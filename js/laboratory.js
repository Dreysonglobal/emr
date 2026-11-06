/**
 * Dreyson Global Hospital — EMR System
 * Laboratory Technician Dashboard — Shared Patient Record Workflow
 *
 * Lab technicians can:
 *   - View all pending lab orders (no transfer required)
 *   - Search any registered patient
 *   - View the full shared patient file
 *   - Accept orders and enter/finalize results (Section D write access)
 *
 * Lab technicians CANNOT:
 *   - Edit patient demographics
 *   - Record nursing observations
 *   - Create lab orders or prescriptions
 *   - Record pharmacy dispensing
 */

import { requireAuth, signOut, redirectToDashboard } from './auth.js';
import {
  getInitials, formatRole, formatDate, calculateAge,
  getStatusBadgeClass, showToast, debounce, escapeHtml,
} from './utils.js';
import { supabase } from './supabase-client.js';
import { PatientFile } from './patient-file.js';
import { getAllLabOrders } from './api/shared-api.js';

// ─── State ───────────────────────────────────────────────────────────────────
let currentProfile = null;
let currentUser = null;
let currentView = 'overview';
let searchPage = 1;
let searchQuery = '';
let ordersFilter = 'all';
let patientFileComponent = null;

const PAGE_SIZE = 20;

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const profile = await requireAuth();
  if (!profile) { window.location.replace('../index.html'); return; }
  if (profile.role !== 'lab_technician') { redirectToDashboard(profile.role, false); return; }

  const { data: userData } = await supabase.auth.getUser();
  currentUser = userData?.user || { id: profile.id };
  currentProfile = profile;

  initUI(profile);
  try {
    await Promise.all([loadOverview(), loadOrdersQueue()]);
  } catch (err) {
    console.warn('Laboratory overview load non-fatal warning:', err);
  }
}

// ─── UI Bootstrap ─────────────────────────────────────────────────────────────
function initUI(profile) {
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

  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('mobile-open');
    document.getElementById('sidebar-overlay').classList.toggle('visible');
  });
  document.getElementById('sidebar-overlay').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebar-overlay').classList.remove('visible');
  });

  document.getElementById('profile-btn').addEventListener('click', () =>
    document.getElementById('profile-menu').classList.toggle('open'));
  document.addEventListener('click', e => {
    const menu = document.getElementById('profile-menu');
    if (menu && !menu.contains(e.target)) menu.classList.remove('open');
  });

  document.getElementById('sign-out-btn').addEventListener('click', handleSignOut);
  document.getElementById('dropdown-signout').addEventListener('click', handleSignOut);

  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); switchView(el.dataset.view); });
  });

  document.querySelectorAll('.quick-action-btn[data-view]').forEach(el => {
    el.addEventListener('click', () => switchView(el.dataset.view));
  });

  document.getElementById('refresh-orders-btn')?.addEventListener('click', loadOverview);

  // Patient search
  const searchInput = document.getElementById('lab-patient-search');
  searchInput?.addEventListener('input', debounce(() => {
    searchQuery = searchInput.value.trim();
    searchPage = 1;
    doPatientSearch();
  }, 400));

  // Orders filter chips
  document.querySelectorAll('#orders-filter-chips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#orders-filter-chips .chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      ordersFilter = chip.dataset.filter;
      loadOrdersQueue();
    });
  });

  // Back button
  document.getElementById('lab-back-btn')?.addEventListener('click', () => switchView('search'));

  // Initialize patient file component
  const container = document.getElementById('lab-patient-file-container');
  patientFileComponent = new PatientFile(container, {
    role: profile.role,
    userId: currentUser?.id,
    userName: profile.full_name,
  });
}

// ─── View Switching ───────────────────────────────────────────────────────────
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view-section').forEach(s => {
    s.style.display = s.id === `view-${view}` ? 'block' : 'none';
  });
  document.querySelectorAll('.nav-item[data-view]').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  const titles = {
    overview: 'Laboratory Dashboard',
    orders: 'Lab Orders Queue',
    search: 'Patient Search',
    'patient-file': 'Patient File',
  };
  document.getElementById('page-title').textContent = titles[view] || 'Laboratory Dashboard';
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
}

async function handleSignOut() {
  try {
    await signOut();
  } catch (err) {
    console.error('Laboratory sign-out failed:', err);
  } finally {
    window.location.replace('../index.html');
  }
}

