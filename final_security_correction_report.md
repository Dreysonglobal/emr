# Dreyson Global Hospital EMR — Comprehensive SQL Schema Reconciliation & Security Hardening Report

**Target Supabase Project:** `lchosyfcjfrkfxtzopcj` (`https://lchosyfcjfrkfxtzopcj.supabase.co`)  
**Audited & Corrected File:** `supabase/dreyson_global_hospital_setup.sql`  
**Deployment Boundary:** Pure offline static verification. No remote database commands, SQL executions, or Edge Function deployments were performed. Original Life Blossom project (`yealxvgednecmwnehfrs`) remains completely untouched.  
**Validation Status:** Passed all 29 structural and security tests in `verify_sql.py` and passed all deep checks in `deep_sql_validator.py` with **0 errors and 0 warnings**.

---

## 1. Executive Summary & Audit Overview

Following an independent review of the Dreyson Global Hospital EMR database setup script, a comprehensive schema reconciliation and security audit was executed. Significant discrepancies were identified between underlying PostgreSQL `CREATE TABLE` definitions, views, triggers, stored procedures (RPCs), enum types, and Row-Level Security (RLS) policies.

Key vulnerabilities and schema inconsistencies resolved include:
1. **Patient Schema Inconsistency:** Phantom columns (`other_names`, `gender`, `phone_number`, `email`, `is_active`) referenced across views, triggers, and RPCs reconciled to the canonical `public.patients` table schema (`middle_name`, `sex`, `phone`).
2. **Front Desk Direct Table Access & Sensitive Data Leakage:** Direct `SELECT` on `public.patients` revoked for `front_desk`. Front Desk access is now strictly confined to the secured `public.patient_demographics` view and `search_patients_frontdesk()` RPC, guaranteeing zero exposure of `blood_group`, `genotype`, or `allergies_summary`.
3. **Pharmacy Schema & Dispensing Integrity:** Resolved 8 distinct column mismatches in `dispense_prescription_atomic()`: corrected `dispensed_by` to `pharmacist_id`, supplied missing `patient_id` on header creation, fixed `dispensing_id` to `dispensing_record_id`, aligned `quantity` to `quantity_dispensed`, supplied missing `medicine_id`, removed nonexistent `is_active` and `unit_price` from batches (retrieving `unit_price` from `medicine_catalog`), and removed invalid updates to non-existent columns (`status`, `dispensed_at`, `updated_at`) on `prescription_items`.
4. **Enum Type Reconciliation:** Eliminated references to the non-existent `prescription_item_status` enum type and removed invalid enum cast `'pending'::prescription_status` (prescriptions transition between `'draft'`, `'active'`, `'partially_dispensed'`, `'dispensed'`, `'cancelled'`). Default status of `dispensing_records` set to `'pending'::dispensing_status`.
5. **Encounter Access Enforcement:** Removed unconditional role-based encounter viewing in `get_active_encounter_for_patient()`. Replaced blanket front-desk access in `encounters_select_policy` with strict author/relationship checks.
6. **Elimination of Permanent Transfer Access:** Removed `'completed'` status from `can_access_patient()`. Departmental handoffs now terminate clinical record access upon transfer completion, return, or cancellation.
7. **Role-Scoped Laboratory & Pharmacy Isolation:** Restricted laboratory orders/items to assigned technicians, unassigned pending queues, or active clinical relationships. Restricted pharmacy orders/items to active dispensing queues or authorized care relationships.
8. **Role-Masked Patient Search:** Updated `search_patients_shared()` to dynamically mask `blood_group` and `genotype` to `NULL` for Front Desk and non-clinical roles.
9. **Least-Privilege Database Grants:** Replaced blanket `GRANT ALL ON ALL TABLES` with table-by-table permissions for `authenticated` users, revoking unneeded `DELETE` privileges and enforcing immutability on vitals, clinical audit logs, and inventory ledgers.

---

## 2. Canonical Schema Reconciliation Matrix

### A. Patient Entity Reconciled to Canonical Schema
The underlying `public.patients` table defines:
`id`, `hospital_number`, `first_name`, `middle_name`, `last_name`, `date_of_birth`, `sex` (`sex_type`), `phone`, `emergency_contact_name`, `emergency_contact_phone`, `emergency_contact_relationship`, `blood_group`, `genotype`, `allergies_summary`, `address`, `registered_by`, `created_at`, `updated_at`.

