/**
 * PostgreSQL SQLSTATE classification.
 *
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 * @see docs/prior-art.md §7
 */

/** Class 40 — Transaction Rollback. */
export const SERIALIZATION_FAILURE = '40001';
export const DEADLOCK_DETECTED = '40P01';

/** Class 55 — Object Not In Prerequisite State. */
export const LOCK_NOT_AVAILABLE = '55P03';

/** Class 57 — Operator Intervention. */
export const QUERY_CANCELED = '57014';

/**
 * Retried by default.
 *
 * - `40001` is the documented cost of SERIALIZABLE (and REPEATABLE READ). PostgreSQL
 *   also reports hot-standby recovery conflicts under this code, so retrying it fixes
 *   read-replica flakiness for callers who never touch SERIALIZABLE.
 * - `40P01` is inevitable whenever concurrent transactions take row locks in
 *   different orders.
 * - `55P03` comes from `NOWAIT`: the caller asked not to block, not to fail.
 *
 * Both `40001` and `40P01` abort the *entire* transaction in PostgreSQL, which is
 * why retry has to re-run the whole method body rather than a single statement.
 */
export const DEFAULT_RETRYABLE_SQLSTATES: readonly string[] = [
  SERIALIZATION_FAILURE,
  DEADLOCK_DETECTED,
  LOCK_NOT_AVAILABLE,
];

/**
 * Never retried by default — retrying these is unsafe, not merely wasteful.
 *
 * Class 08 covers connection exceptions. If the connection drops during `COMMIT`,
 * the client cannot know whether the server applied it. Retrying may double-apply
 * the transaction. Refusing to guess is the only safe default; opting in is
 * possible per-SQLSTATE but documented as hazardous.
 *
 * @see docs/adr/0005-no-connection-error-retry.md
 */
export const UNSAFE_TO_RETRY_SQLSTATES: readonly string[] = [
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
];
