/**
 * Dreyson Global Hospital — EMR System
 * Admin Dashboard Controller
 *
 * Handles all admin views: Overview, Staff Management,
 * System Settings, and Audit Logs.
 */

import { requireAuth, signOut } from './auth.js';
import { supabase } from './supabase-client.js';
import { APP_CONFIG, SUPABASE_ANON_KEY } from './config.js';
import {
  getInitials, formatRole, formatDate, getStatusBadgeClass,
  showToast, debounce, timeAgo, escapeHtml, renderPagination,
  showLoading, showEmpty, showError, showConfirm, collectFormData,
  populateForm,
} from './utils.js';

// ─── State ────────────────────────────────────────────────────────────────────
let currentProfile = null;
let currentView = 'overview';

// Lazy-load flags
const viewLoaded = {
  overview: false,
  staff: false,
  settings: false,
  audit: false,
};

// Staff list state
let staffRoleFilter = '';
let staffStatusFilter = '';
let staffSearchQuery = '';

// Audit log state
let auditPage = 1;
const AUDIT_PAGE_SIZE = 20;
let auditTableFilter = '';
let auditDateFrom = '';
let auditDateTo = '';

// Edit staff context
let editStaffUserId = null;
/** The DOM button that triggered the Edit modal — used to restore focus on close. */
let editStaffTriggerBtn = null;

// Delete staff context
let deleteStaffUserId = null;
/** The DOM button that triggered the Delete modal — used to restore focus on close. */
let deleteStaffTriggerBtn = null;

const HIDDEN_STAFF_STORAGE_KEY = 'dgh_hidden_staff_ids';

function getHiddenStaffIds() {
  try {
    const raw = localStorage.getItem(HIDDEN_STAFF_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) {
    console.warn('Failed to parse hidden staff IDs from localStorage:', e);
    return new Set();
  }
}

function addHiddenStaffId(id) {
  if (!id) return;
  try {
    const set = getHiddenStaffIds();
    set.add(id);
    localStorage.setItem(HIDDEN_STAFF_STORAGE_KEY, JSON.stringify([...set]));
  } catch (e) {
    console.warn('Failed to save hidden staff ID to localStorage:', e);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  initUI();
  try {
    const profile = await requireAuth();
    if (!profile || profile.role !== 'admin') {
      window.location.href = '../index.html';
      return;
    }

    currentProfile = profile;
    renderProfile(profile);
    await loadOverview();
    viewLoaded.overview = true;
  } catch (err) {
    console.error('Admin dashboard initialization failed:', err);
    showToast('Unable to verify your admin session. Check your connection and sign in again.', 'error');
  }
}

// ─── UI Initialization ────────────────────────────────────────────────────────
function renderProfile(profile) {
  const initials = getInitials(profile.full_name);

  ['sidebar-avatar', 'topbar-avatar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = initials;
  });
  document.getElementById('sidebar-name').textContent = profile.full_name;
  document.getElementById('sidebar-role').textContent = formatRole(profile.role);
  document.getElementById('topbar-name').textContent = profile.full_name;
  document.getElementById('dropdown-name').textContent = profile.full_name;
  document.getElementById('dropdown-role').textContent = formatRole(profile.role);
}

function initUI() {
  // Sidebar toggle
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('mobile-open');
    document.getElementById('sidebar-overlay').classList.toggle('visible');
  });
  document.getElementById('sidebar-overlay').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebar-overlay').classList.remove('visible');
  });

  // Profile dropdown
  document.getElementById('profile-btn').addEventListener('click', () =>
    document.getElementById('profile-menu').classList.toggle('open'));
  document.addEventListener('click', e => {
    const menu = document.getElementById('profile-menu');
    if (menu && !menu.contains(e.target) && e.target !== document.getElementById('profile-btn'))
      menu.classList.remove('open');
  });

  // Sign out
  document.getElementById('sign-out-btn').addEventListener('click', handleSignOut);
  document.getElementById('dropdown-signout').addEventListener('click', handleSignOut);

  // Notification panel — admin has no dynamic notifications
  document.getElementById('notif-btn').addEventListener('click', () =>
    document.getElementById('notif-panel').classList.toggle('open'));
  document.getElementById('notif-close').addEventListener('click', () =>
    document.getElementById('notif-panel').classList.remove('open'));
  // Show static "no notifications" message
  const notifCount = document.getElementById('notif-count');
  if (notifCount) notifCount.style.display = 'none';
  const notifList = document.getElementById('notif-list');
  if (notifList) notifList.innerHTML = '<div class="empty-state" style="padding:1.5rem;text-align:center;color:var(--text-muted)">No notifications</div>';

  // Nav items
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      switchView(el.dataset.view);
    });
  });

  // Overview buttons
  document.getElementById('go-settings-btn')?.addEventListener('click', () => switchView('settings'));
  document.getElementById('view-all-audit-btn')?.addEventListener('click', () => switchView('audit'));
  document.getElementById('refresh-overview-btn')?.addEventListener('click', () => {
    viewLoaded.overview = false;
    loadOverview().then(() => { viewLoaded.overview = true; });
  });

  // Staff view
  document.getElementById('add-staff-btn')?.addEventListener('click', function (e) { openAddStaffModal(e.currentTarget); });
  document.getElementById('staff-role-filter')?.addEventListener('change', debounce(() => {
    staffRoleFilter = document.getElementById('staff-role-filter').value;
    loadStaff();
  }, 300));
  document.getElementById('staff-status-filter')?.addEventListener('change', debounce(() => {
    staffStatusFilter = document.getElementById('staff-status-filter').value;
    loadStaff();
  }, 300));
  document.getElementById('staff-search-input')?.addEventListener('input', debounce(() => {
    staffSearchQuery = document.getElementById('staff-search-input').value.trim();
    loadStaff();
  }, 400));

  // Add Staff modal
  setupModalClose('add-staff-modal-overlay', 'close-add-staff-modal', 'cancel-add-staff');
  document.getElementById('add-staff-form')?.addEventListener('submit', e => {
    e.preventDefault();
    void handleAddStaff();
  });

  // Edit Staff modal
  setupModalClose('edit-staff-modal-overlay', 'close-edit-staff-modal', 'cancel-edit-staff');
  document.getElementById('edit-staff-form')?.addEventListener('submit', e => { e.preventDefault(); handleEditStaff(); });
  document.getElementById('submit-edit-staff-btn')?.addEventListener('click', e => {
    e.preventDefault();
    handleEditStaff();
  });

  // Delete Staff modal
  setupModalClose('delete-staff-modal-overlay', 'close-delete-staff-modal', 'cancel-delete-staff');
  document.getElementById('confirm-delete-staff-btn')?.addEventListener('click', () => {
    handleDeleteStaff();
  });

  // Audit view
  document.getElementById('refresh-audit-btn')?.addEventListener('click', () => {
    auditPage = 1;
    loadAuditLogs();
  });
  document.getElementById('apply-audit-filter-btn')?.addEventListener('click', () => {
    auditTableFilter = document.getElementById('audit-table-filter')?.value.trim() || '';
    auditDateFrom = document.getElementById('audit-date-from')?.value || '';
    auditDateTo = document.getElementById('audit-date-to')?.value || '';
    auditPage = 1;
    loadAuditLogs();
  });
  document.getElementById('clear-audit-filter-btn')?.addEventListener('click', () => {
    auditTableFilter = '';
    auditDateFrom = '';
    auditDateTo = '';
    auditPage = 1;
    const tableFilterEl = document.getElementById('audit-table-filter');
    const dateFromEl = document.getElementById('audit-date-from');
    const dateToEl = document.getElementById('audit-date-to');
    if (tableFilterEl) tableFilterEl.value = '';
    if (dateFromEl) dateFromEl.value = '';
    if (dateToEl) dateToEl.value = '';
    loadAuditLogs();
  });
}

