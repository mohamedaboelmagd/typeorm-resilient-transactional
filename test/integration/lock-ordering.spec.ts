import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Column, Entity, PrimaryColumn, type DataSource, type QueryRunner } from 'typeorm';

import {
  addResilientDataSource,
  clearResilientDataSources,
  extractSqlState,
  initializeResilientContext,
  lockRowsInOrder,
  runInResilientTransaction,
  withLockTimeout,
  withStatementTimeout,
} from '../../src/index.js';
import { createTestDataSource } from './harness/postgres.js';
import { Barrier, race2, reasonOf } from './harness/barrier.js';

/**
 * The Phase 5 gate. Two questions:
 *
 *  1. Does `ORDER BY … FOR UPDATE` really acquire locks in that order, under every
 *     plan shape? The answer decides whether `lockRowsInOrder` can use one round
 *     trip or needs N. It is asserted here rather than assumed, and the CI matrix
 *     re-checks it on PostgreSQL 14, 15, 16, and 17.
 *  2. Does ordering actually prevent the deadlocks that unordered locking causes?
 *
 * @see docs/lock-ordering.md
 */

@Entity('lockorder')
class LockRow {
  @PrimaryColumn('int')
  id!: number;

  @Column('int')
  value!: number;
}

let dataSource: DataSource;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PLAN_SHAPES: [string, string[]][] = [
  ['index scan', ['enable_seqscan = off', 'enable_bitmapscan = off']],
  [
    'bitmap heap scan',
    ['enable_seqscan = off', 'enable_indexscan = off', 'enable_indexonlyscan = off'],
  ],
  [
    'sequential scan',
    ['enable_indexscan = off', 'enable_bitmapscan = off', 'enable_indexonlyscan = off'],
  ],
];

beforeAll(async () => {
  initializeResilientContext();
  dataSource = createTestDataSource([LockRow]);
  await dataSource.initialize();
  addResilientDataSource(dataSource);
});

afterAll(async () => {
  clearResilientDataSources();
  if (dataSource?.isInitialized) await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE TABLE lockorder');
  // Enough rows that a sequential scan is a plausible plan for the planner to be
  // forced into, and that ANALYZE produces meaningful statistics.
  await dataSource.query(
    `INSERT INTO lockorder (id, value) SELECT g, 0 FROM generate_series(1, 20000) g`,
  );
  await dataSource.query('ANALYZE lockorder');
});

/** Attempts a NOWAIT lock inside a savepoint, so a refusal does not abort the probe. */
async function canLock(runner: QueryRunner, id: number): Promise<boolean> {
  await runner.query('SAVEPOINT probe');
  try {
    await runner.query('SELECT id FROM lockorder WHERE id = $1 FOR UPDATE NOWAIT', [id]);
    await runner.query('RELEASE SAVEPOINT probe');
    return true;
  } catch {
    await runner.query('ROLLBACK TO SAVEPOINT probe');
    return false;
  }
}

