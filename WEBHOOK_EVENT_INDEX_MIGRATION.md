# Webhook Event Identity Index Migration

This procedure changes webhook idempotency from globally unique `eventId` to
provider-scoped `{ provider, eventId }` identity. It must run during an approved
deployment window. Do not run it from a developer workstation against production.

## Current And Target Indexes

The historical Mongoose declaration creates a unique single-field index normally
named `eventId_1`. The migration does not trust that name: it discovers every
unique index whose exact key is `{ eventId: 1 }`.

The target index is:

```javascript
{ provider: 1, eventId: 1 }
```

with name `provider_1_eventId_1` and `unique: true`.

## Pre-Deployment Validation

Use deployment-controlled credentials and run validation-only mode first:

```powershell
node scripts/migrate_webhook_event_identity_index.js
```

Validation makes no index changes. It fails closed when it finds:

- missing, null, non-string, or blank `provider` values
- missing, null, non-string, or blank `eventId` values
- duplicate `{ provider, eventId }` pairs
- provider values outside `paystack`, `monnify`, and `flutterwave`
- an existing compound target index that is not unique

The command prints index names and bounded duplicate/provider summaries. Review
all unexpected records. Do not invent or run cleanup automatically; prepare a
separately reviewed data-remediation plan if validation fails.

## Approved Apply Step

Only after validation passes and application traffic is controlled:

```powershell
$env:WEBHOOK_EVENT_INDEX_MIGRATION_CONFIRM='provider-event-identity'
node scripts/migrate_webhook_event_identity_index.js --apply
```

The script creates and verifies the compound unique index before dropping any
legacy global unique index. It then re-reads the index catalog and fails if the
target guarantee is absent or a global unique `eventId` index remains.

## Deployment Order

1. Stop or drain old application instances so old code cannot create events under
   global-only assumptions during the migration.
2. Run validation-only mode and archive its output with the deployment record.
3. Resolve any incompatible historical records through a separately approved plan.
4. Run the explicit apply command.
5. Start the hardened application version.
6. Send signed test webhooks for each configured provider and confirm independent
   `{ provider, eventId }` records.
7. Confirm every provider dashboard points to a retained endpoint before any later
   alias removal.

## Rollback Note

After different providers have stored the same textual event ID, the old global
unique index cannot be recreated without data loss. Roll back application code only
to a version that understands provider-scoped identity, or perform a separately
reviewed forward fix.
