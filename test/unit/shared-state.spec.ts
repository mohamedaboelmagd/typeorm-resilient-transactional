import { afterEach, describe, expect, it } from 'vitest';

import { resetSharedState, sharedState } from '../../src/core/shared-state.js';

/**
 * These cover the mechanism. The *reason* it exists — duplicate module copies
 * under CommonJS — cannot be reproduced inside this repository, because Vitest
 * resolves `src/` through a single module graph. `scripts/verify-package.mjs`
 * covers that, against the packed tarball.
 *
 * @see docs/adr/0008-globally-shared-singletons.md
 */

afterEach(() => {
  resetSharedState();
});

describe('sharedState', () => {
  it('creates a value once and returns the same instance after', () => {
    let created = 0;
    const make = () => {
      created += 1;
      return new Map<string, number>();
    };

    const first = sharedState('thing', make);
    const second = sharedState('thing', make);

    expect(second).toBe(first);
    expect(created).toBe(1);
  });

  it('keeps different keys independent', () => {
    expect(sharedState('a', () => ({ v: 1 }))).not.toBe(sharedState('b', () => ({ v: 1 })));
  });

  it('is reachable from any module holding the same symbol', () => {
    sharedState('registry', () => new Map([['x', 1]]));

    // What a second bundled copy of this module would do on first access.
    const bag = (globalThis as unknown as Record<symbol, Record<string, unknown>>)[
      Symbol.for('typeorm-resilient-transactional.state.v1')
    ];

    expect(bag?.['registry']).toBeInstanceOf(Map);
    expect((bag?.['registry'] as Map<string, number>).get('x')).toBe(1);
  });

  it('shares mutations through a boxed value', () => {
    // The reason flags and defaults live in an object rather than as bare
    // module variables: a second copy has to observe the change.
    const box = sharedState('flags', () => ({ initialized: false }));
    box.initialized = true;

    expect(sharedState('flags', () => ({ initialized: false })).initialized).toBe(true);
  });

  it('preserves a falsy value instead of recreating it', () => {
    let created = 0;
    const make = () => {
      created += 1;
      return 0;
    };

    expect(sharedState('zero', make)).toBe(0);
    expect(sharedState('zero', make)).toBe(0);
    expect(created).toBe(1);
  });

  it('is cleared by the test seam', () => {
    sharedState('temp', () => ({ v: 1 }));
    resetSharedState();

    let created = 0;
    sharedState('temp', () => {
      created += 1;
      return { v: 2 };
    });

    expect(created).toBe(1);
  });
});
