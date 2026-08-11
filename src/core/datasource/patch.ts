import { DataSource, EntityManager, Repository } from 'typeorm';

import { getEntityManagerInContext } from '../context/store.js';
import { warnOnce } from '../diagnostics.js';
import { DATA_SOURCE_NAME, ORIGINAL_MANAGER, PATCHED, dataSourceOf, nameOf } from './symbols.js';

/**
 * Everything in this file rewrites TypeORM's own accessors. It is the most
 * upgrade-sensitive code in the library, so two rules apply throughout:
 *
 *  1. Never throw because TypeORM changed shape. `typeorm-transactional` asserts
 *     `DataSource.prototype.query.length === 3` and throws at import time when it
 *     does not hold — one upstream signature change hard-crashes every consumer on
 *     upgrade day. We skip the affected patch and warn instead, so the worst case
 *     is a repository that misses the transactional manager, not a dead process.
 *  2. Read version-dependent properties through the helpers in `symbols.ts`.
 *
 * @see docs/internals.md
 */

/** Arity TypeORM has used for these methods on both 0.3.x and 1.x. */
const EXPECTED_ARITY = 3;
/** Index of the optional `QueryRunner` parameter in both signatures. */
const QUERY_RUNNER_ARG = 2;

type AnyFn = (...args: unknown[]) => unknown;

function isPatched(target: object): boolean {
  return (target as Partial<Record<typeof PATCHED, boolean>>)[PATCHED] === true;
}

function markPatched(target: object): void {
  Object.defineProperty(target, PATCHED, { value: true, enumerable: false, configurable: true });
}

/**
 * Routes a method's optional `QueryRunner` argument to the contextual one.
 *
 * `DataSource.query` and `DataSource.createQueryBuilder` both accept a trailing
 * `QueryRunner`. Without this, raw `dataSource.query(...)` inside `@Transactional()`
 * would run on a pooled connection outside the transaction — reading uncommitted
 * work as absent and writing changes the rollback would not undo.
 */
function patchQueryRunnerArgument(
  dataSource: DataSource,
  method: 'query' | 'createQueryBuilder',
): void {
  // Read unbound on purpose: we re-apply it with the caller's `this` below.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = DataSource.prototype[method] as unknown as AnyFn;

  if (typeof original !== 'function') {
    warnOnce(
      `patch-missing-${method}`,
      `DataSource.prototype.${method} is not a function on this TypeORM build; ` +
        `raw ${method}() calls will not join the transactional context.`,
    );
    return;
  }

  if (original.length !== EXPECTED_ARITY) {
    warnOnce(
      `patch-arity-${method}`,
      `DataSource.prototype.${method} has arity ${original.length}, expected ${EXPECTED_ARITY}. ` +
        `This TypeORM version changed the signature, so ${method}() will not be routed through ` +
        'the transactional query runner. Repositories are unaffected. Please open an issue.',
    );
    return;
  }

  Object.defineProperty(dataSource, method, {
    configurable: true,
    writable: true,
    value: function patched(this: DataSource, ...args: unknown[]): unknown {
      const queryRunner = this.manager?.queryRunner;

      // createQueryBuilder() with no arguments takes the runner as its first.
      if (method === 'createQueryBuilder' && args.length === 0) {
        return original.apply(this, [queryRunner]);
      }

      args[QUERY_RUNNER_ARG] ??= queryRunner;
      return original.apply(this, args);
    },
  });
}

/**
 * Makes `dataSource.manager` resolve to the transactional manager inside a
 * transaction, and to the real one outside.
 *
 * Patched per instance rather than on the prototype, because the name is
 * per-instance and several data sources may be registered at once.
 */
