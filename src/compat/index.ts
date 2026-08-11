/**
 * `typeorm-transactional` compatibility surface.
 *
 * Everything here is also re-exported from the package root, so migrating is a
 * one-line import change. This entry point exists for callers who want the
 * boundary to be explicit.
 *
 * Two exports from `typeorm-transactional` are deliberately absent:
 *
 *   `StorageDriver`            — we only ever use AsyncLocalStorage, so there is
 *                                nothing to select between.
 *   `getTransactionalContext()` — returned the internal cls-hooked/ALS driver.
 *                                Use `getTransactionContext()` or
 *                                `isInTransaction()` instead, which expose the
 *                                transaction rather than the storage mechanism.
 *
 * @see MIGRATION.md
 */

import { addResilientDataSource, initializeResilientContext } from '../core/datasource/registry.js';
import {
  runInResilientTransaction,
  type TransactionCallback,
  type TransactionOptions,
} from '../core/runner/run-in-transaction.js';
import { wrapInResilientTransaction } from '../core/runner/wrap-in-transaction.js';

/** @see initializeResilientContext */
export const initializeTransactionalContext = initializeResilientContext;

/** @see addResilientDataSource */
export const addTransactionalDataSource = addResilientDataSource;

/**
 * @see runInResilientTransaction
 *
 * `typeorm-transactional`'s callback takes no arguments and relies on the context
 * to route repositories. Ours also passes the `EntityManager`, which a zero-arg
 * callback simply ignores — so existing call sites compile and behave unchanged.
 */
export const runInTransaction: <T>(
  fn: TransactionCallback<T>,
  options?: TransactionOptions,
) => Promise<T> = runInResilientTransaction;

/** @see wrapInResilientTransaction */
export const wrapInTransaction = wrapInResilientTransaction;

export { Transactional } from '../core/decorator.js';
export { IsolationLevel, Propagation } from '../core/enums.js';
export { TransactionalError } from '../core/errors/index.js';
export { deleteDataSourceByName, getDataSourceByName } from '../core/datasource/registry.js';

export type { TransactionOptions as WrapInTransactionOptions } from '../core/runner/run-in-transaction.js';
