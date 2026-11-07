/**
 * Dreyson Global Hospital — EMR System
 * Doctor Dashboard Controller
 *
 * Handles all views: Overview, Inbox, Patient Chart, Lookup,
 * Lab Orders, Prescriptions, Send File.
 */

import { requireAuth, signOut, redirectToDashboard } from './auth.js';
import {
  getInitials, formatRole, formatDate, calculateAge,
  getStatusBadgeClass, showToast, debounce, timeAgo,
  calculateBMI, interpretBMI, escapeHtml, formatTransferStatus,
} from './utils.js';
import { countUnreadInbox, getMyInbox, acknowledgeTransfer, updateTransferStatus, sendPatientFile, getPatientTransfers, getPatientTransferHistory } from './api/transfers-api.js';
import { searchPatients, getPatient, getPatientEncounters, getPatientAllergies, getEncounter } from './api/patients-api.js';
import { recordVitals, getPatientVitals, createNote, getPatientNotes, signNote, addDiagnosis, getPatientDiagnoses } from './api/clinical-api.js';
import { supabase } from './supabase-client.js';
import { listPatientDocuments, uploadPatientDocument, createPatientDocumentUrl } from './api/documents-api.js';
import { PatientFile } from './patient-file.js';

// ─── State ────────────────────────────────────────────────────────────────────
let currentProfile = null;
let currentUser = null;
let currentView = 'overview';
let chartContext = null;   // { patient, transfer, encounterId }
let chartBackView = 'lookup';
let labFilter = 'all';
let rxFilter = 'all';

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const profile = await requireAuth();
  if (!profile) { window.location.replace('../index.html'); return; }
  if (profile.role !== 'doctor') { redirectToDashboard(profile.role, false); return; }
  currentProfile = profile;
  const { data: userData } = await supabase.auth.getUser();
  currentUser = userData?.user || { id: profile.id };
  initUI(profile);
  try {
    await Promise.all([loadOverview(), loadNotifications(), loadMedicineCatalog()]);
  } catch (err) {
    console.warn('Doctor overview load non-fatal warning:', err);
  }
}

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

  // Quick actions
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => switchView(el.dataset.nav));
  });
  document.getElementById('qa-new-lab').addEventListener('click', () => {
    switchView('laborders');
    setTimeout(() => openLabModal(), 100);
  });
  document.getElementById('qa-new-rx').addEventListener('click', () => {
    switchView('prescriptions');
    setTimeout(() => openRxModal(), 100);
  });

  // Inbox filters
  document.querySelectorAll('#inbox-filters .chip').forEach(c => {
    c.addEventListener('click', () => {
      document.querySelectorAll('#inbox-filters .chip').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      inboxFilter = c.dataset.filter;
      loadInbox();
    });
  });

  // Lab filters
  document.querySelectorAll('#lab-filters .chip').forEach(c => {
    c.addEventListener('click', () => {
      document.querySelectorAll('#lab-filters .chip').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      labFilter = c.dataset.filter;
      loadLabOrders();
    });
  });

  // Rx filters
  document.querySelectorAll('#rx-filters .chip').forEach(c => {
    c.addEventListener('click', () => {
      document.querySelectorAll('#rx-filters .chip').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      rxFilter = c.dataset.filter;
      loadPrescriptions();
    });
  });

  // Lab / Rx modal open buttons
  document.getElementById('new-lab-btn').addEventListener('click', openLabModal);
  document.getElementById('new-rx-btn').addEventListener('click', openRxModal);

  // Patient search (debounced)
  const searchInput = document.getElementById('patient-search-input');
  searchInput.addEventListener('input', debounce(() => doPatientSearch(searchInput.value), 400));

  // Chart back button
  document.getElementById('chart-back-btn').addEventListener('click', () => switchView(chartBackView));

  // Chart tabs
  document.querySelectorAll('.chart-tab').forEach(tab => {
    tab.addEventListener('click', () => activateChartTab(tab.dataset.tab));
  });

  // Chart note controls
  document.getElementById('new-note-btn').addEventListener('click', () => {
    document.getElementById('new-note-form').style.display = 'block';
    document.getElementById('note-textarea').focus();
  });
  document.getElementById('cancel-note-btn').addEventListener('click', () => {
    document.getElementById('new-note-form').style.display = 'none';
    document.getElementById('note-textarea').value = '';
  });
  document.getElementById('save-note-btn').addEventListener('click', saveNote);

  // Chart diagnosis controls
  document.getElementById('add-dx-btn').addEventListener('click', () => {
    document.getElementById('add-dx-form').style.display = 'block';
    document.getElementById('dx-name').focus();
  });
  document.getElementById('cancel-dx-btn').addEventListener('click', () => {
    document.getElementById('add-dx-form').style.display = 'none';
  });
  document.getElementById('save-dx-btn').addEventListener('click', saveDiagnosis);

  // Chart new lab / rx from patient chart
  document.getElementById('chart-new-lab-btn').addEventListener('click', () => openLabModal(chartContext?.patient?.id));
  document.getElementById('chart-new-rx-btn').addEventListener('click', () => openRxModal(chartContext?.patient?.id));
  document.getElementById('document-upload-form').addEventListener('submit', uploadChartDocument);

  // Vitals BMI auto-calc
  ['v-weight', 'v-height'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      const w = parseFloat(document.getElementById('v-weight').value);
      const h = parseFloat(document.getElementById('v-height').value);
      if (w && h) {
        const bmi = calculateBMI(w, h);
        document.getElementById('v-bmi').value = bmi ? `${bmi} (${interpretBMI(bmi)})` : '';
      } else {
        document.getElementById('v-bmi').value = '';
      }
    });
  });

  // Vitals modal
  document.getElementById('record-vitals-btn').addEventListener('click', () => openVitalsModal());
  setupModalClose('vitals-modal-overlay', 'vitals-modal-close', 'vitals-modal-cancel');
  document.getElementById('vitals-modal-save').addEventListener('click', saveVitals);

  // Lab modal
  setupModalClose('lab-modal-overlay', 'lab-modal-close', 'lab-modal-cancel');
  document.getElementById('lab-modal-save').addEventListener('click', submitLabOrder);
  document.getElementById('add-lab-item-btn').addEventListener('click', addLabItemRow);
  setupPatientSearchInModal('lab-patient-search', 'lab-patient-results', 'lab-patient-id', 'lab-patient-selected');

  // Rx modal
  setupModalClose('rx-modal-overlay', 'rx-modal-close', 'rx-modal-cancel');
  document.getElementById('rx-modal-save').addEventListener('click', submitPrescription);
  document.getElementById('add-rx-item-btn').addEventListener('click', addRxItemRow);
  setupPatientSearchInModal('rx-patient-search', 'rx-patient-results', 'rx-patient-id', 'rx-patient-selected');

  // Send file modal
  setupModalClose('send-modal-overlay', 'send-modal-close', 'send-modal-cancel');
  document.getElementById('send-modal-submit').addEventListener('click', submitSendFile);
  document.getElementById('chart-send-file-btn').addEventListener('click', openSendModal);
  document.getElementById('send-staff-search').addEventListener('input', debounce(searchStaff, 400));

  // ── Shared patient search (new workflow) ─────────────────────────────────
  const docSearchInput = document.getElementById('doc-patient-search');
  if (docSearchInput) {
    docSearchInput.addEventListener('input', debounce(() => {
      docSearchQuery = docSearchInput.value.trim();
      docSearchPage = 1;
      doDoctorPatientSearch();
    }, 400));
  }

  // Back button in patient-file view
  document.getElementById('doc-back-to-search-btn')?.addEventListener('click', () => switchView('search'));

  // Initialize shared PatientFile component
  const docFileContainer = document.getElementById('doc-patient-file-container');
  if (docFileContainer && currentUser) {
    docPatientFileComponent = new PatientFile(docFileContainer, {
      role: profile.role,
      userId: currentUser?.id,
      userName: profile.full_name,
    });
  }
}

function setupModalClose(overlayId, closeId, cancelId) {
  const close = () => document.getElementById(overlayId).classList.remove('active');
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
    console.error('Doctor sign-out failed:', err);
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
    lookup: 'Patient Lookup',
    laborders: 'Lab Orders',
    prescriptions: 'Prescriptions',
    chart: 'Patient Chart',
  };
  document.getElementById('page-title').textContent = titles[view] || 'Dashboard';

  // Lazy load on first switch
  if (view === 'laborders') loadLabOrders();
  if (view === 'prescriptions') loadPrescriptions();
}