export function patchDataSource(dataSource: DataSource, name: string): void {
  if (isPatched(dataSource)) return;

  Object.defineProperty(dataSource, DATA_SOURCE_NAME, {
    value: name,
    enumerable: false,
    configurable: true,
  });

  let originalManager = dataSource.manager;

  Object.defineProperty(dataSource, 'manager', {
    configurable: true,
    get(): EntityManager {
      return getEntityManagerInContext(name) ?? originalManager;
    },
    set(next: EntityManager) {
      originalManager = next;
    },
  });

  patchQueryRunnerArgument(dataSource, 'query');
  patchQueryRunnerArgument(dataSource, 'createQueryBuilder');

  // `DataSource.prototype.transaction` delegates to `this.manager.transaction`,
  // which now resolves to the *transactional* manager — turning an explicit
  // `dataSource.transaction()` into a savepoint on the surrounding transaction.
  // Pinning it to the original manager preserves TypeORM's native behaviour of
  // always opening an independent transaction, and matches typeorm-transactional.
  Object.defineProperty(dataSource, 'transaction', {
    configurable: true,
    writable: true,
    value: function patchedTransaction(this: DataSource, ...args: unknown[]): unknown {
      return (originalManager.transaction as unknown as AnyFn).apply(originalManager, args);
    },
  });

  markPatched(dataSource);
}

/**
 * Makes every `Repository` resolve `this.manager` from the context.
 *
 * `Repository` assigns `this.manager = manager` in its constructor, so a
 * getter-only accessor on the prototype would be shadowed by that own property.
 * Defining a getter *and* setter means the assignment hits our setter instead and
 * no own property is ever created — the manager lands under `ORIGINAL_MANAGER`.
 *
 * Verified against TypeORM 0.3.31 and 1.1.0, whose `Repository` constructors are
 * identical in this respect. @see docs/prior-art.md §1.2
 */
export function patchRepositoryPrototype(): void {
  if (isPatched(Repository.prototype)) return;

  Object.defineProperty(Repository.prototype, 'manager', {
    configurable: true,
    get(this: Record<symbol, EntityManager | undefined>): EntityManager | undefined {
      const original = this[ORIGINAL_MANAGER];

      // A manager carrying its own active transaction was chosen deliberately —
      // `dataSource.transaction(m => m.getRepository(X))` or
      // `queryRunner.manager.getRepository(X)`. Redirecting it to the ambient
      // transaction would silently execute the caller's work somewhere else.
      // Only managers with no transaction of their own are ambient enough to route.
      if (original?.queryRunner?.isTransactionActive === true) return original;

      const name = nameOf(dataSourceOf(original));

      return (name === undefined ? undefined : getEntityManagerInContext(name)) ?? original;
    },
    set(this: Record<symbol, EntityManager | undefined>, next: EntityManager | undefined) {
      this[ORIGINAL_MANAGER] = next;
    },
  });

  // Repositories built before this patch ran already own a plain `manager`
  // property, which shadows the accessor above. Backfill the symbol as they pass
  // through the two factories TypeORM uses to hand them out.
  backfillOriginalManager(EntityManager.prototype, 'getRepository');
  backfillOriginalManager(Repository.prototype, 'extend');

  markPatched(Repository.prototype);
}

function backfillOriginalManager(target: object, method: string): void {
  const holder = target as Record<string, AnyFn | undefined>;
  const original = holder[method];

  if (typeof original !== 'function') {
    warnOnce(
      `patch-missing-${method}`,
      `${method}() is not a function on this TypeORM build; repositories created before ` +
        'initializeResilientContext() may not join the transactional context.',
    );
    return;
  }

  holder[method] = function patched(this: unknown, ...args: unknown[]): unknown {
    const repository = original.apply(this, args);

    if (repository !== null && typeof repository === 'object') {
      adoptRepository(repository as Record<string | symbol, unknown>);
    }

    return repository;
  };
}

/**
 * Hands a repository's `manager` over to the prototype accessor.
 *
 * A repository constructed before `patchRepositoryPrototype()` ran owns a plain
 * `manager` data property, and an own property always shadows a prototype
 * accessor. Storing the manager under the symbol is not enough — the own property
 * has to go, or every read still bypasses the context.
 */
function adoptRepository(repository: Record<string | symbol, unknown>): void {
  if (ORIGINAL_MANAGER in repository) return;

  const own = Object.getOwnPropertyDescriptor(repository, 'manager');

  // No own property means the prototype setter already captured it at construction.
  if (own === undefined || !('value' in own)) return;

  if (own.configurable) {
    delete repository['manager'];
    repository[ORIGINAL_MANAGER] = own.value;
    return;
  }

  warnOnce(
    'patch-repository-non-configurable',
    'A Repository was created with a non-configurable `manager` property and cannot be ' +
      'routed through the transactional context. Call initializeResilientContext() before ' +
      'creating repositories.',
  );
}
