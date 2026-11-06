/**
 * Dreyson Global Hospital — EMR System
 * Nurse Dashboard Controller — Shared Patient Record Workflow
 *
 * Nurses can:
 *   - Search any registered patient
 *   - View the full shared patient file
 *   - Add vital signs (Section B write access)
 *   - Add nursing notes (Section B write access)
 *
 * Nurses CANNOT:
 *   - Create new patient records
 *   - Edit front-desk demographics
 *   - Create lab orders, prescriptions, or dispense medication
 */

import { requireAuth, signOut, redirectToDashboard } from './auth.js';
import { getInitials, formatRole, formatDate, calculateAge, showToast, debounce, escapeHtml } from './utils.js';
import { supabase } from './supabase-client.js';
import { PatientFile } from './patient-file.js';

// ─── State ───────────────────────────────────────────────────────────────────
let currentProfile = null;
let currentUser = null;
let currentView = 'overview';
let searchPage = 1;
let searchQuery = '';
let selectedPatientId = null;
let patientFileComponent = null;

const PAGE_SIZE = 20;

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const profile = await requireAuth();
  if (!profile) { window.location.replace('../index.html'); return; }
  if (profile.role !== 'nurse') { redirectToDashboard(profile.role, false); return; }

  const { data: userData } = await supabase.auth.getUser();
  currentUser = userData?.user || { id: profile.id };
  currentProfile = profile;

  initUI(profile);
  switchView('overview');
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
    if (menu && !menu.contains(e.target)) menu.classList.remove('open');
  });

  // Sign out
  document.getElementById('sign-out-btn').addEventListener('click', handleSignOut);
  document.getElementById('dropdown-signout').addEventListener('click', handleSignOut);

  // Nav items
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); switchView(el.dataset.view); });
  });

  // Quick action buttons
  document.querySelectorAll('.quick-action-btn[data-view]').forEach(el => {
    el.addEventListener('click', () => switchView(el.dataset.view));
  });

  // Patient search
  const searchInput = document.getElementById('nurse-patient-search');
  searchInput.addEventListener('input', debounce(() => {
    searchQuery = searchInput.value.trim();
    searchPage = 1;
    doPatientSearch();
  }, 400));

  // Back to search
  document.getElementById('nurse-back-to-search-btn').addEventListener('click', () => {
    switchView('search');
  });

  // Initialize patient file component (container exists in DOM)
  const container = document.getElementById('nurse-patient-file-container');
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
    overview: 'Nurse Dashboard',
    search: 'Patient Search',
    'patient-file': 'Patient File',
  };
  document.getElementById('page-title').textContent = titles[view] || 'Nurse Dashboard';
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebar-overlay').classList.remove('visible');

  if (view === 'search' && !searchQuery) {
    doPatientSearch();
  }
}

// ─── Sign Out ─────────────────────────────────────────────────────────────────
async function handleSignOut() {
  try {
    await signOut();
  } catch (err) {
    console.error('Nurse sign-out failed:', err);
  } finally {
    window.location.replace('../index.html');
  }
}

// ─── Patient Search ───────────────────────────────────────────────────────────
async function doPatientSearch() {
  const container = document.getElementById('nurse-search-results');
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
    container.innerHTML = '<div class="empty-state">No patients found. Check the spelling or try a different search term.</div>';
    document.getElementById('nurse-search-pagination').innerHTML = '';
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
  renderSearchPagination(count);
}

function renderSearchPagination(totalCount) {
  const pagEl = document.getElementById('nurse-search-pagination');
  if (!totalCount || totalCount <= PAGE_SIZE) { pagEl.innerHTML = ''; return; }
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  pagEl.innerHTML = `
    <div class="pagination">
      <button class="btn btn-sm btn-secondary" ${searchPage <= 1 ? 'disabled' : ''} id="pag-prev">← Prev</button>
      <span>Page ${searchPage} of ${totalPages}</span>
      <button class="btn btn-sm btn-secondary" ${searchPage >= totalPages ? 'disabled' : ''} id="pag-next">Next →</button>
    </div>`;
  document.getElementById('pag-prev')?.addEventListener('click', () => { searchPage--; doPatientSearch(); });
  document.getElementById('pag-next')?.addEventListener('click', () => { searchPage++; doPatientSearch(); });
}

// ─── Open Patient File ────────────────────────────────────────────────────────
async function openPatientFile(patientId) {
  selectedPatientId = patientId;

  // Show badge on nav
  const badge = document.getElementById('patient-file-badge');
  if (badge) badge.style.display = '';

  // Update overview
  updateOverviewCurrentPatient(patientId);

  // Switch to file view and load
  switchView('patient-file');
  await patientFileComponent.load(patientId);
}

async function updateOverviewCurrentPatient(patientId) {
  const container = document.getElementById('overview-current-patient');
  const { data, error } = await supabase
    .from('patients')
    .select('id, hospital_number, first_name, middle_name, last_name, date_of_birth, sex, phone')
    .eq('id', patientId)
    .single();
  if (error || !data) return;
  const name = [data.first_name, data.middle_name, data.last_name].filter(Boolean).join(' ');
  container.innerHTML = `
    <div class="list-item">
      <div class="list-item-body">
        <div class="list-item-title">${escapeHtml(name)}</div>
        <div class="list-item-meta">🏥 ${escapeHtml(data.hospital_number)} · 📞 ${escapeHtml(data.phone || '—')}</div>
      </div>
      <div class="list-item-aside">
        <button class="btn btn-primary btn-sm" id="overview-open-file-btn">Open File</button>
      </div>
    </div>`;
  document.getElementById('overview-open-file-btn')?.addEventListener('click', () => switchView('patient-file'));
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
