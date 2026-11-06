/**
 * Dreyson Global Hospital — EMR System
 * Transfers API Module
 *
 * Handles patient file routing between departments.
 * Every transfer has a single explicit recipient_id — no broadcasts.
 * RLS policies enforce that only the sender and recipient can see a transfer.
 */

import { supabase } from '../supabase-client.js';
import { APP_CONFIG } from '../config.js';

/**
 * Send a patient file to a specific staff member.
 * @param {Object} params
 * @param {string} params.patient_id
 * @param {string} params.encounter_id
 * @param {string} params.recipient_id - specific recipient's profile UUID
 * @param {string} params.sending_department
 * @param {string} params.receiving_department
 * @param {string} [params.message]
 * @returns {Promise<{data, error}>}
 */
export async function sendPatientFile({ patient_id, encounter_id, recipient_id, sending_department, receiving_department, message }) {
  const { data: { user } } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('patient_file_transfers')
    .insert([{
      patient_id,
      encounter_id,
      sender_id: user.id,
      recipient_id,
      sending_department,
      receiving_department,
      message: message || null,
      status: 'sent',
    }])
    .select(`
      *,
      sender:profiles!patient_file_transfers_sender_id_fkey(full_name, role, department),
      recipient:profiles!patient_file_transfers_recipient_id_fkey(full_name, role, department),
      patient:patients(hospital_number, first_name, last_name)
    `)
    .single();

  return { data, error };
}

/**
 * Get the current user's inbox (transfers where they are the recipient).
 * Only shows active/unacknowledged items with current status.
 * @param {string} statusFilter - filter by status, or 'all'
 * @returns {Promise<{data, error}>}
 */
export async function getMyInbox(statusFilter = 'active') {
  const { data: { user } } = await supabase.auth.getUser();

  let query = supabase
    .from('patient_file_transfers')
    .select(`
      *,
      sender:profiles!patient_file_transfers_sender_id_fkey(id, full_name, role, department),
      patient:patients(id, hospital_number, first_name, middle_name, last_name, date_of_birth, sex)
    `)
    .eq('recipient_id', user.id)
    .order('created_at', { ascending: false });

  if (statusFilter !== 'all') {
    if (statusFilter === 'active') {
      query = query.in('status', ['sent', 'received', 'in_progress', 'awaiting_results', 'awaiting_pharmacy']);
    } else {
      query = query.eq('status', statusFilter);
    }
  }

  const { data, error } = await query;
  return { data, error };
}

/**
 * Get transfers sent by the current user.
 * @returns {Promise<{data, error}>}
 */
export async function getMySentFiles() {
  const { data: { user } } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('patient_file_transfers')
    .select(`
      *,
      recipient:profiles!patient_file_transfers_recipient_id_fkey(id, full_name, role, department),
      patient:patients(id, hospital_number, first_name, last_name)
    `)
    .eq('sender_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  return { data, error };
}

/**
 * Get a single transfer by ID.
 * RLS ensures only sender or recipient can read it.
 * @param {string} transferId
 * @returns {Promise<{data, error}>}
 */
export async function getTransfer(transferId) {
  const { data, error } = await supabase
    .from('patient_file_transfers')
    .select(`
      *,
      sender:profiles!patient_file_transfers_sender_id_fkey(id, full_name, role, department),
      recipient:profiles!patient_file_transfers_recipient_id_fkey(id, full_name, role, department),
      patient:patients(*, registered_by_profile:profiles!patients_registered_by_fkey(full_name))
    `)
    .eq('id', transferId)
    .single();

  return { data, error };
}

/**
 * Acknowledge receiving a transfer (status: sent → received).
 * Only the recipient can do this.
 * @param {string} transferId
 * @returns {Promise<{data, error}>}
 */
export async function acknowledgeTransfer(transferId) {
  const { data, error } = await supabase
    .from('patient_file_transfers')
    .update({
      status: 'received',
      acknowledged_at: new Date().toISOString(),
    })
    .eq('id', transferId)
    .select()
    .single();

  return { data, error };
}

/**
 * Update transfer status.
 * Server RLS validates that the user is the recipient.
 * @param {string} transferId
 * @param {string} status
 * @param {string} [note]
 * @returns {Promise<{data, error}>}
 */
export async function updateTransferStatus(transferId, status, note) {
  const updates = { status };
  if (status === 'completed') {
    updates.completed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('patient_file_transfers')
    .update(updates)
    .eq('id', transferId)
    .select()
    .single();

  return { data, error };
}

/**
 * Get the transfer history for a patient encounter.
 * Shows the complete routing audit trail.
 * @param {string} patientId
 * @param {string} [encounterId]
 * @returns {Promise<{data, error}>}
 */
export async function getPatientTransferHistory(patientId, encounterId) {
  let query = supabase
    .from('patient_file_transfer_history')
    .select(`
      *,
      actor:profiles!patient_file_transfer_history_actor_id_fkey(full_name, role)
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: true });

  if (encounterId) {
    query = query.eq('encounter_id', encounterId);
  }

  const { data, error } = await query;
  return { data, error };
}

/**
 * Get all active transfers for a patient (for patient chart routing tab).
 * @param {string} patientId
 * @returns {Promise<{data, error}>}
 */
export async function getPatientTransfers(patientId) {
  const { data, error } = await supabase
    .from('patient_file_transfers')
    .select(`
      *,
      sender:profiles!patient_file_transfers_sender_id_fkey(full_name, role, department),
      recipient:profiles!patient_file_transfers_recipient_id_fkey(full_name, role, department)
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });

  return { data, error };
}

/**
 * Count unread inbox items for the current user.
 * @returns {Promise<number>}
 */
export async function countUnreadInbox() {
  const { data: { user } } = await supabase.auth.getUser();

  const { count, error } = await supabase
    .from('patient_file_transfers')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', user.id)
    .in('status', ['sent', 'received'])
    .is('acknowledged_at', null);

  return error ? 0 : (count || 0);
}