| Dependent Object | Previous Inconsistency | Canonical Correction Applied |
| :--- | :--- | :--- |
| `public.patient_demographics` (View) | Queried `other_names`, `gender`, `phone_number`, `email`, `is_active` | Aligned to `middle_name`, `sex`, `phone`, `address`, `emergency_contact_*`. Excludes `blood_group`, `genotype`, `allergies_summary`. |
| `trg_patient_demographics_insert()` | Inserted phantom columns into `public.patients` | Maps `NEW.middle_name`, `NEW.sex`, `NEW.phone`, `NEW.address`, `v_actor_id`. Removed `email`, `gender`, `is_active`. |
| `trg_patient_demographics_update()` | Attempted to update phantom columns on `public.patients` | Updates `middle_name`, `sex`, `phone`, `address`, `emergency_contact_*`. Removed phantom columns. |
| `update_patient_demographics()` (RPC) | Parameters: `p_other_names`, `p_gender gender_type`, `p_phone_number`, `p_email` | Updated parameters: `p_middle_name text`, `p_sex sex_type`, `p_phone text`. Removed `p_email` and undeclared `gender_type`. |
| `search_patients_frontdesk()` (RPC) | Returned table with `other_names`, `gender gender_type`, `phone_number`, `email`, `is_active` | Returns table with `middle_name`, `sex sex_type`, `phone`, `address`. Added caller role verification guard. |
| `patients_select_policy` | Permitted `public.is_admin() OR public.is_active_staff()` | Front Desk explicitly excluded from raw table: `public.is_admin() OR (public.is_active_staff() AND public.get_my_role() != 'front_desk'::user_role)`. |
| Patient Indexes | Verified index coverage | Indexed canonical columns: `hospital_number`, `phone`, `last_name`, `first_name`, `registered_by`. |

### B. Pharmacy & Dispensing Schema Reconciled to Canonical Schema
The pharmacy sub-system comprises `medicine_catalog`, `medicine_batches`, `medicine_purchases`, `prescriptions`, `prescription_items`, `dispensing_records`, `dispensing_items`, and `inventory_movements`.

| Object & Operation | Discovered Mismatch | Resolution Applied |
| :--- | :--- | :--- |
| `dispense_prescription_atomic` (Header Insert) | Inserted `dispensed_by` into `dispensing_records`; omitted `patient_id` | Changed `dispensed_by` to `pharmacist_id`; added `patient_id := v_rx.patient_id`. |
| `dispense_prescription_atomic` (Batch Query) | Filtered `medicine_batches` on `is_active = true` (column does not exist on batches) | Removed `is_active = true`; filtered on `quantity_remaining >= v_dispense_qty AND expiry_date >= CURRENT_DATE`. |
| `dispense_prescription_atomic` (Batch Pricing) | Referenced `v_batch.unit_price` (`medicine_batches` only stores `cost_price`) | Added lookup to retrieve `unit_price` from `public.medicine_catalog WHERE id = v_rx_item.medicine_id`. |
| `dispense_prescription_atomic` (Item Insert) | Inserted `dispensing_id` and `quantity` into `dispensing_items`; omitted `medicine_id` | Aligned column names: `dispensing_record_id := v_dispensing_id`, `quantity_dispensed := v_dispense_qty`, `medicine_id := v_rx_item.medicine_id`. |
| `dispense_prescription_atomic` (Rx Item Update) | Updated `status`, `dispensed_at`, and `updated_at` on `prescription_items` | `prescription_items` table only maintains `quantity_dispensed`. Removed phantom column updates. |
| `dispense_prescription_atomic` (Stock Deduction) | Called `deduct_stock` using named args `p_reason` and `p_reference_id` | Aligned call to match declared signature: `p_dispensing_record_id := v_dispensing_id, p_performed_by := v_actor_id`. |
| `dispense_prescription_atomic` (Status Filter) | Filtered `v_rx.status NOT IN ('pending'::prescription_status, ...)` | `'pending'` is not in `prescription_status` enum. Replaced with `'active'::prescription_status, 'draft'::prescription_status`. |
| `dispense_prescription_atomic` (Return Payload) | Returned only `'dispensing_id'` in JSONB | Returns both `'dispensing_id'` and `'dispensing_record_id'` for total frontend compatibility. |
| `enforce_rx_item_update_integrity` (Trigger) | Checked `NEW.dose` and `NEW.route` (neither exists on `prescription_items`) | Corrected `NEW.dose` to `NEW.dosage`; removed check for nonexistent `NEW.route`. |
| `dispensing_records` (Table Definition) | `DEFAULT 'completed'::dispensing_status` | Changed table default to `DEFAULT 'pending'::dispensing_status` to prevent desynchronized trigger execution. |

