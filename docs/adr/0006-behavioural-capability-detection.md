# 6. Degrade with a warning instead of throwing on TypeORM changes

- **Status:** accepted
- **Date:** 2026-08-11

## Context

Patching TypeORM's accessors means depending on shapes TypeORM never promised to keep.
`typeorm-transactional` handles this by asserting arity and throwing:

```ts
const originalQuery = DataSource.prototype.query;
if (originalQuery.length !== 3) throw new TypeOrmUpdatedPatchError();
```

`Function.length` counts parameters before the first default or rest parameter. TypeORM's
`query(query, parameters?, useStructuredResult = false)` happens to be 3 today. Adding one
defaulted parameter upstream — an ordinary, non-breaking change by semver rules — would take this
to a **hard throw at import time for every consumer**, on the day they upgrade TypeORM, with a
stack trace pointing at a library they did not change.

## Decision

Check the same shapes. On mismatch, **skip that individual patch and warn**, naming the method.
Never throw at import time because TypeORM changed.

Route warnings through a replaceable handler (`setDiagnosticHandler`), defaulting to
`console.warn`, and emit each code at most once.

## Consequences

The worst case becomes localized and loud rather than fatal: raw `dataSource.query()` stops joining
the transactional context and says so. Repositories are unaffected — they go through the
`Repository.prototype` accessor, which does not depend on arity at all.

A degraded patch is a genuine correctness hazard, not a cosmetic one: unpatched
`dataSource.query()` runs on a pooled connection outside the transaction, so its writes are not
rolled back. The warning text has to say that plainly, and users who treat warnings as errors
should be able to escalate it — which the handler seam allows.

We accept that a silent-but-warned degradation could be missed in a noisy log. The alternative —
taking production down on a patch-level TypeORM bump — is worse, and the CI matrix against both
supported TypeORM lines is what should catch the drift first.
