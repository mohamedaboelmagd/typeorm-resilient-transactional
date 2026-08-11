/**
 * OpenTelemetry annotation, when OpenTelemetry happens to be there.
 *
 * We do not create spans. Applications that care about tracing already have
 * instrumentation producing them; what they lack is any indication that a
 * transaction was retried, which turns an unexplained latency spike into an
 * obvious one. So we annotate whatever span is already active and otherwise stay
 * completely out of the way.
 *
 * `@opentelemetry/api` is an optional peer. When it is absent every function here
 * is a no-op — no throw, no warning, no cost beyond a null check.
 */

export type AttributeValue = string | number | boolean;

interface Span {
  setAttribute(key: string, value: AttributeValue): unknown;
  isRecording?(): boolean;
}

interface OtelApi {
  trace?: {
    getActiveSpan?: () => Span | undefined;
  };
}

let api: OtelApi | undefined;
let resolved = false;

/**
 * Supplies (or clears) the OpenTelemetry API explicitly.
 *
 * Useful when the auto-detection below has not finished, when several copies of
 * `@opentelemetry/api` are in play, and in tests.
 */
export function setOtelApi(next: OtelApi | undefined): void {
  api = next;
  resolved = true;
}

/**
 * Synchronous resolution, available in the CommonJS build.
 *
 * `typeof` on an undeclared identifier is safe, so this evaluates to `undefined`
 * in the ESM build rather than throwing.
 */
function requireSync(): OtelApi | undefined {
  try {
    if (typeof require !== 'function') return undefined;
    // Deliberate: this is the CommonJS resolution path for an optional peer, and
    // it must be synchronous to be useful. In the ESM build the bundler's shim
    // throws here and we fall through to the dynamic import below.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded: unknown = require('@opentelemetry/api');
    return loaded as OtelApi;
  } catch {
    return undefined;
  }
}

/**
 * Attempts to load the optional peer exactly once.
 *
 * Dynamic so a missing module is a caught rejection rather than a load-time crash
 * for the many users who will never install it.
 *
 * The synchronous attempt runs first because the async one resolves a tick later,
 * and a transaction starting in that window would go un-annotated. CommonJS
 * consumers are therefore covered immediately; the ESM build falls back to the
 * dynamic import, which settles long before any real workload begins.
 */
async function resolveApi(): Promise<void> {
  if (resolved) return;

  const sync = requireSync();
  if (sync !== undefined) {
    api = sync;
    resolved = true;
    return;
  }

  resolved = true;

  try {
    api = await import('@opentelemetry/api');
  } catch {
    api = undefined;
  }
}

// Started at import time so the API is in place well before the first
// transaction. Failure is expected and handled; nothing awaits this.
void resolveApi();

/**
 * Resolves once the optional peer has been looked for.
 *
 * Only needed if you must annotate a span in the same tick the library was
 * imported — vanishingly rare in an application, occasionally useful in a test.
 */
export async function whenTelemetryReady(): Promise<void> {
  await resolveApi();
}

/** Test seam. */
export function resetOtel(): void {
  api = undefined;
  resolved = false;
}

export const TELEMETRY_ATTRIBUTES = {
  attempt: 'db.transaction.attempt',
  isolation: 'db.transaction.isolation',
  retryReason: 'db.transaction.retry_reason',
  propagation: 'db.transaction.propagation',
  outcome: 'db.transaction.outcome',
} as const;

/**
 * Adds attributes to the currently active span, if there is one.
 *
 * Silent when OpenTelemetry is absent, when no span is active, or when the span
 * is not recording.
 */
export function annotateActiveSpan(attributes: Record<string, AttributeValue | undefined>): void {
  const span = api?.trace?.getActiveSpan?.();
  if (span === undefined || span === null) return;

  // A non-recording span discards attributes anyway; skipping saves the work in
  // the sampled-out case, which is the common one under load.
  if (span.isRecording?.() === false) return;

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;

    try {
      span.setAttribute(key, value);
    } catch {
      // A broken tracer must never break a transaction.
      return;
    }
  }
}
