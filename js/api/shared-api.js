/**
 * Dreyson Global Hospital — EMR System
 * Shared Clinical API Module
 *
 * Provides unified data access for all dashboards:
 * vitals, clinical notes, diagnoses, allergies,
 * lab orders, lab results, prescriptions, dispensing.
 *
 * RLS policies on the database enforce role-based write access.
 * All staff can READ via the shared patient file workflow.
 */

import { supabase } from '../supabase-client.js';

// ─── Patient File (Full Shared Record) ───────────────────────────────────────

/**
 * Get complete patient file data for the shared patient record view.
 * Returns all sections; RLS controls what the caller can actually read.
 * @param {string} patientId
 * @returns {Promise<{patient, encounters, vitals, notes, diagnoses, allergies, labOrders, labResults, prescriptions, dispensing, error}>}
 */
export async function getPatientFile(patientId) {
  try {
    const [
      patientRes,
      encountersRes,
      vitalsRes,
      notesRes,
      diagnosesRes,
      allergiesRes,
      labOrdersRes,
      prescriptionsRes,
      dispensingRes,
    ] = await Promise.all([
      // Patient demographics
      supabase
        .from('patients')
        .select('*, registered_by_profile:profiles!patients_registered_by_fkey(full_name, role)')
        .eq('id', patientId)
        .single(),

      // Encounters
      supabase
        .from('patient_encounters')
        .select('*, opened_by_profile:profiles!patient_encounters_opened_by_fkey(full_name, role)')
        .eq('patient_id', patientId)
        .order('created_at', { ascending: false }),

      // Vitals (all timestamped entries)
      supabase
        .from('patient_vitals')
        .select('*, recorded_by_profile:profiles!patient_vitals_recorded_by_fkey(full_name, role)')
        .eq('patient_id', patientId)
        .order('created_at', { ascending: false })
        .limit(50),

      // Clinical notes (doctor + nursing)
      supabase
        .from('clinical_notes')
        .select('*, author_profile:profiles!clinical_notes_author_fkey(full_name, role)')
        .eq('patient_id', patientId)
        .order('created_at', { ascending: false }),

      // Diagnoses
      supabase
        .from('patient_diagnoses')
        .select('*, recorded_by_profile:profiles!patient_diagnoses_recorded_by_fkey(full_name, role)')
        .eq('patient_id', patientId)
        .order('created_at', { ascending: false }),

      // Allergies
      supabase
        .from('patient_allergies')
        .select('*, recorded_by_profile:profiles!patient_allergies_recorded_by_fkey(full_name)')
        .eq('patient_id', patientId)
        .order('created_at', { ascending: false }),

      // Lab orders with items and results
      supabase
        .from('laboratory_orders')
        .select(`
          *,
          ordering_doctor:profiles!laboratory_orders_ordering_doctor_id_fkey(full_name, role),
          assigned_tech:profiles!laboratory_orders_assigned_technician_id_fkey(full_name, role),
          items:laboratory_order_items(*),
          results:laboratory_results(
            *,
            performed_by_profile:profiles!laboratory_results_performed_by_fkey(full_name, role),
            finalized_by_profile:profiles!laboratory_results_finalized_by_fkey(full_name, role)
          )
        `)
        .eq('patient_id', patientId)
        .order('created_at', { ascending: false }),

      // Prescriptions with items
      supabase
        .from('prescriptions')
        .select(`
          *,
          prescribing_doctor:profiles!prescriptions_prescribing_doctor_id_fkey(full_name, role),
          items:prescription_items(
            *,
            medicine:medicine_catalog(generic_name, brand_name, strength, dosage_form, unit_of_measure)
          )
        `)
        .eq('patient_id', patientId)
        .order('created_at', { ascending: false }),

      // Dispensing records with items
      supabase
        .from('dispensing_records')
        .select(`
          *,
          pharmacist:profiles!dispensing_records_pharmacist_id_fkey(full_name, role),
          items:dispensing_items(
            *,
            medicine:medicine_catalog(generic_name, brand_name, strength, dosage_form),
            batch:medicine_batches(batch_number, expiry_date)
          )
        `)
        .eq('patient_id', patientId)
        .order('created_at', { ascending: false }),
    ]);

    // Collect any errors (RLS denials return empty arrays, not errors)
    const firstError = [
      patientRes, encountersRes, vitalsRes, notesRes,
      diagnosesRes, allergiesRes, labOrdersRes,
      prescriptionsRes, dispensingRes,
    ].find(r => r.error)?.error;

    if (firstError) return { error: firstError };

    return {
      patient: patientRes.data,
      encounters: encountersRes.data || [],
      vitals: vitalsRes.data || [],
      notes: notesRes.data || [],
      diagnoses: diagnosesRes.data || [],
      allergies: allergiesRes.data || [],
      labOrders: labOrdersRes.data || [],
      prescriptions: prescriptionsRes.data || [],
      dispensing: dispensingRes.data || [],
      error: null,
    };
  } catch (err) {
    return { error: { message: err.message } };
  }
}

