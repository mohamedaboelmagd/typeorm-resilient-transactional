# Migrating from `typeorm-transactional`

## The short version

```diff
- import { Transactional, Propagation, runOnTransactionCommit } from 'typeorm-transactional';
+ import { Transactional, Propagation, runOnTransactionCommit } from 'typeorm-resilient-transactional';
```

```diff
- "typeorm-transactional": "^0.5.0",
+ "typeorm-resilient-transactional": "^0.1.0",
```

That is the whole mechanical migration. Every name below is exported under the same spelling with
the same semantics, and `test/compat/` runs the _same scenario list_ through both libraries in CI to
keep that true rather than merely claimed.

Then read [§3](#3-one-behavioural-difference-to-check) — there is exactly one behavioural difference,
and it only matters if you use `Propagation.NESTED`.

---

## 1. What carries over unchanged

|                                                                   |                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| `initializeTransactionalContext()`                                | same                                                            |
| `addTransactionalDataSource()`                                    | same, including the `{ dataSource, name, patch }` form          |
| `getDataSourceByName()` / `deleteDataSourceByName()`              | same                                                            |
| `@Transactional({ propagation, isolationLevel, connectionName })` | same, all three option spellings                                |
| `Propagation.*`                                                   | same seven modes, same string values                            |
| `IsolationLevel.*`                                                | same                                                            |
| `runInTransaction()` / `wrapInTransaction()`                      | same                                                            |
| `runOnTransactionCommit / Rollback / Complete`                    | same                                                            |
| `TransactionalError`                                              | same name, same cases (`MANDATORY` with none, `NEVER` with one) |

Repositories keep working exactly as before — injected, resolved from the data source, or extended.
The `Repository.prototype` patch uses the same getter/setter technique.

Both `isolation` and `isolationLevel` are accepted, so you can leave existing call sites alone and
use the shorter spelling in new code.

## 2. Two exports that are deliberately absent

| Removed                     | Use instead                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StorageDriver`             | Nothing. There is only `AsyncLocalStorage`, so there is nothing to select between. Drop the `storageDriver` option from `initializeTransactionalContext()`.                              |
| `getTransactionalContext()` | `getTransactionContext()` or `isInTransaction()`. The old function returned the internal cls-hooked/ALS driver; the new ones expose the _transaction_ rather than the storage mechanism. |

If you passed `initializeTransactionalContext({ storageDriver: StorageDriver.AUTO })`, just call
`initializeTransactionalContext()`.

## 3. One behavioural difference to check

**`Propagation.NESTED` uses real savepoints here.**

`typeorm-transactional` routes `NESTED` to the same helper as `REQUIRES_NEW`: it allocates a fresh
`QueryRunner` on a fresh connection, so the inner work commits independently and **survives an outer
rollback**. That is `REQUIRES_NEW` behaviour under a `NESTED` label.

Here, `NESTED` reuses the surrounding query runner, so PostgreSQL emits `SAVEPOINT` /
`RELEASE SAVEPOINT` / `ROLLBACK TO SAVEPOINT`. The savepoint is part of the enclosing transaction and
dies with it.

| Scenario                             | `typeorm-transactional`     | here                        |
| ------------------------------------ | --------------------------- | --------------------------- |
| Inner succeeds, outer commits        | inner persists              | inner persists              |
| Inner fails, outer commits           | inner discarded, outer fine | inner discarded, outer fine |
| **Inner succeeds, outer rolls back** | **inner persists**          | **inner discarded**         |

Only the last row differs — which is exactly why the difference goes unnoticed until it matters.

**If you rely on inner work surviving an outer rollback, change `NESTED` to `REQUIRES_NEW`.** That is
what you were getting.

```diff
- @Transactional({ propagation: Propagation.NESTED })
+ @Transactional({ propagation: Propagation.REQUIRES_NEW })
  async recordAuditEntry(...) { ... }
```

Not using `NESTED`? Nothing to do. See [ADR 0003](docs/adr/0003-nested-savepoint-deviation.md).

### A smaller one: an explicitly chosen manager wins

`dataSource.transaction(m => m.getRepository(X))` and `queryRunner.manager.getRepository(X)` execute
against the manager you named, even inside an ambient `@Transactional()`. `typeorm-transactional`
redirects those to the ambient transaction. We consider that a bug — naming a manager is an explicit
statement about where the work should run. Repositories obtained the usual way (`@InjectRepository`,
`dataSource.getRepository`) are unaffected.

## 4. Turning retry on

Nothing retries until you ask. Migrating changes no runtime behaviour on its own.

```ts
@Transactional({ isolation: IsolationLevel.SERIALIZABLE, retry: { maxAttempts: 5 } })
async transfer(...) { ... }
```

Or application-wide:

```ts
ResilientTransactionalModule.forRoot({ retry: { maxAttempts: 3 } });
```

Per-method options are deep-merged over the global ones, so `retry: { maxAttempts: 5 }` on one method
keeps a globally configured `retryOn` and `backoff`.

**Before enabling it, read [docs/safety.md](docs/safety.md).** Retry re-runs the whole method body —
anything it does outside the database happens again. That is what `runOnCommit()` is for, and it is
the one thing that will bite you.

Retry is only valid where the call _owns_ its transaction. Putting it on a method that joins a
caller's transaction throws `RetryNotPermittedError` on the first call, naming the method — rather
than silently doing nothing.

## 5. NestJS module

Optional. If you only used the decorator and the bootstrap functions, skip this.

```ts
import { ResilientTransactionalModule } from 'typeorm-resilient-transactional/nestjs';

ResilientTransactionalModule.forRoot({
  defaultIsolation: IsolationLevel.READ_COMMITTED,
  retry: { maxAttempts: 3 },
  onRetry: (info) => metrics.increment('tx.retry', { code: info.sqlstate }),
});
```

It calls `initializeResilientContext()` for you and routes library warnings through NestJS's
`Logger`. Registering data sources stays explicit, so the library never has to guess which
`DataSource` you meant.

Note the `/nestjs` subpath: `@nestjs/common` is an _optional_ peer, and exporting the module from the
package root would make it mandatory for everyone.

## 6. Checklist

- [ ] Swap the dependency and the import lines
- [ ] Remove `StorageDriver` / `storageDriver` if you used them
- [ ] Replace `getTransactionalContext()` with `getTransactionContext()` or `isInTransaction()`
- [ ] Audit `Propagation.NESTED` usages — switch to `REQUIRES_NEW` if you need independent commits
- [ ] Run your test suite. Nothing else should change until you enable retry.
- [ ] Read [docs/safety.md](docs/safety.md), then enable retry where it earns its keep
