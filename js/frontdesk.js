/**
 * Dreyson Global Hospital — EMR System
 * Front Desk Dashboard Controller
 *
 * Handles all views: Overview, Patient Registration, Search,
 * File Transfers (Inbox/Sent), Encounters, and Patient Chart side panel.
 */

import { requireAuth, signOut, redirectToDashboard } from './auth.js';
import { supabase } from './supabase-client.js';
import {
  getInitials, formatRole, formatDate, calculateAge,
  getStatusBadgeClass, showToast, debounce, timeAgo,
  escapeHtml, formatTransferStatus, renderPagination,
  showLoading, showEmpty, showError, showConfirm,
} from './utils.js';
import { searchPatients, getPatient } from './api/patients-api.js';
import {
  getMyInbox, countUnreadInbox, acknowledgeTransfer, updateTransferStatus,
} from './api/transfers-api.js';

// ─── State ────────────────────────────────────────────────────────────────────
let currentProfile = null;
let currentView = 'overview';
let inboxFilter = 'active';
let transferTab = 'inbox';   // 'inbox' | 'sent'
let ignoreDuplicate = false;
let lastRegisteredPatient = null;   // holds the newly registered patient object
let encounterModalPatient = null;   // patient selected in encounter modal
let searchPage = 1;
let searchQuery = '';

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const profile = await requireAuth();
  if (!profile) { window.location.replace('../index.html'); return; }
  if (profile.role !== 'front_desk') { redirectToDashboard(profile.role, false); return; }
  currentProfile = profile;

  // Set DOB max to today
  const regDob = document.getElementById('reg-dob');
  if (regDob) regDob.max = new Date().toISOString().substring(0, 10);

  initUI(profile);
  try {
    await Promise.all([loadOverview(), loadNotifications()]);
  } catch (err) {
    console.warn('Frontdesk overview load non-fatal warning:', err);
  }
}

function initUI(profile) {
  // Avatar / name / role
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

  // Sidebar toggle (mobile)
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
    if (menu && !menu.contains(e.target))
      menu.classList.remove('open');
  });

  // Sign out
  document.getElementById('sign-out-btn').addEventListener('click', handleSignOut);
  document.getElementById('dropdown-signout').addEventListener('click', handleSignOut);

  // Notification panel
  document.getElementById('notif-btn').addEventListener('click', () =>
    document.getElementById('notif-panel').classList.toggle('open'));
  document.getElementById('notif-close').addEventListener('click', () =>
    document.getElementById('notif-panel').classList.remove('open'));

  // Nav items (data-view)
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      switchView(el.dataset.view);
    });
  });

  // ── Overview quick actions ──
  document.getElementById('qa-register')?.addEventListener('click', () => switchView('register'));
  document.getElementById('qa-search')?.addEventListener('click', () => switchView('search'));
  document.getElementById('qa-inbox')?.addEventListener('click', () => switchView('transfers'));
  document.getElementById('qa-encounter')?.addEventListener('click', openEncounterModal);

  // Overview buttons
  document.getElementById('refresh-overview-btn').addEventListener('click', loadOverview);
  document.getElementById('view-all-registrations-btn').addEventListener('click', () => switchView('search'));

  // ── Registration form ──
  setupRegistrationForm();

  // ── Search ──
  const searchInput = document.getElementById('patient-search-input');
  searchInput.addEventListener('input', debounce(() => {
    searchQuery = searchInput.value.trim();
    searchPage = 1;
    doPatientSearch();
  }, 400));

  // ── Transfers tabs ──
  document.getElementById('tab-inbox').addEventListener('click', () => activateTransferTab('inbox'));
  document.getElementById('tab-sent').addEventListener('click', () => activateTransferTab('sent'));

  // Transfers filter chips (inside inbox panel)
  document.querySelectorAll('#transfers-inbox-panel .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#transfers-inbox-panel .chip').forEach(c => {
        c.classList.remove('active');
        c.setAttribute('aria-pressed', 'false');
      });
      chip.classList.add('active');
      chip.setAttribute('aria-pressed', 'true');
      inboxFilter = chip.dataset.filter;
      loadInbox();
    });
  });

  // Transfers refresh
  document.getElementById('refresh-transfers-btn').addEventListener('click', () => {
    if (transferTab === 'inbox') loadInbox();
    else loadSent();
  });

  // ── Encounters ──
  document.getElementById('new-encounter-btn').addEventListener('click', openEncounterModal);

  // ── Patient chart side panel ──
  document.getElementById('close-chart-panel')?.addEventListener('click', closeChartPanel);
  document.getElementById('chart-panel-overlay')?.addEventListener('click', closeChartPanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const panel = document.getElementById('patient-chart-panel');
      if (panel?.classList.contains('open')) {
        closeChartPanel();
      }
    }
  });

  // ── Encounter modal ──
  setupEncounterModal();
}

async function handleSignOut() {
  try {
    await signOut();
  } catch (err) {
    console.error('Front desk sign-out failed:', err);
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
    overview: 'Overview',
    register: 'Patient Registration',
    search: 'Search Patients',
    transfers: 'File Transfers',
    encounters: 'Encounters',
  };
  document.getElementById('page-title').textContent = titles[view] || 'Dashboard';

  // Lazy-load data on first visit to each view
  if (view === 'transfers') {
    loadInbox();
    loadSent();
  }
  if (view === 'encounters') loadEncounters();
}

