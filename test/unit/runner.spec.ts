import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

import {
  IsolationLevel,
  Propagation,
  addResilientDataSource,
  clearResilientDataSources,
  initializeResilientContext,
  runInResilientTransaction,
} from '../../src/index.js';
import { resetDiagnostics, setDiagnosticHandler } from '../../src/core/diagnostics.js';

/**
 * Failure paths that a real database will not reproduce on demand: a `ROLLBACK`
 * that itself fails, a `release()` that throws. Both are the difference between a
 * usable stack trace and a mystery, so they are driven through a fake query runner.
 */

class Boom extends Error {}

interface FakeRunner extends Partial<QueryRunner> {
  calls: string[];
}

function makeRunner(
  failures: { rollback?: boolean; release?: boolean; commit?: boolean } = {},
): FakeRunner {
  const calls: string[] = [];

  return {
    calls,
    isTransactionActive: true,
    manager: { tag: 'tx-manager' } as unknown as EntityManager,
    connect: async () => {
      calls.push('connect');
      await Promise.resolve();
      return {} as never;
    },
    startTransaction: async () => {
      calls.push('startTransaction');
      await Promise.resolve();
    },
    commitTransaction: async () => {
      calls.push('commitTransaction');
      await Promise.resolve();
      if (failures.commit === true) throw new Error('commit exploded');
    },
    rollbackTransaction: async () => {
      calls.push('rollbackTransaction');
      await Promise.resolve();
      if (failures.rollback === true) throw new Error('rollback exploded');
    },
    release: async () => {
      calls.push('release');
      await Promise.resolve();
      if (failures.release === true) throw new Error('release exploded');
    },
  };
}

function register(runner: FakeRunner): DataSource {
  const dataSource = {
    manager: { tag: 'root' } as unknown as EntityManager,
    createQueryRunner: () => runner as unknown as QueryRunner,
  } as unknown as DataSource;

  addResilientDataSource({ dataSource, patch: false });
  return dataSource;
}

const warnings: string[] = [];

beforeEach(() => {
  initializeResilientContext();
  warnings.length = 0;
  setDiagnosticHandler((event) => warnings.push(event.code));
});

afterEach(() => {
  clearResilientDataSources();
  resetDiagnostics();
  vi.restoreAllMocks();
});

describe('lifecycle ordering', () => {
  it('connects, starts, commits, and releases on success', async () => {
    const runner = makeRunner();
    register(runner);

    await runInResilientTransaction(() => Promise.resolve('ok'));

    expect(runner.calls).toEqual(['connect', 'startTransaction', 'commitTransaction', 'release']);
  });

  it('rolls back and releases on failure', async () => {
    const runner = makeRunner();
    register(runner);

    await expect(runInResilientTransaction(() => Promise.reject(new Boom('x')))).rejects.toThrow(
      Boom,
    );

    expect(runner.calls).toEqual(['connect', 'startTransaction', 'rollbackTransaction', 'release']);
  });

  it('passes the query runner manager to the callback', async () => {
    const runner = makeRunner();
    register(runner);

    const seen = await runInResilientTransaction((manager) => Promise.resolve(manager));

    expect(seen).toBe(runner.manager);
  });
});

describe('a failing rollback never masks the original error', () => {
  it('propagates the callback error, not the rollback error', async () => {
    const runner = makeRunner({ rollback: true });
    register(runner);

    // The whole point: the caller needs the error that caused the rollback, and a
    // secondary rollback failure must not overwrite it.
    await expect(
      runInResilientTransaction(() => Promise.reject(new Boom('the real cause'))),
    ).rejects.toThrow('the real cause');

    expect(warnings).toContain('rollback-failed');
  });

  it('still releases the query runner', async () => {
    const runner = makeRunner({ rollback: true });
    register(runner);

    await expect(runInResilientTransaction(() => Promise.reject(new Boom('x')))).rejects.toThrow(
      Boom,
    );

    expect(runner.calls).toContain('release');
  });
});

describe('a failing release never masks anything', () => {
  it('lets a successful result through', async () => {
    const runner = makeRunner({ release: true });
    register(runner);

    await expect(runInResilientTransaction(() => Promise.resolve('result'))).resolves.toBe(
      'result',
    );

    expect(warnings).toContain('release-failed');
  });

  it('lets the original error through', async () => {
    const runner = makeRunner({ release: true });
    register(runner);

    await expect(
      runInResilientTransaction(() => Promise.reject(new Boom('the real cause'))),
    ).rejects.toThrow('the real cause');
  });
});

describe('a failing commit', () => {
  it('surfaces the commit error and rolls back', async () => {
    const runner = makeRunner({ commit: true });
    register(runner);

    await expect(runInResilientTransaction(() => Promise.resolve('ok'))).rejects.toThrow(
      'commit exploded',
    );

    expect(runner.calls).toEqual([
      'connect',
      'startTransaction',
      'commitTransaction',
      'rollbackTransaction',
      'release',
    ]);
  });
});

describe('NESTED isolation', () => {
  it('warns that a savepoint cannot change isolation', async () => {
    const runner = makeRunner();
    register(runner);

    await runInResilientTransaction(
      async () => {
        await runInResilientTransaction(() => Promise.resolve(), {
          propagation: Propagation.NESTED,
          isolation: IsolationLevel.READ_COMMITTED,
        });
      },
      { isolation: IsolationLevel.SERIALIZABLE },
    );

    expect(warnings).toContain('nested-isolation-ignored');
  });

  it('stays quiet when the savepoint asks for the isolation it already has', async () => {
    const runner = makeRunner();
    register(runner);

    await runInResilientTransaction(
      async () => {
        await runInResilientTransaction(() => Promise.resolve(), {
          propagation: Propagation.NESTED,
          isolation: IsolationLevel.SERIALIZABLE,
        });
      },
      { isolation: IsolationLevel.SERIALIZABLE },
    );

    expect(warnings).not.toContain('nested-isolation-ignored');
  });

  it('does not release the parent query runner when the savepoint ends', async () => {
    const runner = makeRunner();
    register(runner);

    await runInResilientTransaction(
      async () => {
        await runInResilientTransaction(() => Promise.resolve(), {
          propagation: Propagation.NESTED,
        });
        // One release only, and only after the owner finishes.
        expect(runner.calls.filter((c) => c === 'release')).toHaveLength(0);
      },
      { isolation: IsolationLevel.SERIALIZABLE },
    );

    expect(runner.calls.filter((c) => c === 'release')).toHaveLength(1);
  });
});
