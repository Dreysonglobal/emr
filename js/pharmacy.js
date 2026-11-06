/**
 * Dreyson Global Hospital — EMR System
 * Pharmacy Dashboard Controller
 *
 * Handles all views: Overview, Inbox, Prescriptions Queue,
 * Medicine Inventory, Dispense Medication, Inventory Movements.
 */

import { requireAuth, signOut, redirectToDashboard } from './auth.js';
import { supabase } from './supabase-client.js';
import {
  getInitials, formatRole, formatDate, calculateAge,
  getStatusBadgeClass, showToast, debounce, timeAgo,
  escapeHtml, formatTransferStatus, formatCurrency,
  showLoading, showEmpty, showError, renderPagination, showConfirm,
} from './utils.js';
import {
  getMyInbox, countUnreadInbox,
  acknowledgeTransfer, updateTransferStatus,
} from './api/transfers-api.js';
import { PatientFile } from './patient-file.js';

// ─── Shared Patient File State ────────────────────────────────────────────────
let pharmPatientFileComponent = null;
let pharmSearchPage = 1;
let pharmSearchQuery = '';

// ─── State ────────────────────────────────────────────────────────────────────
let currentProfile   = null;
let currentView      = 'overview';
let inboxFilter      = 'active';
let rxFilter         = 'active';
let invFilter        = 'all';
let mvFilter         = 'all';
let mvPage           = 1;
const MV_PER_PAGE    = 20;

// Lazy-load guards (each view loads once then reloads on tab switch)
const loaded = {};

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const profile = await requireAuth();
  if (!profile) { window.location.replace('../index.html'); return; }
  if (profile.role !== 'pharmacist') { redirectToDashboard(profile.role, false); return; }
  currentProfile = profile;
  initUI(profile);
  try {
    await Promise.all([loadOverview(), loadNotifications()]);
  } catch (err) {
    console.warn('Pharmacy overview load non-fatal warning:', err);
  }
}

// ─── UI Bootstrap ─────────────────────────────────────────────────────────────
function initUI(profile) {
  // Avatars & names
  const initials = getInitials(profile.full_name);
  ['sidebar-avatar', 'topbar-avatar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = initials;
  });
  document.getElementById('sidebar-name').textContent    = profile.full_name;
  document.getElementById('sidebar-role').textContent    = formatRole(profile.role);
  document.getElementById('topbar-name').textContent     = profile.full_name;
  document.getElementById('dropdown-name').textContent   = profile.full_name;
  document.getElementById('dropdown-role').textContent   = formatRole(profile.role);

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
    if (!document.getElementById('profile-menu').contains(e.target))
      document.getElementById('profile-menu').classList.remove('open');
  });

  // Sign out
  document.getElementById('sign-out-btn').addEventListener('click', handleSignOut);
  document.getElementById('dropdown-signout').addEventListener('click', handleSignOut);

  // Notification panel
  document.getElementById('notif-btn').addEventListener('click', () =>
    document.getElementById('notif-panel').classList.toggle('open'));
  document.getElementById('notif-close').addEventListener('click', () =>
    document.getElementById('notif-panel').classList.remove('open'));

  // Nav items
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      switchView(el.dataset.view);
    });
  });

  // Overview quick actions (chips with data-view)
  document.querySelectorAll('[data-view][data-qa]').forEach(el => {
    el.addEventListener('click', () => switchView(el.dataset.view));
  });
  const qaReceive = document.getElementById('qa-receive-stock');
  if (qaReceive) qaReceive.addEventListener('click', () => {
    switchView('inventory');
  });

  // Inbox filter chips
  document.querySelectorAll('[data-inbox-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('[data-inbox-filter]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      inboxFilter = chip.dataset.inboxFilter;
      loadInbox();
    });
  });

  // Prescriptions filter chips
  document.querySelectorAll('[data-rx-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('[data-rx-filter]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      rxFilter = chip.dataset.rxFilter;
      loadPrescriptions();
    });
  });

  // Inventory filter chips
  document.querySelectorAll('[data-inv-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('[data-inv-filter]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      invFilter = chip.dataset.invFilter;
      loadInventory();
    });
  });

  // Inventory search (debounced)
  const invSearch = document.getElementById('inventory-search');
  if (invSearch) invSearch.addEventListener('input', debounce(() => loadInventory(), 350));

  // Add medicine button
  const addMedBtn = document.getElementById('add-medicine-btn');
  if (addMedBtn) addMedBtn.addEventListener('click', () => openMedicineModal());

  // Dispense view search
  const dispSearch    = document.getElementById('dispense-search');
  const dispSearchBtn = document.getElementById('dispense-search-btn');
  if (dispSearchBtn) dispSearchBtn.addEventListener('click', () => doDispenseSearch());
  if (dispSearch) {
    dispSearch.addEventListener('keydown', e => {
      if (e.key === 'Enter') doDispenseSearch();
    });
  }

  // Movements filter chips
  document.querySelectorAll('[data-mv-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('[data-mv-filter]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      mvFilter = chip.dataset.mvFilter;
      mvPage   = 1;
      loadMovements();
    });
  });

  // Medicine modal
  setupModalClose('medicine-modal-overlay', 'medicine-modal-close', 'medicine-modal-cancel');
  document.getElementById('medicine-modal-save').addEventListener('click', saveMedicine);

  // Stock modal
  setupModalClose('stock-modal-overlay', 'stock-modal-close', 'stock-modal-cancel');
  document.getElementById('stock-modal-save').addEventListener('click', saveStock);

  // Dispense modal
  setupModalClose('dispense-modal-overlay', 'dispense-modal-close', 'dispense-modal-cancel');
  document.getElementById('dispense-modal-confirm').addEventListener('click', confirmDispense);

  // Patient panel modal
  setupModalClose('patient-panel-overlay', 'patient-panel-close', 'patient-panel-dismiss');

  // ── NEW: Patient Search + Shared File ──────────────────────────────────────
  initPatientSearchAndFile(profile);
}

function setupModalClose(overlayId, closeId, cancelId) {
  const close = () => document.getElementById(overlayId)?.classList.remove('active');
  document.getElementById(closeId)?.addEventListener('click', close);
  document.getElementById(cancelId)?.addEventListener('click', close);
  document.getElementById(overlayId)?.addEventListener('click', e => {
    if (e.target === document.getElementById(overlayId)) close();
  });
}

