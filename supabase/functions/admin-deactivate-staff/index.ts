/**
 * Dreyson Global Hospital — EMR System
 * Edge Function: admin-deactivate-staff
 *
 * SUPABASE PROJECT: lchosyfcjfrkfxtzopcj.supabase.co
 *
 * Privileged operation: Deactivates, suspends, or reactivates a staff account.
 *
 * Request body: { target_user_id, action: 'suspend' | 'deactivate' | 'reactivate', reason? }
 *
 * Logic:
 * 1. Verify caller is admin and active
 * 2. Prevent admin from deactivating themselves
 * 3. Determine new status: suspend → 'suspended', deactivate → 'deactivated', reactivate → 'active'
 * 4. If reactivating, check account limits for the role
 * 5. Update profiles.status
 * 6. If suspending or deactivating, also invalidate sessions: use adminClient.auth.admin.signOut(target_user_id) or updateUserById to ban
 * 7. Log to audit_logs
 * 8. Return success
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
} from '../_shared/admin-helpers.ts';

interface DeactivateStaffBody {
  target_user_id?: string;
  action?: 'suspend' | 'deactivate' | 'reactivate';
  reason?: string;
}

const ACTION_MAP = {
  suspend: 'suspended',
  deactivate: 'deactivated',
  reactivate: 'active',
} as const;

type ActionType = keyof typeof ACTION_MAP;

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

    // 1. Verify caller is admin and active
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
    const { data: body, error: parseError } = await safeParseJson<DeactivateStaffBody>(req);
    if (parseError || !body) {
      return errorResponse(parseError || 'Invalid JSON body', 400, undefined, {}, requestOrigin);
    }

    // Validate target_user_id
    if (!body.target_user_id || !isValidUUID(body.target_user_id)) {
      return errorResponse('Valid target_user_id (UUID) is required', 400, undefined, {}, requestOrigin);
    }
    const targetUserId = body.target_user_id.trim();

    // 2. Prevent admin from deactivating themselves
    if (callerUser.id === targetUserId) {
      return errorResponse(
        'Administrators cannot suspend, deactivate, or modify their own active account status',
        403,
        undefined,
        {},
        requestOrigin
      );
    }

    // Validate action
    if (!body.action || !(body.action in ACTION_MAP)) {
      return errorResponse(
        "Invalid action. Must be one of: 'suspend', 'deactivate', 'reactivate'",
        400,
        undefined,
        {},
        requestOrigin
      );
    }
    const action = body.action as ActionType;

    // 3. Determine new status: suspend → 'suspended', deactivate → 'deactivated', reactivate → 'active'
    const newStatus = ACTION_MAP[action];
    const cleanReason = body.reason?.trim() || null;

    // Fetch target user's profile
    const { data: targetProfile, error: fetchError } = await adminClient
      .from('profiles')
      .select('id, full_name, email, role, staff_id, department, status')
      .eq('id', targetUserId)
      .maybeSingle();

    if (fetchError) {
      console.error('Error fetching target profile:', fetchError.message);
      return errorResponse('Database query failed', 500, undefined, {}, requestOrigin);
    }

    if (!targetProfile) {
      return errorResponse('Staff member profile not found', 404, undefined, {}, requestOrigin);
    }

    // Prevent modifying other administrator accounts through this staff endpoint
    if (targetProfile.role === 'admin') {
      return errorResponse(
        'Cannot suspend or deactivate an administrator account through this endpoint',
        403,
        undefined,
        {},
        requestOrigin
      );
    }

    // Check if already in target state
    if (targetProfile.status === newStatus) {
      return errorResponse(
        `Staff member account is already in '${newStatus}' state`,
        400,
        undefined,
        {},
        requestOrigin
      );
    }

    // 4. If reactivating, check account limits for the role
    if (action === 'reactivate') {
      const quotaCheck = await checkStaffAccountLimit(adminClient, targetProfile.role, targetUserId);
      if (quotaCheck.error) {
        return errorResponse(quotaCheck.error, 500, undefined, {}, requestOrigin);
      }
      if (!quotaCheck.allowed) {
        return errorResponse(
          `Cannot reactivate staff member. Active staff quota for role '${targetProfile.role}' reached its maximum limit (${quotaCheck.maxLimit}).`,
          409,
          undefined,
          {},
          requestOrigin
        );
      }
    }

    // 5. Update profiles.status
    // SECURITY DESIGN: Use the caller's authenticated administrator JWT (via anonClient)
    // for updating public.profiles. In PostgreSQL, this sets auth.uid() to the verified
    // administrator's UUID, which satisfies the profiles_update_policy RLS rule and passes
    // the trg_protect_profile_sensitive_fields trigger via public.is_admin().
    // We do NOT fall back to service_role for this table update; if the authenticated update
    // fails, the operation fails securely.
    const { data: updatedProfile, error: updateError } = await anonClient
      .from('profiles')
      .update({
        status: newStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('id', targetUserId)
      .select('id, full_name, email, role, staff_id, department, status, updated_at')
      .single();

    if (updateError || !updatedProfile) {
      console.error('Failed to update status in profiles table:', {
        target_user_id: targetUserId,
        action,
        error_code: updateError?.code,
        error_message: updateError?.message,
      });
      return errorResponse('Failed to update staff member status', 500, undefined, {}, requestOrigin);
    }

    // 6. If suspending or deactivating, also invalidate sessions: use adminClient.auth.admin.signOut(target_user_id) or updateUserById to ban
    if (newStatus === 'suspended' || newStatus === 'deactivated') {
      try {
        // Invalidate all active sessions immediately
        await adminClient.auth.admin.signOut(targetUserId);
        // Ban the auth user so refresh tokens cannot be used
        // 876000 hours (~100 years ban duration)
        await adminClient.auth.admin.updateUserById(targetUserId, {
          ban_duration: '876000h',
        });
      } catch (authBanErr) {
        console.warn('Auth session revocation/ban note (non-fatal):', {
          target_user_id: targetUserId,
          error: authBanErr instanceof Error ? authBanErr.message : String(authBanErr),
        });
      }
    } else if (newStatus === 'active') {
      try {
        // Remove ban to restore sign-in capability
        await adminClient.auth.admin.updateUserById(targetUserId, {
          ban_duration: 'none',
        });
      } catch (authUnbanErr) {
        console.warn('Auth unban note (non-fatal):', {
          target_user_id: targetUserId,
          error: authUnbanErr instanceof Error ? authUnbanErr.message : String(authUnbanErr),
        });
      }
    }

    const clientIp = getClientIp(req);
    const userAgent = req.headers.get('user-agent') || 'Unknown';

    // 7. Log to audit_logs
    await recordAuditLog(adminClient, {
      actor_id: callerUser.id,
      actor_email: callerProfile.email || callerUser.email,
      action: `STAFF_ACCOUNT_${action.toUpperCase()}`,
      resource_type: 'profiles',
      resource_id: targetUserId,
      details: {
        action,
        previous_status: targetProfile.status,
        new_status: newStatus,
        reason: cleanReason,
        role: targetProfile.role,
        staff_id: targetProfile.staff_id,
        email: targetProfile.email,
      },
      ip_address: clientIp,
      user_agent: userAgent,
    });

    // 8. Return success
    return jsonResponse(
      {
        success: true,
        message: `Staff member account has been successfully ${newStatus}`,
        profile: updatedProfile,
      },
      200,
      getRateLimitHeaders(),
      requestOrigin
    );
  } catch (err) {
    console.error('Unhandled exception in admin-deactivate-staff:', {
      error: err instanceof Error ? { name: err.name, message: err.message } : 'Unknown error',
    });
    // Include requestOrigin so CORS headers are present on error responses too
    const origin = req.headers.get('Origin');
    return errorResponse('Internal server error', 500, undefined, {}, origin);
  }
});