// ─── Notifications ────────────────────────────────────────────────────────────
async function loadNotifications() {
  const count = await countUnreadInbox();
  const badge = document.getElementById('notif-count');
  const sideBadge = document.getElementById('sidebar-inbox-badge');
  const display = count > 0 ? 'flex' : 'none';
  badge.textContent = count > 99 ? '99+' : count;
  badge.style.display = display;
  if (sideBadge) {
    sideBadge.textContent = count > 99 ? '99+' : count;
    sideBadge.style.display = count > 0 ? 'inline-flex' : 'none';
  }

  // populate notif panel with inbox preview
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
      if (transfer) loadPatientChart(transfer.patient, transfer, 'inbox');
    });
  });
}

// ─── Overview ─────────────────────────────────────────────────────────────────
async function loadOverview() {
  const [inboxRes, labRes, rxRes] = await Promise.all([
    getMyInbox('active'),
    supabase.from('laboratory_orders').select('id,status', { count: 'exact' })
      .eq('ordering_doctor_id', (await supabase.auth.getUser()).data.user.id)
      .in('status', ['pending', 'in_progress']),
    supabase.from('prescriptions').select('id,status', { count: 'exact' })
      .eq('prescribing_doctor_id', (await supabase.auth.getUser()).data.user.id)
      .eq('status', 'active'),
  ]);

  const inbox = inboxRes.data || [];
  const statInbox = document.getElementById('stat-inbox');
  if (statInbox) statInbox.textContent = inbox.length;
  const statPatients = document.getElementById('stat-patients');
  if (statPatients) statPatients.textContent = new Set(inbox.map(t => t.patient?.id)).size;
  const statLabs = document.getElementById('stat-labs');
  if (statLabs) statLabs.textContent = labRes.count || 0;
  const statRx = document.getElementById('stat-rx');
  if (statRx) statRx.textContent = rxRes.count || 0;

  // Recent inbox items (if present)
  const container = document.getElementById('overview-inbox-list');
  if (container) {
    const recent = inbox.slice(0, 5);
    if (recent.length === 0) {
      container.innerHTML = '<div class="empty-state">No pending inbox items.</div>';
    } else {
      container.innerHTML = recent.map(t => renderInboxItem(t)).join('');
      bindInboxItemActions(container, recent);
    }
  }
}

