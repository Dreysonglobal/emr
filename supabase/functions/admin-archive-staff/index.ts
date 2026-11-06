/**
 * Dreyson Global Hospital — EMR System
 * Edge Function: admin-archive-staff
 *
 * SUPABASE PROJECT: lchosyfcjfrkfxtzopcj.supabase.co
 *
 * Privileged operation: Soft-deletes (archives) a staff profile.
 *
 * Request body: { target_user_id: string, reason?: string }
 *
 * Security & Reliability Decisions:
 *   1. Caller JWT verified via anonClient.auth.getUser().
 *   2. Caller must have an active admin profile in public.profiles.
 *   3. Caller cannot archive their own profile.
 *   4. Target must not be an administrator account.
 *   5. Target must already be deactivated (status === 'deactivated') before archiving.
 *   6. Target must not already be archived (deleted_at IS NOT NULL).
 *   7. Auth Account Security: adminClient.auth.admin.updateUserById(targetUserId, { ban_duration: '876000h' })
 *      is enforced. If the ban operation fails, archiving is ABORTED immediately.
 *      The staff member remains deactivated in profiles, preventing any access to EMR data.
 *   8. Hardened Atomic Database Transaction: Calls public.archive_staff_member() (SECURITY INVOKER)
 *      using the caller's authenticated admin JWT (anonClient).
 *      Both the soft-delete profile update and audit_logs insertion execute in one atomic transaction.
 *      If audit log insertion fails, PostgreSQL aborts and rolls back the profile update automatically.
 *   9. Never deletes Auth users or physically deletes profiles.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  handleCors,
  jsonResponse,
  errorResponse,
} from '../_shared/cors.ts';
import {
  isValidUUID,
  safeParseJson,
  getClientIp,
  getRateLimitHeaders,
} from '../_shared/admin-helpers.ts';

interface ArchiveStaffBody {
  target_user_id?: string;
  reason?: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  // ── CORS preflight ────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    const corsPreflight = handleCors(req);
    if (corsPreflight && corsPreflight.status === 200) {
      return corsPreflight;
    }
    // Preflight fallback: ensure HTTP 200 is returned immediately with required CORS headers
    return new Response('ok', {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN')?.trim() || 'https://dreysonglobal.github.io',
        'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Credentials': 'true',
        'Vary': 'Origin',
      },
    });
  }

  const requestOrigin = req.headers.get('Origin');

  if (req.method !== 'POST') {
    return errorResponse('Method Not Allowed. Expected POST.', 405, undefined, {}, requestOrigin);
  }

  try {
    // ── Environment variables ───────────────────────────────────────────────
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      console.error('Missing required Supabase environment variables');
      return errorResponse('Internal server configuration error', 500, undefined, {}, requestOrigin);
    }

    // ── 1. Verify caller JWT ────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse(
        'Missing or invalid Authorization header. Bearer token required.',
        401,
        undefined,
        {},
        requestOrigin
      );
    }

    // anonClient carries the caller's verified JWT so auth.uid() is set in PostgreSQL.
    // Used for the atomic archive RPC so RLS and security checks see the caller's identity.
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

    // adminClient (service_role) is used strictly for:
    //   a) Reading profiles without RLS row-filtering (pre-flight checks)
    //   b) Auth administrative operations (account ban via updateUserById)
    // It is NOT used for the database profile archive mutation.
    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    // ── 2. Verify caller is an active administrator ─────────────────────────
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
      return errorResponse(
        'Forbidden: Caller does not have administrative privileges',
        403,
        undefined,
        {},
        requestOrigin
      );
    }

    if (callerProfile.status !== 'active') {
      return errorResponse(
        'Forbidden: Administrator account is not active',
        403,
        undefined,
        {},
        requestOrigin
      );
    }

    // ── 3. Parse and validate request body ─────────────────────────────────
    const { data: body, error: parseError } = await safeParseJson<ArchiveStaffBody>(req);
    if (parseError || !body) {
      return errorResponse(parseError || 'Invalid JSON body', 400, undefined, {}, requestOrigin);
    }

    if (!body.target_user_id || !isValidUUID(body.target_user_id)) {
      return errorResponse('Valid target_user_id (UUID) is required', 400, undefined, {}, requestOrigin);
    }
    const targetUserId = body.target_user_id.trim();
    const cleanReason = body.reason?.trim() || null;

    // ── 4. Prevent self-archiving ───────────────────────────────────────────
    if (callerUser.id === targetUserId) {
      return errorResponse(
        'Administrators cannot archive their own profile',
        403,
        undefined,
        {},
        requestOrigin
      );
    }

    // ── 5. Fetch and pre-validate target profile ────────────────────────────
    const { data: targetProfile, error: fetchError } = await adminClient
      .from('profiles')
      .select('id, full_name, email, role, staff_id, department, phone, status, deleted_at')
      .eq('id', targetUserId)
      .maybeSingle();

    if (fetchError) {
      console.error('Error fetching target profile:', fetchError.message);
      return errorResponse('Database query failed', 500, undefined, {}, requestOrigin);
    }

    if (!targetProfile) {
      return errorResponse('Staff member profile not found', 404, undefined, {}, requestOrigin);
    }

    // ── 5a. Prevent archiving administrator accounts ────────────────────────
    if (targetProfile.role === 'admin') {
      return errorResponse(
        'Administrator accounts cannot be archived through this endpoint',
        403,
        undefined,
        {},
        requestOrigin
      );
    }

    // ── 5b. Require the account to already be deactivated ──────────────────
    if (targetProfile.status !== 'deactivated') {
      return errorResponse(
        'Only deactivated staff profiles can be archived. Deactivate the account first.',
        400,
        undefined,
        {},
        requestOrigin
      );
    }

    // ── 5c. Prevent double-archiving ───────────────────────────────────────
    if (targetProfile.deleted_at !== null && targetProfile.deleted_at !== undefined) {
      return errorResponse(
        'This staff profile has already been archived',
        409,
        undefined,
        {},
        requestOrigin
      );
    }

    // ── 6. AUTH ACCOUNT SECURITY (FATAL REQUIREMENT) ────────────────────────
    // Apply an explicit ban (~100 years).
    // If the ban operation fails, archiving is ABORTED immediately.
    // The profile remains deactivated in public.profiles (status === 'deactivated'),
    // ensuring the staff member cannot access the hospital system.
    try {
      const { error: banError } = await adminClient.auth.admin.updateUserById(targetUserId, {
        ban_duration: '876000h', // ~100 years ban
      });

      if (banError) {
        console.error('CRITICAL: Failed to ban target user auth account during archive:', {
          target_user_id: targetUserId,
          error_message: banError.message,
        });
        return errorResponse(
          'Failed to apply authentication ban to the target staff member. Archiving aborted.',
          500,
          undefined,
          {},
          requestOrigin
        );
      }
    } catch (authErr) {
      console.error('CRITICAL: Unexpected exception during Auth account ban:', {
        target_user_id: targetUserId,
        error: authErr instanceof Error ? authErr.message : String(authErr),
      });
      return errorResponse(
        'An unexpected error occurred while securing the staff authentication account. Archiving aborted.',
        500,
        undefined,
        {},
        requestOrigin
      );
    }

    // ── 7. ATOMIC DATABASE ARCHIVE & AUDIT (TRANSACTION VIA RPC) ────────────
    // Executes public.archive_staff_member() (SECURITY INVOKER) using anonClient
    // with caller's verified administrator JWT.
    // In PostgreSQL:
    //   - Verifies auth.uid() is an active administrator via public.is_admin().
    //   - Locks target row FOR UPDATE.
    //   - Updates public.profiles (sets deleted_at = pg_catalog.now()).
    //   - Inserts into public.audit_logs (actor_id, action, table_name, record_id, old_data, new_data, ip_address, created_at).
    //   - If the audit insert fails, the ENTIRE transaction rolls back automatically.
    const clientIp = getClientIp(req);
    const userAgent = req.headers.get('user-agent') || 'Unknown';

    const { data: archivedProfile, error: rpcError } = await anonClient.rpc(
      'archive_staff_member',
      {
        p_target_user_id: targetUserId,
        p_reason: cleanReason,
        p_client_ip: clientIp,
        p_user_agent: userAgent,
      }
    );

    if (rpcError || !archivedProfile) {
      console.error('CRITICAL: Database transaction failed during staff archive:', {
        target_user_id: targetUserId,
        caller_id: callerUser.id,
        error_code: rpcError?.code,
        error_message: rpcError?.message,
        error_details: rpcError?.details,
        error_hint: rpcError?.hint,
      });

      return errorResponse(
        rpcError?.message || 'Database error: Failed to atomically archive staff profile and record audit entry.',
        500,
        undefined,
        {},
        requestOrigin
      );
    }

    // ── 8. Return success ───────────────────────────────────────────────────
    return jsonResponse(
      {
        success: true,
        message: 'Staff profile has been archived successfully and audit record created',
        profile: archivedProfile,
      },
      200,
      getRateLimitHeaders(),
      requestOrigin
    );
  } catch (err) {
    console.error('Unhandled exception in admin-archive-staff:', {
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : 'Unknown error',
    });
    const origin = req.headers.get('Origin');
    return errorResponse('Internal server error', 500, undefined, {}, origin);
  }
});
