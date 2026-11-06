/**
 * Dreyson Global Hospital — EMR System
 * Edge Function: admin-create-staff
 *
 * SUPABASE PROJECT: lchosyfcjfrkfxtzopcj.supabase.co
 *
 * Privileged operation: Creates a new staff member account (Auth user + profile).
 * Logic:
 * 1. Immediate OPTIONS preflight handling with CORS headers
 * 2. Verify Bearer token from Authorization header using anonClient.auth.getUser()
 * 3. Verify caller has admin role and active status in profiles table using service role client
 * 4. Validate request body (email, full_name, role, password >= 8 chars)
 * 5. Verify requested role is permitted (cannot create admin through this function)
 * 6. Generate or assign staff ID with uniqueness check
 * 7. Verify email uniqueness and check system_settings role quota limit
 * 8. Create Supabase Auth user (email_confirm: true)
 * 9. Insert corresponding profile row with new auth user's ID
 * 10. Compensating cleanup: if profile insert fails, delete the created auth user
 * 11. Record administrative audit log (passwords strictly omitted)
 * 12. Return 201 Created with safe profile details and CORS headers on all responses
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  handleCors,
  corsHeaders,
  isAllowedOrigin,
  jsonResponse,
  errorResponse,
} from '../_shared/cors.ts';
import {
  checkStaffAccountLimit,
  rollbackAuthUser,
  recordAuditLog,
  isValidEmail,
  safeParseJson,
  getClientIp,
  getRateLimitHeaders,
  ALLOWED_STAFF_ROLES,
  StaffRole,
} from '../_shared/admin-helpers.ts';

interface CreateStaffBody {
  email?: string;
  full_name?: string;
  role?: string;
  staff_id?: string;
  department?: string;
  phone?: string;
  password?: string;
}

const ROLE_STAFF_ID_PREFIXES: Record<StaffRole, string> = {
  doctor: 'DOC',
  nurse: 'NUR',
  pharmacist: 'PHM',
  front_desk: 'FDK',
  lab_technician: 'LAB',
};

/**
 * Assigns or generates a canonical unique Staff ID for the new staff member.
 */
async function resolveStaffId(
  adminClient: SupabaseClient,
  role: StaffRole,
  providedStaffId?: string | null
): Promise<string> {
  const clean = providedStaffId?.trim();
  if (clean) return clean;

  const prefix = ROLE_STAFF_ID_PREFIXES[role] || 'STF';
  const { count } = await adminClient
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', role);

  const startNum = (count ?? 0) + 1;
  for (let offset = 0; offset < 50; offset++) {
    const candidate = `DGH-${prefix}-${String(startNum + offset).padStart(3, '0')}`;
    const { data: existing } = await adminClient
      .from('profiles')
      .select('id')
      .eq('staff_id', candidate)
      .maybeSingle();

    if (!existing) {
      return candidate;
    }
  }

  return `DGH-${prefix}-${Date.now().toString().slice(-4)}`;
}

