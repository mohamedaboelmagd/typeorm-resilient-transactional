import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';

import {
  IsolationLevel,
  NoActiveTransactionError,
  Propagation,
  addResilientDataSource,
  clearResilientDataSources,
  currentAttempt,
  initializeResilientContext,
  isInTransaction,
  runInResilientTransaction,
  runOnCommit,
  runOnComplete,
  runOnRetry,
  runOnRollback,
  runOnTransactionCommit,
  runOnTransactionComplete,
  runOnTransactionRollback,
  type RetryInfo,
} from '../../src/index.js';
import { resetDiagnostics, setDiagnosticHandler } from '../../src/core/diagnostics.js';
import { Note, createFixtureDataSource, noteIds, resetFixtures } from './harness/fixtures.js';
import { Barrier, assertBothSucceeded, race2 } from './harness/barrier.js';
import { setupWriteSkewFixture } from './harness/conflicts.js';

/**
 * The Phase 4 gate. Commit hooks are where every non-database side effect has to
 * live for retry to be safe, so "exactly once, only after a real commit, and
 * never from an attempt that failed" has to be true without qualification.
 */

let dataSource: DataSource;

class Boom extends Error {}

const fast = { strategy: 'exponential-full-jitter', baseMs: 1, capMs: 20 } as const;