// ─── Notifications ────────────────────────────────────────────────────────────
async function loadNotifications() {
  const count = await countUnreadInbox();
  const badge = document.getElementById('notif-count');
  const navBadge = document.getElementById('inbox-nav-badge');

  const displayCount = count > 99 ? '99+' : count;
  badge.textContent = displayCount;
  badge.style.display = count > 0 ? 'flex' : 'none';

  if (navBadge) {
    navBadge.textContent = displayCount;
    navBadge.style.display = count > 0 ? 'inline-flex' : 'none';
  }

  // Also update inbox tab badge
  const tabBadge = document.getElementById('inbox-tab-badge');
  if (tabBadge) {
    tabBadge.textContent = displayCount;
    tabBadge.style.display = count > 0 ? 'inline-flex' : 'none';
  }

  // Populate notification panel
  const { data } = await getMyInbox('active');
  const list = document.getElementById('notif-list');
  if (!data || data.length === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:1rem">No new notifications</div>';
    return;
  }
  list.innerHTML = data.slice(0, 10).map(t => `
    <div class="notif-item" style="padding:.75rem 1rem;border-bottom:1px solid var(--border-color);cursor:pointer" data-transfer-id="${t.id}">
      <div style="font-weight:600;font-size:.85rem">${escapeHtml(t.patient?.first_name || '')} ${escapeHtml(t.patient?.last_name || '')}</div>
      <div style="font-size:.8rem;color:var(--text-muted)">${escapeHtml(t.sender?.full_name || '—')} · ${timeAgo(t.created_at)}</div>
    </div>
  `).join('');
  list.querySelectorAll('.notif-item').forEach(item => {
    item.addEventListener('click', () => {
      document.getElementById('notif-panel').classList.remove('open');
      const transfer = data.find(t => t.id === item.dataset.transferId);
      if (transfer && transfer.patient) openPatientChart(transfer.patient);
    });
  });
}

// ─── Overview ─────────────────────────────────────────────────────────────────
async function loadOverview() {
  // Stat cards — set to loading placeholders
  ['stat-registrations', 'stat-encounters', 'stat-transfers', 'stat-total-patients'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '…';
  });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [regRes, encRes, totalRes, inboxCount] = await Promise.all([
    supabase.from('patient_demographics')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', todayStart.toISOString()),
    supabase.from('patient_encounters')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open'),
    supabase.from('patient_demographics')
      .select('id', { count: 'exact', head: true }),
    countUnreadInbox(),
  ]);

  document.getElementById('stat-registrations').textContent = regRes.count ?? '—';
  document.getElementById('stat-encounters').textContent = encRes.count ?? '—';
  document.getElementById('stat-transfers').textContent = inboxCount ?? '—';
  document.getElementById('stat-total-patients').textContent = totalRes.count ?? '—';

  // Recent registrations table
  await loadRecentRegistrations();
}

