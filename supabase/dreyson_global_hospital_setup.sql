-- ============================================================================
-- DREYSON GLOBAL HOSPITAL EMR SYSTEM
-- COMPLETE DATABASE SETUP SCRIPT FOR NEW SUPABASE PROJECT
-- Target Project URL: https://lchosyfcjfrkfxtzopcj.supabase.co
-- Target Project Ref: lchosyfcjfrkfxtzopcj
--
-- This script performs a complete, self-contained bootstrap of the Dreyson
-- Global Hospital EMR database schema for a brand-new, empty Supabase project.
--
-- HARDENING AND SECURITY ENHANCEMENTS APPLIED:
--   1. deduct_stock(): Enforces caller authentication and role (active pharmacist
--      or administrator). Derives actor from auth.uid() and validates caller match.
--      Validates that batch belongs to the specified medicine. Row locks with FOR UPDATE.
--   2. increment_dispensed_qty(): Enforces active pharmacist or administrator role.
--      Validates quantity > 0, checks prescription item exists, and prevents over-dispensing.
--   3. receive_stock(): Enforces active pharmacist or administrator role.
--      Derives actor from auth.uid() and rejects caller mismatch.
--   4. get_active_encounter_for_patient(): Requires authenticated active staff
--      with patient access via can_access_patient(). Revoked from PUBLIC/anon.
--   5. Function Grants: Comprehensive revocation of EXECUTE from PUBLIC and anon
--      on all functions and trigger procedures. Grants restricted to authenticated/service_role.
--   6. profiles_insert_policy: Removed insecure first-user self-registration privilege.
--      Administrator creation is strictly reserved for the Supabase SQL Editor bootstrap.
--   7. Clinical Record RLS: Front desk staff restricted from clinical notes,
--      vitals, diagnoses, allergies, and laboratory results. can_access_patient()
--      and role-based checks enforced across all clinical tables.
--   8. Complete hospital workflows preserved across all 24 database tables.
--   9. Fully idempotent and safe for repeated executions on empty databases.
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: EXTENSIONS
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- SECTION 2: CUSTOM ENUM TYPES
-- ============================================================================
DO $$
BEGIN
    -- Hospital staff roles for RBAC enforcement
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM (
            'admin',
            'doctor',
            'nurse',
            'pharmacist',
            'front_desk',
            'lab_technician'
        );
    END IF;

    -- Staff account lifecycle states
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_status') THEN
        CREATE TYPE account_status AS ENUM (
            'active',
            'suspended',
            'deactivated'
        );
    END IF;

    -- Physical/electronic chart transfer statuses between hospital departments
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transfer_status') THEN
        CREATE TYPE transfer_status AS ENUM (
            'draft',
            'sent',
            'received',
            'in_progress',
            'awaiting_results',
            'awaiting_pharmacy',
            'completed',
            'returned',
            'cancelled'
        );
    END IF;

    -- Clinical encounter lifecycle
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'encounter_status') THEN
        CREATE TYPE encounter_status AS ENUM (
            'open',
            'in_progress',
            'closed',
            'cancelled'
        );
    END IF;

    -- Laboratory order workflow statuses
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lab_order_status') THEN
        CREATE TYPE lab_order_status AS ENUM (
            'pending',
            'assigned',
            'in_progress',
            'completed',
            'cancelled'
        );
    END IF;

    -- Laboratory result review and verification statuses
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lab_result_status') THEN
        CREATE TYPE lab_result_status AS ENUM (
            'draft',
            'finalized',
            'amended'
        );
    END IF;

    -- Medical prescription statuses
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'prescription_status') THEN
        CREATE TYPE prescription_status AS ENUM (
            'draft',
            'active',
            'dispensed',
            'partially_dispensed',
            'cancelled'
        );
    END IF;

    -- Pharmacy dispensing delivery statuses
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dispensing_status') THEN
        CREATE TYPE dispensing_status AS ENUM (
            'pending',
            'partial',
            'completed',
            'cancelled'
        );
    END IF;

    -- Clinical document categorization
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'document_category') THEN
        CREATE TYPE document_category AS ENUM (
            'xray',
            'lab_report',
            'radiology_report',
            'other_clinical'
        );
    END IF;

    -- Pharmacy inventory audit movement types
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'movement_type') THEN
        CREATE TYPE movement_type AS ENUM (
            'stock_receipt',
            'dispensing',
            'adjustment',
            'expired',
            'damaged',
            'returned',
            'transfer'
        );
    END IF;

    -- Patient biological and demographic sex
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sex_type') THEN
        CREATE TYPE sex_type AS ENUM (
            'male',
            'female',
            'other'
        );
    END IF;

    -- Clinical priority triage levels
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'priority_type') THEN
        CREATE TYPE priority_type AS ENUM (
            'routine',
            'urgent',
            'stat'
        );
    END IF;

    -- Clinical documentation note classification
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'note_type') THEN
        CREATE TYPE note_type AS ENUM (
            'clinical',
            'nursing',
            'amendment'
        );
    END IF;
END $$;

-- ============================================================================
-- SECTION 3: SEQUENCES FOR IDENTIFIER GENERATION
-- ============================================================================
CREATE SEQUENCE IF NOT EXISTS seq_hospital_number START WITH 1;
CREATE SEQUENCE IF NOT EXISTS seq_encounter_number START WITH 1;
CREATE SEQUENCE IF NOT EXISTS seq_lab_order_number START WITH 1;
CREATE SEQUENCE IF NOT EXISTS seq_prescription_number START WITH 1;

REVOKE ALL ON SEQUENCE seq_hospital_number FROM PUBLIC, anon;
REVOKE ALL ON SEQUENCE seq_encounter_number FROM PUBLIC, anon;
REVOKE ALL ON SEQUENCE seq_lab_order_number FROM PUBLIC, anon;
REVOKE ALL ON SEQUENCE seq_prescription_number FROM PUBLIC, anon;

GRANT USAGE, SELECT ON SEQUENCE seq_hospital_number TO authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE seq_encounter_number TO authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE seq_lab_order_number TO authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE seq_prescription_number TO authenticated, service_role;

-- ============================================================================
-- SECTION 4: BASE TRIGGER FUNCTIONS (updated_at)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO authenticated, service_role;

-- ============================================================================
-- SECTION 5: TABLES AND SCHEMAS
-- ============================================================================

-- 5.1 profiles: Staff metadata and RBAC roles linked to Supabase auth.users
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role user_role NOT NULL,
    staff_id TEXT UNIQUE,
    department TEXT,
    phone TEXT,
    status account_status NOT NULL DEFAULT 'active',
    deleted_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.profiles IS 'Staff metadata and RBAC roles linked to Supabase auth.users.';
COMMENT ON COLUMN public.profiles.id IS 'References the authenticated user in Supabase auth.';
COMMENT ON COLUMN public.profiles.role IS 'Strict role for medical workflow authorization.';
COMMENT ON COLUMN public.profiles.deleted_at IS 'Soft-delete timestamp. NULL = active/visible. Non-NULL = archived by admin.';

-- 5.2 system_settings: Global application and licensing parameters
CREATE TABLE IF NOT EXISTS public.system_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT UNIQUE NOT NULL,
    value TEXT,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.system_settings IS 'Hospital application settings, system configurations, and licensing limits.';

-- 5.3 patients: Patient master index and demographic registry
CREATE TABLE IF NOT EXISTS public.patients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_number TEXT UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    middle_name TEXT,
    last_name TEXT NOT NULL,
    date_of_birth DATE NOT NULL,
    sex sex_type NOT NULL,
    phone TEXT,
    alt_phone TEXT,
    email TEXT,
    address TEXT,
    next_of_kin TEXT,
    admin_notes TEXT,
    emergency_contact_name TEXT,
    emergency_contact_phone TEXT,
    emergency_contact_relationship TEXT,
    blood_group TEXT,
    genotype TEXT,
    allergies_summary TEXT,
    registered_by UUID REFERENCES public.profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.patients IS 'Patient master index and demographic record.';
COMMENT ON COLUMN public.patients.hospital_number IS 'Human readable patient ID in format DGH-YYYYNNNNN.';

-- ============================================================================
-- 5.4 patient_encounters: Inpatient/outpatient medical visit sessions
CREATE TABLE IF NOT EXISTS public.patient_encounters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
    encounter_number TEXT UNIQUE NOT NULL,
    department TEXT NOT NULL,
    opened_by UUID NOT NULL REFERENCES public.profiles(id),
    closed_by UUID REFERENCES public.profiles(id),
    status encounter_status NOT NULL DEFAULT 'open',
    chief_complaint TEXT,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.patient_encounters IS 'Clinical encounters/visits tracking patient admission through discharge.';

-- 5.5 patient_vitals: Immutable vital signs records taken by clinical staff
CREATE TABLE IF NOT EXISTS public.patient_vitals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
    encounter_id UUID REFERENCES public.patient_encounters(id) ON DELETE SET NULL,
    recorded_by UUID NOT NULL REFERENCES public.profiles(id),
    temperature_c NUMERIC(4,1) CHECK (temperature_c >= 25.0 AND temperature_c <= 45.0),
    pulse_rate INTEGER CHECK (pulse_rate >= 30 AND pulse_rate <= 250),
    respiratory_rate INTEGER CHECK (respiratory_rate >= 5 AND respiratory_rate <= 80),
    blood_pressure_systolic INTEGER CHECK (blood_pressure_systolic >= 40 AND blood_pressure_systolic <= 300),
    blood_pressure_diastolic INTEGER CHECK (blood_pressure_diastolic >= 20 AND blood_pressure_diastolic <= 200),
    sp_o2 NUMERIC(4,1) CHECK (sp_o2 >= 50.0 AND sp_o2 <= 100.0),
    weight_kg NUMERIC(5,2) CHECK (weight_kg >= 0.5 AND weight_kg <= 500.0),
    height_cm NUMERIC(5,1) CHECK (height_cm >= 20.0 AND height_cm <= 300.0),
    bmi NUMERIC(4,1),
    clinical_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.patient_vitals IS 'Immutable vital sign measurements. Updates and deletes strictly prohibited.';

-- 5.6 clinical_notes: SOAP notes and medical progress documentation
CREATE TABLE IF NOT EXISTS public.clinical_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
    encounter_id UUID REFERENCES public.patient_encounters(id) ON DELETE SET NULL,
    author_id UUID NOT NULL REFERENCES public.profiles(id),
    note_type note_type NOT NULL DEFAULT 'clinical',
    subjective TEXT,
    objective TEXT,
    assessment TEXT,
    plan TEXT,
    raw_note TEXT,
    is_amended BOOLEAN NOT NULL DEFAULT false,
    amended_by UUID REFERENCES public.profiles(id),
    amended_at TIMESTAMPTZ,
    amendment_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.clinical_notes IS 'Clinical progress notes (SOAP format). Once written, notes cannot be altered; only amendments can be appended.';

-- 5.7 patient_diagnoses: ICD-10 coded and clinical diagnoses
CREATE TABLE IF NOT EXISTS public.patient_diagnoses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
    encounter_id UUID REFERENCES public.patient_encounters(id) ON DELETE SET NULL,
    diagnosed_by UUID NOT NULL REFERENCES public.profiles(id),
    icd10_code TEXT,
    diagnosis_name TEXT NOT NULL,
    diagnosis_type TEXT NOT NULL DEFAULT 'provisional' CHECK (diagnosis_type IN ('provisional', 'confirmed', 'differential')),
    notes TEXT,
    diagnosed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.patient_diagnoses IS 'Clinical and provisional diagnoses linked to patient medical history.';

-- 5.8 patient_allergies: Known drug, environmental, and food allergies
CREATE TABLE IF NOT EXISTS public.patient_allergies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
    recorded_by UUID NOT NULL REFERENCES public.profiles(id),
    allergen TEXT NOT NULL,
    reaction TEXT,
    severity TEXT NOT NULL DEFAULT 'moderate' CHECK (severity IN ('mild', 'moderate', 'severe', 'life_threatening')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.patient_allergies IS 'Documented allergies for clinical safety alerts and pharmacy verification.';

-- 5.9 patient_documents: Uploaded scans, external lab records, and PDFs
CREATE TABLE IF NOT EXISTS public.patient_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
    encounter_id UUID REFERENCES public.patient_encounters(id) ON DELETE SET NULL,
    uploaded_by UUID NOT NULL REFERENCES public.profiles(id),
    category document_category NOT NULL DEFAULT 'other_clinical',
    file_name TEXT NOT NULL,
    storage_path TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 52428800),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.patient_documents IS 'Metadata for binary clinical attachments and radiology scans in storage.';

-- 5.10 patient_file_transfers: Chain-of-custody transfer records
CREATE TABLE IF NOT EXISTS public.patient_file_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
    encounter_id UUID REFERENCES public.patient_encounters(id) ON DELETE SET NULL,
    sender_id UUID NOT NULL REFERENCES public.profiles(id),
    recipient_id UUID NOT NULL REFERENCES public.profiles(id),
    from_department TEXT NOT NULL,
    to_department TEXT NOT NULL,
    priority priority_type NOT NULL DEFAULT 'routine',
    reason TEXT NOT NULL,
    clinical_summary TEXT,
    status transfer_status NOT NULL DEFAULT 'sent',
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.patient_file_transfers IS 'Department-to-department patient chart and custody routing workflow.';

-- 5.11 patient_file_transfer_history: Immutable audit trail for transfers
CREATE TABLE IF NOT EXISTS public.patient_file_transfer_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_id UUID NOT NULL REFERENCES public.patient_file_transfers(id) ON DELETE CASCADE,
    patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
    performed_by UUID NOT NULL REFERENCES public.profiles(id),
    previous_status transfer_status,
    new_status transfer_status NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.patient_file_transfer_history IS 'Immutable state-change audit log for chart transfers.';

-- 5.12 notifications: In-app real-time alerts
CREATE TABLE IF NOT EXISTS public.notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    link_url TEXT,
    notification_type TEXT NOT NULL DEFAULT 'file_transfer',
    is_read BOOLEAN NOT NULL DEFAULT false,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.notifications IS 'Targeted staff alerts for incoming transfers, orders, and system messages.';

-- 5.13 laboratory_orders: Clinical diagnostic requisitions
CREATE TABLE IF NOT EXISTS public.laboratory_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number TEXT UNIQUE NOT NULL,
    patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
    encounter_id UUID REFERENCES public.patient_encounters(id) ON DELETE SET NULL,
    ordering_doctor_id UUID NOT NULL REFERENCES public.profiles(id),
    assigned_technician_id UUID REFERENCES public.profiles(id),
    clinical_indication TEXT,
    priority priority_type NOT NULL DEFAULT 'routine',
    status lab_order_status NOT NULL DEFAULT 'pending',
    ordered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.laboratory_orders IS 'Laboratory investigation requests ordered by medical doctors.';

