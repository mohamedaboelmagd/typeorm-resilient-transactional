import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';

import {
  addResilientDataSource,
  clearResilientDataSources,
  initializeResilientContext,
  type RetryInfo,
} from '../../src/index.js';
import { createTestDataSource } from './harness/postgres.js';
import {
  BenchAccount,
  accountTotals,
  makeTransfer,
  randomPair,
  setupAccounts,
  type Strategy,
} from './harness/transfers.js';

/**
 * The property that matters: **money is conserved.**
 *
 * 100 concurrent random transfers across 10 accounts, repeated 20 times. Any
 * lost-update or write-skew bug shows up as a total that moved, which no amount
 * of "the tests pass" elsewhere would reveal.
 */

const ACCOUNTS = 10;
const STARTING_BALANCE = 1_000;
const CONCURRENCY = 100;
const ITERATIONS = 20;
const EXPECTED_TOTAL = ACCOUNTS * STARTING_BALANCE;

let dataSource: DataSource;

beforeAll(async () => {
  initializeResilientContext();
  // The pool has to exceed the concurrency, or the test measures connection
  // starvation instead of database contention — and can deadlock on acquisition.
  dataSource = createTestDataSource([BenchAccount], { poolSize: CONCURRENCY + 10 });
  await dataSource.initialize();
  addResilientDataSource(dataSource);
});

afterAll(async () => {
  clearResilientDataSources();
  if (dataSource?.isInitialized) await dataSource.destroy();
});

beforeEach(async () => {
  await setupAccounts(dataSource, ACCOUNTS, STARTING_BALANCE);
});

async function runRound(strategy: Strategy, onRetry?: (info: RetryInfo) => void) {
  const transfer = makeTransfer(strategy, {
    maxAttempts: 25,
    ...(onRetry === undefined ? {} : { onRetry }),
  });

  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENCY }, () => {
      const [from, to] = randomPair(ACCOUNTS);
      return transfer(from, to, 1 + Math.floor(Math.random() * 50));
    }),
  );

  return {
    failed: results.filter((r) => r.status === 'rejected').length,
  };
}

describe('SERIALIZABLE with retry', () => {
  it(`conserves money across ${String(ITERATIONS)} rounds of ${String(CONCURRENCY)} concurrent transfers`, async () => {
    let retries = 0;
    let failures = 0;

    for (let round = 0; round < ITERATIONS; round++) {
      await setupAccounts(dataSource, ACCOUNTS, STARTING_BALANCE);

      const { failed } = await runRound('serializable-retry', () => {
        retries += 1;
      });
      failures += failed;

      const { total, negatives } = await accountTotals(dataSource);

      // The invariant, asserted without tolerance every single round.
      expect(total, `round ${String(round)} lost or created money`).toBe(EXPECTED_TOTAL);
      expect(negatives, `round ${String(round)} drove an account negative`).toBe(0);
    }

    // If this were zero the workload was not actually contended and the test
    // proved nothing about retry.
    expect(retries, 'the workload should have produced real conflicts').toBeGreaterThan(0);

    // 100 concurrent transactions over 10 accounts is deliberately brutal —
    // every transaction touches a fifth of the dataset. A few will exhaust
    // their attempts, and that is optimistic concurrency working as designed,
    // not a defect: the caller gets RetriesExhaustedError rather than a
    // corrupted balance. The measured rate is recorded in
    // benchmarks/RESULTS.md; this bound only guards against a regression that
    // makes retry stop working altogether.
    const total = ITERATIONS * CONCURRENCY;
    expect(
      failures / total,
      `${String(failures)}/${String(total)} transfers exhausted their attempts`,
    ).toBeLessThan(0.05);
  }, 240_000);
});

describe('READ COMMITTED with ordered pessimistic locks', () => {
  it('also conserves money, and never deadlocks', async () => {
    for (let round = 0; round < 5; round++) {
      await setupAccounts(dataSource, ACCOUNTS, STARTING_BALANCE);

      const { failed } = await runRound('read-committed-locks');
      const { total, negatives } = await accountTotals(dataSource);

      expect(total).toBe(EXPECTED_TOTAL);
      expect(negatives).toBe(0);
      // Ordered locking means no deadlocks, so nothing needs retrying.
      expect(failed).toBe(0);
    }
  }, 120_000);
});

describe('SERIALIZABLE without retry', () => {
  it('conserves money but loses transfers — the status quo this library replaces', async () => {
    await setupAccounts(dataSource, ACCOUNTS, STARTING_BALANCE);

    const { failed } = await runRound('serializable-no-retry');
    const { total, negatives } = await accountTotals(dataSource);

    // Correctness is never in question: PostgreSQL simply refuses the conflicting
    // transactions. The cost is that they reach the caller as errors.
    expect(total).toBe(EXPECTED_TOTAL);
    expect(negatives).toBe(0);
    expect(failed, 'unretried SERIALIZABLE should drop work under contention').toBeGreaterThan(0);
  }, 120_000);
});
