/**
 * Dreyson Global Hospital — EMR System
 * Shared Admin Helpers & Security Utilities
 *
 * Provides centralized caller authentication, role enforcement,
 * system settings quota verification, audit logging, and input validation.
 */

import { createClient, SupabaseClient, User } from 'https://esm.sh/@supabase/supabase-js@2';
import { errorResponse } from './cors.ts';

// Allowed staff roles for management endpoints (cannot create/assign admin)
export const ALLOWED_STAFF_ROLES = [
  'doctor',
  'nurse',
  'pharmacist',
  'front_desk',
  'lab_technician',
] as const;

export type StaffRole = (typeof ALLOWED_STAFF_ROLES)[number];

export interface CallerProfile {
  id: string;
  email: string;
  full_name: string;
  role: string;
  status: string;
}

export interface StaffProfile {
  id: string;
  email: string;
  full_name: string;
  role: string;
  staff_id: string | null;
  department: string | null;
  phone: string | null;
  status: string;
  created_at?: string;
  updated_at?: string;
}

export interface AuditLogEntry {
  actor_id: string;
  actor_email?: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  details?: Record<string, unknown>;
  ip_address?: string;
  user_agent?: string;
}

/**
 * Validates whether the given string is a valid UUID v4 format.
 */
export function isValidUUID(uuid: string): boolean {
  if (typeof uuid !== 'string') return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid.trim());
}

/**
 * Validates standard email address format.
 */
export function isValidEmail(email: string): boolean {
  if (typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

/**
 * Safely parses JSON from incoming Request.
 * Returns null if the request body is empty or malformed JSON.
 */
export async function safeParseJson<T>(req: Request): Promise<{ data: T | null; error?: string }> {
  try {
    const text = await req.text();
    if (!text || text.trim() === '') {
      return { data: null, error: 'Request body cannot be empty' };
    }
    const data = JSON.parse(text) as T;
    return { data };
  } catch (_e) {
    return { data: null, error: 'Malformed JSON payload' };
  }
}

/**
 * Extracts client IP from standard proxy headers.
 */
export function getClientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    '127.0.0.1'
  );
}

/**
 * RATE LIMITING ARCHITECTURE:
 *
 * 1. Supabase Platform Rate Limiting:
 *    Supabase provides built-in API gateway rate limiting for Auth and Edge Functions.
 *    To customize in supabase/config.toml or Supabase Dashboard:
 *    - Configure API gateway limits (e.g. 60 requests/minute per IP)
 *    - Configure Auth rate limits (e.g. max 30 sign-ups or recovery emails per hour)
 *
 * 2. Function-Level Throttling (Distributed Redis / Postgres RPC):
 *    In production hospital environments handling medical records, sensitive endpoints
 *    (e.g., admin-create-staff, admin-reset-staff-password) should be throttled by IP
 *    and caller user ID using Upstash Redis (@upstash/ratelimit) or a database atomic RPC
 *    (e.g. `SELECT check_rate_limit(actor_id, 'admin_action', 30, 60)`).
 *
 * 3. Rate Limit Response Headers:
 *    Returned on each response for client visibility and backoff handling.
 */
export function getRateLimitHeaders(
  limit = 30,
  remaining = 29,
  resetSeconds = 60
): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(Math.max(0, remaining)),
    'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + resetSeconds),
  };
}

/**
 * Verifies that the incoming request contains a valid JWT Bearer token,
 * validates the caller identity using the Anon client, and confirms that
 * the caller has an 'admin' role with 'active' status in the profiles table.
 */
export async function verifyAdminCaller(req: Request): Promise<
  | {
      callerUser: User;
      callerProfile: CallerProfile;
      anonClient: SupabaseClient;
      adminClient: SupabaseClient;
      clientIp: string;
      userAgent: string;
    }
  | { errorResponse: Response }
> {
  // Method verification: administrative mutation functions require POST
  if (req.method !== 'POST') {
    return {
      errorResponse: errorResponse('Method Not Allowed. Expected POST.', 405),
    };
  }

  // Retrieve required Supabase environment variables
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    console.error('CRITICAL: Missing Supabase environment variables');
    return {
      errorResponse: errorResponse('Internal server configuration error', 500),
    };
  }

  // Verify Authorization header
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      errorResponse: errorResponse('Missing or invalid Authorization header. Bearer token required.', 401),
    };
  }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return {
      errorResponse: errorResponse('Bearer authentication token cannot be empty', 401),
    };
  }

  // Initialize Anon client with caller's token to securely verify caller session
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
    return {
      errorResponse: errorResponse('Invalid or expired authentication session', 401),
    };
  }

  // Initialize Admin client with service-role key for privileged database access
  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  // Query profiles table to verify caller has 'admin' role and 'active' status
  const { data: callerProfile, error: profileError } = await adminClient
    .from('profiles')
    .select('id, full_name, email, role, status')
    .eq('id', callerUser.id)
    .single();

  if (profileError || !callerProfile) {
    console.warn(`Profile lookup failed for caller ${callerUser.id}:`, profileError?.message);
    return {
      errorResponse: errorResponse('Caller administrative profile not found', 403),
    };
  }

  if (callerProfile.role !== 'admin') {
    return {
      errorResponse: errorResponse('Forbidden: Administrative privileges required', 403),
    };
  }

  if (callerProfile.status !== 'active') {
    return {
      errorResponse: errorResponse('Forbidden: Administrator account is not active', 403),
    };
  }

  const clientIp = getClientIp(req);
  const userAgent = req.headers.get('user-agent') || 'Unknown';

  return {
    callerUser,
    callerProfile,
    anonClient,
    adminClient,
    clientIp,
    userAgent,
  };
}