async function loadRecentRegistrations() {
  const tbody = document.getElementById('recent-registrations-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="table-loading-cell"><div class="spinner"></div></td></tr>';

  const { data, error } = await supabase
    .from('patient_demographics')
    .select('id, hospital_number, first_name, middle_name, last_name, date_of_birth, sex, created_at')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--danger)">${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No registrations today.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(p => {
    const name = `${p.first_name || ''} ${p.middle_name ? p.middle_name + ' ' : ''}${p.last_name || ''}`.trim();
    return `
      <tr>
        <td><span class="hospital-num">${escapeHtml(p.hospital_number || '—')}</span></td>
        <td>${escapeHtml(name)}</td>
        <td>${calculateAge(p.date_of_birth)}</td>
        <td>${escapeHtml(p.sex || '—')}</td>
        <td>${formatDate(p.created_at, 'datetime')}</td>
        <td>
          <button class="btn btn-ghost btn-xs open-chart-overview-btn" data-pid="${p.id}" aria-label="Open chart for ${escapeHtml(name)}">
            📋 Open Chart
          </button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.open-chart-overview-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { data: patient, error: pe } = await getPatient(btn.dataset.pid);
      if (pe || !patient) { showToast('Could not load patient', 'error'); return; }
      openPatientChart(patient);
    });
  });
}

// ─── Patient Registration ─────────────────────────────────────────────────────
function setupRegistrationForm() {
  const form = document.getElementById('registration-form');

  // Duplicate detection on name/phone blur
  const checkDuplicate = debounce(async () => {
    if (ignoreDuplicate) return;
    const firstName = document.getElementById('reg-first-name').value.trim();
    const lastName = document.getElementById('reg-last-name').value.trim();
    const phone = document.getElementById('reg-phone').value.trim();

    if ((!firstName && !lastName) && !phone) return;

    let query = supabase.from('patient_demographics').select('id, hospital_number, first_name, last_name, phone');

    if (firstName && lastName) {
      query = query.ilike('first_name', `%${firstName}%`).ilike('last_name', `%${lastName}%`);
    } else if (phone) {
      query = query.eq('phone', phone);
    } else {
      return;
    }

    const { data } = await query.limit(3);
    const warning = document.getElementById('duplicate-warning');
    const warningText = document.getElementById('duplicate-warning-text');

    if (data && data.length > 0) {
      const names = data.map(p => `${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)} (HN: ${escapeHtml(p.hospital_number)})`).join(', ');
      warningText.innerHTML = ` Similar patient(s) found: ${names}.`;
      warning.style.display = 'flex';
    } else {
      warning.style.display = 'none';
    }
  }, 600);

  ['reg-first-name', 'reg-last-name', 'reg-phone'].forEach(id => {
    document.getElementById(id).addEventListener('blur', checkDuplicate);
  });

  // Ignore duplicate button
  document.getElementById('ignore-duplicate-btn').addEventListener('click', () => {
    ignoreDuplicate = true;
    document.getElementById('duplicate-warning').style.display = 'none';
  });

  // Clear form
  document.getElementById('clear-reg-form-btn').addEventListener('click', resetRegistrationForm);

  // Form submit
  form.addEventListener('submit', async e => {
    e.preventDefault();
    await submitRegistration();
  });

  // Post-success actions
  document.getElementById('open-encounter-after-reg-btn').addEventListener('click', () => {
    if (!lastRegisteredPatient) return;
    openEncounterModal(lastRegisteredPatient);
  });

  document.getElementById('register-another-btn').addEventListener('click', resetRegistrationForm);
}

function resetRegistrationForm() {
  const form = document.getElementById('registration-form');
  form.reset();
  ignoreDuplicate = false;
  lastRegisteredPatient = null;
  document.getElementById('duplicate-warning').style.display = 'none';
  document.getElementById('registration-success').style.display = 'none';
  form.style.display = 'block';
  document.getElementById('reg-dob').max = new Date().toISOString().substring(0, 10);
}

async function submitRegistration() {
  const btnText = document.querySelector('#submit-reg-btn .btn-text');
  const btnLoading = document.querySelector('#submit-reg-btn .btn-loading');
  const submitBtn = document.getElementById('submit-reg-btn');

  // Prevent duplicate submit clicks while a registration is in progress
  if (submitBtn.disabled) return;

  // Basic required field check
  const firstName = document.getElementById('reg-first-name').value.trim();
  const lastName = document.getElementById('reg-last-name').value.trim();
  const dob = document.getElementById('reg-dob').value;
  const rawSex = document.getElementById('reg-sex').value;
  const phone = document.getElementById('reg-phone').value.trim();

  if (!firstName) {
    showToast('First name is required', 'warning');
    document.getElementById('reg-first-name').focus();
    return;
  }
  if (!lastName) {
    showToast('Last name is required', 'warning');
    document.getElementById('reg-last-name').focus();
    return;
  }
  if (!dob) {
    showToast('Date of birth is required', 'warning');
    document.getElementById('reg-dob').focus();
    return;
  }

  const todayStr = new Date().toISOString().substring(0, 10);
  if (dob > todayStr) {
    showToast('Date of birth cannot be in the future', 'warning');
    document.getElementById('reg-dob').focus();
    return;
  }

  const sex = (rawSex || '').toLowerCase().trim();
  if (!sex || !['male', 'female', 'other'].includes(sex)) {
    showToast('Please select a valid sex (Male, Female, or Other)', 'warning');
    document.getElementById('reg-sex').focus();
    return;
  }

  if (!phone) {
    showToast('Phone number is required', 'warning');
    document.getElementById('reg-phone').focus();
    return;
  }

  // Show loading state and lock button
  submitBtn.disabled = true;
  btnText.style.display = 'none';
  btnLoading.style.display = 'inline';

  const payload = {
    first_name: firstName,
    middle_name: document.getElementById('reg-middle-name').value.trim() || null,
    last_name: lastName,
    date_of_birth: dob,
    sex,
    phone,
    alt_phone: document.getElementById('reg-alt-phone').value.trim() || null,
    email: document.getElementById('reg-email').value.trim() || null,
    address: document.getElementById('reg-address').value.trim() || null,
    emergency_contact_name: document.getElementById('reg-emergency-name').value.trim() || null,
    emergency_contact_phone: document.getElementById('reg-emergency-phone').value.trim() || null,
    emergency_contact_relationship: document.getElementById('reg-relationship').value.trim() || null,
    next_of_kin: document.getElementById('reg-nok').value.trim() || null,
    admin_notes: document.getElementById('reg-notes').value.trim() || null,
    registered_by: currentProfile?.id || null,
  };

  try {
    const { data, error } = await supabase
      .from('patient_demographics')
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error('Patient registration error:', { code: error.code, message: error.message });
      let friendlyMsg = error.message || 'An unexpected database error occurred.';
      if (error.code === 'PGRST204') {
        friendlyMsg = 'Database column mismatch detected. Please reload your browser.';
      } else if (error.code === '23505') {
        friendlyMsg = 'A patient with this unique record (or hospital number) already exists.';
      } else if (error.code === '42501') {
        friendlyMsg = 'Permission denied: Only active front desk staff or administrators can register patients.';
      } else if (error.code === '23502') {
        friendlyMsg = 'A required database field is missing. Please review all required inputs.';
      }
      showToast(`Registration failed: ${friendlyMsg}`, 'error');
      return;
    }

    // Success
    lastRegisteredPatient = data;
    const fullName = `${data.first_name || ''} ${data.middle_name ? data.middle_name + ' ' : ''}${data.last_name || ''}`.trim();

    document.getElementById('new-hospital-number').textContent = data.hospital_number || 'N/A';
    document.getElementById('success-patient-name').textContent = `Name: ${fullName}`;
    document.getElementById('registration-form').style.display = 'none';
    document.getElementById('duplicate-warning').style.display = 'none';
    document.getElementById('registration-success').style.display = 'block';

    showToast(`Patient registered successfully! HN: ${data.hospital_number}`, 'success');
    ignoreDuplicate = false;

    // Refresh overview in background
    loadOverview().catch(err => console.warn('Frontdesk overview refresh non-fatal warning:', err));
  } catch (err) {
    console.error('Unexpected error during patient registration:', err.message || err);
    showToast('An unexpected error occurred during registration. Please try again.', 'error');
  } finally {
    submitBtn.disabled = false;
    btnText.style.display = 'inline';
    btnLoading.style.display = 'none';
  }
}

// ─── Patient Search ───────────────────────────────────────────────────────────
async function doPatientSearch() {
  const container = document.getElementById('search-results-container');
  const paginationEl = document.getElementById('search-pagination');

  if (!searchQuery || searchQuery.length < 2) {
    showEmpty(container, 'Type at least 2 characters to search for patients.', '🔍');
    if (paginationEl) paginationEl.innerHTML = '';
    return;
  }

  showLoading(container, 'Searching patients…');

  const pageSize = 10;
  const { data, error, count } = await searchPatients(searchQuery, searchPage, pageSize);

  if (error) {
    showError(container, error.message);
    return;
  }
  if (!data || data.length === 0) {
    showEmpty(container, `No patients found for "${escapeHtml(searchQuery)}".`, '🔍');
    if (paginationEl) paginationEl.innerHTML = '';
    return;
  }

  container.innerHTML = data.map(p => {
    const name = `${p.first_name || ''} ${p.middle_name ? p.middle_name + ' ' : ''}${p.last_name || ''}`.trim();
    return `
      <div class="list-item patient-search-card" data-pid="${p.id}" style="cursor:pointer" tabindex="0" role="button" aria-label="Open chart for ${escapeHtml(name)}">
        <div class="list-item-avatar">${getInitials(name)}</div>
        <div class="list-item-body">
          <div class="list-item-title">${escapeHtml(name)}</div>
          <div class="list-item-meta">
            HN: ${escapeHtml(p.hospital_number || '—')} ·
            DOB: ${formatDate(p.date_of_birth, 'short')} (${calculateAge(p.date_of_birth)}) ·
            ${escapeHtml(p.sex || '—')}
          </div>
          ${p.phone ? `<div class="list-item-note">📞 ${escapeHtml(p.phone)}</div>` : ''}
        </div>
        <div class="list-item-aside">
          <button class="btn btn-ghost btn-xs" aria-label="Open chart">📋 Open Chart</button>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.patient-search-card').forEach(card => {
    const handler = async () => {
      const { data: patient, error: pe } = await getPatient(card.dataset.pid);
      if (pe || !patient) { showToast('Could not load patient', 'error'); return; }
      openPatientChart(patient);
    };
    card.addEventListener('click', handler);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') handler(); });
  });

  // Pagination
  const totalPages = count ? Math.ceil(count / pageSize) : 1;
  renderPagination(paginationEl, searchPage, totalPages, page => {
    searchPage = page;
    doPatientSearch();
  });
}