// ─── Inbox ────────────────────────────────────────────────────────────────────
async function loadInbox() {
  const container = document.getElementById('inbox-list');
  container.innerHTML = '<div class="loading-state">Loading inbox...</div>';
  const { data, error } = await getMyInbox(inboxFilter);
  if (error) { container.innerHTML = `<div class="error-state">Error: ${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No inbox items.</div>';
    return;
  }
  container.innerHTML = data.map(t => renderInboxItem(t)).join('');
  bindInboxItemActions(container, data);
}

function renderInboxItem(t) {
  const patient = t.patient || {};
  const sender = t.sender || {};
  const name = `${patient.first_name || ''} ${patient.last_name || ''}`.trim() || 'Unknown';
  const statusClass = getStatusBadgeClass(t.status);
  return `
    <div class="list-item inbox-item" data-id="${t.id}" style="cursor:pointer">
      <div class="list-item-avatar">${getInitials(name)}</div>
      <div class="list-item-body">
        <div class="list-item-title">${escapeHtml(name)} <span class="text-muted" style="font-weight:400">· ${escapeHtml(patient.hospital_number || '')}</span></div>
        <div class="list-item-meta">From: ${escapeHtml(sender.full_name || '—')} (${escapeHtml(sender.department || t.from_department || '')})</div>
        ${t.reason ? `<div class="list-item-note">${escapeHtml(t.reason)}</div>` : ''}
      </div>
      <div class="list-item-aside">
        <span class="badge ${statusClass}">${formatTransferStatus(t.status)}</span>
        <span class="text-muted" style="font-size:.75rem">${timeAgo(t.created_at)}</span>
        <div class="item-actions" style="margin-top:.4rem">
          ${t.status === 'sent' ? `<button class="btn btn-warning btn-xs ack-btn" data-id="${t.id}">Acknowledge</button>` : ''}
          ${renderStatusActions(t)}
        </div>
      </div>
    </div>
  `;
}

function renderStatusActions(t) {
  const opts = [];
  if (['received', 'sent'].includes(t.status)) opts.push({ label: 'In Progress', value: 'in_progress' });
  if (t.status === 'in_progress') opts.push({ label: 'Awaiting Results', value: 'awaiting_results' });
  if (['in_progress', 'awaiting_results'].includes(t.status)) {
    opts.push({ label: 'Awaiting Pharmacy', value: 'awaiting_pharmacy' });
    opts.push({ label: 'Complete', value: 'completed' });
    opts.push({ label: 'Return', value: 'returned' });
  }
  if (opts.length === 0) return '';
  return `<select class="status-select form-control form-control-xs" data-id="${t.id}">
    <option value="">Update status...</option>
    ${opts.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
  </select>`;
}

function bindInboxItemActions(container, data) {
  container.querySelectorAll('.inbox-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.ack-btn') || e.target.closest('.status-select')) return;
      const transfer = data.find(t => t.id === item.dataset.id);
      if (transfer) loadPatientChart(transfer.patient, transfer, 'inbox');
    });
  });
  container.querySelectorAll('.ack-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      btn.disabled = true;
      const { error } = await acknowledgeTransfer(btn.dataset.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Transfer acknowledged', 'success'); loadInbox(); loadNotifications(); }
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

// ─── Patient Chart ────────────────────────────────────────────────────────────

// ─── Patient Access & Catalog Helpers ──────────────────────────────────────────

let availableMedicines = [];

async function loadMedicineCatalog() {
  try {
    const { data, error } = await supabase
      .from('medicine_catalog')
      .select('id, generic_name, brand_name, dosage_form, strength, current_stock')
      .eq('is_active', true)
      .order('generic_name');

    if (error) {
      console.warn('Could not query medicine_catalog:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
      return;
    }

    if (data) {
      availableMedicines = data;
      let datalist = document.getElementById('meds-catalog-list');
      if (!datalist) {
        datalist = document.createElement('datalist');
        datalist.id = 'meds-catalog-list';
        document.body.appendChild(datalist);
      }
      datalist.innerHTML = data.map(m => {
        const display = m.brand_name ? `${m.generic_name} (${m.brand_name})` : m.generic_name;
        return `<option value="${escapeHtml(display)}" data-id="${m.id}" data-strength="${escapeHtml(m.strength || '')}">`;
      }).join('');
    }
  } catch (err) {
    console.warn('Error loading medicine catalog:', err);
  }
}

async function resolveMedicineId(name) {
  if (!name) return null;
  const trimmed = name.trim();

  // If already a valid UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed;
  }

  const lower = trimmed.toLowerCase();

  // Check loaded cache
  if (availableMedicines.length > 0) {
    const exact = availableMedicines.find(m =>
      (m.generic_name && m.generic_name.toLowerCase() === lower) ||
      (m.brand_name && m.brand_name.toLowerCase() === lower) ||
      `${m.generic_name} (${m.brand_name || ''})`.toLowerCase().trim() === lower
    );
    if (exact) return exact.id;

    const partial = availableMedicines.find(m =>
      (m.generic_name && lower.includes(m.generic_name.toLowerCase())) ||
      (m.brand_name && lower.includes(m.brand_name.toLowerCase())) ||
      (m.generic_name && m.generic_name.toLowerCase().includes(lower))
    );
    if (partial) return partial.id;
  }

  // Query Supabase directly
  try {
    const { data: matches } = await supabase
      .from('medicine_catalog')
      .select('id, generic_name, brand_name')
      .or(`generic_name.ilike.%${trimmed}%,brand_name.ilike.%${trimmed}%`)
      .limit(1);

    if (matches && matches.length > 0) {
      return matches[0].id;
    }

    // Fallback: if there are any active medicines in the catalog, return the first one
    const { data: anyMeds } = await supabase
      .from('medicine_catalog')
      .select('id')
      .limit(1);

    if (anyMeds && anyMeds.length > 0) {
      return anyMeds[0].id;
    }
  } catch (err) {
    console.warn('Error resolving medicine ID:', err);
  }

  return null;
}

/**
 * Ensures the doctor has an active encounter with the patient.
 * Required so that can_access_patient(patient_id) evaluates to true for RLS.
 * @param {string} patientId
 * @returns {Promise<string|null>} The encounter ID
 */
async function ensureDoctorPatientEncounter(patientId) {
  if (!patientId) return null;

  try {
    const { data: userRes } = await supabase.auth.getUser();
    const userId = userRes?.user?.id;
    if (!userId) return null;

    // Check if there is already an open/in_progress encounter for this patient
    const { data: encounters, error: searchErr } = await supabase
      .from('patient_encounters')
      .select('id, status, opened_by')
      .eq('patient_id', patientId)
      .in('status', ['open', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (searchErr) {
      console.warn('Could not query existing encounters:', {
        code: searchErr.code,
        message: searchErr.message,
        details: searchErr.details,
        hint: searchErr.hint,
      });
    }

    if (encounters && encounters.length > 0) {
      return encounters[0].id;
    }

    // If no active encounter exists, create one with opened_by = auth.uid()
    const { data: newEnc, error: insertErr } = await supabase
      .from('patient_encounters')
      .insert([{
        patient_id: patientId,
        department: currentProfile?.department || 'General Outpatient',
        opened_by: userId,
        status: 'open',
        chief_complaint: 'Clinical Consultation',
      }])
      .select('id')
      .single();

    if (insertErr) {
      console.error('Failed to create encounter for patient access:', {
        code: insertErr.code,
        message: insertErr.message,
        details: insertErr.details,
        hint: insertErr.hint,
      });
      return null;
    }

    return newEnc?.id || null;
  } catch (err) {
    console.error('Unexpected error ensuring doctor patient encounter:', err);
    return null;
  }
}

async function loadPatientChart(patient, transfer, fromView = 'lookup') {
  chartBackView = fromView;
  let encounterId = transfer?.encounter_id;
  if (!encounterId && patient?.id) {
    encounterId = await ensureDoctorPatientEncounter(patient.id);
  }
  chartContext = { patient, transfer, encounterId: encounterId || null };
  switchView('chart');
  activateChartTab('summary');

  // Patient banner
  const name = `${patient.first_name || ''} ${patient.middle_name ? patient.middle_name + ' ' : ''}${patient.last_name || ''}`.trim();
  document.getElementById('banner-avatar').textContent = getInitials(name);
  document.getElementById('banner-name').textContent = name;
  document.getElementById('banner-hn').textContent = `HN: ${patient.hospital_number || '—'}`;
  document.getElementById('banner-dob').textContent = patient.date_of_birth
    ? `DOB: ${formatDate(patient.date_of_birth, 'short')} (${calculateAge(patient.date_of_birth)})`
    : '—';
  document.getElementById('banner-sex').textContent = patient.sex || '—';

  if (transfer) {
    document.getElementById('banner-transfer-info').innerHTML = `
      <span class="badge ${getStatusBadgeClass(transfer.status)}">${formatTransferStatus(transfer.status)}</span>
      <div style="font-size:.8rem;margin-top:.3rem">From: ${escapeHtml(transfer.sender?.full_name || '—')}</div>
    `;
  }

  // Allergies
  const allergyEl = document.getElementById('banner-allergies');
  const { data: allergies } = await getPatientAllergies(patient.id);
  if (allergies && allergies.length > 0) {
    document.getElementById('banner-allergy-list').textContent = allergies.map(a => a.allergen).join(', ');
    allergyEl.style.display = 'flex';
  } else {
    allergyEl.style.display = 'none';
  }

  // Load summary data
  loadChartSummary(patient);
}

function activateChartTab(tab) {
  document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.chart-panel').forEach(p => p.style.display = 'none');
  const activeTab = document.querySelector(`.chart-tab[data-tab="${tab}"]`);
  if (activeTab) activeTab.classList.add('active');
  const panel = document.getElementById(`chart-${tab}`);
  if (panel) panel.style.display = 'block';

  // Lazy load on first switch
  const patient = chartContext?.patient;
  const encounterId = chartContext?.encounterId;
  if (!patient) return;

  if (tab === 'vitals') loadChartVitals(patient.id, encounterId);
  if (tab === 'notes') loadChartNotes(patient.id, encounterId);
  if (tab === 'diagnoses') loadChartDiagnoses(patient.id, encounterId);
  if (tab === 'laborders') loadChartLabOrders(patient.id);
  if (tab === 'prescriptions') loadChartPrescriptions(patient.id);
  if (tab === 'transfers') loadChartTransfers(patient.id);
  if (tab === 'documents') loadChartDocuments(patient.id);
}

async function loadChartDocuments(patientId) {
  const container = document.getElementById('documents-list');
  container.innerHTML = '<div class="loading-state">Loading documents...</div>';
  const { data, error } = await listPatientDocuments(patientId);
  if (error) {
    container.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!data?.length) {
    container.innerHTML = '<div class="empty-state">No clinical documents have been uploaded.</div>';
    return;
  }
  container.innerHTML = data.map(document => `
    <div class="list-item">
      <div class="list-item-body">
        <div class="list-item-title">${escapeHtml(document.original_filename)}</div>
        <div class="list-item-meta">${escapeHtml(document.category.replace(/_/g, ' '))} · ${formatDate(document.created_at, 'datetime')} · ${Math.ceil(document.file_size / 1024)} KB</div>
        ${document.description ? `<div class="list-item-note">${escapeHtml(document.description)}</div>` : ''}
      </div>
      <div class="list-item-aside">
        <button class="btn btn-ghost btn-sm document-open-btn" data-path="${escapeHtml(document.storage_path)}">Open</button>
      </div>
    </div>
  `).join('');
  container.querySelectorAll('.document-open-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const openedWindow = window.open('about:blank', '_blank');
      if (!openedWindow) {
        showToast('Allow pop-ups to open this document.', 'warning');
        return;
      }
      openedWindow.opener = null;
      button.disabled = true;
      const { data: linkData, error: linkError } = await createPatientDocumentUrl(button.dataset.path);
      button.disabled = false;
      if (linkError) {
        openedWindow.close();
        showToast(linkError.message, 'error');
        return;
      }
      openedWindow.location.href = linkData.signedUrl;
    });
  });
}

async function uploadChartDocument(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const file = document.getElementById('document-file').files[0];
  if (!chartContext?.patient || !file) {
    showToast('Choose a patient and document before uploading.', 'warning');
    return;
  }
  const button = document.getElementById('document-upload-btn');
  button.disabled = true;
  try {
    const { error } = await uploadPatientDocument(file, {
      patientId: chartContext.patient.id,
      encounterId: chartContext.encounterId,
      category: document.getElementById('document-category').value,
      description: document.getElementById('document-description').value,
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    form.reset();
    showToast('Clinical document uploaded.', 'success');
    loadChartDocuments(chartContext.patient.id);
  } catch (err) {
    console.error('Clinical document upload failed:', err);
    showToast('Unable to upload the clinical document. Please try again.', 'error');
  } finally {
    button.disabled = false;
  }
}

async function loadChartSummary(patient) {
  const fields = [
    ['Hospital Number', patient.hospital_number],
    ['First Name', patient.first_name],
    ['Middle Name', patient.middle_name],
    ['Last Name', patient.last_name],
    ['Date of Birth', formatDate(patient.date_of_birth, 'short')],
    ['Age', calculateAge(patient.date_of_birth)],
    ['Sex', patient.sex],
    ['Phone', patient.phone],
    ['Email', patient.email],
    ['Address', patient.address],
    ['State', patient.state],
    ['LGA', patient.lga],
    ['Nationality', patient.nationality],
    ['Occupation', patient.occupation],
    ['Marital Status', patient.marital_status],
    ['Religion', patient.religion],
    ['Blood Group', patient.blood_group],
    ['Genotype', patient.genotype],
    ['Next of Kin', patient.next_of_kin || patient.next_of_kin_name],
    ['NOK Phone', patient.next_of_kin_phone],
    ['NOK Relationship', patient.next_of_kin_relationship],
    ['Registered', formatDate(patient.created_at, 'datetime')],
  ];
  const grid = document.getElementById('demographics-grid');
  grid.innerHTML = fields.filter(([, v]) => v).map(([label, val]) => `
    <div class="demo-field">
      <div class="demo-field-label">${escapeHtml(label)}</div>
      <div class="demo-field-value">${escapeHtml(String(val || '—'))}</div>
    </div>
  `).join('');

  // Load Latest Vitals in Summary
  const summaryVitalsEl = document.getElementById('summary-latest-vitals');
  if (summaryVitalsEl) {
    summaryVitalsEl.innerHTML = '<div class="loading-state">Loading latest vitals...</div>';
    const { data: vitalsData, error: vitalsError } = await getPatientVitals(patient.id, null);
    if (vitalsError) {
      summaryVitalsEl.innerHTML = `<div class="error-state" style="padding:.75rem;font-size:.85rem;color:var(--text-danger)">Unable to load vitals: ${escapeHtml(vitalsError.message || 'Check permissions')}</div>`;
    } else if (!vitalsData || vitalsData.length === 0) {
      summaryVitalsEl.innerHTML = '<div class="empty-state" style="padding:1rem">No vitals recorded yet.</div>';
    } else {
      const v = vitalsData[0];
      const bpSys = v.blood_pressure_systolic ?? v.bp_systolic;
      const bpDia = v.blood_pressure_diastolic ?? v.bp_diastolic;
      const bpVal = (bpSys && bpDia) ? `${bpSys}/${bpDia}` : null;
      const tempVal = v.temperature_c ?? v.temperature;
      const spo2Val = v.sp_o2 ?? v.oxygen_saturation ?? v.spo2;
      const wtVal = v.weight_kg ?? v.weight;
      const notesVal = v.clinical_notes ?? v.notes;
      summaryVitalsEl.innerHTML = `
        <div style="padding:0.75rem 1rem;">
          <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.75rem;">
            Recorded ${formatDate(v.created_at, 'datetime')} by ${escapeHtml(v.recorded_by_profile?.full_name || 'Nurse/Staff')}${v.recorded_by_profile?.role ? ` (${escapeHtml(v.recorded_by_profile.role)})` : ''}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:0.75rem;">
            ${bpVal ? `<div class="vital-card" style="padding:.5rem .75rem"><div class="vital-card-label">BP</div><div class="vital-card-value">${escapeHtml(bpVal)} <small style="font-size:.7rem">mmHg</small></div></div>` : ''}
            ${v.pulse_rate ? `<div class="vital-card" style="padding:.5rem .75rem"><div class="vital-card-label">Pulse</div><div class="vital-card-value">${escapeHtml(String(v.pulse_rate))} <small style="font-size:.7rem">bpm</small></div></div>` : ''}
            ${tempVal ? `<div class="vital-card" style="padding:.5rem .75rem"><div class="vital-card-label">Temp</div><div class="vital-card-value">${escapeHtml(String(tempVal))} <small style="font-size:.7rem">°C</small></div></div>` : ''}
            ${spo2Val ? `<div class="vital-card" style="padding:.5rem .75rem"><div class="vital-card-label">SpO₂</div><div class="vital-card-value">${escapeHtml(String(spo2Val))} <small style="font-size:.7rem">%</small></div></div>` : ''}
            ${v.respiratory_rate ? `<div class="vital-card" style="padding:.5rem .75rem"><div class="vital-card-label">Resp</div><div class="vital-card-value">${escapeHtml(String(v.respiratory_rate))} <small style="font-size:.7rem">/min</small></div></div>` : ''}
            ${wtVal ? `<div class="vital-card" style="padding:.5rem .75rem"><div class="vital-card-label">Weight</div><div class="vital-card-value">${escapeHtml(String(wtVal))} <small style="font-size:.7rem">kg</small></div></div>` : ''}
            ${v.bmi ? `<div class="vital-card" style="padding:.5rem .75rem"><div class="vital-card-label">BMI</div><div class="vital-card-value">${escapeHtml(String(v.bmi))}</div></div>` : ''}
          </div>
          ${notesVal ? `<div style="margin-top:0.75rem;padding:0.5rem 0.75rem;background:var(--bg-subtle, #f8f9fa);border-radius:4px;font-size:0.85rem;"><strong>Notes:</strong> ${escapeHtml(notesVal)}</div>` : ''}
        </div>
      `;
    }
  }

  // Bind view all vitals button
  const viewAllVitalsBtn = document.getElementById('summary-view-all-vitals-btn');
  if (viewAllVitalsBtn) {
    viewAllVitalsBtn.onclick = () => activateChartTab('vitals');
  }

  // Encounter history
  const { data: encounters } = await getPatientEncounters(patient.id);
  const histEl = document.getElementById('encounter-history-list');
  if (histEl) {
    if (!encounters || encounters.length === 0) {
      histEl.innerHTML = '<div class="empty-state">No encounters recorded.</div>';
    } else {
      histEl.innerHTML = encounters.map(enc => `
        <div class="list-item">
          <div class="list-item-body">
            <div class="list-item-title">${escapeHtml(enc.department || enc.encounter_number || 'Encounter')}</div>
            <div class="list-item-meta">${formatDate(enc.created_at, 'datetime')} · Opened by: ${escapeHtml(enc.opened_by_profile?.full_name || '—')}</div>
            ${enc.chief_complaint ? `<div class="list-item-note">CC: ${escapeHtml(enc.chief_complaint)}</div>` : ''}
          </div>
          <div class="list-item-aside">
            <span class="badge ${getStatusBadgeClass(enc.status)}">${escapeHtml(enc.status || '')}</span>
          </div>
        </div>
      `).join('');
    }
  }
}

async function loadChartVitals(patientId, encounterId) {
  const container = document.getElementById('vitals-grid');
  if (!container) return;
  container.innerHTML = '<div class="loading-state">Loading vitals...</div>';
  // Load ALL vitals for the patient so nursing recordings always appear
  const { data, error } = await getPatientVitals(patientId, null);
  if (error) {
    container.innerHTML = `<div class="error-state" style="padding:1rem;color:var(--text-danger)">Error loading vitals: ${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No vitals recorded yet.</div>';
    return;
  }
  const v = data[0];
  const bpSys = v.blood_pressure_systolic ?? v.bp_systolic;
  const bpDia = v.blood_pressure_diastolic ?? v.bp_diastolic;
  const tempVal = v.temperature_c ?? v.temperature;
  const spo2Val = v.sp_o2 ?? v.oxygen_saturation ?? v.spo2;
  const wtVal = v.weight_kg ?? v.weight;
  const htVal = v.height_cm ?? v.height;
  const notesVal = v.clinical_notes ?? v.notes;

  const cards = [
    { label: 'Blood Pressure', value: (bpSys && bpDia) ? `${bpSys}/${bpDia} mmHg` : '—', icon: '🫀' },
    { label: 'Pulse Rate', value: v.pulse_rate ? `${v.pulse_rate} bpm` : '—', icon: '💓' },
    { label: 'Resp. Rate', value: v.respiratory_rate ? `${v.respiratory_rate} /min` : '—', icon: '🫁' },
    { label: 'Temperature', value: tempVal ? `${tempVal} °C` : '—', icon: '🌡️' },
    { label: 'SpO₂', value: spo2Val ? `${spo2Val}%` : '—', icon: '🩺' },
    { label: 'Weight', value: wtVal ? `${wtVal} kg` : '—', icon: '⚖️' },
    { label: 'Height', value: htVal ? `${htVal} cm` : '—', icon: '📏' },
    { label: 'BMI', value: v.bmi ? `${v.bmi} (${interpretBMI(v.bmi)})` : '—', icon: '📊' },
  ];
  let html = `
    <div style="margin-bottom:.5rem;font-size:.8rem;color:var(--text-muted)">
      Last recorded: ${formatDate(v.created_at, 'datetime')} by ${escapeHtml(v.recorded_by_profile?.full_name || 'Staff')}${v.recorded_by_profile?.role ? ` (${escapeHtml(v.recorded_by_profile.role)})` : ''}
    </div>
    <div class="vitals-cards-grid">
      ${cards.map(c => `
        <div class="vital-card">
          <div class="vital-card-icon">${c.icon}</div>
          <div class="vital-card-label">${c.label}</div>
          <div class="vital-card-value">${escapeHtml(String(c.value))}</div>
        </div>
      `).join('')}
    </div>
    ${notesVal ? `<div style="margin-top:1rem;padding:.75rem 1rem;background:var(--bg-subtle,#f8f9fa);border-radius:6px;font-size:.875rem;"><strong>Clinical Notes on Vitals:</strong> ${escapeHtml(notesVal)}</div>` : ''}
  `;

  if (data.length > 1) {
    html += `
      <div style="margin-top:1.5rem;">
        <h4 style="font-size:.95rem;margin-bottom:.75rem;">Vitals History (${data.length} records)</h4>
        <div class="table-responsive" style="overflow-x:auto;">
          <table class="data-table" style="width:100%;font-size:.825rem;border-collapse:collapse;">
            <thead>
              <tr style="border-bottom:1px solid var(--border-color,#e5e7eb);text-align:left;">
                <th style="padding:.5rem">Date & Time</th>
                <th style="padding:.5rem">BP</th>
                <th style="padding:.5rem">Pulse</th>
                <th style="padding:.5rem">Temp</th>
                <th style="padding:.5rem">SpO₂</th>
                <th style="padding:.5rem">Resp</th>
                <th style="padding:.5rem">Weight</th>
                <th style="padding:.5rem">Recorded By</th>
              </tr>
            </thead>
            <tbody>
              ${data.map(rec => {
                const s = rec.sp_o2 ?? rec.oxygen_saturation ?? rec.spo2;
                const recBpSys = rec.blood_pressure_systolic ?? rec.bp_systolic;
                const recBpDia = rec.blood_pressure_diastolic ?? rec.bp_diastolic;
                const recTemp = rec.temperature_c ?? rec.temperature;
                const recWt = rec.weight_kg ?? rec.weight;
                return `
                  <tr style="border-bottom:1px solid var(--border-color,#f1f5f9);">
                    <td style="padding:.5rem">${formatDate(rec.created_at, 'datetime')}</td>
                    <td style="padding:.5rem">${(recBpSys && recBpDia) ? `${recBpSys}/${recBpDia}` : '—'}</td>
                    <td style="padding:.5rem">${rec.pulse_rate ? `${rec.pulse_rate} bpm` : '—'}</td>
                    <td style="padding:.5rem">${recTemp ? `${recTemp}°C` : '—'}</td>
                    <td style="padding:.5rem">${s ? `${s}%` : '—'}</td>
                    <td style="padding:.5rem">${rec.respiratory_rate ? `${rec.respiratory_rate}` : '—'}</td>
                    <td style="padding:.5rem">${recWt ? `${recWt} kg` : '—'}</td>
                    <td style="padding:.5rem">${escapeHtml(rec.recorded_by_profile?.full_name || '—')}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }
  container.innerHTML = html;
}

async function loadChartNotes(patientId, encounterId) {
  const container = document.getElementById('notes-list');
  container.innerHTML = '<div class="loading-state">Loading notes...</div>';
  const { data, error } = await getPatientNotes(patientId, encounterId, 'clinical');
  if (error) { container.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No clinical notes yet.</div>';
    return;
  }
  container.innerHTML = data.map(n => `
    <div class="note-card">
      <div class="note-card-header">
        <span class="note-author">${escapeHtml(n.author_profile?.full_name || '—')}</span>
        <span class="text-muted" style="font-size:.78rem">${timeAgo(n.created_at)}</span>
        ${n.is_signed
          ? `<span class="badge badge-success">✅ Signed by ${escapeHtml(n.signed_by_profile?.full_name || '—')}</span>`
          : `<span class="badge badge-warning">Draft</span>`}
      </div>
      <div class="note-card-body">${escapeHtml(n.content || '')}</div>
      ${!n.is_signed && n.author_profile?.id === currentProfile.id ? `
        <div class="note-card-footer">
          <button class="btn btn-ghost btn-xs sign-note-btn" data-note-id="${n.id}">✍️ Sign Note</button>
        </div>
      ` : ''}
    </div>
  `).join('');
  container.querySelectorAll('.sign-note-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const { error } = await signNote(btn.dataset.noteId);
      if (error) { showToast(error.message, 'error'); btn.disabled = false; }
      else { showToast('Note signed', 'success'); loadChartNotes(patientId, encounterId); }
    });
  });
}

