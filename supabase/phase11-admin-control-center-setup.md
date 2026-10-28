# Phase 11 Admin Control Center setup

Apply this migration after the existing creator verification, marketplace, and
monetization migrations:

1. Existing base/schema migrations, including `schema.sql`, `schema-patch.sql`,
   `creator-video-migration.sql`, `video-listing-link-migration.sql`, and
   `social-interactions-migration.sql`, as required by the deployment.
2. `phase7-community-trust-migration.sql`
3. `creator-verification-admin-migration.sql`
4. `phase8-marketplace-growth-migration.sql`
5. `phase10-monetization-migration.sql`
6. `phase11-admin-control-center-migration.sql`

The first administrator remains the explicit row in
`public.verification_admins`. The browser cannot grant, revoke, or edit that
role.

## Admin URL

```text
/admin
```

The deployed app also keeps these direct routes:

- `/admin/verification`
- `/admin/revenue`
- `/admin/verification/:requestId`

## Security model

- Every Admin Control Center RPC calls `public.require_verification_admin()`.
- `public.is_verification_admin()` checks the authenticated Supabase Auth UID
  against the server-controlled `verification_admins` table.
- `admin_audit_logs` has administrator-only RLS.
- Reports, private financial records, promotion requests, and moderation data
  are returned through administrator-only security-definer functions.
- Video/listing/idea moderation changes are written through audited functions;
  ordinary clients have no write policy for those administrative changes.
- Verification evidence continues to use the private bucket and short-lived
  signed URLs from the verification admin system.

## Deliberately unavailable controls

- Account suspension and role management: no account-status model exists yet.
- Video reports: the current product has comment and listing reports, but no
  video-report table.
- Live payment actions: the payment provider and webhook backend are disabled.
- Paid promotion activation: current promotion requests remain non-paid.

These are shown as unavailable or routed to the existing disabled workflows;
the UI does not present dead moderation or payment controls.
