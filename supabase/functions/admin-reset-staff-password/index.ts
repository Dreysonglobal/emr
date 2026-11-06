/**
 * Dreyson Global Hospital — EMR System
 * Edge Function: admin-reset-staff-password
 *
 * SUPABASE PROJECT: lchosyfcjfrkfxtzopcj.supabase.co
 *
 * Privileged operation: Sends a password reset email to a staff member.
 *
 * Request body: { target_user_id }
 *
 * Logic:
 * 1. Verify caller is admin and active
 * 2. Get the target user's email from profiles
 * 3. Send a recovery email whose redirect returns to the password-update screen
 * 4. Log to audit_logs
 * 5. Return success (do NOT return the reset link to the browser)
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
  recordAuditLog,
  isValidUUID,
  safeParseJson,
  getClientIp,
  getRateLimitHeaders,
} from '../_shared/admin-helpers.ts';

interface ResetPasswordBody {
  target_user_id?: string;
}

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
    const { data: body, error: parseError } = await safeParseJson<ResetPasswordBody>(req);
    if (parseError || !body) {
      return errorResponse(parseError || 'Invalid JSON body', 400, undefined, {}, requestOrigin);
    }

    // Validate target_user_id is a valid UUID
    if (!body.target_user_id || !isValidUUID(body.target_user_id)) {
      return errorResponse('Valid target_user_id (UUID) is required', 400, undefined, {}, requestOrigin);
    }
    const targetUserId = body.target_user_id.trim();

    // 2. Get the target user's email from profiles
    const { data: targetProfile, error: fetchError } = await adminClient
      .from('profiles')
      .select('id, full_name, email, role, status')
      .eq('id', targetUserId)
      .maybeSingle();

    if (fetchError) {
      console.error('Error fetching staff profile:', fetchError.message);
      return errorResponse('Database query failed', 500, undefined, {}, requestOrigin);
    }

    if (!targetProfile || !targetProfile.email) {
      return errorResponse('Staff member profile not found or missing email address', 404, undefined, {}, requestOrigin);
    }

    // Check if the target user account is deactivated
    if (targetProfile.status === 'deactivated') {
      return errorResponse(
        'Cannot initiate password reset for a deactivated staff account. Please reactivate the account first.',
        400,
        undefined,
        {},
        requestOrigin
      );
    }

    // Send a recovery link to the application's password-update screen.
    const appOrigin = Deno.env.get('APP_ORIGIN');
    if (!appOrigin) {
      return errorResponse('Password recovery is not configured', 500, undefined, {}, requestOrigin);
    }
    const { error: resetError } = await adminClient.auth.resetPasswordForEmail(targetProfile.email, {
      redirectTo: new URL('/index.html', appOrigin).toString(),
    });
    if (resetError) {
      console.error('Failed to send staff password recovery email:', resetError.message);
      return errorResponse('Failed to send password recovery email', 500, undefined, {}, requestOrigin);
    }

    const clientIp = getClientIp(req);
    const userAgent = req.headers.get('user-agent') || 'Unknown';

    // 4. Log to audit_logs
    // SECURITY REQUIREMENT: Never log password reset links, tokens, or credentials
    await recordAuditLog(adminClient, {
      actor_id: callerUser.id,
      actor_email: callerProfile.email || callerUser.email,
      action: 'STAFF_PASSWORD_RESET_INITIATED',
      resource_type: 'profiles',
      resource_id: targetUserId,
      details: {
        target_role: targetProfile.role,
        target_status: targetProfile.status,
      },
      ip_address: clientIp,
      user_agent: userAgent,
    });

    // 5. Return success (do NOT return the reset link to the browser)
    return jsonResponse(
      {
        success: true,
        message: 'Password reset email initiated successfully.',
        target_user_id: targetUserId,
      },
      200,
      getRateLimitHeaders(),
      requestOrigin
    );
  } catch (err) {
    console.error('Unhandled exception in admin-reset-staff-password:', err);
    return errorResponse('Internal server error', 500, undefined, {}, requestOrigin);
  }
});