// ─── Vitals ───────────────────────────────────────────────────────────────────

export async function getPatientVitals(patientId, encounterId = null) {
  let query = supabase
    .from('patient_vitals')
    .select('*, recorded_by_profile:profiles!patient_vitals_recorded_by_fkey(full_name, role)')
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });
  if (encounterId) query = query.eq('encounter_id', encounterId);
  return query;
}

export async function recordVitals(vitalsData) {
  const { data: { user } } = await supabase.auth.getUser();
  return supabase
    .from('patient_vitals')
    .insert([{ ...vitalsData, recorded_by: user.id }])
    .select('*, recorded_by_profile:profiles!patient_vitals_recorded_by_fkey(full_name, role)')
    .single();
}

// ─── Clinical Notes ───────────────────────────────────────────────────────────

export async function getPatientNotes(patientId, noteType = null) {
  let query = supabase
    .from('clinical_notes')
    .select('*, author_profile:profiles!clinical_notes_author_fkey(full_name, role)')
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });
  if (noteType) query = query.eq('note_type', noteType);
  return query;
}

export async function createNote(noteData) {
  const { data: { user } } = await supabase.auth.getUser();
  return supabase
    .from('clinical_notes')
    .insert([{ ...noteData, author: user.id }])
    .select('*, author_profile:profiles!clinical_notes_author_fkey(full_name, role)')
    .single();
}

export async function signNote(noteId) {
  const { data: { user } } = await supabase.auth.getUser();
  return supabase
    .from('clinical_notes')
    .update({ is_signed: true, signed_at: new Date().toISOString(), signed_by: user.id })
    .eq('id', noteId)
    .select()
    .single();
}

// ─── Diagnoses ────────────────────────────────────────────────────────────────

export async function getPatientDiagnoses(patientId) {
  return supabase
    .from('patient_diagnoses')
    .select('*, recorded_by_profile:profiles!patient_diagnoses_recorded_by_fkey(full_name, role)')
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });
}

export async function addDiagnosis(diagnosisData) {
  const { data: { user } } = await supabase.auth.getUser();
  return supabase
    .from('patient_diagnoses')
    .insert([{ ...diagnosisData, recorded_by: user.id }])
    .select()
    .single();
}

// ─── Lab Orders ───────────────────────────────────────────────────────────────

