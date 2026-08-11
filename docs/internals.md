# Internals

What this library patches, why, and where it will bite you. If you are reviewing whether it is
safe to adopt, this is the page to read.

---

## 1. Context propagation

The transactional `EntityManager` travels through your call stack in a Node
[`AsyncLocalStorage`](https://nodejs.org/api/async_context.html). No `cls-hooked`, no `zone.js`,
no runtime dependencies at all.

The store is a `ReadonlyMap<string, TransactionState>` keyed by data source name, so one method
can be transactional against several databases at once:

```ts
interface TransactionState {
  manager: EntityManager;
  queryRunner: QueryRunner;
  dataSourceName: string;
  isolation: IsolationLevel | undefined;
  attempt: number; // 1-based
  depth: number; // 0 = owner, each NESTED savepoint adds one
  startedAt: number;
  isOwner: boolean;
}
```

### Scoping is `ALS.run`, and nothing else

Entering a scope copies the map, applies one change, and calls `storage.run(next, fn)`:

```ts
export function runWithTransactionState<T>(name, state, fn): T {
  const next = new Map(storage.getStore() ?? EMPTY);
  if (state === undefined) next.delete(name);
  else next.set(name, state);
  return storage.run(next, fn);
}
```

Unwinding is automatic — when `fn` settles, ALS restores the parent store. There is no `exit()`
to forget and no way for an early return or a thrown error to leave a stale entry behind.

`typeorm-transactional` maintains an explicit stack of layers with paired `enter()`/`exit()` calls
even on its ALS driver, because it reproduces `cls-hooked`'s contract. We do not need that, and
the absence of it is why `NOT_SUPPORTED` — which suspends a transaction by _deleting_ the entry
and restoring it on exit — is four lines here.

---

## 2. What gets patched

Two objects, for two different reasons.

### 2.1 `DataSource` — patched per instance

Per instance, because the data source _name_ is per instance and several may be registered.

| Property             | Patched to                                                            | Why                                                                     |
| -------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `manager`            | getter returning the contextual manager, falling back to the real one | Makes `dataSource.manager` transactional inside `@Transactional()`      |
| `query`              | injects the contextual `QueryRunner` as argument 3                    | Otherwise raw SQL runs on a _pooled_ connection outside the transaction |
| `createQueryBuilder` | same injection                                                        | Same reason                                                             |
| `transaction`        | pinned to the original manager                                        | See below                                                               |

The `query` patch matters more than it looks. Without it, `dataSource.query('UPDATE …')` inside a
transaction runs on a different connection: it cannot see the transaction's uncommitted writes,
and its own writes are **not** undone when the transaction rolls back.

`transaction` is pinned to the _original_ manager deliberately. `DataSource.prototype.transaction`
delegates to `this.manager.transaction(...)`; since `this.manager` is now contextual, an explicit
`dataSource.transaction()` inside `@Transactional()` would silently become a savepoint on the
surrounding transaction. Pinning preserves TypeORM's native behaviour — always an independent
transaction — and matches `typeorm-transactional`.

### 2.2 `Repository` — patched on the prototype

`Repository` assigns its manager as an **own instance property**:

```ts
// typeorm/src/repository/Repository.ts — identical in 0.3.31 and 1.1.0
readonly manager: EntityManager
constructor(target, manager, queryRunner?) { this.manager = manager }
```

An own property shadows a prototype getter, so a getter alone would never run. Defining a
**getter and setter pair** on `Repository.prototype` solves it: because a setter exists on the
prototype chain, `this.manager = manager` invokes it rather than creating an own property, and the
real manager is stashed under a symbol.

Repositories constructed _before_ the patch was installed already own a plain `manager` property.
`EntityManager.prototype.getRepository` and `Repository.prototype.extend` are wrapped to adopt
those as they pass through: the own property is deleted and its value re-assigned through the
setter. Deleting is the part that matters — storing the value without removing the shadow leaves
every read still bypassing the context.

### 2.3 An explicitly chosen manager always wins

The repository getter refuses to redirect a manager that carries its own active transaction:

```ts
if (original?.queryRunner?.isTransactionActive === true) return original;
```

So `dataSource.transaction(m => m.getRepository(X))` and `queryRunner.manager.getRepository(X)`
execute against the manager you named, even inside an ambient `@Transactional()`. Only managers
with no transaction of their own — the root manager, which is what `dataSource.getRepository()`
and NestJS's `@InjectRepository()` hand you — are ambient enough to route.

> **Deviation.** `typeorm-transactional` redirects unconditionally, so under it the inner
> repository silently joins the _outer_ transaction. We consider that a bug: writing
> `m.getRepository(X)` is an explicit statement about where the work should run.

---

## 3. Version tolerance

Supported range: `typeorm@^0.3.31 || ^1`.

The patched surface is identical across both lines — verified by reading both, and kept honest by
the `typeorm-compat` CI job. One property was renamed, and it is read through a helper:

```ts
// 0.3.x: manager.connection   1.x: manager.dataSource
export function dataSourceOf(manager) {
  return manager?.dataSource ?? manager?.connection;
}
```

### We never throw because TypeORM changed

`typeorm-transactional` guards its patch with hard arity assertions:

```ts
if (DataSource.prototype.query.length !== 3) throw new TypeOrmUpdatedPatchError();
```

`Function.length` counts parameters before the first default or rest parameter, so adding a single
defaulted argument upstream turns that into a **hard throw at import time for every consumer**.

We check the same arity, but on mismatch we skip that one patch and emit a warning naming the
method. The failure mode becomes "raw `dataSource.query()` no longer joins the transaction"
— degraded, loud, and localized — instead of a dead process. Repositories are unaffected either
way, because they go through a different mechanism.

Route those warnings wherever you like:

```ts
setDiagnosticHandler((event) => logger.warn({ code: event.code }, event.message));
```

---

## 4. Propagation

| Mode                 | With no transaction         | Inside a transaction                          |
| -------------------- | --------------------------- | --------------------------------------------- |
| `REQUIRED` (default) | starts one                  | joins it                                      |
| `REQUIRES_NEW`       | starts one                  | starts an independent one on a new connection |
| `NESTED`             | starts one                  | **savepoint** on the same connection          |
| `SUPPORTS`           | runs bare                   | joins it                                      |
| `NOT_SUPPORTED`      | runs bare                   | suspends it, runs bare                        |
| `MANDATORY`          | throws `TransactionalError` | joins it                                      |
| `NEVER`              | runs bare                   | throws `TransactionalError`                   |

### `NESTED` uses real savepoints

TypeORM's `QueryRunner` already tracks `transactionDepth` and turns `startTransaction()` at depth

> 0 into `SAVEPOINT typeorm_N`, `commitTransaction()` into `RELEASE SAVEPOINT`, and
> `rollbackTransaction()` into `ROLLBACK TO SAVEPOINT`. Correct nesting therefore needs **no SQL of
> our own** — only that we reuse the query runner already in the context.

`typeorm-transactional` allocates a _new_ one, which is why its `NESTED` behaves as
`REQUIRES_NEW`. This is the single behavioural difference between the two libraries, and
`test/compat/` asserts it in both directions. See
[ADR 0003](adr/0003-nested-savepoint-deviation.md).

Savepoint-level retry will be **disabled by default** when the retry engine lands, because
PostgreSQL aborts the _entire_ transaction on `40001` and `40P01` — after either, even
`ROLLBACK TO SAVEPOINT` is rejected. Retrying to a savepoint cannot recover from the two errors
you would most want to retry.

---

## 5. Transaction lifecycle

```
createQueryRunner() → connect() → startTransaction(isolation)
  → ALS.run(state, () => yourMethod())
    ├─ resolved → commitTransaction()
    └─ rejected → rollbackTransaction()   [failures logged, never rethrown]
finally → release()                        [always, on every path]
```

Two invariants, both covered by tests:

- **The query runner is always released.** A leak silently drains the pool, and the symptom
  (everything hangs on connection acquisition) looks nothing like the cause. `test/integration/context.spec.ts`
  runs 80 transactions — well past the pool size — through both the success and failure paths.
- **Rollback failure never masks the original error.** A failed `ROLLBACK` is real but secondary,
  and it is the _expected_ path after a serialization failure, where the transaction is already
  aborted. It is logged through the diagnostics handler and swallowed.

---

## 6. Where the context does not reach

`AsyncLocalStorage` follows `await` and promise chains. It does not follow work you deliberately
detach from them.

**Detached promises and timers.** The context is captured when the callback is _scheduled_, so
this leaves the transaction:

```ts
@Transactional()
async doWork() {
  setTimeout(() => this.repo.save(x), 1000); // ✗ runs after the transaction committed
  void this.repo.save(y);                    // ✗ not awaited — may outlive the transaction
}
```

Anything the transaction's success depends on must be awaited inside it. Anything that should
happen only _after_ commit belongs in `runOnCommit()` (Phase 4).

**NestJS interceptors, guards, and middleware.** These run _outside_ the method the decorator
wraps, so they are outside the ALS scope. A guard cannot see the transaction the method will
open, and an interceptor's post-handler runs after it has committed.

**Request-scoped providers.** `@Injectable({ scope: Scope.REQUEST })` is fine — the ALS context is
per async execution, independent of NestJS's DI scopes. It is not a substitute for one, either:
the context lives for the duration of the transaction, not the request.

**Worker threads and child processes.** Have their own ALS. A transaction cannot span them.

---

## 7. Package layout

```
src/core/      framework-agnostic — must not import @nestjs/*
  context/     ALS store and public accessors
  datasource/  registry, patching, version-tolerance helpers
  runner/      propagation state machine
  errors/      error types
  dialects/    per-database SQLSTATE maps
src/compat/    typeorm-transactional aliases
```

The `src/core/` boundary is enforced by an ESLint `no-restricted-imports` rule, so splitting out a
standalone `@resilient-tx/core` package later stays a file move rather than a refactor.