/**
 * The retry budget for the tests below that need *both* sessions to finish.
 *
 * These assert hook semantics, not that five attempts is enough to win a
 * contention race — the loser can be aborted again on its retry while the
 * winner's COMMIT is still in flight, which on a loaded runner extends the
 * chain (see `retry.spec.ts` for the measurements). The budget is generous so a
 * busy runner cannot turn a semantics test into a coin flip.
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
  await resetFixtures(dataSource);
  await setupWriteSkewFixture(dataSource);
  setDiagnosticHandler(() => undefined);
});

describe('commit hooks', () => {
  it('run exactly once after a successful commit', async () => {
    const effect = vi.fn();

    await runInResilientTransaction(() => {
      runOnCommit(effect);
      return Promise.resolve();
    });

    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('do not run when the transaction rolls back', async () => {
    const effect = vi.fn();

    await expect(
      runInResilientTransaction(() => {
        runOnCommit(effect);
        return Promise.reject(new Boom('fail'));
      }),
    ).rejects.toThrow(Boom);

    expect(effect).not.toHaveBeenCalled();
  });

  it('run after the data is actually durable', async () => {
    let visibleAtHookTime: string[] = [];

    await runInResilientTransaction(async (manager) => {
      await manager.getRepository(Note).save({ id: 'a', body: 'a' });
      runOnCommit(async () => {
        visibleAtHookTime = await noteIds(dataSource);
      });
    });

    expect(visibleAtHookTime).toEqual(['a']);
  });

  it('run outside the transaction context', async () => {
    let inTransactionDuringHook = true;

    await runInResilientTransaction(() => {
      runOnCommit(() => {
        inTransactionDuringHook = isInTransaction();
      });
      return Promise.resolve();
    });

    // A hook that queries must reach a pooled connection, not the query runner
    // whose transaction just ended.
    expect(inTransactionDuringHook).toBe(false);
  });

  it('run in registration order', async () => {
    const order: number[] = [];

    await runInResilientTransaction(() => {
      runOnCommit(() => void order.push(1));
      runOnCommit(() => void order.push(2));
      runOnCommit(() => void order.push(3));
      return Promise.resolve();
    });

    expect(order).toEqual([1, 2, 3]);
  });

  it('await async hooks before the transaction call resolves', async () => {
    let finished = false;

    await runInResilientTransaction(() => {
      runOnCommit(async () => {
        await new Promise((r) => setTimeout(r, 10));
        finished = true;
      });
      return Promise.resolve();
    });

    expect(finished).toBe(true);
  });

  it('do not let one failing hook stop the others, or the caller', async () => {
    const second = vi.fn();

    const result = await runInResilientTransaction(() => {
      runOnCommit(() => {
        throw new Error('email service down');
      });
      runOnCommit(second);
      return Promise.resolve('committed');
    });

    // The transaction is durable; a notification failure cannot undo it, so it
    // must not become a caller-visible error either.
    expect(result).toBe('committed');
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('hooks and retry', () => {
  it('discards hooks registered during an attempt that failed', async () => {
    const barrier = new Barrier(2);
    const effects: string[] = [];

    const session = (doctorId: number) => () =>
      runInResilientTransaction(
        async (manager) => {
          // Captured at registration: commit hooks run outside the transaction
          // context, so currentAttempt() reads 0 by the time one fires.
          const attempt = currentAttempt();

          // Registered on every attempt. Only the surviving attempt's should fire.
          runOnCommit(() => void effects.push(`doctor-${doctorId}-attempt-${attempt}`));

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

    // Two sessions, two commit hooks — never three, even though one session ran
    // its body twice and registered a hook each time.
    expect(effects).toHaveLength(2);

    // And the survivor reports the attempt it actually committed on. Which
    // number that is depends on how many times the runner let it lose, so this
    // asserts the property — one session committed on a later attempt — rather
    // than pinning the count.
    const attempts = effects.map((e) => Number(e.slice(e.lastIndexOf('-') + 1)));
    expect(Math.max(...attempts)).toBeGreaterThanOrEqual(2);
  });

  it('fires retry hooks between attempts', async () => {
    const barrier = new Barrier(2);
    const seen: RetryInfo[] = [];

    const session = (doctorId: number) => () =>
      runInResilientTransaction(
        async (manager) => {
          runOnRetry((info) => seen.push(info));

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

    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]?.sqlstate).toBe('40001');
  });

  it('warns that the body re-ran, naming the method', async () => {
    const messages: string[] = [];
    setDiagnosticHandler((event) => messages.push(event.message));
    resetDiagnostics();
    setDiagnosticHandler((event) => messages.push(event.message));

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
        {
          isolation: IsolationLevel.SERIALIZABLE,
          retry: contended,
          name: 'takeOffCall',
        },
      );

    assertBothSucceeded(await race2(barrier, session(1), session(2)));

    const warning = messages.find((m) => m.includes('takeOffCall'));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/ran more than once/);
    expect(warning).toMatch(/docs\/safety\.md/);
  });
});

describe('rollback hooks', () => {
  it('run when the transaction is abandoned, receiving the error', async () => {
    let received: unknown;

    await expect(
      runInResilientTransaction(() => {
        runOnRollback((error) => void (received = error));
        return Promise.reject(new Boom('the cause'));
      }),
    ).rejects.toThrow(Boom);

    expect(received).toBeInstanceOf(Boom);
  });

  it('do not run on a successful commit', async () => {
    const onRollback = vi.fn();

    await runInResilientTransaction(() => {
      runOnRollback(onRollback);
      return Promise.resolve();
    });

    expect(onRollback).not.toHaveBeenCalled();
  });
});

describe('complete hooks', () => {
  it('run with no error after a commit', async () => {
    const seen: unknown[] = [];

    await runInResilientTransaction(() => {
      runOnComplete((error) => void seen.push(error));
      return Promise.resolve();
    });

    expect(seen).toEqual([undefined]);
  });

  it('run with the error after a rollback', async () => {
    const seen: unknown[] = [];

    await expect(
      runInResilientTransaction(() => {
        runOnComplete((error) => void seen.push(error));
        return Promise.reject(new Boom('x'));
      }),
    ).rejects.toThrow(Boom);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Boom);
  });
});

describe('hooks across propagation', () => {
  it('lets a joined method register a hook that fires on the outer commit', async () => {
    const effect = vi.fn();

    await runInResilientTransaction(async () => {
      await runInResilientTransaction(() => {
        runOnCommit(effect);
        return Promise.resolve();
      });

      // Still inside the outer transaction — nothing has committed yet.
      expect(effect).not.toHaveBeenCalled();
    });

    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('discards a savepoint’s hooks when the savepoint rolls back', async () => {
    const outer = vi.fn();
    const inner = vi.fn();

    await runInResilientTransaction(async () => {
      runOnCommit(outer);

      await expect(
        runInResilientTransaction(
          () => {
            runOnCommit(inner);
            return Promise.reject(new Boom('inner fails'));
          },
          { propagation: Propagation.NESTED },
        ),
      ).rejects.toThrow(Boom);
    });

    // The savepoint's work was undone, so its hook must not fire — even though
    // the enclosing transaction went on to commit.
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
  });

  it('keeps a savepoint’s hooks when the savepoint succeeds', async () => {
    const inner = vi.fn();

    await runInResilientTransaction(async () => {
      await runInResilientTransaction(
        () => {
          runOnCommit(inner);
          return Promise.resolve();
        },
        { propagation: Propagation.NESTED },
      );
    });

    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('lets REQUIRES_NEW fire its own hooks independently', async () => {
    const order: string[] = [];

    await runInResilientTransaction(async () => {
      runOnCommit(() => void order.push('outer'));

      await runInResilientTransaction(
        () => {
          runOnCommit(() => void order.push('inner'));
          return Promise.resolve();
        },
        { propagation: Propagation.REQUIRES_NEW },
      );
    });

    // The inner transaction committed first, so its hook ran first.
    expect(order).toEqual(['inner', 'outer']);
  });
});

describe('registering a hook outside a transaction', () => {
  it.each([
    ['runOnCommit', () => runOnCommit(() => undefined)],
    ['runOnRollback', () => runOnRollback(() => undefined)],
    ['runOnComplete', () => runOnComplete(() => undefined)],
    ['runOnRetry', () => runOnRetry(() => undefined)],
  ])('%s throws rather than silently doing nothing', (_name, register) => {
    expect(register).toThrow(NoActiveTransactionError);
  });
});

describe('typeorm-transactional aliases', () => {
  it('are the same functions', () => {
    expect(runOnTransactionCommit).toBe(runOnCommit);
    expect(runOnTransactionRollback).toBe(runOnRollback);
    expect(runOnTransactionComplete).toBe(runOnComplete);
  });

  it('work under their legacy names', async () => {
    const commit = vi.fn();
    const complete = vi.fn();

    await runInResilientTransaction(() => {
      runOnTransactionCommit(commit);
      runOnTransactionComplete(complete);
      return Promise.resolve();
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
