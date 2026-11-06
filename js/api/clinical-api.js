/**
 * Dreyson Global Hospital — EMR System
 * Clinical Notes & Vitals API Module
 */

import { supabase } from '../supabase-client.js';

// ─── Vitals ───────────────────────────────────────────────────────────────────

/**
 * Record patient vitals.
 * Only nurses can insert (enforced by RLS).
 * @param {Object} vitalsData
 * @returns {Promise<{data, error}>}
 */
export async function recordVitals(vitalsData) {
  const { data, error } = await supabase
    .from('patient_vitals')
    .insert([vitalsData])
    .select()
    .single();
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
  return { data, error };
}

// ─── Clinical Notes ───────────────────────────────────────────────────────────

/**
 * Create a clinical or nursing note.
 * @param {Object} noteData
 * @returns {Promise<{data, error}>}
 */
export async function createNote(noteData) {
  const { data, error } = await supabase
    .from('clinical_notes')
    .insert([noteData])
    .select(`
      *,
      author_profile:profiles!clinical_notes_author_fkey(full_name, role)
    `)
    .single();
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
      author_profile:profiles!clinical_notes_author_fkey(id, full_name, role),
      signed_by_profile:profiles!clinical_notes_signed_by_fkey(full_name, role)
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });

  if (encounterId) query = query.eq('encounter_id', encounterId);
  if (noteType)    query = query.eq('note_type', noteType);

  const { data, error } = await query;
  return { data, error };
}

/**
 * Sign a clinical note.
 * Only the author can sign their own unsigned note.
 * @param {string} noteId
 * @returns {Promise<{data, error}>}
 */
export async function signNote(noteId) {
  const { data: { user } } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('clinical_notes')
    .update({
      is_signed: true,
      signed_at: new Date().toISOString(),
      signed_by: user.id,
    })
    .eq('id', noteId)
    .eq('is_signed', false) // only unsigned
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
    .update({ content })
    .eq('id', noteId)
    .eq('is_signed', false) // RLS also enforces this
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
      encounter_id: encounterId,
      note_type: 'amendment',
      content,
      author: user.id,
      original_note_id: originalNoteId,
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
  const { data, error } = await supabase
    .from('patient_diagnoses')
    .insert([diagnosisData])
    .select()
    .single();
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
      recorded_by_profile:profiles!patient_diagnoses_recorded_by_fkey(full_name)
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });

  if (encounterId) query = query.eq('encounter_id', encounterId);

  const { data, error } = await query;
  return { data, error };
}
