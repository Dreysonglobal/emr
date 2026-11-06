/**
 * Dreyson Global Hospital — EMR System
 * Shared CORS Configuration
 *
 * APP_ORIGIN env var = the production HTTPS origin (set in Supabase dashboard secrets).
 * Must be set to: https://dreysonglobal.github.io
 *
 * In development, requests from localhost / 127.0.0.1 on any port are also permitted
 * so that Live Server, Vite, or any local dev server can reach the Edge Functions.
 *
 * SECURITY: Do NOT set APP_ORIGIN to a wildcard (*).
 * Keep it as the exact production frontend origin.
 *
 * CORS REQUIREMENTS:
 * 1. OPTIONS preflight MUST return HTTP 200 with the correct headers.
 * 2. OPTIONS is handled BEFORE any authentication check.
 * 3. CORS headers are included on ALL responses (success and error).
 * 4. Allowed headers include: authorization, x-client-info, apikey, content-type.
 */

/** Hard-coded production origin — fallback when APP_ORIGIN secret is missing. */
const PRODUCTION_ORIGIN = 'https://dreysonglobal.github.io';

const appOrigin = Deno.env.get('APP_ORIGIN')?.trim() || PRODUCTION_ORIGIN;

/** Origins that are always allowed (local development). */
const DEV_ORIGINS = new Set([
  'http://localhost',
  'http://127.0.0.1',
]);

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  // Exact match for the configured production origin
  if (origin === appOrigin) return true;
  // Also always allow the hard-coded production origin in case of misconfiguration
  if (origin === PRODUCTION_ORIGIN) return true;
  // Allow any port on localhost / 127.0.0.1 for local development
  try {
    const url = new URL(origin);
    return DEV_ORIGINS.has(`${url.protocol}//${url.hostname}`);
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  // Echo the request origin back if it is allowed; otherwise echo the production origin.
  const allowed = isAllowedOrigin(origin) ? origin! : appOrigin;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}

/**
 * Handle CORS preflight requests (OPTIONS).
 *
 * IMPORTANT: Must always return HTTP 200 for valid preflight requests.
 * Never reject OPTIONS based on missing auth tokens — browsers do not send
 * credentials on preflight requests.
 *
 * Returns a 200 OK Response if the request is an OPTIONS preflight from an
 * allowed origin. Returns null if the request is not OPTIONS (let the function
 * proceed to its main handler).
 */
export function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    const origin = req.headers.get('Origin');
    if (!isAllowedOrigin(origin)) {
      // Return 403 without CORS headers for disallowed origins
      return new Response('Forbidden: Origin not allowed', { status: 403 });
    }
    // Return 200 with full CORS headers — no auth check for OPTIONS
    return new Response('ok', {
      status: 200,
      headers: corsHeaders(origin),
    });
  }
  return null;
}

/**
 * Standard JSON response helper with CORS headers.
 * Reads the Origin from the request to echo back the correct allowed origin.
 */
export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
  requestOrigin: string | null = null
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(requestOrigin),
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

/**
 * Standard safe error response helper with CORS headers.
 * Never leaks internal database schemas or sensitive stack traces.
 */
export function errorResponse(
  message: string,
  status = 400,
  details?: unknown,
  extraHeaders: Record<string, string> = {},
  requestOrigin: string | null = null
): Response {
  return jsonResponse(
    {
      success: false,
      error: message,
      ...(details !== undefined ? { details } : {}),
    },
    status,
    extraHeaders,
    requestOrigin
  );
}