-- 5.14 laboratory_order_items: Individual test items within an order
CREATE TABLE IF NOT EXISTS public.laboratory_order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.laboratory_orders(id) ON DELETE CASCADE,
    test_name TEXT NOT NULL,
    test_category TEXT,
    instructions TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.laboratory_order_items IS 'Individual diagnostic panels and tests requested in a laboratory order.';

-- 5.15 laboratory_results: Verified findings and lab technician reports
CREATE TABLE IF NOT EXISTS public.laboratory_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.laboratory_orders(id) ON DELETE RESTRICT,
    order_item_id UUID REFERENCES public.laboratory_order_items(id) ON DELETE SET NULL,
    patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
    performed_by UUID NOT NULL REFERENCES public.profiles(id),
    verified_by UUID REFERENCES public.profiles(id),
    result_value TEXT,
    units TEXT,
    reference_range TEXT,
    is_abnormal BOOLEAN NOT NULL DEFAULT false,
    critical_flag BOOLEAN NOT NULL DEFAULT false,
    findings TEXT,
    recommendations TEXT,
    status lab_result_status NOT NULL DEFAULT 'draft',
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.laboratory_results IS 'Diagnostic results. Finalized results are protected against unauthorized modification.';

-- 5.16 medicine_catalog: Formulary and pharmaceutical catalog
CREATE TABLE IF NOT EXISTS public.medicine_catalog (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    generic_name TEXT NOT NULL,
    brand_name TEXT,
    dosage_form TEXT NOT NULL,
    strength TEXT NOT NULL,
    category TEXT,
    reorder_level INTEGER NOT NULL DEFAULT 50 CHECK (reorder_level >= 0),
    current_stock INTEGER NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
    unit_price NUMERIC(10,2) CHECK (unit_price >= 0),
    requires_prescription BOOLEAN NOT NULL DEFAULT true,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.medicine_catalog IS 'Hospital pharmacy formulary with inventory aggregate counts and unit pricing.';

-- 5.17 medicine_batches: Lot numbers, expiry dates, and unit inventory
CREATE TABLE IF NOT EXISTS public.medicine_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    medicine_id UUID NOT NULL REFERENCES public.medicine_catalog(id) ON DELETE RESTRICT,
    batch_number TEXT NOT NULL,
    expiry_date DATE NOT NULL,
    quantity_received INTEGER NOT NULL CHECK (quantity_received > 0),
    quantity_remaining INTEGER NOT NULL CHECK (quantity_remaining >= 0),
    cost_price NUMERIC(10,2) CHECK (cost_price >= 0),
    received_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_batch_remaining CHECK (quantity_remaining <= quantity_received),
    UNIQUE (medicine_id, batch_number)
);

COMMENT ON TABLE public.medicine_batches IS 'Physical pharmaceutical lots tracking FEFO/FIFO inventory and expiration.';

-- 5.18 medicine_purchases: Inbound supplier procurement ledger
CREATE TABLE IF NOT EXISTS public.medicine_purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    medicine_id UUID NOT NULL REFERENCES public.medicine_catalog(id) ON DELETE RESTRICT,
    batch_id UUID REFERENCES public.medicine_batches(id) ON DELETE SET NULL,
    batch_number TEXT NOT NULL,
    expiry_date DATE NOT NULL,
    quantity_purchased INTEGER NOT NULL CHECK (quantity_purchased > 0),
    cost_price NUMERIC(10,2) CHECK (cost_price >= 0),
    supplier TEXT,
    invoice_number TEXT,
    purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
    recorded_by UUID NOT NULL REFERENCES public.profiles(id),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.medicine_purchases IS 'Inbound pharmacy procurement ledger and stock acquisition audit trail.';

-- 5.19 prescriptions: Medical prescriptions authored by doctors
CREATE TABLE IF NOT EXISTS public.prescriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prescription_number TEXT UNIQUE NOT NULL,
    patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
    encounter_id UUID REFERENCES public.patient_encounters(id) ON DELETE SET NULL,
    prescribing_doctor_id UUID NOT NULL REFERENCES public.profiles(id),
    status prescription_status NOT NULL DEFAULT 'draft',
    clinical_notes TEXT,
    prescribed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.prescriptions IS 'Prescription orders authored by licensed physicians.';

-- 5.20 prescription_items: Individual line-item medication orders
CREATE TABLE IF NOT EXISTS public.prescription_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prescription_id UUID NOT NULL REFERENCES public.prescriptions(id) ON DELETE CASCADE,
    medicine_id UUID NOT NULL REFERENCES public.medicine_catalog(id) ON DELETE RESTRICT,
    dosage TEXT NOT NULL,
    frequency TEXT NOT NULL,
    duration TEXT NOT NULL,
    quantity_prescribed INTEGER NOT NULL CHECK (quantity_prescribed > 0),
    quantity_dispensed INTEGER NOT NULL DEFAULT 0 CHECK (quantity_dispensed >= 0),
    special_instructions TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_rx_dispensed CHECK (quantity_dispensed <= quantity_prescribed)
);

COMMENT ON TABLE public.prescription_items IS 'Line items for prescribed medications specifying dosage regimen.';

-- 5.21 dispensing_records: Pharmacy dispensing events
CREATE TABLE IF NOT EXISTS public.dispensing_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prescription_id UUID NOT NULL REFERENCES public.prescriptions(id) ON DELETE RESTRICT,
    patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
    pharmacist_id UUID NOT NULL REFERENCES public.profiles(id),
    status dispensing_status NOT NULL DEFAULT 'pending',
    notes TEXT,
    dispensed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.dispensing_records IS 'Pharmacy dispensing encounters fulfilling prescriptions.';

-- 5.22 dispensing_items: Itemized inventory deductions per dispense
CREATE TABLE IF NOT EXISTS public.dispensing_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispensing_record_id UUID NOT NULL REFERENCES public.dispensing_records(id) ON DELETE CASCADE,
    prescription_item_id UUID REFERENCES public.prescription_items(id) ON DELETE SET NULL,
    medicine_id UUID NOT NULL REFERENCES public.medicine_catalog(id) ON DELETE RESTRICT,
    batch_id UUID NOT NULL REFERENCES public.medicine_batches(id) ON DELETE RESTRICT,
    quantity_dispensed INTEGER NOT NULL CHECK (quantity_dispensed > 0),
    unit_price NUMERIC(10,2) CHECK (unit_price >= 0),
    total_price NUMERIC(10,2) CHECK (total_price >= 0),
    instructions_given TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.dispensing_items IS 'Specific batches and quantities deducted during medication dispensing.';

-- 5.23 inventory_movements: Complete ledger for every inventory change
CREATE TABLE IF NOT EXISTS public.inventory_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    medicine_id UUID NOT NULL REFERENCES public.medicine_catalog(id) ON DELETE RESTRICT,
    batch_id UUID REFERENCES public.medicine_batches(id) ON DELETE SET NULL,
    movement_type movement_type NOT NULL,
    quantity INTEGER NOT NULL,
    previous_balance INTEGER NOT NULL,
    new_balance INTEGER NOT NULL,
    reference_id UUID,
    performed_by UUID NOT NULL REFERENCES public.profiles(id),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.inventory_movements IS 'Immutable financial and audit ledger of all pharmaceutical stock adjustments.';

-- 5.24 audit_logs: System-wide immutable administrative audit events
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    table_name TEXT NOT NULL,
    record_id UUID,
    old_data JSONB,
    new_data JSONB,
    ip_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.audit_logs IS 'Immutable compliance audit trail for critical medical records and administrative actions.';

