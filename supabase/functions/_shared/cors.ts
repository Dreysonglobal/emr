/**
 * Dreyson Global Hospital — EMR System
 * Shared CORS Configuration
 *
 * PRODUCTION ORIGIN: https://dreysonglobal.github.io
 *
 * In development, requests from localhost / 127.0.0.1 on any port are also permitted
 * so that Live Server, Vite, or local test harnesses can reach the Edge Functions.
 *
 * SECURITY:
 * 1. Preflight (OPTIONS) requests are handled immediately before any auth check.
 * 2. Successful preflight returns HTTP 200 with standard CORS headers.
 * 3. Allowed methods: POST, OPTIONS.
 * 4. Allowed headers: authorization, apikey, x-client-info, content-type, accept.
 * 5. CORS headers are attached to EVERY response (200, 201, 4xx, 5xx).
 * 6. Wildcard origins are NOT used.
 */

/** Canonical production frontend origin for Dreyson Global Hospital */
export const PRODUCTION_ORIGIN = 'https://dreysonglobal.github.io';

/** Origins that are always allowed for local development. */
const DEV_ORIGINS = new Set([
  'http://localhost',
  'http://127.0.0.1',
]);

/**
 * Normalizes an origin string (trimmed, lowercased, trailing slashes removed).
 */
export function normalizeOrigin(origin: string | null | undefined): string {
  if (!origin) return '';
  return origin.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * Checks whether the incoming request origin is permitted.
 */
export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  const cleanOrigin = normalizeOrigin(origin);
  const cleanProd = normalizeOrigin(PRODUCTION_ORIGIN);

  // 1. Exact match against canonical Dreyson Global Hospital origin
  if (cleanOrigin === cleanProd) return true;

  // 2. Match against configured APP_ORIGIN environment secret (if present)
  const envOrigin = normalizeOrigin(Deno.env.get('APP_ORIGIN'));
  if (envOrigin && cleanOrigin === envOrigin) return true;

  // 3. Local development origins (localhost or 127.0.0.1 on any port)
  try {
    const url = new URL(cleanOrigin);
    const hostBase = `${url.protocol}//${url.hostname}`;
    if (DEV_ORIGINS.has(hostBase)) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Generates CORS headers for a given request origin.
 */
export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = isAllowedOrigin(origin)
    ? origin!.trim().replace(/\/+$/, '')
    : PRODUCTION_ORIGIN;

  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type, accept',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

/**
 * Handles CORS preflight requests (OPTIONS).
 *
 * Preflight requests MUST return HTTP 200 with CORS headers immediately,
 * without checking auth tokens or parsing request bodies.
 */
export function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    const origin = req.headers.get('Origin') || req.headers.get('origin');
    if (!isAllowedOrigin(origin)) {
      return new Response('Forbidden: Origin not allowed', { status: 403 });
    }
    return new Response('ok', {
      status: 200,
      headers: corsHeaders(origin),
    });
  }
  return null;
}

/**
 * Standard JSON response helper with CORS headers.
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