async function handleSignOut() {
  try {
    await signOut();
  } catch (err) {
    console.error('Pharmacy sign-out failed:', err);
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
    overview:      'Overview',
    prescriptions: 'Prescriptions Queue',
    inventory:     'Medicine Inventory',
    dispense:      'Dispense Medication',
    movements:     'Inventory Movements',
    search:        'Patient Search',
    'patient-file': 'Patient File',
  };
  document.getElementById('page-title').textContent = titles[view] || 'Pharmacy';

  // Lazy-load on first switch (reload on every subsequent visit too)
  if (view === 'prescriptions') loadPrescriptions();
  if (view === 'inventory')     loadInventory();
  if (view === 'movements')     loadMovements();
}

// ─── Notifications ────────────────────────────────────────────────────────────
async function loadNotifications() {
  const count    = await countUnreadInbox();
  const badge    = document.getElementById('notif-count');
  const navBadge = document.getElementById('inbox-nav-badge');
  const display  = count > 0 ? 'flex' : 'none';

  if (badge) {
    badge.textContent    = count > 99 ? '99+' : count;
    badge.style.display  = display;
  }
  if (navBadge) {
    navBadge.textContent   = count > 99 ? '99+' : count;
    navBadge.style.display = count > 0 ? 'inline-flex' : 'none';
  }

  // Populate notification panel preview
  const { data } = await getMyInbox('active');
  const list = document.getElementById('notif-list');
  if (!list) return;
  if (!data || data.length === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:1rem">No new notifications</div>';
    return;
  }
  list.innerHTML = data.slice(0, 10).map(t => `
    <div class="notif-item" style="padding:.75rem 1rem;border-bottom:1px solid var(--border-color);cursor:pointer" data-transfer-id="${escapeHtml(t.id)}">
      <div style="font-weight:600;font-size:.85rem">${escapeHtml(t.patient?.first_name || '')} ${escapeHtml(t.patient?.last_name || '')}</div>
      <div style="font-size:.8rem;color:var(--text-muted)">${escapeHtml(t.sender?.full_name || '—')} · ${timeAgo(t.created_at)}</div>
    </div>
  `).join('');
  list.querySelectorAll('.notif-item').forEach(item => {
    item.addEventListener('click', () => {
      document.getElementById('notif-panel').classList.remove('open');
      const transfer = data.find(t => t.id === item.dataset.transferId);
      if (transfer) openPatientPanel(transfer);
    });
  });
}

// ─── Overview ─────────────────────────────────────────────────────────────────
async function loadOverview() {
  // ── Stats ──────────────────────────────────────────────────────────────────
  const now        = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const in30Days   = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const [pendingRes, expiringRes, dispensedRes] = await Promise.all([
    supabase.from('prescriptions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active'),
    supabase.from('medicine_batches')
      .select('id', { count: 'exact', head: true })
      .lte('expiry_date', in30Days)
      .gt('quantity', 0),
    supabase.from('inventory_movements')
      .select('id', { count: 'exact', head: true })
      .eq('movement_type', 'dispensing')
      .gte('created_at', todayStart),
  ]);

  setStatEl('stat-pending-rx',    pendingRes.count    ?? 0);
  setStatEl('stat-dispensed-today', dispensedRes.count ?? 0);
  setStatEl('stat-expiring',      expiringRes.count   ?? 0);

  // Low stock count: medicines where available_stock <= reorder_level
  const { data: lowMeds } = await supabase.from('medicine_catalog')
    .select('id, generic_name, brand_name, current_stock, reorder_level')
    .eq('is_active', true)
    .order('current_stock', { ascending: true });

  const trulyLow = (lowMeds || []).filter(m => (m.current_stock || 0) <= (m.reorder_level || 0));
  setStatEl('stat-low-stock', trulyLow.length);

  // ── Low stock list (top 5) ─────────────────────────────────────────────────
  const container = document.getElementById('overview-low-stock-list');
  if (!container) return;

  const top5 = trulyLow.slice(0, 5);
  if (top5.length === 0) {
    container.innerHTML = '<div class="empty-state">All medicines are adequately stocked.</div>';
    return;
  }
  container.innerHTML = top5.map(m => {
    const stockColor = (m.current_stock || 0) === 0 ? 'var(--danger)' : 'var(--warning)';
    return `
      <div class="list-item" style="padding:.6rem .75rem">
        <div class="list-item-body">
          <div class="list-item-title" style="font-size:.9rem">${escapeHtml(m.generic_name + (m.brand_name ? ' (' + m.brand_name + ')' : ''))}</div>
          <div class="list-item-meta">Reorder level: ${escapeHtml(String(m.reorder_level || 0))}</div>
        </div>
        <div class="list-item-aside">
          <span style="font-weight:700;color:${stockColor};font-size:.95rem">${escapeHtml(String(m.current_stock || 0))}</span>
          <span style="font-size:.75rem;color:var(--text-muted)">in stock</span>
        </div>
      </div>
    `;
  }).join('');
}