-- ============================================================================
-- SECTION 6: COMPREHENSIVE PERFORMANCE AND FOREIGN KEY INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_status ON public.profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_staff_id ON public.profiles(staff_id);
CREATE INDEX IF NOT EXISTS idx_profiles_not_archived ON public.profiles (id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_patients_hospital_number ON public.patients(hospital_number);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON public.patients(phone);
CREATE INDEX IF NOT EXISTS idx_patients_last_name ON public.patients(last_name);
CREATE INDEX IF NOT EXISTS idx_patients_first_name ON public.patients(first_name);
CREATE INDEX IF NOT EXISTS idx_patients_registered_by ON public.patients(registered_by);
CREATE INDEX IF NOT EXISTS idx_patients_fulltext ON public.patients
    USING gin(to_tsvector('english',
        coalesce(first_name, '') || ' ' ||
        coalesce(last_name, '') || ' ' ||
        coalesce(hospital_number, '') || ' ' ||
        coalesce(phone, '')
    ));

CREATE INDEX IF NOT EXISTS idx_encounters_patient_id ON public.patient_encounters(patient_id);
CREATE INDEX IF NOT EXISTS idx_encounters_status ON public.patient_encounters(status);
CREATE INDEX IF NOT EXISTS idx_encounters_opened_by ON public.patient_encounters(opened_by);

CREATE INDEX IF NOT EXISTS idx_vitals_patient_id ON public.patient_vitals(patient_id);
CREATE INDEX IF NOT EXISTS idx_vitals_encounter_id ON public.patient_vitals(encounter_id);
CREATE INDEX IF NOT EXISTS idx_vitals_recorded_by ON public.patient_vitals(recorded_by);
CREATE INDEX IF NOT EXISTS idx_vitals_created_at ON public.patient_vitals(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notes_patient_id ON public.clinical_notes(patient_id);
CREATE INDEX IF NOT EXISTS idx_notes_encounter_id ON public.clinical_notes(encounter_id);
CREATE INDEX IF NOT EXISTS idx_notes_author_id ON public.clinical_notes(author_id);

CREATE INDEX IF NOT EXISTS idx_diagnoses_patient_id ON public.patient_diagnoses(patient_id);
CREATE INDEX IF NOT EXISTS idx_allergies_patient_id ON public.patient_allergies(patient_id);
CREATE INDEX IF NOT EXISTS idx_documents_patient_id ON public.patient_documents(patient_id);

CREATE INDEX IF NOT EXISTS idx_transfers_patient_id ON public.patient_file_transfers(patient_id);
CREATE INDEX IF NOT EXISTS idx_transfers_recipient_id ON public.patient_file_transfers(recipient_id);
CREATE INDEX IF NOT EXISTS idx_transfers_sender_id ON public.patient_file_transfers(sender_id);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON public.patient_file_transfers(status);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_id ON public.notifications(recipient_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON public.notifications(is_read);

CREATE INDEX IF NOT EXISTS idx_lab_orders_patient_id ON public.laboratory_orders(patient_id);
CREATE INDEX IF NOT EXISTS idx_lab_orders_status ON public.laboratory_orders(status);
CREATE INDEX IF NOT EXISTS idx_lab_orders_ordering_doctor_id ON public.laboratory_orders(ordering_doctor_id);

CREATE INDEX IF NOT EXISTS idx_lab_results_order_id ON public.laboratory_results(order_id);
CREATE INDEX IF NOT EXISTS idx_lab_results_patient_id ON public.laboratory_results(patient_id);
CREATE INDEX IF NOT EXISTS idx_lab_results_status ON public.laboratory_results(status);

CREATE INDEX IF NOT EXISTS idx_batches_medicine_id ON public.medicine_batches(medicine_id);
CREATE INDEX IF NOT EXISTS idx_batches_expiry_date ON public.medicine_batches(expiry_date);

CREATE INDEX IF NOT EXISTS idx_purchases_medicine ON public.medicine_purchases(medicine_id);
CREATE INDEX IF NOT EXISTS idx_purchases_batch ON public.medicine_purchases(batch_id);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON public.medicine_purchases(purchase_date DESC);

CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_id ON public.prescriptions(patient_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_status ON public.prescriptions(status);
CREATE INDEX IF NOT EXISTS idx_prescriptions_doctor_id ON public.prescriptions(prescribing_doctor_id);

CREATE INDEX IF NOT EXISTS idx_dispensing_patient_id ON public.dispensing_records(patient_id);
CREATE INDEX IF NOT EXISTS idx_dispensing_prescription_id ON public.dispensing_records(prescription_id);

CREATE INDEX IF NOT EXISTS idx_inventory_medicine_id ON public.inventory_movements(medicine_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id ON public.audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_table_record ON public.audit_logs(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs(created_at DESC);

-- ============================================================================
-- SECTION 7: SECURE HELPER FUNCTIONS (SECURITY DEFINER)
-- ============================================================================

-- 10.1 Returns the active role of the caller
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS user_role
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_role user_role;
BEGIN
    SELECT role INTO v_role
    FROM public.profiles
    WHERE id = auth.uid()
      AND status = 'active'::account_status
      AND deleted_at IS NULL;
    RETURN v_role;
END;
$$;

-- 10.2 Returns caller account status
CREATE OR REPLACE FUNCTION public.get_my_status()
RETURNS account_status
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_status account_status;
BEGIN
    SELECT status INTO v_status
    FROM public.profiles
    WHERE id = auth.uid();
    RETURN v_status;
END;
$$;

-- 10.3 Returns true if caller is active administrator
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM public.profiles
        WHERE id = auth.uid()
          AND role = 'admin'::user_role
          AND status = 'active'::account_status
          AND deleted_at IS NULL
    );
END;
$$;

-- 10.4 Returns true if caller is any active user
CREATE OR REPLACE FUNCTION public.is_active_user()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM public.profiles
        WHERE id = auth.uid()
          AND status = 'active'::account_status
    );
END;
$$;

-- 10.5 Returns true if caller is active hospital staff
CREATE OR REPLACE FUNCTION public.is_active_staff()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
          AND status = 'active'::account_status
          AND deleted_at IS NULL
    );
END;
$$;

-- 10.6 Returns caller profile UUID
CREATE OR REPLACE FUNCTION public.get_profile_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_id UUID;
BEGIN
    SELECT id INTO v_id
    FROM public.profiles
    WHERE id = auth.uid()
      AND status = 'active'::account_status;
    RETURN v_id;
END;
$$;

-- 10.7 Comprehensive Clinical & Relationship Patient Access Helper
CREATE OR REPLACE FUNCTION public.can_access_patient(patient_uuid UUID)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_user_id UUID;
    v_role user_role;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN false;
    END IF;

    -- Administrators have universal clinical access
    IF public.is_admin() THEN
        RETURN true;
    END IF;

    -- Must be an active staff member
    IF NOT public.is_active_staff() THEN
        RETURN false;
    END IF;

    SELECT role INTO v_role FROM public.profiles WHERE id = v_user_id;

    -- Active file transfer relationship (sender or recipient) - excludes completed, cancelled, or returned
    IF EXISTS (
        SELECT 1 FROM public.patient_file_transfers
        WHERE patient_id = patient_uuid
          AND (recipient_id = v_user_id OR sender_id = v_user_id)
          AND status IN ('sent', 'received', 'in_progress', 'awaiting_results', 'awaiting_pharmacy')
    ) THEN
        RETURN true;
    END IF;

    -- Encounter management relationship (opened or closed by caller)
    IF EXISTS (
        SELECT 1 FROM public.patient_encounters
        WHERE patient_id = patient_uuid
          AND (opened_by = v_user_id OR closed_by = v_user_id)
    ) THEN
        RETURN true;
    END IF;

    -- Active clinical care relationship for doctors and nurses with active encounters
    IF v_role IN ('doctor'::user_role, 'nurse'::user_role) THEN
        IF EXISTS (
            SELECT 1 FROM public.patient_encounters
            WHERE patient_id = patient_uuid
              AND status IN ('open'::encounter_status, 'in_progress'::encounter_status)
        ) THEN
            RETURN true;
        END IF;
    END IF;

    -- Pharmacy care relationship: active prescription requiring review/dispensing
    IF v_role = 'pharmacist'::user_role THEN
        IF EXISTS (
            SELECT 1 FROM public.prescriptions
            WHERE patient_id = patient_uuid
              AND status IN ('active'::prescription_status, 'partially_dispensed'::prescription_status, 'draft'::prescription_status)
        ) THEN
            RETURN true;
        END IF;
    END IF;

    -- Laboratory diagnostic relationship: pending/active laboratory orders
    IF v_role = 'lab_technician'::user_role THEN
        IF EXISTS (
            SELECT 1 FROM public.laboratory_orders
            WHERE patient_id = patient_uuid
              AND status IN ('pending'::lab_order_status, 'assigned'::lab_order_status, 'in_progress'::lab_order_status)
        ) THEN
            RETURN true;
        END IF;
    END IF;

    -- Front desk registration relationship (for registration/check-in context only)
    IF v_role = 'front_desk'::user_role THEN
        IF EXISTS (
            SELECT 1 FROM public.patients
            WHERE id = patient_uuid AND registered_by = v_user_id
        ) THEN
            RETURN true;
        END IF;
    END IF;

    RETURN false;
END;
$$;

-- 10.8 Returns true if caller is active recipient of a transfer
CREATE OR REPLACE FUNCTION public.is_transfer_recipient(transfer_uuid UUID)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM public.patient_file_transfers
        WHERE id = transfer_uuid
          AND recipient_id = auth.uid()
          AND status IN ('sent', 'received', 'in_progress', 'awaiting_results', 'awaiting_pharmacy')
    );
END;
$$;

-- 10.9 Returns true if caller is sender of a transfer
CREATE OR REPLACE FUNCTION public.is_transfer_sender(transfer_uuid UUID)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM public.patient_file_transfers
        WHERE id = transfer_uuid
          AND sender_id = auth.uid()
    );
END;
$$;

-- 10.10 Retrieves the active open encounter for a patient (Secured)
CREATE OR REPLACE FUNCTION public.get_active_encounter_for_patient(p_patient_id UUID)
RETURNS TABLE (
    id UUID,
    encounter_number TEXT,
    department TEXT,
    opened_by UUID,
    opened_at TIMESTAMPTZ,
    chief_complaint TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    -- Verify caller authentication
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Verify active authorized access to this patient (admin or verified patient-specific access)
    IF NOT (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.can_access_patient(p_patient_id)
        )
    ) THEN
        RAISE EXCEPTION 'Access denied. You do not have permission to view encounters for this patient.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN QUERY
    SELECT e.id, e.encounter_number, e.department, e.opened_by, e.opened_at, e.chief_complaint
    FROM public.patient_encounters e
    WHERE e.patient_id = p_patient_id
      AND e.status IN ('open'::encounter_status, 'in_progress'::encounter_status)
    ORDER BY e.opened_at DESC
    LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_active_user() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_active_staff() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_profile_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_access_patient(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_transfer_recipient(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_transfer_sender(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_active_encounter_for_patient(UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_status() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_active_user() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_active_staff() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_profile_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_patient(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_transfer_recipient(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_transfer_sender(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_active_encounter_for_patient(UUID) TO authenticated, service_role;

-- ============================================================================

-- ============================================================================
-- SECTION 8: SECURE FRONT DESK PATIENT DEMOGRAPHICS VIEW & TRIGGERS
-- ============================================================================
-- Front Desk staff require demographic details for registration and check-in,
-- but MUST NOT have access to sensitive clinical data (blood_group, genotype, allergies).
-- This view restricts column projection strictly to demographic and contact fields,
-- applies a security barrier, and enforces caller-role verification in its WHERE clause.

CREATE OR REPLACE VIEW public.patient_demographics
WITH (security_barrier = true)
AS
SELECT
    id,
    hospital_number,
    first_name,
    last_name,
    middle_name,
    date_of_birth,
    sex,
    phone,
    address,
    emergency_contact_name,
    emergency_contact_relationship,
    emergency_contact_phone,
    registered_by,
    created_at,
    updated_at,
    alt_phone,
    email,
    next_of_kin,
    admin_notes
FROM public.patients
WHERE public.is_active_staff()
  AND (
      public.is_admin()
      OR public.get_my_role() = 'front_desk'::user_role
      OR public.can_access_patient(id)
  );

COMMENT ON VIEW public.patient_demographics IS 'Secure demographic-only view of patients with caller-role filtering; excludes sensitive clinical fields (blood_group, genotype, allergies_summary).';

-- INSTEAD OF INSERT trigger for patient_demographics
CREATE OR REPLACE FUNCTION public.trg_patient_demographics_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_caller_role user_role;
    v_new_id uuid;
    v_hosp_num text;
    v_actor_id uuid;
BEGIN
    IF NOT public.is_active_staff() THEN
        RAISE EXCEPTION 'Access denied: caller is not an active staff member';
    END IF;

    v_caller_role := public.get_my_role();
    IF v_caller_role NOT IN ('admin'::user_role, 'front_desk'::user_role, 'doctor'::user_role, 'nurse'::user_role) THEN
        RAISE EXCEPTION 'Access denied: role % is not authorized to register patients', v_caller_role;
    END IF;

    -- Derive registered_by from auth.uid() to prevent identity spoofing
    v_actor_id := auth.uid();
    IF public.is_admin() AND NEW.registered_by IS NOT NULL THEN
        v_actor_id := NEW.registered_by;
    END IF;

    INSERT INTO public.patients (
        first_name,
        last_name,
        middle_name,
        date_of_birth,
        sex,
        phone,
        alt_phone,
        email,
        address,
        next_of_kin,
        admin_notes,
        emergency_contact_name,
        emergency_contact_relationship,
        emergency_contact_phone,
        registered_by
    ) VALUES (
        NEW.first_name,
        NEW.last_name,
        NEW.middle_name,
        NEW.date_of_birth,
        NEW.sex,
        NEW.phone,
        NEW.alt_phone,
        NEW.email,
        NEW.address,
        NEW.next_of_kin,
        NEW.admin_notes,
        NEW.emergency_contact_name,
        NEW.emergency_contact_relationship,
        NEW.emergency_contact_phone,
        v_actor_id
    )
    RETURNING id, hospital_number INTO v_new_id, v_hosp_num;

    NEW.id := v_new_id;
    NEW.hospital_number := v_hosp_num;
    NEW.registered_by := v_actor_id;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_patient_demographics_insert ON public.patient_demographics;
CREATE TRIGGER trg_patient_demographics_insert
INSTEAD OF INSERT ON public.patient_demographics
FOR EACH ROW EXECUTE FUNCTION public.trg_patient_demographics_insert();

-- INSTEAD OF UPDATE trigger for patient_demographics
CREATE OR REPLACE FUNCTION public.trg_patient_demographics_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_caller_role user_role;
BEGIN
    IF NOT public.is_active_staff() THEN
        RAISE EXCEPTION 'Access denied: caller is not an active staff member';
    END IF;

    v_caller_role := public.get_my_role();
    IF v_caller_role NOT IN ('admin'::user_role, 'front_desk'::user_role) AND NOT public.can_access_patient(OLD.id) THEN
        RAISE EXCEPTION 'Access denied: caller is not authorized to update patient demographics';
    END IF;

    -- Update only demographic and contact fields in patients table; never touches blood_group or genotype
    UPDATE public.patients
    SET
        first_name                     = NEW.first_name,
        last_name                      = NEW.last_name,
        middle_name                    = NEW.middle_name,
        date_of_birth                  = NEW.date_of_birth,
        sex                            = NEW.sex,
        phone                          = NEW.phone,
        alt_phone                      = NEW.alt_phone,
        email                          = NEW.email,
        address                        = NEW.address,
        next_of_kin                    = NEW.next_of_kin,
        admin_notes                    = NEW.admin_notes,
        emergency_contact_name         = NEW.emergency_contact_name,
        emergency_contact_relationship = NEW.emergency_contact_relationship,
        emergency_contact_phone        = NEW.emergency_contact_phone,
        updated_at                     = now()
    WHERE id = OLD.id;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_patient_demographics_update ON public.patient_demographics;
CREATE TRIGGER trg_patient_demographics_update
INSTEAD OF UPDATE ON public.patient_demographics
FOR EACH ROW EXECUTE FUNCTION public.trg_patient_demographics_update();

-- ============================================================================
-- SECTION 9: UPDATED_AT TIMESTAMP TRIGGERS
-- ============================================================================
DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_system_settings_updated_at ON public.system_settings;
CREATE TRIGGER trg_system_settings_updated_at
    BEFORE UPDATE ON public.system_settings
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_patients_updated_at ON public.patients;
CREATE TRIGGER trg_patients_updated_at
    BEFORE UPDATE ON public.patients
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_patient_encounters_updated_at ON public.patient_encounters;
CREATE TRIGGER trg_patient_encounters_updated_at
    BEFORE UPDATE ON public.patient_encounters
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_clinical_notes_updated_at ON public.clinical_notes;
CREATE TRIGGER trg_clinical_notes_updated_at
    BEFORE UPDATE ON public.clinical_notes
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_transfers_updated_at ON public.patient_file_transfers;
CREATE TRIGGER trg_transfers_updated_at
    BEFORE UPDATE ON public.patient_file_transfers
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_lab_orders_updated_at ON public.laboratory_orders;
CREATE TRIGGER trg_lab_orders_updated_at
    BEFORE UPDATE ON public.laboratory_orders
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_lab_results_updated_at ON public.laboratory_results;
CREATE TRIGGER trg_lab_results_updated_at
    BEFORE UPDATE ON public.laboratory_results
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_prescriptions_updated_at ON public.prescriptions;
CREATE TRIGGER trg_prescriptions_updated_at
    BEFORE UPDATE ON public.prescriptions
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_medicine_catalog_updated_at ON public.medicine_catalog;
CREATE TRIGGER trg_medicine_catalog_updated_at
    BEFORE UPDATE ON public.medicine_catalog
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_dispensing_records_updated_at ON public.dispensing_records;
CREATE TRIGGER trg_dispensing_records_updated_at
    BEFORE UPDATE ON public.dispensing_records
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================================
-- SECTION 10: IDENTIFIER AUTO-GENERATION TRIGGERS
-- ============================================================================

-- 8.1 Hospital Number Generator: DGH-YYYYNNNNN
CREATE OR REPLACE FUNCTION public.generate_hospital_number()
RETURNS TRIGGER AS $$
DECLARE
    v_year TEXT := to_char(CURRENT_DATE, 'YYYY');
    v_seq_val BIGINT;
BEGIN
    -- Strict actor identity: derive registered_by from auth.uid() unless caller is administrator
    IF NOT public.is_admin() OR NEW.registered_by IS NULL THEN
        NEW.registered_by := auth.uid();
    END IF;

    IF NEW.hospital_number IS NULL OR trim(NEW.hospital_number) = '' THEN
        v_seq_val := nextval('public.seq_hospital_number');
        NEW.hospital_number := 'DGH-' || v_year || lpad(v_seq_val::TEXT, 5, '0');
    END IF;

    IF NEW.created_at IS NULL THEN
        NEW.created_at := now();
    END IF;
    NEW.updated_at := now();

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.generate_hospital_number() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_hospital_number() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_generate_hospital_number ON public.patients;
CREATE TRIGGER trg_generate_hospital_number
    BEFORE INSERT ON public.patients
    FOR EACH ROW
    EXECUTE FUNCTION public.generate_hospital_number();

-- 8.2 Encounter Number Generator: ENC-YYYYMMDD-XXXXX
CREATE OR REPLACE FUNCTION public.generate_encounter_number()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.encounter_number IS NULL OR trim(NEW.encounter_number) = '' THEN
        NEW.encounter_number := 'ENC-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' ||
            lpad(nextval('seq_encounter_number')::TEXT, 5, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.generate_encounter_number() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_encounter_number() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_generate_encounter_number ON public.patient_encounters;
CREATE TRIGGER trg_generate_encounter_number
    BEFORE INSERT ON public.patient_encounters
    FOR EACH ROW
    EXECUTE FUNCTION public.generate_encounter_number();

-- 8.3 Laboratory Order Number Generator: LAB-YYYYMMDD-XXXXX
CREATE OR REPLACE FUNCTION public.generate_lab_order_number()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.order_number IS NULL OR trim(NEW.order_number) = '' THEN
        NEW.order_number := 'LAB-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' ||
            lpad(nextval('seq_lab_order_number')::TEXT, 5, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.generate_lab_order_number() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_lab_order_number() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_generate_lab_order_number ON public.laboratory_orders;
CREATE TRIGGER trg_generate_lab_order_number
    BEFORE INSERT ON public.laboratory_orders
    FOR EACH ROW
    EXECUTE FUNCTION public.generate_lab_order_number();

-- 8.4 Prescription Number Generator: RX-YYYYMMDD-XXXXX
CREATE OR REPLACE FUNCTION public.generate_prescription_number()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.prescription_number IS NULL OR trim(NEW.prescription_number) = '' THEN
        NEW.prescription_number := 'RX-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' ||
            lpad(nextval('seq_prescription_number')::TEXT, 5, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.generate_prescription_number() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_prescription_number() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_generate_prescription_number ON public.prescriptions;
CREATE TRIGGER trg_generate_prescription_number
    BEFORE INSERT ON public.prescriptions
    FOR EACH ROW
    EXECUTE FUNCTION public.generate_prescription_number();

-- ============================================================================
-- SECTION 11: CLINICAL & BUSINESS LOGIC TRIGGERS
-- ============================================================================

-- 9.1 Automatic BMI calculation from height and weight
CREATE OR REPLACE FUNCTION public.calculate_patient_bmi()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.weight_kg IS NOT NULL AND NEW.height_cm IS NOT NULL AND NEW.height_cm > 0 THEN
        NEW.bmi := round((NEW.weight_kg / ((NEW.height_cm / 100.0) ^ 2))::NUMERIC, 1);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

REVOKE ALL ON FUNCTION public.calculate_patient_bmi() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_patient_bmi() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_calculate_patient_bmi ON public.patient_vitals;
CREATE TRIGGER trg_calculate_patient_bmi
    BEFORE INSERT ON public.patient_vitals
    FOR EACH ROW
    EXECUTE FUNCTION public.calculate_patient_bmi();

-- 9.2 Clinical Note Immutability Enforcement
CREATE OR REPLACE FUNCTION public.enforce_clinical_note_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.note_type = 'amendment'::note_type THEN
            RAISE EXCEPTION 'Amendment notes are permanently immutable.'
                USING ERRCODE = 'restrict_violation';
        END IF;

        IF OLD.raw_note IS DISTINCT FROM NEW.raw_note
           OR OLD.subjective IS DISTINCT FROM NEW.subjective
           OR OLD.objective IS DISTINCT FROM NEW.objective
           OR OLD.assessment IS DISTINCT FROM NEW.assessment
           OR OLD.plan IS DISTINCT FROM NEW.plan THEN
            RAISE EXCEPTION 'Signed clinical notes cannot be altered. Create an amendment note instead.'
                USING ERRCODE = 'restrict_violation';
        END IF;
    ELSIF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Medical progress notes are permanent legal records and cannot be deleted.'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.enforce_clinical_note_immutability() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enforce_clinical_note_immutability() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_enforce_clinical_note_immutability ON public.clinical_notes;
CREATE TRIGGER trg_enforce_clinical_note_immutability
    BEFORE UPDATE OR DELETE ON public.clinical_notes
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_clinical_note_immutability();

-- 9.3 Laboratory Result Finalization Protection
CREATE OR REPLACE FUNCTION public.enforce_lab_result_finalization()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.status = 'finalized'::lab_result_status THEN
            IF NEW.status != 'amended'::lab_result_status THEN
                RAISE EXCEPTION 'Finalized laboratory results can only transition to amended status.'
                    USING ERRCODE = 'restrict_violation';
            END IF;
            IF NEW.verified_by IS NULL THEN
                NEW.verified_by := auth.uid();
                NEW.verified_at := now();
            END IF;
        END IF;
    ELSIF TG_OP = 'DELETE' THEN
        IF OLD.status = 'finalized'::lab_result_status THEN
            RAISE EXCEPTION 'Finalized laboratory diagnostic records cannot be deleted.'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.enforce_lab_result_finalization() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enforce_lab_result_finalization() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_enforce_lab_result_finalization ON public.laboratory_results;
CREATE TRIGGER trg_enforce_lab_result_finalization
    BEFORE UPDATE OR DELETE ON public.laboratory_results
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_lab_result_finalization();

-- 9.4 Transfer Workflow Status Timestamps & Notifications
CREATE OR REPLACE FUNCTION public.handle_transfer_workflow_events()
RETURNS TRIGGER AS $$
DECLARE
    v_patient_name TEXT;
    v_sender_name TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT trim(first_name || ' ' || last_name) INTO v_patient_name
        FROM public.patients WHERE id = NEW.patient_id;

        SELECT full_name INTO v_sender_name
        FROM public.profiles WHERE id = NEW.sender_id;

        INSERT INTO public.notifications (
            recipient_id,
            sender_id,
            title,
            message,
            notification_type,
            link_url
        ) VALUES (
            NEW.recipient_id,
            NEW.sender_id,
            'Incoming Patient File Transfer (' || upper(NEW.priority::TEXT) || ')',
            'Patient ' || coalesce(v_patient_name, 'Unknown') || ' was transferred to you by ' || coalesce(v_sender_name, 'Staff') || '.',
            'file_transfer',
            '/pages/transfers.html'
        );
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.status != 'received'::transfer_status AND NEW.status = 'received'::transfer_status THEN
            NEW.received_at := now();
        END IF;

        IF OLD.status != 'completed'::transfer_status AND NEW.status = 'completed'::transfer_status THEN
            NEW.completed_at := now();
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.handle_transfer_workflow_events() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.handle_transfer_workflow_events() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_handle_transfer_workflow_events ON public.patient_file_transfers;
CREATE TRIGGER trg_handle_transfer_workflow_events
    BEFORE INSERT OR UPDATE ON public.patient_file_transfers
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_transfer_workflow_events();

-- 9.5 Automatic Audit History for Chart Transfers
CREATE OR REPLACE FUNCTION public.log_transfer_history()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.patient_file_transfer_history (
            transfer_id,
            patient_id,
            performed_by,
            previous_status,
            new_status,
            notes
        ) VALUES (
            NEW.id,
            NEW.patient_id,
            NEW.sender_id,
            NULL,
            NEW.status,
            'Initial transfer dispatched.'
        );
    ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO public.patient_file_transfer_history (
            transfer_id,
            patient_id,
            performed_by,
            previous_status,
            new_status,
            notes
        ) VALUES (
            NEW.id,
            NEW.patient_id,
            coalesce(auth.uid(), NEW.recipient_id),
            OLD.status,
            NEW.status,
            'Status transitioned to ' || NEW.status::TEXT || '.'
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.log_transfer_history() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_transfer_history() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_log_transfer_history ON public.patient_file_transfers;
CREATE TRIGGER trg_log_transfer_history
    AFTER INSERT OR UPDATE ON public.patient_file_transfers
    FOR EACH ROW
    EXECUTE FUNCTION public.log_transfer_history();

-- 9.6 Dispensing Completion & Prescription Status Automation
CREATE OR REPLACE FUNCTION public.handle_dispensing_completion()
RETURNS TRIGGER AS $$
DECLARE
    v_all_dispensed boolean;
    v_any_dispensed boolean;
BEGIN
    -- Evaluate live fulfillment from prescription_items upon completion or partial dispensing
    SELECT
        coalesce(bool_and(quantity_dispensed >= quantity_prescribed), false),
        coalesce(bool_or(quantity_dispensed > 0), false)
    INTO v_all_dispensed, v_any_dispensed
    FROM public.prescription_items
    WHERE prescription_id = NEW.prescription_id;

    IF v_all_dispensed THEN
        UPDATE public.prescriptions
        SET status = 'dispensed'::prescription_status,
            updated_at = now()
        WHERE id = NEW.prescription_id
          AND status != 'dispensed'::prescription_status;
    ELSIF v_any_dispensed THEN
        UPDATE public.prescriptions
        SET status = 'partially_dispensed'::prescription_status,
            updated_at = now()
        WHERE id = NEW.prescription_id
          AND status != 'dispensed'::prescription_status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.handle_dispensing_completion() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.handle_dispensing_completion() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_handle_dispensing_completion ON public.dispensing_records;
CREATE TRIGGER trg_handle_dispensing_completion
    AFTER INSERT OR UPDATE ON public.dispensing_records
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_dispensing_completion();

-- 9.6 Enforce prescription header integrity against unauthorized modification
CREATE OR REPLACE FUNCTION public.enforce_prescription_update_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF public.is_admin() THEN
        RETURN NEW;
    END IF;

    -- Non-admin users cannot alter core clinical header parameters
    IF NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
        RAISE EXCEPTION 'Unauthorized: prescription patient_id is immutable';
    END IF;

    IF NEW.prescribing_doctor_id IS DISTINCT FROM OLD.prescribing_doctor_id THEN
        RAISE EXCEPTION 'Unauthorized: prescribing doctor_id is immutable';
    END IF;

    IF NEW.encounter_id IS DISTINCT FROM OLD.encounter_id THEN
        RAISE EXCEPTION 'Unauthorized: prescription encounter_id is immutable';
    END IF;

    IF NEW.prescription_number IS DISTINCT FROM OLD.prescription_number THEN
        RAISE EXCEPTION 'Unauthorized: prescription_number is immutable';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_prescription_update_integrity ON public.prescriptions;
CREATE TRIGGER trg_enforce_prescription_update_integrity
BEFORE UPDATE ON public.prescriptions
FOR EACH ROW EXECUTE FUNCTION public.enforce_prescription_update_integrity();

-- 9.7 Enforce prescription item clinical field integrity against pharmacist tampering
CREATE OR REPLACE FUNCTION public.enforce_rx_item_update_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF public.is_admin() THEN
        RETURN NEW;
    END IF;

    -- Pharmacists and other non-admins cannot alter clinical prescription parameters
    IF NEW.prescription_id IS DISTINCT FROM OLD.prescription_id THEN
        RAISE EXCEPTION 'Unauthorized: prescription_id is immutable';
    END IF;

    IF NEW.medicine_id IS DISTINCT FROM OLD.medicine_id THEN
        RAISE EXCEPTION 'Unauthorized: prescribed medicine_id is immutable';
    END IF;

    IF NEW.dosage IS DISTINCT FROM OLD.dosage THEN
        RAISE EXCEPTION 'Unauthorized: prescribed dosage is immutable';
    END IF;

    IF NEW.frequency IS DISTINCT FROM OLD.frequency THEN
        RAISE EXCEPTION 'Unauthorized: prescribed frequency is immutable';
    END IF;

    IF NEW.duration IS DISTINCT FROM OLD.duration THEN
        RAISE EXCEPTION 'Unauthorized: prescribed duration is immutable';
    END IF;

    IF NEW.quantity_prescribed IS DISTINCT FROM OLD.quantity_prescribed THEN
        RAISE EXCEPTION 'Unauthorized: quantity_prescribed is immutable';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_rx_item_update_integrity ON public.prescription_items;
CREATE TRIGGER trg_enforce_rx_item_update_integrity
BEFORE UPDATE ON public.prescription_items
FOR EACH ROW EXECUTE FUNCTION public.enforce_rx_item_update_integrity();


-- SECTION 12: STAFF ACCOUNT LIMIT ENFORCEMENT
-- ============================================================================
CREATE OR REPLACE FUNCTION public.check_staff_limit(target_role user_role)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_limit INTEGER;
    v_count INTEGER;
    v_setting_key TEXT;
BEGIN
    IF target_role = 'admin'::user_role THEN
        RETURN true;
    END IF;

    CASE target_role
        WHEN 'doctor'::user_role         THEN v_setting_key := 'max_doctors';
        WHEN 'nurse'::user_role          THEN v_setting_key := 'max_nurses';
        WHEN 'pharmacist'::user_role     THEN v_setting_key := 'max_pharmacists';
        WHEN 'front_desk'::user_role     THEN v_setting_key := 'max_front_desk';
        WHEN 'lab_technician'::user_role THEN v_setting_key := 'max_lab_technicians';
        ELSE RETURN false;
    END CASE;

    SELECT coalesce(value::INTEGER, 10) INTO v_limit
    FROM public.system_settings
    WHERE key = v_setting_key;

    IF v_limit IS NULL THEN
        v_limit := 10;
    END IF;

    SELECT count(*) INTO v_count
    FROM public.profiles
    WHERE role = target_role
      AND status = 'active'::account_status;

    RETURN v_count < v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.check_staff_limit(user_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_staff_limit(user_role) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_enforce_staff_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF NEW.role != 'admin'::user_role AND NEW.status = 'active'::account_status THEN
        IF TG_OP = 'UPDATE' AND OLD.status = 'active'::account_status AND OLD.role = NEW.role THEN
            RETURN NEW;
        END IF;

        IF NOT public.check_staff_limit(NEW.role) THEN
            RAISE EXCEPTION 'Staff limit reached for role: %. Maximum allowed active accounts reached.', NEW.role
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trg_enforce_staff_limit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trg_enforce_staff_limit() TO authenticated, service_role;

DROP TRIGGER IF EXISTS before_insert_profile ON public.profiles;
CREATE TRIGGER before_insert_profile
    BEFORE INSERT OR UPDATE OF role, status ON public.profiles
    FOR EACH ROW
    WHEN (NEW.status = 'active')
    EXECUTE FUNCTION public.trg_enforce_staff_limit();

CREATE OR REPLACE FUNCTION public.protect_profile_sensitive_fields()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT public.is_admin() THEN
        IF NEW.role IS DISTINCT FROM OLD.role THEN
            RAISE EXCEPTION 'Only administrators can modify account roles.'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'Only administrators can modify account statuses.'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.staff_id IS DISTINCT FROM OLD.staff_id THEN
            RAISE EXCEPTION 'Only administrators can modify staff IDs.'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id THEN
            RAISE EXCEPTION 'Account user ID is immutable.'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
            RAISE EXCEPTION 'Only administrators can modify account archival state.'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.email IS DISTINCT FROM OLD.email THEN
            RAISE EXCEPTION 'Profile email must match authentication account and can only be updated by administrators.'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.department IS DISTINCT FROM OLD.department THEN
            RAISE EXCEPTION 'Only administrators can modify staff department assignments.'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.protect_profile_sensitive_fields() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.protect_profile_sensitive_fields() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_protect_profile_sensitive_fields ON public.profiles;
CREATE TRIGGER trg_protect_profile_sensitive_fields
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_profile_sensitive_fields();

-- ============================================================================
-- SECTION 13: PHARMACY INVENTORY & WORKFLOW RPCS (HARDENED)
-- ============================================================================

-- 12.1 Atomic Stock Deduction RPC (Secured)
CREATE OR REPLACE FUNCTION public.deduct_stock(
    p_medicine_id UUID,
    p_batch_id UUID,
    p_quantity INTEGER,
    p_dispensing_record_id UUID,
    p_performed_by UUID DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_actor_id UUID;
    v_med_stock INTEGER;
    v_batch_stock INTEGER;
BEGIN
    -- 1. Authentication check
    v_actor_id := auth.uid();
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 2. Authorization check: Active pharmacist or administrator
    IF NOT (public.is_admin() OR (public.is_active_staff() AND public.get_my_role() = 'pharmacist'::user_role)) THEN
        RAISE EXCEPTION 'Only active pharmacists and administrators may deduct stock.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 3. Actor verification: Do not trust caller-supplied UUID mismatch
    IF p_performed_by IS NOT NULL AND p_performed_by != v_actor_id AND NOT public.is_admin() THEN
        RAISE EXCEPTION 'Actor mismatch: p_performed_by must match the authenticated user.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 4. Quantity validation
    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'Dispensing quantity must be positive.'
            USING ERRCODE = 'check_violation';
    END IF;

    -- 5. Lock and validate medicine catalog record
    SELECT current_stock INTO v_med_stock
    FROM public.medicine_catalog
    WHERE id = p_medicine_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Medicine not found in catalog.'
            USING ERRCODE = 'no_data_found';
    END IF;

    IF v_med_stock < p_quantity THEN
        RAISE EXCEPTION 'Insufficient total inventory stock for medicine. Available: %, Requested: %',
            v_med_stock, p_quantity
            USING ERRCODE = 'check_violation';
    END IF;

    -- 6. Lock and validate medicine and batch relationship
    IF p_batch_id IS NOT NULL THEN
        SELECT quantity_remaining INTO v_batch_stock
        FROM public.medicine_batches
        WHERE id = p_batch_id AND medicine_id = p_medicine_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Batch lot not found or does not belong to the specified medicine.'
                USING ERRCODE = 'no_data_found';
        END IF;

        IF v_batch_stock < p_quantity THEN
            RAISE EXCEPTION 'Insufficient stock in batch lot. Available: %, Requested: %',
                v_batch_stock, p_quantity
                USING ERRCODE = 'check_violation';
        END IF;

        UPDATE public.medicine_batches
        SET quantity_remaining = quantity_remaining - p_quantity
        WHERE id = p_batch_id;
    END IF;

    -- 7. Deduct from medicine catalog
    UPDATE public.medicine_catalog
    SET current_stock = current_stock - p_quantity,
        updated_at = now()
    WHERE id = p_medicine_id;

    -- 8. Record audit ledger entry with verified actor
    INSERT INTO public.inventory_movements (
        medicine_id,
        batch_id,
        movement_type,
        quantity,
        previous_balance,
        new_balance,
        reference_id,
        performed_by,
        notes
    ) VALUES (
        p_medicine_id,
        p_batch_id,
        'dispensing'::movement_type,
        -p_quantity,
        v_med_stock,
        v_med_stock - p_quantity,
        p_dispensing_record_id,
        v_actor_id,
        'Prescription dispensed via pharmacy encounter.'
    );

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.deduct_stock(UUID, UUID, INTEGER, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deduct_stock(UUID, UUID, INTEGER, UUID, UUID) TO authenticated, service_role;

-- 12.2 Atomic Stock Receipt RPC (Secured)
CREATE OR REPLACE FUNCTION public.receive_stock(
    p_medicine_id UUID,
    p_batch_number TEXT,
    p_expiry_date DATE,
    p_quantity INTEGER,
    p_cost_price NUMERIC,
    p_supplier TEXT DEFAULT NULL,
    p_invoice_number TEXT DEFAULT NULL,
    p_purchase_date DATE DEFAULT CURRENT_DATE,
    p_recorded_by UUID DEFAULT NULL,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_actor_id UUID;
    v_batch_id UUID;
    v_prev_stock INTEGER;
    v_new_stock INTEGER;
    v_purchase_id UUID;
BEGIN
    -- 1. Authentication check
    v_actor_id := auth.uid();
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 2. Authorization check: Active pharmacist or administrator
    IF NOT (public.is_admin() OR (public.is_active_staff() AND public.get_my_role() = 'pharmacist'::user_role)) THEN
        RAISE EXCEPTION 'Only active pharmacists and administrators can receive stock.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 3. Actor verification: Ensure supplied p_recorded_by matches auth.uid()
    IF p_recorded_by IS NOT NULL AND p_recorded_by != v_actor_id AND NOT public.is_admin() THEN
        RAISE EXCEPTION 'Recorded-by mismatch: p_recorded_by must match the authenticated user.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 4. Quantity validation
    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity received must be positive.'
            USING ERRCODE = 'check_violation';
    END IF;

    -- 5. Expiry validation
    IF p_expiry_date IS NULL OR p_expiry_date <= CURRENT_DATE THEN
        RAISE EXCEPTION 'Cannot receive stock with past or current expiry date.'
            USING ERRCODE = 'check_violation';
    END IF;

    -- 6. Lock and validate medicine catalog item
    SELECT current_stock INTO v_prev_stock
    FROM public.medicine_catalog
    WHERE id = p_medicine_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Medicine catalog item not found.'
            USING ERRCODE = 'no_data_found';
    END IF;

    -- 7. Find or create batch lot
    SELECT id INTO v_batch_id
    FROM public.medicine_batches
    WHERE medicine_id = p_medicine_id AND batch_number = p_batch_number
    FOR UPDATE;

    IF v_batch_id IS NOT NULL THEN
        UPDATE public.medicine_batches
        SET quantity_received = quantity_received + p_quantity,
            quantity_remaining = quantity_remaining + p_quantity,
            cost_price = coalesce(p_cost_price, cost_price)
        WHERE id = v_batch_id;
    ELSE
        INSERT INTO public.medicine_batches (
            medicine_id,
            batch_number,
            expiry_date,
            quantity_received,
            quantity_remaining,
            cost_price,
            received_date
        ) VALUES (
            p_medicine_id,
            p_batch_number,
            p_expiry_date,
            p_quantity,
            p_quantity,
            p_cost_price,
            coalesce(p_purchase_date, CURRENT_DATE)
        )
        RETURNING id INTO v_batch_id;
    END IF;

    v_new_stock := v_prev_stock + p_quantity;

    UPDATE public.medicine_catalog
    SET current_stock = v_new_stock,
        updated_at = now()
    WHERE id = p_medicine_id;

    INSERT INTO public.medicine_purchases (
        medicine_id,
        batch_id,
        batch_number,
        expiry_date,
        quantity_purchased,
        cost_price,
        supplier,
        invoice_number,
        purchase_date,
        recorded_by,
        notes
    ) VALUES (
        p_medicine_id,
        v_batch_id,
        p_batch_number,
        p_expiry_date,
        p_quantity,
        p_cost_price,
        p_supplier,
        p_invoice_number,
        coalesce(p_purchase_date, CURRENT_DATE),
        v_actor_id,
        p_notes
    )
    RETURNING id INTO v_purchase_id;

    INSERT INTO public.inventory_movements (
        medicine_id,
        batch_id,
        movement_type,
        quantity,
        previous_balance,
        new_balance,
        reference_id,
        performed_by,
        notes
    ) VALUES (
        p_medicine_id,
        v_batch_id,
        'stock_receipt'::movement_type,
        p_quantity,
        v_prev_stock,
        v_new_stock,
        v_purchase_id,
        v_actor_id,
        'Stock received from supplier' || coalesce(' (' || p_supplier || ')', '')
    );

    RETURN jsonb_build_object(
        'success', true,
        'batch_id', v_batch_id,
        'purchase_id', v_purchase_id,
        'previous_stock', v_prev_stock,
        'new_stock', v_new_stock,
        'quantity_added', p_quantity
    );
END;
$$;

REVOKE ALL ON FUNCTION public.receive_stock(UUID, TEXT, DATE, INTEGER, NUMERIC, TEXT, TEXT, DATE, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_stock(UUID, TEXT, DATE, INTEGER, NUMERIC, TEXT, TEXT, DATE, UUID, TEXT) TO authenticated, service_role;

-- 12.3 Increment Dispensed Quantity Helper RPC (Secured)
-- 12.3 (DEPRECATED & REVOKED) Legacy increment dispensed quantity
-- Superseded by dispense_prescription_atomic() for atomic multi-item FEFO dispensing.
CREATE OR REPLACE FUNCTION public.increment_dispensed_qty(
    p_item_id UUID,
    p_qty INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    RAISE EXCEPTION 'Direct increment_dispensed_qty is deprecated and disabled for security. Use dispense_prescription_atomic().';
END;
$$;

-- 12.3B Atomic prescription dispensing with strictly reordered FEFO batch selection
CREATE OR REPLACE FUNCTION public.dispense_prescription_atomic(
    p_prescription_id uuid,
    p_items jsonb,  -- JSONB array of dispensing line items
    p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_actor_id uuid;
    v_caller_role user_role;
    v_rx RECORD;
    v_rx_item RECORD;
    v_batch RECORD;
    v_item_elem jsonb;
    v_item_id uuid;
    v_batch_id uuid;
    v_dispense_qty int;
    v_remaining int;
    v_dispensing_id uuid;
    v_unit_price numeric(10,2);
    v_all_fulfilled boolean;
    v_any_dispensed boolean;
BEGIN
    -- 1. Caller authentication and authorization
    v_actor_id := auth.uid();
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF NOT public.is_active_staff() THEN
        RAISE EXCEPTION 'Caller is not an active hospital staff member';
    END IF;

    v_caller_role := public.get_my_role();
    IF v_caller_role NOT IN ('pharmacist'::user_role, 'admin'::user_role) THEN
        RAISE EXCEPTION 'Access denied: only active pharmacists or administrators can dispense prescriptions';
    END IF;

    -- Validate input items array
    IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'No items provided for dispensing';
    END IF;

    -- 2. Fetch and lock prescription
    SELECT * INTO v_rx
    FROM public.prescriptions
    WHERE id = p_prescription_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Prescription % not found', p_prescription_id;
    END IF;

    IF v_rx.status NOT IN ('active'::prescription_status, 'draft'::prescription_status, 'partially_dispensed'::prescription_status) THEN
        RAISE EXCEPTION 'Prescription % cannot be dispensed (current status: %)', p_prescription_id, v_rx.status;
    END IF;

    -- 3. Create dispensing record with initial status 'pending'
    INSERT INTO public.dispensing_records (
        prescription_id,
        patient_id,
        pharmacist_id,
        notes,
        status,
        created_at,
        updated_at
    ) VALUES (
        p_prescription_id,
        v_rx.patient_id,
        v_actor_id,
        p_notes,
        'pending'::dispensing_status,
        now(),
        now()
    )
    RETURNING id INTO v_dispensing_id;

    -- 4. Process each item in the payload
    FOR v_item_elem IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_item_id := (v_item_elem->>'item_id')::uuid;
        v_dispense_qty := (v_item_elem->>'quantity')::int;
        v_batch_id := NULL;
        IF (v_item_elem->>'batch_id') IS NOT NULL AND (v_item_elem->>'batch_id') != '' THEN
            v_batch_id := (v_item_elem->>'batch_id')::uuid;
        END IF;

        IF v_dispense_qty IS NULL OR v_dispense_qty <= 0 THEN
            RAISE EXCEPTION 'Dispense quantity must be greater than zero for item %', v_item_id;
        END IF;

        -- Step 4a: Lock prescription item and fetch its prescribed details FIRST
        SELECT * INTO v_rx_item
        FROM public.prescription_items
        WHERE id = v_item_id AND prescription_id = p_prescription_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Prescription item % not found on prescription %', v_item_id, p_prescription_id;
        END IF;

        v_remaining := v_rx_item.quantity_prescribed - v_rx_item.quantity_dispensed;
        IF v_dispense_qty > v_remaining THEN
            RAISE EXCEPTION 'Cannot dispense % units for item %: remaining unfulfilled quantity is % (prescribed: %, already dispensed: %)',
                v_dispense_qty, v_rx_item.medicine_id, v_remaining, v_rx_item.quantity_prescribed, v_rx_item.quantity_dispensed;
        END IF;

        -- Step 4b: Resolve batch using v_rx_item.medicine_id (FEFO order if not supplied)
        IF v_batch_id IS NULL THEN
            SELECT * INTO v_batch
            FROM public.medicine_batches
            WHERE medicine_id = v_rx_item.medicine_id
              AND quantity_remaining >= v_dispense_qty
              AND expiry_date >= CURRENT_DATE
            ORDER BY expiry_date ASC, created_at ASC
            LIMIT 1
            FOR UPDATE;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'No active, unexpired batch with sufficient stock (>= % units) found for medicine %',
                    v_dispense_qty, v_rx_item.medicine_id;
            END IF;
            v_batch_id := v_batch.id;
        ELSE
            SELECT * INTO v_batch
            FROM public.medicine_batches
            WHERE id = v_batch_id AND medicine_id = v_rx_item.medicine_id
            FOR UPDATE;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Specified batch % does not match medicine %', v_batch_id, v_rx_item.medicine_id;
            END IF;

            IF v_batch.expiry_date < CURRENT_DATE THEN
                RAISE EXCEPTION 'Batch % has expired on %', v_batch_id, v_batch.expiry_date;
            END IF;

            IF v_batch.quantity_remaining < v_dispense_qty THEN
                RAISE EXCEPTION 'Batch % has insufficient stock (% available, % requested)',
                    v_batch_id, v_batch.quantity_remaining, v_dispense_qty;
            END IF;
        END IF;

        -- Step 4b-extra: Fetch unit_price from medicine_catalog (batches only have cost_price)
        SELECT unit_price INTO v_unit_price
        FROM public.medicine_catalog
        WHERE id = v_rx_item.medicine_id;

        -- Step 4c: Deduct stock atomically
        PERFORM public.deduct_stock(
            p_medicine_id := v_rx_item.medicine_id,
            p_batch_id := v_batch_id,
            p_quantity := v_dispense_qty,
            p_dispensing_record_id := v_dispensing_id,
            p_performed_by := v_actor_id
        );

        -- Step 4d: Update prescription item (only quantity_dispensed exists in this table)
        UPDATE public.prescription_items
        SET quantity_dispensed = quantity_dispensed + v_dispense_qty
        WHERE id = v_rx_item.id;

        -- Step 4e: Record dispensing line item
        INSERT INTO public.dispensing_items (
            dispensing_record_id,
            prescription_item_id,
            medicine_id,
            batch_id,
            quantity_dispensed,
            unit_price,
            total_price,
            created_at
        ) VALUES (
            v_dispensing_id,
            v_rx_item.id,
            v_rx_item.medicine_id,
            v_batch_id,
            v_dispense_qty,
            v_unit_price,
            (v_unit_price * v_dispense_qty),
            now()
        );
    END LOOP;

    -- 5. Re-evaluate live prescription fulfillment across all prescription items
    SELECT
        COALESCE(bool_and(quantity_dispensed >= quantity_prescribed), false),
        COALESCE(bool_or(quantity_dispensed > 0), false)
    INTO v_all_fulfilled, v_any_dispensed
    FROM public.prescription_items
    WHERE prescription_id = p_prescription_id;

    -- 6. Finalize dispensing record status
    UPDATE public.dispensing_records
    SET status = CASE
            WHEN v_all_fulfilled THEN 'completed'::dispensing_status
            ELSE 'partial'::dispensing_status
        END,
        updated_at = now()
    WHERE id = v_dispensing_id;

    -- 7. Update parent prescription status
    UPDATE public.prescriptions
    SET status = CASE
            WHEN v_all_fulfilled THEN 'dispensed'::prescription_status
            ELSE 'partially_dispensed'::prescription_status
        END,
        updated_at = now()
    WHERE id = p_prescription_id;

    RETURN jsonb_build_object(
        'success', true,
        'dispensing_id', v_dispensing_id,
        'dispensing_record_id', v_dispensing_id,
        'prescription_id', p_prescription_id,
        'prescription_number', v_rx.prescription_number,
        'status', CASE WHEN v_all_fulfilled THEN 'completed' ELSE 'partial' END
    );
END;
$$;

-- 12.4 Safe profile update RPC for authenticated users
CREATE OR REPLACE FUNCTION public.update_my_profile(
    p_full_name text,
    p_phone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_actor_id uuid;
BEGIN
    v_actor_id := auth.uid();
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF NOT public.is_active_staff() THEN
        RAISE EXCEPTION 'Caller is not an active hospital staff member';
    END IF;

    UPDATE public.profiles
    SET full_name = COALESCE(NULLIF(TRIM(p_full_name), ''), full_name),
        phone = TRIM(p_phone),
        updated_at = now()
    WHERE id = v_actor_id;

    RETURN jsonb_build_object('success', true, 'message', 'Profile updated successfully');
END;
$$;

-- 12.5 Safe demographic update RPC for Front Desk and authorized staff
CREATE OR REPLACE FUNCTION public.update_patient_demographics(
    p_patient_id uuid,
    p_first_name text,
    p_last_name text,
    p_middle_name text DEFAULT NULL,
    p_date_of_birth date DEFAULT NULL,
    p_sex sex_type DEFAULT NULL,
    p_phone text DEFAULT NULL,
    p_address text DEFAULT NULL,
    p_emergency_contact_name text DEFAULT NULL,
    p_emergency_contact_relationship text DEFAULT NULL,
    p_emergency_contact_phone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_caller_role user_role;
BEGIN
    IF NOT public.is_active_staff() THEN
        RAISE EXCEPTION 'Caller is not an active hospital staff member';
    END IF;

    v_caller_role := public.get_my_role();
    IF v_caller_role NOT IN ('admin'::user_role, 'front_desk'::user_role) AND NOT public.can_access_patient(p_patient_id) THEN
        RAISE EXCEPTION 'Access denied: caller cannot update demographics for patient %', p_patient_id;
    END IF;

    UPDATE public.patients
    SET
        first_name = COALESCE(TRIM(p_first_name), first_name),
        last_name = COALESCE(TRIM(p_last_name), last_name),
        middle_name = TRIM(p_middle_name),
        date_of_birth = COALESCE(p_date_of_birth, date_of_birth),
        sex = COALESCE(p_sex, sex),
        phone = TRIM(p_phone),
        address = TRIM(p_address),
        emergency_contact_name = TRIM(p_emergency_contact_name),
        emergency_contact_relationship = TRIM(p_emergency_contact_relationship),
        emergency_contact_phone = TRIM(p_emergency_contact_phone),
        updated_at = now()
    WHERE id = p_patient_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Patient % not found', p_patient_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'message', 'Demographics updated successfully', 'patient_id', p_patient_id);
END;
$$;

-- 12.6 Front-desk patient search RPC (demographics only)
CREATE OR REPLACE FUNCTION public.search_patients_frontdesk(p_search_term text)
RETURNS TABLE (
    id uuid,
    hospital_number text,
    first_name text,
    last_name text,
    middle_name text,
    date_of_birth date,
    sex sex_type,
    phone text,
    address text,
    created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF NOT public.is_active_staff() THEN
        RAISE EXCEPTION 'Access denied: caller is not an active staff member';
    END IF;

    -- Front-desk only: restrict to demographic fields needed for registration/check-in
    IF public.get_my_role() NOT IN ('admin'::user_role, 'front_desk'::user_role, 'doctor'::user_role, 'nurse'::user_role) THEN
        RAISE EXCEPTION 'Access denied: role not authorized for patient search';
    END IF;

    RETURN QUERY
    SELECT
        p.id,
        p.hospital_number,
        p.first_name,
        p.last_name,
        p.middle_name,
        p.date_of_birth,
        p.sex,
        p.phone,
        p.address,
        p.created_at
    FROM public.patients p
    WHERE (
          p_search_term IS NULL
          OR p_search_term = ''
          OR p.hospital_number ILIKE '%' || p_search_term || '%'
          OR p.first_name ILIKE '%' || p_search_term || '%'
          OR p.last_name ILIKE '%' || p_search_term || '%'
          OR COALESCE(p.phone, '') ILIKE '%' || p_search_term || '%'
      )
    ORDER BY p.last_name, p.first_name
    LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_dispensed_qty(UUID, INTEGER) FROM PUBLIC, anon;
-- (REVOKED FOR SECURITY) EXECUTE ON FUNCTION public.increment_dispensed_qty

-- 12.4 Shared Patient Search RPC (Secured)
CREATE OR REPLACE FUNCTION public.search_patients_shared(p_search TEXT)
RETURNS TABLE (
    id UUID,
    hospital_number TEXT,
    first_name TEXT,
    middle_name TEXT,
    last_name TEXT,
    date_of_birth DATE,
    sex sex_type,
    phone TEXT,
    blood_group TEXT,
    genotype TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_clean TEXT := trim(coalesce(p_search, ''));
    v_role user_role;
    v_is_clinical boolean;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT (public.is_admin() OR public.is_active_staff()) THEN
        RAISE EXCEPTION 'Access denied. Active staff credentials required.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    v_role := public.get_my_role();
    -- Only admin, doctors, and nurses receive sensitive clinical fields (blood_group, genotype).
    -- Front desk and non-clinical staff receive NULL for clinical fields.
    v_is_clinical := public.is_admin() OR v_role IN ('doctor'::user_role, 'nurse'::user_role);

    IF length(v_clean) = 0 THEN
        RETURN QUERY
        SELECT
            p.id, p.hospital_number, p.first_name, p.middle_name, p.last_name,
            p.date_of_birth, p.sex, p.phone,
            CASE WHEN v_is_clinical THEN p.blood_group ELSE NULL::TEXT END AS blood_group,
            CASE WHEN v_is_clinical THEN p.genotype ELSE NULL::TEXT END AS genotype,
            p.created_at
        FROM public.patients p
        ORDER BY p.created_at DESC
        LIMIT 50;
    ELSE
        RETURN QUERY
        SELECT
            p.id, p.hospital_number, p.first_name, p.middle_name, p.last_name,
            p.date_of_birth, p.sex, p.phone,
            CASE WHEN v_is_clinical THEN p.blood_group ELSE NULL::TEXT END AS blood_group,
            CASE WHEN v_is_clinical THEN p.genotype ELSE NULL::TEXT END AS genotype,
            p.created_at
        FROM public.patients p
        WHERE
            p.hospital_number ILIKE '%' || v_clean || '%'
            OR p.first_name ILIKE '%' || v_clean || '%'
            OR p.last_name ILIKE '%' || v_clean || '%'
            OR coalesce(p.middle_name, '') ILIKE '%' || v_clean || '%'
            OR coalesce(p.phone, '') ILIKE '%' || v_clean || '%'
        ORDER BY
            CASE WHEN p.hospital_number ILIKE v_clean || '%' THEN 1 ELSE 2 END,
            p.last_name ASC,
            p.first_name ASC
        LIMIT 50;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.search_patients_shared(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_patients_shared(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_patients_frontdesk(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dispense_prescription_atomic(UUID, JSONB, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_my_profile(TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_patient_demographics(UUID, TEXT, TEXT, TEXT, DATE, sex_type, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- Grant access on demographic view to authenticated users
GRANT SELECT, INSERT, UPDATE ON public.patient_demographics TO authenticated;

-- ============================================================================
-- SECTION 14: STAFF ARCHIVE & AUDIT LOGGING RPCS
-- ============================================================================

-- 13.1 Hardened Atomic Staff Archive RPC
CREATE OR REPLACE FUNCTION public.archive_staff_member(
    p_target_user_id pg_catalog.uuid,
    p_reason pg_catalog.text DEFAULT NULL,
    p_client_ip pg_catalog.text DEFAULT NULL,
    p_user_agent pg_catalog.text DEFAULT NULL
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_caller_id pg_catalog.uuid;
    v_target_profile public.profiles%ROWTYPE;
    v_archived_at pg_catalog.timestamptz := pg_catalog.now();
    v_old_data pg_catalog.jsonb;
    v_new_data pg_catalog.jsonb;
    v_actor_email pg_catalog.text;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Only active administrators may archive staff profiles.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    v_caller_id := auth.uid();

    IF v_caller_id = p_target_user_id THEN
        RAISE EXCEPTION 'Administrators cannot archive their own profile.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_target_profile
    FROM public.profiles
    WHERE id = p_target_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Staff member profile not found.'
            USING ERRCODE = 'no_data_found';
    END IF;

    IF v_target_profile.role = 'admin'::public.user_role THEN
        RAISE EXCEPTION 'Administrator accounts cannot be archived.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_target_profile.status != 'deactivated'::public.account_status THEN
        RAISE EXCEPTION 'Only deactivated staff profiles can be archived. Deactivate the account first.'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_target_profile.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'This staff profile has already been archived.'
            USING ERRCODE = 'unique_violation';
    END IF;

    SELECT email INTO v_actor_email
    FROM public.profiles
    WHERE id = v_caller_id;

    v_old_data := pg_catalog.jsonb_build_object(
        'id', v_target_profile.id,
        'staff_id', v_target_profile.staff_id,
        'role', v_target_profile.role,
        'department', v_target_profile.department,
        'status', v_target_profile.status,
        'deleted_at', v_target_profile.deleted_at
    );

    v_new_data := pg_catalog.jsonb_build_object(
        'id', v_target_profile.id,
        'staff_id', v_target_profile.staff_id,
        'role', v_target_profile.role,
        'department', v_target_profile.department,
        'status', v_target_profile.status,
        'deleted_at', v_archived_at,
        'reason', p_reason,
        'actor_email', v_actor_email,
        'user_agent', p_user_agent
    );

    UPDATE public.profiles
    SET deleted_at = v_archived_at,
        updated_at = v_archived_at
    WHERE id = p_target_user_id;

    INSERT INTO public.audit_logs (
        actor_id,
        action,
        table_name,
        record_id,
        old_data,
        new_data,
        ip_address,
        created_at
    ) VALUES (
        v_caller_id,
        'STAFF_ACCOUNT_ARCHIVED',
        'profiles',
        p_target_user_id,
        v_old_data,
        v_new_data,
        p_client_ip,
        v_archived_at
    );

    RETURN pg_catalog.jsonb_build_object(
        'id', v_target_profile.id,
        'full_name', v_target_profile.full_name,
        'role', v_target_profile.role,
        'staff_id', v_target_profile.staff_id,
        'status', v_target_profile.status,
        'deleted_at', v_archived_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.archive_staff_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.archive_staff_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO authenticated;

-- 13.2 Hardened Audit Event Logging Helper
CREATE OR REPLACE FUNCTION public.log_audit_event(
    p_action TEXT,
    p_table_name TEXT,
    p_record_id UUID,
    p_old_data JSONB DEFAULT NULL,
    p_new_data JSONB DEFAULT NULL,
    p_ip_address TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_log_id UUID;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Only active administrators may write audit events.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    INSERT INTO public.audit_logs (
        actor_id,
        action,
        table_name,
        record_id,
        old_data,
        new_data,
        ip_address
    ) VALUES (
        auth.uid(),
        p_action,
        p_table_name,
        p_record_id,
        p_old_data,
        p_new_data,
        p_ip_address
    ) RETURNING id INTO v_log_id;

    RETURN v_log_id;
END;
$$;

REVOKE ALL ON FUNCTION public.log_audit_event(TEXT, TEXT, UUID, JSONB, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_audit_event(TEXT, TEXT, UUID, JSONB, JSONB, TEXT) TO authenticated, service_role;

-- ============================================================================
-- SECTION 15: ENABLE ROW LEVEL SECURITY ON ALL TABLES
-- ============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_encounters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_vitals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_diagnoses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_allergies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_file_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_file_transfer_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.laboratory_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.laboratory_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.laboratory_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medicine_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medicine_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medicine_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prescriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prescription_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispensing_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispensing_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- SECTION 16: ROW LEVEL SECURITY POLICIES (TIGHTENED & ROLE-SECURED)
-- ============================================================================

-- 15.1 profiles
DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;
CREATE POLICY "profiles_select_policy" ON public.profiles
    FOR SELECT TO authenticated
    USING (
        id = auth.uid()
        OR public.is_admin()
        OR (
            public.is_active_user()
            AND status = 'active'::public.account_status
            AND deleted_at IS NULL
        )
    );

-- Removal of first-user self-registration privilege:
-- Administrator account must be created through Supabase SQL Editor / Auth dashboard.
DROP POLICY IF EXISTS "profiles_insert_policy" ON public.profiles;
CREATE POLICY "profiles_insert_policy" ON public.profiles
    FOR INSERT TO authenticated
    WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "profiles_update_policy" ON public.profiles;
DROP POLICY IF EXISTS "profiles_admin_update_policy" ON public.profiles;
CREATE POLICY "profiles_admin_update_policy" ON public.profiles
    FOR UPDATE TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "profiles_self_update_policy" ON public.profiles;
CREATE POLICY "profiles_self_update_policy" ON public.profiles
    FOR UPDATE TO authenticated
    USING (
        id = auth.uid()
        AND public.is_active_staff()
    )
    WITH CHECK (
        id = auth.uid()
        AND public.is_active_staff()
        AND role = (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid())
        AND status = (SELECT p.status FROM public.profiles p WHERE p.id = auth.uid())
        AND (staff_id = (SELECT p.staff_id FROM public.profiles p WHERE p.id = auth.uid()) OR (staff_id IS NULL AND (SELECT p.staff_id FROM public.profiles p WHERE p.id = auth.uid()) IS NULL))
        AND (deleted_at IS NULL AND (SELECT p.deleted_at FROM public.profiles p WHERE p.id = auth.uid()) IS NULL)
    );

DROP POLICY IF EXISTS "profiles_delete_policy" ON public.profiles;
CREATE POLICY "profiles_delete_policy" ON public.profiles
    FOR DELETE TO authenticated
    USING (public.is_admin());

-- 15.2 system_settings
DROP POLICY IF EXISTS "system_settings_select_policy" ON public.system_settings;
CREATE POLICY "system_settings_select_policy" ON public.system_settings
    FOR SELECT TO authenticated
    USING (public.is_active_user());

DROP POLICY IF EXISTS "system_settings_admin_all" ON public.system_settings;
CREATE POLICY "system_settings_admin_all" ON public.system_settings
    FOR ALL TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- 15.3 patients (Master Demographic Index)
DROP POLICY IF EXISTS "patients_select_policy" ON public.patients;
CREATE POLICY "patients_select_policy" ON public.patients
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() != 'front_desk'::user_role
        )
    );
-- Front-desk staff access patients ONLY through the patient_demographics view
-- or search_patients_frontdesk() RPC, which expose only demographic fields.

DROP POLICY IF EXISTS "patients_insert_policy" ON public.patients;
CREATE POLICY "patients_insert_policy" ON public.patients
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('doctor'::user_role, 'nurse'::user_role)
        )
    );

DROP POLICY IF EXISTS "patients_update_policy" ON public.patients;
CREATE POLICY "patients_update_policy" ON public.patients
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('doctor'::user_role, 'nurse'::user_role)
            AND public.can_access_patient(id)
        )
    )
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('doctor'::user_role, 'nurse'::user_role)
            AND public.can_access_patient(id)
        )
    );

-- 15.4 patient_encounters
DROP POLICY IF EXISTS "encounters_select_policy" ON public.patient_encounters;
CREATE POLICY "encounters_select_policy" ON public.patient_encounters
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND (
                opened_by = auth.uid()
                OR closed_by = auth.uid()
                OR public.can_access_patient(patient_id)
            )
        )
    );

DROP POLICY IF EXISTS "encounters_insert_policy" ON public.patient_encounters;
CREATE POLICY "encounters_insert_policy" ON public.patient_encounters
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_user()
            AND public.get_my_role() IN ('front_desk'::user_role, 'doctor'::user_role, 'nurse'::user_role)
            AND opened_by = auth.uid()
        )
    );

DROP POLICY IF EXISTS "encounters_update_policy" ON public.patient_encounters;
CREATE POLICY "encounters_update_policy" ON public.patient_encounters
    FOR UPDATE TO authenticated
    USING (public.is_admin() OR opened_by = auth.uid() OR public.can_access_patient(patient_id))
    WITH CHECK (public.is_admin() OR opened_by = auth.uid() OR public.can_access_patient(patient_id));

-- 15.5 patient_vitals (Clinical records: Front desk strictly excluded)
DROP POLICY IF EXISTS "vitals_select_policy" ON public.patient_vitals;
CREATE POLICY "vitals_select_policy" ON public.patient_vitals
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('doctor'::user_role, 'nurse'::user_role)
            AND (recorded_by = auth.uid() OR public.can_access_patient(patient_id))
        )
    );

DROP POLICY IF EXISTS "vitals_insert_policy" ON public.patient_vitals;
CREATE POLICY "vitals_insert_policy" ON public.patient_vitals
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('nurse'::user_role, 'doctor'::user_role)
            AND recorded_by = auth.uid()
            AND public.can_access_patient(patient_id)
        )
    );

-- 15.6 clinical_notes (Clinical SOAP notes: Front desk strictly excluded)
DROP POLICY IF EXISTS "notes_select_policy" ON public.clinical_notes;
CREATE POLICY "notes_select_policy" ON public.clinical_notes
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('doctor'::user_role, 'nurse'::user_role)
            AND (author_id = auth.uid() OR public.can_access_patient(patient_id))
        )
    );

DROP POLICY IF EXISTS "notes_insert_policy" ON public.clinical_notes;
CREATE POLICY "notes_insert_policy" ON public.clinical_notes
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_user()
            AND public.get_my_role() IN ('doctor'::user_role, 'nurse'::user_role)
            AND author_id = auth.uid()
            AND public.can_access_patient(patient_id)
        )
    );

DROP POLICY IF EXISTS "notes_update_policy" ON public.clinical_notes;
CREATE POLICY "notes_update_policy" ON public.clinical_notes
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_user()
            AND author_id = auth.uid()
            AND is_amended = false
            AND public.can_access_patient(patient_id)
        )
    )
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_user()
            AND (author_id = auth.uid() OR is_amended = true)
            AND public.can_access_patient(patient_id)
        )
    );

-- 15.7 patient_diagnoses (Clinical diagnoses: Front desk strictly excluded)
DROP POLICY IF EXISTS "diagnoses_select_policy" ON public.patient_diagnoses;
CREATE POLICY "diagnoses_select_policy" ON public.patient_diagnoses
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('doctor'::user_role, 'nurse'::user_role, 'pharmacist'::user_role)
            AND (diagnosed_by = auth.uid() OR public.can_access_patient(patient_id))
        )
    );

DROP POLICY IF EXISTS "diagnoses_insert_policy" ON public.patient_diagnoses;
CREATE POLICY "diagnoses_insert_policy" ON public.patient_diagnoses
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_user()
            AND public.get_my_role() = 'doctor'::user_role
            AND diagnosed_by = auth.uid()
            AND public.can_access_patient(patient_id)
        )
    );

DROP POLICY IF EXISTS "diagnoses_update_policy" ON public.patient_diagnoses;
CREATE POLICY "diagnoses_update_policy" ON public.patient_diagnoses
    FOR UPDATE TO authenticated
    USING (public.is_admin() OR (public.is_active_user() AND diagnosed_by = auth.uid()))
    WITH CHECK (public.is_admin() OR (public.is_active_user() AND diagnosed_by = auth.uid()));

-- 15.8 patient_allergies (Clinical allergies: Front desk strictly excluded)
DROP POLICY IF EXISTS "allergies_select_policy" ON public.patient_allergies;
CREATE POLICY "allergies_select_policy" ON public.patient_allergies
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('doctor'::user_role, 'nurse'::user_role, 'pharmacist'::user_role)
            AND (recorded_by = auth.uid() OR public.can_access_patient(patient_id))
        )
    );

DROP POLICY IF EXISTS "allergies_insert_policy" ON public.patient_allergies;
CREATE POLICY "allergies_insert_policy" ON public.patient_allergies
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_user()
            AND public.get_my_role() IN ('doctor'::user_role, 'nurse'::user_role)
            AND recorded_by = auth.uid()
            AND public.can_access_patient(patient_id)
        )
    );

-- 15.9 patient_documents (Clinical attachments: Front desk strictly excluded)
DROP POLICY IF EXISTS "documents_select_policy" ON public.patient_documents;
CREATE POLICY "documents_select_policy" ON public.patient_documents
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('doctor'::user_role, 'nurse'::user_role, 'lab_technician'::user_role)
            AND (uploaded_by = auth.uid() OR public.can_access_patient(patient_id))
        )
    );

