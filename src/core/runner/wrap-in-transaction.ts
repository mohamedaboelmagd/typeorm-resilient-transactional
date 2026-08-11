import { runInResilientTransaction, type TransactionOptions } from './run-in-transaction.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMethod = (this: any, ...args: any[]) => any;

/**
 * Wraps a function so every call runs inside a transaction, preserving `this`.
 *
 * The wrapped function receives its original arguments — not an `EntityManager`.
 * Repositories used inside it resolve to the transactional manager through the
 * context, which is what makes existing code work unchanged. This mirrors
 * `typeorm-transactional`'s `wrapInTransaction`.
 */
export function wrapInResilientTransaction<F extends AnyMethod>(
  fn: F,
  options?: TransactionOptions,
): F {
  function wrapper(this: unknown, ...args: unknown[]): unknown {
    return runInResilientTransaction(() => fn.apply(this, args) as unknown, options);
  }

  Object.defineProperty(wrapper, 'name', { value: fn.name, configurable: true });
  Object.defineProperty(wrapper, 'length', { value: fn.length, configurable: true });

  return wrapper as unknown as F;
}