async function saveNote() {
  const content = document.getElementById('note-textarea').value.trim();
  if (!content) { showToast('Please enter note content', 'warning'); return; }
  const { patient, encounterId } = chartContext;
  const { data: user } = await supabase.auth.getUser();
  const shouldSign = document.getElementById('note-sign-check').checked;

  const { data, error } = await createNote({
    patient_id: patient.id,
    encounter_id: encounterId || null,
    note_type: 'clinical',
    raw_note: content,
    content,
    author_id: user.user.id,
    author: user.user.id,
  });

  if (error) { showToast(error.message, 'error'); return; }
  showToast('Note saved', 'success');
  document.getElementById('new-note-form').style.display = 'none';
  document.getElementById('note-textarea').value = '';
  document.getElementById('note-sign-check').checked = false;
  loadChartNotes(patient.id, encounterId);
}

async function loadChartDiagnoses(patientId, encounterId) {
  const container = document.getElementById('diagnoses-list');
  container.innerHTML = '<div class="loading-state">Loading...</div>';
  const { data, error } = await getPatientDiagnoses(patientId, encounterId);
  if (error) { container.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No diagnoses recorded.</div>';
    return;
  }
  container.innerHTML = data.map(d => `
    <div class="list-item">
      <div class="list-item-body">
        <div class="list-item-title">${d.icd_code ? `<span class="badge badge-info">${escapeHtml(d.icd_code)}</span> ` : ''}${escapeHtml(d.diagnosis_name || '')}</div>
        ${d.notes ? `<div class="list-item-note">${escapeHtml(d.notes)}</div>` : ''}
        <div class="list-item-meta">By: ${escapeHtml(d.diagnosed_by_profile?.full_name || d.recorded_by_profile?.full_name || '—')} · ${timeAgo(d.created_at)}</div>
      </div>
    </div>
  `).join('');
}

