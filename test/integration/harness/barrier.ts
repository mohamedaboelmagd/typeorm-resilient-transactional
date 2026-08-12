/**
 * Rendezvous point for coordinating concurrent database sessions.
 *
 * Conflict tests are only worth having if they are deterministic. Sleeping and
 * hoping two transactions interleave produces a suite that passes locally and
 * flakes in CI; a barrier makes the interleaving exact.
 */
interface Waiter {
  resolve: () => void;
  reject: (reason: Error) => void;
}

export class Barrier {
  private arrived = 0;
  private waiters: Waiter[] = [];
  private broken: Error | undefined;

  constructor(private readonly parties: number) {
    if (parties < 1) throw new Error('A barrier needs at least one party');
  }

  /**
   * Blocks until `parties` callers have arrived, then releases them together.
   *
   * A parked caller is rejected directly by `break()` rather than resolved and
   * left to re-check a flag — which also means no state has to survive the
   * `await`.
   */
  async arrive(): Promise<void> {
    if (this.broken !== undefined) throw this.broken;

    this.arrived += 1;

    if (this.arrived >= this.parties) {
      const waiting = this.waiters;
      this.waiters = [];
      this.arrived = 0;
      for (const waiter of waiting) waiter.resolve();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * Releases everyone with an error.
   *
   * Without this, one session failing early leaves the other awaiting a
   * rendezvous that will never happen, and the test times out instead of
   * reporting the real failure.
   */
  break(reason: Error): void {
    this.broken = reason;
    const waiting = this.waiters;
    this.waiters = [];
    for (const waiter of waiting) waiter.reject(reason);
  }
}

/**
 * Runs two sessions concurrently, breaking the barrier if either throws so a
 * failure surfaces as itself rather than as a timeout.
 */
export async function race2<A, B>(
  barrier: Barrier,
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      barrier.break(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  };

  return Promise.allSettled([guard(first), guard(second)]);
}

/** The error from a settled result, or undefined if it succeeded. */
export function reasonOf(result: PromiseSettledResult<unknown>): unknown {
  return result.status === 'rejected' ? result.reason : undefined;
}

/**
 * Rethrows the first rejection, for tests that only care about what the sessions
 * did rather than which one lost the race.
 *
 * `race2` settles instead of rejecting, which is what tests inspecting the loser
 * need — but a test that ignores the results turns "one session threw" into a
 * count mismatch three assertions later, destroying the evidence for why. Every
 * caller that does not read the results should pipe them through here.
 */
export function assertBothSucceeded(results: readonly PromiseSettledResult<unknown>[]): void {
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
}