describe('does ORDER BY drive lock acquisition order?', () => {
  /**
   * Session A holds row 5. Session B asks for `{9, 5, 1}` — deliberately not in
   * ascending array order — with `ORDER BY id FOR UPDATE`, and must stall on row 5.
   * Session C then asks which rows B managed to take before stalling.
   *
   *   row 1 locked, row 9 free  → B locked ascending and stopped at 5
   *   row 9 locked, row 1 free  → B locked in array order
   */
  it.each(PLAN_SHAPES)('locks ascending under a %s', async (_label, settings) => {
    const holder = dataSource.createQueryRunner();
    const blocked = dataSource.createQueryRunner();
    const prober = dataSource.createQueryRunner();

    await Promise.all([holder.connect(), blocked.connect(), prober.connect()]);

    try {
      await holder.startTransaction();
      await holder.query('SELECT id FROM lockorder WHERE id = 5 FOR UPDATE');

      await blocked.startTransaction();
      for (const s of settings) await blocked.query(`SET LOCAL ${s}`);

      const blockedQuery = blocked
        .query('SELECT id FROM lockorder WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[9, 5, 1]])
        .catch(() => undefined);

      await sleep(400);

      await prober.startTransaction();
      const oneFree = await canLock(prober, 1);
      const nineFree = await canLock(prober, 9);
      await prober.rollbackTransaction();

      expect(oneFree, 'row 1 should already be locked by the blocked session').toBe(false);
      expect(nineFree, 'row 9 should not have been reached yet').toBe(true);

      await holder.rollbackTransaction();
      await blockedQuery;
      if (blocked.isTransactionActive) await blocked.rollbackTransaction();
    } finally {
      await Promise.all([holder.release(), blocked.release(), prober.release()]);
    }
  });

  it('puts LockRows above the ordering step in every plan', async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();

    try {
      for (const [, settings] of PLAN_SHAPES) {
        await runner.startTransaction();
        for (const s of settings) await runner.query(`SET LOCAL ${s}`);

        const rows = (await runner.query(
          'EXPLAIN (COSTS OFF, VERBOSE) SELECT id FROM lockorder WHERE id = ANY($1) ' +
            'ORDER BY id FOR UPDATE',
          [[7, 3, 11, 5, 9]],
        )) as Record<string, string>[];

        await runner.rollbackTransaction();

        const plan = rows.map((r) => Object.values(r)[0] ?? '').join('\n');

        // LockRows consuming already-ordered output is the structural reason the
        // acquisition order holds. If a future planner pushes it below the Sort,
        // this assertion fails before the behavioural one does.
        expect(plan.split('\n')[0]).toMatch(/^LockRows/);
      }
    } finally {
      await runner.release();
    }
  });
});

describe('ordering prevents the deadlock that unordered locking causes', () => {
  const ids = [1, 2];

  it('deadlocks reliably when two transactions lock in opposite orders', async () => {
    const barrier = new Barrier(2);

    const session = (order: number[]) => () =>
      runInResilientTransaction(
        async (manager) => {
          await manager.query('SELECT id FROM lockorder WHERE id = $1 FOR UPDATE', [order[0]]);
          await barrier.arrive();
          await manager.query('SELECT id FROM lockorder WHERE id = $1 FOR UPDATE', [order[1]]);
        },
        { retry: false },
      );

    const [a, b] = await race2(barrier, session([1, 2]), session([2, 1]));
    const failure = reasonOf(a) ?? reasonOf(b);

    expect(extractSqlState(failure)).toBe('40P01');
  });

  /**
   * No barrier here, deliberately — and the reason is the result.
   *
   * Once both sessions sort, whichever arrives first takes *both* rows and the
   * other blocks on row 1 until it commits. The two can no longer interleave, so
   * a rendezvous between them is unreachable by construction. Serialising them is
   * exactly what removes the cycle.
   */
  const orderedSessions = (strategy?: 'row-by-row') => {
    const session = (handedTo: number[]) => () =>
      runInResilientTransaction(
        async (manager) => {
          await lockRowsInOrder(
            manager,
            LockRow,
            handedTo,
            strategy === undefined ? {} : { strategy },
          );
          await manager.query('UPDATE lockorder SET value = value + 1 WHERE id = ANY($1)', [ids]);
        },
        { retry: false },
      );

    return Promise.allSettled([session([1, 2])(), session([2, 1])()]);
  };

  it('never deadlocks when both sort first, whatever order they were handed', async () => {
    for (let i = 0; i < 25; i++) {
      const [a, b] = await orderedSessions();
      expect(reasonOf(a)).toBeUndefined();
      expect(reasonOf(b)).toBeUndefined();
    }

    // Both transactions applied their update exactly once, 25 times over.
    const rows = await dataSource.query<{ value: number }[]>(
      'SELECT value FROM lockorder WHERE id = ANY($1) ORDER BY id',
      [ids],
    );
    expect(rows.map((r) => r.value)).toEqual([50, 50]);
  });

  it('holds for the row-by-row strategy too', async () => {
    for (let i = 0; i < 25; i++) {
      const [a, b] = await orderedSessions('row-by-row');
      expect(reasonOf(a)).toBeUndefined();
      expect(reasonOf(b)).toBeUndefined();
    }
  });
});