async function saveDiagnosis() {
  const name = document.getElementById('dx-name').value.trim();
  if (!name) { showToast('Please enter diagnosis name', 'warning'); return; }
  const { patient, encounterId } = chartContext;
  const { data: user } = await supabase.auth.getUser();

  const { error } = await addDiagnosis({
    patient_id: patient.id,
    encounter_id: encounterId || null,
    icd10_code: document.getElementById('dx-icd').value.trim() || null,
    diagnosis_name: name,
    notes: document.getElementById('dx-notes').value.trim() || null,
    diagnosed_by: user.user.id,
    recorded_by: user.user.id,
  });

  if (error) { showToast(error.message, 'error'); return; }
  showToast('Diagnosis saved', 'success');
  document.getElementById('add-dx-form').style.display = 'none';
  document.getElementById('dx-icd').value = '';
  document.getElementById('dx-name').value = '';
  document.getElementById('dx-notes').value = '';
  loadChartDiagnoses(patient.id, encounterId);
}

async function loadChartLabOrders(patientId) {
  const container = document.getElementById('chart-laborders-list');
  container.innerHTML = '<div class="loading-state">Loading...</div>';
  const { data, error } = await supabase.from('laboratory_orders')
    .select(`*, laboratory_order_items(*), patient:patients(hospital_number,first_name,last_name)`)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });
  if (error) { container.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) { container.innerHTML = '<div class="empty-state">No lab orders for this patient.</div>'; return; }
  container.innerHTML = data.map(o => renderLabOrderCard(o)).join('');
}

async function loadChartPrescriptions(patientId) {
  const container = document.getElementById('chart-prescriptions-list');
  container.innerHTML = '<div class="loading-state">Loading...</div>';
  const { data, error } = await supabase.from('prescriptions')
    .select(`*, prescription_items(*)`)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });
  if (error) { container.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) { container.innerHTML = '<div class="empty-state">No prescriptions for this patient.</div>'; return; }
  container.innerHTML = data.map(rx => renderRxCard(rx)).join('');
}

async function loadChartTransfers(patientId) {
  const container = document.getElementById('transfers-timeline');
  container.innerHTML = '<div class="loading-state">Loading...</div>';
  const { data, error } = await getPatientTransfers(patientId);
  if (error) { container.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) { container.innerHTML = '<div class="empty-state">No transfer history.</div>'; return; }
  container.innerHTML = `<div class="timeline">
    ${data.map(t => `
      <div class="timeline-item">
        <div class="timeline-dot ${getStatusBadgeClass(t.status)}"></div>
        <div class="timeline-content">
          <div class="timeline-title">${escapeHtml(t.from_department || '—')} → ${escapeHtml(t.to_department || '—')}</div>
          <div class="timeline-meta">
            ${escapeHtml(t.sender?.full_name || '—')} → ${escapeHtml(t.recipient?.full_name || '—')}
            <span class="badge ${getStatusBadgeClass(t.status)}" style="margin-left:.5rem">${formatTransferStatus(t.status)}</span>
          </div>
          <div class="timeline-time">${formatDate(t.created_at, 'datetime')}</div>
          ${t.reason ? `<div class="timeline-note">${escapeHtml(t.reason)}</div>` : ''}
        </div>
      </div>
    `).join('')}
  </div>`;
}

// ─── Patient Lookup ───────────────────────────────────────────────────────────
async function doPatientSearch(query) {
  const container = document.getElementById('patient-lookup-results');
  if (!query.trim()) {
    container.innerHTML = '<div class="empty-state">Enter a name or hospital number to search.</div>';
    return;
  }
  container.innerHTML = '<div class="loading-state">Searching...</div>';
  const { data, error } = await searchPatients(query);
  if (error) { container.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) { container.innerHTML = '<div class="empty-state">No patients found.</div>'; return; }
  container.innerHTML = data.map(p => `
    <div class="list-item patient-card" data-pid="${p.id}" style="cursor:pointer">
      <div class="list-item-avatar">${getInitials(`${p.first_name} ${p.last_name}`)}</div>
      <div class="list-item-body">
        <div class="list-item-title">${escapeHtml(p.first_name)} ${escapeHtml(p.middle_name || '')} ${escapeHtml(p.last_name)}</div>
        <div class="list-item-meta">HN: ${escapeHtml(p.hospital_number)} · ${calculateAge(p.date_of_birth)} · ${escapeHtml(p.sex || '')}</div>
      </div>
    </div>
  `).join('');
  container.querySelectorAll('.patient-card').forEach(card => {
    card.addEventListener('click', async () => {
      const { data: full } = await getPatient(card.dataset.pid);
      if (full) loadPatientChart(full, null, 'lookup');
    });
  });
}

