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

  it('raises the failure at COMMIT, not at the offending statement', async () => {
    // This is why retry has to re-run the whole method body: by the time
    // PostgreSQL notices, every statement has already "succeeded".
    const [a, b] = await produceWriteSkew(dataSource);
    const failure = (reasonOf(a) ?? reasonOf(b)) as QueryFailedError & { query?: string };

    expect(failure.query).toMatch(/COMMIT/i);
  });
});
