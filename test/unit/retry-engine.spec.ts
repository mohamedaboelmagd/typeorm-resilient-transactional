import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

import {
  Propagation,
  RetriesExhaustedError,
  RetryNotPermittedError,
  TransactionTimeoutError,
  addResilientDataSource,
  clearResilientDataSources,
  currentAttempt,
  initializeResilientContext,
  runInResilientTransaction,
  type RetryInfo,
} from '../../src/index.js';
import { resetDiagnostics, setDiagnosticHandler } from '../../src/core/diagnostics.js';

/**
 * The retry loop, driven through a fake query runner.
 *
 * Real conflicts are proven against PostgreSQL in
 * `test/integration/retry.spec.ts`; these tests pin the control flow — attempt
 * counting, error selection, budget arithmetic — which a real database cannot be
 * made to reproduce on demand.
 */

/** SQLSTATE 40001, in the shape TypeORM actually produces (verified in error-shapes.spec.ts). */
function serializationFailure(): Error & { code: string } {
  return Object.assign(new Error('could not serialize access'), { code: '40001' });
}

function deadlock(): Error & { code: string } {
  return Object.assign(new Error('deadlock detected'), { code: '40P01' });
}

interface Harness {
  dataSource: DataSource;
  /** One entry per query runner created — proves each attempt got a fresh one. */
  runners: QueryRunner[];
  commits: number;
  rollbacks: number;
}

/** A data source whose first `failures` attempts reject at commit time. */
function harness(failures: (Error | undefined)[]): Harness {
  const state: Harness = {
    runners: [],
    commits: 0,
    rollbacks: 0,
    dataSource: undefined as unknown as DataSource,
  };

  let attempt = 0;

  state.dataSource = {
    manager: { tag: 'root' } as unknown as EntityManager,
    createQueryRunner: () => {
      const index = attempt;
      const runner = {
        isTransactionActive: true,
        manager: { tag: `tx-${index}` } as unknown as EntityManager,
        connect: () => Promise.resolve({} as never),
        startTransaction: () => Promise.resolve(),
        commitTransaction: () => {
          const failure = failures[attempt];
          attempt += 1;
          if (failure !== undefined) return Promise.reject(failure);
          state.commits += 1;
          return Promise.resolve();
        },
        rollbackTransaction: () => {
          state.rollbacks += 1;
          return Promise.resolve();
        },
        release: () => Promise.resolve(),
      } as unknown as QueryRunner;

      state.runners.push(runner);
      return runner;
    },
  } as unknown as DataSource;

  addResilientDataSource({ dataSource: state.dataSource, patch: false });
  return state;
}

/** No real waiting — the backoff maths is covered by backoff.spec.ts. */
const noWait = { strategy: 'fixed', baseMs: 0, capMs: 0 } as const;

beforeEach(() => {
  initializeResilientContext();
  setDiagnosticHandler(() => undefined);
});

afterEach(() => {
  clearResilientDataSources();
  resetDiagnostics();
  vi.restoreAllMocks();
});

describe('when retry is not configured', () => {
  it('makes a single attempt and rethrows the original error', async () => {
    const h = harness([serializationFailure()]);

    await expect(runInResilientTransaction(() => Promise.resolve('x'))).rejects.toThrow(
      'could not serialize access',
    );

    expect(h.runners).toHaveLength(1);
  });
});

describe('retrying a retryable failure', () => {
  it('succeeds on a later attempt and returns its value', async () => {
    const h = harness([serializationFailure(), deadlock()]);

    const result = await runInResilientTransaction(() => Promise.resolve('ok'), {
      retry: { maxAttempts: 5, backoff: noWait },
    });

    expect(result).toBe('ok');
    expect(h.runners).toHaveLength(3);
    expect(h.commits).toBe(1);
  });

  it('gives every attempt a fresh query runner', async () => {
    // Reusing a runner after a rollback would carry aborted-transaction state
    // into the retry.
    const h = harness([serializationFailure(), serializationFailure()]);

    await runInResilientTransaction(() => Promise.resolve('ok'), {
      retry: { maxAttempts: 5, backoff: noWait },
    });

    expect(new Set(h.runners).size).toBe(3);
  });

  it('rolls back every failed attempt', async () => {
    const h = harness([serializationFailure(), serializationFailure()]);

    await runInResilientTransaction(() => Promise.resolve('ok'), {
      retry: { maxAttempts: 5, backoff: noWait },
    });

    expect(h.rollbacks).toBe(2);
  });

  it('exposes a 1-based attempt number to the callback', async () => {
    harness([serializationFailure(), serializationFailure()]);
    const seen: number[] = [];

    await runInResilientTransaction(
      () => {
        seen.push(currentAttempt());
        return Promise.resolve('ok');
      },
      { retry: { maxAttempts: 5, backoff: noWait } },
    );

    expect(seen).toEqual([1, 2, 3]);
  });

  it('re-runs the whole callback, not just the commit', async () => {
    harness([serializationFailure()]);
    const body = vi.fn(() => Promise.resolve('ok'));

    await runInResilientTransaction(body, { retry: { maxAttempts: 3, backoff: noWait } });

    expect(body).toHaveBeenCalledTimes(2);
  });
});

