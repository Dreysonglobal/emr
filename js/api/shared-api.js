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
        .maybeSingle(),

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
        .select('*, author_profile:profiles!clinical_notes_author_id_fkey(full_name, role)')
        .eq('patient_id', patientId)
        .order('created_at', { ascending: false }),

      // Diagnoses
      supabase
        .from('patient_diagnoses')
        .select('*, diagnosed_by_profile:profiles!patient_diagnoses_diagnosed_by_fkey(full_name, role)')
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
            verified_by_profile:profiles!laboratory_results_verified_by_fkey(full_name, role)
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
            medicine:medicine_catalog(generic_name, brand_name, strength, dosage_form)
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

    // Fallback patient lookup via patient_demographics if patients table query was restricted
    let patient = patientRes.data;
    if (!patient) {
      const demoRes = await supabase
        .from('patient_demographics')
        .select('*')
        .eq('id', patientId)
        .maybeSingle();
      if (demoRes.data) {
        patient = demoRes.data;
      }
    }

    // Collect any non-RLS errors
    const nonPatientErrors = [
      encountersRes, vitalsRes, notesRes,
      diagnosesRes, allergiesRes, labOrdersRes,
      prescriptionsRes, dispensingRes,
    ].find(r => r.error)?.error;

    if (nonPatientErrors && !patient) return { error: nonPatientErrors };

    // Format diagnoses with backward-compatible aliases
    const diagnoses = (diagnosesRes.data || []).map(d => ({
      ...d,
      recorded_by_profile: d.diagnosed_by_profile,
      icd_code: d.icd10_code,
      diagnosis_code: d.icd10_code,
    }));

    // Format notes with content alias
    const notes = (notesRes.data || []).map(n => ({
      ...n,
      content: n.raw_note || n.assessment || n.content || '',
    }));

    // Format lab results with finalized_by_profile alias
    const labOrders = (labOrdersRes.data || []).map(order => ({
      ...order,
      results: (order.results || []).map(r => ({
        ...r,
        finalized_by_profile: r.verified_by_profile,
        comments: r.findings || r.comments,
      })),
    }));

    const vitals = (vitalsRes.data || []).map(v => ({
      ...v,
      bp_systolic: v.blood_pressure_systolic,
      bp_diastolic: v.blood_pressure_diastolic,
      temperature: v.temperature_c,
      oxygen_saturation: v.sp_o2,
      weight: v.weight_kg,
      height: v.height_cm,
      notes: v.clinical_notes,
    }));

    return {
      patient: patient || patientRes.data,
      encounters: encountersRes.data || [],
      vitals,
      notes,
      diagnoses,
      allergies: allergiesRes.data || [],
      labOrders,
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
  const res = await query;
  if (res.data) {
    res.data.forEach(v => {
      v.bp_systolic = v.blood_pressure_systolic;
      v.bp_diastolic = v.blood_pressure_diastolic;
      v.temperature = v.temperature_c;
      v.oxygen_saturation = v.sp_o2;
      v.weight = v.weight_kg;
      v.height = v.height_cm;
      v.notes = v.clinical_notes;
    });
  }
  return res;
}

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

  const res = await supabase
    .from('patient_vitals')
    .insert([payload])
    .select('*, recorded_by_profile:profiles!patient_vitals_recorded_by_fkey(full_name, role)')
    .single();

  if (res.error) {
    console.error('Failed to record vitals:', {
      code: res.error.code,
      message: res.error.message,
      details: res.error.details,
      hint: res.error.hint,
    });
  }

  if (res.data) {
    res.data.bp_systolic = res.data.blood_pressure_systolic;
    res.data.bp_diastolic = res.data.blood_pressure_diastolic;
    res.data.temperature = res.data.temperature_c;
    res.data.oxygen_saturation = res.data.sp_o2;
    res.data.weight = res.data.weight_kg;
    res.data.height = res.data.height_cm;
    res.data.notes = res.data.clinical_notes;
  }

  return res;
}

// ─── Clinical Notes ───────────────────────────────────────────────────────────

export async function getPatientNotes(patientId, noteType = null) {
  let query = supabase
    .from('clinical_notes')
    .select('*, author_profile:profiles!clinical_notes_author_id_fkey(full_name, role)')
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });
  if (noteType) query = query.eq('note_type', noteType);
  const res = await query;
  if (res.data) {
    res.data.forEach(n => {
      if (!n.content) n.content = n.raw_note || n.assessment || '';
    });
  }
  return res;
}

export async function createNote(noteData) {
  const { data: { user } } = await supabase.auth.getUser();
  const payload = {
    patient_id: noteData.patient_id,
    encounter_id: noteData.encounter_id || null,
    author_id: noteData.author_id || noteData.author || user.id,
    note_type: noteData.note_type || 'clinical',
    raw_note: noteData.raw_note || noteData.content || '',
    subjective: noteData.subjective || null,
    objective: noteData.objective || null,
    assessment: noteData.assessment || null,
    plan: noteData.plan || null,
  };
  const res = await supabase
    .from('clinical_notes')
    .insert([payload])
    .select('*, author_profile:profiles!clinical_notes_author_id_fkey(full_name, role)')
    .single();
  if (res.data && !res.data.content) {
    res.data.content = res.data.raw_note || res.data.assessment || '';
  }
  return res;
}

