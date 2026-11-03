-- ============================================================================
-- Migration: 20261103150000_add_staff_archive_support.sql
-- Life Blossom Care and Cure Hospital — EMR System
--
-- PURPOSE:
--   Adds atomic soft-delete (archive) and audit logging support for staff profiles.
--   Allows deactivated staff members to be safely archived from active management
--   while guaranteeing that a profile is NEVER archived without an immutable audit record.
--
-- HARDENING & SECURITY DECISIONS:
--   1. Adds nullable deleted_at column to public.profiles.
--   2. Adds partial index to make filtering non-archived profiles efficient.
--   3. Updates profiles SELECT RLS policy to hide archived profiles from non-admin active users.
--   4. public.archive_staff_member() is implemented as SECURITY INVOKER:
--      - Does NOT elevate privileges; runs strictly under the authenticated caller's identity (auth.uid()).
--      - Existing RLS policies (profiles_update_policy, audit_logs_insert_policy) and the
--        trg_protect_profile_sensitive_fields trigger permit active administrators to execute
--        the update and audit log insert directly.
--      - Uses SET search_path = '' to completely prevent search-path hijacking attacks.
--      - Fully qualifies every database object, schema, and type (public.*, auth.*, pg_catalog.*).
--   5. Restricts execution grants:
--      - Granted ONLY to authenticated.
--      - Explicitly REVOKED from PUBLIC, anon, and service_role.
--   6. Enforces single-transaction atomicity:
--      - Row locking with FOR UPDATE prevents concurrent race conditions.
--      - If the audit_logs insert fails, PostgreSQL aborts the entire transaction and rolls back
--        the profile update automatically.
--
-- DO NOT RUN until reviewed and approved. Run with:
--   npx supabase db push  (against remote)
-- or apply via the Supabase SQL editor in the dashboard.
-- ============================================================================

BEGIN;

-- ─── 1. Add deleted_at column ────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deleted_at pg_catalog.timestamptz DEFAULT NULL;

COMMENT ON COLUMN public.profiles.deleted_at IS
  'Soft-delete timestamp. NULL = active/visible profile. Non-NULL = archived by an administrator. '
  'Never physically deletes the row; preserves all FK references and audit history.';

-- ─── 2. Partial index for efficient non-archived lookups ─────────────────────
CREATE INDEX IF NOT EXISTS idx_profiles_not_archived
  ON public.profiles (id)
  WHERE deleted_at IS NULL;

-- ─── 3. Update SELECT RLS policy to hide archived profiles from non-admins ───
-- Preserves all existing conditions:
--   - Profile owner can always view their own profile (id = auth.uid())
--   - Administrators see every profile (active, deactivated, or archived) (public.is_admin())
--   - Active users see active profiles where deleted_at IS NULL
DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;

CREATE POLICY "profiles_select_policy"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (
    id = auth.uid()
    OR public.is_admin()
    OR (
      public.is_active_user()
      AND status = 'active'::public.account_status
      AND deleted_at IS NULL
    )
  );

-- ─── 4. Hardened Atomic Archive & Audit RPC Function ─────────────────────────
-- Configured with SECURITY INVOKER and SET search_path = ''
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
    -- 1. Authorization: Only active administrators may archive staff
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Only active administrators may archive staff profiles.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    v_caller_id := auth.uid();

    -- 2. Self-archive protection: Admins cannot archive their own account
    IF v_caller_id = p_target_user_id THEN
        RAISE EXCEPTION 'Administrators cannot archive their own profile.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 3. Lock target profile row for update to eliminate concurrent race conditions
    SELECT * INTO v_target_profile
    FROM public.profiles
    WHERE id = p_target_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Staff member profile not found.'
            USING ERRCODE = 'no_data_found';
    END IF;

    -- 4. Target account safety: Cannot archive administrator accounts
    IF v_target_profile.role = 'admin'::public.user_role THEN
        RAISE EXCEPTION 'Administrator accounts cannot be archived.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 5. Status prerequisite: Target must already be deactivated
    IF v_target_profile.status != 'deactivated'::public.account_status THEN
        RAISE EXCEPTION 'Only deactivated staff profiles can be archived. Deactivate the account first.'
            USING ERRCODE = 'check_violation';
    END IF;

    -- 6. Idempotency: Prevent double-archiving
    IF v_target_profile.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'This staff profile has already been archived.'
            USING ERRCODE = 'unique_violation';
    END IF;

    -- 7. Retrieve caller email for audit metadata
    SELECT email INTO v_actor_email
    FROM public.profiles
    WHERE id = v_caller_id;

    -- 8. Build structured audit payloads
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

    -- 9. Update profiles table (soft delete)
    -- Under SECURITY INVOKER, profiles_update_policy allows this because public.is_admin() is true.
    -- The trg_protect_profile_sensitive_fields trigger permits this because role, status,
    -- staff_id, and id are not altered.
    UPDATE public.profiles
    SET deleted_at = v_archived_at,
        updated_at = v_archived_at
    WHERE id = p_target_user_id;

    -- 10. Insert audit log entry atomically
    -- Under SECURITY INVOKER, audit_logs_insert_policy requires (public.is_admin() AND actor_id = auth.uid()).
    -- Since v_caller_id = auth.uid() and public.is_admin() is true, the policy check succeeds.
    -- If this INSERT fails, the entire transaction aborts and the UPDATE rolls back.
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

    -- Return safe archived profile fields
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

-- ─── 5. Execution Grants & Revocations ─────────────────────────────────────────
-- Revoke execution from PUBLIC, anon, and service_role; grant strictly to authenticated
REVOKE EXECUTE ON FUNCTION public.archive_staff_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.archive_staff_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.archive_staff_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.archive_staff_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text) TO authenticated;

COMMIT;
