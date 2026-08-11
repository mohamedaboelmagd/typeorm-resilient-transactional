import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

import {
  IsolationLevel,
  TELEMETRY_ATTRIBUTES,
  addResilientDataSource,
  annotateActiveSpan,
  clearResilientDataSources,
  initializeResilientContext,
  resetOtel,
  resetResilientDefaults,
  runInResilientTransaction,
  setOtelApi,
  setResilientDefaults,
  type RetryInfo,
  type RetryMetrics,
} from '../../src/index.js';
import { resetDiagnostics, setDiagnosticHandler } from '../../src/core/diagnostics.js';

function serializationFailure(): Error & { code: string } {
  return Object.assign(new Error('could not serialize access'), { code: '40001' });
}

function harness(failures: (Error | undefined)[]) {
  let attempt = 0;

  const dataSource = {
    manager: { tag: 'root' } as unknown as EntityManager,
    createQueryRunner: () =>
      ({
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
      }) as unknown as QueryRunner,
  } as unknown as DataSource;

  addResilientDataSource({ dataSource, patch: false });
}

const noWait = { strategy: 'fixed', baseMs: 0, capMs: 0 } as const;

/** A span that records what was set on it. */
function fakeSpan(options: { recording?: boolean; throwOnSet?: boolean } = {}) {
  const attributes: Record<string, unknown> = {};

  const span = {
    isRecording: () => options.recording ?? true,
    setAttribute: (key: string, value: unknown) => {
      if (options.throwOnSet === true) throw new Error('tracer exploded');
      attributes[key] = value;
    },
  };

  return { span, attributes };
}

beforeEach(() => {
  initializeResilientContext();
  setDiagnosticHandler(() => undefined);
});

afterEach(() => {
  clearResilientDataSources();
  resetResilientDefaults();
  resetDiagnostics();
  resetOtel();
  vi.restoreAllMocks();
});

describe('OpenTelemetry, when it is absent', () => {
  it('annotating is a silent no-op', () => {
    setOtelApi(undefined);
    expect(() => annotateActiveSpan({ 'db.transaction.attempt': 2 })).not.toThrow();
  });

  it('transactions run normally with no tracer at all', async () => {
    setOtelApi(undefined);
    harness([serializationFailure()]);

    await expect(
      runInResilientTransaction(() => Promise.resolve('ok'), {
        retry: { maxAttempts: 3, backoff: noWait },
      }),
    ).resolves.toBe('ok');
  });
});

