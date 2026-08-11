/**
 * typeorm-resilient-transactional
 *
 * `@Transactional()` for NestJS + TypeORM that survives deadlocks and
 * serialization failures.
 *
 * Phases 3–5 add the retry engine, lifecycle hooks, and lock-ordering helpers.
 */

// ── bootstrap ────────────────────────────────────────────────────────────────
export {
  addResilientDataSource,
  clearResilientDataSources,
  deleteDataSourceByName,
  getDataSourceByName,
  hasDataSource,
  initializeResilientContext,
  isContextInitialized,
  type AddResilientDataSourceInput,
} from './core/datasource/registry.js';

// ── running transactions ─────────────────────────────────────────────────────
export { Transactional } from './core/decorator.js';
export {
  runInResilientTransaction,
  type TransactionCallback,
  type TransactionOptions,
} from './core/runner/run-in-transaction.js';
export { wrapInResilientTransaction } from './core/runner/wrap-in-transaction.js';

// ── introspection ────────────────────────────────────────────────────────────
export {
  currentAttempt,
  getTransactionContext,
  isInTransaction,
  type TransactionContext,
} from './core/context/index.js';

// ── retry ────────────────────────────────────────────────────────────────────
export {
  DEFAULT_MAX_ATTEMPTS,
  resolveRetry,
  runWithRetry,
  type ResolvedRetry,
  type RetryConfig,
  type RetryInfo,
} from './core/retry/engine.js';
export {
  DEFAULT_BACKOFF,
  computeBackoff,
  type BackoffConfig,
  type BackoffStrategy,
} from './core/retry/backoff.js';
export { extractSqlState, isRetryable, isUnsafeToRetry } from './core/retry/classifier.js';

// ── configuration ────────────────────────────────────────────────────────────
export { IsolationLevel, Propagation } from './core/enums.js';

export {
  DEADLOCK_DETECTED,
  DEFAULT_RETRYABLE_SQLSTATES,
  LOCK_NOT_AVAILABLE,
  QUERY_CANCELED,
  SERIALIZATION_FAILURE,
  UNSAFE_TO_RETRY_SQLSTATES,
} from './core/dialects/postgres.js';

// ── errors ───────────────────────────────────────────────────────────────────
export {
  ContextNotInitializedError,
  DataSourceNotRegisteredError,
  ResilientTransactionalError,
  RetriesExhaustedError,
  RetryNotPermittedError,
  TransactionTimeoutError,
  TransactionalError,
} from './core/errors/index.js';

// ── diagnostics ──────────────────────────────────────────────────────────────
export {
  setDiagnosticHandler,
  type DiagnosticEvent,
  type DiagnosticHandler,
  type DiagnosticLevel,
} from './core/diagnostics.js';

// ── typeorm-transactional compatibility ──────────────────────────────────────
// Also available from the `/compat` subpath. Exported here so migrating is a
// one-line import change. @see MIGRATION.md
export {
  addTransactionalDataSource,
  initializeTransactionalContext,
  runInTransaction,
  wrapInTransaction,
} from './compat/index.js';
