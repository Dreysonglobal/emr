/**
 * Dreyson Global Hospital — EMR System
 * Shared Utilities
 *
 * Common helper functions used across the entire application.
 * No business logic — pure utility functions only.
 */

import { APP_CONFIG } from './config.js';

// ─── Date & Time ─────────────────────────────────────────────────────────────

/**
 * Format a date string or Date object for display.
 * @param {string|Date|null} value
 * @param {string} [format='long'] - 'long', 'short', 'datetime', 'time'
 * @returns {string}
 */
export function formatDate(value, format = 'long') {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return '—';

  const opts = {
    long: { day: '2-digit', month: 'long', year: 'numeric' },
    short: { day: '2-digit', month: 'short', year: 'numeric' },
    datetime: { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' },
    time: { hour: '2-digit', minute: '2-digit' },
  };

  return date.toLocaleDateString('en-GB', opts[format] || opts.long);
}

/**
 * Format a timestamp as a relative time string.
 * @param {string|Date} value
 * @returns {string}
 */
export function timeAgo(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(date, 'short');
}

/**
 * Calculate age from date of birth.
 * @param {string|Date} dob
 * @returns {string}
 */
export function calculateAge(dob) {
  if (!dob) return '—';
  const birth = new Date(dob);
  const now = new Date();
  const years = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  const age = m < 0 || (m === 0 && now.getDate() < birth.getDate()) ? years - 1 : years;
  if (age < 1) {
    const months = Math.floor((now - birth) / (1000 * 60 * 60 * 24 * 30));
    return `${months} month${months !== 1 ? 's' : ''}`;
  }
  return `${age} year${age !== 1 ? 's' : ''}`;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/**
 * Format a role string for display.
 * @param {string} role
 * @returns {string}
 */
export function formatRole(role) {
  const labels = {
    admin: 'Administrator',
    doctor: 'Doctor',
    nurse: 'Nurse',
    pharmacist: 'Pharmacist',
    front_desk: 'Front Desk',
    lab_technician: 'Laboratory Technician',
  };
  return labels[role] || role;
}

/**
 * Format a transfer status for display.
 * @param {string} status
 * @returns {string}
 */
export function formatTransferStatus(status) {
  const labels = {
    draft: 'Draft',
    sent: 'Sent',
    received: 'Received',
    in_progress: 'In Progress',
    awaiting_results: 'Awaiting Results',
    awaiting_pharmacy: 'Awaiting Pharmacy',
    completed: 'Completed',
    returned: 'Returned',
    cancelled: 'Cancelled',
  };
  return labels[status] || status;
}

/**
 * Get CSS class for a transfer/workflow status badge.
 * @param {string} status
 * @returns {string}
 */
export function getStatusBadgeClass(status) {
  const classes = {
    draft: 'badge-secondary',
    sent: 'badge-primary',
    received: 'badge-info',
    in_progress: 'badge-warning',
    awaiting_results: 'badge-warning',
    awaiting_pharmacy: 'badge-warning',
    completed: 'badge-success',
    returned: 'badge-returned',
    cancelled: 'badge-danger',
    active: 'badge-success',
    suspended: 'badge-warning',
    deactivated: 'badge-danger',
    pending: 'badge-warning',
    finalized: 'badge-success',
    amended: 'badge-info',
  };
  return classes[status] || 'badge-secondary';
}

/**
 * Format a currency amount.
 * @param {number} amount
 * @returns {string}
 */
export function formatCurrency(amount) {
  if (amount === null || amount === undefined) return '₦0.00';
  return `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Calculate BMI from weight (kg) and height (cm).
 * @param {number} weightKg
 * @param {number} heightCm
 * @returns {number|null}
 */
export function calculateBMI(weightKg, heightCm) {
  if (!weightKg || !heightCm || heightCm <= 0) return null;
  const heightM = heightCm / 100;
  return Math.round((weightKg / (heightM * heightM)) * 10) / 10;
}

/**
 * Interpret BMI value.
 * @param {number} bmi
 * @returns {string}
 */
export function interpretBMI(bmi) {
  if (!bmi) return '';
  if (bmi < 18.5) return 'Underweight';
  if (bmi < 25) return 'Normal';
  if (bmi < 30) return 'Overweight';
  return 'Obese';
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate an email address.
 * @param {string} email
 * @returns {boolean}
 */
export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email?.trim() || '');
}

/**
 * Validate a Nigerian phone number (basic format check).
 * @param {string} phone
 * @returns {boolean}
 */
export function isValidPhone(phone) {
  const cleaned = (phone || '').replace(/\s+/g, '').replace(/^(\+234|0)/, '');
  return /^\d{10}$/.test(cleaned);
}

/**
 * Validate required form fields. Returns an array of error messages.
 * @param {Object} fields - { fieldName: value }
 * @param {string[]} required - list of required field names
 * @returns {string[]}
 */
export function validateRequired(fields, required) {
  const errors = [];
  for (const field of required) {
    const value = fields[field];
    if (value === null || value === undefined || String(value).trim() === '') {
      errors.push(`${field.replace(/_/g, ' ')} is required`);
    }
  }
  return errors;
}

// ─── DOM Utilities ────────────────────────────────────────────────────────────

/**
 * Safely escape HTML to prevent XSS.
 * Always use this before inserting user-generated content into innerHTML.
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Show a loading spinner in a container.
 * @param {HTMLElement} container
 * @param {string} [message='Loading...']
 */
export function showLoading(container, message = 'Loading...') {
  if (!container) return;
  container.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

/**
 * Show an empty state message in a container.
 * @param {HTMLElement} container
 * @param {string} message
 * @param {string} [icon='📭']
 */
export function showEmpty(container, message, icon = '📭') {
  if (!container) return;
  container.innerHTML = `
    <div class="empty-state">
      <span class="empty-icon">${icon}</span>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

/**
 * Show an error state in a container.
 * @param {HTMLElement} container
 * @param {string} message
 */
export function showError(container, message) {
  if (!container) return;
  container.innerHTML = `
    <div class="error-state">
      <span class="error-icon">⚠️</span>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

/**
 * Display a toast notification.
 * @param {string} message
 * @param {'success'|'error'|'warning'|'info'} type
 * @param {number} [duration=4000]
 */
export function showToast(message, type = 'info', duration = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'warning' ? '⚠' : 'ℹ';

  const msg = document.createElement('span');
  msg.className = 'toast-message';
  msg.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.addEventListener('click', () => toast.remove());

  toast.appendChild(icon);
  toast.appendChild(msg);
  toast.appendChild(closeBtn);

  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => toast.classList.add('toast-visible'));

  // Auto-remove
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * Show a confirmation dialog. Returns a promise resolving to true/false.
 * @param {string} message
 * @param {string} [title='Confirm']
 * @param {string} [confirmText='Confirm']
 * @param {string} [type='warning']
 * @returns {Promise<boolean>}
 */
export function showConfirm(message, title = 'Confirm', confirmText = 'Confirm', type = 'warning') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.innerHTML = `
      <div class="modal modal-sm">
        <div class="modal-header modal-header-${type}">
          <h3>${escapeHtml(title)}</h3>
        </div>
        <div class="modal-body">
          <p>${escapeHtml(message)}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="confirm-cancel">Cancel</button>
          <button class="btn btn-${type === 'danger' ? 'danger' : 'primary'}" id="confirm-ok">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#confirm-cancel').addEventListener('click', () => {
      overlay.remove();
      resolve(false);
    });
    overlay.querySelector('#confirm-ok').addEventListener('click', () => {
      overlay.remove();
      resolve(true);
    });
  });
}

