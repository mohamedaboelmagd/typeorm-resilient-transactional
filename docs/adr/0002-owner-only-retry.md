# 2. Only the transaction owner may retry

- **Status:** accepted
- **Date:** 2026-08-11

## Context

Retry re-runs the entire method body in a brand-new transaction. That is only
coherent if the method _owns_ the transaction.

Consider a `REQUIRED` method that joins a transaction its caller opened:

```ts
@Transactional({ retry: { maxAttempts: 5 } }) // ← cannot work
async debit(accountId: string, amount: number) { ... }
```

If `debit` were retried in place it would replay part of a transaction it does not control,
against a query runner whose transaction was aborted by the very error being retried. There is
nothing sensible to do here.

The naive implementations do nothing: the retry setting is silently ignored. **Code that looks
like it retries and does not is worse than code that plainly does not** — it is invisible until
production contention, and the symptom (occasional `40001` reaching the caller) points nowhere
near the cause.

Savepoints do not rescue this either. PostgreSQL aborts the **entire** transaction on `40001` and
`40P01`; after either, even `ROLLBACK TO SAVEPOINT` is rejected. So `NESTED` cannot retry the two
errors you would most want to retry.

## Decision

Retry is permitted only where the call opens a transaction of its own:

| Propagation                                          | Owns? | Retry      |
| ---------------------------------------------------- | ----- | ---------- |
| `REQUIRED`, no active transaction                    | yes   | permitted  |
| `REQUIRED`, joining                                  | no    | **throws** |
| `REQUIRES_NEW`                                       | yes   | permitted  |
| `NESTED`, no active transaction                      | yes   | permitted  |
| `NESTED`, savepoint                                  | no    | **throws** |
| `SUPPORTS` / `NOT_SUPPORTED` / `MANDATORY` / `NEVER` | no    | **throws** |

Configuring retry anywhere else throws `RetryNotPermittedError`, naming the method and stating the
fix.

Only an **explicit** retry option throws. A method nested inside a retrying caller is ordinary
composition and must keep working.

## Consequences

The failure is loud and immediate rather than silent and eventual.

It fires on the **first call**, not at import time, despite the build spec asking for
"bootstrap-time" validation. Whether a `REQUIRED` method joins or owns is a property of the call
graph at runtime — `debit()` may own a transaction when called from a controller and join one when
called from a service. There is no bootstrap-time fact to check. First-call is the earliest moment
the question has an answer.

The practical consequence for users is that retry configuration belongs on the **outermost**
`@Transactional()` — the one that opens the transaction — which is also where a wall-clock
`timeoutMs` is meaningful. A method that genuinely needs to retry independently should declare
`REQUIRES_NEW` and accept that it commits separately.