// ─── Overview ─────────────────────────────────────────────────────────────────
async function loadOverview() {
  const [pendingRes, inProgressRes, todayRes] = await Promise.all([
    supabase.from('laboratory_orders').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('laboratory_orders').select('id', { count: 'exact', head: true }).eq('status', 'in_progress'),
    supabase.from('laboratory_orders').select('id', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('updated_at', new Date().toISOString().substring(0, 10)),
  ]);
  document.getElementById('stat-pending').textContent = pendingRes.count ?? '—';
  document.getElementById('stat-inprogress').textContent = inProgressRes.count ?? '—';
  document.getElementById('stat-completed-today').textContent = todayRes.count ?? '—';

  // Badge
  const badge = document.getElementById('orders-badge');
  const pendingCount = (pendingRes.count || 0) + (inProgressRes.count || 0);
  if (badge) { badge.textContent = String(pendingCount); badge.style.display = pendingCount ? '' : 'none'; }

  // Pending list
  const { data: pendingOrders } = await getAllLabOrders('pending', 10);
  renderOrdersList('overview-orders-list', pendingOrders || [], true);
}

// ─── Lab Orders Queue ─────────────────────────────────────────────────────────
async function loadOrdersQueue() {
  const container = document.getElementById('lab-orders-list');
  container.innerHTML = '<div class="loading-state">Loading orders…</div>';
  const status = ordersFilter === 'all' ? null : ordersFilter;
  const { data, error } = await getAllLabOrders(status, 100);
  if (error) { container.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`; return; }
  renderOrdersList('lab-orders-list', data || [], true);
}

function renderOrdersList(containerId, orders, showOpenButton) {
  const container = document.getElementById(containerId);
  if (!orders.length) {
    container.innerHTML = '<div class="empty-state">No lab orders found.</div>';
    return;
  }
  container.innerHTML = orders.map(order => {
    const patient = order.patient;
    const patientName = patient ? [patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ') : '—';
    const tests = (order.items || []).map(i => escapeHtml(i.test_name)).join(', ');
    return `
      <div class="list-item">
        <div class="list-item-body">
          <div class="list-item-title">${escapeHtml(order.order_number)} · ${escapeHtml(patientName)}</div>
          <div class="list-item-meta">
            <span class="status-badge ${getStatusBadgeClass(order.status)}">${order.status}</span>
            <span class="order-priority priority-${order.priority}">${order.priority}</span>
            ${tests ? `· Tests: ${tests}` : ''}
            ${order.clinical_indication ? `· Indication: ${escapeHtml(order.clinical_indication)}` : ''}
          </div>
          <div class="list-item-meta">
            Ordered by Dr. ${escapeHtml(order.ordering_doctor?.full_name || '—')} · ${formatDate(order.created_at, 'datetime')}
          </div>
        </div>
        ${showOpenButton && patient ? `
          <div class="list-item-aside">
            <button class="btn btn-primary btn-sm open-order-patient-btn" 
              data-patient-id="${escapeHtml(patient.id)}"
              data-order-number="${escapeHtml(order.order_number)}">
              Open Patient File
            </button>
          </div>` : ''}
      </div>`;
  }).join('');

  container.querySelectorAll('.open-order-patient-btn').forEach(btn => {
    btn.addEventListener('click', () => openPatientFile(btn.dataset.patientId));
  });
}

// ─── Patient Search ───────────────────────────────────────────────────────────
async function doPatientSearch() {
  const container = document.getElementById('lab-search-results');
  container.innerHTML = '<div class="loading-state">Searching…</div>';

  const q = searchQuery;
  const offset = (searchPage - 1) * PAGE_SIZE;

  const { data, error, count } = await supabase
    .from('patients')
    .select('id, hospital_number, first_name, middle_name, last_name, date_of_birth, sex, phone, created_at', { count: 'exact' })
    .or(q
      ? `hospital_number.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%,phone.ilike.%${q}%`
      : 'id.neq.00000000-0000-0000-0000-000000000000'
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (error) {
    container.innerHTML = `<div class="error-state">Search failed: ${escapeHtml(error.message)}</div>`;
    return;
  }

  if (!data?.length) {
    container.innerHTML = '<div class="empty-state">No patients found.</div>';
    document.getElementById('lab-search-pagination').innerHTML = '';
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
            Registered: ${formatDate(patient.created_at, 'date')}
          </div>
        </div>
        <div class="list-item-aside">
          <button class="btn btn-primary btn-sm open-patient-btn" data-patient-id="${escapeHtml(patient.id)}">
            Open File
          </button>
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll('.open-patient-btn').forEach(btn => {
    btn.addEventListener('click', () => openPatientFile(btn.dataset.patientId));
  });

  // Pagination
  const pagEl = document.getElementById('lab-search-pagination');
  const totalPages = Math.ceil((count || 0) / PAGE_SIZE);
  if (totalPages > 1) {
    pagEl.innerHTML = `
      <div class="pagination">
        <button class="btn btn-sm btn-secondary" ${searchPage <= 1 ? 'disabled' : ''} id="pag-prev">← Prev</button>
        <span>Page ${searchPage} of ${totalPages}</span>
        <button class="btn btn-sm btn-secondary" ${searchPage >= totalPages ? 'disabled' : ''} id="pag-next">Next →</button>
      </div>`;
    document.getElementById('pag-prev')?.addEventListener('click', () => { searchPage--; doPatientSearch(); });
    document.getElementById('pag-next')?.addEventListener('click', () => { searchPage++; doPatientSearch(); });
  } else {
    pagEl.innerHTML = '';
  }
}

// ─── Open Patient File ────────────────────────────────────────────────────────
async function openPatientFile(patientId) {
  const badge = document.getElementById('patient-file-badge');
  if (badge) badge.style.display = '';
  switchView('patient-file');
  await patientFileComponent.load(patientId);
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
