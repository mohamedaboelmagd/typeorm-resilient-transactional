export type BackoffStrategy =
  'fixed' | 'linear' | 'exponential' | 'exponential-full-jitter' | ((attempt: number) => number);

export interface BackoffConfig {
  strategy?: BackoffStrategy;
  /** Delay unit in milliseconds. */
  baseMs?: number;
  /** Upper bound applied to every strategy, including custom functions. */
  capMs?: number;
}

/**
 * Full jitter, base 25ms, cap 500ms.
 *
 * Jitter is on by default — Spring's `@Backoff(random)` defaults to off — because
 * of the specific failure this library retries. Two transactions that just
 * deadlocked are synchronised by construction: PostgreSQL killed one at the exact
 * moment it let the other proceed. Back both off by the same `base * 2^n` and
 * they wake together and deadlock again, with undithered exponential making each
 * successive collision more expensive rather than less. Randomising the delay is
 * what breaks the phase lock.
 *
 * @see https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */
export const DEFAULT_BACKOFF: Required<BackoffConfig> = {
  strategy: 'exponential-full-jitter',
  baseMs: 25,
  capMs: 500,
};

/**
 * `base * 2^(attempt-1)`, clamped before the arithmetic can overflow.
 *
 * `2 ** 1100` is `Infinity`, and `Infinity * 0` — which full jitter would do — is
 * `NaN`. Clamping first keeps a large attempt number from producing a delay of
 * `NaN` milliseconds, which `setTimeout` silently treats as zero.
 */
function exponentialCeiling(attempt: number, baseMs: number, capMs: number): number {
  const exponent = attempt - 1;

  // Past this the result exceeds any plausible cap anyway.
  if (exponent > 52) return capMs;

  return Math.min(capMs, baseMs * 2 ** exponent);
}

/**
 * Milliseconds to wait before `attempt` (1-based).
 *
 * `random` is injectable so jitter can be asserted in tests rather than sampled.
 */
export function computeBackoff(
  attempt: number,
  config?: BackoffConfig,
  random: () => number = Math.random,
): number {
  const strategy = config?.strategy ?? DEFAULT_BACKOFF.strategy;
  const baseMs = config?.baseMs ?? DEFAULT_BACKOFF.baseMs;
  const capMs = config?.capMs ?? DEFAULT_BACKOFF.capMs;

  const n = Math.max(1, Math.floor(attempt));

  const raw = ((): number => {
    if (typeof strategy === 'function') return strategy(n);

    switch (strategy) {
      case 'fixed':
        return baseMs;
      case 'linear':
        return baseMs * n;
      case 'exponential':
        return exponentialCeiling(n, baseMs, capMs);
      case 'exponential-full-jitter':
        return random() * exponentialCeiling(n, baseMs, capMs);
    }
  })();

  if (!Number.isFinite(raw)) return capMs;

  return Math.max(0, Math.min(capMs, Math.floor(raw)));
}

/** Cancellable sleep. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
