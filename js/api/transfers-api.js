/**
 * Dreyson Global Hospital — EMR System
 * Transfers API Module
 *
 * Handles patient file routing between departments.
 * Every transfer has a single explicit recipient_id — no broadcasts.
 * RLS policies enforce that only the sender and recipient can see a transfer.
 *
 * Confirmed Database Schema:
 *   Table: public.patient_file_transfers
 *     - id, patient_id, encounter_id, sender_id, recipient_id
 *     - from_department, to_department, priority, reason, clinical_summary
 *     - status, sent_at, received_at, completed_at, created_at, updated_at
 *
 *   Table: public.patient_file_transfer_history
 *     - id, transfer_id, patient_id, performed_by, previous_status, new_status, notes, created_at
 *
 * Foreign-key relationship hints:
 *   - Sender: patient_file_transfers_sender_id_fkey
 *   - Recipient: patient_file_transfers_recipient_id_fkey
 *   - Patient: patient_file_transfers_patient_id_fkey
 *   - Encounter: patient_file_transfers_encounter_id_fkey
 *   - Transfer history actor: patient_file_transfer_history_performed_by_fkey
 *   - Transfer history transfer: patient_file_transfer_history_transfer_id_fkey
 *   - Transfer history patient: patient_file_transfer_history_patient_id_fkey
 */

import { supabase } from '../supabase-client.js';
import { APP_CONFIG } from '../config.js';

/**
 * Send a patient file to a specific staff member.
 * @param {Object} params
 * @param {string} params.patient_id
 * @param {string} [params.encounter_id]
 * @param {string} params.recipient_id
 * @param {string} params.from_department
 * @param {string} params.to_department
 * @param {string} [params.reason]
 * @param {string} [params.priority='routine']
 * @param {string} [params.clinical_summary]
 * @returns {Promise<{data, error}>}
 */
export async function sendPatientFile({
  patient_id,
  encounter_id,
  recipient_id,
  from_department,
  to_department,
  reason,
  priority = 'routine',
  clinical_summary = null,
}) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: new Error('User not authenticated') };

  const finalFromDept = from_department || 'General';
  const finalToDept = to_department || 'General';
  const finalReason = reason || 'Patient file transfer';

  const { data, error } = await supabase
    .from('patient_file_transfers')
    .insert([{
      patient_id,
      encounter_id: encounter_id || null,
      sender_id: user.id,
      recipient_id,
      from_department: finalFromDept,
      to_department: finalToDept,
      priority,
      reason: finalReason,
      clinical_summary: clinical_summary || null,
      status: 'sent',
    }])
    .select(`
      *,
      sender:profiles!patient_file_transfers_sender_id_fkey(id, full_name, role, department),
      recipient:profiles!patient_file_transfers_recipient_id_fkey(id, full_name, role, department),
      patient:patients!patient_file_transfers_patient_id_fkey(id, hospital_number, first_name, last_name)
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
  if (!user) return { data: [], error: null };

  let query = supabase
    .from('patient_file_transfers')
    .select(`
      *,
      sender:profiles!patient_file_transfers_sender_id_fkey(id, full_name, role, department),
      recipient:profiles!patient_file_transfers_recipient_id_fkey(id, full_name, role, department),
      patient:patients!patient_file_transfers_patient_id_fkey(id, hospital_number, first_name, middle_name, last_name, date_of_birth, sex)
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
  if (!user) return { data: [], error: null };

  const { data, error } = await supabase
    .from('patient_file_transfers')
    .select(`
      *,
      sender:profiles!patient_file_transfers_sender_id_fkey(id, full_name, role, department),
      recipient:profiles!patient_file_transfers_recipient_id_fkey(id, full_name, role, department),
      patient:patients!patient_file_transfers_patient_id_fkey(id, hospital_number, first_name, last_name)
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
      patient:patients!patient_file_transfers_patient_id_fkey(id, hospital_number, first_name, middle_name, last_name, date_of_birth, sex, phone)
    `)
    .eq('id', transferId)
    .single();

  return { data, error };
}

/**
 * Acknowledge receiving a transfer (status: sent → received).
 * Only the recipient can do this.
 * Sets `received_at` (actual DB column).
 * @param {string} transferId
 * @returns {Promise<{data, error}>}
 */
export async function acknowledgeTransfer(transferId) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('patient_file_transfers')
    .update({
      status: 'received',
      received_at: now,
      updated_at: now,
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
  const now = new Date().toISOString();
  const updates = {
    status,
    updated_at: now,
  };
  if (status === 'completed') {
    updates.completed_at = now;
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
 * Get the transfer history for a patient encounter or transfer.
 * Shows the complete routing audit trail using confirmed foreign keys.
 * @param {string} patientId
 * @param {string} [transferId]
 * @returns {Promise<{data, error}>}
 */
export async function getPatientTransferHistory(patientId, transferId) {
  let query = supabase
    .from('patient_file_transfer_history')
    .select(`
      *,
      performed_by_profile:profiles!patient_file_transfer_history_performed_by_fkey(id, full_name, role, department),
      transfer:patient_file_transfers!patient_file_transfer_history_transfer_id_fkey(id, from_department, to_department, priority, reason, status)
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: true });

  if (transferId) {
    query = query.eq('transfer_id', transferId);
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
      sender:profiles!patient_file_transfers_sender_id_fkey(id, full_name, role, department),
      recipient:profiles!patient_file_transfers_recipient_id_fkey(id, full_name, role, department),
      patient:patients!patient_file_transfers_patient_id_fkey(id, hospital_number, first_name, last_name)
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });

  return { data, error };
}

/**
 * Count unread inbox items for the current user.
 * Uses `received_at` (the actual DB column).
 * "Unread" = status is 'sent' (never received) OR received but received_at is null.
 * @returns {Promise<number>}
 */
export async function countUnreadInbox() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 0;

  const { count, error } = await supabase
    .from('patient_file_transfers')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', user.id)
    .in('status', ['sent', 'received'])
    .is('received_at', null);

  return error ? 0 : (count || 0);
}
