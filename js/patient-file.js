/**
 * Dreyson Global Hospital — EMR System
 * Shared Patient File Component
 *
 * Renders the unified patient record across all dashboards.
 * Each section is rendered if data exists; edit controls only appear
 * when the caller's role has write permission for that section.
 *
 * Usage:
 *   import { PatientFile } from './patient-file.js';
 *   const pf = new PatientFile(containerEl, { role, onSave });
 *   pf.load(patientId);
 */

import { supabase } from './supabase-client.js';
import {
  formatDate, calculateAge, escapeHtml, showToast,
  getStatusBadgeClass,
} from './utils.js';
import {
  getPatientFile,
  recordVitals,
  createNote,
  createLabOrder,
  updateLabOrderStatus,
  saveLabResult,
  finalizeLabResult,
  createPrescription,
  dispenseItems,
  getMedicineCatalog,
  getMedicineBatches,
} from './api/shared-api.js';

export class PatientFile {
  /**
   * @param {HTMLElement} container - Where the file renders
   * @param {Object} opts
   * @param {string} opts.role - Current staff role
   * @param {string} opts.userId - Current user ID
   * @param {string} opts.userName - Current user full name
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.role = opts.role || '';
    this.userId = opts.userId || '';
    this.userName = opts.userName || '';
    this.patientId = null;
    this.fileData = null;
    this._saveInProgress = false;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async load(patientId) {
    this.patientId = patientId;
    this._renderLoading();
    const result = await getPatientFile(patientId);
    if (result.error) {
      this._renderError(result.error.message);
      return;
    }
    this.fileData = result;
    this._render();
  }

  async refresh() {
    if (!this.patientId) return;
    await this.load(this.patientId);
  }

  clear() {
    this.patientId = null;
    this.fileData = null;
    this.container.innerHTML = '';
  }

  // ─── Rendering ───────────────────────────────────────────────────────────────

  _renderLoading() {
    this.container.innerHTML = `
      <div class="patient-file-loading">
        <div class="loading-spinner"></div>
        <p>Loading patient record…</p>
      </div>`;
  }

  _renderError(msg) {
    this.container.innerHTML = `
      <div class="patient-file-error alert alert-error">
        <strong>Error loading patient file:</strong> ${escapeHtml(msg)}
      </div>`;
  }

  _render() {
    const { patient, encounters, vitals, notes, diagnoses, allergies,
            labOrders, prescriptions, dispensing } = this.fileData;
    if (!patient) {
      this._renderError('Patient record not found.');
      return;
    }

    const activeEncounter = encounters.find(e =>
      e.status === 'open' || e.status === 'in_progress'
    ) || encounters[0] || null;

    const html = `
      <div class="patient-file" id="patient-file-root">
        ${this._renderPatientHeader(patient, activeEncounter)}
        ${this._renderSectionA(patient)}
        ${this._renderSectionB(vitals, notes.filter(n => n.note_type === 'nursing'), activeEncounter)}
        ${this._renderSectionC(notes.filter(n => n.note_type !== 'nursing'), diagnoses, labOrders, prescriptions, activeEncounter)}
        ${this._renderSectionD(labOrders, vitals, activeEncounter)}
        ${this._renderSectionE(prescriptions, dispensing, activeEncounter)}
      </div>`;
    this.container.innerHTML = html;
    this._attachEventListeners(patient, activeEncounter);
  }

  // ─── Header ─────────────────────────────────────────────────────────────────

  _renderPatientHeader(patient, encounter) {
    const name = [patient.first_name, patient.middle_name, patient.last_name]
      .filter(Boolean).join(' ');
    const age = patient.date_of_birth ? calculateAge(patient.date_of_birth) : '—';
    const showPhone = ['front_desk', 'nurse', 'doctor', 'pharmacist', 'admin'].includes(this.role);
    return `
      <div class="patient-file-header">
        <div class="patient-file-identity">
          <div class="patient-file-avatar">${escapeHtml(name.charAt(0).toUpperCase())}</div>
          <div class="patient-file-details">
            <h2 class="patient-file-name">${escapeHtml(name)}</h2>
            <div class="patient-file-meta">
              <span class="meta-pill">🏥 ${escapeHtml(patient.hospital_number)}</span>
              <span class="meta-pill">👤 ${escapeHtml(patient.sex || '—')}, ${age} yrs</span>
              ${showPhone ? `<span class="meta-pill">📞 ${escapeHtml(patient.phone || '—')}</span>` : ''}
              <span class="meta-pill">📅 Reg: ${formatDate(patient.created_at, 'date')}</span>
              ${encounter ? `<span class="meta-pill encounter-pill">🔖 ${escapeHtml(encounter.encounter_number)} · ${encounter.status}</span>` : ''}
            </div>
          </div>
        </div>
        <button class="btn btn-sm btn-secondary" id="pf-refresh-btn" title="Refresh patient file">↻ Refresh</button>
      </div>`;
  }

  // ─── Section A: Front-Desk Demographics ─────────────────────────────────────

  _renderSectionA(patient) {
    const canEdit = ['front_desk', 'admin'].includes(this.role);
    const dob = patient.date_of_birth ? formatDate(patient.date_of_birth, 'date') : '—';
    return `
      <section class="pf-section" id="pf-section-a">
        <div class="pf-section-header">
          <div class="pf-section-title">
            <span class="pf-section-icon">🏢</span>
            <h3>Section A — Patient Registration</h3>
            <span class="pf-section-dept">Front Desk</span>
          </div>
          ${canEdit ? `<button class="btn btn-sm btn-secondary" id="pf-edit-demographics-btn">✏️ Edit Demographics</button>` : ''}
        </div>
        <div class="pf-section-body" id="pf-section-a-view">
          <div class="info-grid">
            <div class="info-item"><label>Full Name</label><span>${escapeHtml([patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' '))}</span></div>
            <div class="info-item"><label>Hospital Number</label><span class="hospital-number">${escapeHtml(patient.hospital_number)}</span></div>
            <div class="info-item"><label>Date of Birth</label><span>${dob}</span></div>
            <div class="info-item"><label>Sex</label><span>${escapeHtml(patient.sex || '—')}</span></div>
            <div class="info-item"><label>Phone</label><span>${escapeHtml(patient.phone || '—')}</span></div>
            <div class="info-item"><label>Alt Phone</label><span>${escapeHtml(patient.alt_phone || '—')}</span></div>
            <div class="info-item"><label>Email</label><span>${escapeHtml(patient.email || '—')}</span></div>
            <div class="info-item info-item-wide"><label>Address</label><span>${escapeHtml(patient.address || '—')}</span></div>
            <div class="info-item"><label>Next of Kin</label><span>${escapeHtml(patient.next_of_kin || '—')}</span></div>
            <div class="info-item"><label>Emergency Contact</label><span>${escapeHtml(patient.emergency_contact_name || '—')} ${patient.emergency_contact_phone ? `· ${escapeHtml(patient.emergency_contact_phone)}` : ''}</span></div>
            <div class="info-item"><label>Registered By</label><span>${escapeHtml(patient.registered_by_profile?.full_name || '—')}</span></div>
            <div class="info-item"><label>Registration Date</label><span>${formatDate(patient.created_at, 'datetime')}</span></div>
          </div>
        </div>
        ${canEdit ? this._renderDemographicsEditForm(patient) : ''}
      </section>`;
  }

  _renderDemographicsEditForm(patient) {
    return `
      <div class="pf-edit-form" id="pf-section-a-edit" style="display:none">
        <form id="pf-demographics-form" class="form-grid">
          <div class="form-group">
            <label>Phone *</label>
            <input type="tel" id="pf-dem-phone" value="${escapeHtml(patient.phone || '')}" required/>
          </div>
          <div class="form-group">
            <label>Alt Phone</label>
            <input type="tel" id="pf-dem-alt-phone" value="${escapeHtml(patient.alt_phone || '')}"/>
          </div>
          <div class="form-group">
            <label>Email</label>
            <input type="email" id="pf-dem-email" value="${escapeHtml(patient.email || '')}"/>
          </div>
          <div class="form-group form-group-wide">
            <label>Address</label>
            <input type="text" id="pf-dem-address" value="${escapeHtml(patient.address || '')}"/>
          </div>
          <div class="form-group">
            <label>Next of Kin</label>
            <input type="text" id="pf-dem-nok" value="${escapeHtml(patient.next_of_kin || '')}"/>
          </div>
          <div class="form-group">
            <label>Emergency Contact Name</label>
            <input type="text" id="pf-dem-ec-name" value="${escapeHtml(patient.emergency_contact_name || '')}"/>
          </div>
          <div class="form-group">
            <label>Emergency Contact Phone</label>
            <input type="tel" id="pf-dem-ec-phone" value="${escapeHtml(patient.emergency_contact_phone || '')}"/>
          </div>
          <div class="form-group">
            <label>Emergency Contact Relationship</label>
            <input type="text" id="pf-dem-ec-rel" value="${escapeHtml(patient.emergency_contact_relationship || '')}"/>
          </div>
          <div class="form-group form-group-wide">
            <label>Administrative Notes</label>
            <textarea id="pf-dem-notes" rows="2">${escapeHtml(patient.admin_notes || '')}</textarea>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="pf-save-demographics-btn">💾 Save Demographics</button>
            <button type="button" class="btn btn-secondary" id="pf-cancel-demographics-btn">Cancel</button>
          </div>
        </form>
      </div>`;
  }

  // ─── Section B: Nursing ──────────────────────────────────────────────────────

  _renderSectionB(vitals, nursingNotes, encounter) {
    const canWrite = ['nurse', 'admin'].includes(this.role);
    return `
      <section class="pf-section" id="pf-section-b">
        <div class="pf-section-header">
          <div class="pf-section-title">
            <span class="pf-section-icon">🩺</span>
            <h3>Section B — Nursing</h3>
            <span class="pf-section-dept">Nursing</span>
          </div>
        </div>
        <div class="pf-section-body">
          ${this._renderVitalsHistory(vitals)}
          ${this._renderNursingNotes(nursingNotes)}
          ${canWrite ? this._renderVitalsForm(encounter) : '<p class="pf-readonly-note">You do not have permission to record nursing observations.</p>'}
        </div>
      </section>`;
  }

  _renderVitalsHistory(vitals) {
    if (!vitals.length) return '<div class="pf-subsection"><h4>Vital Signs History</h4><p class="empty-text">No vital signs recorded.</p></div>';
    return `
      <div class="pf-subsection">
        <h4>Vital Signs History</h4>
        <div class="vitals-list">
          ${vitals.slice(0, 10).map(v => {
            const bpSys = v.blood_pressure_systolic ?? v.bp_systolic;
            const bpDia = v.blood_pressure_diastolic ?? v.bp_diastolic;
            const temp = v.temperature_c ?? v.temperature;
            const spo2 = v.sp_o2 ?? v.oxygen_saturation;
            const wt = v.weight_kg ?? v.weight;
            const ht = v.height_cm ?? v.height;
            const notes = v.clinical_notes ?? v.notes;
            return `
            <div class="vitals-entry">
              <div class="vitals-row">
                ${bpSys && bpDia ? `<span class="vital-chip">BP: ${bpSys}/${bpDia} mmHg</span>` : ''}
                ${v.pulse_rate ? `<span class="vital-chip">Pulse: ${v.pulse_rate} bpm</span>` : ''}
                ${temp ? `<span class="vital-chip">Temp: ${temp}°C</span>` : ''}
                ${v.respiratory_rate ? `<span class="vital-chip">RR: ${v.respiratory_rate}/min</span>` : ''}
                ${spo2 ? `<span class="vital-chip">SpO₂: ${spo2}%</span>` : ''}
                ${wt ? `<span class="vital-chip">Wt: ${wt} kg</span>` : ''}
                ${ht ? `<span class="vital-chip">Ht: ${ht} cm</span>` : ''}
                ${v.bmi ? `<span class="vital-chip">BMI: ${v.bmi}</span>` : ''}
              </div>
              <div class="vitals-meta">
                Recorded by ${escapeHtml(v.recorded_by_profile?.full_name || 'Staff')} · ${formatDate(v.created_at, 'datetime')}
                ${notes ? `<div class="vitals-note">${escapeHtml(notes)}</div>` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  _renderNursingNotes(notes) {
    if (!notes.length) return '<div class="pf-subsection"><h4>Nursing Notes</h4><p class="empty-text">No nursing notes recorded.</p></div>';
    return `
      <div class="pf-subsection">
        <h4>Nursing Notes</h4>
        ${notes.map(n => `
          <div class="note-entry ${n.is_signed ? 'note-signed' : ''}">
            <div class="note-content">${escapeHtml(n.content)}</div>
            <div class="note-meta">${escapeHtml(n.author_profile?.full_name || 'Nurse')} · ${formatDate(n.created_at, 'datetime')} ${n.is_signed ? '✅ Signed' : ''}</div>
          </div>`).join('')}
      </div>`;
  }

  _renderVitalsForm(encounter) {
    return `
      <div class="pf-subsection pf-write-section">
        <h4>Record New Vital Signs</h4>
        <form id="pf-vitals-form" class="form-grid">
          <div class="form-group">
            <label>BP Systolic (mmHg)</label>
            <input type="number" id="pf-bp-sys" min="50" max="300" placeholder="e.g. 120"/>
          </div>
          <div class="form-group">
            <label>BP Diastolic (mmHg)</label>
            <input type="number" id="pf-bp-dia" min="30" max="200" placeholder="e.g. 80"/>
          </div>
          <div class="form-group">
            <label>Pulse Rate (bpm)</label>
            <input type="number" id="pf-pulse" min="20" max="300" placeholder="e.g. 72"/>
          </div>
          <div class="form-group">
            <label>Respiratory Rate (/min)</label>
            <input type="number" id="pf-rr" min="5" max="60" placeholder="e.g. 16"/>
          </div>
          <div class="form-group">
            <label>Temperature (°C)</label>
            <input type="number" id="pf-temp" step="0.1" min="30" max="45" placeholder="e.g. 36.5"/>
          </div>
          <div class="form-group">
            <label>SpO₂ (%)</label>
            <input type="number" id="pf-spo2" step="0.1" min="50" max="100" placeholder="e.g. 98"/>
          </div>
          <div class="form-group">
            <label>Weight (kg)</label>
            <input type="number" id="pf-weight" step="0.1" min="1" max="500" placeholder="e.g. 70"/>
          </div>
          <div class="form-group">
            <label>Height (cm)</label>
            <input type="number" id="pf-height" step="0.1" min="30" max="300" placeholder="e.g. 175"/>
          </div>

          <div class="form-group form-group-wide">
            <label>Nursing Notes</label>
            <textarea id="pf-vitals-notes" rows="2" placeholder="Additional nursing observations…"></textarea>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="pf-save-vitals-btn">💾 Save Vital Signs</button>
          </div>
        </form>
      </div>`;
  }

  // ─── Section C: Doctor ───────────────────────────────────────────────────────

  _renderSectionC(clinicalNotes, diagnoses, labOrders, prescriptions, encounter) {
    const canWrite = ['doctor', 'admin'].includes(this.role);
    return `
      <section class="pf-section" id="pf-section-c">
        <div class="pf-section-header">
          <div class="pf-section-title">
            <span class="pf-section-icon">👨‍⚕️</span>
            <h3>Section C — Medical Consultation</h3>
            <span class="pf-section-dept">Doctor</span>
          </div>
        </div>
        <div class="pf-section-body">
          ${this._renderClinicalNotes(clinicalNotes)}
          ${this._renderDiagnoses(diagnoses)}
          ${this._renderLabOrderSummary(labOrders)}
          ${this._renderPrescriptionSummary(prescriptions)}
          ${canWrite ? this._renderConsultationForm(encounter) : '<p class="pf-readonly-note">Only doctors can add consultation notes, orders and prescriptions.</p>'}
        </div>
      </section>`;
  }

  _renderClinicalNotes(notes) {
    if (!notes.length) return '<div class="pf-subsection"><h4>Consultation Notes</h4><p class="empty-text">No consultation notes recorded.</p></div>';
    return `
      <div class="pf-subsection">
        <h4>Consultation Notes</h4>
        ${notes.map(n => `
          <div class="note-entry ${n.is_signed ? 'note-signed' : ''} ${n.note_type === 'amendment' ? 'note-amendment' : ''}">
            <div class="note-type-tag">${n.note_type === 'amendment' ? '📝 Amendment' : '📋 Clinical Note'}</div>
            <div class="note-content">${escapeHtml(n.content)}</div>
            <div class="note-meta">Dr. ${escapeHtml(n.author_profile?.full_name || '—')} · ${formatDate(n.created_at, 'datetime')} ${n.is_signed ? '✅ Signed' : ''}</div>
          </div>`).join('')}
      </div>`;
  }

  _renderDiagnoses(diagnoses) {
    if (!diagnoses.length) return '<div class="pf-subsection"><h4>Diagnoses</h4><p class="empty-text">No diagnoses recorded.</p></div>';
    return `
      <div class="pf-subsection">
        <h4>Diagnoses</h4>
        <div class="diagnoses-list">
          ${diagnoses.map(d => `
            <div class="diagnosis-entry">
              <span class="diagnosis-name">${escapeHtml(d.diagnosis_name)}${d.diagnosis_code ? ` <small>(${escapeHtml(d.diagnosis_code)})</small>` : ''}</span>
              ${d.notes ? `<span class="diagnosis-notes">${escapeHtml(d.notes)}</span>` : ''}
              <span class="diagnosis-meta">${escapeHtml(d.diagnosed_by_profile?.full_name || d.recorded_by_profile?.full_name || '—')} · ${formatDate(d.created_at, 'date')}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  _renderLabOrderSummary(labOrders) {
    if (!labOrders.length) return '<div class="pf-subsection"><h4>Laboratory Orders</h4><p class="empty-text">No laboratory orders placed.</p></div>';
    return `
      <div class="pf-subsection">
        <h4>Laboratory Orders</h4>
        ${labOrders.map(o => `
          <div class="order-card">
            <div class="order-card-header">
              <span class="order-number">${escapeHtml(o.order_number)}</span>
              <span class="status-badge ${getStatusBadgeClass(o.status)}">${o.status}</span>
              <span class="order-priority priority-${o.priority}">${o.priority}</span>
            </div>
            <div class="order-tests">${(o.items || []).map(i => `<span class="test-tag">${escapeHtml(i.test_name)}</span>`).join('')}</div>
            ${o.clinical_indication ? `<div class="order-indication">Indication: ${escapeHtml(o.clinical_indication)}</div>` : ''}
            <div class="order-meta">Ordered by Dr. ${escapeHtml(o.ordering_doctor?.full_name || '—')} · ${formatDate(o.created_at, 'datetime')}</div>
          </div>`).join('')}
      </div>`;
  }

  _renderPrescriptionSummary(prescriptions) {
    if (!prescriptions.length) return '<div class="pf-subsection"><h4>Medication Orders</h4><p class="empty-text">No medication orders placed.</p></div>';
    return `
      <div class="pf-subsection">
        <h4>Medication Orders</h4>
        ${prescriptions.map(rx => `
          <div class="order-card">
            <div class="order-card-header">
              <span class="order-number">${escapeHtml(rx.prescription_number)}</span>
              <span class="status-badge ${getStatusBadgeClass(rx.status)}">${rx.status}</span>
            </div>
            ${rx.notes ? `<div class="order-indication">${escapeHtml(rx.notes)}</div>` : ''}
            <div class="rx-items">
              ${(rx.items || []).map(i => `
                <div class="rx-item">
                  <strong>${escapeHtml(i.medicine_name)}${i.strength ? ` ${escapeHtml(i.strength)}` : ''}</strong>
                  — ${escapeHtml(i.dosage)}, ${escapeHtml(i.frequency)}${i.duration ? `, ${escapeHtml(i.duration)}` : ''}, Qty: ${i.quantity}
                  ${i.instructions ? `<div class="rx-instructions">${escapeHtml(i.instructions)}</div>` : ''}
                </div>`).join('')}
            </div>
            <div class="order-meta">Dr. ${escapeHtml(rx.prescribing_doctor?.full_name || '—')} · ${formatDate(rx.created_at, 'datetime')}</div>
          </div>`).join('')}
      </div>`;
  }

  _renderConsultationForm(encounter) {
    return `
      <div class="pf-subsection pf-write-section">
        <h4>Add Consultation Note</h4>
        <form id="pf-consultation-form" class="form-grid">
          <div class="form-group form-group-wide">
            <label>Consultation Note *</label>
            <textarea id="pf-consult-note" rows="5" placeholder="Chief complaint, history, examination findings, assessment, treatment plan…" required></textarea>
          </div>
          <div class="form-group">
            <label>Diagnosis Name</label>
            <input type="text" id="pf-diagnosis-name" placeholder="e.g. Malaria, Typhoid fever"/>
          </div>
          <div class="form-group">
            <label>ICD Code (optional)</label>
            <input type="text" id="pf-diagnosis-code" placeholder="e.g. B54"/>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="pf-save-consult-btn">💾 Save Note</button>
            <label class="checkbox-label">
              <input type="checkbox" id="pf-sign-note"/> Sign this note
            </label>
          </div>
        </form>

        <hr class="pf-divider"/>
        <h4>Create Laboratory Order</h4>
        <form id="pf-lab-order-form" class="form-grid">
          <div class="form-group form-group-wide">
            <label>Test(s) Required *</label>
            <input type="text" id="pf-lab-tests" placeholder="e.g. Full Blood Count, Malaria RDT, Blood Culture (separate with commas)" required/>
          </div>
          <div class="form-group form-group-wide">
            <label>Clinical Indication</label>
            <input type="text" id="pf-lab-indication" placeholder="e.g. Fever, suspect malaria"/>
          </div>
          <div class="form-group">
            <label>Priority</label>
            <select id="pf-lab-priority">
              <option value="routine">Routine</option>
              <option value="urgent">Urgent</option>
              <option value="stat">STAT</option>
            </select>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-warning" id="pf-save-lab-order-btn">🧪 Send Lab Order</button>
          </div>
        </form>

        <hr class="pf-divider"/>
        <h4>Create Medication Order</h4>
        <form id="pf-prescription-form" class="form-grid">
          <div class="form-group form-group-wide">
            <label>Clinical Notes / Treatment Plan</label>
            <input type="text" id="pf-rx-notes" placeholder="Brief treatment rationale"/>
          </div>
          <div id="pf-rx-items-container">
            ${this._renderRxItemRow(0)}
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" id="pf-add-rx-item-btn">+ Add Medicine</button>
            <button type="submit" class="btn btn-success" id="pf-save-rx-btn">💊 Issue Prescription</button>
          </div>
        </form>
      </div>`;
  }

  _renderRxItemRow(index) {
    return `
      <div class="rx-item-row" id="pf-rx-row-${index}">
        <div class="form-group"><label>Medicine Name *</label><input type="text" class="pf-rx-med-name" placeholder="e.g. Amoxicillin" required/></div>
        <div class="form-group"><label>Strength</label><input type="text" class="pf-rx-strength" placeholder="e.g. 500mg"/></div>
        <div class="form-group"><label>Dosage *</label><input type="text" class="pf-rx-dosage" placeholder="e.g. 1 tablet" required/></div>
        <div class="form-group"><label>Route *</label><input type="text" class="pf-rx-route" placeholder="e.g. Oral" required/></div>
        <div class="form-group"><label>Frequency *</label><input type="text" class="pf-rx-freq" placeholder="e.g. 3x daily" required/></div>
        <div class="form-group"><label>Duration</label><input type="text" class="pf-rx-duration" placeholder="e.g. 7 days"/></div>
        <div class="form-group"><label>Quantity *</label><input type="number" class="pf-rx-qty" min="1" placeholder="e.g. 21" required/></div>
        <div class="form-group"><label>Instructions</label><input type="text" class="pf-rx-instructions" placeholder="e.g. Take with food"/></div>
        ${index > 0 ? `<div class="form-group"><button type="button" class="btn btn-sm btn-danger pf-remove-rx-row" data-index="${index}">Remove</button></div>` : ''}
      </div>`;
  }

  // ─── Section D: Laboratory ───────────────────────────────────────────────────

  _renderSectionD(labOrders, vitals, encounter) {
    const canWrite = ['lab_technician', 'admin'].includes(this.role);
    return `
      <section class="pf-section" id="pf-section-d">
        <div class="pf-section-header">
          <div class="pf-section-title">
            <span class="pf-section-icon">🔬</span>
            <h3>Section D — Laboratory</h3>
            <span class="pf-section-dept">Laboratory</span>
          </div>
        </div>
        <div class="pf-section-body">
          ${this._renderLabOrdersWithResults(labOrders, canWrite)}
          ${!canWrite ? '<p class="pf-readonly-note">Only laboratory technicians can enter test results.</p>' : ''}
        </div>
      </section>`;
  }

  _renderLabOrdersWithResults(labOrders, canWrite) {
    if (!labOrders.length) return '<p class="empty-text">No laboratory orders for this patient.</p>';
    return labOrders.map(order => `
      <div class="lab-order-panel" id="lab-order-${escapeHtml(order.id)}">
        <div class="lab-order-info">
          <div class="order-card-header">
            <span class="order-number">${escapeHtml(order.order_number)}</span>
            <span class="status-badge ${getStatusBadgeClass(order.status)}">${order.status}</span>
            <span class="order-priority priority-${order.priority}">${order.priority}</span>
          </div>
          <div class="order-tests">${(order.items || []).map(i => `<span class="test-tag">${escapeHtml(i.test_name)}</span>`).join('')}</div>
          ${order.clinical_indication ? `<div class="order-indication">Indication: ${escapeHtml(order.clinical_indication)}</div>` : ''}
          <div class="order-meta">Ordered by Dr. ${escapeHtml(order.ordering_doctor?.full_name || '—')} · ${formatDate(order.created_at, 'datetime')}</div>
        </div>
        ${this._renderExistingResults(order.results || [])}
        ${canWrite && order.status !== 'cancelled' ? this._renderResultEntryForm(order) : ''}
      </div>`).join('');
  }

  _renderExistingResults(results) {
    if (!results.length) return '<div class="pf-subsection"><p class="empty-text">No results recorded yet.</p></div>';
    return `
      <div class="pf-subsection">
        <h4>Results</h4>
        ${results.map(r => `
          <div class="result-entry ${r.is_abnormal ? 'result-abnormal' : ''} ${r.status === 'finalized' ? 'result-finalized' : ''}">
            <div class="result-row">
              <strong>${escapeHtml(r.test_name)}</strong>
              <span class="result-value">${escapeHtml(r.result_value || '—')}</span>
              ${r.unit ? `<span class="result-unit">${escapeHtml(r.unit)}</span>` : ''}
              ${r.reference_range ? `<span class="result-ref">Ref: ${escapeHtml(r.reference_range)}</span>` : ''}
              ${r.is_abnormal ? '<span class="abnormal-flag">⚠ ABNORMAL</span>' : ''}
              <span class="status-badge ${getStatusBadgeClass(r.status)}">${r.status}</span>
            </div>
            ${r.comments ? `<div class="result-comments">${escapeHtml(r.comments)}</div>` : ''}
            ${r.specimen_type ? `<div class="result-meta">Specimen: ${escapeHtml(r.specimen_type)}</div>` : ''}
            <div class="result-meta">By ${escapeHtml(r.performed_by_profile?.full_name || '—')} · ${formatDate(r.created_at, 'datetime')} ${r.status === 'finalized' ? `· Verified by ${escapeHtml(r.verified_by_profile?.full_name || r.finalized_by_profile?.full_name || '—')} at ${formatDate(r.finalized_at, 'datetime')}` : ''}</div>
          </div>`).join('')}
      </div>`;
  }

  _renderResultEntryForm(order) {
    const canAccept = order.status === 'pending' || order.status === 'assigned';
    return `
      <div class="pf-subsection pf-write-section">
        ${canAccept ? `
          <button class="btn btn-sm btn-primary pf-accept-order-btn" data-order-id="${escapeHtml(order.id)}">
            ✅ Accept Order
          </button>` : ''}
        <h4>Enter Results for ${escapeHtml(order.order_number)}</h4>
        <form class="pf-result-form form-grid" data-order-id="${escapeHtml(order.id)}">
          <div class="form-group"><label>Test Name *</label><input type="text" name="test_name" placeholder="e.g. Haemoglobin" required value="${order.items?.[0]?.test_name ? escapeHtml(order.items[0].test_name) : ''}"/></div>
          <div class="form-group"><label>Specimen</label><input type="text" name="specimen_type" placeholder="e.g. Whole blood"/></div>
          <div class="form-group"><label>Result *</label><input type="text" name="result_value" placeholder="e.g. 12.5" required/></div>
          <div class="form-group"><label>Unit</label><input type="text" name="unit" placeholder="e.g. g/dL"/></div>
          <div class="form-group"><label>Reference Range</label><input type="text" name="reference_range" placeholder="e.g. 12–16 g/dL"/></div>
          <div class="form-group"><label>Abnormal?</label>
            <select name="is_abnormal"><option value="">No</option><option value="true">Yes — Abnormal</option></select>
          </div>
          <div class="form-group form-group-wide"><label>Comments</label><textarea name="comments" rows="2" placeholder="Lab technician comments…"></textarea></div>
          <div class="form-actions">
            <button type="submit" name="action" value="draft" class="btn btn-secondary">💾 Save Draft</button>
            <button type="submit" name="action" value="finalize" class="btn btn-primary">✅ Save & Finalize</button>
          </div>
        </form>
      </div>`;
  }

  // ─── Section E: Pharmacy ─────────────────────────────────────────────────────

  _renderSectionE(prescriptions, dispensing, encounter) {
    const canWrite = ['pharmacist', 'admin'].includes(this.role);
    return `
      <section class="pf-section" id="pf-section-e">
        <div class="pf-section-header">
          <div class="pf-section-title">
            <span class="pf-section-icon">💊</span>
            <h3>Section E — Pharmacy</h3>
            <span class="pf-section-dept">Pharmacy</span>
          </div>
        </div>
        <div class="pf-section-body">
          ${this._renderDispensingHistory(dispensing)}
          ${canWrite ? this._renderDispensingForm(prescriptions, encounter) : '<p class="pf-readonly-note">Only pharmacists can record dispensing transactions.</p>'}
        </div>
      </section>`;
  }

  _renderDispensingHistory(dispensing) {
    if (!dispensing.length) return '<div class="pf-subsection"><h4>Dispensing History</h4><p class="empty-text">No dispensing records found.</p></div>';
    return `
      <div class="pf-subsection">
        <h4>Dispensing History</h4>
        ${dispensing.map(d => `
          <div class="dispensing-record">
            <div class="order-card-header">
              <span class="status-badge ${getStatusBadgeClass(d.status)}">${d.status}</span>
              <span class="order-meta">${escapeHtml(d.pharmacist?.full_name || '—')} · ${formatDate(d.dispensed_at || d.created_at, 'datetime')}</span>
            </div>
            ${(d.items || []).map(i => `
              <div class="dispensing-item">
                <strong>${escapeHtml(i.medicine?.generic_name || i.medicine?.brand_name || i.medicine?.medicine_name || i.medicine_id)}</strong>
                ${i.medicine?.strength ? ` ${escapeHtml(i.medicine.strength)}` : ''}
                — Qty: ${i.quantity_dispensed}
                ${i.batch?.batch_number ? ` · Batch: ${escapeHtml(i.batch.batch_number)}` : ''}
                ${i.batch?.expiry_date ? ` · Exp: ${formatDate(i.batch.expiry_date, 'date')}` : ''}
                ${i.substitution_reason ? `<div class="substitution-note">Substitution: ${escapeHtml(i.substitution_reason)}</div>` : ''}
              </div>`).join('')}
            ${d.notes ? `<div class="dispensing-notes">${escapeHtml(d.notes)}</div>` : ''}
          </div>`).join('')}
      </div>`;
  }

  _renderDispensingForm(prescriptions, encounter) {
    const activePrescriptions = prescriptions.filter(rx =>
      rx.status === 'active' || rx.status === 'partially_dispensed'
    );
    return `
      <div class="pf-subsection pf-write-section">
        <h4>Record Dispensing</h4>
        <form id="pf-dispensing-form" class="form-grid">
          <div class="form-group form-group-wide">
            <label>Prescription</label>
            <select id="pf-dispense-rx-select">
              <option value="">— Select prescription —</option>
              ${activePrescriptions.map(rx => `
                <option value="${escapeHtml(rx.id)}">${escapeHtml(rx.prescription_number)} · Dr. ${escapeHtml(rx.prescribing_doctor?.full_name || '—')} · ${rx.status}</option>`).join('')}
            </select>
          </div>
          <div id="pf-dispense-rx-items" class="form-group-wide">
            <p class="helper-text">Select a prescription to see its items.</p>
          </div>
          <div class="form-group form-group-wide">
            <label>Dispensing Notes</label>
            <textarea id="pf-dispense-notes" rows="2" placeholder="Counselling notes, substitutions, patient instructions…"></textarea>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-success" id="pf-save-dispense-btn">✅ Record Dispensing</button>
          </div>
        </form>
      </div>`;
  }

  // ─── Event Listeners ──────────────────────────────────────────────────────────

  _attachEventListeners(patient, encounter) {
    // Refresh
    document.getElementById('pf-refresh-btn')?.addEventListener('click', () => this.refresh());

    // Section A — Demographics edit (front_desk/admin only)
    if (['front_desk', 'admin'].includes(this.role)) {
      this._attachDemographicsListeners(patient);
    }

    // Section B — Vitals (nurse/admin only)
    if (['nurse', 'admin'].includes(this.role)) {
      this._attachVitalsListeners(patient, encounter);
    }

    // Section C — Doctor actions
    if (['doctor', 'admin'].includes(this.role)) {
      this._attachDoctorListeners(patient, encounter);
    }

    // Section D — Lab results
    if (['lab_technician', 'admin'].includes(this.role)) {
      this._attachLabListeners(patient, encounter);
    }

    // Section E — Dispensing
    if (['pharmacist', 'admin'].includes(this.role)) {
      this._attachDispensingListeners(patient, encounter);
    }
  }

  _attachDemographicsListeners(patient) {
    const editBtn = document.getElementById('pf-edit-demographics-btn');
    const cancelBtn = document.getElementById('pf-cancel-demographics-btn');
    const viewEl = document.getElementById('pf-section-a-view');
    const editEl = document.getElementById('pf-section-a-edit');
    const form = document.getElementById('pf-demographics-form');

    editBtn?.addEventListener('click', () => {
      viewEl.style.display = 'none';
      editEl.style.display = 'block';
    });
    cancelBtn?.addEventListener('click', () => {
      viewEl.style.display = 'block';
      editEl.style.display = 'none';
    });
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this._saveInProgress) return;
      this._saveInProgress = true;
      const saveBtn = document.getElementById('pf-save-demographics-btn');
      saveBtn.disabled = true;
      try {
        const updates = {
          phone: document.getElementById('pf-dem-phone').value.trim(),
          alt_phone: document.getElementById('pf-dem-alt-phone').value.trim() || null,
          email: document.getElementById('pf-dem-email').value.trim() || null,
          address: document.getElementById('pf-dem-address').value.trim() || null,
          next_of_kin: document.getElementById('pf-dem-nok').value.trim() || null,
          emergency_contact_name: document.getElementById('pf-dem-ec-name').value.trim() || null,
          emergency_contact_phone: document.getElementById('pf-dem-ec-phone').value.trim() || null,
          emergency_contact_relationship: document.getElementById('pf-dem-ec-rel').value.trim() || null,
          admin_notes: document.getElementById('pf-dem-notes').value.trim() || null,
        };
        const { error } = await supabase.from('patients').update(updates).eq('id', patient.id);
        if (error) throw error;
        showToast('Demographics updated successfully.', 'success');
        await this.refresh();
      } catch (err) {
        showToast(err.message || 'Failed to update demographics.', 'error');
      } finally {
        this._saveInProgress = false;
        saveBtn.disabled = false;
      }
    });
  }

  _attachVitalsListeners(patient, encounter) {
    const form = document.getElementById('pf-vitals-form');
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this._saveInProgress) return;
      this._saveInProgress = true;
      const saveBtn = document.getElementById('pf-save-vitals-btn');
      saveBtn.disabled = true;
      try {
        const n = id => { const el = document.getElementById(id); if (!el) return null; const v = el.value.trim(); return v === '' ? null : Number(v); };
        const weight = n('pf-weight');
        const height = n('pf-height');
        const bmi = (weight && height && height > 0)
          ? Math.round((weight / ((height / 100) ** 2)) * 10) / 10
          : null;
        const notes = document.getElementById('pf-vitals-notes')?.value.trim() || null;

        const payload = {
          patient_id: patient.id,
          encounter_id: encounter?.id || null,
          blood_pressure_systolic: n('pf-bp-sys'),
          blood_pressure_diastolic: n('pf-bp-dia'),
          pulse_rate: n('pf-pulse'),
          respiratory_rate: n('pf-rr'),
          temperature_c: n('pf-temp'),
          sp_o2: n('pf-spo2'),
          weight_kg: weight,
          height_cm: height,
          bmi: bmi,
          clinical_notes: notes,
        };
        const hasData = [
          payload.blood_pressure_systolic,
          payload.blood_pressure_diastolic,
          payload.pulse_rate,
          payload.respiratory_rate,
          payload.temperature_c,
          payload.sp_o2,
          payload.weight_kg,
          payload.height_cm,
        ].some(v => v !== null);

        if (!hasData) { showToast('Enter at least one vital sign measurement.', 'warning'); return; }
        const { error } = await recordVitals(payload);
        if (error) {
          console.error('Failed to record vitals:', {
            code: error.code,
            message: error.message,
            details: error.details,
            hint: error.hint,
          });
          throw error;
        }
        form.reset();
        showToast('Vital signs recorded successfully.', 'success');
        await this.refresh();
      } catch (err) {
        console.error('Error recording vital signs:', {
          code: err.code,
          message: err.message,
          details: err.details,
          hint: err.hint,
        });
        showToast(err.message || 'Failed to record vital signs.', 'error');
      } finally {
        this._saveInProgress = false;
        saveBtn.disabled = false;
      }
    });
  }

  _attachDoctorListeners(patient, encounter) {
    // Consultation note
    document.getElementById('pf-consultation-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this._saveInProgress) return;
      this._saveInProgress = true;
      const btn = document.getElementById('pf-save-consult-btn');
      btn.disabled = true;
      try {
        const content = document.getElementById('pf-consult-note').value.trim();
        if (!content) { showToast('Consultation note cannot be empty.', 'warning'); return; }
        const isSigned = document.getElementById('pf-sign-note').checked;
        const noteData = {
          patient_id: patient.id,
          encounter_id: encounter?.id || null,
          note_type: 'clinical',
          content,
          is_signed: isSigned,
        };
        const { data: note, error: noteErr } = await createNote(noteData);
        if (noteErr) throw noteErr;

        // Save diagnosis if provided
        const diagName = document.getElementById('pf-diagnosis-name')?.value.trim();
        if (diagName) {
          await addDiagnosis({
            patient_id: patient.id,
            encounter_id: encounter?.id || null,
            diagnosis_name: diagName,
            diagnosis_code: document.getElementById('pf-diagnosis-code')?.value.trim() || null,
          });
        }
        showToast('Consultation note saved.', 'success');
        await this.refresh();
      } catch (err) {
        showToast(err.message || 'Failed to save consultation.', 'error');
      } finally {
        this._saveInProgress = false;
        btn.disabled = false;
      }
    });

    // Lab order
    document.getElementById('pf-lab-order-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this._saveInProgress) return;
      this._saveInProgress = true;
      const btn = document.getElementById('pf-save-lab-order-btn');
      btn.disabled = true;
      try {
        const testsRaw = document.getElementById('pf-lab-tests').value.trim();
        if (!testsRaw) { showToast('Enter at least one test name.', 'warning'); return; }
        const tests = testsRaw.split(',').map(t => t.trim()).filter(Boolean);
        const orderData = {
          patient_id: patient.id,
          encounter_id: encounter?.id || null,
          clinical_indication: document.getElementById('pf-lab-indication').value.trim() || null,
          priority: document.getElementById('pf-lab-priority').value,
          status: 'pending',
        };
        const items = tests.map(t => ({ test_name: t }));
        const { error } = await createLabOrder(orderData, items);
        if (error) throw error;
        document.getElementById('pf-lab-order-form').reset();
        showToast('Laboratory order created.', 'success');
        await this.refresh();
      } catch (err) {
        showToast(err.message || 'Failed to create lab order.', 'error');
      } finally {
        this._saveInProgress = false;
        btn.disabled = false;
      }
    });

    // Add rx row
    let rxRowCount = 1;
    document.getElementById('pf-add-rx-item-btn')?.addEventListener('click', () => {
      const container = document.getElementById('pf-rx-items-container');
      const div = document.createElement('div');
      div.innerHTML = this._renderRxItemRow(rxRowCount++);
      container.appendChild(div.firstElementChild);
      container.querySelectorAll('.pf-remove-rx-row').forEach(btn => {
        btn.addEventListener('click', () => btn.closest('.rx-item-row').remove());
      });
    });

    // Prescription
    document.getElementById('pf-prescription-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this._saveInProgress) return;
      this._saveInProgress = true;
      const btn = document.getElementById('pf-save-rx-btn');
      btn.disabled = true;
      try {
        const rows = document.querySelectorAll('.rx-item-row');
        const items = [];
        for (const row of rows) {
          const name = row.querySelector('.pf-rx-med-name').value.trim();
          const qty = parseInt(row.querySelector('.pf-rx-qty').value, 10);
          if (!name || !qty) continue;
          items.push({
            medicine_name: name,
            strength: row.querySelector('.pf-rx-strength').value.trim() || null,
            dosage: row.querySelector('.pf-rx-dosage').value.trim(),
            route: row.querySelector('.pf-rx-route').value.trim(),
            frequency: row.querySelector('.pf-rx-freq').value.trim(),
            duration: row.querySelector('.pf-rx-duration').value.trim() || null,
            quantity: qty,
            instructions: row.querySelector('.pf-rx-instructions').value.trim() || null,
          });
        }
        if (!items.length) { showToast('Add at least one medicine.', 'warning'); return; }
        const rxData = {
          patient_id: patient.id,
          encounter_id: encounter?.id || null,
          notes: document.getElementById('pf-rx-notes')?.value.trim() || null,
        };
        const { error } = await createPrescription(rxData, items);
        if (error) throw error;
        document.getElementById('pf-prescription-form').reset();
        showToast('Prescription issued.', 'success');
        await this.refresh();
      } catch (err) {
        showToast(err.message || 'Failed to issue prescription.', 'error');
      } finally {
        this._saveInProgress = false;
        btn.disabled = false;
      }
    });
  }

  _attachLabListeners(patient, encounter) {
    // Accept order buttons
    document.querySelectorAll('.pf-accept-order-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const orderId = btn.dataset.orderId;
        btn.disabled = true;
        try {
          const { error } = await updateLabOrderStatus(orderId, 'in_progress', this.userId);
          if (error) throw error;
          showToast('Order accepted and in progress.', 'success');
          await this.refresh();
        } catch (err) {
          showToast(err.message || 'Failed to accept order.', 'error');
          btn.disabled = false;
        }
      });
    });

    // Result entry forms
    document.querySelectorAll('.pf-result-form').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (this._saveInProgress) return;
        this._saveInProgress = true;
        const submitter = e.submitter;
        const action = submitter?.value || 'draft';
        const orderId = form.dataset.orderId;
        const saveBtn = form.querySelector(`button[value="${action}"]`);
        if (saveBtn) saveBtn.disabled = true;
        try {
          const fd = new FormData(form);
          const resultData = {
            order_id: orderId,
            patient_id: patient.id,
            encounter_id: encounter?.id || null,
            test_name: fd.get('test_name'),
            specimen_type: fd.get('specimen_type') || null,
            result_value: fd.get('result_value'),
            unit: fd.get('unit') || null,
            reference_range: fd.get('reference_range') || null,
            is_abnormal: fd.get('is_abnormal') === 'true',
            comments: fd.get('comments') || null,
            status: action === 'finalize' ? 'finalized' : 'draft',
          };
          if (action === 'finalize') {
            resultData.verified_by = this.userId;
            resultData.verified_at = new Date().toISOString();
            resultData.finalized_by = this.userId;
            resultData.finalized_at = new Date().toISOString();
          }
          const { error } = await saveLabResult(resultData);
          if (error) throw error;

          // Update order status
          if (action === 'finalize') {
            await updateLabOrderStatus(orderId, 'completed');
          } else if (action === 'draft') {
            await updateLabOrderStatus(orderId, 'in_progress', this.userId);
          }

          showToast(`Result ${action === 'finalize' ? 'finalized' : 'saved as draft'}.`, 'success');
          await this.refresh();
        } catch (err) {
          showToast(err.message || 'Failed to save result.', 'error');
        } finally {
          this._saveInProgress = false;
          if (saveBtn) saveBtn.disabled = false;
        }
      });
    });
  }

  _attachDispensingListeners(patient, encounter) {
    const rxSelect = document.getElementById('pf-dispense-rx-select');
    const itemsContainer = document.getElementById('pf-dispense-rx-items');

    rxSelect?.addEventListener('change', async () => {
      const rxId = rxSelect.value;
      if (!rxId) {
        itemsContainer.innerHTML = '<p class="helper-text">Select a prescription to see its items.</p>';
        return;
      }
      itemsContainer.innerHTML = '<p class="loading-text">Loading prescription items…</p>';
      const { data: rx } = await supabase
        .from('prescriptions')
        .select('*, items:prescription_items(*, medicine:medicine_catalog(id, generic_name, brand_name, strength, dosage_form, current_stock))')
        .eq('id', rxId)
        .single();

      if (!rx?.items?.length) {
        itemsContainer.innerHTML = '<p class="empty-text">No items in this prescription.</p>';
        return;
      }
      itemsContainer.innerHTML = rx.items.map((item, idx) => `
        <div class="dispense-item-row" data-rx-item-id="${escapeHtml(item.id)}" data-medicine-id="${escapeHtml(item.medicine_id || '')}">
          <strong>${escapeHtml(item.medicine?.generic_name || item.medicine?.brand_name || item.medicine_name || item.generic_name || '')} ${item.strength ? escapeHtml(item.strength) : ''}</strong>
          — ${escapeHtml(item.dosage)}, ${escapeHtml(item.frequency)}
          — Prescribed: ${item.quantity}, Dispensed so far: ${item.quantity_dispensed || 0}
          ${item.medicine?.current_stock !== undefined ? ` · Stock: ${item.medicine.current_stock}` : ''}
          <div class="form-group">
            <label>Quantity to Dispense *</label>
            <input type="number" class="dispense-qty" min="1" max="${item.quantity - (item.quantity_dispensed || 0)}" 
              value="${item.quantity - (item.quantity_dispensed || 0)}" 
              data-max="${item.quantity - (item.quantity_dispensed || 0)}"
              data-medicine-id="${escapeHtml(item.medicine_id || '')}"
              data-rx-item-id="${escapeHtml(item.id)}"/>
          </div>
          <div class="form-group">
            <label>Substitution Reason (if any)</label>
            <input type="text" class="dispense-substitution" placeholder="Leave blank if dispensing exactly as prescribed"/>
          </div>
        </div>`).join('');
    });

    document.getElementById('pf-dispensing-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this._saveInProgress) return;
      this._saveInProgress = true;
      const btn = document.getElementById('pf-save-dispense-btn');
      btn.disabled = true;
      try {
        const rxId = rxSelect?.value || null;
        const rows = document.querySelectorAll('.dispense-item-row');
        const items = [];
        for (const row of rows) {
          const qtyInput = row.querySelector('.dispense-qty');
          const qty = parseInt(qtyInput?.value, 10);
          if (!qty || qty <= 0) continue;
          const max = parseInt(qtyInput.dataset.max, 10);
          if (qty > max) {
            showToast(`Cannot dispense more than ${max} units (remaining quantity).`, 'error');
            return;
          }
          items.push({
            medicine_id: row.dataset.medicineId,
            prescription_item_id: row.dataset.rxItemId || null,
            quantity_dispensed: qty,
            substitution_reason: row.querySelector('.dispense-substitution')?.value.trim() || null,
          });
        }
        if (!items.length) { showToast('Enter at least one dispensing quantity.', 'warning'); return; }
        const notes = document.getElementById('pf-dispense-notes')?.value.trim() || null;
        const { error } = await dispenseItems(patient.id, encounter?.id || null, rxId, items, notes);
        if (error) throw error;
        document.getElementById('pf-dispensing-form').reset();
        itemsContainer.innerHTML = '<p class="helper-text">Select a prescription to see its items.</p>';
        showToast('Dispensing recorded successfully.', 'success');
        await this.refresh();
      } catch (err) {
        showToast(err.message || 'Failed to record dispensing.', 'error');
      } finally {
        this._saveInProgress = false;
        btn.disabled = false;
      }
    });
  }
}

