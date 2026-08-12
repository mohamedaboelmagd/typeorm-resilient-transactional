import type { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';

import { ResilientTransactionalError } from '../errors/index.js';

export type LockMode = 'pessimistic_write' | 'pessimistic_read';

/**
 * How the lock statements are issued.
 *
 * `single-statement` — one `SELECT … WHERE id = ANY($1) ORDER BY <pk> FOR UPDATE`.
 * One round trip. Verified on PostgreSQL to acquire locks in `ORDER BY` order
 * across index-scan, bitmap-heap-scan, and sequential-scan plans.
 *
 * `row-by-row` — N statements in sorted order, one per id. N round trips, but the
 * acquisition order is decided by this process rather than by the planner, so it
 * holds for any ordering you can express in JavaScript.
 *
 * @see docs/lock-ordering.md
 */
export type LockStrategy = 'single-statement' | 'row-by-row';

export interface LockRowsInOrderOptions<Id> {
  /** Defaults to `pessimistic_write` (`FOR UPDATE`). */
  mode?: LockMode;
  /**
   * Orders the identifiers. Defaults to ascending numeric/lexicographic.
   *
   * Supplying one forces `row-by-row`, because a JavaScript comparator cannot be
   * expressed as a SQL `ORDER BY` — leaving the database free to lock in a
   * different order than the one you asked for.
   */
  comparator?: (a: Id, b: Id) => number;
  /** Overrides the automatic choice. */
  strategy?: LockStrategy;
}

/** Ascending, with numbers compared numerically rather than as strings. */
function defaultComparator<Id>(a: Id, b: Id): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * Locks rows in a deterministic global order, so concurrent callers cannot
 * deadlock over them.
 *
 * Surviving deadlocks is what retry is for; not having them is better. A deadlock
 * needs two transactions to take the same locks in opposite orders — so if every
 * transaction sorts its identifiers first, the cycle cannot form. This is the
 * application-level fix PostgreSQL's own documentation recommends.
 *
 * ```ts
 * // Both callers lock 'a' before 'b', whatever order they were handed.
 * await lockRowsInOrder(manager, Account, [toId, fromId]);
 * ```
 *
 * Must run inside a transaction — row locks are held until commit, so locking
 * outside one accomplishes nothing.
 *
 * @returns the locked entities, in the order they were locked.
 * @see docs/lock-ordering.md
 */
export async function lockRowsInOrder<Entity extends ObjectLiteral, Id>(
  manager: EntityManager,
  target: EntityTarget<Entity>,
  ids: readonly Id[],
  options: LockRowsInOrderOptions<Id> = {},
): Promise<Entity[]> {
  if (manager.queryRunner?.isTransactionActive !== true) {
    throw new ResilientTransactionalError(
      'lockRowsInOrder() must run inside a transaction. Row locks are released at commit, ' +
        'so locking outside one has no effect.',
    );
  }

  const metadata = manager.connection.getMetadata(target);
  const primaryColumns = metadata.primaryColumns;
  const primary = primaryColumns[0];

  if (primary === undefined) {
    throw new ResilientTransactionalError(
      `${metadata.name} has no primary column, so its rows cannot be locked by id.`,
    );
  }

  const mode = options.mode ?? 'pessimistic_write';
  const comparator = options.comparator ?? defaultComparator;

  // Deduplicate before sorting: locking the same row twice is harmless but makes
  // the round-trip count lie, and an accidental duplicate should not change the
  // order the remaining ids are taken in.
  const sorted = [...new Set(ids)].sort(comparator);
  if (sorted.length === 0) return [];

  // A custom comparator or a composite key cannot be expressed as the SQL
  // ORDER BY that makes the single-statement form safe, so those fall back to
  // issuing one statement per row, where *we* control the order.
  const canUseSingleStatement = options.comparator === undefined && primaryColumns.length === 1;
  const strategy: LockStrategy =
    options.strategy ?? (canUseSingleStatement ? 'single-statement' : 'row-by-row');

  if (strategy === 'single-statement' && !canUseSingleStatement) {
    throw new ResilientTransactionalError(
      "strategy 'single-statement' cannot honour a custom comparator or a composite primary " +
        "key, because neither can be expressed as a SQL ORDER BY. Use 'row-by-row'.",
    );
  }

  const alias = metadata.tableName;

  if (strategy === 'row-by-row') {
    const locked: Entity[] = [];

    for (const id of sorted) {
      const row = await manager
        .createQueryBuilder(target, alias)
        .setLock(mode)
        .whereInIds([id])
        .getOne();

      if (row !== null) locked.push(row);
    }

    return locked;
  }

  return manager
    .createQueryBuilder(target, alias)
    .setLock(mode)
    .whereInIds(sorted)
    .orderBy(`${alias}.${primary.propertyName}`, 'ASC')
    .getMany();
}