Deno.serve(async (req: Request): Promise<Response> => {
  // ── 1. Immediate CORS preflight handling ───────────────────────────────────
  // Preflight MUST be evaluated before any auth verification or body parsing.
  if (req.method === 'OPTIONS') {
    const corsPreflight = handleCors(req);
    if (corsPreflight) return corsPreflight;

    // Safety fallback: if origin is permitted, return 200 with full CORS headers
    const origin = req.headers.get('Origin') || req.headers.get('origin');
    if (isAllowedOrigin(origin)) {
      return new Response('ok', {
        status: 200,
        headers: corsHeaders(origin),
      });
    }
    return new Response('Forbidden: Origin not allowed', { status: 403 });
  }

  const requestOrigin = req.headers.get('Origin') || req.headers.get('origin');

  if (req.method !== 'POST') {
    return errorResponse('Method Not Allowed. Expected POST.', 405, undefined, {}, requestOrigin);
  }

  try {
    // ── 2. Environment variables ─────────────────────────────────────────────
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      console.error('Missing required Supabase environment variables');
      return errorResponse('Internal server configuration error', 500, undefined, {}, requestOrigin);
    }

    // ── 3. Caller authentication via Bearer JWT ──────────────────────────────
    const authHeader = req.headers.get('Authorization') || req.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse('Missing or invalid Authorization header. Bearer token required.', 401, undefined, {}, requestOrigin);
    }

    const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user: callerUser },
      error: authError,
    } = await anonClient.auth.getUser();

    if (authError || !callerUser) {
      console.warn('Caller authentication failed:', authError?.message);
      return errorResponse('Invalid or expired authentication session', 401, undefined, {}, requestOrigin);
    }

    // ── 4. Caller administrator role authorization ───────────────────────────
    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: callerProfile, error: callerProfileError } = await adminClient
      .from('profiles')
      .select('id, full_name, email, role, status')
      .eq('id', callerUser.id)
      .single();

    if (callerProfileError || !callerProfile) {
      console.warn(`Profile lookup failed for caller ${callerUser.id}:`, callerProfileError?.message);
      return errorResponse('Caller administrative profile not found', 403, undefined, {}, requestOrigin);
    }

    if (callerProfile.role !== 'admin') {
      return errorResponse('Forbidden: Caller does not have administrative privileges', 403, undefined, {}, requestOrigin);
    }

    if (callerProfile.status !== 'active') {
      return errorResponse('Forbidden: Administrator account is not active', 403, undefined, {}, requestOrigin);
    }

    // ── 5. Request body validation ───────────────────────────────────────────
    const { data: body, error: parseError } = await safeParseJson<CreateStaffBody>(req);
    if (parseError || !body) {
      return errorResponse(parseError || 'Invalid JSON body', 400, undefined, {}, requestOrigin);
    }

    // Validate email
    if (!body.email || typeof body.email !== 'string' || !isValidEmail(body.email)) {
      return errorResponse('Valid email address is required', 400, undefined, {}, requestOrigin);
    }
    const normalizedEmail = body.email.toLowerCase().trim();

    // Validate full name
    if (!body.full_name || typeof body.full_name !== 'string' || body.full_name.trim() === '') {
      return errorResponse('Full name is required', 400, undefined, {}, requestOrigin);
    }
    const cleanFullName = body.full_name.trim();

    // Validate role: must be in ALLOWED_STAFF_ROLES (admin cannot be created here)
    if (!body.role || !ALLOWED_STAFF_ROLES.includes(body.role as StaffRole)) {
      return errorResponse(
        `Invalid role. Role must be one of: ${ALLOWED_STAFF_ROLES.join(', ')}. Creating an admin through this function is not permitted.`,
        400,
        undefined,
        {},
        requestOrigin
      );
    }
    const requestedRole = body.role as StaffRole;

    // Validate password
    if (typeof body.password !== 'string' || Array.from(body.password).length < 8) {
      return errorResponse('Password must be at least 8 characters long', 400, undefined, {}, requestOrigin);
    }

    const cleanDepartment = body.department?.trim() || null;
    const cleanPhone = body.phone?.trim() || null;

    // ── 6. Assign or generate Staff ID and verify uniqueness ──────────────────
    const assignedStaffId = await resolveStaffId(adminClient, requestedRole, body.staff_id);

    // If an explicit staff_id was provided, verify it does not conflict
    if (body.staff_id && body.staff_id.trim() !== '') {
      const { data: existingStaffId, error: checkIdError } = await adminClient
        .from('profiles')
        .select('id')
        .eq('staff_id', assignedStaffId)
        .maybeSingle();

      if (checkIdError) {
        console.error('Database error checking staff_id:', checkIdError.message);
        return errorResponse('Database verification failed', 500, undefined, {}, requestOrigin);
      }

      if (existingStaffId) {
        return errorResponse(
          `Staff ID '${assignedStaffId}' is already assigned to another staff member`,
          409,
          undefined,
          {},
          requestOrigin
        );
      }
    }

    // Check unique email in profiles table
    const { data: existingProfileEmail, error: checkEmailError } = await adminClient
      .from('profiles')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (checkEmailError) {
      console.error('Database error checking profile email:', checkEmailError.message);
      return errorResponse('Database verification failed', 500, undefined, {}, requestOrigin);
    }

    if (existingProfileEmail) {
      return errorResponse(`An account with email '${normalizedEmail}' already exists`, 409, undefined, {}, requestOrigin);
    }

    // ── 7. Enforce staff account quota limit from system_settings ───────────
    const quotaCheck = await checkStaffAccountLimit(adminClient, requestedRole);
    if (quotaCheck.error) {
      return errorResponse(quotaCheck.error, 500, undefined, {}, requestOrigin);
    }

    if (!quotaCheck.allowed) {
      return errorResponse(
        `Staff limit exceeded for role '${requestedRole}'. Active accounts limit is ${quotaCheck.maxLimit} (currently active: ${quotaCheck.currentCount}).`,
        409,
        undefined,
        {},
        requestOrigin
      );
    }

    // ── 8. Create Supabase Auth user (email auto-confirmed) ──────────────────
    const { data: authData, error: authCreateError } = await adminClient.auth.admin.createUser({
      email: normalizedEmail,
      password: body.password,
      email_confirm: true,
      user_metadata: {
        full_name: cleanFullName,
        role: requestedRole,
        department: cleanDepartment,
        staff_id: assignedStaffId,
      },
    });

    if (authCreateError || !authData.user) {
      console.error('Auth user creation failed:', authCreateError?.message);
      const errMsg = authCreateError?.message?.toLowerCase() || '';
      if (errMsg.includes('already registered') || errMsg.includes('already been registered')) {
        return errorResponse(`An authentication account with email '${normalizedEmail}' already exists`, 409, undefined, {}, requestOrigin);
      }
      return errorResponse(
        'Failed to create authentication user',
        400,
        authCreateError?.message,
        {},
        requestOrigin
      );
    }

    const newUserId = authData.user.id;

    // ── 9. Insert corresponding profile row ──────────────────────────────────
    const { data: newProfile, error: profileInsertError } = await adminClient
      .from('profiles')
      .insert({
        id: newUserId,
        email: normalizedEmail,
        full_name: cleanFullName,
        role: requestedRole,
        staff_id: assignedStaffId,
        department: cleanDepartment,
        phone: cleanPhone,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('id, full_name, email, role, staff_id, department, phone, status, created_at')
      .single();

    // ── 10. Compensating cleanup: rollback auth user if profile insert fails ─
    if (profileInsertError || !newProfile) {
      console.error(
        `Profile insert failed for auth user ${newUserId}. Initiating compensating cleanup:`,
        profileInsertError?.message
      );
      await rollbackAuthUser(adminClient, newUserId);

      if (profileInsertError?.code === '23505') {
        return errorResponse('Staff profile conflict: Email or Staff ID already exists', 409, undefined, {}, requestOrigin);
      }
      return errorResponse(
        'Failed to initialize staff profile. Rolled back account creation.',
        500,
        undefined,
        {},
        requestOrigin
      );
    }

    const clientIp = getClientIp(req);
    const userAgent = req.headers.get('user-agent') || 'Unknown';

    // ── 11. Record immutable audit log entry ─────────────────────────────────
    // Strictly omit passwords, tokens, and sensitive medical data
    await recordAuditLog(adminClient, {
      actor_id: callerUser.id,
      actor_email: callerProfile.email || callerUser.email,
      action: 'STAFF_ACCOUNT_CREATED',
      resource_type: 'profiles',
      resource_id: newUserId,
      details: {
        staff_id: assignedStaffId,
        role: requestedRole,
        department: cleanDepartment,
        email: normalizedEmail,
        full_name: cleanFullName,
      },
      ip_address: clientIp,
      user_agent: userAgent,
    });

    // ── 12. Return safe account response with CORS headers ───────────────────
    return jsonResponse(
      {
        success: true,
        message: 'Staff account successfully created',
        user_id: newUserId,
        staff_id: assignedStaffId,
        profile: newProfile,
      },
      201,
      getRateLimitHeaders(),
      requestOrigin
    );
  } catch (err) {
    console.error('Unhandled exception in admin-create-staff:', err);
    return errorResponse('Internal server error', 500, undefined, {}, requestOrigin);
  }
});