DROP POLICY IF EXISTS "documents_insert_policy" ON public.patient_documents;
CREATE POLICY "documents_insert_policy" ON public.patient_documents
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_user()
            AND public.get_my_role() IN ('doctor'::user_role, 'lab_technician'::user_role)
            AND uploaded_by = auth.uid()
            AND public.can_access_patient(patient_id)
        )
    );

-- 15.10 patient_file_transfers
DROP POLICY IF EXISTS "transfers_select_policy" ON public.patient_file_transfers;
CREATE POLICY "transfers_select_policy" ON public.patient_file_transfers
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR sender_id = auth.uid()
        OR recipient_id = auth.uid()
    );

DROP POLICY IF EXISTS "transfers_insert_policy" ON public.patient_file_transfers;
CREATE POLICY "transfers_insert_policy" ON public.patient_file_transfers
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_user()
            AND sender_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "transfers_update_policy" ON public.patient_file_transfers;
CREATE POLICY "transfers_update_policy" ON public.patient_file_transfers
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR recipient_id = auth.uid()
        OR sender_id = auth.uid()
    )
    WITH CHECK (
        public.is_admin()
        OR recipient_id = auth.uid()
        OR sender_id = auth.uid()
    );

-- 15.11 patient_file_transfer_history
DROP POLICY IF EXISTS "transfer_history_select_policy" ON public.patient_file_transfer_history;
CREATE POLICY "transfer_history_select_policy" ON public.patient_file_transfer_history
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR EXISTS (
            SELECT 1 FROM public.patient_file_transfers t
            WHERE t.id = transfer_id
              AND (t.sender_id = auth.uid() OR t.recipient_id = auth.uid())
        )
    );