function setStatEl(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ─── Inbox ────────────────────────────────────────────────────────────────────
async function loadInbox() {
  const container = document.getElementById('inbox-list');
  if (!container) return;
  container.innerHTML = '<div class="loading-state">Loading inbox...</div>';

  const { data, error } = await getMyInbox(inboxFilter);
  if (error) {
    container.innerHTML = `<div class="error-state">Error: ${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No inbox items found.</div>';
    return;
  }

  container.innerHTML = data.map(t => renderInboxItem(t)).join('');
  bindInboxActions(container, data);
}

function renderInboxItem(t) {
  const patient    = t.patient || {};
  const sender     = t.sender  || {};
  const name       = `${patient.first_name || ''} ${patient.last_name || ''}`.trim() || 'Unknown';
  const statusCls  = getStatusBadgeClass(t.status);
  return `
    <div class="list-item inbox-item" data-id="${escapeHtml(t.id)}" style="cursor:pointer">
      <div class="list-item-avatar">${getInitials(name)}</div>
      <div class="list-item-body">
        <div class="list-item-title">${escapeHtml(name)} <span class="text-muted" style="font-weight:400">· ${escapeHtml(patient.hospital_number || '')}</span></div>
        <div class="list-item-meta">From: ${escapeHtml(sender.full_name || '—')} (${escapeHtml(sender.department || t.from_department || '')})</div>
        ${t.reason ? `<div class="list-item-note">${escapeHtml(t.reason)}</div>` : ''}
      </div>
      <div class="list-item-aside">
        <span class="badge ${statusCls}">${formatTransferStatus(t.status)}</span>
        <span class="text-muted" style="font-size:.75rem">${timeAgo(t.created_at)}</span>
        <div class="item-actions" style="margin-top:.4rem">
          ${t.status === 'sent' ? `<button class="btn btn-warning btn-xs ack-btn" data-id="${escapeHtml(t.id)}">Acknowledge</button>` : ''}
          ${renderInboxStatusActions(t)}
        </div>
      </div>
    </div>
  `;
}

function renderInboxStatusActions(t) {
  const opts = [];
  if (['sent', 'received'].includes(t.status))
    opts.push({ label: 'In Progress', value: 'in_progress' });
  if (t.status === 'in_progress')
    opts.push({ label: 'Awaiting Results', value: 'awaiting_results' });
  if (['in_progress', 'awaiting_results'].includes(t.status)) {
    opts.push({ label: 'Complete',  value: 'completed' });
    opts.push({ label: 'Return',    value: 'returned'  });
  }
  if (opts.length === 0) return '';
  return `
    <select class="status-select form-control form-control-xs" data-id="${escapeHtml(t.id)}">
      <option value="">Update status...</option>
      ${opts.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('')}
    </select>
  `;
}

function bindInboxActions(container, data) {
  container.querySelectorAll('.inbox-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.ack-btn') || e.target.closest('.status-select')) return;
      const transfer = data.find(t => t.id === item.dataset.id);
      if (transfer) openPatientPanel(transfer);
    });
  });

  container.querySelectorAll('.ack-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      btn.disabled = true;
      const { error } = await acknowledgeTransfer(btn.dataset.id);
      if (error) { showToast(error.message, 'error'); btn.disabled = false; }
      else { showToast('Transfer acknowledged', 'success'); loadInbox(); loadNotifications(); }
    });
  });

  container.querySelectorAll('.status-select').forEach(sel => {
    sel.addEventListener('change', async e => {
      e.stopPropagation();
      if (!sel.value) return;
      const { error } = await updateTransferStatus(sel.dataset.id, sel.value);
      if (error) { showToast(error.message, 'error'); }
      else { showToast('Status updated', 'success'); loadInbox(); }
    });
  });
}

// ─── Patient Panel (Inbox detail) ─────────────────────────────────────────────
async function openPatientPanel(transfer) {
  const overlay  = document.getElementById('patient-panel-overlay');
  const content  = document.getElementById('patient-panel-content');
  if (!overlay || !content) return;
  overlay.classList.add('active');
  content.innerHTML = '<div class="loading-state">Loading patient info...</div>';

  const patient = transfer.patient || {};
  const name    = `${patient.first_name || ''} ${patient.middle_name ? patient.middle_name + ' ' : ''}${patient.last_name || ''}`.trim();

  // Fetch active prescriptions for this patient
  const { data: prescriptions, error: rxErr } = await supabase.from('prescriptions')
    .select(`*, prescription_items(*), prescribing_doctor:profiles(full_name)`)
    .eq('patient_id', patient.id)
    .in('status', ['active', 'partially_dispensed'])
    .order('created_at', { ascending: false });

  content.innerHTML = `
    <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:1.25rem">
      <div class="list-item-avatar" style="width:48px;height:48px;font-size:1.1rem">${getInitials(name)}</div>
      <div>
        <div style="font-weight:700;font-size:1rem">${escapeHtml(name)}</div>
        <div style="font-size:.82rem;color:var(--text-muted)">HN: ${escapeHtml(patient.hospital_number || '—')} · ${calculateAge(patient.date_of_birth)}</div>
      </div>
      <span class="badge ${getStatusBadgeClass(transfer.status)}" style="margin-left:auto">${formatTransferStatus(transfer.status)}</span>
    </div>

    <div style="margin-bottom:.5rem;font-size:.85rem;color:var(--text-muted)">From: ${escapeHtml(transfer.sender?.full_name || '—')}</div>
    ${transfer.reason ? `<div class="list-item-note" style="margin-bottom:1rem">${escapeHtml(transfer.reason)}</div>` : ''}

    <hr style="margin:.75rem 0">
    <div style="font-weight:600;font-size:.9rem;margin-bottom:.6rem">Active Prescriptions</div>

    ${rxErr || !prescriptions || prescriptions.length === 0
      ? `<div class="empty-state">No active prescriptions found.</div>`
      : prescriptions.map(rx => `
          <div style="background:var(--bg-secondary,#f8fafc);border:1px solid var(--border-color);border-radius:8px;padding:.75rem;margin-bottom:.6rem">
            <div style="font-weight:600;font-size:.875rem">
              RX #${escapeHtml(rx.prescription_number || rx.rx_number || rx.id.slice(0, 8))}
              <span class="badge ${getStatusBadgeClass(rx.status)}" style="margin-left:.5rem">${escapeHtml(rx.status || '')}</span>
            </div>
            <div style="font-size:.78rem;color:var(--text-muted);margin:.2rem 0">
              ${formatDate(rx.created_at, 'datetime')} · Dr. ${escapeHtml(rx.prescribing_doctor?.full_name || '—')}
            </div>
            ${(rx.prescription_items || []).map(item => `
              <div style="font-size:.82rem;margin-top:.3rem">
                💊 <strong>${escapeHtml(item.medicine_name || item.generic_name || '')}</strong> ${escapeHtml(item.strength || '')}
                — ${escapeHtml(item.dosage || '')} · ${escapeHtml(item.route || '')} · ${escapeHtml(item.frequency || '')}
                ${item.duration ? `· ${escapeHtml(item.duration)}` : ''}
                ${item.quantity ? `· Qty: <strong>${escapeHtml(String(item.quantity))}</strong>` : ''}
                ${item.quantity_dispensed ? `<span style="color:var(--success)"> (${escapeHtml(String(item.quantity_dispensed))} dispensed)</span>` : ''}
                ${item.instructions ? `<div style="font-size:.76rem;color:var(--text-muted);margin-left:1.2rem"><em>Instructions: ${escapeHtml(item.instructions)}</em></div>` : ''}
              </div>
            `).join('')}
            <button class="btn btn-primary btn-xs" style="margin-top:.6rem" data-rx-id="${escapeHtml(rx.id)}">
              💊 Dispense
            </button>
          </div>
        `).join('')
    }
  `;

  // Wire up dispense buttons in panel
  content.querySelectorAll('[data-rx-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.classList.remove('active');
      const rx = prescriptions.find(r => r.id === btn.dataset.rxId);
      if (rx) openDispenseModal(rx, patient);
    });
  });
}

// ─── Prescriptions Queue ──────────────────────────────────────────────────────
async function loadPrescriptions() {
  const container = document.getElementById('prescriptions-list');
  if (!container) return;
  container.innerHTML = '<div class="loading-state">Loading prescriptions...</div>';

  let query = supabase.from('prescriptions')
    .select(`
      *,
      patient:patients(id, first_name, last_name, hospital_number, date_of_birth, sex),
      prescription_items(*),
      prescribing_doctor:profiles(full_name)
    `)
    .order('created_at', { ascending: false });

  if (rxFilter !== 'all') query = query.eq('status', rxFilter);

  const { data, error } = await query;
  if (error) {
    container.innerHTML = `<div class="error-state">Error: ${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No prescriptions found.</div>';
    return;
  }

  container.innerHTML = data.map(rx => renderRxCard(rx)).join('');

  container.querySelectorAll('.dispense-rx-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const rx      = data.find(r => r.id === btn.dataset.rxId);
      const patient = rx?.patient;
      if (rx && patient) openDispenseModal(rx, patient);
    });
  });
}