describe('OpenTelemetry, when it is present', () => {
  it('annotates the active span on retry', async () => {
    const { span, attributes } = fakeSpan();
    setOtelApi({ trace: { getActiveSpan: () => span } });

    harness([serializationFailure()]);

    await runInResilientTransaction(() => Promise.resolve('ok'), {
      isolation: IsolationLevel.SERIALIZABLE,
      retry: { maxAttempts: 3, backoff: noWait },
    });

    expect(attributes[TELEMETRY_ATTRIBUTES.retryReason]).toBe('40001');
    expect(attributes[TELEMETRY_ATTRIBUTES.isolation]).toBe('SERIALIZABLE');
    expect(attributes[TELEMETRY_ATTRIBUTES.attempt]).toBe(2);
  });

  it('records the outcome on commit', async () => {
    const { span, attributes } = fakeSpan();
    setOtelApi({ trace: { getActiveSpan: () => span } });
    harness([]);

    await runInResilientTransaction(() => Promise.resolve('ok'));

    expect(attributes[TELEMETRY_ATTRIBUTES.outcome]).toBe('commit');
    expect(attributes[TELEMETRY_ATTRIBUTES.attempt]).toBe(1);
  });

  it('records the outcome on rollback', async () => {
    const { span, attributes } = fakeSpan();
    setOtelApi({ trace: { getActiveSpan: () => span } });
    harness([]);

    await runInResilientTransaction(() => Promise.reject(new Error('boom'))).catch(() => undefined);

    expect(attributes[TELEMETRY_ATTRIBUTES.outcome]).toBe('rollback');
  });

  it('skips a span that is not recording', () => {
    const { span, attributes } = fakeSpan({ recording: false });
    setOtelApi({ trace: { getActiveSpan: () => span } });

    annotateActiveSpan({ 'db.transaction.attempt': 3 });

    expect(attributes).toEqual({});
  });

  it('survives a tracer that throws', async () => {
    const { span } = fakeSpan({ throwOnSet: true });
    setOtelApi({ trace: { getActiveSpan: () => span } });
    harness([]);

    // A broken tracer must not cost a database write.
    await expect(runInResilientTransaction(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('does nothing when no span is active', () => {
    setOtelApi({ trace: { getActiveSpan: () => undefined } });
    expect(() => annotateActiveSpan({ 'db.transaction.attempt': 1 })).not.toThrow();
  });

  it('can be turned off entirely', async () => {
    const { span, attributes } = fakeSpan();
    setOtelApi({ trace: { getActiveSpan: () => span } });
    setResilientDefaults({ telemetry: false });
    harness([]);

    await runInResilientTransaction(() => Promise.resolve('ok'));

    expect(attributes).toEqual({});
  });
});

describe('metrics', () => {
  it('records retries, commits, and the attempt count', async () => {
    const retries: RetryInfo[] = [];
    const commits: { attempts: number }[] = [];

    const metrics: RetryMetrics = {
      recordRetry: (info) => retries.push(info),
      recordCommit: (outcome) => commits.push(outcome),
    };

    setResilientDefaults({ metrics });
    harness([serializationFailure(), serializationFailure()]);

    await runInResilientTransaction(() => Promise.resolve('ok'), {
      retry: { maxAttempts: 5, backoff: noWait },
      name: 'transfer',
    });

    expect(retries).toHaveLength(2);
    expect(retries[0]?.sqlstate).toBe('40001');
    expect(commits).toHaveLength(1);
    expect(commits[0]?.attempts).toBe(3);
  });

  it('records a rollback with the SQLSTATE that caused it', async () => {
    const rollbacks: { sqlstate: string | undefined; attempts: number }[] = [];

    setResilientDefaults({ metrics: { recordRollback: (o) => rollbacks.push(o) } });
    harness([serializationFailure()]);

    await runInResilientTransaction(() => Promise.resolve('x')).catch(() => undefined);

    expect(rollbacks).toHaveLength(1);
    expect(rollbacks[0]?.sqlstate).toBe('40001');
    expect(rollbacks[0]?.attempts).toBe(1);
  });

  it('records exhaustion once', async () => {
    const exhausted = vi.fn();
    setResilientDefaults({ metrics: { recordExhausted: exhausted } });
    harness(Array.from({ length: 5 }, serializationFailure));

    await runInResilientTransaction(() => Promise.resolve('x'), {
      retry: { maxAttempts: 2, backoff: noWait },
    }).catch(() => undefined);

    expect(exhausted).toHaveBeenCalledTimes(1);
  });

  it('reports attempts as 1 for a transaction that never retried', async () => {
    const commits: { attempts: number; durationMs: number }[] = [];
    setResilientDefaults({ metrics: { recordCommit: (o) => commits.push(o) } });
    harness([]);

    await runInResilientTransaction(() => Promise.resolve('ok'));

    expect(commits[0]?.attempts).toBe(1);
    expect(commits[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('a broken observer cannot break a transaction', () => {
  it.each([
    [
      'metrics.recordRetry',
      {
        recordRetry: () => {
          throw new Error('down');
        },
      },
    ],
    [
      'metrics.recordCommit',
      {
        recordCommit: () => {
          throw new Error('down');
        },
      },
    ],
  ])('%s throwing is logged and ignored', async (_label, metrics) => {
    setResilientDefaults({ metrics });
    harness([serializationFailure()]);

    await expect(
      runInResilientTransaction(() => Promise.resolve('ok'), {
        retry: { maxAttempts: 3, backoff: noWait },
      }),
    ).resolves.toBe('ok');
  });

  it('a throwing global onRetry is ignored', async () => {
    setResilientDefaults({
      onRetry: () => {
        throw new Error('metrics backend down');
      },
    });
    harness([serializationFailure()]);

    await expect(
      runInResilientTransaction(() => Promise.resolve('ok'), {
        retry: { maxAttempts: 3, backoff: noWait },
      }),
    ).resolves.toBe('ok');
  });

  it('reports the failure through diagnostics', async () => {
    const codes: string[] = [];
    setDiagnosticHandler((event) => codes.push(event.code));

    setResilientDefaults({
      onCommit: () => {
        throw new Error('down');
      },
    });
    harness([]);

    await runInResilientTransaction(() => Promise.resolve('ok'));

    expect(codes).toContain('observer-failed');
  });
});

describe('both local and global callbacks fire', () => {
  it('calls the per-transaction and application-wide onRetry', async () => {
    const seen: string[] = [];

    setResilientDefaults({ onRetry: () => seen.push('global') });
    harness([serializationFailure()]);

    await runInResilientTransaction(() => Promise.resolve('ok'), {
      retry: { maxAttempts: 3, backoff: noWait },
      onRetry: () => seen.push('local'),
    });

    expect(seen).toEqual(['local', 'global']);
  });
});
