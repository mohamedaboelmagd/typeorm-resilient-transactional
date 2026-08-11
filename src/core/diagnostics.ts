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
