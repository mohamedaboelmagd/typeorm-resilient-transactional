import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';

import {
  IsolationLevel,
  RetriesExhaustedError,
  addResilientDataSource,
  clearResilientDataSources,
  currentAttempt,
  extractSqlState,
  initializeResilientContext,
  runInResilientTransaction,
  type RetryInfo,
} from '../../src/index.js';
import { createFixtureDataSource } from './harness/fixtures.js';
import { Barrier, assertBothSucceeded, race2, reasonOf } from './harness/barrier.js';
import {
  onCallCount,
  produceDeadlock,
  produceWriteSkew,
  setupDeadlockFixture,
  setupWriteSkewFixture,
} from './harness/conflicts.js';

/**
 * The Phase 3 gate, and the library's entire reason for existing: the same
 * concurrent workload fails without retry and succeeds with it, against a real
 * PostgreSQL.
 *
 * Each pair of tests runs the *identical* interleaving. The only variable is
 * whether retry is configured.
 */

let dataSource: DataSource;

const fast = { strategy: 'exponential-full-jitter', baseMs: 1, capMs: 20 } as const;

/**
 * The retry budget for tests that need *both* sessions to finish.
 *
 * The loser of a conflict can be aborted a second time on its retry, because it
 * re-reads the same rows while the winner's COMMIT is still in flight. So the
 * budget has to cover a stall on a busy runner, not just the one retry the idle
 * path needs. Measured on `postgres:17-alpine`: a third attempt never occurred
 * across 120 unloaded rounds, and appeared in 1–4% of rounds under CPU
 * contention. This headroom is a fact about CI, not about the library — the
 * tests that assert what the budget itself does set it explicitly.
 */
const contended = { maxAttempts: 25, backoff: fast } as const;

beforeAll(async () => {
  initializeResilientContext();
  dataSource = createFixtureDataSource();
  await dataSource.initialize();
  addResilientDataSource(dataSource);
});

afterAll(async () => {
  clearResilientDataSources();
  if (dataSource?.isInitialized) await dataSource.destroy();
});

beforeEach(async () => {
  await setupDeadlockFixture(dataSource);
  await setupWriteSkewFixture(dataSource);
});

describe('40P01 deadlock_detected', () => {
  it('kills one of two sessions when nothing retries', async () => {
    const [a, b] = await produceDeadlock(dataSource);

    const failure = reasonOf(a) ?? reasonOf(b);
    expect(failure, 'the harness must reliably deadlock').toBeDefined();
    expect(extractSqlState(failure)).toBe('40P01');
  });

  it('completes both sessions when retry is enabled', async () => {
    const barrier = new Barrier(2);
    const retries: RetryInfo[] = [];

    // The barrier is single-use, so only the first attempt rendezvous. A retried
    // transaction runs alone — which is exactly what happens in production once
    // the winner has committed and released its locks.
    const session = (firstId: number, secondId: number) => () =>
      runInResilientTransaction(
        async (manager) => {
          await manager.query('UPDATE deadlock_row SET value = value + 1 WHERE id = $1', [firstId]);

          if (currentAttempt() === 1) await barrier.arrive();

          await manager.query('UPDATE deadlock_row SET value = value + 1 WHERE id = $1', [
            secondId,
          ]);
        },
        {
          isolation: IsolationLevel.READ_COMMITTED,
          retry: contended,
          onRetry: (info) => retries.push(info),
        },
      );

    const [a, b] = await race2(barrier, session(1, 2), session(2, 1));

    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');

    expect(retries.length, 'a deadlock must actually have occurred').toBeGreaterThanOrEqual(1);
    expect(retries[0]?.sqlstate).toBe('40P01');

    // Both sessions incremented both rows exactly once.
    const rows = await dataSource.query<{ id: number; value: number }[]>(
      'SELECT id, value FROM deadlock_row ORDER BY id',
    );
    expect(rows.map((r) => r.value)).toEqual([2, 2]);
  });
});