function setupModalClose(overlayId, closeId, cancelId) {
  const close = () => {
    const overlay = document.getElementById(overlayId);
    if (!overlay) return;

    // ── ACCESSIBILITY FIX ──────────────────────────────────────────────────
    // Move keyboard focus OUTSIDE the modal BEFORE setting aria-hidden="true".
    // Setting aria-hidden while a child element is focused causes the browser
    // warning: "Blocked aria-hidden on an element because its descendant
    // retained focus." Moving focus first prevents that warning and keeps
    // keyboard navigation working correctly.
    //
    // Preference order:
    //   1. overlay._triggerElement — the DOM element that opened this modal
    //      (set by the calling code so we can return focus precisely).
    //   2. A button with [data-opens="<overlayId>"] — a declarative trigger.
    //   3. The close / cancel button (guaranteed to exist and be focusable).
    //   4. document.body as a safe fallback.
    const trigger =
      overlay._triggerElement ||
      document.querySelector(`[data-opens="${overlayId}"]`) ||
      document.getElementById(closeId) ||
      document.getElementById(cancelId) ||
      document.body;
    if (trigger && typeof trigger.focus === 'function') {
      trigger.focus();
    }
    overlay._triggerElement = null;

    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
  };
  document.getElementById(closeId)?.addEventListener('click', close);
  document.getElementById(cancelId)?.addEventListener('click', close);
  document.getElementById(overlayId)?.addEventListener('click', e => {
    if (e.target === document.getElementById(overlayId)) close();
  });
  // Allow Escape key to close
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const overlay = document.getElementById(overlayId);
      if (overlay?.classList.contains('active')) close();
    }
  });
}

async function handleSignOut() {
  try {
    await signOut();
  } catch (err) {
    console.error('Admin sign-out failed:', err);
  } finally {
    window.location.replace('../index.html');
  }
}

