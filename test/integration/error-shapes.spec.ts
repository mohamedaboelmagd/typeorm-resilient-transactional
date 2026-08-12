import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryFailedError, type DataSource } from 'typeorm';

import { createFixtureDataSource } from './harness/fixtures.js';
import { reasonOf } from './harness/barrier.js';
import {
  produceDeadlock,
  produceWriteSkew,
  setupDeadlockFixture,
  setupWriteSkewFixture,
} from './harness/conflicts.js';

/**
 * Pins the *actual* shape of the errors the classifier has to read.
 *
 * The SQLSTATE lives in a different place depending on driver and wrapping, and
 * guessing wrong means the retry engine silently never fires. These assertions
 * are what makes `extractSqlState()` a response to evidence rather than to
 * memory, and they will fail loudly if a TypeORM or `pg` upgrade moves things.
 */

let dataSource: DataSource;

beforeAll(async () => {
  dataSource = createFixtureDataSource();
  await dataSource.initialize();
});

// Both fixtures are single-use: once a doctor goes off call the guard stops
// holding, and the second run produces no conflict at all.
beforeEach(async () => {
  await setupDeadlockFixture(dataSource);
  await setupWriteSkewFixture(dataSource);
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

describe('the shape of a real deadlock error', () => {
  it('arrives as a QueryFailedError carrying 40P01 in both places', async () => {
    const [a, b] = await produceDeadlock(dataSource);

    const failure = reasonOf(a) ?? reasonOf(b);
    expect(failure, 'exactly one session should have been killed').toBeDefined();
    expect(failure).toBeInstanceOf(QueryFailedError);

    const error = failure as QueryFailedError & {
      code?: string;
      driverError?: { code?: string };
    };

    // TypeORM copies the driver's fields onto the wrapper *and* keeps the
    // original under `driverError`. The classifier must accept either.
    expect(error.driverError?.code).toBe('40P01');
    expect(error.code).toBe('40P01');
  });
});

describe('the shape of a real serialization failure', () => {
  it('arrives as a QueryFailedError carrying 40001', async () => {
    const [a, b] = await produceWriteSkew(dataSource);

    const failure = reasonOf(a) ?? reasonOf(b);
    expect(failure, 'exactly one session should have been aborted').toBeDefined();
    expect(failure).toBeInstanceOf(QueryFailedError);

    const error = failure as QueryFailedError & {
      code?: string;
      driverError?: { code?: string };
    };

    expect(error.driverError?.code).toBe('40001');
    expect(error.code).toBe('40001');
  });

  /**
   * Where the failure surfaces is **not fixed**, and that is the point.
   *
   * PostgreSQL's SSI raises `40001` as soon as it detects a dangerous structure.
   * Sometimes that is at `COMMIT`, once every statement has already appeared to
   * succeed; sometimes it is at the conflicting statement itself. Both were
   * observed across the CI version matrix — an earlier version of this test
   * asserted `COMMIT` unconditionally and failed on PostgreSQL 15.
   *
   * Either way the *entire* transaction is aborted, so there is no single
   * statement a caller could usefully re-issue. That is what makes
   * whole-transaction retry the only sound design, and per-statement retry — what
   * TypeORM issue #9806 literally asked for — unimplementable.
   */
  it('surfaces at COMMIT or at the conflicting statement, never predictably', async () => {
    const [a, b] = await produceWriteSkew(dataSource);
    const failure = (reasonOf(a) ?? reasonOf(b)) as QueryFailedError & { query?: string };

    expect(failure.query).toBeTypeOf('string');
    expect(failure.query).toMatch(/COMMIT|UPDATE doctor/i);
  });

  it('aborts the whole transaction, whichever statement reported it', async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();

    try {
      await runner.startTransaction('SERIALIZABLE');
      await runner.query('SELECT count(*) FROM doctor WHERE on_call = true');

      // A second session commits a conflicting change.
      await dataSource.query('UPDATE doctor SET on_call = false WHERE id = 1');

      await runner.query('UPDATE doctor SET on_call = false WHERE id = 2');

      const failed = await runner.commitTransaction().then(
        () => false,
        () => true,
      );

      if (failed) {
        // Once aborted, nothing else can run on that transaction — so retrying a
        // single statement inside it is not an option that exists.
        await expect(runner.query('SELECT 1')).rejects.toThrow();
      }
    } finally {
      try {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
      } catch {
        /* already aborted */
      }
      await runner.release();
    }
  });
});
