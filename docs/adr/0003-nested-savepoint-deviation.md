# 3. NESTED means savepoints, deviating from typeorm-transactional

- **Status:** accepted
- **Date:** 2026-08-11

## Context

API compatibility with `typeorm-transactional` is this library's main adoption lever, so
deviations need justifying.

Its `Propagation.NESTED` routes to the same helper as `REQUIRES_NEW`:

```ts
case Propagation.NESTED:
  return runWithNewTransaction(); // → dataSource.transaction(...) → a brand-new QueryRunner
```

A fresh `QueryRunner` means a fresh pooled connection, so the inner work commits independently and
survives an outer rollback. That is `REQUIRES_NEW` behaviour under a `NESTED` name. In Spring,
whose vocabulary these modes come from, `NESTED` means a savepoint.

Meanwhile TypeORM's `QueryRunner` already implements savepoints: `startTransaction()` at
`transactionDepth > 0` emits `SAVEPOINT typeorm_N`, `commitTransaction()` emits
`RELEASE SAVEPOINT`, and `rollbackTransaction()` emits `ROLLBACK TO SAVEPOINT`.

## Decision

Implement `NESTED` as a real savepoint by reusing the query runner already in the context.

Assert the divergence in `test/compat/` **in both directions** — one suite pins
`typeorm-transactional`'s actual behaviour, the other pins ours — so neither can drift silently.

When the retry engine lands, savepoint-level retry is **disabled by default**.

## Consequences

`NESTED` now behaves as Spring and PostgreSQL define it: the savepoint is part of the enclosing
transaction, so an outer rollback discards it, and an inner failure rolls back only to the
savepoint while leaving the outer transaction usable.

Correct nesting costs no SQL of our own — only routing to the existing query runner instead of
allocating a new one.

**This is a behavioural change for anyone migrating who uses `NESTED`.** Code relying on inner work
surviving an outer rollback must switch to `REQUIRES_NEW`, which is what it was getting anyway.
`MIGRATION.md` calls this out as the only non-mechanical step. Every other `NESTED` scenario we
tested produces identical output under both implementations, which is precisely why the difference
goes unnoticed today.

Savepoint-level retry stays off because PostgreSQL aborts the **entire** transaction on `40001` and
`40P01`. After either, `ROLLBACK TO SAVEPOINT` is itself rejected — so retrying to a savepoint
cannot recover from the two errors you would most want to retry. Enabling it would be a lie
dressed as a feature.