// ─── View Switching ───────────────────────────────────────────────────────────
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view-section').forEach(s => s.style.display = 'none');
  document.querySelectorAll('.nav-item[data-view]').forEach(n => n.classList.remove('active'));

  const section = document.getElementById(`view-${view}`);
  if (section) section.style.display = 'block';

  const navItem = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (navItem) navItem.classList.add('active');

  const titles = {
    overview: 'Dashboard Overview',
    staff: 'Staff Management',
    settings: 'System Settings',
    audit: 'Audit Logs',
  };
  const pageTitle = document.getElementById('page-title');
  if (pageTitle) pageTitle.textContent = titles[view] || 'Admin Dashboard';

  // Lazy-load views on first visit
  if (view === 'overview' && !viewLoaded.overview) {
    loadOverview().then(() => { viewLoaded.overview = true; });
  }
  if (view === 'staff' && !viewLoaded.staff) {
    loadStaff().then(() => { viewLoaded.staff = true; });
  }
  if (view === 'settings' && !viewLoaded.settings) {
    loadSettings().then(() => { viewLoaded.settings = true; });
  }
  if (view === 'audit' && !viewLoaded.audit) {
    loadAuditLogs().then(() => { viewLoaded.audit = true; });
  }
}

// ─── Edge Function Helper ─────────────────────────────────────────────────────
async function callEdgeFunction(path, body) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return { error: 'Your session has expired. Sign in again.' };
    const res = await fetch(`${APP_CONFIG.EDGE_FUNCTION_URL}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify(body),
    });
    let json = {};
    try {
      json = await res.json();
    } catch {
      json = { error: 'Server returned status ' + res.status };
    }
    if (!res.ok) return { error: json.error || json.message || ('Request failed with status ' + res.status) };
    return { data: json };
  } catch (err) {
    console.error(`Edge Function '${path}' request failed:`, err);
    return { error: 'Unable to reach the server. Check your connection and try again.' };
  }
}

// ─── Overview ─────────────────────────────────────────────────────────────────
async function loadOverview() {
  // Stat card placeholders
  const statIds = [
    'stat-active-staff', 'stat-total-patients', 'stat-active-transfers',
    'stat-today-activity', 'stat-audit-today',
    'stat-role-doctor', 'stat-role-nurse', 'stat-role-pharmacist',
    'stat-role-lab', 'stat-role-frontdesk',
  ];
  statIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '…';
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();

  try {
    // Parallel fetches for all stats
    const [
      activeStaffRes,
      totalPatientsRes,
      activeTransfersRes,
      auditTodayRes,
      // Role counts
      doctorRes,
      nurseRes,
      pharmacistRes,
      labRes,
      frontDeskRes,
      // Today's activity
      patientsRegTodayRes,
      labOrdersTodayRes,
      rxTodayRes,
      // Settings
      settingsRes,
      // Recent audit
      recentAuditRes,
    ] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('patients').select('id', { count: 'exact', head: true }),
      supabase.from('patient_file_transfers')
        .select('id', { count: 'exact', head: true })
        .not('status', 'in', '("completed","returned","cancelled")'),
      supabase.from('audit_logs').select('id', { count: 'exact', head: true }).gte('created_at', todayISO),
      // Role breakdowns
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'doctor').eq('status', 'active'),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'nurse').eq('status', 'active'),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'pharmacist').eq('status', 'active'),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'lab_technician').eq('status', 'active'),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'front_desk').eq('status', 'active'),
      // Today activity
      supabase.from('patients').select('id', { count: 'exact', head: true }).gte('created_at', todayISO),
      supabase.from('laboratory_orders').select('id', { count: 'exact', head: true }).gte('created_at', todayISO),
      supabase.from('prescriptions').select('id', { count: 'exact', head: true }).gte('created_at', todayISO),
      // Settings
      supabase.from('system_settings').select('key, value'),
      // Recent audit (last 5)
      supabase.from('audit_logs')
        .select('id, action, table_name, record_id, created_at, actor:profiles(full_name)')
        .order('created_at', { ascending: false })
        .limit(5),
    ]);

    // Stats
    setStatText('stat-active-staff', activeStaffRes.count ?? 0);
    setStatText('stat-total-patients', totalPatientsRes.count ?? 0);
    setStatText('stat-active-transfers', activeTransfersRes.count ?? 0);
    setStatText('stat-audit-today', auditTodayRes.count ?? 0);

    // Today's activity total
    const todayActivity = (patientsRegTodayRes.count ?? 0) + (labOrdersTodayRes.count ?? 0) + (rxTodayRes.count ?? 0);
    setStatText('stat-today-activity', todayActivity);

    // Role breakdown
    setStatText('stat-role-doctor', doctorRes.count ?? 0);
    setStatText('stat-role-nurse', nurseRes.count ?? 0);
    setStatText('stat-role-pharmacist', pharmacistRes.count ?? 0);
    setStatText('stat-role-lab', labRes.count ?? 0);
    setStatText('stat-role-frontdesk', frontDeskRes.count ?? 0);

    // Account limits table
    renderAccountLimits(settingsRes.data || []);

    // Recent audit table
    renderRecentAudit(recentAuditRes.data || []);

  } catch (err) {
    console.error('Overview load error:', err);
    showToast('Failed to load overview data', 'error');
  }
}

function setStatText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function renderAccountLimits(settings) {
  const container = document.getElementById('account-limits-body');
  if (!container) return;

  const roleKeys = [
    { key: 'max_doctors', label: 'Doctors', defaultVal: APP_CONFIG.ACCOUNT_LIMITS?.doctor ?? '—' },
    { key: 'max_nurses', label: 'Nurses', defaultVal: APP_CONFIG.ACCOUNT_LIMITS?.nurse ?? '—' },
    { key: 'max_pharmacists', label: 'Pharmacists', defaultVal: APP_CONFIG.ACCOUNT_LIMITS?.pharmacist ?? '—' },
    { key: 'max_lab_technicians', label: 'Lab Technicians', defaultVal: APP_CONFIG.ACCOUNT_LIMITS?.lab_technician ?? '—' },
    { key: 'max_front_desk', label: 'Front Desk', defaultVal: APP_CONFIG.ACCOUNT_LIMITS?.front_desk ?? '—' },
  ];

  const settingsMap = {};
  (settings || []).forEach(s => { settingsMap[s.key] = s.value; });

  container.innerHTML = roleKeys.map(({ key, label, defaultVal }) => {
    const val = settingsMap[key] ?? defaultVal;
    return `
      <tr>
        <td>${escapeHtml(label)}</td>
        <td><span class="badge badge-info">${escapeHtml(String(val))}</span></td>
      </tr>
    `;
  }).join('');
}

function renderRecentAudit(logs) {
  const tbody = document.getElementById('recent-audit-tbody');
  if (!tbody) return;

  if (!logs || logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:1rem">No audit events today</td></tr>`;
    return;
  }

  tbody.innerHTML = logs.map(log => `
    <tr>
      <td>${escapeHtml(formatDate(log.created_at, 'datetime'))}</td>
      <td>${escapeHtml(log.actor?.full_name || '—')}</td>
      <td><span class="badge badge-info">${escapeHtml(log.action || '—')}</span></td>
      <td>${escapeHtml(log.table_name || '—')}</td>
      <td style="font-family:monospace;font-size:.8rem">${log.record_id ? escapeHtml(String(log.record_id).slice(0, 8)) + '…' : '—'}</td>
    </tr>
  `).join('');
}