// ─── File Transfers ───────────────────────────────────────────────────────────
function activateTransferTab(tab) {
  transferTab = tab;

  const inboxBtn = document.getElementById('tab-inbox');
  const sentBtn = document.getElementById('tab-sent');
  const inboxPanel = document.getElementById('transfers-inbox-panel');
  const sentPanel = document.getElementById('transfers-sent-panel');

  if (tab === 'inbox') {
    inboxBtn.classList.add('active');
    inboxBtn.setAttribute('aria-selected', 'true');
    sentBtn.classList.remove('active');
    sentBtn.setAttribute('aria-selected', 'false');
    inboxPanel.style.display = 'block';
    sentPanel.style.display = 'none';
    loadInbox();
  } else {
    sentBtn.classList.add('active');
    sentBtn.setAttribute('aria-selected', 'true');
    inboxBtn.classList.remove('active');
    inboxBtn.setAttribute('aria-selected', 'false');
    sentPanel.style.display = 'block';
    inboxPanel.style.display = 'none';
    loadSent();
  }
}

async function loadInbox() {
  const container = document.getElementById('inbox-list');
  showLoading(container, 'Loading inbox…');

  const { data, error } = await getMyInbox(inboxFilter);

  if (error) { showError(container, error.message); return; }
  if (!data || data.length === 0) {
    showEmpty(container, 'No transfers in your inbox.', '📭');
    updateInboxBadge(0);
    return;
  }

  // Update badge with count of 'active' (sent/received/in_progress) items
  const activeCount = data.filter(t => ['sent', 'received', 'in_progress'].includes(t.status)).length;
  updateInboxBadge(activeCount);

  container.innerHTML = data.map(t => renderInboxItem(t)).join('');
  bindInboxActions(container, data);
}

