import { DEFAULT_RETRYABLE_SQLSTATES } from '../dialects/postgres.js';
import { warn, warnOnce } from '../diagnostics.js';
import { RetriesExhaustedError, TransactionTimeoutError } from '../errors/index.js';
import { DEFAULT_BACKOFF, computeBackoff, sleep, type BackoffConfig } from './backoff.js';
import { extractSqlState, isRetryable, isUnsafeToRetry } from './classifier.js';

export interface RetryConfig {
  /** Defaults to true when a `retry` object is supplied at all. */
  enabled?: boolean;
  /** Total attempts, including the first. Defaults to 3, matching Spring Retry. */
  maxAttempts?: number;
  /** SQLSTATEs to retry. Defaults to `DEFAULT_RETRYABLE_SQLSTATES`. */
  retryOn?: readonly string[];
  backoff?: BackoffConfig;
}

/** What `onRetry` and `onExhausted` receive. */
export interface RetryInfo {
  /** The attempt that just failed, 1-based. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly sqlstate: string | undefined;
  /** Milliseconds until the next attempt. Zero when giving up. */
  readonly delayMs: number;
  /** Decorated method name, when known. */
  readonly method: string | undefined;
  /** Wall-clock milliseconds since the first attempt began. */
  readonly elapsedMs: number;
  readonly error: unknown;
  readonly dataSourceName: string;
}

export const DEFAULT_MAX_ATTEMPTS = 3;

/** A retry policy with every default already applied. */
export interface ResolvedRetry {
  readonly maxAttempts: number;
  readonly retryOn: readonly string[];
  readonly backoff: BackoffConfig;
}

/**
 * Applies defaults, or returns `undefined` when retry is off.
 *
 * `undefined` and `false` both mean off; supplying an object turns it on.
 */
export function resolveRetry(retry: RetryConfig | false | undefined): ResolvedRetry | undefined {
  if (retry === undefined || retry === false) return undefined;
  if (retry.enabled === false) return undefined;

  const retryOn = retry.retryOn ?? DEFAULT_RETRYABLE_SQLSTATES;

  for (const sqlstate of retryOn) {
    if (!isUnsafeToRetry(sqlstate)) continue;

    warnOnce(
      'retry-unsafe-sqlstate',
      `retryOn includes ${sqlstate}, a connection-class error. If the connection drops ` +
        'during COMMIT the commit state is unknown, so retrying may apply the transaction ' +
        'twice. Only opt in for transactions you know are idempotent — see docs/safety.md.',
    );
  }

  return {
    maxAttempts: Math.max(1, Math.floor(retry.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)),
    retryOn,
    backoff: retry.backoff ?? DEFAULT_BACKOFF,
  };
}

export interface RetryExecutionOptions extends ResolvedRetry {
  /** Wall-clock budget across *all* attempts, not per attempt. */
  readonly timeoutMs: number | undefined;
  readonly onRetry: ((info: RetryInfo) => void) | undefined;
  readonly onExhausted: ((info: RetryInfo) => void) | undefined;
  readonly method: string | undefined;
  readonly dataSourceName: string;
}

/**
 * Observability must never be able to break the thing it observes. A metrics
 * backend going down should not turn a recoverable conflict into a failure.
 */
function notify(
  callback: ((info: RetryInfo) => void) | undefined,
  info: RetryInfo,
  which: string,
): void {
  if (callback === undefined) return;

  try {
    callback(info);
  } catch (error) {
    warn('retry-callback-failed', `${which} callback threw and was ignored: ${String(error)}`);
  }
}

/**
 * Runs `attempt`, retrying transient database failures.
 *
 * `attempt` is expected to open a brand-new transaction each time it is called —
 * reusing a rolled-back query runner would carry aborted-transaction state into
 * the retry. The whole callback re-runs, not just the commit, because PostgreSQL
 * raises `40001` at `COMMIT`, by which point every statement has already
 * "succeeded". That is also why per-statement retry cannot work.
 *
 * Shape follows the pseudocode in the build spec §5.4.
 */
export async function runWithRetry<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  options: RetryExecutionOptions,
): Promise<T> {
  const { maxAttempts, retryOn, backoff, timeoutMs, method, dataSourceName } = options;

  const startedAt = Date.now();
  const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : startedAt + timeoutMs;

  let attemptNumber = 0;

  for (;;) {
    attemptNumber += 1;

    try {
      return await attempt(attemptNumber);
    } catch (error) {
      // An unrecognised error would fail identically every time; retrying it just
      // multiplies the damage and hides the cause.
      if (!isRetryable(error, retryOn)) throw error;

      const sqlstate = extractSqlState(error);
      const elapsedMs = Date.now() - startedAt;

      const info = (delayMs: number): RetryInfo => ({
        attempt: attemptNumber,
        maxAttempts,
        sqlstate,
        delayMs,
        method,
        elapsedMs,
        error,
        dataSourceName,
      });

      if (attemptNumber >= maxAttempts) {
        notify(options.onExhausted, info(0), 'onExhausted');
        throw new RetriesExhaustedError(error, attemptNumber, sqlstate, elapsedMs, method);
      }

      const delayMs = computeBackoff(attemptNumber, backoff);

      // Checked *before* sleeping: overshooting the caller's budget and then
      // reporting it is worse than stopping now.
      if (Date.now() + delayMs > deadline) {
        notify(options.onExhausted, info(delayMs), 'onExhausted');
        throw new TransactionTimeoutError(
          error,
          attemptNumber,
          sqlstate,
          elapsedMs,
          timeoutMs ?? 0,
          method,
        );
      }

      notify(options.onRetry, info(delayMs), 'onRetry');

      await sleep(delayMs);
    }
  }
}