describe('lockRowsInOrder', () => {
  it('returns the rows in the order they were locked', async () => {
    await runInResilientTransaction(async (manager) => {
      const rows = await lockRowsInOrder(manager, LockRow, [9, 3, 7]);
      expect(rows.map((r) => r.id)).toEqual([3, 7, 9]);
    });
  });

  it('deduplicates ids', async () => {
    await runInResilientTransaction(async (manager) => {
      const rows = await lockRowsInOrder(manager, LockRow, [5, 5, 5]);
      expect(rows.map((r) => r.id)).toEqual([5]);
    });
  });

  it('does nothing for an empty id list', async () => {
    await runInResilientTransaction(async (manager) => {
      expect(await lockRowsInOrder(manager, LockRow, [])).toEqual([]);
    });
  });

  it('honours a custom comparator, locking row-by-row', async () => {
    await runInResilientTransaction(async (manager) => {
      const rows = await lockRowsInOrder(manager, LockRow, [1, 2, 3], {
        comparator: (a, b) => b - a, // descending
      });
      expect(rows.map((r) => r.id)).toEqual([3, 2, 1]);
    });
  });

  it('refuses single-statement with a custom comparator, which it cannot honour', async () => {
    await runInResilientTransaction(async (manager) => {
      await expect(
        lockRowsInOrder(manager, LockRow, [1, 2], {
          comparator: (a, b) => b - a,
          strategy: 'single-statement',
        }),
      ).rejects.toThrow(/cannot honour a custom comparator/);
    });
  });

  it('refuses to run outside a transaction, where locks would be pointless', async () => {
    await expect(lockRowsInOrder(dataSource.manager, LockRow, [1])).rejects.toThrow(
      /must run inside a transaction/,
    );
  });
});

describe('withLockTimeout', () => {
  it('turns an unbounded lock wait into a retryable 55P03', async () => {
    const holder = dataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    await holder.query('SELECT id FROM lockorder WHERE id = 1 FOR UPDATE');

    try {
      const error = await runInResilientTransaction(
        (manager) =>
          withLockTimeout(manager, 100, () =>
            manager.query('SELECT id FROM lockorder WHERE id = 1 FOR UPDATE'),
          ),
        { retry: false },
      ).catch((e: unknown) => e);

      expect(extractSqlState(error)).toBe('55P03');
    } finally {
      await holder.rollbackTransaction();
      await holder.release();
    }
  });

  it('restores the previous setting afterwards', async () => {
    await runInResilientTransaction(async (manager) => {
      const before = await manager.query<{ lock_timeout: string }[]>('SHOW lock_timeout');
      await withLockTimeout(manager, 50, () => Promise.resolve());
      const after = await manager.query<{ lock_timeout: string }[]>('SHOW lock_timeout');

      expect(after[0]?.lock_timeout).toBe(before[0]?.lock_timeout);
    });
  });

  it('rejects a nonsensical duration rather than interpolating it', async () => {
    await runInResilientTransaction(async (manager) => {
      await expect(withLockTimeout(manager, -1, () => Promise.resolve())).rejects.toThrow(
        /non-negative integer/,
      );
      await expect(withLockTimeout(manager, 1.5, () => Promise.resolve())).rejects.toThrow(
        /non-negative integer/,
      );
    });
  });

  it('refuses to run outside a transaction, where SET LOCAL does nothing', async () => {
    await expect(withLockTimeout(dataSource.manager, 100, () => Promise.resolve())).rejects.toThrow(
      /must run inside a transaction/,
    );
  });
});

describe('withStatementTimeout', () => {
  it('cancels a statement that runs too long, with 57014', async () => {
    const error = await runInResilientTransaction(
      (manager) => withStatementTimeout(manager, 100, () => manager.query('SELECT pg_sleep(2)')),
      { retry: false },
    ).catch((e: unknown) => e);

    // Not retried by default: a query that exhausted its budget will usually
    // exhaust it again. @see docs/adr/0005-no-connection-error-retry.md
    expect(extractSqlState(error)).toBe('57014');
  });

  it('restores the previous setting afterwards', async () => {
    await runInResilientTransaction(async (manager) => {
      const before = await manager.query<{ statement_timeout: string }[]>('SHOW statement_timeout');
      await withStatementTimeout(manager, 50, () => Promise.resolve());
      const after = await manager.query<{ statement_timeout: string }[]>('SHOW statement_timeout');

      expect(after[0]?.statement_timeout).toBe(before[0]?.statement_timeout);
    });
  });
});

afterEach(async () => {
  await dataSource.query('TRUNCATE TABLE lockorder');
});
