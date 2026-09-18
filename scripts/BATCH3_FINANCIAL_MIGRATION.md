# Batch 3 Financial Integrity Migration

This migration is a deployment prerequisite for the Batch 3 settlement and
investment integrity changes. It must be run by an approved operator against a
verified backup during a fully quiesced maintenance window.

## Required Quiescence

`MAINTENANCE_MODE` alone is not sufficient. Payment webhook routes are mounted
before the maintenance middleware, and running application instances start cron
work that can write to the database.

Before validation or apply:

- stop every Zantara backend/application instance,
- stop every cron and worker process,
- block payment webhook ingress upstream,
- confirm that no application process is writing to the target database,
- verify a restorable backup,
- provide an explicitly approved `MONGO_URI` that contains the target database
  name.

The migration rejects a URI without an explicit database name. It does not
hardcode an environment or database.

## Validation-Only Run

With all writers stopped, run without `--apply`:

```powershell
node scripts/migrate_batch3_financial_integrity.js
```

Validation-only mode reads raw collection data and index metadata. It does not
mutate data or create indexes. Review every reported finding, including:

- duplicate or malformed local transaction references,
- duplicate settlement idempotency keys,
- duplicate or malformed provider-scoped transaction identities,
- intermediate settlements incompatible with runtime evidence validation,
- pending investment withdrawals with missing, malformed, or inconsistent
  reservation proof,
- pending share exits with missing, malformed, or inconsistent reservation
  proof,
- malformed `sharesOwned` or `frozenShares`, including BSON numeric types that
  runtime validation would reject or interpret inconsistently,
- missing or conflicting required index specifications,
- malformed existing global share-issuance lock state.

Duplicate identities, malformed index keys, malformed user share balances, and
index conflicts block apply and require manual reconciliation. The migration
does not infer or repair ambiguous financial values.

## Complete Required Index Set

Application startup does not create these indexes because `autoIndex` is
disabled on the affected schemas. Apply mode creates and verifies the complete
required set after historical validation.

`transactionstatuses`:

- unique `refId_1` on `{ refId: 1 }`,
- `userId_1` on `{ userId: 1 }`,
- `status_1` on `{ status: 1 }`,
- `createdAt_-1` on `{ createdAt: -1 }`,
- `status_1_settlementLeaseExpiresAt_1` on
  `{ status: 1, settlementLeaseExpiresAt: 1 }`,
- partial unique `confirmedProvider_1_confirmedProviderRef_1_unique_partial`
  on `{ confirmedProvider: 1, confirmedProviderRef: 1 }`.

`walletledgers`:

- `walletId_1` on `{ walletId: 1 }`,
- `userId_1` on `{ userId: 1 }`,
- `reference_1` on `{ reference: 1 }`,
- partial unique `settlementKey_1_unique_partial` on `{ settlementKey: 1 }`.

MongoDB's mandatory `_id_` index remains implicit on both collections. The
migration preserves unrelated indexes. A same-name/different-specification or
same-key/different-name conflict fails visibly; indexes are never silently
dropped or rewritten.

## Approved Apply Run

Only after validation passes and findings are approved:

```powershell
$env:BATCH3_FINANCIAL_MIGRATION_CONFIRM='batch3-financial-integrity'
node scripts/migrate_batch3_financial_integrity.js --apply
```

Apply mode:

- creates any missing required baseline and Batch 3 indexes,
- verifies every required index specification,
- initializes the global share-issuance serialization lock,
- moves incompatible intermediate settlements to `reconciliation_required`,
- moves malformed pending investment withdrawals and share exits to
  `manual_review`,
- reruns the complete inspection,
- verifies that quarantine candidates are gone,
- verifies the final index set and global share lock before reporting success.

The operations are safe to rerun when existing index definitions match exactly.
A partial prior run can be rerun after its reported blocker is resolved. Do not
restore quarantined records to `pending` without authoritative reconciliation.

## Post-Apply Verification

Keep all writers and webhook ingress stopped until all steps pass:

1. Review the migration's `verified: true` result and created-index list.
2. Independently inspect both collections and verify the complete index set
   above, including uniqueness and partial-filter definitions.
3. Verify `_id: "global"` exists in `shareissuancelocks` with a non-negative
   safe-integer `revision`.
4. Run validation-only mode again and confirm there are no blockers or active
   quarantine candidates.
5. Perform the mandatory staging tests below.
6. Restore webhook ingress and application/worker instances only after approval.

## Mandatory Staging Tests

This repository has no existing real MongoDB replica-set test facility. The
unit suites simulate sessions and write conflicts and do not prove MongoDB
transaction semantics. Before production deployment, run these tests against an
isolated staging replica set with the migrated index set:

- transaction commit, rollback, and real write-conflict behavior,
- concurrent settlement attempts for one local reference,
- provider-scoped settlement unique-index enforcement across local references,
- settlement-key unique-index enforcement,
- concurrent global share issuance at the supply boundary,
- concurrent monthly share-exit quota reservations.

## Rollback

Do not automatically restore quarantined requests to `pending`. Reconcile each
record against authoritative balance, provider, and payout evidence first. If an
application rollback is approved, indexes must not be dropped until the rollback
owner confirms that doing so cannot reopen duplicate settlement paths. Additive
fields may remain in documents.

## Deferred Technical Debt

The following non-blocking cleanup is intentionally outside this migration:

- duplicated investment preflight policy,
- duplicated transaction test harnesses,
- duplicate notification test coverage,
- small EOL and whitespace noise.