export async function getLabOrders(patientId, status = null) {
  let query = supabase
    .from('laboratory_orders')
    .select(`
      *,
      ordering_doctor:profiles!laboratory_orders_ordering_doctor_id_fkey(full_name, role),
      assigned_tech:profiles!laboratory_orders_assigned_technician_id_fkey(full_name, role),
      items:laboratory_order_items(*),
      results:laboratory_results(
        *,
        performed_by_profile:profiles!laboratory_results_performed_by_fkey(full_name, role),
        finalized_by_profile:profiles!laboratory_results_finalized_by_fkey(full_name, role)
      )
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });
  if (status && status !== 'all') query = query.eq('status', status);
  return query;
}

export async function getAllLabOrders(status = null, limit = 50) {
  let query = supabase
    .from('laboratory_orders')
    .select(`
      *,
      patient:patients(id, hospital_number, first_name, middle_name, last_name),
      ordering_doctor:profiles!laboratory_orders_ordering_doctor_id_fkey(full_name, role),
      assigned_tech:profiles!laboratory_orders_assigned_technician_id_fkey(full_name, role),
      items:laboratory_order_items(*)
    `)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status && status !== 'all') query = query.eq('status', status);
  return query;
}

export async function createLabOrder(orderData, items = []) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data: order, error: orderErr } = await supabase
    .from('laboratory_orders')
    .insert([{ ...orderData, ordering_doctor_id: user.id }])
    .select()
    .single();
  if (orderErr) return { data: null, error: orderErr };

  if (items.length > 0) {
    const { error: itemErr } = await supabase
      .from('laboratory_order_items')
      .insert(items.map(item => ({ ...item, order_id: order.id })));
    if (itemErr) return { data: order, error: itemErr };
  }
  return { data: order, error: null };
}

export async function updateLabOrderStatus(orderId, status, technicianId = null) {
  const updates = { status };
  if (technicianId) updates.assigned_technician_id = technicianId;
  return supabase
    .from('laboratory_orders')
    .update(updates)
    .eq('id', orderId)
    .select()
    .single();
}

// ─── Lab Results ──────────────────────────────────────────────────────────────

export async function getLabResults(orderId) {
  return supabase
    .from('laboratory_results')
    .select(`
      *,
      performed_by_profile:profiles!laboratory_results_performed_by_fkey(full_name, role),
      finalized_by_profile:profiles!laboratory_results_finalized_by_fkey(full_name, role)
    `)
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });
}

export async function saveLabResult(resultData) {
  const { data: { user } } = await supabase.auth.getUser();
  const payload = { ...resultData, performed_by: user.id };

  if (payload.id) {
    const { id, ...updates } = payload;
    return supabase
      .from('laboratory_results')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
  }
  return supabase
    .from('laboratory_results')
    .insert([payload])
    .select()
    .single();
}

export async function finalizeLabResult(resultId) {
  const { data: { user } } = await supabase.auth.getUser();
  return supabase
    .from('laboratory_results')
    .update({
      status: 'finalized',
      finalized_by: user.id,
      finalized_at: new Date().toISOString(),
    })
    .eq('id', resultId)
    .select()
    .single();
}

// ─── Prescriptions ────────────────────────────────────────────────────────────

export async function getPrescriptions(patientId, status = null) {
  let query = supabase
    .from('prescriptions')
    .select(`
      *,
      prescribing_doctor:profiles!prescriptions_prescribing_doctor_id_fkey(full_name, role),
      items:prescription_items(
        *,
        medicine:medicine_catalog(generic_name, brand_name, strength, dosage_form, unit_of_measure, current_stock)
      )
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });
  if (status && status !== 'all') query = query.eq('status', status);
  return query;
}

export async function createPrescription(prescriptionData, items = []) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data: rx, error: rxErr } = await supabase
    .from('prescriptions')
    .insert([{ ...prescriptionData, prescribing_doctor_id: user.id, status: 'active' }])
    .select()
    .single();
  if (rxErr) return { data: null, error: rxErr };

  if (items.length > 0) {
    const { error: itemErr } = await supabase
      .from('prescription_items')
      .insert(items.map(item => ({ ...item, prescription_id: rx.id })));
    if (itemErr) return { data: rx, error: itemErr };
  }
  return { data: rx, error: null };
}

// ─── Dispensing ───────────────────────────────────────────────────────────────

