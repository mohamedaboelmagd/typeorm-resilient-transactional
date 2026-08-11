import type { IsolationLevel } from './enums.js';
import type { RetryInfo } from './retry/engine.js';

/** How a transaction ended. */
export interface TransactionOutcome {
  readonly method: string | undefined;
  readonly dataSourceName: string;
  readonly isolation: IsolationLevel | undefined;
  /** Attempts made, including the one that succeeded. `1` means no retry. */
  readonly attempts: number;
  /** Wall-clock milliseconds across every attempt. */
  readonly durationMs: number;
}

export interface FailedTransactionOutcome extends TransactionOutcome {
  readonly error: unknown;
  readonly sqlstate: string | undefined;
}

/**
 * Somewhere to send retry telemetry.
 *
 * Deliberately an interface with no implementation and no dependency. Shipping a
 * `prom-client` adapter would drag a runtime dependency into a library that
 * advertises none, and would pick a metrics stack for you. Implement the two or
 * three methods your monitoring actually needs — every one is optional.
 *
 * ```ts
 * const metrics: RetryMetrics = {
 *   recordRetry: (info) => counter.inc({ sqlstate: info.sqlstate ?? 'unknown' }),
 *   recordExhausted: (info) => exhausted.inc({ method: info.method ?? 'unknown' }),
 * };
 * ```
 *
 * A worked Prometheus adapter lives in `examples/`, outside the published package.
 *
 * Every method is called inside a try/catch — a metrics backend going down must
 * not turn a recoverable conflict into a failed transaction.
 */
export interface RetryMetrics {
  /** A retryable failure occurred and another attempt is about to be made. */
  recordRetry?(info: RetryInfo): void;
  /** Retrying stopped without success — attempts or the time budget ran out. */
  recordExhausted?(info: RetryInfo): void;
  /** A transaction committed. `attempts > 1` means it took retries to get there. */
  recordCommit?(outcome: TransactionOutcome): void;
  /** A transaction was abandoned. */
  recordRollback?(outcome: FailedTransactionOutcome): void;
}