function renderRxCard(rx) {
  const patient = rx.patient || {};
  const items   = rx.prescription_items || [];
  const name    = `${patient.first_name || ''} ${patient.last_name || ''}`.trim() || 'Unknown';

  return `
    <div class="list-item" style="flex-direction:column;align-items:stretch;gap:.5rem">
      <div style="display:flex;align-items:flex-start;gap:.75rem">
        <div class="list-item-avatar">${getInitials(name)}</div>
        <div style="flex:1">
          <div class="list-item-title">
            RX #${escapeHtml(rx.prescription_number || rx.rx_number || rx.id.slice(0, 8))} —
            ${escapeHtml(name)}
            <span class="text-muted" style="font-weight:400">· ${escapeHtml(patient.hospital_number || '—')}</span>
          </div>
          <div class="list-item-meta">
            Dr. ${escapeHtml(rx.prescribing_doctor?.full_name || '—')} · ${formatDate(rx.created_at, 'datetime')}
          </div>
          <div style="margin-top:.4rem">
            ${items.map(item => `
              <div style="font-size:.82rem;margin-top:.25rem">
                💊 <strong>${escapeHtml(item.medicine_name || item.generic_name || '')}</strong> ${escapeHtml(item.strength || '')}
                — ${escapeHtml(item.dosage || '')} · ${escapeHtml(item.route || '')} · ${escapeHtml(item.frequency || '')}
                ${item.duration ? `· ${escapeHtml(item.duration)}` : ''}
                ${item.quantity ? `· Qty: <strong>${escapeHtml(String(item.quantity))}</strong>` : ''}
                ${item.quantity_dispensed ? `<span style="color:var(--success)"> (${escapeHtml(String(item.quantity_dispensed))} dispensed)</span>` : ''}
                ${item.instructions ? `<div style="font-size:.76rem;color:var(--text-muted);margin-left:1.2rem"><em>Instructions: ${escapeHtml(item.instructions)}</em></div>` : ''}
              </div>
            `).join('')}
          </div>
          ${rx.notes ? `<div class="list-item-note" style="margin-top:.4rem">${escapeHtml(rx.notes)}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:.4rem">
          <span class="badge ${getStatusBadgeClass(rx.status)}">${escapeHtml(rx.status || '')}</span>
          ${rx.status !== 'dispensed' && rx.status !== 'cancelled' ? `
            <button class="btn btn-primary btn-xs dispense-rx-btn" data-rx-id="${escapeHtml(rx.id)}">
              💊 Dispense
            </button>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

// ─── Medicine Inventory ───────────────────────────────────────────────────────
async function loadInventory() {
  const grid = document.getElementById('inventory-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="loading-state">Loading inventory...</div>';

  const searchTerm = (document.getElementById('inventory-search')?.value || '').trim().toLowerCase();

  let query = supabase.from('medicine_catalog')
    .select('*')
    .eq('is_active', true)
    .order('generic_name', { ascending: true });

  if (searchTerm) {
    query = query.or(`generic_name.ilike.%${searchTerm}%,brand_name.ilike.%${searchTerm}%,sku.ilike.%${searchTerm}%`);
  }

  let { data, error } = await query;
  if (error) {
    grid.innerHTML = `<div class="error-state">Error: ${escapeHtml(error.message)}</div>`;
    return;
  }

  data = data || [];

  // Client-side filter for 'low', 'out', 'expiring'
  if (invFilter === 'low') {
    data = data.filter(m => (m.current_stock || 0) > 0 && (m.current_stock || 0) <= (m.reorder_level || 0));
  } else if (invFilter === 'out') {
    data = data.filter(m => (m.current_stock || 0) === 0);
  } else if (invFilter === 'expiring') {
    const in30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const { data: batches } = await supabase.from('medicine_batches')
      .select('medicine_id')
      .lte('expiry_date', in30)
      .gt('quantity', 0);
    const expMedIds = new Set((batches || []).map(b => b.medicine_id));
    data = data.filter(m => expMedIds.has(m.id));
  }

  if (data.length === 0) {
    grid.innerHTML = '<div class="empty-state">No medicines found.</div>';
    return;
  }

  grid.innerHTML = data.map(m => renderMedicineCard(m)).join('');

  grid.querySelectorAll('.edit-medicine-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const med = data.find(m => m.id === btn.dataset.id);
      if (med) openMedicineModal(med);
    });
  });

  grid.querySelectorAll('.receive-stock-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const med = data.find(m => m.id === btn.dataset.id);
      if (med) openStockModal(med);
    });
  });
}

function renderMedicineCard(m) {
  const stock = m.current_stock || 0;
  const reorder = m.reorder_level || 0;
  let stockColor = 'var(--success)';
  let stockLabel = 'In Stock';
  if (stock === 0) {
    stockColor = 'var(--danger)';
    stockLabel = 'Out of Stock';
  } else if (stock <= reorder) {
    stockColor = 'var(--warning)';
    stockLabel = 'Low Stock';
  }

  return `
    <div class="medicine-card" style="background:var(--bg-primary,#fff);border:1px solid var(--border-color);border-radius:12px;padding:1rem;display:flex;flex-direction:column;gap:.5rem">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem">
        <div>
          <div style="font-weight:700;font-size:.95rem">${escapeHtml(m.generic_name + (m.brand_name ? ' (' + m.brand_name + ')' : ''))}</div>
          ${m.generic_name ? `<div style="font-size:.8rem;color:var(--text-muted)">${escapeHtml(m.generic_name)}</div>` : ''}
        </div>
        <span style="background:${stockColor};color:#fff;border-radius:20px;padding:.2rem .6rem;font-size:.72rem;font-weight:600;white-space:nowrap">${stockLabel}</span>
      </div>
      <div style="font-size:.82rem;color:var(--text-muted)">
        ${m.brand_name ? `Brand: ${escapeHtml(m.brand_name)} · ` : ''}${escapeHtml(m.dosage_form || '')} ${escapeHtml(m.strength || '')}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg-secondary,#f8fafc);border-radius:8px;padding:.5rem .75rem">
        <div>
          <div style="font-size:.75rem;color:var(--text-muted)">In Stock</div>
          <div style="font-weight:700;font-size:1.2rem;color:${stockColor}">${escapeHtml(String(stock))}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:.75rem;color:var(--text-muted)">Reorder At</div>
          <div style="font-weight:600;font-size:.95rem">${escapeHtml(String(reorder))}</div>
        </div>
      </div>
      <div style="font-size:.78rem;color:var(--text-muted)">SKU: ${escapeHtml(m.sku || '—')}</div>
      <div style="display:flex;gap:.5rem;margin-top:.25rem">
        <button class="btn btn-ghost btn-xs edit-medicine-btn" data-id="${escapeHtml(m.id)}" style="flex:1">✏️ Edit</button>
        <button class="btn btn-primary btn-xs receive-stock-btn" data-id="${escapeHtml(m.id)}" style="flex:1">📦 Receive Stock</button>
      </div>
    </div>
  `;
}

// ─── Add / Edit Medicine Modal ────────────────────────────────────────────────
function openMedicineModal(medicine = null) {
  const overlay   = document.getElementById('medicine-modal-overlay');
  const titleEl   = document.getElementById('medicine-modal-title');
  const editIdEl  = document.getElementById('medicine-edit-id');
  const form      = document.getElementById('medicine-form');
  if (!overlay || !form) return;

  form.reset();
  editIdEl.value = '';

  if (medicine) {
    titleEl.textContent = 'Edit Medicine';
    editIdEl.value      = medicine.id;
    // Populate by field name attrs
    const fields = ['generic_name','brand_name','strength','dosage_form',
                    'unit_of_measure','sku','reorder_level','purchase_price','selling_price'];
    fields.forEach(f => {
      const el = form.querySelector(`[name="${f}"]`);
      if (el && medicine[f] != null) el.value = medicine[f];
    });
  } else {
    titleEl.textContent = 'Add Medicine';
  }

  overlay.classList.add('active');
}

async function saveMedicine() {
  const form     = document.getElementById('medicine-form');
  const editId   = document.getElementById('medicine-edit-id')?.value;
  const btn      = document.getElementById('medicine-modal-save');
  if (!form) return;

  const medicineName = form.querySelector('[name="medicine_name"]')?.value.trim();
  if (!medicineName) { showToast('Medicine name is required', 'warning'); return; }

  const dosageForm = form.querySelector('[name="dosage_form"]')?.value.trim();
  if (!dosageForm) { showToast('Dosage form is required', 'warning'); return; }

  const unitOfMeasure = form.querySelector('[name="unit_of_measure"]')?.value.trim() || 'units';

  const payload = {
    generic_name:    medicineName,
    generic_name:    form.querySelector('[name="generic_name"]')?.value.trim()    || null,
    brand_name:      form.querySelector('[name="brand_name"]')?.value.trim()      || null,
    strength:        form.querySelector('[name="strength"]')?.value.trim()        || null,
    dosage_form:     dosageForm,
    unit_of_measure: unitOfMeasure,
    sku:             form.querySelector('[name="sku"]')?.value.trim()             || null,
    reorder_level:   parseInt(form.querySelector('[name="reorder_level"]')?.value) || 10,
    purchase_price:  parseFloat(form.querySelector('[name="purchase_price"]')?.value) || 0.00,
    selling_price:   parseFloat(form.querySelector('[name="selling_price"]')?.value)  || 0.00,
    is_active:       true,
  };

  btn.disabled    = true;
  btn.textContent = 'Saving...';

  const { data: user } = await supabase.auth.getUser();

  let error;
  if (editId) {
    ({ error } = await supabase.from('medicine_catalog').update(payload).eq('id', editId));
  } else {
    ({ error } = await supabase.from('medicine_catalog').insert([{
      ...payload,
      current_stock: 0,
      created_by: user?.user?.id || null,
    }]));
  }

  btn.disabled    = false;
  btn.textContent = 'Save Medicine';

  if (error) { showToast(error.message, 'error'); return; }
  showToast(editId ? 'Medicine updated' : 'Medicine added to catalogue', 'success');
  document.getElementById('medicine-modal-overlay').classList.remove('active');
  loadInventory();
  if (currentView === 'overview') loadOverview();
}

// ─── Receive Stock Modal ──────────────────────────────────────────────────────
let _stockMedicineId   = null;
let _stockCurrentQty   = 0;

function openStockModal(medicine) {
  const overlay  = document.getElementById('stock-modal-overlay');
  const nameEl   = document.getElementById('stock-modal-medicine-name');
  const medIdEl  = document.getElementById('stock-medicine-id');
  const form     = document.getElementById('stock-form');
  if (!overlay || !form) return;

  form.reset();
  _stockMedicineId = medicine.id;
  _stockCurrentQty = medicine.current_stock || 0;
  if (nameEl) nameEl.textContent = escapeHtml(medicine.generic_name + (medicine.brand_name ? ' (' + medicine.brand_name + ')' : ''));
  if (medIdEl) medIdEl.value     = medicine.id;

  overlay.classList.add('active');
}

async function saveStock() {
  const form = document.getElementById('stock-form');
  const btn  = document.getElementById('stock-modal-save');
  if (!form || !_stockMedicineId) return;

  const batchNumber   = form.querySelector('[name="batch_number"]')?.value.trim();
  const quantity      = parseInt(form.querySelector('[name="quantity"]')?.value) || 0;
  const expiryDate    = form.querySelector('[name="expiry_date"]')?.value;
  const manufactDate  = form.querySelector('[name="manufacture_date"]')?.value || null;
  const purchasePrice = parseFloat(form.querySelector('[name="purchase_price"]')?.value) || null;
  const supplierName  = form.querySelector('[name="supplier_name"]')?.value.trim() || null;

  if (!batchNumber) { showToast('Batch number is required', 'warning'); return; }
  if (quantity <= 0) { showToast('Quantity must be greater than zero', 'warning'); return; }
  if (!expiryDate)   { showToast('Expiry date is required', 'warning'); return; }

  btn.disabled    = true;
  btn.textContent = 'Saving...';

  const { data: user }  = await supabase.auth.getUser();
  const userId          = user?.user?.id;
  const previousStock   = _stockCurrentQty;
  const resultingStock  = previousStock + quantity;

  // 1. Insert medicine_batch
  const { data: batch, error: batchErr } = await supabase.from('medicine_batches').insert([{
    medicine_id:        _stockMedicineId,
    batch_number:       batchNumber,
    quantity:           quantity,
    manufacture_date:   manufactDate || null,
    expiry_date:        expiryDate,
    purchase_price:     purchasePrice,
    supplier_name:      supplierName,
    received_by:        userId,
    received_at:        new Date().toISOString(),
  }]).select().single();

  if (batchErr) { showToast(batchErr.message, 'error'); btn.disabled = false; btn.textContent = 'Save'; return; }

  // 2. Update medicine_catalog.available_stock
  const { error: updateErr } = await supabase.from('medicine_catalog')
    .update({ current_stock: resultingStock })
    .eq('id', _stockMedicineId);

  if (updateErr) { showToast(updateErr.message, 'error'); btn.disabled = false; btn.textContent = 'Save'; return; }

  // 3. Insert inventory_movement
  await supabase.from('inventory_movements').insert([{
    medicine_id:     _stockMedicineId,
    batch_id:        batch?.id || null,
    movement_type:   'stock_receipt',
    quantity:        quantity,
    previous_stock:  previousStock,
    resulting_stock: resultingStock,
    unit_purchase_cost: purchasePrice,
    reason:          `Batch: ${batchNumber}${supplierName ? ` from ${supplierName}` : ''}`,
    performed_by:    userId,
  }]);

  btn.disabled    = false;
  btn.textContent = 'Save';

  showToast(`Stock received: +${quantity} units`, 'success');
  document.getElementById('stock-modal-overlay').classList.remove('active');
  loadInventory();
  if (currentView === 'overview') loadOverview();
}

// ─── Dispense — Search View ───────────────────────────────────────────────────
async function doDispenseSearch() {
  const query     = (document.getElementById('dispense-search')?.value || '').trim();
  const container = document.getElementById('dispense-prescription-detail');
  if (!container) return;

  if (!query) { showToast('Enter an RX number or patient hospital number', 'warning'); return; }
  container.innerHTML = '<div class="loading-state">Searching...</div>';

  // Try matching prescription number first, then patient HN
  let { data, error } = await supabase.from('prescriptions')
    .select(`
      *,
      patient:patients(id, first_name, last_name, hospital_number, date_of_birth, sex),
      prescription_items(*),
      prescribing_doctor:profiles(full_name)
    `)
    .or(`prescription_number.ilike.%${query}%`)
    .not('status', 'eq', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) { container.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`; return; }

  // Also search by patient hospital number
  if (!data || data.length === 0) {
    const { data: byHN } = await supabase.from('prescriptions')
      .select(`
        *,
        patient:patients!inner(id, first_name, last_name, hospital_number, date_of_birth, sex),
        prescription_items(*),
        prescribing_doctor:profiles(full_name)
      `)
      .eq('patient.hospital_number', query)
      .not('status', 'eq', 'cancelled')
      .order('created_at', { ascending: false })
      .limit(10);
    data = byHN || [];
  }

  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No prescriptions found for that RX number or hospital number.</div>';
    return;
  }

  container.innerHTML = data.map(rx => renderDispenseRxDetail(rx)).join('');

  container.querySelectorAll('.open-dispense-modal-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const rx      = data.find(r => r.id === btn.dataset.rxId);
      const patient = rx?.patient;
      if (rx && patient) openDispenseModal(rx, patient);
    });
  });
}