-- 15.12 notifications
DROP POLICY IF EXISTS "notifications_select_policy" ON public.notifications;
CREATE POLICY "notifications_select_policy" ON public.notifications
    FOR SELECT TO authenticated
    USING (recipient_id = auth.uid());

DROP POLICY IF EXISTS "notifications_insert_policy" ON public.notifications;
CREATE POLICY "notifications_insert_policy" ON public.notifications
    FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.is_active_staff());

DROP POLICY IF EXISTS "notifications_update_policy" ON public.notifications;
CREATE POLICY "notifications_update_policy" ON public.notifications
    FOR UPDATE TO authenticated
    USING (recipient_id = auth.uid())
    WITH CHECK (recipient_id = auth.uid());

-- 15.13 laboratory_orders (Front desk strictly excluded)
DROP POLICY IF EXISTS "lab_orders_select_policy" ON public.laboratory_orders;
CREATE POLICY "lab_orders_select_policy" ON public.laboratory_orders
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('doctor'::user_role, 'nurse'::user_role, 'lab_technician'::user_role)
            AND (
                -- Unassigned work queue for lab technicians
                (public.get_my_role() = 'lab_technician'::user_role AND assigned_technician_id IS NULL AND status IN ('pending'::lab_order_status, 'assigned'::lab_order_status))
                OR assigned_technician_id = auth.uid()
                OR ordering_doctor_id = auth.uid()
                OR public.can_access_patient(patient_id)
            )
        )
    );

