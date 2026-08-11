import { UNSAFE_TO_RETRY_SQLSTATES } from '../dialects/postgres.js';

/**
 * A SQLSTATE is exactly five characters from `[0-9A-Z]` — `40001`, `40P01`, `55P03`.
 *
 * Matching the shape matters because errors carry all sorts of unrelated `code`
 * fields: Node uses `ECONNREFUSED`, TypeORM wrappers add their own. Accepting any
 * `code` blindly would classify an application bug as retryable.
 */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/** Properties that have held a SQLSTATE across drivers and TypeORM versions. */
const CODE_KEYS = ['code', 'sqlState', 'sqlstate'] as const;

/** Properties that wrap another error. Order decides precedence. */
const NESTED_KEYS = ['driverError', 'originalError', 'cause'] as const;

/** Depth bound. Real chains are 2–3 deep; anything more is a malformed error. */
const MAX_DEPTH = 8;

function toSqlState(value: unknown): string | undefined {
  if (typeof value === 'string') return SQLSTATE_PATTERN.test(value) ? value : undefined;

  // Some drivers hand back a numeric code; `40001` is a valid JS number.
  if (typeof value === 'number' && Number.isInteger(value)) {
    const asString = String(value).padStart(5, '0');
    return SQLSTATE_PATTERN.test(asString) ? asString : undefined;
  }

  return undefined;
}

/**
 * Digs the SQLSTATE out of an error, whatever shape it arrived in.
 *
 * Searches breadth-first so the outermost code wins: TypeORM copies the driver's
 * code onto its `QueryFailedError` wrapper *and* keeps the original under
 * `driverError`, and when both are present the wrapper is the authoritative one.
 *
 * Returns `undefined` rather than guessing. An unknown error is not retryable,
 * which is the safe direction to be wrong in.
 */
export function extractSqlState(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;

  const seen = new Set<object>();
  let frontier: object[] = [error];
  let depth = 0;

  while (frontier.length > 0 && depth < MAX_DEPTH) {
    const next: object[] = [];

    for (const node of frontier) {
      // Cyclic `cause` chains are rare but must not hang the retry path.
      if (seen.has(node)) continue;
      seen.add(node);

      const record = node as Record<string, unknown>;

      for (const key of CODE_KEYS) {
        const candidate = toSqlState(record[key]);
        if (candidate !== undefined) return candidate;
      }

      for (const key of NESTED_KEYS) {
        const nested = record[key];
        if (nested !== null && typeof nested === 'object') next.push(nested);
      }
    }

    frontier = next;
    depth += 1;
  }

  return undefined;
}

/**
 * Whether an error should be retried, given the configured SQLSTATE set.
 *
 * Errors with no recognisable SQLSTATE are never retried — an application bug
 * would fail identically on every attempt, and retrying it just multiplies the
 * damage while hiding the cause.
 */
export function isRetryable(error: unknown, retryOn: readonly string[]): boolean {
  const sqlState = extractSqlState(error);
  return sqlState !== undefined && retryOn.includes(sqlState);
}

/**
 * Whether retrying this SQLSTATE risks applying the transaction twice.
 *
 * Connection-class errors lose the commit acknowledgement, so the client cannot
 * know whether the server applied the transaction. Users may still opt in; the
 * engine warns once when they do.
 *
 * @see docs/adr/0005-no-connection-error-retry.md
 */
export function isUnsafeToRetry(sqlState: string): boolean {
  return UNSAFE_TO_RETRY_SQLSTATES.includes(sqlState);
}
