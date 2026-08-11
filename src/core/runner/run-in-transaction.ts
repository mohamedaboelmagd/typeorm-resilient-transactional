import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

import {
  DEFAULT_DATA_SOURCE_NAME,
  getTransactionState,
  runWithTransactionState,
  type TransactionState,
} from '../context/store.js';
import { getDataSourceByName, isContextInitialized } from '../datasource/registry.js';
import { warn } from '../diagnostics.js';
import {
  ContextNotInitializedError,
  RetryNotPermittedError,
  TransactionalError,
} from '../errors/index.js';
import { IsolationLevel, Propagation } from '../enums.js';
import { resolveRetry, runWithRetry, type RetryConfig, type RetryInfo } from '../retry/engine.js';

export interface TransactionOptions {
  /** Defaults to `REQUIRED`. */
  propagation?: Propagation;
  /** Omit to use the connection's default. Ignored by `NESTED` — savepoints inherit. */
  isolation?: IsolationLevel;
  /**
   * `typeorm-transactional` spelling of `isolation`. Accepted so migrating is a
   * one-line import change; `isolation` wins if both are given.
   */
  isolationLevel?: IsolationLevel;
  /** Which registered data source to use. Defaults to `'default'`. */
  dataSourceName?: string;
  /** `typeorm-transactional` spelling of `dataSourceName`. */
  connectionName?: string;
  /** Method or operation name, used in diagnostics. */
  name?: string;
  /**
   * Retry policy. Omit or pass `false` to disable.
   *
   * Only valid where this call *owns* the transaction — see
   * {@link RetryNotPermittedError}.
   */
  retry?: RetryConfig | false;
  /** Wall-clock budget across every attempt, not per attempt. */
  timeoutMs?: number;
  onRetry?: (info: RetryInfo) => void;
  onExhausted?: (info: RetryInfo) => void;
}

export type TransactionCallback<T> = (manager: EntityManager) => Promise<T> | T;

function resolveDataSourceName(options: TransactionOptions | undefined): string {
  return options?.dataSourceName ?? options?.connectionName ?? DEFAULT_DATA_SOURCE_NAME;
}

/**
 * Rolls back without ever masking the error that caused the rollback.
 *
 * A failing `ROLLBACK` is real but secondary information: the original error is
 * what the caller needs to see. This is also the expected path after a
 * serialization failure, where the transaction is already aborted and even
 * `ROLLBACK TO SAVEPOINT` is rejected.
 */
async function safeRollback(queryRunner: QueryRunner): Promise<void> {
  try {
    if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
  } catch (rollbackError) {
    warn(
      'rollback-failed',
      `Rollback failed and was suppressed so it could not mask the original error: ${String(
        rollbackError,
      )}`,
    );
  }
}

/** Releases without masking either the result or a pending error. */
async function safeRelease(queryRunner: QueryRunner): Promise<void> {
  try {
    await queryRunner.release();
  } catch (releaseError) {
    warn('release-failed', `Failed to release query runner: ${String(releaseError)}`);
  }
}

/**
 * Opens a transaction on a fresh query runner and owns its lifecycle.
 *
 * The query runner is released on every path — success, failure, and rollback
 * failure — because leaking one silently exhausts the pool.
 */
async function runAsOwner<T>(
  dataSource: DataSource,
  dataSourceName: string,
  isolation: IsolationLevel | undefined,
  fn: TransactionCallback<T>,
  attempt: number,
): Promise<T> {
  const queryRunner = dataSource.createQueryRunner();

  try {
    await queryRunner.connect();
    await queryRunner.startTransaction(isolation);

    const state: TransactionState = {
      manager: queryRunner.manager,
      queryRunner,
      dataSourceName,
      isolation,
      attempt,
      depth: 0,
      startedAt: Date.now(),
      isOwner: true,
    };

    try {
      const result = await runWithTransactionState(dataSourceName, state, () =>
        fn(queryRunner.manager),
      );

      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await safeRollback(queryRunner);
      throw error;
    }
  } finally {
    await safeRelease(queryRunner);
  }
}

/**
 * Runs inside a savepoint of the surrounding transaction.
 *
 * TypeORM's `QueryRunner` tracks `transactionDepth` and turns `startTransaction()`
 * at depth > 0 into `SAVEPOINT`, `commitTransaction()` into `RELEASE SAVEPOINT`,
 * and `rollbackTransaction()` into `ROLLBACK TO SAVEPOINT` — so this needs no SQL
 * of its own. It must reuse the *existing* query runner; allocating a new one is
 * what makes `typeorm-transactional`'s NESTED behave as REQUIRES_NEW instead.
 *
 * The query runner is not released here: this scope does not own it.
 *
 * @see docs/prior-art.md §4.2
 * @see docs/adr/0003-nested-savepoint-deviation.md
 */
async function runInSavepoint<T>(
  parent: TransactionState,
  isolation: IsolationLevel | undefined,
  fn: TransactionCallback<T>,
): Promise<T> {
  if (isolation !== undefined && isolation !== parent.isolation) {
    warn(
      'nested-isolation-ignored',
      `Ignoring isolation "${isolation}" on a NESTED transaction: PostgreSQL cannot change ` +
        `isolation after a transaction has started, so the savepoint inherits ` +
        `"${parent.isolation ?? 'the connection default'}".`,
    );
  }

  const { queryRunner } = parent;

  await queryRunner.startTransaction();

  const state: TransactionState = {
    ...parent,
    depth: parent.depth + 1,
    isOwner: false,
  };

  try {
    const result = await runWithTransactionState(parent.dataSourceName, state, () =>
      fn(queryRunner.manager),
    );

    await queryRunner.commitTransaction();
    return result;
  } catch (error) {
    await safeRollback(queryRunner);
    throw error;
  }
}

