/**
 * Dreyson Global Hospital — EMR System
 * Supabase Client Initialization
 *
 * Uses the pinned Supabase JS v2 client for stability.
 * The client is initialized once and exported as a singleton.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const authRedirect = new URL(window.location.href);
const authRedirectHash = new URLSearchParams(authRedirect.hash.slice(1));
export const IS_PASSWORD_SETUP_REDIRECT =
  ['recovery', 'invite'].includes(authRedirectHash.get('type'))
  || ['recovery', 'invite'].includes(authRedirect.searchParams.get('type'))
  || authRedirect.searchParams.has('code');

// Pin to a specific version to avoid breaking changes from unversioned CDN URLs
const { createClient } = await import(
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.7/+esm'
);

/**
 * Singleton Supabase client instance.
 * Uses the publishable anon key — access is controlled entirely by RLS policies.
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    storage: window.sessionStorage, // Use sessionStorage instead of localStorage for additional safety
  },
});

/**
 * Get the current authenticated session.
 * @returns {Promise<{session: import('@supabase/supabase-js').Session|null}>}
 */
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

/**
 * Get the current authenticated user.
 * @returns {Promise<import('@supabase/supabase-js').User|null>}
 */
export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user;
}
