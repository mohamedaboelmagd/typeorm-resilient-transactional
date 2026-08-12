import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  emitDiagnostic,
  resetDiagnostics,
  setDiagnosticHandler,
  warn,
  warnOnce,
} from '../../src/core/diagnostics.js';

afterEach(() => {
  resetDiagnostics();
  vi.restoreAllMocks();
});

describe('diagnostic routing', () => {
  it('sends warnings to a custom handler', () => {
    const handler = vi.fn();
    setDiagnosticHandler(handler);

    warn('some-code', 'something happened');

    expect(handler).toHaveBeenCalledWith({
      level: 'warn',
      code: 'some-code',
      message: 'something happened',
    });
  });

  it('falls back to console.warn when no handler is set', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    warn('fallback', 'to console');

    expect(spy).toHaveBeenCalledWith('[typeorm-resilient-transactional] to console');
  });

  it('stays silent for debug events on the default handler', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    emitDiagnostic({ level: 'debug', code: 'quiet', message: 'not shown' });

    expect(spy).not.toHaveBeenCalled();
  });

  it('restores the default handler when passed undefined', () => {
    const handler = vi.fn();
    setDiagnosticHandler(handler);
    setDiagnosticHandler(undefined);

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    warn('restored', 'back to default');

    expect(handler).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
  });
});

/**
 * The handler is what reports every other failure, so it is the one callback that
 * must not be able to create one. Users are pointed at a NestJS `Logger` or pino,
 * and `setDiagnosticHandler(async (e) => log.send(e))` is an easy thing to write —
 * `DiagnosticHandler` returns `void`, and TypeScript accepts an async function
 * there without complaint.
 *
 * Nothing is reported when it fails: telling the user would mean calling the
 * handler that just failed.
 */
describe('a handler that fails cannot break the caller', () => {
  it('contains a handler that throws', () => {
    setDiagnosticHandler(() => {
      throw new Error('log pipeline down');
    });

    expect(() => warn('some-code', 'something happened')).not.toThrow();
  });

  it('contains a handler that rejects', async () => {
    setDiagnosticHandler(
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      () => Promise.reject(new Error('log pipeline down')),
    );

    expect(() => warn('some-code', 'something happened')).not.toThrow();

    // An escaped rejection fails this file on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('keeps working after a handler failed', () => {
    let calls = 0;
    setDiagnosticHandler(() => {
      calls += 1;
      throw new Error('still down');
    });

    warn('first', 'one');
    warn('second', 'two');

    expect(calls, 'a failure must not disable diagnostics').toBe(2);
  });
});

describe('warnOnce', () => {
  // Patch-degradation notices are emitted from hot paths. Repeating them per call
  // site would bury the one message that matters.
  it('emits a given code only once', () => {
    const handler = vi.fn();
    setDiagnosticHandler(handler);

    warnOnce('dup', 'first');
    warnOnce('dup', 'second');
    warnOnce('dup', 'third');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ message: 'first' });
  });

  it('tracks codes independently', () => {
    const handler = vi.fn();
    setDiagnosticHandler(handler);

    warnOnce('a', 'first');
    warnOnce('b', 'second');

    expect(handler).toHaveBeenCalledTimes(2);
  });
});
