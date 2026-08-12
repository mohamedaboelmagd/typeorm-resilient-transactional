# typeorm-resilient-transactional

## 0.1.2

### Patch Changes

- df4dd69: Stop a failing diagnostic handler from breaking the caller.
  
  `setDiagnosticHandler()` takes a `(event) => void`, and the docs point you at a NestJS `Logger` or pino — so `setDiagnosticHandler(async (event) => log.send(event))` is an easy thing to write, and TypeScript accepts it. The handler was called bare: one that threw surfaced from whatever library code happened to be warning at the time, including from inside a `catch` that was already handling a different failure, and one that rejected became an unhandled rejection, which terminates the process on Node 15+.
  
  That made the channel used to report every other failure the one most able to cause one. A logging outage could take down the service.
  
  The handler's throw or rejection is now absorbed. Nothing is reported when it fails, deliberately: the only channel out is the handler that just failed, and calling it again would recurse. Diagnostics keep working afterwards — a failure does not disable the handler.
  
  This is the same defect as the `onRetry` / `onExhausted` / `runOnRetry` fix in 0.1.1, found by sweeping for the pattern rather than waiting for it to be reported. `onCommit`, `onRollback`, and every `RetryMetrics` method were already covered by that fix.

## 0.1.1

### Patch Changes

- 86f721f: Stop an async observability callback from taking the process down, and stop a `NaN` cap from disabling backoff.
  
  **Async observability callbacks could crash the process.** `onRetry`, `onExhausted`, and `runOnRetry` are declared `(info) => void`, but TypeScript accepts an `async` function wherever a void-returning one is expected — so `onRetry: async (info) => metrics.push(info)` compiles under `--strict` with no complaint. The `try`/`catch` guarding each call never saw the rejection, which became an unhandled rejection and terminated the process on Node 15+ — mid-retry, with a transaction open. A flaky metrics backend could take down the service it was measuring.
  
  Rejections from these callbacks are now caught and reported through the diagnostic handler. They are still deliberately not awaited: they fire between retry attempts, and retry latency must not depend on how fast your telemetry pipeline is. Commit, rollback, and complete hooks were never affected — those were already awaited.
  
  If you run type-aware ESLint, `@typescript-eslint/no-misused-promises` already flagged this at your call site. `tsc` alone did not.
  
  **`capMs: NaN` silently removed all backoff.** `NaN` survived every clamp in `computeBackoff`, and `setTimeout(NaN)` fires immediately. Since nothing validated the value and `Number(process.env.RETRY_CAP_MS)` is `NaN` whenever that variable is unset or misspelled, a deployment typo could remove the jitter that keeps two conflicting transactions from waking together and colliding again — visible only as unexplained contention. `capMs` and `baseMs` that are `NaN`, infinite, or negative now fall back to their defaults.
  
  **New guidance on sizing `maxAttempts`.** [`docs/safety.md`](https://github.com/mohamedaboelmagd/typeorm-resilient-transactional/blob/master/docs/safety.md#6-retries-are-not-free) now records how many attempts a conflict actually needs. Measured against PostgreSQL 17: on an idle host every retry succeeded on the second attempt, while under CPU saturation a third was needed in 1–4% of rounds — same database, same query, same conflict. The chain length tracks how busy the host is, because the loser re-reads the same rows while the winner's `COMMIT` is still in flight. Size `maxAttempts` for the loaded case and bound tail latency with `timeoutMs`.

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
