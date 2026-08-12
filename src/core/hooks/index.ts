import { getTransactionState } from '../context/store.js';
import { ResilientTransactionalError } from '../errors/index.js';
import type { CommitHook, CompleteHook, RetryHook, RollbackHook } from './registry.js';

export {
  HookRegistry,
  type CommitHook,
  type CompleteHook,
  type HookMark,
  type RetryHook,
  type RollbackHook,
} from './registry.js';

/** Raised when a lifecycle hook is registered with no transaction in scope. */
export class NoActiveTransactionError extends ResilientTransactionalError {
  constructor(fn: string) {
    super(
      `${fn}() was called outside a transaction. Lifecycle hooks only exist inside ` +
        '@Transactional() or runInResilientTransaction().',
    );
  }
}

function registryOf(fn: string, dataSourceName?: string) {
  const state = getTransactionState(dataSourceName);
  if (state === undefined) throw new NoActiveTransactionError(fn);
  return state.hooks;
}

/**
 * Runs `cb` after the transaction commits successfully.
 *
 * **This is where every non-database side effect belongs.** Retry re-runs the
 * whole method body, so an email, webhook, Stripe charge, or Kafka publish made
 * inline will happen once per attempt. Registered here, it happens exactly once,
 * and only if the transaction actually became durable.
 *
 * Hooks registered during an attempt that later fails are discarded.
 *
 * The callback runs *after* `COMMIT` and outside the transaction context, so
 * repositories used inside it get a pooled connection. Errors are logged rather
 * than thrown — the transaction is already durable and cannot be undone.
 *
 * @see docs/safety.md
 */
export function runOnCommit(cb: CommitHook, dataSourceName?: string): void {
  registryOf('runOnCommit', dataSourceName).addCommit(cb);
}

/** Runs `cb` when the transaction is finally abandoned — not between retries. */
export function runOnRollback(cb: RollbackHook, dataSourceName?: string): void {
  registryOf('runOnRollback', dataSourceName).addRollback(cb);
}

/** Runs `cb` on either outcome, receiving the error when there was one. */
export function runOnComplete(cb: CompleteHook, dataSourceName?: string): void {
  registryOf('runOnComplete', dataSourceName).addComplete(cb);
}

/** Runs `cb` each time this transaction is retried. */
export function runOnRetry(cb: RetryHook, dataSourceName?: string): void {
  registryOf('runOnRetry', dataSourceName).addRetry(cb);
}

// ── typeorm-transactional aliases ────────────────────────────────────────────
// Same semantics, different spelling, so migration is a one-line import change.

/** @see runOnCommit */
export const runOnTransactionCommit = runOnCommit;

/** @see runOnRollback */
export const runOnTransactionRollback = runOnRollback;

/** @see runOnComplete */
export const runOnTransactionComplete = runOnComplete;