// ─── Form Utilities ───────────────────────────────────────────────────────────

/**
 * Collect all form data into a plain object.
 * @param {HTMLFormElement} form
 * @returns {Object}
 */
export function collectFormData(form) {
  const data = {};
  const formData = new FormData(form);
  for (const [key, value] of formData.entries()) {
    data[key] = value;
  }
  return data;
}

/**
 * Populate a form with values from an object.
 * @param {HTMLFormElement} form
 * @param {Object} data
 */
export function populateForm(form, data) {
  for (const [key, value] of Object.entries(data)) {
    const el = form.elements[key];
    if (!el) continue;
    if (el.type === 'checkbox') {
      el.checked = Boolean(value);
    } else if (el.type === 'date' && value) {
      el.value = value.substring(0, 10);
    } else {
      el.value = value ?? '';
    }
  }
}

/**
 * Show form field validation error.
 * @param {HTMLElement} field
 * @param {string} message
 */
export function showFieldError(field, message) {
  field.classList.add('error');
  let err = field.parentElement.querySelector('.field-error');
  if (!err) {
    err = document.createElement('span');
    err.className = 'field-error';
    field.parentElement.appendChild(err);
  }
  err.textContent = message;
}

/**
 * Clear all form field errors.
 * @param {HTMLFormElement} form
 */
export function clearFormErrors(form) {
  form.querySelectorAll('.error').forEach((el) => el.classList.remove('error'));
  form.querySelectorAll('.field-error').forEach((el) => el.remove());
}

// ─── Debounce & Throttle ──────────────────────────────────────────────────────

/**
 * Debounce a function.
 * @param {Function} fn
 * @param {number} delay
 * @returns {Function}
 */
export function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ─── Pagination ───────────────────────────────────────────────────────────────

/**
 * Render a pagination control.
 * @param {HTMLElement} container
 * @param {number} currentPage
 * @param {number} totalPages
 * @param {Function} onPage - callback with page number
 */
export function renderPagination(container, currentPage, totalPages, onPage) {
  if (!container || totalPages <= 1) {
    if (container) container.innerHTML = '';
    return;
  }

  const pages = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= currentPage - 1 && i <= currentPage + 1)) {
      pages.push(i);
    } else if (pages[pages.length - 1] !== '...') {
      pages.push('...');
    }
  }

  container.innerHTML = `
    <div class="pagination">
      <button class="page-btn" ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">‹ Prev</button>
      ${pages.map((p) => p === '...'
        ? `<span class="page-ellipsis">...</span>`
        : `<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`
      ).join('')}
      <button class="page-btn" ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">Next ›</button>
    </div>
  `;

  container.querySelectorAll('.page-btn:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', () => onPage(Number(btn.dataset.page)));
  });
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

/**
 * Generate a display avatar from initials.
 * @param {string} name
 * @returns {string} - initials string (max 2 chars)
 */
export function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Safely parse a JSON string. Returns null on failure.
 * @param {string} str
 * @returns {*}
 */
export function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Format a file size in bytes to a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