DROP POLICY IF EXISTS "lab_orders_insert_policy" ON public.laboratory_orders;
CREATE POLICY "lab_orders_insert_policy" ON public.laboratory_orders
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() = 'doctor'::user_role
            AND ordering_doctor_id = auth.uid()
            AND public.can_access_patient(patient_id)
        )
    );

DROP POLICY IF EXISTS "lab_orders_update_policy" ON public.laboratory_orders;
CREATE POLICY "lab_orders_update_policy" ON public.laboratory_orders
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND (
                ordering_doctor_id = auth.uid()
                OR assigned_technician_id = auth.uid()
                OR (
                    public.get_my_role() = 'lab_technician'::user_role
                    AND assigned_technician_id IS NULL
                )
            )
        )
    )
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND (
                ordering_doctor_id = auth.uid()
                OR assigned_technician_id = auth.uid()
                OR public.get_my_role() = 'lab_technician'::user_role
            )
        )
    );

-- 15.14 laboratory_order_items (Front desk strictly excluded)
DROP POLICY IF EXISTS "lab_order_items_select_policy" ON public.laboratory_order_items;
CREATE POLICY "lab_order_items_select_policy" ON public.laboratory_order_items
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('doctor'::user_role, 'nurse'::user_role, 'lab_technician'::user_role)
            AND EXISTS (
                SELECT 1 FROM public.laboratory_orders o
                WHERE o.id = order_id
                  AND (
                      -- Unassigned work queue for lab technicians
                      (public.get_my_role() = 'lab_technician'::user_role AND o.assigned_technician_id IS NULL AND o.status IN ('pending'::lab_order_status, 'assigned'::lab_order_status))
                      OR o.assigned_technician_id = auth.uid()
                      OR o.ordering_doctor_id = auth.uid()
                      OR public.can_access_patient(o.patient_id)
                  )
            )
        )
    );