export async function signNote(noteId) {
  return supabase
    .from('clinical_notes')
    .update({ is_amended: false, updated_at: new Date().toISOString() })
    .eq('id', noteId)
    .select()
    .single();
}

// ─── Diagnoses ────────────────────────────────────────────────────────────────

export async function getPatientDiagnoses(patientId) {
  const res = await supabase
    .from('patient_diagnoses')
    .select('*, diagnosed_by_profile:profiles!patient_diagnoses_diagnosed_by_fkey(full_name, role)')
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });
  if (res.data) {
    res.data.forEach(d => {
      d.recorded_by_profile = d.diagnosed_by_profile;
      d.icd_code = d.icd10_code;
      d.diagnosis_code = d.icd10_code;
    });
  }
  return res;
}

export async function addDiagnosis(diagnosisData) {
  const { data: { user } } = await supabase.auth.getUser();
  const payload = {
    patient_id: diagnosisData.patient_id,
    encounter_id: diagnosisData.encounter_id || null,
    diagnosed_by: diagnosisData.diagnosed_by || diagnosisData.recorded_by || user.id,
    diagnosis_name: diagnosisData.diagnosis_name,
    diagnosis_type: diagnosisData.diagnosis_type || 'provisional',
    icd10_code: diagnosisData.icd10_code || diagnosisData.icd_code || diagnosisData.diagnosis_code || null,
    notes: diagnosisData.notes || null,
  };
  const res = await supabase
    .from('patient_diagnoses')
    .insert([payload])
    .select('*, diagnosed_by_profile:profiles!patient_diagnoses_diagnosed_by_fkey(full_name, role)')
    .single();
  if (res.data) {
    res.data.recorded_by_profile = res.data.diagnosed_by_profile;
    res.data.icd_code = res.data.icd10_code;
    res.data.diagnosis_code = res.data.icd10_code;
  }
  return res;
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
        verified_by_profile:profiles!laboratory_results_verified_by_fkey(full_name, role)
      )
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });
  if (status && status !== 'all') query = query.eq('status', status);
  const res = await query;
  if (res.data) {
    res.data.forEach(order => {
      if (order.results) {
        order.results.forEach(r => {
          r.finalized_by_profile = r.verified_by_profile;
          r.comments = r.findings || r.comments;
        });
      }
    });
  }
  return res;
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
  const orderPayload = {
    patient_id: orderData.patient_id,
    encounter_id: orderData.encounter_id || null,
    ordering_doctor_id: orderData.ordering_doctor_id || user.id,
    clinical_indication: orderData.clinical_indication || null,
    priority: orderData.priority || 'routine',
    status: orderData.status || 'pending',
  };

  const { data: order, error: orderErr } = await supabase
    .from('laboratory_orders')
    .insert([orderPayload])
    .select()
    .single();
  if (orderErr) return { data: null, error: orderErr };

  if (items.length > 0) {
    const sanitizedItems = items.map(item => ({
      order_id: order.id,
      test_name: item.test_name,
      test_category: item.test_category || null,
      instructions: item.instructions || item.notes || null,
    }));
    const { error: itemErr } = await supabase
      .from('laboratory_order_items')
      .insert(sanitizedItems);
    if (itemErr) return { data: order, error: itemErr };
  }
  return { data: order, error: null };
}

export async function updateLabOrderStatus(orderId, status, technicianId = null) {
  const updates = { status, updated_at: new Date().toISOString() };
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
  let res = await supabase
    .from('laboratory_results')
    .select(`
      *,
      order_item:laboratory_order_items!laboratory_results_order_item_id_fkey(id, test_name, test_category),
      performed_by_profile:profiles!laboratory_results_performed_by_fkey(full_name, role),
      verified_by_profile:profiles!laboratory_results_verified_by_fkey(full_name, role)
    `)
    .eq('order_id', orderId)
    .order('created_at', { ascending: true });

  if (res.error) {
    // Fallback if FK constraint name hint differs
    res = await supabase
      .from('laboratory_results')
      .select(`
        *,
        performed_by_profile:profiles!laboratory_results_performed_by_fkey(full_name, role),
        verified_by_profile:profiles!laboratory_results_verified_by_fkey(full_name, role)
      `)
      .eq('order_id', orderId)
      .order('created_at', { ascending: true });
  }

  if (res.data) {
    res.data.forEach(r => {
      r.finalized_by_profile = r.verified_by_profile;
      r.comments = r.findings || r.comments;
      r.unit = r.units || r.unit;
    });
  }
  return res;
}

