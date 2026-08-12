export type DiagnosticLevel = 'warn' | 'debug';

export interface DiagnosticEvent {
  readonly level: DiagnosticLevel;
  readonly message: string;
  /** Stable identifier so handlers can filter without matching on prose. */
  readonly code: string;
}

export type DiagnosticHandler = (event: DiagnosticEvent) => void;

const defaultHandler: DiagnosticHandler = (event) => {
  if (event.level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(`[typeorm-resilient-transactional] ${event.message}`);
  }
};

let handler: DiagnosticHandler = defaultHandler;

/**
 * Routes library diagnostics somewhere other than `console.warn` — a NestJS
 * `Logger`, pino, a test spy. Phase 6 wires the NestJS adapter to this.
 */
export function setDiagnosticHandler(next: DiagnosticHandler | undefined): void {
  handler = next ?? defaultHandler;
}

export function emitDiagnostic(event: DiagnosticEvent): void {
  handler(event);
}

export function warn(code: string, message: string): void {
  emitDiagnostic({ level: 'warn', code, message });
}

/**
 * Runs an observability callback so that nothing it does can take the process
 * down.
 *
 * These callbacks are declared `=> void`, but TypeScript accepts an `async`
 * function wherever a void-returning one is expected — `onRetry: async (info) =>
 * metrics.push(info)` compiles without a complaint. A `try`/`catch` never sees
 * that rejection, and an unhandled one terminates the process on Node 15+, so a
 * metrics backend going down would kill a transaction mid-retry. That is exactly
 * backwards: observability must not be able to break the thing it observes.
 *
 * The result is deliberately **not** awaited. These fire between retry attempts,
 * and retry latency must not depend on how fast someone's telemetry pipeline is.
 */
export function runGuarded(call: () => unknown, onError: (error: unknown) => void): void {
  const report = (error: unknown): void => {
    try {
      onError(error);
    } catch {
      /* a diagnostic handler that throws must not resurface as a new failure */
    }
  };

  let result: unknown;

  try {
    result = call();
  } catch (error) {
    report(error);
    return;
  }

  if (typeof (result as { then?: unknown } | null)?.then === 'function') {
    (result as PromiseLike<unknown>).then(undefined, report);
  }
}

/** Warns once per code. Patch-degradation notices must not fire per call site. */
const seen = new Set<string>();

export function warnOnce(code: string, message: string): void {
  if (seen.has(code)) return;
  seen.add(code);
  warn(code, message);
}

/** Test seam. */
export function resetDiagnostics(): void {
  seen.clear();
  handler = defaultHandler;
}
