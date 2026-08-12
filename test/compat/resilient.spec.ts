import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';

import {
  Propagation,
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
  runInTransaction,
  wrapInTransaction,
} from '../../src/index.js';
import { createFixtureDataSource } from '../integration/harness/fixtures.js';
import {
  EXPECTED_NESTED_RESILIENT,
  EXPECTED_SHARED,
  NESTED_SCENARIO,
  SCENARIOS,
  makeWriteNote,
  runScenario,
  type TransactionalApi,
} from './scenarios.js';

/**
 * The same scenarios through this library, imported through the *compat* aliases
 * only — so this file doubles as proof that the drop-in surface is complete
 * enough to run a real suite without touching a single native name.
 */

let dataSource: DataSource;

const api: TransactionalApi = {
  label: 'typeorm-resilient-transactional',
  Propagation: Propagation,
  wrap: ((fn: (...args: never[]) => unknown, propagation: string) =>
    wrapInTransaction(fn, {
      propagation: propagation as Propagation,
    })) as TransactionalApi['wrap'],
  runInTransaction: <T>(fn: () => Promise<T>) => runInTransaction(fn),
};

beforeAll(async () => {
  initializeTransactionalContext();
  dataSource = createFixtureDataSource();
  await dataSource.initialize();
  addTransactionalDataSource(dataSource);
});

afterAll(async () => {
  deleteDataSourceByName('default');
  if (dataSource?.isInitialized) await dataSource.destroy();
});

describe('parity with typeorm-transactional', () => {
  for (const scenario of SCENARIOS) {
    if (scenario.name === NESTED_SCENARIO) continue;

    it(scenario.name, async () => {
      const outcome = await runScenario(scenario, {
        api,
        dataSource,
        writeNote: makeWriteNote(dataSource),
      });

      expect(outcome).toEqual(EXPECTED_SHARED[scenario.name]);
    });
  }
});

describe('the one intentional divergence', () => {
  it('rolls NESTED back with the outer transaction, because it is a real savepoint', async () => {
    const scenario = SCENARIOS.find((s) => s.name === NESTED_SCENARIO);
    expect(scenario).toBeDefined();

    const outcome = await runScenario(scenario!, {
      api,
      dataSource,
      writeNote: makeWriteNote(dataSource),
    });

    expect(outcome).toEqual(EXPECTED_NESTED_RESILIENT);
    expect(outcome.notes).not.toContain('inner');
  });
});
