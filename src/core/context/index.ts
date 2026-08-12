import type { EntityManager, QueryRunner } from 'typeorm';

import type { IsolationLevel } from '../enums.js';
import {
  DEFAULT_DATA_SOURCE_NAME,
  getTransactionState,
  hasAnyTransactionState,
  type TransactionState,
} from './store.js';

export {
  DEFAULT_DATA_SOURCE_NAME,
  getEntityManagerInContext,
  getTransactionState,
  hasAnyTransactionState,
  runWithTransactionState,
  type TransactionState,
} from './store.js';

/** What `getTransactionContext()` hands back. Read-only by design. */
export interface TransactionContext {
  readonly manager: EntityManager;
  /** Advanced use — lock helpers need it to issue `SET LOCAL`. */
  readonly queryRunner: QueryRunner;
  readonly dataSourceName: string;
  readonly isolation: IsolationLevel | undefined;
  /** 1-based attempt counter. */
  readonly attempt: number;
  /** 0 for the transaction owner; each `NESTED` savepoint adds one. */
  readonly depth: number;
  readonly startedAt: number;
  /** Only the owner may commit, roll back, or retry. */
  readonly isOwner: boolean;
}

function toContext(state: TransactionState): TransactionContext {
  return {
    manager: state.manager,
    queryRunner: state.queryRunner,
    dataSourceName: state.dataSourceName,
    isolation: state.isolation,
    attempt: state.attempt,
    depth: state.depth,
    startedAt: state.startedAt,
    isOwner: state.isOwner,
  };
}

/**
 * The active transaction for `dataSourceName`, or `undefined` outside one.
 */
export function getTransactionContext(
  dataSourceName: string = DEFAULT_DATA_SOURCE_NAME,
): TransactionContext | undefined {
  const state = getTransactionState(dataSourceName);
  return state === undefined ? undefined : toContext(state);
}

/**
 * Whether a transaction is active.
 *
 * With no argument this reports whether *any* data source is in a transaction,
 * which is what callers almost always mean. Pass a name to ask about one
 * specific data source.
 */
export function isInTransaction(dataSourceName?: string): boolean {
  return dataSourceName === undefined
    ? hasAnyTransactionState()
    : getTransactionState(dataSourceName) !== undefined;
}

/**
 * The 1-based attempt number of the current transaction, or 0 outside one.
 *
 * Always 1 until the retry engine lands in Phase 3.
 */
export function currentAttempt(dataSourceName: string = DEFAULT_DATA_SOURCE_NAME): number {
  return getTransactionState(dataSourceName)?.attempt ?? 0;
}