/** Joins the surrounding transaction without starting anything. */
function runJoined<T>(parent: TransactionState, fn: TransactionCallback<T>): Promise<T> {
  const state: TransactionState = { ...parent, isOwner: false };

  return Promise.resolve(
    runWithTransactionState(parent.dataSourceName, state, () => fn(parent.manager)),
  );
}

/**
 * Runs with no transaction, suspending any that is active for this data source.
 *
 * The manager is resolved *inside* the suspended scope so the patched
 * `dataSource.manager` getter returns the real manager rather than the
 * transactional one.
 */
function runSuspended<T>(
  dataSource: DataSource,
  dataSourceName: string,
  fn: TransactionCallback<T>,
): Promise<T> {
  return Promise.resolve(
    runWithTransactionState(dataSourceName, undefined, () => fn(dataSource.manager)),
  );
}

/**
 * Runs an owned transaction, retrying transient failures when configured.
 *
 * Retry lives here rather than inside `runAsOwner` because each attempt needs a
 * brand-new query runner and a fresh `START TRANSACTION`.
 */
function runOwned<T>(
  dataSource: DataSource,
  dataSourceName: string,
  isolation: IsolationLevel | undefined,
  fn: TransactionCallback<T>,
  options: TransactionOptions | undefined,
): Promise<T> {
  const retry = resolveRetry(options?.retry);

  if (retry === undefined) {
    return runAsOwner(dataSource, dataSourceName, isolation, fn, 1);
  }

  return runWithRetry((attempt) => runAsOwner(dataSource, dataSourceName, isolation, fn, attempt), {
    ...retry,
    timeoutMs: options?.timeoutMs,
    onRetry: options?.onRetry,
    onExhausted: options?.onExhausted,
    method: options?.name,
    dataSourceName,
  });
}

/**
 * Rejects retry configured somewhere it could never take effect.
 *
 * Re-running a *joined* method would replay part of a transaction someone else
 * owns; retrying to a savepoint cannot recover from `40001` or `40P01`, which
 * abort the whole transaction in PostgreSQL. Both cases are silent no-ops in a
 * naive implementation — and code that looks like it retries but does not is
 * worse than code that plainly does not.
 *
 * This fires on the first call rather than at import time, because whether a
 * method joins or owns is only knowable once it runs.
 *
 * @see docs/adr/0002-owner-only-retry.md
 */
function assertRetryPermitted(
  options: TransactionOptions | undefined,
  propagation: Propagation,
  joining: boolean,
): void {
  if (!joining) return;
  if (resolveRetry(options?.retry) === undefined) return;

  const where = options?.name === undefined ? 'This method' : `"${options.name}"`;

  throw new RetryNotPermittedError(
    `${where} configures retry but does not own its transaction (propagation ` +
      `${propagation}). Only the transaction owner can retry — move the retry ` +
      'configuration to the outermost @Transactional(), or use REQUIRES_NEW so this ' +
      'method owns a transaction of its own.',
  );
}

/**
 * Runs `fn` in a transaction, honouring `propagation`.
 *
 * The programmatic entry point. `@Transactional()` is a thin wrapper over it.
 */
export async function runInResilientTransaction<T>(
  fn: TransactionCallback<T>,
  options?: TransactionOptions,
): Promise<T> {
  if (!isContextInitialized()) throw new ContextNotInitializedError();

  const dataSourceName = resolveDataSourceName(options);
  const propagation = options?.propagation ?? Propagation.REQUIRED;
  const isolation = options?.isolation ?? options?.isolationLevel;

  const dataSource = getDataSourceByName(dataSourceName);
  const existing = getTransactionState(dataSourceName);

  // Owning means opening a transaction of our own; everything else either joins
  // one or runs without any, and neither can be retried.
  const owns =
    propagation === Propagation.REQUIRES_NEW ||
    ((propagation === Propagation.REQUIRED || propagation === Propagation.NESTED) &&
      existing === undefined);

  assertRetryPermitted(options, propagation, !owns);

  switch (propagation) {
    case Propagation.REQUIRED:
      return existing === undefined
        ? runOwned(dataSource, dataSourceName, isolation, fn, options)
        : runJoined(existing, fn);

    case Propagation.REQUIRES_NEW:
      return runOwned(dataSource, dataSourceName, isolation, fn, options);

    case Propagation.NESTED:
      return existing === undefined
        ? runOwned(dataSource, dataSourceName, isolation, fn, options)
        : runInSavepoint(existing, isolation, fn);

    case Propagation.SUPPORTS:
      return existing === undefined
        ? runSuspended(dataSource, dataSourceName, fn)
        : runJoined(existing, fn);

    case Propagation.NOT_SUPPORTED:
      return runSuspended(dataSource, dataSourceName, fn);

    case Propagation.MANDATORY:
      if (existing === undefined) {
        throw new TransactionalError(
          `No existing transaction found for a method marked with propagation 'MANDATORY'` +
            (options?.name === undefined ? '' : ` (${options.name})`),
        );
      }
      return runJoined(existing, fn);

    case Propagation.NEVER:
      if (existing !== undefined) {
        throw new TransactionalError(
          `Found an existing transaction for a method marked with propagation 'NEVER'` +
            (options?.name === undefined ? '' : ` (${options.name})`),
        );
      }
      return runSuspended(dataSource, dataSourceName, fn);
  }
}
