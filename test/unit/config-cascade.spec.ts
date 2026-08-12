import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

import {
  DEFAULT_RETRYABLE_SQLSTATES,
  IsolationLevel,
  addResilientDataSource,
  clearResilientDataSources,
  getTransactionContext,
  initializeResilientContext,
  resetResilientDefaults,
  resolveRetryConfig,
  runInResilientTransaction,
  setResilientDefaults,
} from '../../src/index.js';
import { resetDiagnostics, setDiagnosticHandler } from '../../src/core/diagnostics.js';

/**
 * `@Transactional()` → `forRoot()` → library defaults, with `retry` deep-merged.
 *
 * The merge matters more than it looks: setting `retry: { maxAttempts: 5 }` on one
 * method must not silently discard a `retryOn` list configured application-wide,
 * or that method quietly stops retrying the codes everything else does.
 */

function serializationFailure(): Error & { code: string } {
  return Object.assign(new Error('could not serialize access'), { code: '40001' });
}

function harness(failures: (Error | undefined)[]) {
  const runners: QueryRunner[] = [];
  let attempt = 0;

  const dataSource = {
    manager: { tag: 'root' } as unknown as EntityManager,
    createQueryRunner: () => {
      const runner = {
        isTransactionActive: true,
        manager: { tag: 'tx' } as unknown as EntityManager,
        connect: () => Promise.resolve({} as never),
        startTransaction: () => Promise.resolve(),
        commitTransaction: () => {
          const failure = failures[attempt];
          attempt += 1;
          return failure === undefined ? Promise.resolve() : Promise.reject(failure);
        },
        rollbackTransaction: () => Promise.resolve(),
        release: () => Promise.resolve(),
      } as unknown as QueryRunner;

      runners.push(runner);
      return runner;
    },
  } as unknown as DataSource;

  addResilientDataSource({ dataSource, patch: false });
  return { runners };
}

const noWait = { strategy: 'fixed', baseMs: 0, capMs: 0 } as const;

beforeEach(() => {
  initializeResilientContext();
  setDiagnosticHandler(() => undefined);
});

afterEach(() => {
  clearResilientDataSources();
  resetResilientDefaults();
  resetDiagnostics();
});

describe('resolveRetryConfig', () => {
  it('returns the global policy when the call says nothing', () => {
    expect(resolveRetryConfig(undefined, { maxAttempts: 4 })).toEqual({ maxAttempts: 4 });
  });

  it('returns the local policy when there is no global one', () => {
    expect(resolveRetryConfig({ maxAttempts: 2 }, undefined)).toEqual({ maxAttempts: 2 });
  });

  it('lets the call override individual fields while keeping the rest', () => {
    const merged = resolveRetryConfig({ maxAttempts: 9 }, { maxAttempts: 3, retryOn: ['40001'] });
    expect(merged).toEqual({ maxAttempts: 9, retryOn: ['40001'] });
  });

  it('deep-merges backoff rather than replacing it', () => {
    const merged = resolveRetryConfig(
      { backoff: { baseMs: 5 } },
      { backoff: { strategy: 'fixed', baseMs: 100, capMs: 900 } },
    );

    expect(merged).toMatchObject({
      backoff: { strategy: 'fixed', baseMs: 5, capMs: 900 },
    });
  });

  it('keeps the global backoff when the call sets other retry fields', () => {
    const merged = resolveRetryConfig(
      { maxAttempts: 7 },
      { backoff: { strategy: 'linear', baseMs: 10 } },
    );

    expect(merged).toMatchObject({
      maxAttempts: 7,
      backoff: { strategy: 'linear', baseMs: 10 },
    });
  });

  it('treats a local false as an explicit opt-out that beats the global policy', () => {
    expect(resolveRetryConfig(false, { maxAttempts: 5 })).toBe(false);
  });

  it('lets one method opt in even when retry is globally off', () => {
    expect(resolveRetryConfig({ maxAttempts: 2 }, false)).toEqual({ maxAttempts: 2 });
  });

  it('stays off when neither level asks for retry', () => {
    expect(resolveRetryConfig(undefined, undefined)).toBeUndefined();
    expect(resolveRetryConfig(undefined, false)).toBe(false);
  });
});

describe('isolation cascade', () => {
  it('uses the library default — none — when nothing is configured', async () => {
    harness([]);
    await runInResilientTransaction(() => {
      expect(getTransactionContext()?.isolation).toBeUndefined();
      return Promise.resolve();
    });
  });

  it('applies the module default', async () => {
    setResilientDefaults({ defaultIsolation: IsolationLevel.SERIALIZABLE });
    harness([]);

    await runInResilientTransaction(() => {
      expect(getTransactionContext()?.isolation).toBe(IsolationLevel.SERIALIZABLE);
      return Promise.resolve();
    });
  });

  it('lets the call override the module default', async () => {
    setResilientDefaults({ defaultIsolation: IsolationLevel.SERIALIZABLE });
    harness([]);

    await runInResilientTransaction(
      () => {
        expect(getTransactionContext()?.isolation).toBe(IsolationLevel.READ_COMMITTED);
        return Promise.resolve();
      },
      { isolation: IsolationLevel.READ_COMMITTED },
    );
  });

  it('honours the isolationLevel spelling over the module default too', async () => {
    setResilientDefaults({ defaultIsolation: IsolationLevel.READ_COMMITTED });
    harness([]);

    await runInResilientTransaction(
      () => {
        expect(getTransactionContext()?.isolation).toBe(IsolationLevel.SERIALIZABLE);
        return Promise.resolve();
      },
      { isolationLevel: IsolationLevel.SERIALIZABLE },
    );
  });
});