function renderDispenseRxDetail(rx) {
  const patient = rx.patient || {};
  const items   = rx.prescription_items || [];
  const name    = `${patient.first_name || ''} ${patient.last_name || ''}`.trim();

  return `
    <div style="background:var(--bg-primary,#fff);border:1px solid var(--border-color);border-radius:12px;padding:1.1rem;margin-bottom:1rem">
      <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.75rem">
        <div class="list-item-avatar">${getInitials(name)}</div>
        <div style="flex:1">
          <div style="font-weight:700">${escapeHtml(name)}</div>
          <div style="font-size:.8rem;color:var(--text-muted)">
            HN: ${escapeHtml(patient.hospital_number || '—')} · ${calculateAge(patient.date_of_birth)} · ${escapeHtml(patient.sex || '')}
          </div>
        </div>
        <span class="badge ${getStatusBadgeClass(rx.status)}">${escapeHtml(rx.status || '')}</span>
      </div>
      <div style="font-size:.83rem;color:var(--text-muted);margin-bottom:.6rem">
        RX #${escapeHtml(rx.prescription_number || rx.rx_number || rx.id.slice(0, 8))} ·
        Dr. ${escapeHtml(rx.prescribing_doctor?.full_name || '—')} ·
        ${formatDate(rx.created_at, 'datetime')}
      </div>
      <div style="background:var(--bg-secondary,#f8fafc);border-radius:8px;padding:.75rem;margin-bottom:.75rem">
        ${items.map(item => `
          <div style="font-size:.85rem;margin-bottom:.35rem;padding-bottom:.35rem;border-bottom:1px solid var(--border-color)">
            💊 <strong>${escapeHtml(item.medicine_name || item.generic_name || '')}</strong> ${escapeHtml(item.strength || '')}
            <span style="color:var(--text-muted)">— ${escapeHtml(item.dosage || '')} · ${escapeHtml(item.route || '')} · ${escapeHtml(item.frequency || '')} ${item.duration ? `for ${escapeHtml(item.duration)}` : ''}</span>
            <span style="float:right;font-size:.78rem">
              Ordered: <strong>${escapeHtml(String(item.quantity || 0))}</strong>
              · Dispensed: <strong style="color:var(--success)">${escapeHtml(String(item.quantity_dispensed || 0))}</strong>
            </span>
            ${item.instructions ? `<div style="font-size:.76rem;color:var(--text-muted);margin-top:.2rem"><em>Instructions: ${escapeHtml(item.instructions)}</em></div>` : ''}
          </div>
        `).join('')}
      </div>
      ${rx.status !== 'dispensed' && rx.status !== 'cancelled' ? `
        <button class="btn btn-primary open-dispense-modal-btn" data-rx-id="${escapeHtml(rx.id)}">💊 Dispense Medication</button>
      ` : `<div class="badge badge-success">Fully Dispensed</div>`}
    </div>
  `;
}

