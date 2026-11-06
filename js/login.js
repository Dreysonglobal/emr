/**
 * Dreyson Global Hospital — EMR System
 * Login Page Controller (js/login.js)
 *
 * Handles the sign-in form, password visibility toggle,
 * password reset flow, and session checking.
 */

import { signIn, requestPasswordReset, updatePassword, redirectToDashboard } from './auth.js';
import { supabase, IS_PASSWORD_SETUP_REDIRECT } from './supabase-client.js';
import { isValidEmail } from './utils.js';

// ─── DOM References ───────────────────────────────────────────────────────────
const loginForm         = document.getElementById('login-form');
const loginBtn          = document.getElementById('login-btn');
const emailInput        = document.getElementById('email');
const passwordInput     = document.getElementById('password');
const togglePassword    = document.getElementById('toggle-password');
const loginError        = document.getElementById('login-error');
const loginErrorText    = document.getElementById('login-error-text');
const loginSuccess      = document.getElementById('login-success');
const loginSuccessText  = document.getElementById('login-success-text');
const emailError        = document.getElementById('email-error');
const passwordError     = document.getElementById('password-error');

const mainFormSection   = document.getElementById('main-form-section');
const resetFormSection  = document.getElementById('reset-form-section');
const showResetBtn      = document.getElementById('show-reset');
const backToLoginBtn    = document.getElementById('back-to-login');
const resetForm         = document.getElementById('reset-form');
const resetBtn          = document.getElementById('reset-btn');
const resetEmailInput   = document.getElementById('reset-email');
const resetError        = document.getElementById('reset-error');
const resetErrorText    = document.getElementById('reset-error-text');
const resetSuccess      = document.getElementById('reset-success');
const resetSuccessText  = document.getElementById('reset-success-text');
const passwordFormSection = document.getElementById('password-form-section');
const passwordForm      = document.getElementById('password-form');
const newPasswordInput  = document.getElementById('new-password');
const confirmPasswordInput = document.getElementById('confirm-password');
const passwordUpdateError = document.getElementById('password-update-error');
const passwordUpdateErrorText = document.getElementById('password-update-error-text');
const passwordUpdateSuccess = document.getElementById('password-update-success');
const passwordUpdateSuccessText = document.getElementById('password-update-success-text');
const passwordUpdateBtn = document.getElementById('password-update-btn');

let isPasswordRecovery = IS_PASSWORD_SETUP_REDIRECT;

function showPasswordUpdateForm() {
  isPasswordRecovery = true;
  mainFormSection.classList.add('hidden');
  resetFormSection.classList.remove('visible');
  passwordFormSection.classList.add('visible');
  newPasswordInput.focus();
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') showPasswordUpdateForm();
});

// ─── Session Check on Load ────────────────────────────────────────────────────
async function checkExistingSession() {
  const { data } = await supabase.auth.getSession();
  if (isPasswordRecovery) {
    showPasswordUpdateForm();
  } else if (data?.session) {
    // Load profile to get role
    const { data: profileData } = await supabase
      .from('profiles')
      .select('role, status')
      .eq('id', data.session.user.id)
      .single();

    if (profileData?.status === 'active') {
      redirectToDashboard(profileData.role, true);
    }
  }
}

checkExistingSession();

// ─── Show/Hide Password ────────────────────────────────────────────────────────
togglePassword?.addEventListener('click', () => {
  const isPassword = passwordInput.type === 'password';
  passwordInput.type = isPassword ? 'text' : 'password';
  togglePassword.textContent = isPassword ? '🙈' : '👁';
  togglePassword.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
});

// ─── Helper Functions ──────────────────────────────────────────────────────────
function setLoginLoading(loading) {
  loginBtn.disabled = loading;
  loginBtn.classList.toggle('loading', loading);
}

function setResetLoading(loading) {
  resetBtn.disabled = loading;
  resetBtn.classList.toggle('loading', loading);
}

function showLoginError(msg) {
  loginErrorText.textContent = msg;
  loginError.classList.add('visible');
  loginSuccess.classList.remove('visible');
}

function hideLoginError() {
  loginError.classList.remove('visible');
}

function showLoginSuccess(msg) {
  loginSuccessText.textContent = msg;
  loginSuccess.classList.add('visible');
  loginError.classList.remove('visible');
}

function clearFieldErrors() {
  emailError.textContent = '';
  passwordError.textContent = '';
  emailInput.classList.remove('error');
  passwordInput.classList.remove('error');
}

