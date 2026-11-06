-- ============================================================================
-- Dreyson Global Hospital — EMR System
-- Migration: 20261106120000_fix_patient_and_transfer_schema.sql
--
-- Fixes three groups of schema gaps discovered via frontend error analysis:
--
-- 1. patients table: add demographic fields that the registration form
--    already collects (alt_phone, email, next_of_kin, admin_notes).
--    These are purely demographic / administrative fields; they do NOT
--    contain clinical data (blood_group, genotype, allergies_summary are
--    intentionally excluded from this view).
--
-- 2. patient_demographics view: re-create to expose the new columns.
--    Preserves the original 15 columns in their exact existing order and
--    appends the four new columns at the end, allowing non-destructive
--    CREATE OR REPLACE VIEW without requiring DROP VIEW ... CASCADE.
--
-- 3. trg_patient_demographics_insert / trg_patient_demographics_update:
--    re-create both INSTEAD OF triggers so they propagate the new columns
--    through to the underlying patients table.
--
-- SAFETY NOTES:
-- * All ALTER TABLE … ADD COLUMN IF NOT EXISTS — safe to run on live data.
-- * No existing columns are dropped or renamed from public.patients.
-- * No existing patient records are modified.
-- * No RLS policies are changed.
-- * No DROP VIEW ... CASCADE or destructive operations.
-- ============================================================================

BEGIN;

-- ── 1. Add missing demographic columns to patients ───────────────────────────

ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS alt_phone  TEXT,
  ADD COLUMN IF NOT EXISTS email      TEXT,
  ADD COLUMN IF NOT EXISTS next_of_kin TEXT,
  ADD COLUMN IF NOT EXISTS admin_notes TEXT;

COMMENT ON COLUMN public.patients.alt_phone   IS 'Optional alternate contact phone number for the patient.';
COMMENT ON COLUMN public.patients.email        IS 'Optional patient email address for correspondence.';
COMMENT ON COLUMN public.patients.next_of_kin  IS 'Next of kin name and/or contact — distinct from emergency contact.';
COMMENT ON COLUMN public.patients.admin_notes  IS 'Administrative notes recorded at registration (not clinical notes).';

-- ── 2. Update patient_demographics view ───────────────────────────────────────
-- Preserves the original 15 columns in their exact existing order, then appends
-- alt_phone, email, next_of_kin, and admin_notes at the end.
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

COMMENT ON VIEW public.patient_demographics IS
  'Secure demographic-only view of patients with caller-role filtering; '
  'excludes sensitive clinical fields (blood_group, genotype, allergies_summary).';

-- ── 3. Re-create INSTEAD OF INSERT trigger function ──────────────────────────
-- Extends the original trigger to pass through the four new columns.

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
        address,
        emergency_contact_name,
        emergency_contact_relationship,
        emergency_contact_phone,
        alt_phone,
        email,
        next_of_kin,
        admin_notes,
        registered_by
    ) VALUES (
        NEW.first_name,
        NEW.last_name,
        NEW.middle_name,
        NEW.date_of_birth,
        NEW.sex,
        NEW.phone,
        NEW.address,
        NEW.emergency_contact_name,
        NEW.emergency_contact_relationship,
        NEW.emergency_contact_phone,
        NEW.alt_phone,
        NEW.email,
        NEW.next_of_kin,
        NEW.admin_notes,
        v_actor_id
    )
    RETURNING id, hospital_number INTO v_new_id, v_hosp_num;

    NEW.id              := v_new_id;
    NEW.hospital_number := v_hosp_num;
    NEW.registered_by   := v_actor_id;
    NEW.created_at      := now();
    NEW.updated_at      := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_patient_demographics_insert ON public.patient_demographics;
CREATE TRIGGER trg_patient_demographics_insert
INSTEAD OF INSERT ON public.patient_demographics
FOR EACH ROW EXECUTE FUNCTION public.trg_patient_demographics_insert();

-- ── 4. Re-create INSTEAD OF UPDATE trigger function ──────────────────────────
-- Extends the original trigger to allow updating the four new columns.
-- Never touches blood_group, genotype, or allergies_summary.

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

    -- Update only demographic and contact fields; never touches blood_group or genotype
    UPDATE public.patients
    SET
        first_name                     = NEW.first_name,
        last_name                      = NEW.last_name,
        middle_name                    = NEW.middle_name,
        date_of_birth                  = NEW.date_of_birth,
        sex                            = NEW.sex,
        phone                          = NEW.phone,
        address                        = NEW.address,
        emergency_contact_name         = NEW.emergency_contact_name,
        emergency_contact_relationship = NEW.emergency_contact_relationship,
        emergency_contact_phone        = NEW.emergency_contact_phone,
        alt_phone                      = NEW.alt_phone,
        email                          = NEW.email,
        next_of_kin                    = NEW.next_of_kin,
        admin_notes                    = NEW.admin_notes,
        updated_at                     = now()
    WHERE id = OLD.id;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_patient_demographics_update ON public.patient_demographics;
CREATE TRIGGER trg_patient_demographics_update
INSTEAD OF UPDATE ON public.patient_demographics
FOR EACH ROW EXECUTE FUNCTION public.trg_patient_demographics_update();

-- ── 5. Re-apply permissions on the view ───────────────────────────────────────
REVOKE ALL ON public.patient_demographics FROM anon, public;
GRANT SELECT, INSERT, UPDATE ON public.patient_demographics TO authenticated, service_role;

COMMIT;