// ─── Staff Management ─────────────────────────────────────────────────────────
async function loadStaff() {
  const container = document.getElementById('staff-list-container');
  if (!container) return;

  container.innerHTML = `<div class="loading-state" style="padding:2rem;text-align:center">Loading staff…</div>`;

  try {
    let query = supabase.from('profiles')
      .select('id, full_name, email, role, department, staff_id, phone, status, created_at')
      .neq('role', 'admin')
      .order('full_name', { ascending: true });

    if (staffRoleFilter) query = query.eq('role', staffRoleFilter);
    if (staffStatusFilter === 'active') query = query.eq('status', 'active');
    else if (staffStatusFilter === 'suspended') query = query.eq('status', 'suspended');
    else if (staffStatusFilter === 'deactivated') query = query.eq('status', 'deactivated');
    if (staffSearchQuery) {
      query = query.or(`full_name.ilike.%${staffSearchQuery}%,email.ilike.%${staffSearchQuery}%,staff_id.ilike.%${staffSearchQuery}%`);
    }

    const { data, error } = await query;
    if (error) { container.innerHTML = `<div class="error-state" style="padding:2rem">Error: ${escapeHtml(error.message)}</div>`; return; }

    // Exclude staff members hidden by the administrator in this browser
    const hiddenIds = getHiddenStaffIds();
    const visibleStaff = (data || []).filter(s => !hiddenIds.has(s.id));

    if (visibleStaff.length === 0) {
      container.innerHTML = `<div class="empty-state" style="padding:2rem;text-align:center">No staff found matching your filters.</div>`;
      return;
    }

    container.innerHTML = `
      <div class="table-responsive">
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th>Staff</th>
              <th>Role</th>
              <th>Department</th>
              <th>Staff ID</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${visibleStaff.map(s => renderStaffRow(s)).join('')}
          </tbody>
        </table>
      </div>
    `;

    // Bind actions
    container.querySelectorAll('.edit-staff-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = visibleStaff.find(x => x.id === btn.dataset.id);
        if (s) openEditStaffModal(s, btn);
      });
    });
    container.querySelectorAll('.deactivate-staff-btn').forEach(btn => {
      btn.addEventListener('click', () => handleDeactivateStaff(btn.dataset.id, btn.dataset.name));
    });
    container.querySelectorAll('.reactivate-staff-btn').forEach(btn => {
      btn.addEventListener('click', () => handleReactivateStaff(btn.dataset.id, btn.dataset.name));
    });
    container.querySelectorAll('.reset-password-btn').forEach(btn => {
      btn.addEventListener('click', () => handleResetPassword(btn.dataset.id, btn.dataset.name));
    });
    container.querySelectorAll('.delete-staff-btn').forEach(btn => {
      btn.addEventListener('click', () => openDeleteStaffModal(
        btn.dataset.id,
        btn.dataset.name,
        btn.dataset.staffid,
        btn
      ));
    });

  } catch (err) {
    console.error('loadStaff error:', err);
    container.innerHTML = `<div class="error-state" style="padding:2rem">Unexpected error loading staff.</div>`;
  }
}

