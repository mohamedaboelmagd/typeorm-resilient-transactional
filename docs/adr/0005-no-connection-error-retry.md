# 5. Never retry connection errors by default

- **Status:** accepted
- **Date:** 2026-08-11

## Context

A retry library is judged by what it refuses to retry. PostgreSQL's Class 08 codes — `08000`,
`08001`, `08003`, `08004`, `08006` — signal that the connection failed. They are transient by
nature, which makes them look like ideal retry candidates.

They are not, because of one case: **the connection dropping during `COMMIT`.**

When that happens the client has sent the commit and never received the acknowledgement. The
server may have applied it, or may not have. The client cannot distinguish these. Retrying the
transaction may therefore **apply it twice** — two debits, two payments, two journal entries.

## Decision

`DEFAULT_RETRYABLE_SQLSTATES` contains `40001`, `40P01`, and `55P03`. It contains no Class 08 code
and no `57014`.

Users may opt in per-SQLSTATE via `retryOn`, behind a documented warning.

Export `UNSAFE_TO_RETRY_SQLSTATES` so the hazardous set is nameable, and assert in the test suite
that the two lists never intersect.

## Consequences

Out of the box, a connection failure surfaces to the caller instead of being silently retried.
That is more work for the user and it is the correct default: the library cannot know whether the
operation is idempotent, and the user can.

`57014` (`query_canceled`) is also off by default for a different reason — it is usually a
`statement_timeout`, and retrying a query that already exhausted its time budget amplifies the load
that caused the timeout.

This is a **feature to advertise, not a limitation to apologise for.** The README says so in a
call-out, because "we retry everything transient" is exactly the kind of claim that makes a
library untrustworthy for the financial workloads that most need `SERIALIZABLE`.

The test asserting `DEFAULT_RETRYABLE_SQLSTATES` and `UNSAFE_TO_RETRY_SQLSTATES` are disjoint
exists to stop a future contributor widening the defaults for convenience.