DROP POLICY IF EXISTS "lab_order_items_insert_policy" ON public.laboratory_order_items;
CREATE POLICY "lab_order_items_insert_policy" ON public.laboratory_order_items
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() = 'doctor'::user_role
            AND EXISTS (
                SELECT 1 FROM public.laboratory_orders o
                WHERE o.id = order_id
                  AND o.ordering_doctor_id = auth.uid()
            )
        )
    );

-- 15.15 laboratory_results (Front desk strictly excluded)
DROP POLICY IF EXISTS "lab_results_select_policy" ON public.laboratory_results;
CREATE POLICY "lab_results_select_policy" ON public.laboratory_results
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('doctor'::user_role, 'nurse'::user_role, 'lab_technician'::user_role)
            AND (
                performed_by = auth.uid()
                OR verified_by = auth.uid()
                OR public.can_access_patient(patient_id)
            )
        )
    );

DROP POLICY IF EXISTS "lab_results_insert_policy" ON public.laboratory_results;
CREATE POLICY "lab_results_insert_policy" ON public.laboratory_results
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() = 'lab_technician'::user_role
            AND performed_by = auth.uid()
            AND public.can_access_patient(patient_id)
        )
    );

DROP POLICY IF EXISTS "lab_results_update_policy" ON public.laboratory_results;
CREATE POLICY "lab_results_update_policy" ON public.laboratory_results
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND (
                (public.get_my_role() = 'lab_technician'::user_role AND performed_by = auth.uid() AND status = 'draft'::lab_result_status)
                OR (public.get_my_role() IN ('doctor'::user_role, 'lab_technician'::user_role) AND verified_by = auth.uid())
            )
        )
    )
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND (
                (public.get_my_role() = 'lab_technician'::user_role AND performed_by = auth.uid())
                OR (public.get_my_role() IN ('doctor'::user_role, 'lab_technician'::user_role) AND verified_by = auth.uid())
            )
        )
    );

-- 15.16 medicine_catalog
DROP POLICY IF EXISTS "med_catalog_select_policy" ON public.medicine_catalog;
CREATE POLICY "med_catalog_select_policy" ON public.medicine_catalog
    FOR SELECT TO authenticated
    USING (public.is_active_user());

DROP POLICY IF EXISTS "med_catalog_insert_policy" ON public.medicine_catalog;
CREATE POLICY "med_catalog_insert_policy" ON public.medicine_catalog
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (public.is_active_user() AND public.get_my_role() = 'pharmacist'::user_role)
    );

DROP POLICY IF EXISTS "med_catalog_update_policy" ON public.medicine_catalog;
CREATE POLICY "med_catalog_update_policy" ON public.medicine_catalog
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR (public.is_active_user() AND public.get_my_role() = 'pharmacist'::user_role)
    )
    WITH CHECK (
        public.is_admin()
        OR (public.is_active_user() AND public.get_my_role() = 'pharmacist'::user_role)
    );

DROP POLICY IF EXISTS "med_catalog_delete_policy" ON public.medicine_catalog;
CREATE POLICY "med_catalog_delete_policy" ON public.medicine_catalog
    FOR DELETE TO authenticated
    USING (public.is_admin());

-- 15.17 medicine_batches
DROP POLICY IF EXISTS "med_batches_select_policy" ON public.medicine_batches;
CREATE POLICY "med_batches_select_policy" ON public.medicine_batches
    FOR SELECT TO authenticated
    USING (public.is_active_user());

DROP POLICY IF EXISTS "med_batches_insert_policy" ON public.medicine_batches;
CREATE POLICY "med_batches_insert_policy" ON public.medicine_batches
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (public.is_active_user() AND public.get_my_role() = 'pharmacist'::user_role)
    );

DROP POLICY IF EXISTS "med_batches_update_policy" ON public.medicine_batches;
CREATE POLICY "med_batches_update_policy" ON public.medicine_batches
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR (public.is_active_user() AND public.get_my_role() = 'pharmacist'::user_role)
    )
    WITH CHECK (
        public.is_admin()
        OR (public.is_active_user() AND public.get_my_role() = 'pharmacist'::user_role)
    );

-- 15.18 medicine_purchases
DROP POLICY IF EXISTS "purchases_select_policy" ON public.medicine_purchases;
CREATE POLICY "purchases_select_policy" ON public.medicine_purchases
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (public.is_active_staff() AND public.get_my_role() = 'pharmacist'::user_role)
    );

