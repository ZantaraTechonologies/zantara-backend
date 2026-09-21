# First SuperAdmin Bootstrap

## Purpose

`bootstrap_superadmin.js` exists only to create the first production
SuperAdmin on a fresh database before the initial legal-document seed. It is a
one-time deployment tool, not an HTTP endpoint or a routine administration
workflow.

Do not use this script for routine administrator creation or promotion. After
bootstrap, use the existing administrative mechanisms and `promoteAdmin.js`
workflow.

## Safeguards

- `MONGO_URI` is required and must include an explicit database name.
- `BOOTSTRAP_SUPERADMIN_CONFIRM` must exactly equal
  `create-initial-superadmin`.
- The script refuses to run if any SuperAdmin already exists.
- Existing users are never promoted or modified.
- Duplicate phone or email values abort the operation.
- The password is bcrypt-hashed with the same cost used by registration.
- Only one User document is created. No wallet, KYC, legal acceptance,
  referral, virtual account, notification, PIN, or financial record is
  deliberately created.
- The persisted active status and both SuperAdmin role representations are
  verified before success is reported.

## Temporary Inputs

Set these only for the bootstrap process:

```text
MONGO_URI
BOOTSTRAP_SUPERADMIN_CONFIRM=create-initial-superadmin
BOOTSTRAP_SUPERADMIN_NAME
BOOTSTRAP_SUPERADMIN_PHONE
BOOTSTRAP_SUPERADMIN_EMAIL
BOOTSTRAP_SUPERADMIN_PASSWORD
```

`BOOTSTRAP_SUPERADMIN_EMAIL` is optional. The other values are required. Do
not place bootstrap credentials in committed files or add these variables to
normal runtime configuration requirements.

Run from the backend repository root:

```powershell
node scripts/bootstrap_superadmin.js
```

## One-Time Sequence

1. Keep public application traffic disabled.
2. Configure the final `MONGO_URI`.
3. Supply the temporary bootstrap variables.
4. Run `node scripts/bootstrap_superadmin.js`.
5. Remove the temporary bootstrap credential variables.
6. Prepare the separately approved legal content.
7. Run `node scripts/seed_legal_documents.js`.
8. Verify the published legal documents and registration requirements.
9. Authenticate the SuperAdmin.
10. Enable normal registration and application traffic.