describe('retry cascade end to end', () => {
  it('does not retry when neither level configures it', async () => {
    const { runners } = harness([serializationFailure()]);

    await expect(runInResilientTransaction(() => Promise.resolve('x'))).rejects.toThrow(
      'could not serialize access',
    );
    expect(runners).toHaveLength(1);
  });

  it('retries using the module default when the call says nothing', async () => {
    setResilientDefaults({ retry: { maxAttempts: 3, backoff: noWait } });
    const { runners } = harness([serializationFailure(), serializationFailure()]);

    await expect(runInResilientTransaction(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(runners).toHaveLength(3);
  });

  it('lets the call raise maxAttempts above the module default', async () => {
    setResilientDefaults({ retry: { maxAttempts: 2, backoff: noWait } });
    const { runners } = harness(Array.from({ length: 3 }, serializationFailure));

    await expect(
      runInResilientTransaction(() => Promise.resolve('ok'), { retry: { maxAttempts: 4 } }),
    ).resolves.toBe('ok');
    expect(runners).toHaveLength(4);
  });

  it('keeps the module retryOn when the call only changes maxAttempts', async () => {
    // Globally opted into a code that is unsafe by default; the method below
    // changes only maxAttempts and must not lose that opt-in.
    setResilientDefaults({
      retry: { retryOn: ['08006'], backoff: noWait },
    });
    const { runners } = harness([Object.assign(new Error('connection lost'), { code: '08006' })]);

    await expect(
      runInResilientTransaction(() => Promise.resolve('ok'), { retry: { maxAttempts: 3 } }),
    ).resolves.toBe('ok');
    expect(runners).toHaveLength(2);
  });

  it('lets the call disable retry that is on globally', async () => {
    setResilientDefaults({ retry: { maxAttempts: 5, backoff: noWait } });
    const { runners } = harness([serializationFailure()]);

    await expect(
      runInResilientTransaction(() => Promise.resolve('x'), { retry: false }),
    ).rejects.toThrow('could not serialize access');
    expect(runners).toHaveLength(1);
  });

  it('lets the call enable retry that is off globally', async () => {
    setResilientDefaults({ retry: false });
    const { runners } = harness([serializationFailure()]);

    await expect(
      runInResilientTransaction(() => Promise.resolve('ok'), {
        retry: { maxAttempts: 3, backoff: noWait },
      }),
    ).resolves.toBe('ok');
    expect(runners).toHaveLength(2);
  });

  it('falls back to the library default of three attempts', async () => {
    setResilientDefaults({ retry: { backoff: noWait } });
    const { runners } = harness(Array.from({ length: 5 }, serializationFailure));

    await runInResilientTransaction(() => Promise.resolve('x')).catch(() => undefined);
    expect(runners).toHaveLength(3);
  });

  it('uses DEFAULT_RETRYABLE_SQLSTATES when no retryOn is configured anywhere', async () => {
    setResilientDefaults({ retry: { backoff: noWait } });
    const { runners } = harness([Object.assign(new Error('deadlock'), { code: '40P01' })]);

    expect(DEFAULT_RETRYABLE_SQLSTATES).toContain('40P01');
    await expect(runInResilientTransaction(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(runners).toHaveLength(2);
  });
});

describe('timeout cascade', () => {
  it('applies the module budget when the call omits one', async () => {
    setResilientDefaults({
      timeoutMs: 40,
      retry: { maxAttempts: 100, backoff: { strategy: 'fixed', baseMs: 10_000, capMs: 10_000 } },
    });
    harness(Array.from({ length: 5 }, serializationFailure));

    await expect(runInResilientTransaction(() => Promise.resolve('x'))).rejects.toThrow(
      /exceeded its 40ms budget/,
    );
  });

  it('lets the call override the module budget', async () => {
    setResilientDefaults({
      timeoutMs: 40,
      retry: { maxAttempts: 100, backoff: { strategy: 'fixed', baseMs: 10_000, capMs: 10_000 } },
    });
    harness(Array.from({ length: 5 }, serializationFailure));

    await expect(
      runInResilientTransaction(() => Promise.resolve('x'), { timeoutMs: 75 }),
    ).rejects.toThrow(/exceeded its 75ms budget/);
  });
});
