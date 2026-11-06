/**
 * Dreyson Global Hospital — EMR System
 * Edge Function: admin-update-staff
 *
 * SUPABASE PROJECT: lchosyfcjfrkfxtzopcj.supabase.co
 *
 * Privileged operation: Updates a staff profile.
 *
 * Request body: { target_user_id, full_name?, department?, phone?, staff_id?, status? }
 *
 * Logic:
 * 1. Verify caller is admin and active
 * 2. Validate target_user_id is a valid UUID
 * 3. Prevent caller from changing their own role
 * 4. Prevent changing role to 'admin' through this function
 * 5. If status is being changed to 'active', check account limits for the role
 * 6. Update profiles row
 * 7. Log to audit_logs
 * 8. Return updated profile (safe fields only)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  handleCors,
  isAllowedOrigin,
  corsHeaders,
  jsonResponse,
  errorResponse,
} from '../_shared/cors.ts';
import {
  checkStaffAccountLimit,
  recordAuditLog,
  isValidUUID,
  safeParseJson,
  getClientIp,
  getRateLimitHeaders,
  ALLOWED_STAFF_ROLES,
  StaffRole,
} from '../_shared/admin-helpers.ts';

interface UpdateStaffBody {
  target_user_id?: string;
  full_name?: string;
  department?: string;
  phone?: string;
  staff_id?: string;
  status?: 'active' | 'suspended' | 'deactivated';
  role?: string;
}

const VALID_STATUSES = ['active', 'suspended', 'deactivated'] as const;

Deno.serve(async (req: Request): Promise<Response> => {
  // -- Immediate CORS preflight handling ----------------------------------------
  // OPTIONS must be evaluated before auth verification or body parsing.
  if (req.method === 'OPTIONS') {
    const corsPreflight = handleCors(req);
    if (corsPreflight) return corsPreflight;
    // Safety fallback: guarantee HTTP 200 for allowed origins.
    const origin = req.headers.get('Origin') || req.headers.get('origin');
    if (isAllowedOrigin(origin)) {
      return new Response('ok', { status: 200, headers: corsHeaders(origin) });
    }
    return new Response('Forbidden: Origin not allowed', { status: 403 });
  }

  const requestOrigin = req.headers.get('Origin') || req.headers.get('origin');

  if (req.method !== 'POST') {
    return errorResponse('Method Not Allowed. Expected POST.', 405, undefined, {}, requestOrigin);
  }

  try {
    // Read Supabase environment variables directly
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      console.error('Missing required Supabase environment variables');
      return errorResponse('Internal server configuration error', 500, undefined, {}, requestOrigin);
    }

    // 1. Verify caller Bearer token & verify caller is active administrator
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

    // Validate request JSON payload
    const { data: body, error: parseError } = await safeParseJson<UpdateStaffBody>(req);
    if (parseError || !body) {
      return errorResponse(parseError || 'Invalid JSON body', 400, undefined, {}, requestOrigin);
    }

    // 2. Validate target_user_id is a valid UUID
    if (!body.target_user_id || !isValidUUID(body.target_user_id)) {
      return errorResponse('Valid target_user_id (UUID) is required', 400, undefined, {}, requestOrigin);
    }
    const targetUserId = body.target_user_id.trim();

    // Fetch existing target staff profile
    const { data: targetProfile, error: fetchError } = await adminClient
      .from('profiles')
      .select('id, full_name, email, role, staff_id, department, phone, status')
      .eq('id', targetUserId)
      .maybeSingle();

    if (fetchError) {
      console.error('Error fetching target profile:', fetchError.message);
      return errorResponse('Database query failed', 500, undefined, {}, requestOrigin);
    }

    if (!targetProfile) {
      return errorResponse('Staff member profile not found', 404, undefined, {}, requestOrigin);
    }

    // 3. Prevent caller from changing their own role
    if (callerUser.id === targetUserId && body.role && body.role !== targetProfile.role) {
      return errorResponse('Administrators cannot change their own role', 403, undefined, {}, requestOrigin);
    }

    // Prevent administrator from deactivating themselves
    if (callerUser.id === targetUserId && body.status && body.status !== 'active') {
      return errorResponse('Administrators cannot suspend or deactivate their own account', 403, undefined, {}, requestOrigin);
    }

    // 4. Prevent changing role to 'admin' through this function
    if (body.role === 'admin') {
      return errorResponse('Changing role to administrator through this function is strictly prohibited', 403, undefined, {}, requestOrigin);
    }

    // If target profile is already admin and caller is targeting someone else, protect admin profiles
    if (targetProfile.role === 'admin' && callerUser.id !== targetUserId) {
      return errorResponse('Modifying administrator profiles through this staff endpoint is not permitted', 403, undefined, {}, requestOrigin);
    }

    // Validate role if specified
    if (body.role !== undefined) {
      if (!ALLOWED_STAFF_ROLES.includes(body.role as StaffRole)) {
        return errorResponse(
          `Invalid role specified. Must be one of: ${ALLOWED_STAFF_ROLES.join(', ')}`,
          400,
          undefined,
          {},
          requestOrigin
        );
      }
    }

    // Validate status if specified
    if (body.status !== undefined) {
      if (!VALID_STATUSES.includes(body.status)) {
        return errorResponse(
          `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
          400,
          undefined,
          {},
          requestOrigin
        );
      }
    }

    const effectiveRole = (body.role as StaffRole) || targetProfile.role;

    // 5. If status is being changed to 'active', check account limits for the role
    const isBecomingActive =
      (body.status === 'active' && targetProfile.status !== 'active') ||
      (body.role && body.role !== targetProfile.role && (body.status === 'active' || targetProfile.status === 'active'));

    if (isBecomingActive) {
      const quotaCheck = await checkStaffAccountLimit(adminClient, effectiveRole, targetUserId);
      if (quotaCheck.error) {
        return errorResponse(quotaCheck.error, 500, undefined, {}, requestOrigin);
      }
      if (!quotaCheck.allowed) {
        return errorResponse(
          `Active staff quota exceeded for role '${effectiveRole}'. Maximum allowed active accounts is ${quotaCheck.maxLimit}.`,
          409,
          undefined,
          {},
          requestOrigin
        );
      }
    }

    // Check unique staff_id if changing
    if (body.staff_id !== undefined && body.staff_id.trim() !== '') {
      const cleanStaffId = body.staff_id.trim();
      if (cleanStaffId !== targetProfile.staff_id) {
        const { data: existingStaffId, error: checkIdError } = await adminClient
          .from('profiles')
          .select('id')
          .eq('staff_id', cleanStaffId)
          .neq('id', targetUserId)
          .maybeSingle();

        if (checkIdError) {
          console.error('Error verifying unique staff_id:', checkIdError.message);
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
    }

    // Prepare profile updates
    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (body.full_name !== undefined) {
      if (typeof body.full_name !== 'string' || body.full_name.trim() === '') {
        return errorResponse('Full name cannot be empty', 400, undefined, {}, requestOrigin);
      }
      updates.full_name = body.full_name.trim();
    }

    if (body.department !== undefined) {
      updates.department = body.department ? body.department.trim() : null;
    }

    if (body.phone !== undefined) {
      updates.phone = body.phone ? body.phone.trim() : null;
    }

    if (body.staff_id !== undefined) {
      updates.staff_id = body.staff_id ? body.staff_id.trim() : null;
    }

    if (body.status !== undefined) {
      updates.status = body.status;
    }

    if (body.role !== undefined) {
      updates.role = body.role;
    }

    // 6. Update profiles row
    const { data: updatedProfile, error: updateError } = await adminClient
      .from('profiles')
      .update(updates)
      .eq('id', targetUserId)
      .select('id, full_name, email, role, staff_id, department, phone, status, updated_at')
      .single();

    if (updateError || !updatedProfile) {
      console.error('Failed to update staff profile:', updateError?.message);
      return errorResponse('Failed to update staff profile in database', 500, undefined, {}, requestOrigin);
    }

    // Sync user_metadata in Auth if full_name or role changed
    try {
      const authUpdates: Record<string, unknown> = {};
      if (updates.full_name) authUpdates.full_name = updates.full_name;
      if (updates.role) authUpdates.role = updates.role;
      if (Object.keys(authUpdates).length > 0) {
        await adminClient.auth.admin.updateUserById(targetUserId, {
          user_metadata: authUpdates,
        });
      }
    } catch (authMetaErr) {
      console.warn('Auth user metadata sync non-fatal note:', authMetaErr);
    }

    // If status changed to suspended/deactivated, revoke active sessions
    if (body.status === 'suspended' || body.status === 'deactivated') {
      try {
        await adminClient.auth.admin.signOut(targetUserId);
      } catch (signOutErr) {
        console.warn('Session revocation non-fatal note:', signOutErr);
      }
    }

    const clientIp = getClientIp(req);
    const userAgent = req.headers.get('user-agent') || 'Unknown';

    // 7. Log to audit_logs (omits sensitive or confidential patient data)
    await recordAuditLog(adminClient, {
      actor_id: callerUser.id,
      actor_email: callerProfile.email || callerUser.email,
      action: 'STAFF_PROFILE_UPDATED',
      resource_type: 'profiles',
      resource_id: targetUserId,
      details: {
        changed_fields: Object.keys(updates).filter((k) => k !== 'updated_at'),
        previous: {
          full_name: targetProfile.full_name,
          department: targetProfile.department,
          phone: targetProfile.phone,
          staff_id: targetProfile.staff_id,
          status: targetProfile.status,
          role: targetProfile.role,
        },
        updated: updates,
      },
      ip_address: clientIp,
      user_agent: userAgent,
    });

    // 8. Return updated profile (safe fields only)
    return jsonResponse(
      {
        success: true,
        message: 'Staff profile updated successfully',
        profile: updatedProfile,
      },
      200,
      getRateLimitHeaders(),
      requestOrigin
    );
  } catch (err) {
    console.error('Unhandled exception in admin-update-staff:', err);
    return errorResponse('Internal server error', 500, undefined, {}, requestOrigin);
  }
});
