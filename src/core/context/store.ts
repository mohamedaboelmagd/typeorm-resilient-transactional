import { AsyncLocalStorage } from 'node:async_hooks';
import type { EntityManager, QueryRunner } from 'typeorm';

import type { IsolationLevel } from '../enums.js';

export const DEFAULT_DATA_SOURCE_NAME = 'default';

/**
 * The active transaction for one data source.
 *
 * Frozen on creation: a nested scope derives a new state rather than mutating the
 * one its parent can still see.
 */
export interface TransactionState {
  readonly manager: EntityManager;
  readonly queryRunner: QueryRunner;
  readonly dataSourceName: string;
  readonly isolation: IsolationLevel | undefined;
  /** 1-based. Always 1 until the retry engine lands in Phase 3. */
  readonly attempt: number;
  /** 0 for the transaction owner; each savepoint (`NESTED`) adds one. */
  readonly depth: number;
  /** `Date.now()` when the owning transaction began — not reset by savepoints. */
  readonly startedAt: number;
  /**
   * True when this scope started the transaction and is therefore allowed to
   * commit, roll back, and (from Phase 3) retry it. Joined scopes are not owners.
   */
  readonly isOwner: boolean;
}

/**
 * One entry per data source, so a method can be transactional against several
 * databases at once.
 */
type Store = ReadonlyMap<string, TransactionState>;

const storage = new AsyncLocalStorage<Store>();

const EMPTY: Store = new Map();

/**
 * Runs `fn` with `state` bound to `name`, leaving every other data source alone.
 *
 * Passing `undefined` suspends the transaction for that data source, which is how
 * `NOT_SUPPORTED` works.
 *
 * Scoping is `AsyncLocalStorage.run` and nothing else. `typeorm-transactional`
 * hand-rolls a layer stack with matching `enter()`/`exit()` calls because
 * `cls-hooked` requires it; ALS restores the parent store when `fn` settles, so
 * there is no unwind step to get wrong. See docs/internals.md.
 */
export function runWithTransactionState<T>(
  name: string,
  state: TransactionState | undefined,
  fn: () => T,
): T {
  const next = new Map(storage.getStore() ?? EMPTY);

  if (state === undefined) next.delete(name);
  else next.set(name, state);

  return storage.run(next, fn);
}

export function getTransactionState(
  name: string = DEFAULT_DATA_SOURCE_NAME,
): TransactionState | undefined {
  return storage.getStore()?.get(name);
}

/** True when any data source has an active transaction in this scope. */
export function hasAnyTransactionState(): boolean {
  const store = storage.getStore();
  return store !== undefined && store.size > 0;
}

/**
 * The transactional `EntityManager` for `name`, or `undefined` outside a
 * transaction.
 *
 * This is the hot path — every patched repository accessor calls it on every
 * property read — so it stays a single map lookup.
 */
export function getEntityManagerInContext(name: string): EntityManager | undefined {
  return storage.getStore()?.get(name)?.manager;
}