function updateInboxBadge(count) {
  const tabBadge = document.getElementById('inbox-tab-badge');
  const navBadge = document.getElementById('inbox-nav-badge');
  const notifBadge = document.getElementById('notif-count');

  const display = count > 0 ? 'inline-flex' : 'none';
  const label = count > 99 ? '99+' : String(count);

  if (tabBadge) { tabBadge.textContent = label; tabBadge.style.display = display; }
  if (navBadge) { navBadge.textContent = label; navBadge.style.display = display; }
  if (notifBadge) { notifBadge.textContent = label; notifBadge.style.display = count > 0 ? 'flex' : 'none'; }
}

function renderInboxItem(t) {
  const patient = t.patient || {};
  const sender = t.sender || {};
  const name = `${patient.first_name || ''} ${patient.last_name || ''}`.trim() || 'Unknown';
  const statusClass = getStatusBadgeClass(t.status);

  return `
    <div class="list-item inbox-item" data-id="${t.id}" style="cursor:pointer" tabindex="0" role="button">
      <div class="list-item-avatar">${getInitials(name)}</div>
      <div class="list-item-body">
        <div class="list-item-title">
          ${escapeHtml(name)}
          <span class="text-muted" style="font-weight:400">· ${escapeHtml(patient.hospital_number || '')}</span>
        </div>
        <div class="list-item-meta">From: ${escapeHtml(sender.full_name || '—')} (${escapeHtml(sender.department || '')})</div>
        ${t.message ? `<div class="list-item-note">${escapeHtml(t.message)}</div>` : ''}
      </div>
      <div class="list-item-aside">
        <span class="badge ${statusClass}">${formatTransferStatus(t.status)}</span>
        <span class="text-muted" style="font-size:.75rem">${timeAgo(t.created_at)}</span>
        <div class="item-actions" style="margin-top:.4rem">
          ${t.status === 'sent'
            ? `<button class="btn btn-warning btn-xs ack-btn" data-id="${t.id}">Acknowledge</button>`
            : ''}
          ${renderTransferStatusActions(t)}
        </div>
      </div>
    </div>
  `;
}

function renderTransferStatusActions(t) {
  const opts = [];
  if (['received', 'sent'].includes(t.status)) opts.push({ label: 'In Progress', value: 'in_progress' });
  if (t.status === 'in_progress') opts.push({ label: 'Awaiting Results', value: 'awaiting_results' });
  if (['in_progress', 'awaiting_results'].includes(t.status)) {
    opts.push({ label: 'Complete', value: 'completed' });
    opts.push({ label: 'Return', value: 'returned' });
  }
  if (opts.length === 0) return '';
  return `
    <select class="status-select form-control form-control-xs" data-id="${t.id}">
      <option value="">Update status…</option>
      ${opts.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
    </select>
  `;
}

function bindInboxActions(container, data) {
  container.querySelectorAll('.inbox-item').forEach(item => {
    const handler = e => {
      if (e.target.closest('.ack-btn') || e.target.closest('.status-select')) return;
      const transfer = data.find(t => t.id === item.dataset.id);
      if (transfer && transfer.patient) openPatientChart(transfer.patient);
    };
    item.addEventListener('click', handler);
    item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') handler(e); });
  });

  container.querySelectorAll('.ack-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      btn.disabled = true;
      const { error } = await acknowledgeTransfer(btn.dataset.id);
      if (error) { showToast(error.message, 'error'); btn.disabled = false; }
      else {
        showToast('Transfer acknowledged', 'success');
        loadInbox();
        loadNotifications();
      }
    });
  });

  container.querySelectorAll('.status-select').forEach(sel => {
    sel.addEventListener('change', async e => {
      e.stopPropagation();
      if (!sel.value) return;
      const { error } = await updateTransferStatus(sel.dataset.id, sel.value);
      if (error) showToast(error.message, 'error');
      else { showToast('Status updated', 'success'); loadInbox(); }
    });
  });
}

