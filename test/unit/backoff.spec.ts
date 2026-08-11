import { describe, expect, it } from 'vitest';

import { DEFAULT_BACKOFF, computeBackoff } from '../../src/core/retry/backoff.js';

/** Randomness is injected so jitter can be asserted rather than sampled. */
const always = (value: number) => () => value;

describe('defaults', () => {
  it('is full jitter with base 25ms and cap 500ms', () => {
    expect(DEFAULT_BACKOFF).toEqual({
      strategy: 'exponential-full-jitter',
      baseMs: 25,
      capMs: 500,
    });
  });
});

describe('fixed', () => {
  it('returns the base delay on every attempt', () => {
    const config = { strategy: 'fixed', baseMs: 50, capMs: 500 } as const;
    expect(computeBackoff(1, config)).toBe(50);
    expect(computeBackoff(5, config)).toBe(50);
  });

  it('never exceeds the cap', () => {
    expect(computeBackoff(1, { strategy: 'fixed', baseMs: 900, capMs: 500 })).toBe(500);
  });
});

describe('linear', () => {
  it('scales with the attempt number', () => {
    const config = { strategy: 'linear', baseMs: 10, capMs: 10_000 } as const;
    expect(computeBackoff(1, config)).toBe(10);
    expect(computeBackoff(2, config)).toBe(20);
    expect(computeBackoff(3, config)).toBe(30);
  });

  it('saturates at the cap', () => {
    expect(computeBackoff(100, { strategy: 'linear', baseMs: 10, capMs: 250 })).toBe(250);
  });
});

describe('exponential', () => {
  it('doubles each attempt, starting at the base', () => {
    const config = { strategy: 'exponential', baseMs: 25, capMs: 10_000 } as const;
    expect(computeBackoff(1, config)).toBe(25);
    expect(computeBackoff(2, config)).toBe(50);
    expect(computeBackoff(3, config)).toBe(100);
    expect(computeBackoff(4, config)).toBe(200);
  });

  it('saturates at the cap instead of overflowing', () => {
    const config = { strategy: 'exponential', baseMs: 25, capMs: 500 } as const;
    expect(computeBackoff(10, config)).toBe(500);
    // 2 ** 1000 is Infinity; the cap has to win before the arithmetic does.
    expect(computeBackoff(1000, config)).toBe(500);
  });
});

describe('exponential-full-jitter', () => {
  const config = { strategy: 'exponential-full-jitter', baseMs: 25, capMs: 500 } as const;

  // `Math.random()` yields [0, 1), so the delay spans [0, ceiling) and flooring
  // puts the maximum at ceiling - 1. That one millisecond is immaterial; what
  // matters is that the ceiling is never exceeded.
  it('picks uniformly from [0, ceiling) where ceiling is the exponential value', () => {
    expect(computeBackoff(1, config, always(0))).toBe(0);
    expect(computeBackoff(1, config, always(0.999999))).toBe(24); // ceiling 25
    expect(computeBackoff(3, config, always(0.5))).toBe(50); // ceiling 100
  });

  it('respects the cap as the ceiling', () => {
    expect(computeBackoff(20, config, always(0.999999))).toBe(499);
    expect(computeBackoff(20, config, always(0.999999))).toBeLessThanOrEqual(500);
  });

  it('can return zero, so a retry may fire immediately', () => {
    expect(computeBackoff(5, config, always(0))).toBe(0);
  });

  it('stays within bounds across many real samples', () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const ceiling = Math.min(500, 25 * 2 ** (attempt - 1));
      for (let i = 0; i < 200; i++) {
        const delay = computeBackoff(attempt, config);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });
});

describe('a custom function', () => {
  it('is used verbatim', () => {
    expect(computeBackoff(3, { strategy: (attempt) => attempt * 7 })).toBe(21);
  });

  it('is still bounded by the cap', () => {
    expect(computeBackoff(3, { strategy: () => 9_999, capMs: 100 })).toBe(100);
  });

  it('cannot return a negative delay', () => {
    expect(computeBackoff(1, { strategy: () => -50 })).toBe(0);
  });
});

/**
 * Why jitter is the default, demonstrated rather than asserted in prose.
 *
 * Two transactions that just deadlocked are synchronised by construction —
 * PostgreSQL killed one at the same instant it let the other proceed. If they
 * both back off by an identical amount they wake together and collide again.
 *
 * This is a simulation of the delay distribution, not a throughput benchmark;
 * the real contention numbers come from Phase 7.
 */
describe('jitter breaks the phase lock (simulation)', () => {
  const base = { baseMs: 25, capMs: 500 } as const;

  it('undithered exponential makes every pair collide', () => {
    let collisions = 0;
    for (let i = 0; i < 1_000; i++) {
      const a = computeBackoff(2, { ...base, strategy: 'exponential' });
      const b = computeBackoff(2, { ...base, strategy: 'exponential' });
      if (a === b) collisions++;
    }
    expect(collisions).toBe(1_000);
  });

  it('full jitter makes collisions rare', () => {
    let collisions = 0;
    for (let i = 0; i < 1_000; i++) {
      const a = computeBackoff(2, { ...base, strategy: 'exponential-full-jitter' });
      const b = computeBackoff(2, { ...base, strategy: 'exponential-full-jitter' });
      if (a === b) collisions++;
    }
    // Ceiling is 50ms at attempt 2, so ~51 integer slots — a handful of
    // coincidental ties is expected, universal collision is not.
    expect(collisions).toBeLessThan(100);
  });
});

describe('input hardening', () => {
  it('treats attempt 0 and negatives as the first attempt', () => {
    const config = { strategy: 'exponential', baseMs: 25, capMs: 500 } as const;
    expect(computeBackoff(0, config)).toBe(25);
    expect(computeBackoff(-3, config)).toBe(25);
  });

  it('returns whole milliseconds', () => {
    const delay = computeBackoff(3, { strategy: 'exponential-full-jitter', baseMs: 25 });
    expect(Number.isInteger(delay)).toBe(true);
  });
});