// ─── My Patients ──────────────────────────────────────────────────────────────
async function loadMyPatients() {
  const container = document.getElementById('mypatients-list');
  container.innerHTML = '<div class="loading-state">Loading...</div>';
  const { data, error } = await getMyInbox('active');
  if (error) { container.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) { container.innerHTML = '<div class="empty-state">No active patients.</div>'; return; }
  // Deduplicate by patient
  const seen = new Set();
  const unique = data.filter(t => {
    if (!t.patient?.id || seen.has(t.patient.id)) return false;
    seen.add(t.patient.id);
    return true;
  });
  container.innerHTML = unique.map(t => {
    const p = t.patient;
    const name = `${p.first_name || ''} ${p.last_name || ''}`.trim();
    return `
      <div class="list-item" data-id="${t.id}" style="cursor:pointer">
        <div class="list-item-avatar">${getInitials(name)}</div>
        <div class="list-item-body">
          <div class="list-item-title">${escapeHtml(name)}</div>
          <div class="list-item-meta">HN: ${escapeHtml(p.hospital_number || '')} · ${calculateAge(p.date_of_birth)}</div>
        </div>
        <div class="list-item-aside">
          <span class="badge ${getStatusBadgeClass(t.status)}">${formatTransferStatus(t.status)}</span>
        </div>
      </div>
    `;
  }).join('');
  container.querySelectorAll('.list-item[data-id]').forEach(item => {
    item.addEventListener('click', () => {
      const transfer = data.find(t => t.id === item.dataset.id);
      if (transfer) loadPatientChart(transfer.patient, transfer, 'mypatients');
    });
  });
}

// ─── Lab Orders ───────────────────────────────────────────────────────────────
async function loadLabOrders() {
  const container = document.getElementById('laborders-list');
  container.innerHTML = '<div class="loading-state">Loading...</div>';
  const { data: user } = await supabase.auth.getUser();
  let query = supabase.from('laboratory_orders')
    .select(`*, laboratory_order_items(*), patient:patients(hospital_number,first_name,last_name)`)
    .eq('ordering_doctor_id', user.user.id)
    .order('created_at', { ascending: false });
  if (labFilter !== 'all') query = query.eq('status', labFilter);
  const { data, error } = await query;
  if (error) { container.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) { container.innerHTML = '<div class="empty-state">No lab orders.</div>'; return; }
  container.innerHTML = data.map(o => renderLabOrderCard(o)).join('');
}

function renderLabOrderCard(o) {
  const patient = o.patient || {};
  const items = o.laboratory_order_items || [];
  return `
    <div class="list-item">
      <div class="list-item-body">
        <div class="list-item-title">
          Order #${escapeHtml(o.order_number || o.id.slice(0, 8))} —
          ${escapeHtml(patient.first_name || '')} ${escapeHtml(patient.last_name || '')}
          <span class="badge badge-${o.priority === 'stat' ? 'danger' : o.priority === 'urgent' ? 'warning' : 'info'}" style="margin-left:.5rem">${escapeHtml(o.priority || 'routine')}</span>
        </div>
        <div class="list-item-meta">HN: ${escapeHtml(patient.hospital_number || '—')} · ${formatDate(o.created_at, 'datetime')}</div>
        <div style="margin-top:.35rem;font-size:.82rem">
          Tests: ${items.map(i => escapeHtml(i.test_name)).join(', ') || '—'}
        </div>
        ${o.clinical_indication ? `<div class="list-item-note">${escapeHtml(o.clinical_indication)}</div>` : ''}
      </div>
      <div class="list-item-aside">
        <span class="badge ${getStatusBadgeClass(o.status)}">${escapeHtml(o.status || '')}</span>
      </div>
    </div>
  `;
}

function openLabModal(presetPatientId) {
  document.getElementById('lab-items-container').innerHTML = '';
  document.getElementById('lab-indication').value = '';
  document.getElementById('lab-patient-id').value = '';
  document.getElementById('lab-patient-selected').style.display = 'none';
  document.getElementById('lab-patient-search').value = '';
  document.getElementById('lab-patient-results').style.display = 'none';
  addLabItemRow();
  if (presetPatientId && chartContext?.patient) {
    const p = chartContext.patient;
    document.getElementById('lab-patient-id').value = p.id;
    const chip = document.getElementById('lab-patient-selected');
    chip.textContent = `${p.first_name} ${p.last_name} (${p.hospital_number})`;
    chip.style.display = 'block';
    document.getElementById('lab-patient-search').disabled = true;
  }
  document.getElementById('lab-modal-overlay').classList.add('active');
}