describe('errors that are not retryable', () => {
  it('does not retry an application error', async () => {
    const h = harness([]);

    await expect(
      runInResilientTransaction(() => Promise.reject(new Error('business rule violated')), {
        retry: { maxAttempts: 5, backoff: noWait },
      }),
    ).rejects.toThrow('business rule violated');

    expect(h.runners).toHaveLength(1);
  });

  it('does not retry a connection error under the defaults', async () => {
    const h = harness([Object.assign(new Error('connection lost'), { code: '08006' })]);

    await expect(
      runInResilientTransaction(() => Promise.resolve('x'), {
        retry: { maxAttempts: 5, backoff: noWait },
      }),
    ).rejects.toThrow('connection lost');

    expect(h.runners).toHaveLength(1);
  });

  it('retries a connection error when explicitly opted in', async () => {
    const h = harness([Object.assign(new Error('connection lost'), { code: '08006' })]);

    await runInResilientTransaction(() => Promise.resolve('ok'), {
      retry: { maxAttempts: 3, retryOn: ['08006'], backoff: noWait },
    });

    expect(h.runners).toHaveLength(2);
  });

  it('warns once when an unsafe SQLSTATE is opted into', async () => {
    const codes: string[] = [];
    setDiagnosticHandler((event) => codes.push(event.code));
    harness([Object.assign(new Error('connection lost'), { code: '08006' })]);

    await runInResilientTransaction(() => Promise.resolve('ok'), {
      retry: { maxAttempts: 3, retryOn: ['08006'], backoff: noWait },
    });

    expect(codes).toContain('retry-unsafe-sqlstate');
  });
});

