import type { EntityManager } from 'typeorm';

import { ResilientTransactionalError } from '../errors/index.js';

/**
 * `SET LOCAL` is only meaningful inside a transaction — outside one PostgreSQL
 * warns and does nothing, which would silently leave the caller unprotected.
 */
function assertInTransaction(manager: EntityManager, fn: string): void {
  if (manager.queryRunner?.isTransactionActive === true) return;

  throw new ResilientTransactionalError(
    `${fn}() must run inside a transaction. SET LOCAL has no effect outside one, so the ` +
      'timeout would be silently ignored.',
  );
}

/**
 * Milliseconds are interpolated, not bound, because PostgreSQL does not accept a
 * parameter in `SET`. Validating hard is therefore the only thing standing
 * between a caller's variable and the statement text.
 */
function toMilliseconds(value: number, fn: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ResilientTransactionalError(
      `${fn}() expects a non-negative integer number of milliseconds, received ${String(value)}.`,
    );
  }
  return value;
}

async function withLocalSetting<T>(
  manager: EntityManager,
  setting: 'lock_timeout' | 'statement_timeout',
  ms: number,
  fn: () => Promise<T>,
  caller: string,
): Promise<T> {
  assertInTransaction(manager, caller);
  const value = toMilliseconds(ms, caller);

  const rows = await manager.query<Record<string, string>[]>(`SHOW ${setting}`);
  const previous = Object.values(rows[0] ?? {})[0] ?? '0';

  await manager.query(`SET LOCAL ${setting} = ${value}`);

  try {
    return await fn();
  } finally {
    // `SET LOCAL` would revert on its own at commit, but the transaction usually
    // continues past this call and must not inherit the narrower timeout.
    //
    // Best-effort on purpose. The common failure here is the timeout firing,
    // which aborts the transaction and makes every subsequent statement fail with
    // 25P02 — including this one. Letting that propagate would replace the
    // caller's 55P03 or 57014 with a meaningless "transaction is aborted", hiding
    // the very error the timeout existed to produce. Nothing is leaked either
    // way: the setting dies with the transaction.
    try {
      await manager.query(`SET LOCAL ${setting} = '${previous}'`);
    } catch {
      /* the transaction is already aborted; there is nothing left to restore */
    }
  }
}

/**
 * Runs `fn` with a bounded wait for row locks.
 *
 * A statement that waits longer than `ms` for a lock fails with SQLSTATE `55P03`
 * (`lock_not_available`), which is retryable by default. This turns an unbounded
 * stall into a fast, recoverable failure — useful when you would rather retry
 * than hold a connection hostage behind someone else's long transaction.
 *
 * Only affects waiting for locks, not query execution time.
 */
export function withLockTimeout<T>(
  manager: EntityManager,
  ms: number,
  fn: () => Promise<T>,
): Promise<T> {
  return withLocalSetting(manager, 'lock_timeout', ms, fn, 'withLockTimeout');
}

/**
 * Runs `fn` with a bounded total execution time per statement.
 *
 * Exceeding it raises SQLSTATE `57014` (`query_canceled`), which is **not**
 * retried by default — a query that already exhausted its time budget will
 * usually exhaust it again, and retrying amplifies the load that caused it.
 *
 * @see docs/safety.md §5
 */
export function withStatementTimeout<T>(
  manager: EntityManager,
  ms: number,
  fn: () => Promise<T>,
): Promise<T> {
  return withLocalSetting(manager, 'statement_timeout', ms, fn, 'withStatementTimeout');
}
