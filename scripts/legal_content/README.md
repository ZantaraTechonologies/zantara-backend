# Zantara Legal Content — Approval Gate

The authoritative legal wording for Zantara's versioned legal documents is an
**external deliverable pending separate approval**. It is intentionally NOT
bundled with this repository.

## Pipeline status

| Document | Version | Status |
| --- | --- | --- |
| Terms of Service | v1.0 | pending approval |
| Privacy Policy | v1.0 | pending approval |
| Refund, Reversal & Complaints Policy | v1.0 | pending approval |

## How approval unlocks seeding

Once the drafted wording is reviewed and approved, place a module at:

```
scripts/legal_content/approved.js
```

whose export sets `APPROVED: true` and provides the three documents as
Markdown. Example shape:

```js
module.exports = {
    APPROVED: true,
    terms: {
        version: '1.0',
        title: 'Zantara Terms of Service',
        markdown: '# Zantara Terms of Service\n\n...',
        changeSummary: 'Initial approved version'
    },
    privacy: {
        version: '1.0',
        title: 'Zantara Privacy Policy',
        markdown: '# Zantara Privacy Policy\n\n...',
        changeSummary: 'Initial approved version'
    },
    refund_complaints: {
        version: '1.0',
        title: 'Zantara Refund, Reversal & Complaints Policy',
        markdown: '# Zantara Refund, Reversal & Complaints Policy\n\n...',
        changeSummary: 'Initial approved version'
    }
};
```

## Enforcement

- `scripts/seed_legal_documents.js` exits non-zero **with zero writes** while
  `APPROVED_CONTENT` is absent or `APPROVED !== true`.
- The seed never publishes placeholder or static web copy. The React pages under
  `vtu-web/src/pages/system/` are UI-only and are not an authoritative source.
- Publishing additionally requires a real **active superAdmin** account, or a
  valid `BOOTSTRAP_ACTOR_ID` pointing to one; otherwise the seed fails with zero
  writes.
- Re-running is idempotent: types that already have a published document are
  skipped.