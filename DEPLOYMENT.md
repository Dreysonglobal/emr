# Deployment checklist

## 1. Supabase database

For a new project, open the Supabase SQL Editor and apply `supabase/dreyson_global_hospital_setup.sql` once. Then apply the SQL files in `supabase/migrations/` in timestamp order. The setup script is idempotent for its schema objects; keep it as the documented bootstrap for environments that do not yet have migration history.

For an existing project, apply any unapplied files in `supabase/migrations/` before deploying the matching client code. Verify the migration completed without errors, then test RLS using accounts from each role. Do not test with real patient records.

## 2. Edge Functions and secrets

Install the Supabase CLI and authenticate it, then from the project root run:

```powershell
supabase login
supabase link --project-ref lchosyfcjfrkfxtzopcj
supabase secrets set APP_ORIGIN=https://dreysonglobal.github.io
supabase functions deploy admin-create-staff --project-ref lchosyfcjfrkfxtzopcj
supabase functions deploy admin-update-staff --project-ref lchosyfcjfrkfxtzopcj
supabase functions deploy admin-deactivate-staff --project-ref lchosyfcjfrkfxtzopcj
supabase functions deploy admin-reset-staff-password --project-ref lchosyfcjfrkfxtzopcj
```

Set `APP_ORIGIN` to the exact HTTPS origin that hosts the frontend (scheme and hostname, with an optional port; no path or trailing slash). The CORS layer intentionally does not allow all origins. For local development, set the origin to the local web server origin. Never put `SUPABASE_SERVICE_ROLE_KEY` in browser code or the frontend hosting environment.

## 3. Auth configuration

In Supabase Auth settings:

- Add the production sign-in URL and the exact `index.html` password-recovery callback URL to the redirect allowlist.
- Configure SMTP for password recovery and verify recovery links with a test account. Staff accounts created in the admin dashboard use an initial password set by the administrator and do not send an invitation email; share that password securely.
- Disable public account registration if staff accounts are provisioned only by administrators.
- Set reasonable authentication and recovery rate limits.

The site must be served over HTTPS through a static host or web server; opening HTML files directly is not supported because the app uses JavaScript modules.

## 4. Frontend hosting

Publish the project root, preserving `index.html`, `css/`, `images/`, `js/`, and `pages/` paths. Configure response headers at the host/CDN:

- `Strict-Transport-Security` (after HTTPS is fully enabled)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- A restrictive `Content-Security-Policy` matching the policies in the HTML pages and allowing Supabase HTTPS/WebSocket endpoints and the pinned jsDelivr module
- `frame-ancestors 'none'` in the response CSP

The login page has a CSP meta policy; response headers are needed to apply a consistent policy to all dashboard routes and for directives such as `frame-ancestors`.

## 5. Pre-release verification

- Test sign-in, role-specific routing, sign-out, expired sessions, and the complete password-recovery flow.
- For each role, test allowed and denied RLS access, including direct API requests; hidden UI controls are not authorization.
- Test patient registration, encounter access, vitals, notes/signatures, laboratory orders/results, inventory dispensing, transfers, file uploads, signed document links, and upload rollback.
- Confirm backup/PITR retention and perform a restore drill before real records are entered.
- Verify monitoring, incident response, audit retention, staff offboarding, and applicable privacy/legal requirements with qualified reviewers.

There is no automated test suite or CI pipeline in this repository yet. Treat this checklist as manual pre-release verification, not as evidence of regulatory compliance.