describe('exhaustion', () => {
  it('throws RetriesExhaustedError preserving the original error', async () => {
    const original = serializationFailure();
    harness([original, original, original]);

    const error = await runInResilientTransaction(() => Promise.resolve('x'), {
      retry: { maxAttempts: 3, backoff: noWait },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RetriesExhaustedError);
    const exhausted = error as RetriesExhaustedError;
    expect(exhausted.cause).toBe(original);
    expect(exhausted.attempts).toBe(3);
    expect(exhausted.sqlstate).toBe('40001');
  });

  it('makes exactly maxAttempts attempts', async () => {
    const h = harness([serializationFailure(), serializationFailure(), serializationFailure()]);

    await runInResilientTransaction(() => Promise.resolve('x'), {
      retry: { maxAttempts: 3, backoff: noWait },
    }).catch(() => undefined);

    expect(h.runners).toHaveLength(3);
  });

  it('defaults to 3 attempts, matching Spring', async () => {
    const h = harness(Array.from({ length: 10 }, serializationFailure));

    await runInResilientTransaction(() => Promise.resolve('x'), {
      retry: { backoff: noWait },
    }).catch(() => undefined);

    expect(h.runners).toHaveLength(3);
  });
});

describe('the wall-clock budget', () => {
  it('throws TransactionTimeoutError when the next delay would overrun it', async () => {
    harness(Array.from({ length: 10 }, serializationFailure));

    const error = await runInResilientTransaction(() => Promise.resolve('x'), {
      retry: { maxAttempts: 100, backoff: { strategy: 'fixed', baseMs: 10_000, capMs: 10_000 } },
      timeoutMs: 50,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransactionTimeoutError);
    expect((error as TransactionTimeoutError).timeoutMs).toBe(50);
    expect((error as TransactionTimeoutError).cause).toMatchObject({ code: '40001' });
  });

  it('covers all attempts rather than each one', async () => {
    const h = harness(Array.from({ length: 10 }, serializationFailure));

    await runInResilientTransaction(() => Promise.resolve('x'), {
      retry: { maxAttempts: 100, backoff: { strategy: 'fixed', baseMs: 30, capMs: 30 } },
      timeoutMs: 100,
    }).catch(() => undefined);

    // 30ms per wait against a 100ms budget: a handful of attempts, not 100.
    expect(h.runners.length).toBeLessThan(10);
    expect(h.runners.length).toBeGreaterThan(1);
  });
});

describe('callbacks', () => {
  it('reports each retry with the SQLSTATE and attempt', async () => {
    harness([serializationFailure(), deadlock()]);
    const infos: RetryInfo[] = [];

    await runInResilientTransaction(() => Promise.resolve('ok'), {
      retry: { maxAttempts: 5, backoff: noWait },
      onRetry: (info) => infos.push(info),
      name: 'transfer',
    });

    expect(infos).toHaveLength(2);
    expect(infos[0]).toMatchObject({ attempt: 1, sqlstate: '40001', method: 'transfer' });
    expect(infos[1]).toMatchObject({ attempt: 2, sqlstate: '40P01', method: 'transfer' });
    expect(infos[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('fires onExhausted exactly once when giving up', async () => {
    harness([serializationFailure(), serializationFailure(), serializationFailure()]);
    const onExhausted = vi.fn();

    await runInResilientTransaction(() => Promise.resolve('x'), {
      retry: { maxAttempts: 3, backoff: noWait },
      onExhausted,
    }).catch(() => undefined);

    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted.mock.calls[0]?.[0]).toMatchObject({ attempt: 3, sqlstate: '40001' });
  });

  it('does not let a throwing callback break the retry loop', async () => {
    harness([serializationFailure()]);

    const result = await runInResilientTransaction(() => Promise.resolve('ok'), {
      retry: { maxAttempts: 3, backoff: noWait },
      onRetry: () => {
        throw new Error('metrics backend down');
      },
    });

    expect(result).toBe('ok');
  });
});

describe('only the owner may retry', () => {
  it('refuses retry on a joined REQUIRED method', async () => {
    harness([]);

    await expect(
      runInResilientTransaction(
        async () => {
          await runInResilientTransaction(() => Promise.resolve('inner'), {
            retry: { maxAttempts: 3 },
            name: 'innerMethod',
          });
        },
        { name: 'outerMethod' },
      ),
    ).rejects.toThrow(RetryNotPermittedError);
  });

  it('names the offending method so the fix is obvious', async () => {
    harness([]);

    await expect(
      runInResilientTransaction(async () => {
        await runInResilientTransaction(() => Promise.resolve('inner'), {
          retry: { maxAttempts: 3 },
          name: 'innerMethod',
        });
      }),
    ).rejects.toThrow(/innerMethod/);
  });

  it('refuses retry on NESTED, where it cannot help', async () => {
    harness([]);

    await expect(
      runInResilientTransaction(async () => {
        await runInResilientTransaction(() => Promise.resolve('inner'), {
          propagation: Propagation.NESTED,
          retry: { maxAttempts: 3 },
        });
      }),
    ).rejects.toThrow(RetryNotPermittedError);
  });

  it('allows retry on REQUIRES_NEW, which owns its transaction', async () => {
    // The inner transaction commits first, so its commit is the one that fails.
    harness([serializationFailure()]);

    await expect(
      runInResilientTransaction(async () => {
        await runInResilientTransaction(() => Promise.resolve('inner'), {
          propagation: Propagation.REQUIRES_NEW,
          retry: { maxAttempts: 3, backoff: noWait },
        });
      }),
    ).resolves.toBeUndefined();
  });

  it('permits an inner method to inherit retry it did not ask for', async () => {
    // Only an *explicit* inner retry is an error. Ambient defaults must not make
    // ordinary nesting throw.
    harness([]);

    await expect(
      runInResilientTransaction(
        async () => {
          await runInResilientTransaction(() => Promise.resolve('inner'));
        },
        { retry: { maxAttempts: 3, backoff: noWait } },
      ),
    ).resolves.toBeUndefined();
  });
});

describe('disabling retry explicitly', () => {
  it('accepts retry: false', async () => {
    const h = harness([serializationFailure()]);

    await expect(
      runInResilientTransaction(() => Promise.resolve('x'), { retry: false }),
    ).rejects.toThrow('could not serialize access');

    expect(h.runners).toHaveLength(1);
  });

  it('accepts retry: { enabled: false }', async () => {
    const h = harness([serializationFailure()]);

    await expect(
      runInResilientTransaction(() => Promise.resolve('x'), {
        retry: { enabled: false, maxAttempts: 5 },
      }),
    ).rejects.toThrow('could not serialize access');

    expect(h.runners).toHaveLength(1);
  });
});