// ─── Dispense Modal ───────────────────────────────────────────────────────────
let _dispenseRx      = null;
let _dispensePatient = null;

function openDispenseModal(rx, patient) {
  _dispenseRx      = rx;
  _dispensePatient = patient;

  const overlay = document.getElementById('dispense-modal-overlay');
  const content = document.getElementById('dispense-modal-content');
  if (!overlay || !content) return;

  const items       = rx.prescription_items || [];
  const patientName = `${patient.first_name || ''} ${patient.last_name || ''}`.trim();

  content.innerHTML = `
    <div style="margin-bottom:1rem;padding:.75rem;background:var(--bg-secondary,#f8fafc);border-radius:8px">
      <div style="font-weight:700">${escapeHtml(patientName)}</div>
      <div style="font-size:.8rem;color:var(--text-muted)">HN: ${escapeHtml(patient.hospital_number || '—')} · RX #${escapeHtml(rx.prescription_number || rx.rx_number || rx.id.slice(0, 8))}</div>
    </div>

    ${items.filter(i => (i.quantity_dispensed || 0) < (i.quantity || 0)).map(item => {
      const remaining = (item.quantity || 0) - (item.quantity_dispensed || 0);
      return `
        <div class="dispense-item-row" data-item-id="${escapeHtml(item.id)}" style="padding:.75rem;border:1px solid var(--border-color);border-radius:8px;margin-bottom:.6rem">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem">
            <div style="flex:1">
              <div style="font-weight:600;font-size:.9rem">💊 ${escapeHtml(item.medicine_name || item.generic_name || '')} ${escapeHtml(item.strength || '')}</div>
              <div style="font-size:.78rem;color:var(--text-muted)">${escapeHtml(item.dosage || '')} · ${escapeHtml(item.route || '')} · ${escapeHtml(item.frequency || '')} ${item.duration ? `· ${escapeHtml(item.duration)}` : ''}</div>
              <div style="font-size:.78rem;color:var(--text-muted)">Ordered: ${escapeHtml(String(item.quantity || 0))} · Already dispensed: ${escapeHtml(String(item.quantity_dispensed || 0))} · Remaining: <strong>${escapeHtml(String(remaining))}</strong></div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:center;gap:.25rem">
              <label style="font-size:.75rem;color:var(--text-muted)">Qty to dispense</label>
              <input type="number" class="form-control dispense-qty-input"
                data-item-id="${escapeHtml(item.id)}"
                data-medicine-name="${escapeHtml(item.medicine_name || item.generic_name || '' || item.generic_name || '')}"
                value="${remaining}"
                min="0"
                max="${remaining}"
                style="width:80px;text-align:center"
              />
            </div>
          </div>
          ${item.instructions ? `<div style="font-size:.78rem;margin-top:.35rem;color:var(--text-muted)">Instructions: ${escapeHtml(item.instructions)}</div>` : ''}
        </div>
      `;
    }).join('')}

    ${items.every(i => (i.quantity_dispensed || 0) >= (i.quantity || 0)) ? '<div class="empty-state">All items already dispensed.</div>' : ''}
  `;

  overlay.classList.add('active');
}

