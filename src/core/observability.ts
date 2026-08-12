import { getResilientDefaults } from './config.js';
import { warn } from './diagnostics.js';
import type { IsolationLevel } from './enums.js';
import type { FailedTransactionOutcome, TransactionOutcome } from './metrics.js';
import { extractSqlState } from './retry/classifier.js';
import type { RetryInfo } from './retry/engine.js';
import { TELEMETRY_ATTRIBUTES, annotateActiveSpan } from './telemetry/otel.js';

/**
 * Fans one lifecycle event out to the per-call callback, the application-wide
 * callback, the metrics sink, and the active trace span.
 *
 * Every notification is isolated. Observability failing must never turn a
 * recoverable conflict into a failed transaction — a metrics backend going down
 * is not a reason to lose a database write.
 */

export interface ObservabilityContext {
  readonly method: string | undefined;
  readonly dataSourceName: string;
  readonly isolation: IsolationLevel | undefined;
  readonly startedAt: number;
}

function safely(label: string, fn: (() => void) | undefined): void {
  if (fn === undefined) return;

  try {
    fn();
  } catch (error) {
    warn('observer-failed', `${label} threw and was ignored: ${String(error)}`);
  }
}

function telemetryEnabled(): boolean {
  return getResilientDefaults().telemetry !== false;
}

export function notifyRetry(
  info: RetryInfo,
  local: ((info: RetryInfo) => void) | undefined,
  isolation: IsolationLevel | undefined,
): void {
  const defaults = getResilientDefaults();

  if (telemetryEnabled()) {
    // Annotating the span the application already has is what turns an
    // unexplained latency spike into an obviously-retried transaction.
    annotateActiveSpan({
      [TELEMETRY_ATTRIBUTES.attempt]: info.attempt,
      [TELEMETRY_ATTRIBUTES.isolation]: isolation,
      [TELEMETRY_ATTRIBUTES.retryReason]: info.sqlstate,
    });
  }

  safely('onRetry', local === undefined ? undefined : () => local(info));
  safely(
    'onRetry (global)',
    defaults.onRetry === undefined ? undefined : () => defaults.onRetry?.(info),
  );
  safely(
    'metrics.recordRetry',
    defaults.metrics?.recordRetry === undefined
      ? undefined
      : () => defaults.metrics?.recordRetry?.(info),
  );
}

export function notifyExhausted(
  info: RetryInfo,
  local: ((info: RetryInfo) => void) | undefined,
): void {
  const defaults = getResilientDefaults();

  safely('onExhausted', local === undefined ? undefined : () => local(info));
  safely(
    'onExhausted (global)',
    defaults.onExhausted === undefined ? undefined : () => defaults.onExhausted?.(info),
  );
  safely(
    'metrics.recordExhausted',
    defaults.metrics?.recordExhausted === undefined
      ? undefined
      : () => defaults.metrics?.recordExhausted?.(info),
  );
}

export function notifyCommit(ctx: ObservabilityContext, attempts: number): void {
  const defaults = getResilientDefaults();

  const outcome: TransactionOutcome = {
    method: ctx.method,
    dataSourceName: ctx.dataSourceName,
    isolation: ctx.isolation,
    attempts,
    durationMs: Date.now() - ctx.startedAt,
  };

  if (telemetryEnabled()) {
    annotateActiveSpan({
      [TELEMETRY_ATTRIBUTES.attempt]: attempts,
      [TELEMETRY_ATTRIBUTES.isolation]: ctx.isolation,
      [TELEMETRY_ATTRIBUTES.outcome]: 'commit',
    });
  }

  safely(
    'onCommit',
    defaults.onCommit === undefined ? undefined : () => defaults.onCommit?.(outcome),
  );
  safely(
    'metrics.recordCommit',
    defaults.metrics?.recordCommit === undefined
      ? undefined
      : () => defaults.metrics?.recordCommit?.(outcome),
  );
}

export function notifyRollback(ctx: ObservabilityContext, attempts: number, error: unknown): void {
  const defaults = getResilientDefaults();

  const outcome: FailedTransactionOutcome = {
    method: ctx.method,
    dataSourceName: ctx.dataSourceName,
    isolation: ctx.isolation,
    attempts,
    durationMs: Date.now() - ctx.startedAt,
    error,
    sqlstate: extractSqlState(error),
  };

  if (telemetryEnabled()) {
    annotateActiveSpan({
      [TELEMETRY_ATTRIBUTES.attempt]: attempts,
      [TELEMETRY_ATTRIBUTES.isolation]: ctx.isolation,
      [TELEMETRY_ATTRIBUTES.outcome]: 'rollback',
      [TELEMETRY_ATTRIBUTES.retryReason]: outcome.sqlstate,
    });
  }

  safely(
    'onRollback',
    defaults.onRollback === undefined ? undefined : () => defaults.onRollback?.(outcome),
  );
  safely(
    'metrics.recordRollback',
    defaults.metrics?.recordRollback === undefined
      ? undefined
      : () => defaults.metrics?.recordRollback?.(outcome),
  );
}