export async function saveLabResult(resultData) {
  const { data: { user } } = await supabase.auth.getUser();
  const isFinal = resultData.status === 'finalized';

  const payload = {
    order_id: resultData.order_id,
    order_item_id: resultData.order_item_id || null,
    patient_id: resultData.patient_id,
    performed_by: resultData.performed_by || user?.id,
    result_value: resultData.result_value != null ? String(resultData.result_value) : null,
    units: resultData.units || resultData.unit || null,
    reference_range: resultData.reference_range || null,
    is_abnormal: Boolean(resultData.is_abnormal),
    critical_flag: Boolean(resultData.critical_flag),
    findings: resultData.findings || resultData.comments || null,
    recommendations: resultData.recommendations || null,
    status: isFinal ? 'finalized' : (resultData.status || 'draft'),
    verified_by: resultData.verified_by || resultData.finalized_by || (isFinal ? user?.id : null),
    verified_at: resultData.verified_at || resultData.finalized_at || (isFinal ? new Date().toISOString() : null),
    updated_at: new Date().toISOString(),
  };

  if (resultData.id) {
    return supabase
      .from('laboratory_results')
      .update(payload)
      .eq('id', resultData.id)
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
  const now = new Date().toISOString();
  return supabase
    .from('laboratory_results')
    .update({
      status: 'finalized',
      verified_by: user.id,
      verified_at: now,
      updated_at: now,
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
        medicine:medicine_catalog(generic_name, brand_name, strength, dosage_form)
      )
    `)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });
  if (status && status !== 'all') query = query.eq('status', status);
  return query;
}

export async function createPrescription(prescriptionData, items = []) {
  const { data: { user } } = await supabase.auth.getUser();
  const rxPayload = {
    patient_id: prescriptionData.patient_id,
    encounter_id: prescriptionData.encounter_id || null,
    prescribing_doctor_id: prescriptionData.prescribing_doctor_id || user.id,
    status: prescriptionData.status || 'active',
    clinical_notes: prescriptionData.clinical_notes || prescriptionData.notes || null,
  };

  const { data: rx, error: rxErr } = await supabase
    .from('prescriptions')
    .insert([rxPayload])
    .select()
    .single();
  if (rxErr) return { data: null, error: rxErr };

  if (items.length > 0) {
    const sanitizedItems = items.map(item => ({
      prescription_id: rx.id,
      medicine_id: item.medicine_id,
      dosage: item.dosage,
      frequency: item.frequency,
      duration: item.duration || null,
      quantity_prescribed: item.quantity_prescribed || item.quantity || 1,
      quantity_dispensed: item.quantity_dispensed || 0,
      special_instructions: item.special_instructions || item.instructions || null,
    }));
    const { error: itemErr } = await supabase
      .from('prescription_items')
      .insert(sanitizedItems);
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
    const { error: itemErr } = await supabase
      .from('dispensing_items')
      .insert([{ ...item, dispensing_record_id: record.id }]);
    if (itemErr) return { data: record, error: itemErr };

    const { error: stockErr } = await supabase.rpc('deduct_stock', {
      p_medicine_id: item.medicine_id,
      p_batch_id: item.batch_id || null,
      p_quantity: item.quantity_dispensed,
      p_dispensing_record_id: record.id,
      p_performed_by: user.id,
    });
    if (stockErr) return { data: record, error: stockErr };

    if (item.prescription_item_id) {
      await supabase
        .from('prescription_items')
        .update({ quantity_dispensed: item.quantity_dispensed })
        .eq('id', item.prescription_item_id);
    }
  }

  await supabase
    .from('dispensing_records')
    .update({ status: 'completed', dispensed_at: new Date().toISOString() })
    .eq('id', record.id);

  return { data: record, error: null };
}

/**
 * Simpler dispense: create record + items + call deduct_stock per item
 */
export async function dispenseItems(patientId, encounterId, prescriptionId, dispensingItems, notes) {
  if (prescriptionId) {
    const itemsPayload = dispensingItems.map(item => {
      const itemId = item.item_id || item.prescription_item_id;
      const qty = parseInt(item.quantity ?? item.quantity_dispensed, 10);
      return {
        item_id: itemId,
        prescription_item_id: itemId,
        medicine_id: item.medicine_id || null,
        batch_id: item.batch_id || null,
        quantity: isNaN(qty) ? 0 : qty,
        instructions: item.instructions || item.special_instructions || item.substitution_reason || null,
      };
    });

    const rpcArgs = {
      p_prescription_id: prescriptionId,
      p_items: itemsPayload,
      p_notes: notes || null,
    };

    console.log('Invoking dispense_prescription_atomic RPC with args:', {
      p_prescription_id: rpcArgs.p_prescription_id,
      items_count: rpcArgs.p_items.length,
      items: rpcArgs.p_items.map(i => ({ item_id: i.item_id, quantity: i.quantity }))
    });

    const { data, error } = await supabase.rpc('dispense_prescription_atomic', rpcArgs);

    if (error) {
      console.error('dispense_prescription_atomic failed in shared-api:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
        args: {
          p_prescription_id: rpcArgs.p_prescription_id,
          p_items: rpcArgs.p_items
        }
      });
      return { data: null, error };
    }
    return { data: { id: data.dispensing_record_id, ...data }, error: null };
  }

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
    .gt('quantity_remaining', 0)
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
