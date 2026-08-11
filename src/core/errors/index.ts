/** Base class for every error this library raises, so callers can catch broadly. */
export class ResilientTransactionalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/**
 * A propagation contract was violated — `MANDATORY` found no transaction, or
 * `NEVER` found one.
 *
 * Named to match `typeorm-transactional`'s `TransactionalError` so existing
 * `catch` blocks keep working after migration.
 */
export class TransactionalError extends ResilientTransactionalError {}

/** `initializeResilientContext()` was never called. */
export class ContextNotInitializedError extends ResilientTransactionalError {
  constructor() {
    super(
      'No transactional context found. Call initializeResilientContext() before your ' +
        'application starts — it installs the AsyncLocalStorage store and patches ' +
        'Repository.prototype so repositories resolve to the transactional manager.',
    );
  }
}

/**
 * Every attempt failed with a retryable error.
 *
 * The original failure is preserved as `.cause`, because that — not the fact that
 * we gave up — is what a reader needs to diagnose the contention.
 */
export class RetriesExhaustedError extends ResilientTransactionalError {
  constructor(
    override readonly cause: unknown,
    readonly attempts: number,
    readonly sqlstate: string | undefined,
    readonly elapsedMs: number,
    method?: string,
  ) {
    super(
      `Transaction failed after ${attempts} attempt${attempts === 1 ? '' : 's'}` +
        (method === undefined ? '' : ` in ${method}`) +
        (sqlstate === undefined ? '' : ` (SQLSTATE ${sqlstate})`) +
        `, ${elapsedMs}ms elapsed. Raise retry.maxAttempts, reduce contention, or order ` +
        'your locks — see docs/lock-ordering.md.',
      { cause },
    );
  }
}

/**
 * The wall-clock budget ran out before the retries did.
 *
 * `timeoutMs` covers *all* attempts, so a caller can bound total latency rather
 * than only the number of tries.
 */
export class TransactionTimeoutError extends ResilientTransactionalError {
  constructor(
    override readonly cause: unknown,
    readonly attempts: number,
    readonly sqlstate: string | undefined,
    readonly elapsedMs: number,
    readonly timeoutMs: number,
    method?: string,
  ) {
    super(
      `Transaction exceeded its ${timeoutMs}ms budget after ${attempts} attempt` +
        `${attempts === 1 ? '' : 's'}` +
        (method === undefined ? '' : ` in ${method}`) +
        (sqlstate === undefined ? '' : ` (SQLSTATE ${sqlstate})`) +
        `, ${elapsedMs}ms elapsed.`,
      { cause },
    );
  }
}

/**
 * Retry was configured somewhere it can never take effect.
 *
 * Only the transaction owner can retry — re-running a joined method would replay
 * half of someone else's transaction. Rather than ignore the setting, we refuse
 * it, because silently doing nothing is how people ship code they believe is
 * retrying and is not.
 *
 * @see docs/adr/0002-owner-only-retry.md
 */
export class RetryNotPermittedError extends ResilientTransactionalError {}

/** A transaction referenced a data source that was never registered. */
export class DataSourceNotRegisteredError extends ResilientTransactionalError {
  constructor(readonly dataSourceName: string) {
    super(
      `No data source registered under the name "${dataSourceName}". ` +
        'Call addResilientDataSource(dataSource) before your application starts.',
    );
  }
}
