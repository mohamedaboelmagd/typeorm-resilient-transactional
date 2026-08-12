# typeorm-resilient-transactional

## 0.1.0

### Minor Changes

- 3d897b7: Initial release.
  
  `@Transactional()` for NestJS + TypeORM with automatic retry of transient database failures, so
  `SERIALIZABLE` is usable in production.
  
  - **Retry engine** — SQLSTATE classification (`40001`, `40P01`, `55P03` by default), exponential
    backoff with full jitter, a wall-clock budget across all attempts, and owner-only retry that
    throws rather than silently no-opping where it cannot work.
  - **Context propagation** via `AsyncLocalStorage` with **zero runtime dependencies**. Repositories
    resolve to the transactional manager unchanged.
  - **All seven propagation modes.** `NESTED` uses real savepoints.
  - **Lifecycle hooks** — `runOnCommit` and friends, per-attempt, so a failed attempt's side effects
    are discarded rather than replayed.
  - **Lock ordering** — `lockRowsInOrder()`, `withLockTimeout()`, `withStatementTimeout()`.
  - **Observability** — retry callbacks, a dependency-free `RetryMetrics` interface, optional
    OpenTelemetry span attributes, and NestJS `Logger` routing.
  - **Drop-in for `typeorm-transactional`** — one import line, with parity asserted in CI against the
    real package.
  
  Supports `typeorm@^0.3.31 || ^1` and Node ≥ 20. PostgreSQL is the tested dialect.
