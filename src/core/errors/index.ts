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

/** A transaction referenced a data source that was never registered. */
export class DataSourceNotRegisteredError extends ResilientTransactionalError {
  constructor(readonly dataSourceName: string) {
    super(
      `No data source registered under the name "${dataSourceName}". ` +
        'Call addResilientDataSource(dataSource) before your application starts.',
    );
  }
}