/**
 * Reads staff account limit for a given role from the system_settings table.
 * Defaults to 10 if not explicitly configured in system_settings.
 */
export async function getStaffRoleLimit(
  adminClient: SupabaseClient,
  role: string
): Promise<number> {
  const DEFAULT_ROLE_LIMIT = 10;
  const settingKeys: Record<string, string> = {
    doctor: 'max_doctors',
    nurse: 'max_nurses',
    pharmacist: 'max_pharmacists',
    front_desk: 'max_front_desk',
    lab_technician: 'max_lab_technicians',
  };
  const settingKey = settingKeys[role];
  if (!settingKey) return DEFAULT_ROLE_LIMIT;

  const { data, error } = await adminClient
    .from('system_settings')
    .select('value')
    .eq('key', settingKey)
    .maybeSingle();
  if (error) {
    console.error(`Failed to read staff limit setting '${settingKey}':`, error.message);
    throw new Error('Failed to verify staff quota limit');
  }
  if (!data || data.value === null) return DEFAULT_ROLE_LIMIT;

  const rawValue = String(data.value).trim();
  const value = Number(rawValue);
  if (!/^\d+$/.test(rawValue) || !Number.isInteger(value) || value < 0) {
    throw new Error(`Staff quota setting '${settingKey}' must be a non-negative integer`);
  }
  return value;
}

/**
 * Checks if the number of active staff accounts for a role is within the limit.
 */
export async function checkStaffAccountLimit(
  adminClient: SupabaseClient,
  role: string,
  excludeUserId?: string
): Promise<{ allowed: boolean; currentCount: number; maxLimit: number; error?: string }> {
  const maxLimit = await getStaffRoleLimit(adminClient, role);

  let query = adminClient
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', role)
    .eq('status', 'active');

  if (excludeUserId) {
    query = query.neq('id', excludeUserId);
  }

  const { count, error } = await query;

  if (error) {
    console.error(`Failed to count active profiles for role '${role}':`, error.message);
    return {
      allowed: false,
      currentCount: 0,
      maxLimit,
      error: 'Failed to verify staff quota limit',
    };
  }

  const currentCount = count ?? 0;
  return {
    allowed: currentCount < maxLimit,
    currentCount,
    maxLimit,
  };
}

/**
 * Compensating transaction helper: rolls back created Auth user
 * if profile creation or post-creation steps fail.
 */
export async function rollbackAuthUser(
  adminClient: SupabaseClient,
  userId: string
): Promise<void> {
  try {
    console.warn(`Initiating compensating cleanup: Deleting auth user ${userId}`);
    const { error } = await adminClient.auth.admin.deleteUser(userId);
    if (error) {
      console.error(`CRITICAL: Compensating cleanup failed for user ${userId}:`, error.message);
    } else {
      console.info(`Compensating cleanup succeeded for user ${userId}`);
    }
  } catch (cleanupErr) {
    console.error(`CRITICAL: Unexpected error during compensating cleanup for user ${userId}:`, cleanupErr);
  }
}

/**
 * Records an immutable administrative action to the audit_logs table.
 * SECURITY: Never logs passwords, tokens, or sensitive medical records.
 */
export async function recordAuditLog(
  adminClient: SupabaseClient,
  entry: AuditLogEntry
): Promise<void> {
  try {
    const payload = {
      actor_id: entry.actor_id,
      action: entry.action,
      table_name: entry.resource_type,
      record_id: entry.resource_id ?? null,
      new_data: {
        ...(entry.details ?? {}),
        ...(entry.actor_email ? { actor_email: entry.actor_email } : {}),
        ...(entry.user_agent ? { user_agent: entry.user_agent } : {}),
      },
      ip_address: entry.ip_address ?? null,
      created_at: new Date().toISOString(),
    };

    const { error } = await adminClient.from('audit_logs').insert(payload);
    if (error) {
      console.warn('Audit log write warning (non-fatal):', error.message);
    }
  } catch (err) {
    console.warn('Audit log write failed with exception (non-fatal):', err);
  }
}
