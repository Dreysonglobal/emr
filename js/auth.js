/**
 * Dreyson Global Hospital — EMR System
 * Authentication Module
 *
 * Handles login, logout, password reset, session verification,
 * and secure profile loading from the database.
 *
 * SECURITY NOTE: Role determination always comes from the database (profiles table)
 * protected by RLS, never from localStorage, URL parameters, or JWT claims alone.
 */

import { supabase } from './supabase-client.js';
import { APP_CONFIG } from './config.js';

/**
 * Sign in with email and password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{session, profile, error}>}
 */
export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { session: null, profile: null, error: friendlyAuthError(error) };
  }

  // Load profile from database — never trust client-side role assignment
  const profile = await loadUserProfile(data.user.id);

  if (!profile) {
    await supabase.auth.signOut();
    return {
      session: null,
      profile: null,
      error: 'Your account has no staff profile. Please contact the administrator.',
    };
  }

  if (profile.status !== 'active') {
    await supabase.auth.signOut();
    return {
      session: null,
      profile: null,
      error: 'Your account has been suspended or deactivated. Please contact the administrator.',
    };
  }

  return { session: data.session, profile, error: null };
}

/**
 * Sign out the current user and clear session.
 */
export async function signOut() {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.warn('Supabase sign-out warning:', error);
    }
  } catch (err) {
    console.warn('Network or session sign-out exception:', err);
  } finally {
    // Clear all session storage
    sessionStorage.clear();
    // Clear any Supabase client session tokens in localStorage if present
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('sb-') || key.includes('supabase') || key.startsWith('dgh_') || key.startsWith('lbc_'))) {
        localStorage.removeItem(key);
      }
    }
  }
}

/**
 * Load the staff profile for a given auth user ID.
 * Queries the database — protected by RLS.
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
export async function loadUserProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, email, role, staff_id, department, phone, status')
    .eq('id', userId)
    .single();

  if (error || !data) return null;
  return data;
}

/**
 * Get the current user's profile from the database.
 * Used on protected pages to verify session and role.
 * @returns {Promise<Object|null>}
 */
export async function requireAuth() {
  const { data: sessionData } = await supabase.auth.getSession();

  if (!sessionData?.session) {
    return null;
  }

  const profile = await loadUserProfile(sessionData.session.user.id);

  if (!profile || profile.status !== 'active') {
    await supabase.auth.signOut();
    return null;
  }

  return profile;
}

/**
 * Send a password reset email.
 * @param {string} email
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
export async function requestPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: new URL('./index.html', window.location.href).toString(),
  });

  if (error) {
    return { success: false, error: friendlyAuthError(error) };
  }
  return { success: true, error: null };
}

/**
 * Update the authenticated user's password (after reset flow).
 * @param {string} newPassword
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    return { success: false, error: friendlyAuthError(error) };
  }
  return { success: true, error: null };
}

/**
 * Redirect user to their role-appropriate dashboard.
 * @param {string} role
 * @param {boolean} fromRoot - whether we're navigating from the root index.html
 */
export function redirectToDashboard(role, fromRoot = true) {
  const routes = fromRoot
    ? APP_CONFIG.DASHBOARD_ROUTES_FROM_ROOT
    : APP_CONFIG.DASHBOARD_ROUTES;

  const destination = routes[role];
  if (destination) {
    window.location.href = destination;
  } else {
    console.error('Unknown role:', role);
    signOut().then(() => {
      window.location.href = fromRoot ? './index.html' : '../index.html';
    });
  }
}

/**
 * Redirect to login page.
 * @param {boolean} fromPages - whether we're in the pages/ subdirectory
 */
export function redirectToLogin(fromPages = false) {
  const loginPath = fromPages ? '../index.html' : './index.html';
  window.location.href = loginPath;
}

/**
 * Convert Supabase auth errors to user-friendly messages.
 * Never expose internal error details to the user.
 * @param {Error} error
 * @returns {string}
 */
function friendlyAuthError(error) {
  const msg = error?.message?.toLowerCase() || '';

  if (msg.includes('invalid login credentials') || msg.includes('invalid email or password')) {
    return 'Invalid email address or password. Please try again.';
  }
  if (msg.includes('email not confirmed')) {
    return 'Please confirm your email address before signing in.';
  }
  if (msg.includes('too many requests')) {
    return 'Too many sign-in attempts. Please wait a few minutes and try again.';
  }
  if (msg.includes('user not found')) {
    return 'Invalid email address or password. Please try again.';
  }
  if (msg.includes('network')) {
    return 'Network error. Please check your internet connection and try again.';
  }
  return 'An error occurred. Please try again or contact the administrator.';
}
