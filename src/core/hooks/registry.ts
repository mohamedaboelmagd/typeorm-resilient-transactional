import { warn } from '../diagnostics.js';
import type { RetryInfo } from '../retry/engine.js';

export type CommitHook = () => void | Promise<void>;
export type RollbackHook = (error: unknown) => void | Promise<void>;
/** Receives the failure, or `undefined` when the transaction committed. */
export type CompleteHook = (error: unknown) => void | Promise<void>;
export type RetryHook = (info: RetryInfo) => void;

/** Snapshot of registry lengths, used to unwind a savepoint. */
export interface HookMark {
  readonly commit: number;
  readonly rollback: number;
  readonly complete: number;
  readonly retry: number;
}

/**
 * Lifecycle callbacks for one transaction attempt.
 *
 * A fresh registry is created per attempt, which is what makes the central
 * safety property true: **hooks registered during an attempt that failed are
 * discarded, never carried into the retry.** Without that, a retried transaction
 * would fire the side effects of every attempt that came before it.
 */
export class HookRegistry {
  private commitHooks: CommitHook[] = [];
  private rollbackHooks: RollbackHook[] = [];
  private completeHooks: CompleteHook[] = [];
  private retryHooks: RetryHook[] = [];

  private commitRan = false;

  addCommit(hook: CommitHook): void {
    this.commitHooks.push(hook);
  }

  addRollback(hook: RollbackHook): void {
    this.rollbackHooks.push(hook);
  }

  addComplete(hook: CompleteHook): void {
    this.completeHooks.push(hook);
  }

  addRetry(hook: RetryHook): void {
    this.retryHooks.push(hook);
  }

  /** Current lengths, so a savepoint can discard only what it added. */
  mark(): HookMark {
    return {
      commit: this.commitHooks.length,
      rollback: this.rollbackHooks.length,
      complete: this.completeHooks.length,
      retry: this.retryHooks.length,
    };
  }

  /**
   * Drops every hook registered since `mark`.
   *
   * A `NESTED` block that rolls back to its savepoint had its work undone, so its
   * commit hooks must not fire even though the outer transaction goes on to
   * commit. Same principle as the per-attempt reset, one level down.
   */
  rollbackTo(mark: HookMark): void {
    this.commitHooks.length = mark.commit;
    this.rollbackHooks.length = mark.rollback;
    this.completeHooks.length = mark.complete;
    this.retryHooks.length = mark.retry;
  }

  /**
   * Runs commit hooks, at most once per registry.
   *
   * Called *after* `COMMIT` and outside the transaction's context, so a hook that
   * touches the database gets a pooled connection rather than the finished
   * transaction's. Errors are logged, never rethrown: the transaction is already
   * durable and turning a post-commit notification failure into a caller-visible
   * error would misrepresent what happened.
   */
  async runCommit(): Promise<void> {
    if (this.commitRan) return;
    this.commitRan = true;

    for (const hook of this.commitHooks) {
      await this.safely(hook, 'commit');
    }

    await this.runComplete(undefined);
  }

  async runRollback(error: unknown): Promise<void> {
    for (const hook of this.rollbackHooks) {
      await this.safely(() => hook(error), 'rollback');
    }

    await this.runComplete(error);
  }

  /** Synchronous by design — this fires between attempts, on the hot path. */
  runRetry(info: RetryInfo): void {
    for (const hook of this.retryHooks) {
      try {
        hook(info);
      } catch (hookError) {
        warn('hook-failed', `A retry hook threw and was ignored: ${String(hookError)}`);
      }
    }
  }

  private async runComplete(error: unknown): Promise<void> {
    for (const hook of this.completeHooks) {
      await this.safely(() => hook(error), 'complete');
    }
  }

  /** One failing hook must never stop its siblings from running. */
  private async safely(hook: () => void | Promise<void>, kind: string): Promise<void> {
    try {
      await hook();
    } catch (hookError) {
      warn('hook-failed', `A ${kind} hook threw and was ignored: ${String(hookError)}`);
    }
  }
}
