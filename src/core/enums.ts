/**
 * Transaction propagation behaviour.
 *
 * Names and semantics follow Spring's `Propagation`, which entered this ecosystem
 * via `typeorm-transactional`. We keep them identical so migration is a one-line
 * import change.
 *
 * @see docs/prior-art.md §1.4
 */
export const Propagation = {
  /** Join the current transaction, or start one if none exists. The default. */
  REQUIRED: 'REQUIRED',
  /** Always start a new, independent transaction on its own connection. */
  REQUIRES_NEW: 'REQUIRES_NEW',
  /** Join the current transaction if one exists; otherwise run without one. */
  SUPPORTS: 'SUPPORTS',
  /** Suspend any current transaction and run without one. */
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  /** Require an existing transaction; throw if there is none. */
  MANDATORY: 'MANDATORY',
  /** Require that no transaction exists; throw if one does. */
  NEVER: 'NEVER',
  /**
   * Run inside a savepoint of the current transaction.
   *
   * Note this deviates from `typeorm-transactional`, whose NESTED is really
   * REQUIRES_NEW. Ours uses real savepoints, and retry at the savepoint level is
   * disabled by default because `40001` and `40P01` abort the entire transaction
   * in PostgreSQL — rolling back to a savepoint cannot recover from either.
   *
   * @see docs/adr/0003-nested-savepoint-deviation.md
   */
  NESTED: 'NESTED',
} as const;

export type Propagation = (typeof Propagation)[keyof typeof Propagation];

/**
 * SQL transaction isolation levels, spelled as PostgreSQL expects them.
 *
 * TypeORM 1.x validates these against `driver.supportedIsolationLevels` before
 * issuing any SQL; 0.3.x let the driver reject them. Both accept these strings.
 */
export const IsolationLevel = {
  READ_UNCOMMITTED: 'READ UNCOMMITTED',
  READ_COMMITTED: 'READ COMMITTED',
  REPEATABLE_READ: 'REPEATABLE READ',
  SERIALIZABLE: 'SERIALIZABLE',
} as const;

export type IsolationLevel = (typeof IsolationLevel)[keyof typeof IsolationLevel];