function validateLoginForm() {
  let valid = true;
  clearFieldErrors();

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email) {
    emailError.textContent = 'Email address is required.';
    emailInput.classList.add('error');
    emailInput.focus();
    valid = false;
  } else if (!isValidEmail(email)) {
    emailError.textContent = 'Please enter a valid email address.';
    emailInput.classList.add('error');
    emailInput.focus();
    valid = false;
  }

  if (!password) {
    passwordError.textContent = 'Password is required.';
    passwordInput.classList.add('error');
    if (valid) passwordInput.focus();
    valid = false;
  }

  return valid;
}

// ─── Login Form Submit ─────────────────────────────────────────────────────────
loginForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideLoginError();

  if (!validateLoginForm()) return;

  const email    = emailInput.value.trim();
  const password = passwordInput.value;

  setLoginLoading(true);

  try {
    const { session, profile, error } = await signIn(email, password);

    if (error || !session || !profile) {
      showLoginError(error || 'Sign in failed. Please try again.');
      setLoginLoading(false);
      return;
    }

    // Successful sign in — redirect to role dashboard
    showLoginSuccess('Signed in successfully. Redirecting…');
    setTimeout(() => {
      redirectToDashboard(profile.role, true);
    }, 600);

  } catch (err) {
    console.error('Login error:', err);
    showLoginError('An unexpected error occurred. Please check your connection and try again.');
    setLoginLoading(false);
  }
});

// Prevent accidental re-submit on Enter
loginForm?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const tag = e.target.tagName.toLowerCase();
    if (tag !== 'button') return; // let button handle it
  }
});

// ─── Password Reset Flow ───────────────────────────────────────────────────────
showResetBtn?.addEventListener('click', () => {
  passwordFormSection.classList.remove('visible');
  mainFormSection.classList.add('hidden');
  resetFormSection.classList.add('visible');
  resetEmailInput.value = emailInput.value.trim();
  resetEmailInput.focus();
  // Scroll to top
  document.querySelector('.login-panel')?.scrollTo({ top: 0, behavior: 'smooth' });
});

backToLoginBtn?.addEventListener('click', () => {
  resetFormSection.classList.remove('visible');
  passwordFormSection.classList.remove('visible');
  mainFormSection.classList.remove('hidden');
  resetError.classList.remove('visible');
  resetSuccess.classList.remove('visible');
  emailInput.focus();
});

passwordForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  passwordUpdateError.classList.remove('visible');
  passwordUpdateSuccess.classList.remove('visible');

  const password = newPasswordInput.value;
  if (password.length < 8) {
    passwordUpdateErrorText.textContent = 'Password must be at least 8 characters long.';
    passwordUpdateError.classList.add('visible');
    newPasswordInput.focus();
    return;
  }
  if (password !== confirmPasswordInput.value) {
    passwordUpdateErrorText.textContent = 'The passwords do not match.';
    passwordUpdateError.classList.add('visible');
    confirmPasswordInput.focus();
    return;
  }

  passwordUpdateBtn.disabled = true;
  passwordUpdateBtn.classList.add('loading');
  try {
    const { success, error } = await updatePassword(password);
    if (!success) {
      passwordUpdateErrorText.textContent = error || 'Unable to update your password. Please try again.';
      passwordUpdateError.classList.add('visible');
      return;
    }

    await supabase.auth.signOut();
    passwordUpdateSuccessText.textContent = 'Your password has been updated. Return to sign in with your new password.';
    passwordUpdateSuccess.classList.add('visible');
    passwordForm.reset();
    setTimeout(() => {
      window.location.replace(new URL('./index.html', window.location.href).toString());
    }, 1600);
  } catch (err) {
    console.error('Password update error:', err);
    passwordUpdateErrorText.textContent = 'An unexpected error occurred. Please try again.';
    passwordUpdateError.classList.add('visible');
  } finally {
    passwordUpdateBtn.disabled = false;
    passwordUpdateBtn.classList.remove('loading');
  }
});

resetForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  resetError.classList.remove('visible');
  resetSuccess.classList.remove('visible');

  const email = resetEmailInput.value.trim();

  if (!email || !isValidEmail(email)) {
    resetErrorText.textContent = 'Please enter a valid email address.';
    resetError.classList.add('visible');
    resetEmailInput.focus();
    return;
  }

  setResetLoading(true);

  try {
    const { success, error } = await requestPasswordReset(email);

    if (!success) {
      resetErrorText.textContent = error || 'Failed to send reset email. Please try again.';
      resetError.classList.add('visible');
    } else {
      resetSuccessText.textContent = `A password reset link has been sent to ${email}. Please check your inbox and spam folder.`;
      resetSuccess.classList.add('visible');
      resetForm.reset();
    }
  } catch (err) {
    console.error('Reset error:', err);
    resetErrorText.textContent = 'An unexpected error occurred. Please try again.';
    resetError.classList.add('visible');
  } finally {
    setResetLoading(false);
  }
});
