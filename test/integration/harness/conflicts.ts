import type { DataSource, QueryRunner } from 'typeorm';

import { Barrier, race2 } from './barrier.js';

/**
 * Deterministic producers for the two errors this library exists to survive.
 *
 * Both use a barrier so the interleaving is exact rather than probabilistic.
 */

async function withRunner<T>(
  dataSource: DataSource,
  isolation: 'READ COMMITTED' | 'SERIALIZABLE',
  fn: (runner: QueryRunner) => Promise<T>,
): Promise<T> {
  const runner = dataSource.createQueryRunner();
  try {
    await runner.connect();
    await runner.startTransaction(isolation);
    try {
      const result = await fn(runner);
      await runner.commitTransaction();
      return result;
    } catch (error) {
      try {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
      } catch {
        /* the transaction is already aborted — the original error is what matters */
      }
      throw error;
    }
  } finally {
    await runner.release();
  }
}

export async function setupDeadlockFixture(dataSource: DataSource): Promise<void> {
  await dataSource.query('DROP TABLE IF EXISTS deadlock_row');
  await dataSource.query('CREATE TABLE deadlock_row (id int PRIMARY KEY, value int NOT NULL)');
  await dataSource.query('INSERT INTO deadlock_row (id, value) VALUES (1, 0), (2, 0)');
}

/**
 * Guaranteed `40P01`.
 *
 * T1 locks row 1, T2 locks row 2, both wait at the barrier, then each reaches for
 * the row the other holds. PostgreSQL's deadlock detector kills exactly one.
 */
export async function produceDeadlock(
  dataSource: DataSource,
): Promise<[PromiseSettledResult<void>, PromiseSettledResult<void>]> {
  const barrier = new Barrier(2);

  const session = (firstId: number, secondId: number) => async (): Promise<void> => {
    await withRunner(dataSource, 'READ COMMITTED', async (runner) => {
      await runner.query('UPDATE deadlock_row SET value = value + 1 WHERE id = $1', [firstId]);
      await barrier.arrive();
      await runner.query('UPDATE deadlock_row SET value = value + 1 WHERE id = $1', [secondId]);
    });
  };

  return race2(barrier, session(1, 2), session(2, 1));
}

export async function setupWriteSkewFixture(dataSource: DataSource): Promise<void> {
  await dataSource.query('DROP TABLE IF EXISTS doctor');
  await dataSource.query(
    'CREATE TABLE doctor (id int PRIMARY KEY, name text NOT NULL, on_call boolean NOT NULL)',
  );
  await dataSource.query(
    `INSERT INTO doctor (id, name, on_call) VALUES (1, 'alice', true), (2, 'bob', true)`,
  );
}

/**
 * Guaranteed `40001` — the canonical on-call doctors write skew.
 *
 * Both transactions check that at least two doctors are on call, both see 2, and
 * both then take themselves off call. Neither sees the other's write, so under a
 * weaker isolation level the invariant "at least one doctor on call" silently
 * breaks. Under SERIALIZABLE, PostgreSQL detects the read/write dependency cycle
 * and aborts one at COMMIT with a serialization failure.
 *
 * This is the bug the library's whole thesis is about: SERIALIZABLE is the only
 * level that catches it, and SERIALIZABLE is unusable without retry.
 */
export async function produceWriteSkew(
  dataSource: DataSource,
): Promise<[PromiseSettledResult<void>, PromiseSettledResult<void>]> {
  const barrier = new Barrier(2);

  const session = (doctorId: number) => async (): Promise<void> => {
    await withRunner(dataSource, 'SERIALIZABLE', async (runner) => {
      const rows = (await runner.query(
        'SELECT count(*)::int AS count FROM doctor WHERE on_call = true',
      )) as { count: number }[];

      // Both sessions must complete their read before either writes, or the
      // second would simply see the first's committed state and no cycle forms.
      await barrier.arrive();

      if ((rows[0]?.count ?? 0) >= 2) {
        await runner.query('UPDATE doctor SET on_call = false WHERE id = $1', [doctorId]);
      }
    });
  };

  return race2(barrier, session(1), session(2));
}

export async function onCallCount(dataSource: DataSource): Promise<number> {
  const rows = await dataSource.query<{ count: number }[]>(
    'SELECT count(*)::int AS count FROM doctor WHERE on_call = true',
  );
  return rows[0]?.count ?? 0;
}
