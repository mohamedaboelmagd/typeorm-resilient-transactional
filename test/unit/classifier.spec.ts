import { describe, expect, it } from 'vitest';

import { extractSqlState, isRetryable, isUnsafeToRetry } from '../../src/core/retry/classifier.js';
import { DEFAULT_RETRYABLE_SQLSTATES } from '../../src/core/dialects/postgres.js';

/**
 * The SQLSTATE lives somewhere different for every driver and every layer of
 * wrapping. Getting this wrong means the retry engine silently never fires — the
 * worst failure mode this library has, because everything looks fine until
 * production contention.
 *
 * The shapes below are pinned by `test/integration/error-shapes.spec.ts` against
 * a real PostgreSQL; the rest cover drivers we cannot exercise here.
 */

describe('extractSqlState', () => {
  it('reads a bare `code`, the shape node-postgres throws', () => {
    expect(extractSqlState({ code: '40001' })).toBe('40001');
  });

  it('reads `driverError.code`, the shape TypeORM wraps it in', () => {
    // Verified against a real deadlock in error-shapes.spec.ts.
    expect(extractSqlState({ driverError: { code: '40P01' } })).toBe('40P01');
  });

  it('reads `originalError.code`, used by older TypeORM drivers', () => {
    expect(extractSqlState({ originalError: { code: '55P03' } })).toBe('55P03');
  });

  it('reads `sqlState`, which mysql2 populates', () => {
    expect(extractSqlState({ sqlState: '40001' })).toBe('40001');
  });

  it('unwraps a `cause` chain', () => {
    expect(extractSqlState({ cause: { cause: { code: '40001' } } })).toBe('40001');
  });

  it('prefers the outermost SQLSTATE when several are present', () => {
    expect(extractSqlState({ code: '40001', driverError: { code: '40P01' } })).toBe('40001');
  });

  it('skips a non-SQLSTATE `code` and keeps looking', () => {
    // Node throws `code: 'ECONNREFUSED'`, and TypeORM sometimes wraps a driver
    // error inside an error that carries its own unrelated code.
    expect(extractSqlState({ code: 'ECONNREFUSED', driverError: { code: '40001' } })).toBe('40001');
  });

  it('accepts the letter-bearing codes PostgreSQL actually uses', () => {
    expect(extractSqlState({ code: '40P01' })).toBe('40P01');
    expect(extractSqlState({ code: '55P03' })).toBe('55P03');
  });

  it('normalises a numeric code to a string', () => {
    expect(extractSqlState({ code: 40001 })).toBe('40001');
  });

  describe('returns undefined for things that carry no SQLSTATE', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a string', 'boom'],
      ['a number', 42],
      ['a plain Error', new Error('boom')],
      ['an empty object', {}],
      ['a non-SQLSTATE code', { code: 'ECONNREFUSED' }],
      ['a too-short code', { code: '4001' }],
      ['a too-long code', { code: '400012' }],
    ])('%s', (_label, input) => {
      expect(extractSqlState(input)).toBeUndefined();
    });
  });

  it('survives a self-referencing error chain', () => {
    // A cyclic `cause` must not hang the retry path.
    const error: Record<string, unknown> = { message: 'looping' };
    error['cause'] = error;

    expect(() => extractSqlState(error)).not.toThrow();
    expect(extractSqlState(error)).toBeUndefined();
  });
});

describe('isRetryable', () => {
  it('accepts the default PostgreSQL set', () => {
    expect(isRetryable({ code: '40001' }, DEFAULT_RETRYABLE_SQLSTATES)).toBe(true);
    expect(isRetryable({ code: '40P01' }, DEFAULT_RETRYABLE_SQLSTATES)).toBe(true);
    expect(isRetryable({ code: '55P03' }, DEFAULT_RETRYABLE_SQLSTATES)).toBe(true);
  });

  it('rejects errors with no SQLSTATE at all', () => {
    expect(isRetryable(new Error('application bug'), DEFAULT_RETRYABLE_SQLSTATES)).toBe(false);
  });

  it('rejects a SQLSTATE outside the configured set', () => {
    // 23505 unique_violation — retrying will fail identically forever.
    expect(isRetryable({ code: '23505' }, DEFAULT_RETRYABLE_SQLSTATES)).toBe(false);
  });

  it('does not retry connection errors under the defaults', () => {
    for (const code of ['08000', '08001', '08003', '08004', '08006']) {
      expect(isRetryable({ code }, DEFAULT_RETRYABLE_SQLSTATES)).toBe(false);
    }
  });

  it('does not retry query_canceled under the defaults', () => {
    expect(isRetryable({ code: '57014' }, DEFAULT_RETRYABLE_SQLSTATES)).toBe(false);
  });

  it('honours an explicit opt-in set', () => {
    expect(isRetryable({ code: '57014' }, ['57014'])).toBe(true);
  });

  it('retries nothing when given an empty set', () => {
    expect(isRetryable({ code: '40001' }, [])).toBe(false);
  });
});

describe('isUnsafeToRetry', () => {
  // Surfacing this lets the engine warn loudly when someone opts into a code
  // whose commit state cannot be known. @see docs/adr/0005-no-connection-error-retry.md
  it('flags connection-class errors', () => {
    expect(isUnsafeToRetry('08006')).toBe(true);
    expect(isUnsafeToRetry('08003')).toBe(true);
  });

  it('does not flag the normal retryable codes', () => {
    expect(isUnsafeToRetry('40001')).toBe(false);
    expect(isUnsafeToRetry('40P01')).toBe(false);
  });
});