async function confirmDispense() {
  if (!_dispenseRx || !_dispensePatient) return;

  const btn    = document.getElementById('dispense-modal-confirm');
  const inputs = document.querySelectorAll('.dispense-qty-input');

  // Build atomic dispense items payload
  const itemsPayload = [];
  inputs.forEach(input => {
    const qty = parseInt(input.value) || 0;
    if (qty > 0) {
      itemsPayload.push({
        prescription_item_id: input.dataset.itemId,
        quantity: qty
      });
    }
  });

  if (itemsPayload.length === 0) { showToast('Enter at least one quantity to dispense', 'warning'); return; }

  btn.disabled    = true;
  btn.textContent = 'Processing...';

  try {
    // Execute atomic dispensing transaction
    const { data, error } = await supabase.rpc('dispense_prescription_atomic', {
      p_prescription_id: _dispenseRx.id,
      p_items: itemsPayload,
      p_notes: `Dispensed via pharmacy console for patient ${_dispensePatient.hospital_number || 'N/A'}`
    });

    if (error) {
      console.error('Atomic dispense error:', error);
      showToast(`Dispensing failed: ${error.message}`, 'error');
      btn.disabled    = false;
      btn.textContent = 'Confirm Dispense';
      return;
    }

    btn.disabled    = false;
    btn.textContent = 'Confirm Dispense';

    showToast('Medication dispensed successfully', 'success');
    document.getElementById('dispense-modal-overlay').classList.remove('active');

    // Refresh relevant views
    if (currentView === 'prescriptions') loadPrescriptions();
    if (currentView === 'inventory')     loadInventory();
    if (currentView === 'overview')      loadOverview();

    // Refresh dispense view search result if visible
    const dispContainer = document.getElementById('dispense-prescription-detail');
    if (dispContainer && dispContainer.innerHTML.includes(_dispenseRx.id)) doDispenseSearch();
  } catch (err) {
    console.error('Unexpected dispensing error:', err);
    showToast(`Unexpected error: ${err.message || err}`, 'error');
    btn.disabled    = false;
    btn.textContent = 'Confirm Dispense';
  }
}

