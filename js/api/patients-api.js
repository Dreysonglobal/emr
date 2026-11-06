/**
 * Dreyson Global Hospital — EMR System
 * Patients API Module
 *
 * All patient data access goes through authorized Supabase queries.
 * RLS policies on the database enforce access control.
 */

import { supabase } from '../supabase-client.js';
import { APP_CONFIG } from '../config.js';

/**
 * Register a new patient.
 * Only front_desk and admin roles can do this (enforced by RLS).
 * @param {Object} patientData
 * @returns {Promise<{data, error}>}
 */
export async function registerPatient(patientData) {
  const { data, error } = await supabase
    .from('patients')
    .insert([patientData])
    .select()
    .single();
  return { data, error };
}

/**
 * Search patients by various fields.
 * Paginated and authorized via RLS.
 * @param {string} query
 * @param {number} page
 * @param {number} pageSize
 * @returns {Promise<{data, count, error}>}
 */
export async function searchPatients(query, page = 1, pageSize = APP_CONFIG.DEFAULT_PAGE_SIZE) {
  const offset = (page - 1) * pageSize;
  const q = query?.trim() || '';

  // Use the secure patient_demographics view to provide authorized search
  // for all staff roles without exposing sensitive clinical attributes to front desk.
  let dbQuery = supabase
    .from('patient_demographics')
    .select('id, hospital_number, first_name, middle_name, last_name, date_of_birth, sex, phone, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (q) {
    // Use ilike for case-insensitive search on multiple fields
    dbQuery = dbQuery.or(
      `hospital_number.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%,phone.ilike.%${q}%`
    );
  }

  const { data, count, error } = await dbQuery;
  return { data, count, error };
}

/**
 * Get a single patient by ID.
 * @param {string} patientId
 * @returns {Promise<{data, error}>}
 */
export async function getPatient(patientId) {
  const { data, error } = await supabase
    .from('patients')
    .select('*')
    .eq('id', patientId)
    .single();

  // If access is denied by RLS (e.g. front desk role), fall back to secure demographics view
  if (error && (error.code === '42501' || error.message?.includes('violates row-level security'))) {
    const demoRes = await supabase
      .from('patient_demographics')
      .select('*')
      .eq('id', patientId)
      .single();
    return demoRes;
  }

  return { data, error };
}

/**
 * Get patient by hospital number.
 * @param {string} hospitalNumber
 * @returns {Promise<{data, error}>}
 */
export async function getPatientByNumber(hospitalNumber) {
  const { data, error } = await supabase
    .from('patients')
    .select('*')
    .eq('hospital_number', hospitalNumber)
    .single();

  if (error && (error.code === '42501' || error.message?.includes('violates row-level security'))) {
    const demoRes = await supabase
      .from('patient_demographics')
      .select('*')
      .eq('hospital_number', hospitalNumber)
      .single();
    return demoRes;
  }

  return { data, error };
}

/**
 * Update patient demographic information.
 * Only permitted fields (enforced by RLS column-level policies).
 * @param {string} patientId
 * @param {Object} updates
 * @returns {Promise<{data, error}>}
 */
export async function updatePatient(patientId, updates) {
  const { data, error } = await supabase
    .from('patients')
    .update(updates)
    .eq('id', patientId)
    .select()
    .single();

  // If update is denied by RLS (e.g. front desk role), update through secure demographics view
  if (error && (error.code === '42501' || error.message?.includes('violates row-level security'))) {
    const demoRes = await supabase
      .from('patient_demographics')
      .update(updates)
      .eq('id', patientId)
      .select()
      .single();
    return demoRes;
  }

  return { data, error };
}

/**
 * Check for potential duplicate patients (by name + DOB + phone).
 * Returns possible matches — does not auto-merge or create records.
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} dob
 * @param {string} phone
 * @returns {Promise<{data, error}>}
 */
export async function checkDuplicatePatient(firstName, lastName, dob, phone) {
  const { data, error } = await supabase
    .from('patient_demographics')
    .select('id, hospital_number, first_name, middle_name, last_name, date_of_birth, phone')
    .or(`first_name.ilike.${firstName},phone.eq.${phone}`)
    .eq('last_name', lastName)
    .limit(5);
  return { data, error };
}

// ─── Encounters ───────────────────────────────────────────────────────────────

/**
 * Create a new patient encounter.
 * @param {Object} encounterData
 * @returns {Promise<{data, error}>}
 */
export async function createEncounter(encounterData) {
  const { data, error } = await supabase
    .from('patient_encounters')
    .insert([encounterData])
    .select()
    .single();
  return { data, error };
}

/**
 * Get all encounters for a patient.
 * @param {string} patientId
 * @returns {Promise<{data, error}>}
 */
export async function getPatientEncounters(patientId) {
  const { data, error } = await supabase
    .from('patient_encounters')
    .select(`
      *,
      opened_by_profile:profiles!patient_encounters_opened_by_fkey(full_name, role)
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });
  return { data, error };
}

/**
 * Get a single encounter.
 * @param {string} encounterId
 * @returns {Promise<{data, error}>}
 */
export async function getEncounter(encounterId) {
  const { data, error } = await supabase
    .from('patient_encounters')
    .select(`*, opened_by_profile:profiles!patient_encounters_opened_by_fkey(full_name, role)`)
    .eq('id', encounterId)
    .single();
  return { data, error };
}

/**
 * Update encounter fields.
 * @param {string} encounterId
 * @param {Object} updates
 * @returns {Promise<{data, error}>}
 */
export async function updateEncounter(encounterId, updates) {
  const { data, error } = await supabase
    .from('patient_encounters')
    .update(updates)
    .eq('id', encounterId)
    .select()
    .single();
  return { data, error };
}

// ─── Allergies ────────────────────────────────────────────────────────────────

/**
 * Get patient allergies.
 * @param {string} patientId
 * @returns {Promise<{data, error}>}
 */
export async function getPatientAllergies(patientId) {
  const { data, error } = await supabase
    .from('patient_allergies')
    .select('*, recorded_by_profile:profiles!patient_allergies_recorded_by_fkey(full_name)')
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });
  return { data, error };
}

/**
 * Add a patient allergy.
 * @param {Object} allergyData
 * @returns {Promise<{data, error}>}
 */
export async function addPatientAllergy(allergyData) {
  const { data, error } = await supabase
    .from('patient_allergies')
    .insert([allergyData])
    .select()
    .single();
  return { data, error };
}