### C. Profiles & Staff Management Reconciled
| Object & Operation | Discovered Mismatch | Resolution Applied |
| :--- | :--- | :--- |
| `update_my_profile()` (RPC) | Accepted `p_first_name`, `p_last_name`, `p_phone_number` and updated nonexistent columns | Aligned to canonical `profiles` schema (`full_name TEXT`, `phone TEXT`): signature updated to `(p_full_name TEXT, p_phone TEXT)`. |
| `GRANT` / `REVOKE` on `update_my_profile` | Declared with old 3-parameter signature in Section 18 | Aligned to `(TEXT, TEXT)` across all grant and revoke blocks. |
| `protect_profile_sensitive_fields()` | Protected `role`, `status`, `staff_id`, `deleted_at`, `email`, `department` | Retained full protection against privilege escalation. Ordinary users cannot promote themselves or alter status. |

---

### D. PostgreSQL DDL Execution Ordering Reconciled
- **Root Cause of Error 42883:** The patient_demographics view (originally at line 283) referenced public.is_active_staff(), public.is_admin(), public.get_my_role(), and public.can_access_patient(id) in its WHERE clause. In PostgreSQL, CREATE VIEW parses and compiles query semantics immediately. Because the helper functions were declared later in Section 10, execution failed with ERROR: 42883: function public.is_active_staff() does not exist.
- **Restructured Dependency Order:**
  1. Section 1 to 5: Extensions, Enums, Sequences, Base Functions, and all 24 Tables.
  2. Section 6: Comprehensive Performance and Foreign Key Indexes.
  3. Section 7: Secure Helper Functions (is_admin, is_active_staff, get_my_role, can_access_patient, etc.).
  4. Section 8: public.patient_demographics View & Triggers (now compiles cleanly with all functions and tables pre-existing).
  5. Section 9 to 19: Triggers, RPCs, RLS Policies, Storage, Seed Data, and Permissions.

## 3. Workflow & Access Control Hardening

### 1. Clinical Encounters
- **Function Hardened:** `get_active_encounter_for_patient(p_patient_id UUID)`
  - *Previous Vulnerability:* Granted unconditional access to encounter details and chief complaints if `get_my_role() IN ('doctor', 'nurse', 'front_desk')`.
  - *Hardened Implementation:* Unconditional role bypass removed. Requires verified active staff credentials and patient-specific authorization via `public.can_access_patient(p_patient_id)` or administrator privileges (`public.is_admin()`).
- **Policy Hardened:** `encounters_select_policy`
  - *Previous Vulnerability:* Front Desk personnel could read all patient encounters hospital-wide.
  - *Hardened Implementation:* Front Desk can only read encounters they personally opened (`opened_by = auth.uid()`), closed, or where a verified patient care relationship exists. Prevents unauthorized browsing of clinical chief complaints while preserving patient check-in workflows.

### 2. Departmental Handoffs & File Transfers
- **Function Hardened:** `can_access_patient(patient_uuid UUID)`
  - *Previous Vulnerability:* Included `'completed'` in `status IN ('sent', 'received', 'in_progress', 'awaiting_results', 'awaiting_pharmacy', 'completed')`, granting permanent clinical record access to any past transfer participant.
  - *Hardened Implementation:* Removed `'completed'`. Transfer-based clinical access is active strictly while status is in `('sent', 'received', 'in_progress', 'awaiting_results', 'awaiting_pharmacy')`. Once a transfer is completed, cancelled, or returned, transfer-based access terminates immediately.

### 3. Laboratory Orders & Results Isolation
- **Policies Hardened:** `lab_orders_select_policy` and `lab_order_items_select_policy`
  - *Previous Vulnerability:* Permitted all laboratory technicians to read every lab order and test item hospital-wide.
  - *Hardened Implementation:* Laboratory technicians can only access:
    1. Orders specifically assigned to them (`assigned_technician_id = auth.uid()`),
    2. Unassigned pending work queue items awaiting pickup (`assigned_technician_id IS NULL AND status IN ('pending', 'assigned')`),
    3. Orders for patients where they hold a verified diagnostic care relationship (`can_access_patient(patient_id)`).
  - Doctors and nurses retain access to orders for their authorized patients or orders they placed.

### 4. Pharmacy Orders & Prescription Isolation
- **Policies Hardened:** `prescriptions_select_policy` and `rx_items_select_policy`
  - *Previous Vulnerability:* Permitted all pharmacists to read every prescription and line item across all hospital history.
  - *Hardened Implementation:* Pharmacists can only read prescriptions in active dispensing workflow states (`status IN ('active', 'partially_dispensed')`) or for patients with whom they have an authorized care relationship (`can_access_patient(patient_id)`). Historical, cancelled, or unsubmitted draft prescriptions belonging to other clinicians are hidden.

