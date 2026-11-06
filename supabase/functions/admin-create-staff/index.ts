/**
 * Dreyson Global Hospital — EMR System
 * Edge Function: admin-create-staff
 *
 * SUPABASE PROJECT: lchosyfcjfrkfxtzopcj.supabase.co
 *
 * Privileged operation: Creates a new staff member account (Auth user + profile).
 * Logic:
 * 1. Handle OPTIONS preflight with corsHeaders
 * 2. Verify Bearer token from Authorization header using createClient with SUPABASE_URL + SUPABASE_ANON_KEY and getUser()
 * 3. Using service role client (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY), verify caller has admin role and active status by querying profiles table
 * 4. Validate request body: email required, valid email format, full_name required, role must be one of:
 *    doctor, nurse, pharmacist, front_desk, lab_technician (cannot create admin through this function)
 * 5. Check staff account limits: query profiles table WHERE role = requested_role AND status = 'active', count must be < 10 (read limit from system_settings)
 * 6. Create Auth user: adminClient.auth.admin.createUser({ email, password, email_confirm: true })
 * 7. Insert profile row with the new auth user's ID
 * 8. If profile insert fails, attempt to delete the auth user (compensating cleanup)
 * 9. Do not send an invitation email; the active administrator sets the initial password
 * 10. Log to audit_logs (never log passwords or sensitive medical data)
 * 11. Return 201 with { success: true, user_id, staff_id }
 * 12. Return safe error messages: 400 for validation, 403 for unauthorized, 409 for limit exceeded or duplicate, 500 for internal errors
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  handleCors,
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

Deno.serve(async (req: Request): Promise<Response> => {
  // 1. Handle OPTIONS preflight with corsHeaders
  const corsPreflight = handleCors(req);
  if (corsPreflight) return corsPreflight;

  const requestOrigin = req.headers.get('Origin');

  if (req.method !== 'POST') {
    return errorResponse('Method Not Allowed. Expected POST.', 405, undefined, {}, requestOrigin);
  }

  try {
    // Read environment variables directly
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      console.error('Missing required Supabase environment variables');
      return errorResponse('Internal server configuration error', 500, undefined, {}, requestOrigin);
    }

    // 2. Verify Bearer token from Authorization header using createClient with SUPABASE_URL + SUPABASE_ANON_KEY and getUser()
    const authHeader = req.headers.get('Authorization');
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

    // 3. Using service role client (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY), verify caller has admin role and active status by querying profiles table
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

    // 4. Validate request body: email required, valid email format, full_name required,
    // role must be one of: doctor, nurse, pharmacist, front_desk, lab_technician (cannot create admin through this function)
    const { data: body, error: parseError } = await safeParseJson<CreateStaffBody>(req);
    if (parseError || !body) {
      return errorResponse(parseError || 'Invalid JSON body', 400, undefined, {}, requestOrigin);
    }

    // Email validation
    if (!body.email || typeof body.email !== 'string' || !isValidEmail(body.email)) {
      return errorResponse('Valid email address is required', 400, undefined, {}, requestOrigin);
    }
    const normalizedEmail = body.email.toLowerCase().trim();

    // Full name validation
    if (!body.full_name || typeof body.full_name !== 'string' || body.full_name.trim() === '') {
      return errorResponse('Full name is required', 400, undefined, {}, requestOrigin);
    }
    const cleanFullName = body.full_name.trim();

    // Role validation: strictly enforce allowed staff roles (cannot create admin)
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

    if (typeof body.password !== 'string' || Array.from(body.password).length < 8) {
      return errorResponse('Password must be at least 8 characters long', 400, undefined, {}, requestOrigin);
    }

    const cleanStaffId = body.staff_id?.trim() || null;
    const cleanDepartment = body.department?.trim() || null;
    const cleanPhone = body.phone?.trim() || null;

    // Check unique staff_id if provided
    if (cleanStaffId) {
      const { data: existingStaffId, error: checkIdError } = await adminClient
        .from('profiles')
        .select('id')
        .eq('staff_id', cleanStaffId)
        .maybeSingle();

      if (checkIdError) {
        console.error('Database error checking staff_id:', checkIdError.message);
        return errorResponse('Database verification failed', 500, undefined, {}, requestOrigin);
      }

      if (existingStaffId) {
        return errorResponse(
          `Staff ID '${cleanStaffId}' is already assigned to another staff member`,
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

    // 5. Check staff account limits: query profiles table WHERE role = requested_role AND status = 'active', count must be < 10 (read limit from system_settings)
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

    // Create a confirmed account with the password supplied by the verified administrator.
    const { data: authData, error: authCreateError } = await adminClient.auth.admin.createUser({
      email: normalizedEmail,
      password: body.password,
      email_confirm: true,
      user_metadata: {
        full_name: cleanFullName,
        role: requestedRole,
        department: cleanDepartment,
        staff_id: cleanStaffId,
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

    // 7. Insert profile row with the new auth user's ID
    const { data: newProfile, error: profileInsertError } = await adminClient
      .from('profiles')
      .insert({
        id: newUserId,
        email: normalizedEmail,
        full_name: cleanFullName,
        role: requestedRole,
        staff_id: cleanStaffId,
        department: cleanDepartment,
        phone: cleanPhone,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('id, full_name, email, role, staff_id, department, phone, status, created_at')
      .single();

    // 8. If profile insert fails, attempt to delete the auth user (compensating cleanup)
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

    // 10. Log to audit_logs (Strictly omit passwords, tokens, and sensitive medical data)
    await recordAuditLog(adminClient, {
      actor_id: callerUser.id,
      actor_email: callerProfile.email || callerUser.email,
      action: 'STAFF_ACCOUNT_CREATED',
      resource_type: 'profiles',
      resource_id: newUserId,
      details: {
        staff_id: cleanStaffId,
        role: requestedRole,
        department: cleanDepartment,
        email: normalizedEmail,
        full_name: cleanFullName,
      },
      ip_address: clientIp,
      user_agent: userAgent,
    });

    // Return only safe account information; never return or log the password.
    return jsonResponse(
      {
        success: true,
        message: 'Staff account successfully created',
        user_id: newUserId,
        staff_id: cleanStaffId,
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