async function loadSent() {
  const container = document.getElementById('sent-list');
  showLoading(container, 'Loading sent files…');

  const { data, error } = await supabase
    .from('patient_file_transfers')
    .select('*, patient:patients(first_name, last_name, hospital_number), recipient:profiles(full_name, role, department)')
    .eq('sender_id', currentProfile.id)
    .order('created_at', { ascending: false });

  if (error) { showError(container, error.message); return; }
  if (!data || data.length === 0) {
    showEmpty(container, 'No sent transfers yet.', '📤');
    return;
  }

  container.innerHTML = data.map(t => {
    const patient = t.patient || {};
    const recipient = t.recipient || {};
    const name = `${patient.first_name || ''} ${patient.last_name || ''}`.trim() || 'Unknown';
    const statusClass = getStatusBadgeClass(t.status);
    return `
      <div class="list-item sent-item" data-id="${t.id}" style="cursor:pointer" tabindex="0" role="button">
        <div class="list-item-avatar">${getInitials(name)}</div>
        <div class="list-item-body">
          <div class="list-item-title">
            ${escapeHtml(name)}
            <span class="text-muted" style="font-weight:400">· ${escapeHtml(patient.hospital_number || '')}</span>
          </div>
          <div class="list-item-meta">To: ${escapeHtml(recipient.full_name || '—')} (${escapeHtml(recipient.department || '')})</div>
          ${t.message ? `<div class="list-item-note">${escapeHtml(t.message)}</div>` : ''}
        </div>
        <div class="list-item-aside">
          <span class="badge ${statusClass}">${formatTransferStatus(t.status)}</span>
          <span class="text-muted" style="font-size:.75rem">${timeAgo(t.created_at)}</span>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.sent-item').forEach((item, i) => {
    item.addEventListener('click', async () => {
      const t = data[i];
      if (t.patient) {
        const { data: patient } = await getPatient(t.patient.id || t.patient_id);
        if (patient) openPatientChart(patient);
      }
    });
  });
}

// ─── Encounters ───────────────────────────────────────────────────────────────
async function loadEncounters() {
  const container = document.getElementById('encounters-list');
  showLoading(container, 'Loading encounters…');

  const { data, error } = await supabase
    .from('patient_encounters')
    .select('*, patient:patients(first_name, last_name, hospital_number), opened_by_profile:profiles(full_name)')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) { showError(container, error.message); return; }
  if (!data || data.length === 0) {
    showEmpty(container, 'No encounters found.', '📋');
    return;
  }

  container.innerHTML = data.map(enc => {
    const patient = enc.patient || {};
    const openedBy = enc.opened_by_profile || {};
    const name = `${patient.first_name || ''} ${patient.last_name || ''}`.trim() || 'Unknown';
    const statusClass = getStatusBadgeClass(enc.status);
    return `
      <div class="list-item encounter-item" data-enc-id="${enc.id}" style="cursor:pointer" tabindex="0" role="button">
        <div class="list-item-avatar">${getInitials(name)}</div>
        <div class="list-item-body">
          <div class="list-item-title">
            ${escapeHtml(name)}
            <span class="text-muted" style="font-weight:400">· ${escapeHtml(patient.hospital_number || '')}</span>
          </div>
          <div class="list-item-meta">
            ${escapeHtml(enc.department || enc.encounter_number || 'Encounter')} ·
            Opened by: ${escapeHtml(openedBy.full_name || '—')} ·
            ${formatDate(enc.created_at, 'datetime')}
          </div>
          ${enc.chief_complaint ? `<div class="list-item-note">CC: ${escapeHtml(enc.chief_complaint)}</div>` : ''}
        </div>
        <div class="list-item-aside">
          <span class="badge ${statusClass}">${escapeHtml(enc.status || '')}</span>
          <span class="text-muted" style="font-size:.75rem">${timeAgo(enc.created_at)}</span>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.encounter-item').forEach((item, i) => {
    const handler = async () => {
      const enc = data[i];
      if (!enc.patient) return;
      const { data: patient } = await getPatient(enc.patient_id || enc.patient?.id);
      if (patient) openPatientChart(patient);
    };
    item.addEventListener('click', handler);
    item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') handler(); });
  });
}

// ─── Encounter Modal ──────────────────────────────────────────────────────────
function setupEncounterModal() {
  const overlay = document.getElementById('encounter-modal-overlay');
  const closeModal = () => {
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
    encounterModalPatient = null;
    document.getElementById('encounter-patient-search').value = '';
    document.getElementById('encounter-patient-results').innerHTML = '';
    document.getElementById('encounter-selected-patient').style.display = 'none';
    document.getElementById('encounter-reason').value = '';
    document.getElementById('confirm-open-encounter-btn').disabled = true;
  };

  document.getElementById('close-encounter-modal').addEventListener('click', closeModal);
  document.getElementById('cancel-encounter-modal').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

  // Patient search inside modal
  const searchInput = document.getElementById('encounter-patient-search');
  searchInput.addEventListener('input', debounce(async () => {
    const q = searchInput.value.trim();
    const resultsEl = document.getElementById('encounter-patient-results');
    if (!q || q.length < 2) {
      resultsEl.innerHTML = '';
      return;
    }
    resultsEl.innerHTML = '<div style="padding:.5rem;font-size:.82rem;color:var(--text-muted)">Searching…</div>';
    const { data, error } = await searchPatients(q, 1, 8);
    if (error || !data || data.length === 0) {
      resultsEl.innerHTML = '<div style="padding:.5rem;font-size:.82rem;color:var(--text-muted)">No patients found.</div>';
      return;
    }
    resultsEl.innerHTML = data.map(p => `
      <div class="search-dropdown-item" data-pid="${p.id}"
           style="padding:.6rem .75rem;cursor:pointer;font-size:.85rem;border-bottom:1px solid var(--border-color);display:flex;align-items:center;gap:.5rem"
           tabindex="0" role="option">
        <div style="width:2rem;height:2rem;border-radius:50%;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:700;flex-shrink:0">
          ${getInitials(`${p.first_name} ${p.last_name}`)}
        </div>
        <div>
          <div style="font-weight:600">${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</div>
          <div style="font-size:.75rem;color:var(--text-muted)">HN: ${escapeHtml(p.hospital_number)} · ${calculateAge(p.date_of_birth)} · ${escapeHtml(p.sex || '')}</div>
        </div>
      </div>
    `).join('');

    resultsEl.querySelectorAll('.search-dropdown-item').forEach((item, i) => {
      const selectHandler = () => {
        encounterModalPatient = data[i];
        document.getElementById('encounter-selected-name').textContent = `${data[i].first_name} ${data[i].last_name}`;
        document.getElementById('encounter-selected-number').textContent = data[i].hospital_number;
        document.getElementById('encounter-selected-patient').style.display = 'block';
        document.getElementById('confirm-open-encounter-btn').disabled = false;
        resultsEl.innerHTML = '';
        searchInput.value = '';
      };
      item.addEventListener('click', selectHandler);
      item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') selectHandler(); });
    });
  }, 350));

  // Confirm — open encounter
  document.getElementById('confirm-open-encounter-btn').addEventListener('click', submitOpenEncounter);
}