describe('40001 serialization_failure', () => {
  it('aborts one of two SERIALIZABLE sessions when nothing retries', async () => {
    const [a, b] = await produceWriteSkew(dataSource);

    const failure = reasonOf(a) ?? reasonOf(b);
    expect(failure, 'the harness must reliably produce write skew').toBeDefined();
    expect(extractSqlState(failure)).toBe('40001');
  });

  it('completes both sessions when retry is enabled, and preserves the invariant', async () => {
    const barrier = new Barrier(2);
    const retries: RetryInfo[] = [];

    const session = (doctorId: number) => () =>
      runInResilientTransaction(
        async (manager) => {
          const rows = await manager.query<{ count: number }[]>(
            'SELECT count(*)::int AS count FROM doctor WHERE on_call = true',
          );

          if (currentAttempt() === 1) await barrier.arrive();

          if ((rows[0]?.count ?? 0) >= 2) {
            await manager.query('UPDATE doctor SET on_call = false WHERE id = $1', [doctorId]);
          }
        },
        {
          isolation: IsolationLevel.SERIALIZABLE,
          retry: contended,
          onRetry: (info) => retries.push(info),
        },
      );

    const [a, b] = await race2(barrier, session(1), session(2));

    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
    expect(retries[0]?.sqlstate).toBe('40001');

    // The point of the whole exercise. The retried transaction re-read the table,
    // saw the winner's committed write, and correctly declined to take the last
    // doctor off call. Retry did not merely swallow an error — it produced the
    // right answer, which is what SERIALIZABLE promised and could not deliver
    // without it.
    expect(await onCallCount(dataSource)).toBe(1);
  });

  it('re-runs the whole method body, since no single statement can be re-issued', async () => {
    const barrier = new Barrier(2);
    let bodyRuns = 0;

    const session = (doctorId: number) => () =>
      runInResilientTransaction(
        async (manager) => {
          bodyRuns += 1;
          const rows = await manager.query<{ count: number }[]>(
            'SELECT count(*)::int AS count FROM doctor WHERE on_call = true',
          );

          if (currentAttempt() === 1) await barrier.arrive();

          if ((rows[0]?.count ?? 0) >= 2) {
            await manager.query('UPDATE doctor SET on_call = false WHERE id = $1', [doctorId]);
          }
        },
        { isolation: IsolationLevel.SERIALIZABLE, retry: contended },
      );

    assertBothSucceeded(await race2(barrier, session(1), session(2)));

    // Two sessions, at least one of which ran twice.
    expect(bodyRuns).toBeGreaterThanOrEqual(3);
  });
});

describe('giving up', () => {
  it('throws RetriesExhaustedError carrying the last SQLSTATE', async () => {
    // maxAttempts 1 means the first failure is also the last.
    const barrier = new Barrier(2);

    const session = (doctorId: number) => () =>
      runInResilientTransaction(
        async (manager) => {
          const rows = await manager.query<{ count: number }[]>(
            'SELECT count(*)::int AS count FROM doctor WHERE on_call = true',
          );

          if (currentAttempt() === 1) await barrier.arrive();

          if ((rows[0]?.count ?? 0) >= 2) {
            await manager.query('UPDATE doctor SET on_call = false WHERE id = $1', [doctorId]);
          }
        },
        { isolation: IsolationLevel.SERIALIZABLE, retry: { maxAttempts: 1, backoff: fast } },
      );

    const [a, b] = await race2(barrier, session(1), session(2));
    const failure = reasonOf(a) ?? reasonOf(b);

    expect(failure).toBeInstanceOf(RetriesExhaustedError);
    const exhausted = failure as RetriesExhaustedError;
    expect(exhausted.attempts).toBe(1);
    expect(exhausted.sqlstate).toBe('40001');
    expect(extractSqlState(exhausted.cause)).toBe('40001');
  });
});