function addLabItemRow() {
  const container = document.getElementById('lab-items-container');
  const row = document.createElement('div');
  row.className = 'form-row lab-item-row';
  row.innerHTML = `
    <div class="form-group" style="flex:2">
      <input type="text" class="form-control" placeholder="Test name *" data-field="test_name"/>
    </div>
    <div class="form-group">
      <input type="text" class="form-control" placeholder="Test code" data-field="test_code"/>
    </div>
    <button class="btn btn-ghost btn-xs remove-row-btn" style="align-self:center">✕</button>
  `;
  row.querySelector('.remove-row-btn').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

async function submitLabOrder() {
  const patientId = document.getElementById('lab-patient-id').value;
  if (!patientId) { showToast('Please select a patient', 'warning'); return; }
  const indication = document.getElementById('lab-indication').value.trim();
  if (!indication) { showToast('Please enter clinical indication', 'warning'); return; }

  const rows = document.querySelectorAll('.lab-item-row');
  const items = [];
  let valid = true;
  rows.forEach(row => {
    const name = row.querySelector('[data-field="test_name"]').value.trim();
    if (!name) { valid = false; return; }
    items.push({
      test_name: name,
      test_code: row.querySelector('[data-field="test_code"]').value.trim() || null
    });
  });
  if (!valid || items.length === 0) { showToast('Please add at least one valid test item', 'warning'); return; }

  const btn = document.getElementById('lab-modal-save');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    const { data: userRes } = await supabase.auth.getUser();
    const userId = userRes?.user?.id;
    if (!userId) {
      showToast('You must be logged in to order laboratory tests.', 'error');
      btn.disabled = false;
      btn.textContent = 'Submit Order';
      return;
    }

    // Ensure active encounter so can_access_patient(patient_id) is satisfied
    let encounterId = chartContext?.encounterId;
    if (!encounterId) {
      encounterId = await ensureDoctorPatientEncounter(patientId);
      if (chartContext && chartContext.patient?.id === patientId) {
        chartContext.encounterId = encounterId;
      }
    }

    const { data: order, error } = await supabase.from('laboratory_orders').insert([{
      patient_id: patientId,
      encounter_id: encounterId || null,
      ordering_doctor_id: userId,
      clinical_indication: indication,
      priority: document.getElementById('lab-priority').value || 'routine',
      status: 'pending',
    }]).select().single();

    if (error) {
      console.error('Failed to create laboratory order:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
      showToast(error.message || 'Failed to create laboratory order', 'error');
      btn.disabled = false;
      btn.textContent = 'Submit Order';
      return;
    }

    // laboratory_order_items columns: id, order_id, test_name, test_category, instructions, created_at
    const itemsToInsert = items.map(i => ({
      order_id: order.id,
      test_name: i.test_name,
      test_category: i.test_category || null,
      instructions: i.instructions || i.notes || null,
    }));

    const { error: itemsError } = await supabase.from('laboratory_order_items').insert(itemsToInsert);
    if (itemsError) {
      console.error('Failed to insert laboratory order items:', {
        code: itemsError.code,
        message: itemsError.message,
        details: itemsError.details,
        hint: itemsError.hint,
      });
      showToast(`Order created, but tests failed: ${itemsError.message}`, 'error');
      btn.disabled = false;
      btn.textContent = 'Submit Order';
      return;
    }

    showToast('Lab order submitted successfully', 'success');
    document.getElementById('lab-modal-overlay').classList.remove('active');
    btn.disabled = false;
    btn.textContent = 'Submit Order';
    loadLabOrders();
    if (currentView === 'chart') loadChartLabOrders(patientId);
  } catch (err) {
    console.error('Unexpected error submitting lab order:', {
      code: err.code,
      message: err.message,
      details: err.details,
      hint: err.hint,
    });
    showToast(err.message || 'Failed to submit lab order', 'error');
    btn.disabled = false;
    btn.textContent = 'Submit Order';
  }
}

// ─── Prescriptions ────────────────────────────────────────────────────────────
async function loadPrescriptions() {
  const container = document.getElementById('prescriptions-list');
  container.innerHTML = '<div class="loading-state">Loading...</div>';
  const { data: user } = await supabase.auth.getUser();
  let query = supabase.from('prescriptions')
    .select(`*, prescription_items(*), patient:patients(hospital_number,first_name,last_name)`)
    .eq('prescribing_doctor_id', user.user.id)
    .order('created_at', { ascending: false });
  if (rxFilter !== 'all') query = query.eq('status', rxFilter);
  const { data, error } = await query;
  if (error) { container.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`; return; }
  if (!data || data.length === 0) { container.innerHTML = '<div class="empty-state">No prescriptions.</div>'; return; }
  container.innerHTML = data.map(rx => renderRxCard(rx)).join('');
}

function renderRxCard(rx) {
  const patient = rx.patient || {};
  const items = rx.prescription_items || [];
  return `
    <div class="list-item">
      <div class="list-item-body">
        <div class="list-item-title">
          RX #${escapeHtml(rx.rx_number || rx.id.slice(0, 8))} —
          ${escapeHtml(patient.first_name || '')} ${escapeHtml(patient.last_name || '')}
        </div>
        <div class="list-item-meta">HN: ${escapeHtml(patient.hospital_number || '—')} · ${formatDate(rx.created_at, 'datetime')}</div>
        <div style="margin-top:.35rem">
          ${items.map(i => `
            <div style="font-size:.82rem;margin-top:.2rem">
              💊 ${escapeHtml(i.medicine_name || i.generic_name || '')} ${escapeHtml(i.strength || '')} — ${escapeHtml(i.dosage || '')} ${escapeHtml(i.frequency || '')}
            </div>
          `).join('')}
        </div>
        ${rx.notes ? `<div class="list-item-note">${escapeHtml(rx.notes)}</div>` : ''}
      </div>
      <div class="list-item-aside">
        <span class="badge ${getStatusBadgeClass(rx.status)}">${escapeHtml(rx.status || '')}</span>
      </div>
    </div>
  `;
}

function openRxModal(presetPatientId) {
  loadMedicineCatalog();
  document.getElementById('rx-items-container').innerHTML = '';
  document.getElementById('rx-notes').value = '';
  document.getElementById('rx-patient-id').value = '';
  document.getElementById('rx-patient-selected').style.display = 'none';
  document.getElementById('rx-patient-search').value = '';
  document.getElementById('rx-patient-search').disabled = false;
  document.getElementById('rx-patient-results').style.display = 'none';
  addRxItemRow();
  if (presetPatientId && chartContext?.patient) {
    const p = chartContext.patient;
    document.getElementById('rx-patient-id').value = p.id;
    const chip = document.getElementById('rx-patient-selected');
    chip.textContent = `${p.first_name} ${p.last_name} (${p.hospital_number})`;
    chip.style.display = 'block';
    document.getElementById('rx-patient-search').disabled = true;
  }
  document.getElementById('rx-modal-overlay').classList.add('active');
}

function addRxItemRow() {
  const container = document.getElementById('rx-items-container');
  const row = document.createElement('div');
  row.className = 'rx-item-row';
  row.style.cssText = 'background:var(--bg-secondary,#f8fafc);border:1px solid var(--border-color,#e2e8f0);border-radius:8px;padding:.75rem;margin-bottom:.5rem';
  row.innerHTML = `
    <div class="form-row">
      <div class="form-group" style="flex:2">
        <label class="form-label" style="font-size:.75rem">Medicine Name *</label>
        <input type="text" class="form-control" data-field="medicine_name" list="meds-catalog-list" placeholder="e.g. Amoxicillin" required/>
      </div>
      <div class="form-group">
        <label class="form-label" style="font-size:.75rem">Strength</label>
        <input type="text" class="form-control" data-field="strength" placeholder="e.g. 500mg"/>
      </div>
      <div class="form-group">
        <label class="form-label" style="font-size:.75rem">Dosage *</label>
        <input type="text" class="form-control" data-field="dosage" placeholder="e.g. 1 tablet" required/>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" style="font-size:.75rem">Route *</label>
        <select class="form-control" data-field="route">
          <option value="oral">Oral</option>
          <option value="iv">IV</option>
          <option value="im">IM</option>
          <option value="topical">Topical</option>
          <option value="sublingual">Sublingual</option>
          <option value="inhalation">Inhalation</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" style="font-size:.75rem">Frequency *</label>
        <input type="text" class="form-control" data-field="frequency" placeholder="e.g. TDS" required/>
      </div>
      <div class="form-group">
        <label class="form-label" style="font-size:.75rem">Duration</label>
        <input type="text" class="form-control" data-field="duration" placeholder="e.g. 7 days"/>
      </div>
      <div class="form-group">
        <label class="form-label" style="font-size:.75rem">Qty *</label>
        <input type="number" min="1" class="form-control" data-field="quantity" placeholder="21" required/>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" style="font-size:.75rem">Instructions</label>
      <input type="text" class="form-control" data-field="instructions" placeholder="e.g. Take after meals"/>
    </div>
    <button class="btn btn-ghost btn-xs remove-row-btn" style="color:var(--danger)">✕ Remove</button>
  `;
  row.querySelector('.remove-row-btn').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

async function submitPrescription() {
  const patientId = document.getElementById('rx-patient-id').value;
  if (!patientId) { showToast('Please select a patient', 'warning'); return; }
  const rows = document.querySelectorAll('.rx-item-row');
  if (rows.length === 0) { showToast('Please add at least one medicine', 'warning'); return; }

  const items = [];
  let validationError = null;

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const name = row.querySelector('[data-field="medicine_name"]').value.trim();
    const dosage = row.querySelector('[data-field="dosage"]').value.trim();
    const route = row.querySelector('[data-field="route"]').value;
    const frequency = row.querySelector('[data-field="frequency"]').value.trim();
    const duration = row.querySelector('[data-field="duration"]').value.trim();
    const qtyVal = parseInt(row.querySelector('[data-field="quantity"]').value);
    const strength = row.querySelector('[data-field="strength"]').value.trim();
    const instructions = row.querySelector('[data-field="instructions"]').value.trim();

    if (!name) {
      validationError = `Medicine #${idx + 1}: Name is required.`;
      break;
    }
    if (!dosage) {
      validationError = `Medicine #${idx + 1} (${name}): Dosage is required (e.g. 1 tablet, 5ml).`;
      break;
    }
    if (!frequency) {
      validationError = `Medicine #${idx + 1} (${name}): Frequency is required (e.g. TDS, BD, Once daily).`;
      break;
    }
    if (!qtyVal || qtyVal <= 0 || isNaN(qtyVal)) {
      validationError = `Medicine #${idx + 1} (${name}): Quantity must be a positive number greater than 0.`;
      break;
    }

    // Resolve medicine_id from catalog
    const medId = await resolveMedicineId(name);
    if (!medId) {
      validationError = `Medicine #${idx + 1} (${name}): Could not find medicine in pharmacy catalog. Please select a registered medicine.`;
      break;
    }

    items.push({
      medicine_id: medId,
      medicine_name: name,
      strength: strength || null,
      dosage: dosage,
      route: route || 'oral',
      frequency: frequency,
      duration: duration || 'As directed',
      quantity_prescribed: qtyVal,
      instructions: instructions || null,
    });
  }

  if (validationError) {
    showToast(validationError, 'warning');
    return;
  }
  if (items.length === 0) {
    showToast('Please add at least one medicine', 'warning');
    return;
  }

  const btn = document.getElementById('rx-modal-save');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    const { data: userRes } = await supabase.auth.getUser();
    const userId = userRes?.user?.id;
    if (!userId) {
      showToast('You must be logged in to prescribe medication.', 'error');
      btn.disabled = false;
      btn.textContent = 'Submit Prescription';
      return;
    }

    // Ensure active encounter so can_access_patient(patient_id) is satisfied
    let encounterId = chartContext?.encounterId;
    if (!encounterId) {
      encounterId = await ensureDoctorPatientEncounter(patientId);
      if (chartContext && chartContext.patient?.id === patientId) {
        chartContext.encounterId = encounterId;
      }
    }

    const { data: rx, error } = await supabase.from('prescriptions').insert([{
      patient_id: patientId,
      encounter_id: encounterId || null,
      prescribing_doctor_id: userId,
      clinical_notes: document.getElementById('rx-notes')?.value.trim() || null,
      status: 'active',
    }]).select().single();

    if (error) {
      console.error('Failed to create prescription parent record:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
      showToast(error.message || 'Failed to create prescription', 'error');
      btn.disabled = false;
      btn.textContent = 'Submit Prescription';
      return;
    }

    const itemsToInsert = items.map(i => ({
      prescription_id: rx.id,
      medicine_id: i.medicine_id,
      dosage: i.dosage,
      frequency: i.frequency,
      duration: i.duration,
      quantity_prescribed: i.quantity_prescribed,
      quantity_dispensed: 0,
      special_instructions: i.instructions || null,
    }));
    const { error: itemsError } = await supabase.from('prescription_items').insert(itemsToInsert);

    if (itemsError) {
      console.error('Failed to insert prescription items:', {
        code: itemsError.code,
        message: itemsError.message,
        details: itemsError.details,
        hint: itemsError.hint,
      });
      showToast(`Prescription created, but medication items failed: ${itemsError.message}`, 'error');
      btn.disabled = false;
      btn.textContent = 'Submit Prescription';
      return;
    }

    showToast('Prescription submitted successfully', 'success');
    document.getElementById('rx-modal-overlay').classList.remove('active');
    btn.disabled = false;
    btn.textContent = 'Submit Prescription';
    loadPrescriptions();
    if (currentView === 'chart') loadChartPrescriptions(patientId);
  } catch (err) {
    console.error('Unexpected error in submitPrescription:', {
      code: err.code,
      message: err.message,
      details: err.details,
      hint: err.hint,
    });
    showToast(err.message || 'An unexpected error occurred submitting prescription', 'error');
    btn.disabled = false;
    btn.textContent = 'Submit Prescription';
  }
}