### 5. Patient Search Demographic Masking
- **Function Hardened:** `search_patients_shared(p_search TEXT)`
  - *Previous Vulnerability:* Returned raw `blood_group` and `genotype` strings to all authenticated staff callers, including Front Desk.
  - *Hardened Implementation:* Evaluates caller clinical credentials (`public.is_admin() OR v_role IN ('doctor', 'nurse')`). If the caller is Front Desk or non-clinical, `blood_group` and `genotype` are dynamically masked to `NULL`. Clinical staff retain full access.

---

## 4. Least-Privilege Grant Restructuring

Blanket privilege grant `GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role;` was removed. 

The security architecture now enforces:
1. **`service_role` (Backend):** Retains `ALL` on all tables and sequences for administrative automation and Edge Functions.
2. **`authenticated` (Staff Users):** Granted precise, principle-of-least-privilege permissions:
   - **Full Workflow (`SELECT, INSERT, UPDATE`):** `profiles` (no delete), `system_settings`, `patients` (no delete), `patient_demographics`, `patient_encounters` (no delete), `clinical_notes`, `patient_diagnoses`, `patient_allergies`, `patient_file_transfers`, `laboratory_orders`, `laboratory_order_items`, `laboratory_results`, `medicine_batches`, `prescriptions`, `prescription_items`, `dispensing_records`.
   - **Scoped Deletes (`SELECT, INSERT, UPDATE, DELETE`):** `patient_documents` (removable by author/admin), `notifications` (dismissable), `medicine_catalog` (catalog management by admin).
   - **Immutable Records (`SELECT, INSERT` Only — No `UPDATE`, No `DELETE`):**
     - `patient_vitals`: Clinical measurements cannot be modified or deleted once recorded.
     - `patient_file_transfer_history`: Permanent handoff audit log.
     - `medicine_purchases`: Inbound procurement financial ledger.
     - `dispensing_items`: Itemized physical stock deduction history.
     - `inventory_movements`: Pharmaceutical stock change ledger.
     - `audit_logs`: Administrative compliance trail.
3. **`anon` and `PUBLIC`:** Explicitly revoked from all tables, sequences, views (`patient_demographics`), and stored procedures.

---

## 5. Frontend Compatibility & Reconciliation

The frontend codebase was audited and synchronized to prevent runtime errors:

1. **`js/pharmacy.js`:**
   - Replaced all non-existent column references `medicine_name` with `generic_name` (and composite display: `generic_name + (brand_name ? ' (' + brand_name + ')' : '')`).
   - Replaced non-existent column `available_stock` with `current_stock` across catalog queries, inventory sorting, low-stock counters, and updates.
   - Preserved atomic multi-item dispensing workflow through `dispense_prescription_atomic`.
2. **`js/api/shared-api.js`:**
   - Synchronized Supabase joins to select `generic_name, brand_name, current_stock` instead of `medicine_name` and `available_stock`.
   - Verified payload parameters for `dispense_prescription_atomic`.
3. **`js/doctor.js`:**
   - Synchronized prescription rendering to display `item.generic_name` with fallback.
   - Updated encounter listings from nonexistent `encounter_type` to `department` / `encounter_number`.
4. **`js/patient-file.js`:**
   - Replaced `medicine_name` and `available_stock` in medication ledger displays.
5. **`js/frontdesk.js`:**
   - Replaced references to nonexistent `encounter_type` column on `patient_encounters` with `department: currentProfile.department || 'General Outpatient'`.
   - Ensured all patient registrations route cleanly through `patient_demographics` view with `trg_patient_demographics_insert`.
6. **`js/api/patients-api.js`:**
   - Updated `updatePatient()` to automatically fall back to the secure `patient_demographics` view whenever direct table update on `patients` encounters RLS denial.

---

## 6. Static Verification Results

Automated static analysis was executed on `supabase/dreyson_global_hospital_setup.sql`:

