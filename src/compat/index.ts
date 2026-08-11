/**
 * `typeorm-transactional` compatibility surface.
 *
 * Everything here is also re-exported from the package root, so migrating is a
 * one-line import change. This entry point exists for callers who prefer the
 * boundary to be explicit.
 *
 * Aliases land alongside the features they wrap:
 *   Phase 2 — initializeTransactionalContext, addTransactionalDataSource
 *   Phase 4 — runOnTransactionCommit / Rollback / Complete
 *
 * @see MIGRATION.md
 */

export { Propagation, IsolationLevel } from '../core/enums.js';
