/**
 * typeorm-resilient-transactional
 *
 * `@Transactional()` for NestJS + TypeORM that survives deadlocks and
 * serialization failures.
 *
 * Phase 1 exports the stable declarative surface only. The context, runner,
 * retry engine, hooks, and locking utilities land in Phases 2–5.
 */

export { Propagation, IsolationLevel } from './core/enums.js';

export {
  DEFAULT_RETRYABLE_SQLSTATES,
  UNSAFE_TO_RETRY_SQLSTATES,
  SERIALIZATION_FAILURE,
  DEADLOCK_DETECTED,
  LOCK_NOT_AVAILABLE,
  QUERY_CANCELED,
} from './core/dialects/postgres.js';
