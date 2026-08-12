import type { IsolationLevel } from './enums.js';
import type { FailedTransactionOutcome, RetryMetrics, TransactionOutcome } from './metrics.js';
import type { RetryConfig, RetryInfo } from './retry/engine.js';
import { sharedState } from './shared-state.js';

/**
 * Application-wide defaults, set once at bootstrap.
 *
 * Every field is overridable per `@Transactional()`. See {@link resolveRetryConfig}
 * for how the two are combined.
 */
export interface ResilientDefaults {
  /** Applied when a transaction does not name an isolation level. */
  defaultIsolation?: IsolationLevel;
  /** Default retry policy. `false` disables retry unless a call opts back in. */
  retry?: RetryConfig | false;
  /** Default wall-clock budget across all attempts. */
  timeoutMs?: number;

  onRetry?: (info: RetryInfo) => void;
  onExhausted?: (info: RetryInfo) => void;
  onCommit?: (outcome: TransactionOutcome) => void;
  onRollback?: (outcome: FailedTransactionOutcome) => void;

  metrics?: RetryMetrics;

  /**
   * Annotate the active OpenTelemetry span with transaction attributes.
   * Defaults to `true`, and is a no-op when `@opentelemetry/api` is absent.
   */
  telemetry?: boolean;
}

/**
 * Boxed and shared across duplicate module copies, so `forRoot()` imported from
 * `/nestjs` configures the same defaults that `@Transactional()` imported from the
 * package root reads. @see ./shared-state.ts
 */
const box = sharedState<{ defaults: ResilientDefaults }>('config', () => ({ defaults: {} }));

/** Replaces the application-wide defaults. Called by the NestJS module. */
export function setResilientDefaults(next: ResilientDefaults): void {
  box.defaults = { ...next };
}

export function getResilientDefaults(): ResilientDefaults {
  return box.defaults;
}

/** Test seam. */
export function resetResilientDefaults(): void {
  box.defaults = {};
}

/**
 * Combines a call's retry options with the application defaults.
 *
 * Precedence is `@Transactional()` → `forRoot()` → library defaults, and the two
 * retry objects are **deep-merged** rather than replaced: setting
 * `retry: { maxAttempts: 5 }` on one method must not silently discard the
 * `retryOn` list configured globally.
 *
 * `false` at either level is an explicit "off", and an explicit local `false`
 * beats a global policy — but a local object beats a global `false`, so a single
 * method can opt into retry in an application that does not use it by default.
 */
export function resolveRetryConfig(
  local: RetryConfig | false | undefined,
  global: RetryConfig | false | undefined,
): RetryConfig | false | undefined {
  if (local === false) return false;
  if (local === undefined) return global;
  if (global === undefined || global === false) return local;

  const merged: RetryConfig = { ...global, ...local };

  // Merged separately so `retry: { maxAttempts: 5 }` keeps a globally configured
  // `backoff` instead of resetting it to the library default.
  if (global.backoff !== undefined || local.backoff !== undefined) {
    merged.backoff = { ...global.backoff, ...local.backoff };
  }

  return merged;
}