function renderStaffRow(s) {
  const name = escapeHtml(s.full_name || '');
  const email = escapeHtml(s.email || '');
  const initials = getInitials(s.full_name || '');
  const roleBadge = `<span class="badge badge-info">${escapeHtml(formatRole(s.role))}</span>`;
  const statusClass = s.status === 'active' ? 'badge-success' : (s.status === 'suspended' ? 'badge-warning' : 'badge-danger');
  const statusLabel = s.status === 'active' ? 'Active' : (s.status === 'suspended' ? 'Suspended' : 'Deactivated');
  const isInactive = s.status !== 'active';
  // Delete button: only shown for deactivated accounts
  const showDeleteBtn = s.status === 'deactivated';

  return `
    <tr data-staff-id="${escapeHtml(s.id)}">
      <td>
        <div style="display:flex;align-items:center;gap:.6rem">
          <div class="list-item-avatar" style="width:2rem;height:2rem;min-width:2rem;font-size:.75rem">${initials}</div>
          <div>
            <div style="font-weight:600">${name}</div>
            <div style="font-size:.78rem;color:var(--text-muted)">${email}</div>
          </div>
        </div>
      </td>
      <td>${roleBadge}</td>
      <td>${escapeHtml(s.department || '—')}</td>
      <td style="font-family:monospace;font-size:.82rem">${escapeHtml(s.staff_id || '—')}</td>
      <td><span class="badge ${statusClass}">${escapeHtml(statusLabel)}</span></td>
      <td>
        <div style="display:flex;gap:.4rem;flex-wrap:wrap">
          <button class="btn btn-ghost btn-xs edit-staff-btn" data-id="${escapeHtml(s.id)}" title="Edit">✏️ Edit</button>
          <button class="btn btn-ghost btn-xs reset-password-btn" data-id="${escapeHtml(s.id)}" data-name="${name}" title="Reset Password">🔑 Reset</button>
          ${isInactive
            ? `<button class="btn btn-ghost btn-xs reactivate-staff-btn" data-id="${escapeHtml(s.id)}" data-name="${name}" style="color:var(--success)">✅ Reactivate</button>`
            : `<button class="btn btn-ghost btn-xs deactivate-staff-btn" data-id="${escapeHtml(s.id)}" data-name="${name}" style="color:var(--danger)">🚫 Deactivate</button>`
          }
          ${showDeleteBtn
            ? `<button class="btn btn-danger btn-xs delete-staff-btn" data-id="${escapeHtml(s.id)}" data-name="${name}" data-staffid="${escapeHtml(s.staff_id || '—')}" title="Delete this staff member from list" style="margin-left:.2rem">🗑 Delete</button>`
            : ''
          }
        </div>
      </td>
    </tr>
  `;
}

// ─── Add Staff Modal ──────────────────────────────────────────────────────────
function openAddStaffModal(triggerBtn) {
  const form = document.getElementById('add-staff-form');
  if (form) form.reset();
  const overlay = document.getElementById('add-staff-modal-overlay');
  if (overlay) {
    // Store the trigger element so setupModalClose can return focus to it on close.
    overlay._triggerElement = triggerBtn || document.getElementById('add-staff-btn') || null;
    overlay.removeAttribute('aria-hidden');
    overlay.classList.add('active');
    // Move focus to first interactive element inside the modal.
    const firstInput = overlay.querySelector('input, select, button:not([type="button"])');
    if (firstInput) setTimeout(() => firstInput.focus(), 50);
  }
}

