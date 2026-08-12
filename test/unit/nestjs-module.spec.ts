import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoggerService } from '@nestjs/common';

import {
  IsolationLevel,
  getResilientDefaults,
  isContextInitialized,
  resetResilientDefaults,
} from '../../src/index.js';
import {
  RESILIENT_TRANSACTIONAL_OPTIONS,
  ResilientTransactionalModule,
  useNestLogger,
} from '../../src/nestjs/index.js';
import { resetDiagnostics, warn } from '../../src/core/diagnostics.js';

function fakeLogger() {
  const calls: [string, string][] = [];
  const record = (level: string) => (message: unknown) => void calls.push([level, String(message)]);

  const logger: LoggerService = {
    log: record('log'),
    error: record('error'),
    warn: record('warn'),
    debug: record('debug'),
    verbose: record('verbose'),
  };

  return { logger, calls };
}

afterEach(() => {
  resetResilientDefaults();
  resetDiagnostics();
  vi.restoreAllMocks();
});

describe('forRoot', () => {
  it('installs the transactional context', () => {
    ResilientTransactionalModule.forRoot({ useNestLogger: false });
    // Must happen during module construction, not in a lifecycle hook:
    // repositories are built during dependency injection, and the
    // Repository.prototype patch has to be in place before that.
    expect(isContextInitialized()).toBe(true);
  });

  it('applies the defaults it was given', () => {
    ResilientTransactionalModule.forRoot({
      defaultIsolation: IsolationLevel.SERIALIZABLE,
      retry: { maxAttempts: 7 },
      timeoutMs: 1234,
      useNestLogger: false,
    });

    const defaults = getResilientDefaults();
    expect(defaults.defaultIsolation).toBe(IsolationLevel.SERIALIZABLE);
    expect(defaults.retry).toEqual({ maxAttempts: 7 });
    expect(defaults.timeoutMs).toBe(1234);
  });

  it('does not leak its own options into the defaults', () => {
    ResilientTransactionalModule.forRoot({ useNestLogger: false, logLevels: { warn: 'silent' } });

    const defaults = getResilientDefaults() as Record<string, unknown>;
    expect(defaults['useNestLogger']).toBeUndefined();
    expect(defaults['logLevels']).toBeUndefined();
    expect(defaults['logger']).toBeUndefined();
  });

  it('returns a dynamic module exposing its options', () => {
    const module = ResilientTransactionalModule.forRoot({ timeoutMs: 5, useNestLogger: false });

    expect(module.module).toBe(ResilientTransactionalModule);
    expect(module.exports).toContain(RESILIENT_TRANSACTIONAL_OPTIONS);
    expect(module.providers?.[0]).toMatchObject({ provide: RESILIENT_TRANSACTIONAL_OPTIONS });
  });

  it('works with no options at all', () => {
    expect(() => ResilientTransactionalModule.forRoot()).not.toThrow();
  });
});

describe('logger routing', () => {
  it('sends warnings to the NestJS logger instead of console', () => {
    const { logger, calls } = fakeLogger();
    ResilientTransactionalModule.forRoot({ logger, useNestLogger: true });

    warn('some-code', 'something happened');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('warn');
    // The stable code is included so handlers can filter without matching prose.
    expect(calls[0]?.[1]).toContain('[some-code]');
    expect(calls[0]?.[1]).toContain('something happened');
  });

  it('honours a configured level', () => {
    const { logger, calls } = fakeLogger();
    useNestLogger(logger, { warn: 'error' });

    warn('escalated', 'treat this as an error');

    expect(calls[0]?.[0]).toBe('error');
  });

  it('drops events set to silent', () => {
    const { logger, calls } = fakeLogger();
    useNestLogger(logger, { warn: 'silent' });

    warn('quiet', 'not shown');

    expect(calls).toHaveLength(0);
  });

  it('leaves diagnostics on console when routing is disabled', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { logger, calls } = fakeLogger();

    ResilientTransactionalModule.forRoot({ logger, useNestLogger: false });
    warn('unrouted', 'goes to console');

    expect(calls).toHaveLength(0);
    expect(spy).toHaveBeenCalled();
  });

  it('survives a logger that lacks the optional methods', () => {
    const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as LoggerService;
    useNestLogger(logger, { debug: 'debug' });

    // `debug` and `verbose` are optional on LoggerService.
    expect(() => warn('x', 'y')).not.toThrow();
  });
});
