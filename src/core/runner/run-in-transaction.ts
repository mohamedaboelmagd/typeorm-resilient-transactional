import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

import {
  DEFAULT_DATA_SOURCE_NAME,
  getTransactionState,
  runWithTransactionState,
  type TransactionState,
} from '../context/store.js';
import { getDataSourceByName, isContextInitialized } from '../datasource/registry.js';
import { warn } from '../diagnostics.js';
import { ContextNotInitializedError, TransactionalError } from '../errors/index.js';
import { IsolationLevel, Propagation } from '../enums.js';

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
      attempt: 1,
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

  switch (propagation) {
    case Propagation.REQUIRED:
      return existing === undefined
        ? runAsOwner(dataSource, dataSourceName, isolation, fn)
        : runJoined(existing, fn);

    case Propagation.REQUIRES_NEW:
      return runAsOwner(dataSource, dataSourceName, isolation, fn);

    case Propagation.NESTED:
      return existing === undefined
        ? runAsOwner(dataSource, dataSourceName, isolation, fn)
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