async function handleAddStaff() {
  const form = document.getElementById('add-staff-form');
  if (!form) return;

  const full_name = form.querySelector('[name="full_name"]')?.value.trim();
  const email = form.querySelector('[name="email"]')?.value.trim();
  const role = form.querySelector('[name="role"]')?.value;
  const staff_id = form.querySelector('[name="staff_id"]')?.value.trim();
  const department = form.querySelector('[name="department"]')?.value.trim();
  const phone = form.querySelector('[name="phone"]')?.value.trim();
  const password = form.querySelector('[name="password"]')?.value || '';
  const passwordConfirm = form.querySelector('[name="password_confirm"]')?.value || '';

  if (!full_name || !email || !role) {
    showToast('Please fill in all required fields', 'warning');
    return;
  }
  if (Array.from(password).length < 8) {
    showToast('Password must be at least 8 characters long', 'warning');
    return;
  }
  if (password !== passwordConfirm) {
    showToast('The passwords do not match', 'warning');
    return;
  }

  const btn = document.getElementById('submit-add-staff-btn');
  const btnText = btn?.querySelector('.btn-text');
  const btnLoading = btn?.querySelector('.btn-loading');
  if (btn) btn.disabled = true;
  if (btnText) btnText.style.display = 'none';
  if (btnLoading) btnLoading.style.display = 'inline';

  try {
    const { error } = await callEdgeFunction('admin-create-staff', {
      full_name, email, role, staff_id, department, phone, password,
    });

    if (error) {
      showToast(typeof error === 'string' ? error : 'Failed to create staff account', 'error');
      return;
    }

    showToast('Staff account created successfully. No invitation email was sent.', 'success');
    const addOverlay = document.getElementById('add-staff-modal-overlay');
    if (addOverlay) { addOverlay.classList.remove('active'); addOverlay.setAttribute('aria-hidden', 'true'); }
    form.reset();
    viewLoaded.staff = false;
    await loadStaff();
    viewLoaded.staff = true;
  } catch (err) {
    console.error('Staff account creation failed:', err);
    showToast('Unable to create the staff account. Please try again.', 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.style.display = 'inline';
    if (btnLoading) btnLoading.style.display = 'none';
  }
}

// ─── Edit Staff Modal ─────────────────────────────────────────────────────────
function openEditStaffModal(staffMember, triggerBtn) {
  editStaffUserId = staffMember.id;
  editStaffTriggerBtn = triggerBtn || null;
  const form = document.getElementById('edit-staff-form');
  if (!form) return;

  // Populate hidden field
  const hiddenId = document.getElementById('edit-staff-user-id');
  if (hiddenId) hiddenId.value = staffMember.id;

  // Populate visible fields
  const fullNameEl = form.querySelector('[name="full_name"]');
  const departmentEl = form.querySelector('[name="department"]');
  const phoneEl = form.querySelector('[name="phone"]');
  if (fullNameEl) fullNameEl.value = staffMember.full_name || '';
  if (departmentEl) departmentEl.value = staffMember.department || '';
  if (phoneEl) phoneEl.value = staffMember.phone || '';

  // Remove aria-hidden BEFORE making the overlay visible, then shift focus in.
  // This prevents the "Blocked aria-hidden on element because its descendant
  // retained focus" accessibility warning.
  const editOverlay = document.getElementById('edit-staff-modal-overlay');
  if (editOverlay) {
    // Store the trigger so setupModalClose can return focus to it on close.
    editOverlay._triggerElement = editStaffTriggerBtn;
    editOverlay.removeAttribute('aria-hidden');
    editOverlay.classList.add('active');
    // Move focus into the first real input after the browser has painted the modal.
    const firstInput = editOverlay.querySelector('input:not([type="hidden"]), select');
    if (firstInput) setTimeout(() => firstInput.focus(), 50);
  }
}

async function handleEditStaff() {
  const form = document.getElementById('edit-staff-form');
  if (!form) return;

  const target_user_id = document.getElementById('edit-staff-user-id')?.value || editStaffUserId;
  const full_name = form.querySelector('[name="full_name"]')?.value.trim();
  const department = form.querySelector('[name="department"]')?.value.trim();
  const phone = form.querySelector('[name="phone"]')?.value.trim();

  if (!target_user_id) { showToast('Invalid staff member', 'error'); return; }
  if (!full_name) { showToast('Full name is required', 'warning'); return; }

  const btn = document.getElementById('submit-edit-staff-btn');
  const btnText = btn?.querySelector('.btn-text');
  const btnLoading = btn?.querySelector('.btn-loading');
  if (btn) btn.disabled = true;
  if (btnText) btnText.style.display = 'none';
  if (btnLoading) btnLoading.style.display = 'inline';

  const { data, error } = await callEdgeFunction('admin-update-staff', {
    target_user_id, full_name, department, phone,
  });

  if (btn) btn.disabled = false;
  if (btnText) btnText.style.display = 'inline';
  if (btnLoading) btnLoading.style.display = 'none';

  if (error) {
    showToast(typeof error === 'string' ? error : 'Failed to update staff', 'error');
    return;
  }

  showToast('Staff profile updated', 'success');
  const editOverlay2 = document.getElementById('edit-staff-modal-overlay');
  if (editOverlay2) {
    // Move focus outside the modal before hiding it to prevent the
    // "Blocked aria-hidden on element because its descendant retained focus" warning.
    const focusTarget =
      editStaffTriggerBtn ||
      editOverlay2._triggerElement ||
      document.querySelector('[data-opens="edit-staff-modal-overlay"]') ||
      document.body;
    if (focusTarget && typeof focusTarget.focus === 'function') {
      focusTarget.focus();
    }
    editOverlay2._triggerElement = null;
    editOverlay2.classList.remove('active');
    editOverlay2.setAttribute('aria-hidden', 'true');
  }
  editStaffUserId = null;
  viewLoaded.staff = false;
  await loadStaff();
  viewLoaded.staff = true;
}

// ─── Deactivate / Reactivate ──────────────────────────────────────────────────
async function handleDeactivateStaff(userId, name) {
  const confirmed = await showConfirm(
    `Deactivate ${name || 'this staff member'}? They will no longer be able to log in.`
  );
  if (!confirmed) return;

  const { error } = await callEdgeFunction('admin-deactivate-staff', { target_user_id: userId, action: 'deactivate' });
  if (error) {
    showToast(typeof error === 'string' ? error : 'Failed to deactivate staff', 'error');
    return;
  }
  showToast('Staff account deactivated', 'success');
  viewLoaded.staff = false;
  await loadStaff();
  viewLoaded.staff = true;
}

async function handleReactivateStaff(userId, name) {
  const confirmed = await showConfirm(
    `Reactivate ${name || 'this staff member'}? They will regain access to the system.`
  );
  if (!confirmed) return;

  const { error } = await callEdgeFunction('admin-deactivate-staff', { target_user_id: userId, action: 'reactivate' });

  if (error) {
    showToast(typeof error === 'string' ? error : 'Failed to reactivate staff', 'error');
    return;
  }
  showToast('Staff account reactivated', 'success');
  viewLoaded.staff = false;
  await loadStaff();
  viewLoaded.staff = true;
}

// ─── Reset Password ───────────────────────────────────────────────────────────
async function handleResetPassword(userId, name) {
  const confirmed = await showConfirm(
    `Send a password reset email to ${name || 'this staff member'}?`
  );
  if (!confirmed) return;

  const { error } = await callEdgeFunction('admin-reset-staff-password', { target_user_id: userId });
  if (error) {
    showToast(typeof error === 'string' ? error : 'Failed to send reset email', 'error');
    return;
  }
  showToast('Password reset email sent', 'success');
}

// ─── Delete Staff ────────────────────────────────────────────────────────────

/**
 * Opens the delete confirmation modal for a deactivated staff profile.
 * @param {string} userId        - UUID of the target staff member
 * @param {string} name          - Display name (already HTML-escaped in data attribute)
 * @param {string} staffId       - Staff ID string (already HTML-escaped in data attribute)
 * @param {HTMLElement} triggerBtn - The button that opened this modal (for focus return)
 */
function openDeleteStaffModal(userId, name, staffId, triggerBtn) {
  deleteStaffUserId = userId;
  deleteStaffTriggerBtn = triggerBtn || null;

  // Populate modal content
  const nameEl = document.getElementById('delete-staff-name');
  const idEl = document.getElementById('delete-staff-id-display');
  if (nameEl) nameEl.textContent = name || '—';
  if (idEl) idEl.textContent = staffId || '—';

  const overlay = document.getElementById('delete-staff-modal-overlay');
  if (overlay) {
    overlay._triggerElement = deleteStaffTriggerBtn;
    overlay.removeAttribute('aria-hidden');
    overlay.classList.add('active');
    // Move focus into the Cancel button (safer than Confirm for destructive actions)
    const cancelBtn = document.getElementById('cancel-delete-staff');
    if (cancelBtn) setTimeout(() => cancelBtn.focus(), 50);
  }
}

/**
 * Immediately removes the staff member from the visible dashboard list and
 * persists the hidden profile ID in browser localStorage.
 * Does not call any Edge Function or RPC, and does not alter backend data.
 */
function handleDeleteStaff() {
  const userId = deleteStaffUserId;
  if (!userId) return;

  // Persist hidden profile ID to browser localStorage
  addHiddenStaffId(userId);

  // Close modal — setupModalClose returns focus to trigger button
  const overlay = document.getElementById('delete-staff-modal-overlay');
  if (overlay) {
    const trigger = overlay._triggerElement || deleteStaffTriggerBtn || document.body;
    if (trigger && typeof trigger.focus === 'function') trigger.focus();
    overlay._triggerElement = null;
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
  }

  deleteStaffUserId = null;
  deleteStaffTriggerBtn = null;

  showToast('Staff member deleted from the list', 'success');

  // Immediately remove the row from the visible table DOM
  const row = document.querySelector(`tr[data-staff-id="${userId}"]`) ||
              document.querySelector(`.delete-staff-btn[data-id="${userId}"]`)?.closest('tr');
  if (row) {
    row.remove();
  }

  // If table has no rows remaining, display empty state
  const tbody = document.querySelector('#staff-list-container tbody');
  if (tbody && tbody.children.length === 0) {
    const container = document.getElementById('staff-list-container');
    if (container) {
      container.innerHTML = `<div class="empty-state" style="padding:2rem;text-align:center">No staff found matching your filters.</div>`;
    }
  }
}

// ─── System Settings ───────────────────────────────────────────────────────────
async function loadSettings() {
  const container = document.getElementById('settings-limits-body');
  if (!container) return;

  container.innerHTML = `<div class="loading-state" style="padding:1.5rem;text-align:center">Loading settings…</div>`;

  const { data, error } = await supabase
    .from('system_settings')
    .select('key, value, updated_by, updated_at');

  if (error) {
    container.innerHTML = `<div class="error-state" style="padding:1.5rem">Error: ${escapeHtml(error.message)}</div>`;
    return;
  }

  const settingsMap = {};
  (data || []).forEach(s => { settingsMap[s.key] = s; });

  const roleConfigs = [
    { key: 'max_doctors', label: 'Doctors', defaultVal: APP_CONFIG.ACCOUNT_LIMITS?.doctor ?? 10 },
    { key: 'max_nurses', label: 'Nurses', defaultVal: APP_CONFIG.ACCOUNT_LIMITS?.nurse ?? 10 },
    { key: 'max_pharmacists', label: 'Pharmacists', defaultVal: APP_CONFIG.ACCOUNT_LIMITS?.pharmacist ?? 10 },
    { key: 'max_lab_technicians', label: 'Lab Technicians', defaultVal: APP_CONFIG.ACCOUNT_LIMITS?.lab_technician ?? 10 },
    { key: 'max_front_desk', label: 'Front Desk', defaultVal: APP_CONFIG.ACCOUNT_LIMITS?.front_desk ?? 10 },
  ];

  container.innerHTML = `
    <table class="data-table" style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th>Role</th>
          <th>Account Limit</th>
          <th>Last Updated</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${roleConfigs.map(({ key, label, defaultVal }) => {
          const setting = settingsMap[key];
          const currentVal = setting?.value ?? defaultVal;
          const lastUpdated = setting?.updated_at ? formatDate(setting.updated_at, 'datetime') : 'Never';
          return `
            <tr data-key="${escapeHtml(key)}">
              <td style="font-weight:600">${escapeHtml(label)}</td>
              <td>
                <input
                  type="number"
                  class="form-control setting-limit-input"
                  style="width:100px"
                  min="0"
                  max="999"
                  value="${escapeHtml(String(currentVal))}"
                  data-key="${escapeHtml(key)}"
                />
              </td>
              <td style="font-size:.82rem;color:var(--text-muted)">${escapeHtml(lastUpdated)}</td>
              <td>
                <button
                  class="btn btn-primary btn-xs save-limit-btn"
                  data-key="${escapeHtml(key)}"
                  data-label="${escapeHtml(label)}"
                >
                  Save
                </button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  // Bind save buttons
  container.querySelectorAll('.save-limit-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.key;
      const label = btn.dataset.label;
      const input = container.querySelector(`.setting-limit-input[data-key="${key}"]`);
      if (!input) return;
      const value = parseInt(input.value);
      if (isNaN(value) || value < 0) {
        showToast(`Invalid limit value for ${label}`, 'warning');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Saving…';
      await saveSettingLimit(key, String(value), btn);
      btn.disabled = false;
      btn.textContent = 'Save';
    });
  });
}