function openEncounterModal(prefilledPatient) {
  encounterModalPatient = prefilledPatient || null;

  const overlay = document.getElementById('encounter-modal-overlay');
  overlay.classList.add('active');
  overlay.setAttribute('aria-hidden', 'false');

  // Reset modal fields
  document.getElementById('encounter-patient-search').value = '';
  document.getElementById('encounter-patient-results').innerHTML = '';
  document.getElementById('encounter-reason').value = '';
  document.getElementById('confirm-open-encounter-btn').disabled = true;

  if (encounterModalPatient) {
    const p = encounterModalPatient;
    document.getElementById('encounter-selected-name').textContent = `${p.first_name || ''} ${p.last_name || ''}`.trim();
    document.getElementById('encounter-selected-number').textContent = p.hospital_number || '';
    document.getElementById('encounter-selected-patient').style.display = 'block';
    document.getElementById('confirm-open-encounter-btn').disabled = false;
  } else {
    document.getElementById('encounter-selected-patient').style.display = 'none';
  }
}

async function submitOpenEncounter() {
  if (!encounterModalPatient) {
    showToast('Please select a patient', 'warning');
    return;
  }

  const btn = document.getElementById('confirm-open-encounter-btn');
  btn.disabled = true;
  btn.textContent = 'Opening…';

  const chiefComplaint = document.getElementById('encounter-reason').value.trim();

  const { error } = await supabase.from('patient_encounters').insert([{
    patient_id: encounterModalPatient.id,
    department: currentProfile.department || 'General Outpatient',
    chief_complaint: chiefComplaint || null,
    opened_by: currentProfile.id,
    status: 'open',
  }]);

  btn.disabled = false;
  btn.textContent = '📋 Open Encounter';

  if (error) {
    showToast(`Failed to open encounter: ${error.message}`, 'error');
    return;
  }

  showToast('Encounter opened successfully', 'success');
  // Close modal
  document.getElementById('encounter-modal-overlay').classList.remove('active');
  document.getElementById('encounter-modal-overlay').setAttribute('aria-hidden', 'true');
  encounterModalPatient = null;

  // Reload encounters if on that view
  if (currentView === 'encounters') loadEncounters();
  // Reload overview stats
  if (currentView === 'overview') loadOverview();
}

// ─── Patient Chart Side Panel ─────────────────────────────────────────────────
let chartPanelTriggerBtn = null;

