/**
 * Dreyson Global Hospital — EMR System
 * Clinical Notes & Vitals API Module
 */

import { supabase } from '../supabase-client.js';

// ─── Vitals ───────────────────────────────────────────────────────────────────

/**
 * Record patient vitals.
 * Only nurses can insert (enforced by RLS).
 * Sanitizes payload to match public.patient_vitals schema exactly.
 * @param {Object} vitalsData
 * @returns {Promise<{data, error}>}
 */
export async function recordVitals(vitalsData) {
  const { data: userRes } = await supabase.auth.getUser();
  const userId = userRes?.user?.id;

  const weight = vitalsData.weight_kg ?? vitalsData.weight ?? null;
  const height = vitalsData.height_cm ?? vitalsData.height ?? null;
  let bmi = vitalsData.bmi ?? null;
  if (bmi === null && weight && height && Number(height) > 0) {
    bmi = Math.round((Number(weight) / ((Number(height) / 100) ** 2)) * 10) / 10;
  }

  const payload = {
    patient_id: vitalsData.patient_id,
    encounter_id: vitalsData.encounter_id || null,
    recorded_by: vitalsData.recorded_by || userId,
    temperature_c: vitalsData.temperature_c ?? vitalsData.temperature ?? null,
    pulse_rate: vitalsData.pulse_rate ?? null,
    respiratory_rate: vitalsData.respiratory_rate ?? null,
    blood_pressure_systolic: vitalsData.blood_pressure_systolic ?? vitalsData.bp_systolic ?? null,
    blood_pressure_diastolic: vitalsData.blood_pressure_diastolic ?? vitalsData.bp_diastolic ?? null,
    sp_o2: vitalsData.sp_o2 ?? vitalsData.oxygen_saturation ?? null,
    weight_kg: weight !== null ? Number(weight) : null,
    height_cm: height !== null ? Number(height) : null,
    bmi: bmi !== null ? Number(bmi) : null,
    clinical_notes: vitalsData.clinical_notes ?? vitalsData.notes ?? null,
  };

  const { data, error } = await supabase
    .from('patient_vitals')
    .insert([payload])
    .select(`
      *,
      recorded_by_profile:profiles!patient_vitals_recorded_by_fkey(full_name, role)
    `)
    .single();

  if (error) {
    console.error('Failed to record vitals:', {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
  }

  if (data) {
    data.bp_systolic = data.blood_pressure_systolic;
    data.bp_diastolic = data.blood_pressure_diastolic;
    data.temperature = data.temperature_c;
    data.oxygen_saturation = data.sp_o2;
    data.weight = data.weight_kg;
    data.height = data.height_cm;
    data.notes = data.clinical_notes;
  }

  return { data, error };
}

/**
 * Get latest vitals for an encounter.
 * @param {string} patientId
 * @param {string} [encounterId]
 * @returns {Promise<{data, error}>}
 */
export async function getPatientVitals(patientId, encounterId) {
  let query = supabase
    .from('patient_vitals')
    .select(`
      *,
      recorded_by_profile:profiles!patient_vitals_recorded_by_fkey(full_name, role)
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });

  if (encounterId) {
    query = query.eq('encounter_id', encounterId);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Failed to fetch patient vitals:', {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
  }
  if (data) {
    data.forEach(v => {
      v.bp_systolic = v.blood_pressure_systolic;
      v.bp_diastolic = v.blood_pressure_diastolic;
      v.temperature = v.temperature_c;
      v.oxygen_saturation = v.sp_o2;
      v.weight = v.weight_kg;
      v.height = v.height_cm;
      v.notes = v.clinical_notes;
    });
  }
  return { data, error };
}

// ─── Clinical Notes ───────────────────────────────────────────────────────────

/**
 * Create a clinical or nursing note.
 * @param {Object} noteData
 * @returns {Promise<{data, error}>}
 */
export async function createNote(noteData) {
  const { data: userRes } = await supabase.auth.getUser();
  const userId = userRes?.user?.id;
  const payload = {
    patient_id: noteData.patient_id,
    encounter_id: noteData.encounter_id || null,
    author_id: noteData.author_id || noteData.author || userId,
    note_type: noteData.note_type || 'clinical',
    raw_note: noteData.raw_note || noteData.content || '',
    subjective: noteData.subjective || null,
    objective: noteData.objective || null,
    assessment: noteData.assessment || null,
    plan: noteData.plan || null,
  };

  const { data, error } = await supabase
    .from('clinical_notes')
    .insert([payload])
    .select(`
      *,
      author_profile:profiles!clinical_notes_author_id_fkey(full_name, role)
    `)
    .single();

  if (data && !data.content) {
    data.content = data.raw_note || data.assessment || '';
  }
  return { data, error };
}

/**
 * Get notes for a patient encounter.
 * @param {string} patientId
 * @param {string} [encounterId]
 * @param {string} [noteType] - 'clinical' | 'nursing' | 'amendment' | null for all
 * @returns {Promise<{data, error}>}
 */
export async function getPatientNotes(patientId, encounterId, noteType) {
  let query = supabase
    .from('clinical_notes')
    .select(`
      *,
      author_profile:profiles!clinical_notes_author_id_fkey(id, full_name, role),
      amended_by_profile:profiles!clinical_notes_amended_by_fkey(full_name, role)
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });

  if (encounterId) query = query.eq('encounter_id', encounterId);
  if (noteType)    query = query.eq('note_type', noteType);

  const { data, error } = await query;
  if (data) {
    data.forEach(n => {
      if (!n.content) n.content = n.raw_note || n.assessment || '';
      n.signed_by_profile = n.amended_by_profile;
    });
  }
  return { data, error };
}

/**
 * Sign a clinical note.
 * Only the author can sign their own unsigned note.
 * @param {string} noteId
 * @returns {Promise<{data, error}>}
 */
export async function signNote(noteId) {
  const { data, error } = await supabase
    .from('clinical_notes')
    .update({
      is_amended: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', noteId)
    .select()
    .single();

  return { data, error };
}

/**
 * Update an unsigned note's content.
 * Once signed, amendments must be created separately.
 * @param {string} noteId
 * @param {string} content
 * @returns {Promise<{data, error}>}
 */
export async function updateNote(noteId, content) {
  const { data, error } = await supabase
    .from('clinical_notes')
    .update({ raw_note: content, updated_at: new Date().toISOString() })
    .eq('id', noteId)
    .select()
    .single();

  return { data, error };
}

/**
 * Create an amendment to a signed note.
 * The original note is referenced, and it gets note_type='amendment'.
 * @param {string} originalNoteId
 * @param {string} patientId
 * @param {string} encounterId
 * @param {string} content
 * @returns {Promise<{data, error}>}
 */
export async function createNoteAmendment(originalNoteId, patientId, encounterId, content) {
  const { data: { user } } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('clinical_notes')
    .insert([{
      patient_id: patientId,
      encounter_id: encounterId || null,
      note_type: 'amendment',
      raw_note: content,
      author_id: user.id,
      amendment_reason: `Amendment to note ${originalNoteId}`,
    }])
    .select()
    .single();

  return { data, error };
}

// ─── Diagnoses ────────────────────────────────────────────────────────────────

/**
 * Add a diagnosis to an encounter.
 * @param {Object} diagnosisData
 * @returns {Promise<{data, error}>}
 */
export async function addDiagnosis(diagnosisData) {
  const { data: userRes } = await supabase.auth.getUser();
  const userId = userRes?.user?.id;
  const payload = {
    patient_id: diagnosisData.patient_id,
    encounter_id: diagnosisData.encounter_id || null,
    diagnosed_by: diagnosisData.diagnosed_by || diagnosisData.recorded_by || userId,
    diagnosis_name: diagnosisData.diagnosis_name,
    diagnosis_type: diagnosisData.diagnosis_type || 'provisional',
    icd10_code: diagnosisData.icd10_code || diagnosisData.icd_code || diagnosisData.diagnosis_code || null,
    notes: diagnosisData.notes || null,
  };

  const { data, error } = await supabase
    .from('patient_diagnoses')
    .insert([payload])
    .select(`
      *,
      diagnosed_by_profile:profiles!patient_diagnoses_diagnosed_by_fkey(full_name, role)
    `)
    .single();

  if (data) {
    data.recorded_by_profile = data.diagnosed_by_profile;
    data.icd_code = data.icd10_code;
    data.diagnosis_code = data.icd10_code;
  }
  return { data, error };
}

/**
 * Get patient diagnoses.
 * @param {string} patientId
 * @param {string} [encounterId]
 * @returns {Promise<{data, error}>}
 */
export async function getPatientDiagnoses(patientId, encounterId) {
  let query = supabase
    .from('patient_diagnoses')
    .select(`
      *,
      diagnosed_by_profile:profiles!patient_diagnoses_diagnosed_by_fkey(full_name, role)
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });

  if (encounterId) query = query.eq('encounter_id', encounterId);

  const { data, error } = await query;
  if (data) {
    data.forEach(d => {
      d.recorded_by_profile = d.diagnosed_by_profile;
      d.icd_code = d.icd10_code;
      d.diagnosis_code = d.icd10_code;
    });
  }
  return { data, error };
}