async function saveSettingLimit(key, value, btn) {
  const { error } = await supabase
    .from('system_settings')
    .upsert({
      key,
      value,
      updated_by: currentProfile.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });

  if (error) {
    showToast(`Failed to save limit: ${error.message}`, 'error');
    return;
  }
  showToast('Limit saved successfully', 'success');
  // Refresh the updated_at display for this row
  const row = btn?.closest('tr');
  if (row) {
    const lastUpdatedCell = row.cells[2];
    if (lastUpdatedCell) lastUpdatedCell.textContent = formatDate(new Date().toISOString(), 'datetime');
  }
  // Also mark overview as stale so it refreshes limits on next visit
  viewLoaded.overview = false;
}

// ─── Audit Logs ───────────────────────────────────────────────────────────────
async function loadAuditLogs() {
  const tbody = document.getElementById('audit-tbody');
  const paginationEl = document.getElementById('audit-pagination');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:1.5rem">Loading audit logs…</td></tr>`;
  if (paginationEl) paginationEl.innerHTML = '';

  try {
    const from = (auditPage - 1) * AUDIT_PAGE_SIZE;
    const to = from + AUDIT_PAGE_SIZE - 1;

    let query = supabase
      .from('audit_logs')
      .select('id, action, table_name, record_id, created_at, actor:profiles!audit_logs_actor_id_fkey(full_name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (auditTableFilter) query = query.ilike('table_name', `%${auditTableFilter}%`);
    if (auditDateFrom) query = query.gte('created_at', new Date(auditDateFrom).toISOString());
    if (auditDateTo) {
      const toDate = new Date(auditDateTo);
      toDate.setHours(23, 59, 59, 999);
      query = query.lte('created_at', toDate.toISOString());
    }

    const { data, error, count } = await query;

    if (error) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:1.5rem;color:var(--danger)">Error: ${escapeHtml(error.message)}</td></tr>`;
      return;
    }

    if (!data || data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:1.5rem;color:var(--text-muted)">No audit logs found.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.map(log => `
      <tr>
        <td style="font-size:.82rem;white-space:nowrap">${escapeHtml(formatDate(log.created_at, 'datetime'))}</td>
        <td>${escapeHtml(log.actor?.full_name || '—')}</td>
        <td><span class="badge badge-info">${escapeHtml(log.action || '—')}</span></td>
        <td>${escapeHtml(log.table_name || '—')}</td>
        <td style="font-family:monospace;font-size:.78rem">${log.record_id ? escapeHtml(String(log.record_id).slice(0, 8)) + '…' : '—'}</td>
      </tr>
    `).join('');

    // Pagination
    if (paginationEl && count != null) {
      const totalPages = Math.ceil(count / AUDIT_PAGE_SIZE);
      renderPagination(paginationEl, auditPage, totalPages, (page) => {
        auditPage = page;
        loadAuditLogs();
      });
    }

  } catch (err) {
    console.error('loadAuditLogs error:', err);
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:1.5rem;color:var(--danger)">Unexpected error loading audit logs.</td></tr>`;
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  void init();
}

window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    void init();
  }
});
