import { afterEach, describe, expect, it, vi } from 'vitest';

import { HookRegistry } from '../../src/core/hooks/registry.js';
import { resetDiagnostics, setDiagnosticHandler } from '../../src/core/diagnostics.js';
import type { RetryInfo } from '../../src/core/retry/engine.js';

/**
 * The registry in isolation. Its behaviour under real transactions is covered by
 * `test/integration/hooks.spec.ts`; these pin the guarantees that a database
 * cannot be made to violate on demand.
 */

const info: RetryInfo = {
  attempt: 1,
  maxAttempts: 3,
  sqlstate: '40001',
  delayMs: 0,
  method: 'someMethod',
  elapsedMs: 0,
  error: new Error('conflict'),
  dataSourceName: 'default',
};

afterEach(() => {
  resetDiagnostics();
  vi.restoreAllMocks();
});

describe('commit hooks run at most once', () => {
  it('ignores a second runCommit on the same registry', async () => {
    const registry = new HookRegistry();
    const effect = vi.fn();
    registry.addCommit(effect);

    await registry.runCommit();
    await registry.runCommit();

    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('runs complete hooks with no error, also once', async () => {
    const registry = new HookRegistry();
    const complete = vi.fn();
    registry.addComplete(complete);

    await registry.runCommit();
    await registry.runCommit();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(undefined);
  });
});

describe('failing hooks are contained', () => {
  it('logs and continues past a throwing commit hook', async () => {
    const codes: string[] = [];
    setDiagnosticHandler((event) => codes.push(event.code));

    const registry = new HookRegistry();
    const after = vi.fn();

    registry.addCommit(() => {
      throw new Error('email down');
    });
    registry.addCommit(after);

    await expect(registry.runCommit()).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledTimes(1);
    expect(codes).toContain('hook-failed');
  });

  it('logs and continues past a rejecting async hook', async () => {
    const registry = new HookRegistry();
    const after = vi.fn();

    registry.addCommit(() => Promise.reject(new Error('async failure')));
    registry.addCommit(after);

    await registry.runCommit();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('logs and continues past a throwing rollback hook', async () => {
    const registry = new HookRegistry();
    const after = vi.fn();

    registry.addRollback(() => {
      throw new Error('boom');
    });
    registry.addRollback(after);

    await registry.runRollback(new Error('cause'));
    expect(after).toHaveBeenCalledTimes(1);
  });

  // runRetry is synchronous on purpose: it fires between attempts, on the hot path.
  it('logs and continues past a throwing retry hook', () => {
    const codes: string[] = [];
    setDiagnosticHandler((event) => codes.push(event.code));

    const registry = new HookRegistry();
    const after = vi.fn();

    registry.addRetry(() => {
      throw new Error('metrics down');
    });
    registry.addRetry(after);

    expect(() => registry.runRetry(info)).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(codes).toContain('hook-failed');
  });

  /**
   * `RetryHook` returns `void`, but TypeScript accepts an `async` function there
   * without complaint — so `runOnRetry(async () => metrics.push(info))` compiles
   * cleanly. Its rejection is not a throw, so the `try/catch` above misses it,
   * and an unhandled rejection terminates the process on Node 15+. That would let
   * a metrics backend outage kill a transaction mid-retry, which is the opposite
   * of what an observability hook is for. Commit hooks are already awaited; this
   * closes the same hole on the one path that cannot afford to wait.
   */
  it('swallows a rejected promise from an async retry hook', async () => {
    const codes: string[] = [];
    setDiagnosticHandler((event) => codes.push(event.code));

    const registry = new HookRegistry();
    const after = vi.fn();

    // Deliberately the mistake a consumer makes. `tsc --strict` accepts this
    // silently; only the type-aware ESLint rule below objects, and plenty of
    // projects do not run it.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    registry.addRetry(() => Promise.reject(new Error('metrics down')));
    registry.addRetry(after);

    expect(() => registry.runRetry(info)).not.toThrow();

    // The rejection lands a microtask later; an escaped one fails the run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(after, 'a slow hook must not block the ones after it').toHaveBeenCalledTimes(1);
    expect(codes).toContain('hook-failed');
  });

  it('does not wait for an async retry hook to settle', () => {
    const registry = new HookRegistry();
    let settled = false;

    registry.addRetry(
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            settled = true;
            resolve(undefined);
          }, 50);
        }),
    );

    registry.runRetry(info);

    // Retry latency must not depend on how fast someone's telemetry pipeline is.
    expect(settled).toBe(false);
  });
});

describe('rollback hooks receive the cause', () => {
  it('passes the error through, and to complete hooks too', async () => {
    const registry = new HookRegistry();
    const cause = new Error('the cause');
    const seen: unknown[] = [];

    registry.addRollback((error) => void seen.push(error));
    registry.addComplete((error) => void seen.push(error));

    await registry.runRollback(cause);

    expect(seen).toEqual([cause, cause]);
  });
});

describe('savepoint marks', () => {
  it('discards only what was registered after the mark', async () => {
    const registry = new HookRegistry();
    const before = vi.fn();
    const after = vi.fn();

    registry.addCommit(before);
    const mark = registry.mark();
    registry.addCommit(after);

    registry.rollbackTo(mark);
    await registry.runCommit();

    expect(before).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
  });

  it('discards every kind of hook', async () => {
    const registry = new HookRegistry();
    const commit = vi.fn();
    const rollback = vi.fn();
    const complete = vi.fn();
    const retry = vi.fn();

    const mark = registry.mark();
    registry.addCommit(commit);
    registry.addRollback(rollback);
    registry.addComplete(complete);
    registry.addRetry(retry);

    registry.rollbackTo(mark);

    registry.runRetry(info);
    await registry.runRollback(new Error('x'));

    expect(commit).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('is a no-op on an untouched registry', async () => {
    const registry = new HookRegistry();
    const mark = registry.mark();
    registry.rollbackTo(mark);

    await expect(registry.runCommit()).resolves.toBeUndefined();
  });
});

describe('an empty registry', () => {
  it('completes both paths without complaint', async () => {
    await expect(new HookRegistry().runCommit()).resolves.toBeUndefined();
    await expect(new HookRegistry().runRollback(new Error('x'))).resolves.toBeUndefined();
    expect(() => new HookRegistry().runRetry(info)).not.toThrow();
  });
});
