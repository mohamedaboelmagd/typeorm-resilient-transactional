import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';

import { lockRowsInOrder, withLockTimeout, withStatementTimeout } from '../../src/index.js';

/**
 * Guard clauses and fallbacks for the locking helpers. Their behaviour against a
 * real database is covered by `test/integration/lock-ordering.spec.ts`; these
 * cover the paths a healthy PostgreSQL will not produce on demand.
 */

interface FakeManagerOptions {
  inTransaction?: boolean;
  showResult?: unknown;
  failRestore?: boolean;
}

function fakeManager(options: FakeManagerOptions = {}) {
  const {
    inTransaction = true,
    showResult = [{ lock_timeout: '5s' }],
    failRestore = false,
  } = options;
  const queries: string[] = [];

  const manager = {
    queryRunner: { isTransactionActive: inTransaction },
    query: (sql: string) => {
      queries.push(sql);
      if (sql.startsWith('SHOW')) return Promise.resolve(showResult);
      if (failRestore && sql.includes("= '")) return Promise.reject(new Error('25P02 aborted'));
      return Promise.resolve([]);
    },
  } as unknown as EntityManager;

  return { manager, queries };
}

describe('transaction guards', () => {
  it.each([
    ['withLockTimeout', (m: EntityManager) => withLockTimeout(m, 100, () => Promise.resolve())],
    [
      'withStatementTimeout',
      (m: EntityManager) => withStatementTimeout(m, 100, () => Promise.resolve()),
    ],
  ])('%s refuses to run outside a transaction', async (_name, call) => {
    // SET LOCAL outside a transaction is a no-op that PostgreSQL only warns about,
    // so the caller would believe they were protected when they were not.
    const { manager } = fakeManager({ inTransaction: false });
    await expect(call(manager)).rejects.toThrow(/must run inside a transaction/);
  });

  it('lockRowsInOrder refuses to run outside a transaction', async () => {
    const { manager } = fakeManager({ inTransaction: false });
    await expect(lockRowsInOrder(manager, class Foo {}, [1])).rejects.toThrow(
      /must run inside a transaction/,
    );
  });
});

describe('duration validation', () => {
  // The value is interpolated because PostgreSQL will not bind a parameter in
  // SET, so validation is the only thing between a caller's variable and the
  // statement text.
  it.each([
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s', async (_label, ms) => {
    const { manager } = fakeManager();
    await expect(withLockTimeout(manager, ms, () => Promise.resolve())).rejects.toThrow(
      /non-negative integer/,
    );
  });

  it('accepts zero, which disables the timeout', async () => {
    const { manager, queries } = fakeManager();
    await withLockTimeout(manager, 0, () => Promise.resolve());
    expect(queries).toContain('SET LOCAL lock_timeout = 0');
  });
});

describe('restoring the previous setting', () => {
  it('puts back what SHOW reported', async () => {
    const { manager, queries } = fakeManager({ showResult: [{ lock_timeout: '5s' }] });

    await withLockTimeout(manager, 100, () => Promise.resolve());

    expect(queries).toEqual([
      'SHOW lock_timeout',
      'SET LOCAL lock_timeout = 100',
      "SET LOCAL lock_timeout = '5s'",
    ]);
  });

  it('falls back to 0 when SHOW returns nothing usable', async () => {
    const { manager, queries } = fakeManager({ showResult: [] });

    await withLockTimeout(manager, 100, () => Promise.resolve());

    expect(queries).toContain("SET LOCAL lock_timeout = '0'");
  });

  it('swallows a failing restore so the original error survives', async () => {
    // The usual case: the timeout fired, aborting the transaction, so every
    // further statement fails with 25P02 — including the restore. Letting that
    // propagate would replace the caller's 55P03 with a meaningless message.
    const { manager } = fakeManager({ failRestore: true });

    await expect(
      withLockTimeout(manager, 100, () => Promise.reject(new Error('55P03 lock not available'))),
    ).rejects.toThrow('55P03 lock not available');
  });

  it('swallows a failing restore on the success path too', async () => {
    const { manager } = fakeManager({ failRestore: true });

    await expect(withLockTimeout(manager, 100, () => Promise.resolve('done'))).resolves.toBe(
      'done',
    );
  });
});

describe('lockRowsInOrder ordering', () => {
  /** A manager just complete enough to reach the sorting logic. */
  function managerWithMetadata(primaryProps: string[]) {
    const built: unknown[][] = [];

    const builder = {
      setLock: () => builder,
      whereInIds: (ids: unknown) => {
        built.push(Array.isArray(ids) ? ids : [ids]);
        return builder;
      },
      orderBy: () => builder,
      getMany: () => Promise.resolve([]),
      getOne: () => Promise.resolve(null),
    };

    const manager = {
      queryRunner: { isTransactionActive: true },
      connection: {
        getMetadata: () => ({
          name: 'Thing',
          tableName: 'thing',
          primaryColumns: primaryProps.map((propertyName) => ({ propertyName })),
        }),
      },
      createQueryBuilder: () => builder,
    } as unknown as EntityManager;

    return { manager, built };
  }

  it('sorts numeric ids numerically, not lexicographically', async () => {
    const { manager, built } = managerWithMetadata(['id']);

    await lockRowsInOrder(manager, class Thing {}, [10, 9, 100]);

    // Lexicographic sorting would give [10, 100, 9] and defeat the whole purpose.
    expect(built[0]).toEqual([9, 10, 100]);
  });

  it('sorts string ids lexicographically', async () => {
    const { manager, built } = managerWithMetadata(['id']);

    await lockRowsInOrder(manager, class Thing {}, ['delta', 'alpha', 'charlie']);

    expect(built[0]).toEqual(['alpha', 'charlie', 'delta']);
  });

  it('falls back to row-by-row for a composite primary key', async () => {
    const { manager, built } = managerWithMetadata(['tenantId', 'seq']);

    await lockRowsInOrder(manager, class Thing {}, [3, 1, 2]);

    // One statement per row, in sorted order — the ordering across columns is the
    // caller's semantics, not something a single ORDER BY can be trusted with.
    expect(built).toEqual([[1], [2], [3]]);
  });

  it('rejects an entity with no primary column', async () => {
    const { manager } = managerWithMetadata([]);

    await expect(lockRowsInOrder(manager, class Thing {}, [1])).rejects.toThrow(
      /no primary column/,
    );
  });

  it('deduplicates before sorting', async () => {
    const { manager, built } = managerWithMetadata(['id']);

    await lockRowsInOrder(manager, class Thing {}, [3, 1, 3, 1, 2]);

    expect(built[0]).toEqual([1, 2, 3]);
  });

  it('issues nothing at all for an empty list', async () => {
    const { manager, built } = managerWithMetadata(['id']);

    expect(await lockRowsInOrder(manager, class Thing {}, [])).toEqual([]);
    expect(built).toEqual([]);
  });

  it('does not call the comparator when there is nothing to order', async () => {
    const { manager } = managerWithMetadata(['id']);
    const comparator = vi.fn();

    await lockRowsInOrder(manager, class Thing {}, [], { comparator });

    expect(comparator).not.toHaveBeenCalled();
  });
});
