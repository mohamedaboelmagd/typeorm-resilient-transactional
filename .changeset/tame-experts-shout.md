---
'typeorm-resilient-transactional': patch
---

Stop an async observability callback from taking the process down, and stop a `NaN` cap from disabling backoff.

**Async observability callbacks could crash the process.** `onRetry`, `onExhausted`, and `runOnRetry` are declared `(info) => void`, but TypeScript accepts an `async` function wherever a void-returning one is expected — so `onRetry: async (info) => metrics.push(info)` compiles under `--strict` with no complaint. The `try`/`catch` guarding each call never saw the rejection, which became an unhandled rejection and terminated the process on Node 15+ — mid-retry, with a transaction open. A flaky metrics backend could take down the service it was measuring.

Rejections from these callbacks are now caught and reported through the diagnostic handler. They are still deliberately not awaited: they fire between retry attempts, and retry latency must not depend on how fast your telemetry pipeline is. Commit, rollback, and complete hooks were never affected — those were already awaited.

If you run type-aware ESLint, `@typescript-eslint/no-misused-promises` already flagged this at your call site. `tsc` alone did not.

**`capMs: NaN` silently removed all backoff.** `NaN` survived every clamp in `computeBackoff`, and `setTimeout(NaN)` fires immediately. Since nothing validated the value and `Number(process.env.RETRY_CAP_MS)` is `NaN` whenever that variable is unset or misspelled, a deployment typo could remove the jitter that keeps two conflicting transactions from waking together and colliding again — visible only as unexplained contention. `capMs` and `baseMs` that are `NaN`, infinite, or negative now fall back to their defaults.

**New guidance on sizing `maxAttempts`.** [`docs/safety.md`](https://github.com/mohamedaboelmagd/typeorm-resilient-transactional/blob/master/docs/safety.md#6-retries-are-not-free) now records how many attempts a conflict actually needs. Measured against PostgreSQL 17: on an idle host every retry succeeded on the second attempt, while under CPU saturation a third was needed in 1–4% of rounds — same database, same query, same conflict. The chain length tracks how busy the host is, because the loser re-reads the same rows while the winner's `COMMIT` is still in flight. Size `maxAttempts` for the loaded case and bound tail latency with `timeoutMs`.