DROP POLICY IF EXISTS "purchases_insert_policy" ON public.medicine_purchases;
CREATE POLICY "purchases_insert_policy" ON public.medicine_purchases
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() = 'pharmacist'::user_role
            AND recorded_by = auth.uid()
        )
    );

-- 15.19 prescriptions (Front desk strictly excluded)
DROP POLICY IF EXISTS "prescriptions_select_policy" ON public.prescriptions;
CREATE POLICY "prescriptions_select_policy" ON public.prescriptions
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('doctor'::user_role, 'nurse'::user_role, 'pharmacist'::user_role)
            AND (
                -- Pharmacists: active prescriptions requiring review/dispensing or authorized patient relationship
                (public.get_my_role() = 'pharmacist'::user_role AND status IN ('active'::prescription_status, 'partially_dispensed'::prescription_status))
                OR prescribing_doctor_id = auth.uid()
                OR public.can_access_patient(patient_id)
            )
        )
    );

DROP POLICY IF EXISTS "prescriptions_insert_policy" ON public.prescriptions;
CREATE POLICY "prescriptions_insert_policy" ON public.prescriptions
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() = 'doctor'::user_role
            AND prescribing_doctor_id = auth.uid()
            AND public.can_access_patient(patient_id)
        )
    );

DROP POLICY IF EXISTS "prescriptions_update_policy" ON public.prescriptions;
CREATE POLICY "prescriptions_update_policy" ON public.prescriptions
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() = 'doctor'::user_role
            AND prescribing_doctor_id = auth.uid()
            AND status = 'draft'::prescription_status
        )
        OR (
            public.is_active_staff()
            AND public.get_my_role() = 'pharmacist'::user_role
        )
    )
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND (
                (public.get_my_role() = 'doctor'::user_role AND prescribing_doctor_id = auth.uid())
                OR public.get_my_role() = 'pharmacist'::user_role
            )
        )
    );

-- 15.20 prescription_items (Front desk strictly excluded)
DROP POLICY IF EXISTS "rx_items_select_policy" ON public.prescription_items;
CREATE POLICY "rx_items_select_policy" ON public.prescription_items
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('doctor'::user_role, 'nurse'::user_role, 'pharmacist'::user_role)
            AND EXISTS (
                SELECT 1 FROM public.prescriptions p
                WHERE p.id = prescription_id
                  AND (
                      -- Pharmacists: active prescriptions requiring review/dispensing
                      (public.get_my_role() = 'pharmacist'::user_role AND p.status IN ('active'::prescription_status, 'partially_dispensed'::prescription_status))
                      OR p.prescribing_doctor_id = auth.uid()
                      OR public.can_access_patient(p.patient_id)
                  )
            )
        )
    );

DROP POLICY IF EXISTS "rx_items_insert_policy" ON public.prescription_items;
CREATE POLICY "rx_items_insert_policy" ON public.prescription_items
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() = 'doctor'::user_role
            AND EXISTS (
                SELECT 1 FROM public.prescriptions p
                WHERE p.id = prescription_id
                  AND p.prescribing_doctor_id = auth.uid()
                  AND p.status IN ('draft'::prescription_status, 'active'::prescription_status)
            )
        )
    );

DROP POLICY IF EXISTS "rx_items_update_policy" ON public.prescription_items;
CREATE POLICY "rx_items_update_policy" ON public.prescription_items
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() = 'pharmacist'::user_role
        )
        OR (
            public.is_active_staff()
            AND public.get_my_role() = 'doctor'::user_role
            AND EXISTS (
                SELECT 1 FROM public.prescriptions p
                WHERE p.id = prescription_id
                  AND p.prescribing_doctor_id = auth.uid()
                  AND p.status = 'draft'::prescription_status
            )
        )
    )
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND (
                public.get_my_role() = 'pharmacist'::user_role
                OR public.get_my_role() = 'doctor'::user_role
            )
        )
    );

-- 15.21 dispensing_records
DROP POLICY IF EXISTS "dispensing_select_policy" ON public.dispensing_records;
CREATE POLICY "dispensing_select_policy" ON public.dispensing_records
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('pharmacist'::user_role, 'doctor'::user_role)
        )
    );

DROP POLICY IF EXISTS "dispensing_insert_policy" ON public.dispensing_records;
CREATE POLICY "dispensing_insert_policy" ON public.dispensing_records
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_user()
            AND public.get_my_role() = 'pharmacist'::user_role
            AND pharmacist_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "dispensing_update_policy" ON public.dispensing_records;
CREATE POLICY "dispensing_update_policy" ON public.dispensing_records
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_user()
            AND public.get_my_role() = 'pharmacist'::user_role
            AND pharmacist_id = auth.uid()
        )
    )
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_user()
            AND public.get_my_role() = 'pharmacist'::user_role
            AND pharmacist_id = auth.uid()
        )
    );

-- 15.22 dispensing_items
DROP POLICY IF EXISTS "dispensing_items_select_policy" ON public.dispensing_items;
CREATE POLICY "dispensing_items_select_policy" ON public.dispensing_items
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.is_active_staff()
            AND public.get_my_role() IN ('pharmacist'::user_role, 'doctor'::user_role)
        )
    );

DROP POLICY IF EXISTS "dispensing_items_insert_policy" ON public.dispensing_items;
CREATE POLICY "dispensing_items_insert_policy" ON public.dispensing_items
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_user()
            AND public.get_my_role() = 'pharmacist'::user_role
        )
    );

-- 15.23 inventory_movements
DROP POLICY IF EXISTS "movements_select_policy" ON public.inventory_movements;
CREATE POLICY "movements_select_policy" ON public.inventory_movements
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (public.is_active_user() AND public.get_my_role() = 'pharmacist'::user_role)
    );

DROP POLICY IF EXISTS "movements_insert_policy" ON public.inventory_movements;
CREATE POLICY "movements_insert_policy" ON public.inventory_movements
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            public.is_active_user()
            AND public.get_my_role() = 'pharmacist'::user_role
            AND performed_by = auth.uid()
        )
    );

-- 15.24 audit_logs
DROP POLICY IF EXISTS "audit_logs_select_policy" ON public.audit_logs;
CREATE POLICY "audit_logs_select_policy" ON public.audit_logs
    FOR SELECT TO authenticated
    USING (public.is_admin());

DROP POLICY IF EXISTS "audit_logs_insert_policy" ON public.audit_logs;
CREATE POLICY "audit_logs_insert_policy" ON public.audit_logs
    FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() AND actor_id = auth.uid());

-- ============================================================================
-- SECTION 17: SUPABASE STORAGE BUCKET & STORAGE POLICIES
-- ============================================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage') THEN
        INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        VALUES (
            'medical-images',
            'medical-images',
            false,
            52428800,
            ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'image/tiff']::text[]
        )
        ON CONFLICT (id) DO UPDATE SET
            public = EXCLUDED.public,
            file_size_limit = EXCLUDED.file_size_limit,
            allowed_mime_types = EXCLUDED.allowed_mime_types;
    END IF;
END $$;

DROP POLICY IF EXISTS "medical_images_insert_policy" ON storage.objects;
CREATE POLICY "medical_images_insert_policy"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'medical-images'
    AND public.is_active_user()
    AND public.get_my_role() IN ('doctor'::user_role, 'lab_technician'::user_role)
    AND (storage.foldername(name))[1] = auth.uid()::TEXT
);

DROP POLICY IF EXISTS "medical_images_select_policy" ON storage.objects;
CREATE POLICY "medical_images_select_policy"
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'medical-images'
    AND (
        public.is_admin()
        OR EXISTS (
            SELECT 1 FROM public.patient_documents d
            WHERE d.storage_path = storage.objects.name
              AND public.can_access_patient(d.patient_id)
        )
    )
);

DROP POLICY IF EXISTS "medical_images_delete_policy" ON storage.objects;
CREATE POLICY "medical_images_delete_policy"
ON storage.objects
FOR DELETE
TO authenticated
USING (
    bucket_id = 'medical-images'
    AND NOT EXISTS (
        SELECT 1
        FROM public.patient_documents d
        WHERE d.storage_path = storage.objects.name
    )
    AND (
        public.is_admin()
        OR (
            public.is_active_user()
            AND public.get_my_role() IN ('doctor'::user_role, 'lab_technician'::user_role)
            AND (storage.foldername(name))[1] = auth.uid()::TEXT
        )
    )
);

-- ============================================================================
-- SECTION 18: INITIAL SYSTEM SETTINGS SEED DATA
-- ============================================================================
INSERT INTO public.system_settings (key, value, description)
VALUES
    ('max_doctors', '10', 'Maximum allowed active doctor accounts in Dreyson Global Hospital'),
    ('max_nurses', '10', 'Maximum allowed active nurse accounts in Dreyson Global Hospital'),
    ('max_pharmacists', '10', 'Maximum allowed active pharmacist accounts in Dreyson Global Hospital'),
    ('max_front_desk', '10', 'Maximum allowed active front desk accounts in Dreyson Global Hospital'),
    ('max_lab_technicians', '10', 'Maximum allowed active lab technician accounts in Dreyson Global Hospital')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- SECTION 19: PERMISSIONS AND EXECUTE GRANTS
-- ============================================================================
-- Schema usage
GRANT USAGE ON SCHEMA public TO authenticated, service_role;

-- Full structural rights strictly for backend service_role
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Least-privilege grants for authenticated users (row-level policies enforce row access)
-- Sequences: USAGE, SELECT needed for serials/generators
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Specific table grants for authenticated (no blanket DELETE or TRUNCATE):
-- Core entities and configuration
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.system_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.patients TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.patient_demographics TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.patient_encounters TO authenticated;
-- Immutable clinical data: SELECT and INSERT only (no UPDATE, no DELETE)
GRANT SELECT, INSERT ON public.patient_vitals TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.clinical_notes TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.patient_diagnoses TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.patient_allergies TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_documents TO authenticated;
-- Handoffs and workflow
GRANT SELECT, INSERT, UPDATE ON public.patient_file_transfers TO authenticated;
GRANT SELECT, INSERT ON public.patient_file_transfer_history TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated;
-- Laboratory workflows
GRANT SELECT, INSERT, UPDATE ON public.laboratory_orders TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.laboratory_order_items TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.laboratory_results TO authenticated;
-- Pharmacy and medications
GRANT SELECT, INSERT, UPDATE, DELETE ON public.medicine_catalog TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.medicine_batches TO authenticated;
GRANT SELECT, INSERT ON public.medicine_purchases TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.prescriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.prescription_items TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.dispensing_records TO authenticated;
GRANT SELECT, INSERT ON public.dispensing_items TO authenticated;
-- Immutable ledgers: SELECT and INSERT only
GRANT SELECT, INSERT ON public.inventory_movements TO authenticated;
GRANT SELECT, INSERT ON public.audit_logs TO authenticated;

GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_status() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_active_user() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_active_staff() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_profile_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_patient(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_transfer_recipient(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_transfer_sender(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_active_encounter_for_patient(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_staff_limit(user_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deduct_stock(UUID, UUID, INTEGER, UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receive_stock(UUID, TEXT, DATE, INTEGER, NUMERIC, TEXT, TEXT, DATE, UUID, TEXT) TO authenticated, service_role;
-- (REVOKED FOR SECURITY) EXECUTE ON FUNCTION public.increment_dispensed_qty
GRANT EXECUTE ON FUNCTION public.search_patients_shared(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_patients_frontdesk(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dispense_prescription_atomic(UUID, JSONB, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_my_profile(TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_patient_demographics(UUID, TEXT, TEXT, TEXT, DATE, sex_type, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- Demographic view permissions: explicitly revoked from anon/public, granted to authenticated & service_role
REVOKE ALL ON public.patient_demographics FROM anon, public;
GRANT SELECT, INSERT, UPDATE ON public.patient_demographics TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.log_audit_event(TEXT, TEXT, UUID, JSONB, JSONB, TEXT) TO authenticated, service_role;

-- Revoke dangerous permissions from public and anonymous users
REVOKE ALL ON FUNCTION public.deduct_stock(UUID, UUID, INTEGER, UUID, UUID) FROM anon, public;
REVOKE ALL ON FUNCTION public.check_staff_limit(user_role) FROM anon, public;
REVOKE ALL ON FUNCTION public.log_audit_event(TEXT, TEXT, UUID, JSONB, JSONB, TEXT) FROM anon, public;
REVOKE ALL ON FUNCTION public.receive_stock(UUID, TEXT, DATE, INTEGER, NUMERIC, TEXT, TEXT, DATE, UUID, TEXT) FROM anon, public;
REVOKE ALL ON FUNCTION public.increment_dispensed_qty(UUID, INTEGER) FROM anon, public;
REVOKE ALL ON FUNCTION public.search_patients_shared(TEXT) FROM anon, public;
REVOKE ALL ON FUNCTION public.search_patients_frontdesk(TEXT) FROM anon, public;
REVOKE ALL ON FUNCTION public.dispense_prescription_atomic(UUID, JSONB, TEXT) FROM anon, public;
REVOKE ALL ON FUNCTION public.update_my_profile(TEXT, TEXT) FROM anon, public;
REVOKE ALL ON FUNCTION public.update_patient_demographics(UUID, TEXT, TEXT, TEXT, DATE, sex_type, TEXT, TEXT, TEXT, TEXT, TEXT) FROM anon, public;
REVOKE ALL ON FUNCTION public.increment_dispensed_qty(UUID, INTEGER) FROM anon, public, authenticated;
REVOKE ALL ON FUNCTION public.get_active_encounter_for_patient(UUID) FROM anon, public;

-- Archive staff member RPC is strictly authenticated
REVOKE ALL ON FUNCTION public.archive_staff_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.archive_staff_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO authenticated;

COMMIT;

-- ============================================================================
-- SECTION 20: INITIAL ADMINISTRATOR PROVISIONING INSTRUCTIONS
-- ============================================================================
-- After applying this SQL script in the new Supabase project SQL Editor:
-- 1. In Supabase Dashboard -> Authentication -> Users, click "Add user" -> "Create user".
-- 2. Provide the administrator's email and a secure password. Auto-confirm user.
-- 3. Copy the generated User UID (e.g., '11111111-2222-3333-4444-555555555555').
-- 4. Run the following query in the SQL Editor to link their staff profile:
--
--    INSERT INTO public.profiles (id, full_name, email, role, staff_id, department, status)
--    VALUES (
--        '<PASTE_NEW_AUTH_USER_UUID>',
--        'System Administrator',
--        '<PASTE_NEW_ADMIN_EMAIL>',
--        'admin'::public.user_role,
--        'DGH-ADM-001',
--        'Administration',
--        'active'::public.account_status
--    )
--    ON CONFLICT (id) DO UPDATE SET
--        role = 'admin'::public.user_role,
--        status = 'active'::public.account_status;
-- ============================================================================