// ─── Send File ────────────────────────────────────────────────────────────────
function openSendModal() {
  if (!chartContext?.patient) { showToast('No patient selected', 'warning'); return; }
  document.getElementById('send-staff-search').value = '';
  document.getElementById('send-staff-results').innerHTML = '';
  document.getElementById('send-recipient-id').value = '';
  document.getElementById('send-from-dept').value = currentProfile.department || '';
  document.getElementById('send-to-dept').value = '';
  document.getElementById('send-message').value = '';
  document.getElementById('send-modal-overlay').classList.add('active');
}

async function searchStaff() {
  const q = document.getElementById('send-staff-search').value.trim();
  if (!q) { document.getElementById('send-staff-results').innerHTML = ''; return; }
  const { data, error } = await supabase.from('profiles')
    .select('id, full_name, role, department')
    .or(`full_name.ilike.%${q}%,department.ilike.%${q}%`)
    .neq('id', currentProfile.id)
    .eq('is_active', true)
    .limit(10);
  if (error || !data) return;
  const container = document.getElementById('send-staff-results');
  container.innerHTML = data.map(s => `
    <label class="staff-option">
      <input type="radio" name="send-recipient" value="${s.id}" data-dept="${escapeHtml(s.department || '')}"/>
      <div>
        <div style="font-weight:600">${escapeHtml(s.full_name)}</div>
        <div style="font-size:.8rem;color:var(--text-muted)">${formatRole(s.role)} · ${escapeHtml(s.department || '—')}</div>
      </div>
    </label>
  `).join('');
  container.querySelectorAll('input[name="send-recipient"]').forEach(radio => {
    radio.addEventListener('change', () => {
      document.getElementById('send-recipient-id').value = radio.value;
      document.getElementById('send-to-dept').value = radio.dataset.dept;
    });
  });
}

async function submitSendFile() {
  const recipientId = document.getElementById('send-recipient-id').value;
  if (!recipientId) { showToast('Please select a recipient', 'warning'); return; }
  const fromDept = document.getElementById('send-from-dept').value.trim();
  const toDept = document.getElementById('send-to-dept').value.trim();
  if (!fromDept || !toDept) { showToast('Please enter departments', 'warning'); return; }

  const btn = document.getElementById('send-modal-submit');
  btn.disabled = true;

  const { error } = await sendPatientFile({
    patient_id: chartContext.patient.id,
    encounter_id: chartContext.encounterId || null,
    recipient_id: recipientId,
    from_department: fromDept,
    to_department: toDept,
    reason: document.getElementById('send-message')?.value.trim() || 'Patient file transfer',
  });

  if (error) { showToast(error.message, 'error'); btn.disabled = false; return; }
  showToast('Patient file sent', 'success');
  document.getElementById('send-modal-overlay').classList.remove('active');
  btn.disabled = false;
}

// ─── Patient search in modals ─────────────────────────────────────────────────
function setupPatientSearchInModal(searchId, resultsId, hiddenId, chipId) {
  const input = document.getElementById(searchId);
  const results = document.getElementById(resultsId);
  input.addEventListener('input', debounce(async () => {
    const q = input.value.trim();
    if (!q) { results.style.display = 'none'; return; }
    const { data } = await searchPatients(q, 1, 8);
    if (!data || data.length === 0) { results.innerHTML = '<div style="padding:.5rem;font-size:.82rem">No results</div>'; results.style.display = 'block'; return; }
    results.innerHTML = data.map(p => `
      <div class="search-dropdown-item" data-pid="${p.id}" data-name="${escapeHtml(p.first_name + ' ' + p.last_name)}" data-hn="${escapeHtml(p.hospital_number)}" style="padding:.5rem;cursor:pointer;font-size:.85rem">
        ${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)} <span style="color:var(--text-muted)">(${escapeHtml(p.hospital_number)})</span>
      </div>
    `).join('');
    results.style.display = 'block';
    results.querySelectorAll('.search-dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        document.getElementById(hiddenId).value = item.dataset.pid;
        const chip = document.getElementById(chipId);
        chip.textContent = `${item.dataset.name} (${item.dataset.hn})`;
        chip.style.display = 'block';
        input.value = '';
        results.style.display = 'none';
      });
    });
  }, 350));
}

// ─── Vitals Modal ─────────────────────────────────────────────────────────────
function openVitalsModal() {
  ['v-bp-sys','v-bp-dia','v-pulse','v-resp','v-temp','v-spo2','v-weight','v-height','v-bmi','v-glucose','v-pain','v-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('vitals-modal-overlay').classList.add('active');
}

async function saveVitals() {
  if (!chartContext?.patient) return;
  const { patient, encounterId } = chartContext;
  const { data: userRes } = await supabase.auth.getUser();
  const userId = userRes?.user?.id;
  const bpSys = parseInt(document.getElementById('v-bp-sys').value) || null;
  const bpDia = parseInt(document.getElementById('v-bp-dia').value) || null;
  const weight = parseFloat(document.getElementById('v-weight').value) || null;
  const height = parseFloat(document.getElementById('v-height').value) || null;
  const pulse = parseInt(document.getElementById('v-pulse').value) || null;
  const resp = parseInt(document.getElementById('v-resp').value) || null;
  const temp = parseFloat(document.getElementById('v-temp').value) || null;
  const spo2 = parseInt(document.getElementById('v-spo2').value) || null;
  const notes = document.getElementById('v-notes').value.trim() || null;
  const bmi = (weight && height && height > 0) ? Math.round((weight / ((height / 100) ** 2)) * 10) / 10 : null;

  let encId = encounterId;
  if (!encId && patient.id) {
    encId = await ensureDoctorPatientEncounter(patient.id);
    if (chartContext) chartContext.encounterId = encId;
  }

  const payload = {
    patient_id: patient.id,
    encounter_id: encId || null,
    recorded_by: userId,
    blood_pressure_systolic: bpSys,
    blood_pressure_diastolic: bpDia,
    pulse_rate: pulse,
    respiratory_rate: resp,
    temperature_c: temp,
    sp_o2: spo2,
    weight_kg: weight,
    height_cm: height,
    bmi: bmi,
    clinical_notes: notes,
  };

  const btn = document.getElementById('vitals-modal-save');
  btn.disabled = true;
  const { error } = await recordVitals(payload);
  btn.disabled = false;
  if (error) {
    console.error('Failed to record vitals:', {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    showToast(error.message || 'Failed to record vitals', 'error');
    return;
  }
  showToast('Vitals recorded', 'success');
  document.getElementById('vitals-modal-overlay').classList.remove('active');
  loadChartVitals(patient.id, encId);
  loadChartSummary(patient);
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