export async function getDispensingRecords(patientId) {
  return supabase
    .from('dispensing_records')
    .select(`
      *,
      pharmacist:profiles!dispensing_records_pharmacist_id_fkey(full_name, role),
      items:dispensing_items(
        *,
        medicine:medicine_catalog(generic_name, brand_name, strength, dosage_form),
        batch:medicine_batches(batch_number, expiry_date)
      )
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });
}

export async function createDispensingRecord(recordData, items = []) {
  const { data: { user } } = await supabase.auth.getUser();

  // Create dispensing record
  const { data: record, error: recErr } = await supabase
    .from('dispensing_records')
    .insert([{ ...recordData, pharmacist_id: user.id }])
    .select()
    .single();
  if (recErr) return { data: null, error: recErr };

  // Dispense each item atomically via the deduct_stock function
  for (const item of items) {
    // Insert dispensing item
    const { error: itemErr } = await supabase
      .from('dispensing_items')
      .insert([{ ...item, dispensing_record_id: record.id }]);
    if (itemErr) return { data: record, error: itemErr };

    // Atomically deduct stock
    const { error: stockErr } = await supabase.rpc('deduct_stock', {
      p_medicine_id: item.medicine_id,
      p_batch_id: item.batch_id || null,
      p_quantity: item.quantity_dispensed,
      p_dispensing_record_id: record.id,
      p_performed_by: user.id,
    });
    if (stockErr) return { data: record, error: stockErr };

    // Update prescription item quantity_dispensed if linked
    if (item.prescription_item_id) {
      await supabase
        .from('prescription_items')
        .update({ quantity_dispensed: supabase.rpc('quantity_dispensed', {}) })
        .eq('id', item.prescription_item_id);
    }
  }

  // Mark dispensing record as completed
  await supabase
    .from('dispensing_records')
    .update({ status: 'completed', dispensed_at: new Date().toISOString() })
    .eq('id', record.id);

  return { data: record, error: null };
}

/**
 * Simpler dispense: create record + items + call deduct_stock per item
 * This version takes full control with explicit quantity tracking.
 */
export async function dispenseItems(patientId, encounterId, prescriptionId, dispensingItems, notes) {
  // Use atomic dispensing transaction function for prescription dispensing
  if (prescriptionId) {
    const itemsPayload = dispensingItems.map(item => ({
      prescription_item_id: item.prescription_item_id,
      medicine_id: item.medicine_id,
      batch_id: item.batch_id || null,
      quantity: item.quantity_dispensed,
      instructions: item.instructions || item.special_instructions || null,
    }));

    const { data, error } = await supabase.rpc('dispense_prescription_atomic', {
      p_prescription_id: prescriptionId,
      p_items: itemsPayload,
      p_notes: notes || null,
    });

    if (error) return { data: null, error };
    return { data: { id: data.dispensing_record_id, ...data }, error: null };
  }

  // Fallback for direct inventory adjustment without prescription
  const { data: { user } } = await supabase.auth.getUser();
  const { data: record, error: recErr } = await supabase
    .from('dispensing_records')
    .insert([{
      patient_id: patientId,
      encounter_id: encounterId || null,
      pharmacist_id: user.id,
      status: 'completed',
      notes: notes || null,
    }])
    .select()
    .single();
  if (recErr) return { data: null, error: recErr };

  for (const item of dispensingItems) {
    const { error: stockErr } = await supabase.rpc('deduct_stock', {
      p_medicine_id: item.medicine_id,
      p_batch_id: item.batch_id || null,
      p_quantity: item.quantity_dispensed,
      p_dispensing_record_id: record.id,
      p_performed_by: user.id,
    });
    if (stockErr) return { data: record, error: stockErr };
  }

  return { data: record, error: null };
}

// ─── Medicine Catalog & Inventory ─────────────────────────────────────────────

export async function getMedicineCatalog(activeOnly = true, limit = 200) {
  let query = supabase
    .from('medicine_catalog')
    .select('*')
    .order('generic_name', { ascending: true })
    .limit(limit);
  if (activeOnly) query = query.eq('is_active', true);
  return query;
}

export async function getMedicineBatches(medicineId) {
  return supabase
    .from('medicine_batches')
    .select('*')
    .eq('medicine_id', medicineId)
    .gt('quantity', 0)
    .order('expiry_date', { ascending: true });
}

export async function getInventoryMovements(medicineId = null, limit = 50, offset = 0) {
  let query = supabase
    .from('inventory_movements')
    .select(`
      *,
      medicine:medicine_catalog(generic_name, brand_name, strength, dosage_form),
      batch:medicine_batches(batch_number),
      performed_by_profile:profiles!inventory_movements_performed_by_fkey(full_name, role)
    `)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (medicineId) query = query.eq('medicine_id', medicineId);
  return query;
}

export async function receiveStock(medicineId, batchId, quantity, purchaseId) {
  const { data: { user } } = await supabase.auth.getUser();
  return supabase.rpc('receive_stock', {
    p_medicine_id: medicineId,
    p_batch_id: batchId || null,
    p_quantity: quantity,
    p_purchase_id: purchaseId || null,
    p_performed_by: user.id,
  });
}