// ─── Inventory Movements ──────────────────────────────────────────────────────
async function loadMovements() {
  const tbody      = document.getElementById('movements-tbody');
  const pagination = document.getElementById('movements-pagination');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="7"><div class="loading-state">Loading movements...</div></td></tr>`;

  let query = supabase.from('inventory_movements')
    .select(`
      *,
      medicine:medicine_catalog(generic_name, brand_name),
      performed_by_profile:profiles(full_name)
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((mvPage - 1) * MV_PER_PAGE, mvPage * MV_PER_PAGE - 1);

  if (mvFilter !== 'all') query = query.eq('movement_type', mvFilter);

  const { data, error, count } = await query;

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="error-state">${escapeHtml(error.message)}</div></td></tr>`;
    return;
  }

  if (!data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">No movements found.</div></td></tr>`;
    if (pagination) pagination.innerHTML = '';
    return;
  }

  tbody.innerHTML = data.map(mv => {
    const typeLabel = {
      stock_receipt: 'Stock Receipt',
      dispensing:    'Dispensing',
      adjustment:    'Adjustment',
      expired:       'Expired',
      damaged:       'Damaged',
      returned:      'Returned',
      transfer:      'Transfer',
    }[mv.movement_type] || escapeHtml(mv.movement_type || '');

    const typeBadge = {
      stock_receipt: 'badge-success',
      dispensing:    'badge-info',
      adjustment:    'badge-warning',
      expired:       'badge-danger',
      damaged:       'badge-danger',
      returned:      'badge-secondary',
      transfer:      'badge-secondary',
    }[mv.movement_type] || '';

    const qtySign = ['stock_receipt', 'returned'].includes(mv.movement_type) ? '+' : '-';
    const qtyColor = ['stock_receipt', 'returned'].includes(mv.movement_type) ? 'var(--success)' : 'var(--danger)';

    return `
      <tr>
        <td>${formatDate(mv.created_at, 'datetime')}</td>
        <td>${escapeHtml(mv.medicine?.medicine_name || '—')}</td>
        <td><span class="badge ${typeBadge}">${typeLabel}</span></td>
        <td style="font-weight:700;color:${qtyColor}">${qtySign}${escapeHtml(String(mv.quantity || 0))}</td>
        <td>${escapeHtml(String(mv.previous_stock ?? '—'))}</td>
        <td>${escapeHtml(String(mv.resulting_stock ?? '—'))}</td>
        <td>${escapeHtml(mv.performed_by_profile?.full_name || '—')}</td>
      </tr>
    `;
  }).join('');

  if (pagination) {
    pagination.innerHTML = renderPagination({
      currentPage: mvPage,
      totalCount:  count || 0,
      perPage:     MV_PER_PAGE,
      onPageChange: page => { mvPage = page; loadMovements(); },
    });
  }
}

// ─── Patient Search & Shared File (Pharmacist) ────────────────────────────────
const PHARM_PAGE_SIZE = 20;

function initPatientSearchAndFile(profile) {
  // Patient search input
  const searchInput = document.getElementById('pharm-patient-search');
  if (searchInput) {
    searchInput.addEventListener('input', debounce(() => {
      pharmSearchQuery = searchInput.value.trim();
      pharmSearchPage = 1;
      doPharmPatientSearch();
    }, 400));
  }

  // Back button
  document.getElementById('pharm-back-btn')?.addEventListener('click', () => switchView('search'));

  // Initialize patient file component
  const container = document.getElementById('pharm-patient-file-container');
  if (container) {
    pharmPatientFileComponent = new PatientFile(container, {
      role: profile.role,
      userId: currentProfile?.id,
      userName: profile.full_name,
    });
  }
}

async function doPharmPatientSearch() {
  const container = document.getElementById('pharm-search-results');
  if (!container) return;
  container.innerHTML = '<div class="loading-state">Searching…</div>';

  const q = pharmSearchQuery;
  const offset = (pharmSearchPage - 1) * PHARM_PAGE_SIZE;

  const { data, error, count } = await supabase
    .from('patients')
    .select('id, hospital_number, first_name, middle_name, last_name, date_of_birth, sex, phone, created_at', { count: 'exact' })
    .or(q
      ? `hospital_number.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%,phone.ilike.%${q}%`
      : 'id.neq.00000000-0000-0000-0000-000000000000'
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + PHARM_PAGE_SIZE - 1);

  if (error) {
    container.innerHTML = `<div class="error-state">Search failed: ${escapeHtml(error.message)}</div>`;
    return;
  }

  if (!data?.length) {
    container.innerHTML = '<div class="empty-state">No patients found.</div>';
    document.getElementById('pharm-search-pagination').innerHTML = '';
    return;
  }

  container.innerHTML = data.map(patient => {
    const name = [patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ');
    const age = patient.date_of_birth ? `${calculateAge(patient.date_of_birth)} yrs` : '—';
    return `
      <div class="list-item">
        <div class="list-item-body">
          <div class="list-item-title">${escapeHtml(name)}</div>
          <div class="list-item-meta">
            🏥 ${escapeHtml(patient.hospital_number)} ·
            👤 ${escapeHtml(patient.sex || '—')}, ${age} ·
            📞 ${escapeHtml(patient.phone || '—')} ·
            Registered: ${formatDate(patient.created_at, 'date')}
          </div>
        </div>
        <div class="list-item-aside">
          <button class="btn btn-primary btn-sm pharm-open-patient-btn" data-patient-id="${escapeHtml(patient.id)}">
            Open File
          </button>
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll('.pharm-open-patient-btn').forEach(btn => {
    btn.addEventListener('click', () => pharmOpenPatientFile(btn.dataset.patientId));
  });

  // Pagination
  const pagEl = document.getElementById('pharm-search-pagination');
  if (pagEl) {
    const totalPages = Math.ceil((count || 0) / PHARM_PAGE_SIZE);
    if (totalPages > 1) {
      pagEl.innerHTML = `
        <div class="pagination">
          <button class="btn btn-sm btn-secondary" ${pharmSearchPage <= 1 ? 'disabled' : ''} id="pharm-pag-prev">← Prev</button>
          <span>Page ${pharmSearchPage} of ${totalPages}</span>
          <button class="btn btn-sm btn-secondary" ${pharmSearchPage >= totalPages ? 'disabled' : ''} id="pharm-pag-next">Next →</button>
        </div>`;
      document.getElementById('pharm-pag-prev')?.addEventListener('click', () => { pharmSearchPage--; doPharmPatientSearch(); });
      document.getElementById('pharm-pag-next')?.addEventListener('click', () => { pharmSearchPage++; doPharmPatientSearch(); });
    } else {
      pagEl.innerHTML = '';
    }
  }
}

async function pharmOpenPatientFile(patientId) {
  const badge = document.getElementById('patient-file-badge');
  if (badge) badge.style.display = '';
  switchView('patient-file');
  if (pharmPatientFileComponent) {
    await pharmPatientFileComponent.load(patientId);
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
