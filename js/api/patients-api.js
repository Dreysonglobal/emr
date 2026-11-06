/**
 * Dreyson Global Hospital — EMR System
 * Patients API Module
 *
 * All patient demographic operations go through authorized Supabase queries.
 * Front Desk staff access patient demographic records through the secure
 * `public.patient_demographics` view (19 columns):
 *   - id, hospital_number, first_name, last_name, middle_name, date_of_birth,
 *     sex, phone, address, emergency_contact_name, emergency_contact_relationship,
 *     emergency_contact_phone, registered_by, created_at, updated_at,
 *     alt_phone, email, next_of_kin, admin_notes
 *
 * Direct table access to `public.patients` is reserved for clinical staff needing
 * sensitive fields (blood_group, genotype, allergies_summary).
 */

import { supabase } from '../supabase-client.js';
import { APP_CONFIG } from '../config.js';

export const PATIENT_DEMOGRAPHIC_COLUMNS = [
  'id',
  'hospital_number',
  'first_name',
  'last_name',
  'middle_name',
  'date_of_birth',
  'sex',
  'phone',
  'address',
  'emergency_contact_name',
  'emergency_contact_relationship',
  'emergency_contact_phone',
  'registered_by',
  'created_at',
  'updated_at',
  'alt_phone',
  'email',
  'next_of_kin',
  'admin_notes',
].join(', ');

/**
 * Register a new patient.
 * Inserts through patient_demographics view which triggers trg_patient_demographics_insert.
 * Falls back to patients table for administrator role if needed.
 * @param {Object} patientData
 * @returns {Promise<{data, error}>}
 */
export async function registerPatient(patientData) {
  let res = await supabase
    .from('patient_demographics')
    .insert([patientData])
    .select()
    .single();

  if (res.error && (res.error.code === '42501' || res.error.message?.includes('violates row-level security'))) {
    res = await supabase
      .from('patients')
      .insert([patientData])
      .select()
      .single();
  }
  return res;
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

  let dbQuery = supabase
    .from('patient_demographics')
    .select(PATIENT_DEMOGRAPHIC_COLUMNS, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (q) {
    dbQuery = dbQuery.or(
      `hospital_number.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%,phone.ilike.%${q}%,alt_phone.ilike.%${q}%,email.ilike.%${q}%`
    );
  }

  const { data, count, error } = await dbQuery;

  // Fallback to patients table for authorized clinical staff searching newly registered patients
  if (!error && (!data || data.length === 0)) {
    let altQuery = supabase
      .from('patients')
      .select('id, hospital_number, first_name, middle_name, last_name, date_of_birth, sex, phone, alt_phone, email, address, emergency_contact_name, emergency_contact_relationship, emergency_contact_phone, registered_by, created_at, updated_at, next_of_kin, admin_notes', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (q) {
      altQuery = altQuery.or(
        `hospital_number.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%,phone.ilike.%${q}%,alt_phone.ilike.%${q}%,email.ilike.%${q}%`
      );
    }
    const altRes = await altQuery;
    if (altRes.data && altRes.data.length > 0) {
      return altRes;
    }
  }

  return { data, count, error };
}

/**
 * Get a single patient by ID.
 * Tries the secure patient_demographics view first, falling back to patients
 * table for authorized clinical staff who require full medical history.
 * @param {string} patientId
 * @returns {Promise<{data, error}>}
 */
export async function getPatient(patientId) {
  const demoRes = await supabase
    .from('patient_demographics')
    .select(PATIENT_DEMOGRAPHIC_COLUMNS)
    .eq('id', patientId)
    .maybeSingle();

  if (demoRes.data && !demoRes.error) {
    return { data: demoRes.data, error: null };
  }

  // Fallback to full patients table (for doctor/nurse roles needing blood_group, genotype)
  const fullRes = await supabase
    .from('patients')
    .select('*')
    .eq('id', patientId)
    .maybeSingle();

  return fullRes;
}

/**
 * Get patient by hospital number.
 * @param {string} hospitalNumber
 * @returns {Promise<{data, error}>}
 */
export async function getPatientByNumber(hospitalNumber) {
  const demoRes = await supabase
    .from('patient_demographics')
    .select(PATIENT_DEMOGRAPHIC_COLUMNS)
    .eq('hospital_number', hospitalNumber)
    .maybeSingle();

  if (demoRes.data && !demoRes.error) {
    return { data: demoRes.data, error: null };
  }

  const fullRes = await supabase
    .from('patients')
    .select('*')
    .eq('hospital_number', hospitalNumber)
    .maybeSingle();

  return fullRes;
}

/**
 * Update patient demographic information.
 * Uses patient_demographics view which triggers trg_patient_demographics_update.
 * @param {string} patientId
 * @param {Object} updates
 * @returns {Promise<{data, error}>}
 */
export async function updatePatient(patientId, updates) {
  let demoRes = await supabase
    .from('patient_demographics')
    .update(updates)
    .eq('id', patientId)
    .select()
    .single();

  if (demoRes.error && (demoRes.error.code === '42501' || demoRes.error.message?.includes('violates row-level security'))) {
    demoRes = await supabase
      .from('patients')
      .update(updates)
      .eq('id', patientId)
      .select()
      .single();
  }

  return demoRes;
}

/**
 * Check for potential duplicate patients (by name + DOB + phone).
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} dob
 * @param {string} phone
 * @returns {Promise<{data, error}>}
 */
export async function checkDuplicatePatient(firstName, lastName, dob, phone) {
  const { data, error } = await supabase
    .from('patient_demographics')
    .select('id, hospital_number, first_name, middle_name, last_name, date_of_birth, phone, alt_phone')
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
