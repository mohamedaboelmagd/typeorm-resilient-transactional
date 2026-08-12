import { describe, expect, it } from 'vitest';

import {
  DEADLOCK_DETECTED,
  DEFAULT_RETRYABLE_SQLSTATES,
  IsolationLevel,
  Propagation,
  SERIALIZATION_FAILURE,
  UNSAFE_TO_RETRY_SQLSTATES,
} from '../../src/index.js';

describe('public surface', () => {
  it('spells isolation levels the way PostgreSQL expects', () => {
    expect(IsolationLevel.SERIALIZABLE).toBe('SERIALIZABLE');
    expect(IsolationLevel.READ_COMMITTED).toBe('READ COMMITTED');
  });

  it('exposes every Spring-style propagation mode', () => {
    expect(Object.keys(Propagation)).toEqual([
      'REQUIRED',
      'REQUIRES_NEW',
      'SUPPORTS',
      'NOT_SUPPORTED',
      'MANDATORY',
      'NEVER',
      'NESTED',
    ]);
  });
});

describe('default retryable SQLSTATEs', () => {
  it('retries serialization failures and deadlocks', () => {
    expect(DEFAULT_RETRYABLE_SQLSTATES).toContain(SERIALIZATION_FAILURE);
    expect(DEFAULT_RETRYABLE_SQLSTATES).toContain(DEADLOCK_DETECTED);
  });

  // Retrying a connection error whose COMMIT outcome is unknown can double-apply
  // the transaction. This assertion is the guard against someone "helpfully"
  // widening the default set later.
  it('never retries connection errors by default', () => {
    for (const sqlstate of UNSAFE_TO_RETRY_SQLSTATES) {
      expect(DEFAULT_RETRYABLE_SQLSTATES).not.toContain(sqlstate);
    }
  });

  it('does not retry query_canceled by default, since it may be a statement_timeout', () => {
    expect(DEFAULT_RETRYABLE_SQLSTATES).not.toContain('57014');
  });
});