async function openPatientChart(patient, triggerBtn = null) {
  if (!patient) return;

  chartPanelTriggerBtn = triggerBtn || (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  const panel = document.getElementById('patient-chart-panel');
  const overlay = document.getElementById('chart-panel-overlay');
  const body = document.getElementById('patient-chart-body');
  const title = document.getElementById('chart-panel-title');

  const fullName = `${patient.first_name || ''} ${patient.middle_name ? patient.middle_name + ' ' : ''}${patient.last_name || ''}`.trim();
  title.textContent = fullName || 'Patient Chart';

  // Open the panel and configure accessible state
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  panel.setAttribute('aria-modal', 'true');
  if (overlay) {
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
  }

  // Move keyboard focus inside the panel
  const closeBtn = document.getElementById('close-chart-panel');
  if (closeBtn) setTimeout(() => closeBtn.focus(), 50);

  showLoading(body, 'Loading patient chart…');

  // If we only have partial data (from a join), fetch the full record
  let fullPatient = patient;
  if (!patient.created_at) {
    const { data } = await getPatient(patient.id);
    if (data) fullPatient = data;
  }

  // Fetch recent encounters
  const { data: encounters } = await supabase
    .from('patient_encounters')
    .select('id, encounter_number, department, status, chief_complaint, created_at, opened_by_profile:profiles(full_name)')
    .eq('patient_id', fullPatient.id)
    .order('created_at', { ascending: false })
    .limit(5);

  const name = `${fullPatient.first_name || ''} ${fullPatient.middle_name ? fullPatient.middle_name + ' ' : ''}${fullPatient.last_name || ''}`.trim();

  body.innerHTML = `
    <!-- Demographics banner -->
    <div class="chart-patient-banner" style="display:flex;align-items:center;gap:1rem;padding:1rem;background:var(--bg-secondary,#f8fafc);border-radius:8px;margin-bottom:1rem">
      <div style="width:3rem;height:3rem;border-radius:50%;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1rem;flex-shrink:0">
        ${getInitials(name)}
      </div>
      <div style="min-width:0">
        <div style="font-weight:700;font-size:1rem">${escapeHtml(name)}</div>
        <div style="font-size:.82rem;color:var(--text-muted)">
          HN: <strong>${escapeHtml(fullPatient.hospital_number || '—')}</strong> ·
          ${calculateAge(fullPatient.date_of_birth)} ·
          ${escapeHtml(fullPatient.sex || '—')}
        </div>
      </div>
    </div>

    <!-- Demographics grid -->
    <div style="margin-bottom:1.25rem">
      <h4 style="font-size:.85rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin:0 0 .75rem">Demographics</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem .75rem">
        ${renderDemoField('Date of Birth', formatDate(fullPatient.date_of_birth, 'short'))}
        ${renderDemoField('Sex', fullPatient.sex)}
        ${renderDemoField('Phone', fullPatient.phone)}
        ${renderDemoField('Alt. Phone', fullPatient.alt_phone)}
        ${renderDemoField('Email', fullPatient.email)}
        ${renderDemoField('Address', fullPatient.address)}
        ${renderDemoField('Next of Kin', fullPatient.next_of_kin || fullPatient.next_of_kin_name)}
        ${renderDemoField('Emergency Contact', fullPatient.emergency_contact_name)}
        ${renderDemoField('Emergency Phone', fullPatient.emergency_contact_phone)}
        ${renderDemoField('Relationship', fullPatient.emergency_contact_relationship)}
        ${renderDemoField('Registered', formatDate(fullPatient.created_at, 'datetime'))}
      </div>
    </div>

    <!-- Recent encounters -->
    <div style="margin-bottom:1.25rem">
      <h4 style="font-size:.85rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin:0 0 .75rem">Recent Encounters</h4>
      ${!encounters || encounters.length === 0
        ? '<div class="empty-state" style="padding:.75rem">No encounters recorded.</div>'
        : encounters.map(enc => `
            <div class="list-item" style="padding:.6rem;margin-bottom:.4rem;border-radius:6px;border:1px solid var(--border-color)">
              <div class="list-item-body">
                <div class="list-item-title" style="font-size:.85rem">${escapeHtml(enc.department || enc.encounter_number || 'Encounter')}</div>
                <div class="list-item-meta" style="font-size:.75rem">
                  ${formatDate(enc.created_at, 'datetime')} ·
                  By: ${escapeHtml(enc.opened_by_profile?.full_name || '—')}
                </div>
                ${enc.chief_complaint ? `<div class="list-item-note" style="font-size:.78rem">CC: ${escapeHtml(enc.chief_complaint)}</div>` : ''}
              </div>
              <div class="list-item-aside">
                <span class="badge ${getStatusBadgeClass(enc.status)}">${escapeHtml(enc.status || '')}</span>
              </div>
            </div>
          `).join('')}
    </div>

    <!-- Actions -->
    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm chart-open-encounter-btn" aria-label="Open encounter for this patient">
        📋 Open Encounter
      </button>
      <button type="button" class="btn btn-ghost btn-sm chart-cancel-btn" aria-label="Close patient chart">
        Cancel
      </button>
    </div>
  `;

  // Bind "Open Encounter" from within chart
  body.querySelector('.chart-open-encounter-btn')?.addEventListener('click', () => {
    closeChartPanel();
    setTimeout(() => openEncounterModal(fullPatient), 150);
  });

  // Bind "Cancel" from within chart
  body.querySelector('.chart-cancel-btn')?.addEventListener('click', closeChartPanel);
}

function renderDemoField(label, value) {
  if (!value) return '';
  return `
    <div>
      <div style="font-size:.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">${escapeHtml(label)}</div>
      <div style="font-size:.85rem;margin-top:.1rem">${escapeHtml(String(value))}</div>
    </div>
  `;
}

function closeChartPanel() {
  const panel = document.getElementById('patient-chart-panel');
  const overlay = document.getElementById('chart-panel-overlay');
  if (!panel) return;

  // Move keyboard focus outside the panel BEFORE setting aria-hidden="true"
  if (chartPanelTriggerBtn && typeof chartPanelTriggerBtn.focus === 'function' && document.body.contains(chartPanelTriggerBtn)) {
    chartPanelTriggerBtn.focus();
  } else if (panel.contains(document.activeElement)) {
    document.activeElement?.blur();
  }
  chartPanelTriggerBtn = null;

  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  panel.setAttribute('aria-modal', 'false');
  if (overlay) {
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
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