```
============================================================
DEEP STATIC VALIDATOR REPORT
============================================================
  [INFO] Declared 13 enums: user_role, account_status, transfer_status, encounter_status,
         lab_order_status, lab_result_status, prescription_status, dispensing_status,
         document_category, movement_type, sex_type, priority_type, note_type
  [INFO] Declared 24 tables: profiles, system_settings, patients, patient_encounters,
         patient_vitals, clinical_notes, patient_diagnoses, patient_allergies,
         patient_documents, patient_file_transfers, patient_file_transfer_history,
         notifications, laboratory_orders, laboratory_order_items, laboratory_results,
         medicine_catalog, medicine_batches, medicine_purchases, prescriptions,
         prescription_items, dispensing_records, dispensing_items, inventory_movements,
         audit_logs
  [INFO] Declared 38 functions
  [INFO] Found 27 triggers
  [INFO] Found 67 RLS policies
============================================================
RESULT: 0 errors, 0 warnings.
ALL VERIFICATIONS PASSED WITH ZERO ERRORS!
```

Checks completed:
- [x] Dollar quote tag parity: 80 tags (40 blocks balanced)
- [x] Transaction wrapper: `BEGIN;` and `COMMIT;` boundaries intact
- [x] 24/24 database tables validated against all `INSERT` and `UPDATE` statements
- [x] `public.patient_demographics` view validated for column cleanliness and security barrier
- [x] `public.dispense_prescription_atomic` FEFO ordering, row locking, and batch resolution validated
- [x] Profile sensitive field trigger and policy separation validated
- [x] Zero references to nonexistent columns (`other_names`, `gender`, `phone_number`, `medicine_name`, `available_stock`)
- [x] Zero references to nonexistent enum `prescription_item_status`
- [x] Zero invalid casts to `'pending'::prescription_status`
- [x] Least-privilege table grants in place for `authenticated`

---

## 7. Remaining Limitations & Architectural Trade-offs

1. **Security Definer Function Scope:**  
   Security definer functions (`can_access_patient`, `dispense_prescription_atomic`, `trg_patient_demographics_insert`, etc.) run with view-owner/table-creator privileges. To mitigate privilege escalation risks, every security definer function specifies a fixed `search_path = public, auth` and explicitly evaluates `auth.uid()`, `public.is_active_staff()`, and caller roles before performing mutations.
2. **Physical Deletions Restricted:**  
   Under the least-privilege grant model, `authenticated` users cannot issue SQL `DELETE` commands on patient records, vitals, clinical progress notes, transfers, prescriptions, or audit logs. Deletions must occur via administrative soft-delete flags (e.g. `deleted_at`) or administrative review.
3. **Offline Static Testing Boundary:**  
   In compliance with user instructions, no live connections to Supabase project `lchosyfcjfrkfxtzopcj` were opened, and no SQL was executed against remote servers. All validations reflect strict static analysis and abstract syntax verification.

---

## 8. Post-Deployment Verification Suite

Execute these verification checks in the Supabase SQL Editor once the script is applied to project `lchosyfcjfrkfxtzopcj`:

### Test Suite 1: Front Desk Isolation
```sql
-- 1. Sign in as Front Desk staff
-- 2. Attempt direct select from public.patients (MUST return 0 rows)
SELECT * FROM public.patients;

-- 3. Select from patient_demographics (MUST return demographic fields, NO clinical columns)
SELECT * FROM public.patient_demographics LIMIT 5;

-- 4. Execute search_patients_shared as front desk (blood_group and genotype MUST be NULL)
SELECT blood_group, genotype FROM public.search_patients_shared('Test');
```

### Test Suite 2: Profile Privilege Escalation Prevention
```sql
-- 1. Sign in as ordinary doctor or nurse
-- 2. Attempt self-promotion to admin (MUST fail with insufficient_privilege exception)
UPDATE public.profiles SET role = 'admin' WHERE id = auth.uid();

-- 3. Attempt changing account status (MUST fail)
UPDATE public.profiles SET status = 'active' WHERE id = auth.uid();
```

### Test Suite 3: Atomic Prescription Dispensing
```sql
-- 1. Create a draft prescription and activate it
-- 2. Call dispense_prescription_atomic as active pharmacist
SELECT public.dispense_prescription_atomic(
    '<PRESCRIPTION_UUID>',
    '[{"item_id": "<ITEM_UUID>", "quantity": 1}]'::jsonb,
    'Post-deployment automated test'
);
-- 3. Verify stock deduction in medicine_batches and inventory_movements ledger
SELECT * FROM public.inventory_movements WHERE reference_id = '<DISPENSING_RECORD_UUID>';
```

### Test Suite 4: Transfer Handoff Expiration
```sql
-- 1. Initiate patient transfer from Department A to Department B
-- 2. While status is 'sent', verify recipient can access patient records via can_access_patient()
-- 3. Update transfer status to 'completed'
-- 4. Verify can_access_patient() returns FALSE for recipient unless another care relationship exists
```
