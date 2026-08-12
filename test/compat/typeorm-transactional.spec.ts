import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  Propagation,
  StorageDriver,
  addTransactionalDataSource,
  deleteDataSourceByName,
  initializeTransactionalContext,
  runInTransaction,
  wrapInTransaction,
} from 'typeorm-transactional';

import { createFixtureDataSource } from '../integration/harness/fixtures.js';
import {
  EXPECTED_NESTED_TYPEORM_TRANSACTIONAL,
  EXPECTED_SHARED,
  NESTED_SCENARIO,
  SCENARIOS,
  makeWriteNote,
  runScenario,
  type TransactionalApi,
} from './scenarios.js';

/**
 * Baseline: what `typeorm-transactional` actually does.
 *
 * This file must not import from `src/` — both libraries patch
 * `Repository.prototype.manager`, and whichever installs last wins. Vitest runs
 * each file in its own worker, so the sibling suite gets a clean process.
 */

let dataSource: DataSource;

const api: TransactionalApi = {
  label: 'typeorm-transactional',
  Propagation: Propagation,
  wrap: ((fn: (...args: never[]) => unknown, propagation: string) =>
    wrapInTransaction(fn, {
      propagation: propagation as Propagation,
    })) as TransactionalApi['wrap'],
  runInTransaction: <T>(fn: () => Promise<T>) => runInTransaction(fn),
};

beforeAll(async () => {
  initializeTransactionalContext({ storageDriver: StorageDriver.ASYNC_LOCAL_STORAGE });
  dataSource = createFixtureDataSource();
  await dataSource.initialize();
  addTransactionalDataSource(dataSource);
});

afterAll(async () => {
  deleteDataSourceByName('default');
  if (dataSource?.isInitialized) await dataSource.destroy();
});

describe('typeorm-transactional baseline', () => {
  for (const scenario of SCENARIOS) {
    const expected = EXPECTED_SHARED[scenario.name] ?? EXPECTED_NESTED_TYPEORM_TRANSACTIONAL;

    it(scenario.name, async () => {
      const outcome = await runScenario(scenario, {
        api,
        dataSource,
        writeNote: makeWriteNote(dataSource),
      });

      expect(outcome).toEqual(expected);
    });
  }

  it('gives NESTED an independent transaction rather than a savepoint', async () => {
    const scenario = SCENARIOS.find((s) => s.name === NESTED_SCENARIO);
    expect(scenario).toBeDefined();

    const outcome = await runScenario(scenario!, {
      api,
      dataSource,
      writeNote: makeWriteNote(dataSource),
    });

    // Documents the upstream behaviour we deliberately depart from. If this ever
    // starts matching ours, the deviation note in MIGRATION.md is obsolete.
    expect(outcome).toEqual(EXPECTED_NESTED_TYPEORM_TRANSACTIONAL);
    expect(outcome.notes).toContain('inner');
  });
});
