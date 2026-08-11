# Prior art

Research conducted before writing any implementation code. Everything below was read from source
or fetched from a live API on 2026-08-11 — nothing is quoted from memory. Line references are to the
tags/branches named in each section.

**Contents:** [typeorm-transactional](#1-typeorm-transactional) ·
[nestjs-cls](#2-nestjs-cls--nestjs-clstransactional) · [TypeORM #9806](#3-typeorm-issue-9806) ·
[TypeORM's own retry](#4-typeorms-own-retry-implementation) · [Spring](#5-spring-retry--spring-tx) ·
[AWS jitter](#6-aws-exponential-backoff-and-jitter) · [Postgres](#7-postgresql-documentation) ·
[Verdict](#8-verdict-copy--improve--reject)

---

## 0. The landscape, in numbers

Measured 2026-08-11 from the npm registry API and GitHub API.

| Package                     | Weekly downloads | Runtime deps                                | Retry?                        |
| --------------------------- | ---------------: | ------------------------------------------- | ----------------------------- |
| `typeorm`                   |        4,826,597 | —                                           | Only for CockroachDB (see §4) |
| `nestjs-cls`                |        1,175,524 | —                                           | No                            |
| `typeorm-transactional`     |          172,112 | `cls-hooked`, `@types/cls-hooked`, `semver` | **No**                        |
| `@nestjs-cls/transactional` |          148,247 | —                                           | **No**                        |

TypeORM `latest` is **1.1.0** (2026-07-13). The `0.3.x` line is tagged **`legacy`** but still
maintained — `0.3.31` shipped the same day as 1.1.0. We support both.

---

## 1. `typeorm-transactional`

v0.5.0 · [Aliheym/typeorm-transactional](https://github.com/Aliheym/typeorm-transactional) · read at `master`.

This is the API we must be compatible with. It is a well-built library; the notes below are about
where it stops, not about its quality.

### 1.1 Context propagation

Two interchangeable storage drivers behind a `StorageDriver` interface: `cls-hooked` and
`AsyncLocalStorage`.

> **This corrects a premise in our own brief.** We had positioned "uses AsyncLocalStorage, not
> `cls-hooked`" as a differentiator. It is not — `src/storage/driver/async-local-storage/index.ts`
> has existed for some time. What _is_ a real differentiator is **zero runtime dependencies**:
> `cls-hooked`, `@types/cls-hooked`, and `semver` are all listed under `dependencies`, so every
> consumer installs them regardless of which driver they select.

Their ALS driver deliberately reimplements `cls-hooked`'s _layered_ semantics on top of
`AsyncLocalStorage`, because the two have different contracts (ALS requires the store to be passed
on every `.run()`; cls-hooked manages layers internally). The result is a `Store` class holding a
`layers: (Storage|undefined)[]` stack with `enter()`/`exit()`.

One sharp edge worth avoiding:

```ts
private get store() {
    return this.context.getStore() || new Store();   // ← outside a context, silently returns a throwaway
}
```

Calling `.set()` outside any active context writes into a `Store` that is immediately garbage —
no error, no warning. We will make out-of-context access explicit instead.

### 1.2 DataSource and Repository patching

Understanding this is the single highest-value thing in this document, because it is the part of
our own design most likely to go wrong.

**`DataSource` — patched per instance** (`src/common/index.ts`):

```ts
Object.defineProperty(dataSource, 'manager', {
  configurable: true,
  get() {
    return getEntityManagerInContext(this[TYPEORM_DATA_SOURCE_NAME]) || originalManager;
  },
  set(manager) {
    originalManager = manager;
  },
});
```

**`Repository` — patched on the prototype**, which is subtler than it looks. In both TypeORM 0.3.31
and 1.1.0, `Repository` assigns its manager as an **own instance property** in the constructor:

```ts
// typeorm/src/repository/Repository.ts:40,68 — identical in 0.3.31 and 1.1.0
readonly manager: EntityManager
constructor(target, manager, queryRunner?) { this.manager = manager; /* … */ }
```

A getter-only accessor on `Repository.prototype` would be shadowed by that own property. Their
workaround is to define a **getter _and_ setter** pair on the prototype. Because a setter exists on
the prototype chain, `this.manager = manager` in the constructor **invokes the setter instead of
creating an own data property**, and the setter stashes the real manager under a symbol:

```ts
Object.defineProperty(Repository.prototype, 'manager', {
  configurable: true,
  get() {
    return getEntityManagerInContext(/* … */) || this[TYPEORM_ENTITY_MANAGER_NAME];
  },
  set(manager) {
    this[TYPEORM_ENTITY_MANAGER_NAME] = manager;
  },
});
```

They additionally wrap `EntityManager.prototype.getRepository` and `Repository.prototype.extend` to
backfill the symbol for repositories that were constructed before the patch was installed.

This technique is correct and we adopt it. It also means the _shape_ we depend on
(`DataSource.manager`, `Repository.manager`, `createQueryRunner(mode)`,
`startTransaction(isolationLevel?)`) is **identical across TypeORM 0.3.31 and 1.1.0** — verified by
reading both — so dual-version support costs us very little.

### 1.3 The fragility we will not copy

The patch is guarded by hard function-arity assertions:

```ts
const originalQuery = DataSource.prototype.query;
if (originalQuery.length !== 3) throw new TypeOrmUpdatedPatchError();

const originalCreateQueryBuilder = DataSource.prototype.createQueryBuilder;
if (originalCreateQueryBuilder.length !== 3) throw new TypeOrmUpdatedPatchError();
```

`Function.length` counts parameters before the first default or rest parameter. TypeORM's
`query(query, parameters?, useStructuredResult: boolean = false)` currently has arity 3 — but adding
one defaulted parameter, or converting to a rest signature, would take this to a **hard throw at
bootstrap** for every user on upgrade day.

**We reject this.** We will detect capability behaviourally, and on mismatch degrade to unpatched
operation with a `warn` naming the affected method — never a throw at import time.

### 1.4 Propagation

All seven Spring-style modes are implemented in `src/transactions/wrap-in-transaction.ts`:
`REQUIRED` (default), `REQUIRES_NEW`, `SUPPORTS`, `NOT_SUPPORTED`, `MANDATORY`, `NEVER`, `NESTED`.

**`NESTED` does not use savepoints.** It routes to the same `runWithNewTransaction()` helper as
`REQUIRES_NEW`:

```ts
case Propagation.NESTED:
  return runWithNewTransaction();      // → dataSource.transaction(...) → a brand-new QueryRunner
```

Because `dataSource.transaction()` allocates a fresh `QueryRunner` on a fresh pooled connection,
the inner work runs in a genuinely independent transaction. It commits independently, is invisible
to the outer transaction until it does, and is **not** rolled back if the outer transaction aborts.
That is `REQUIRES_NEW` semantics wearing a `NESTED` label.

This matters because savepoints are essentially free in TypeORM already — see §4.2. We implement
real savepoints and document the deviation in `MIGRATION.md`.

### 1.5 Hooks

`runOnTransactionCommit` / `runOnTransactionRollback` / `runOnTransactionComplete`, built on a
per-context Node `EventEmitter` with `.once()` and a configurable `maxHookHandlers` (default 10) to
surface listener leaks.

Dispatch is fire-and-forget:

```ts
const result = await Promise.resolve(cb());
setImmediate(() => {
  hook.emit('commit');
  hook.emit('end', undefined);
  hook.removeAllListeners();
});
return result;
```

Two consequences. The function returns **before** commit hooks have run, so a caller cannot await
side effects. And because `setImmediate` escapes the promise chain, a hook that throws — or an async
hook that rejects — becomes an **unhandled rejection / uncaught exception**, which by default takes
the process down in modern Node.

We will `await` commit hooks after `COMMIT` and catch-and-log per hook, so one bad listener can
neither crash the process nor prevent its siblings from running.

### 1.6 What is simply absent

**Retry.** There is no classifier, no backoff, no attempt counter, no notion of a transaction
"owner". This is the gap the library exists to fill.

---

## 2. `nestjs-cls` + `@nestjs-cls/transactional`

v6.2.1 / v3.2.1 · [Papooch/nestjs-cls](https://github.com/Papooch/nestjs-cls) · read at `main`.

A different and cleaner architectural bet: rather than monkey-patching an ORM, define a narrow
adapter interface and implement it per data-access library. Adapters ship for TypeORM, Prisma,
Drizzle, Knex, Kysely, MongoDB, Mongoose, and pg-promise.

The entire TypeORM adapter is ~60 lines:

```ts
export class TransactionalAdapterTypeOrm implements TransactionalAdapter<
  DataSource,
  EntityManager,
  TypeOrmTransactionOptions
> {
  optionsFactory = (dataSource: DataSource) => ({
    wrapWithTransaction: async (options, fn, setClient) =>
      dataSource.transaction(options?.isolationLevel, (trx) => {
        setClient(trx);
        return fn();
      }),
    wrapWithNestedTransaction: async (options, fn, setClient, client) =>
      client.transaction(options?.isolationLevel, (trx) => {
        setClient(trx);
        return fn();
      }),
    getFallbackInstance: () => dataSource.manager,
  });
}
```

**What we take:** the three-method shape (`wrap` / `wrapNested` / `fallback`) is a good internal
boundary, and `getFallbackInstance` is the right answer to "what does a repository resolve to
outside a transaction". Note that their `wrapWithNestedTransaction` calls `client.transaction(...)`
on the **existing** manager — which, per §4.2, is exactly how you get real savepoints. Their nested
semantics are correct where `typeorm-transactional`'s are not.

**What we reject:** the adapter indirection itself, for v1. It buys multi-ORM support we have
explicitly declared a non-goal, at the cost of the transparent-repository behaviour that makes
`@Transactional()` a genuine drop-in. Their approach requires injecting a `TransactionHost`; ours
lets existing repository code work unchanged.

**Also absent: retry.** Neither the plugin nor any adapter has a retry concept.

---

## 3. TypeORM issue #9806

[typeorm/typeorm#9806](https://github.com/typeorm/typeorm/issues/9806) — _"Auto Retry options on
error in transactions(e.g. Deadlock)"_. Opened 2023-02-24 by **@jayvaghani**. **Still open** as of
2026-08-11, with **30 reactions** and 5 comments.

The original ask, verbatim:

> Whenever Deadlock happen in any transaction query, Retrying same query transaction is needed in
> most of the cases. Writing code for each query to retry on deadlock is too much headache and it
> does not keep code clean. […] Workaround was to write additional lines of code to retry queries on
> such error, But that makes code messy and less readable.

Requested surface: `shouldRetryOnError`, `attempts`, `delay`, configurable globally and overridable
per query. That maps almost exactly onto our `retry: { enabled, maxAttempts, backoff }` cascade.

All five comments, and what each tells us:

| Commenter     | Date       | Signal                                                                   |
| ------------- | ---------- | ------------------------------------------------------------------------ |
| @daitay4      | 2023-06-06 | "+1, exact same reasons"                                                 |
| @scr4bble     | 2024-06-19 | Facing deadlocks; would rather configure retry than redesign around them |
| **@quezak**   | 2024-08-13 | **Needs retry for hot-standby recovery conflicts on a Postgres replica** |
| @joachimbulow | 2025-04-23 | Points out TypeORM already has retry logic "in various places" — see §4  |
| @jayvaghani   | 2025-04-23 | "I will share PR soon" — none landed in the 16 months since              |

Two findings worth acting on.

**The reporter's own driver is MySQL, not Postgres.** The issue checkbox list has `mysql` ticked and
`postgres` unticked. Our Postgres-first stance is right on technical merit, but the exported
`RetryableErrorMap` interface is what lets this audience actually adopt — it is not a nice-to-have.

**@quezak's case is one we would otherwise have missed.** Reading from a Postgres read replica
raises `canceling statement due to conflict with recovery` and `terminating connection due to
conflict with recovery` when a long query on the standby conflicts with WAL replay. Postgres reports
the cancellation case as **`40001`** — the same SQLSTATE as `serialization_failure`. So our default
`retryOn` list fixes a second, entirely separate real-world problem for free. This deserves its own
section in the README, and it materially widens the audience beyond people using `SERIALIZABLE`.

---

## 4. TypeORM's own retry implementation

@joachimbulow's comment is correct, and worth following up because it is precedent from inside the
project.

### 4.1 CockroachDB gets retry; Postgres does not

TypeORM's CockroachDB driver has long implemented transaction retry replay, and it was still being
actively fixed during the 1.0 cycle — PR #11861, _"fix(cockroachdb): preserve structured query
results during txn retry replay"_, shipped in 1.0.0.

The maintainers therefore already accept that **retry belongs at this layer** — they simply
implemented it for the one database whose vendor documentation makes retry unavoidable. Postgres
under `SERIALIZABLE` has exactly the same requirement; it just doesn't advertise it as loudly. This
is the strongest single argument to make when we comment on #9806 in Phase 9.

### 4.2 Savepoints are already implemented — we just have to reach them

From `src/driver/postgres/PostgresQueryRunner.ts` at 1.1.0:

```ts
async startTransaction(isolationLevel?: IsolationLevel) {
    // …
    if (this.transactionDepth === 0) {
        await this.query("START TRANSACTION")
        if (isolationLevel) await this.query("SET TRANSACTION ISOLATION LEVEL " + isolationLevel)
    } else {
        await this.query(`SAVEPOINT typeorm_${this.transactionDepth}`)
    }
    this.transactionDepth += 1
}

async commitTransaction() {
    if (this.transactionDepth > 1) await this.query(`RELEASE SAVEPOINT typeorm_${this.transactionDepth - 1}`)
    else { await this.query("COMMIT"); this.isTransactionActive = false }
    this.transactionDepth -= 1
}

async rollbackTransaction() {
    if (this.transactionDepth > 1) await this.query(`ROLLBACK TO SAVEPOINT typeorm_${this.transactionDepth - 1}`)
    else { await this.query("ROLLBACK"); this.isTransactionActive = false }
    this.transactionDepth -= 1
}
```

`QueryRunner` maintains a `transactionDepth` and emits `SAVEPOINT` / `RELEASE SAVEPOINT` /
`ROLLBACK TO SAVEPOINT` automatically. Correct `NESTED` support therefore requires **no SQL of our
own** — only that we call `startTransaction()` on the query runner already in the ALS context rather
than allocating a new one. `typeorm-transactional`'s NESTED is wrong by one line of routing.

### 4.3 A 1.x-only behaviour change to handle

1.1.0 added, in `startTransaction`:

```ts
isolationLevel ??= this.dataSource.options.isolationLevel;
validateIsolationLevel(this.driver.supportedIsolationLevels, isolationLevel);
```

Two implications for our dual-version support: on 1.x an unsupported isolation level now **throws
before any SQL is sent** (0.3.x would have let the driver reject it), and a `DataSource`-level
`isolationLevel` default exists that our own default must compose with rather than silently
override. Both need a test in the config-cascade suite.

---

## 5. Spring Retry / Spring TX

Read from `spring-projects/spring-retry` at `main`.

We are not the first ecosystem to solve this, and the vocabulary is worth borrowing wholesale
because it is what senior backend engineers arriving from Java will search for.

`@Retryable`: `maxAttempts()` (**default 3**), `backoff()`, `recover()`, `stateful()`, `label()`,
`exceptionExpression()`.
`@Backoff`: `delay()` (default 1000), `maxDelay()`, `multiplier()`, **`random()`** (default `false`).

Mapping onto our API:

| Spring                   | Ours                          | Note                                           |
| ------------------------ | ----------------------------- | ---------------------------------------------- |
| `maxAttempts`            | `retry.maxAttempts`           | Same name, same default of 3                   |
| `@Backoff(delay=…)`      | `backoff.baseMs`              |                                                |
| `@Backoff(maxDelay=…)`   | `backoff.capMs`               |                                                |
| `@Backoff(multiplier=…)` | `'exponential'` strategy      |                                                |
| `@Backoff(random=true)`  | `'exponential-full-jitter'`   | **We default this on; Spring defaults it off** |
| `@Recover`               | `onExhausted` callback        | Ours is a callback, not method dispatch        |
| `TransactionTemplate`    | `runInResilientTransaction()` | Programmatic, non-decorator escape hatch       |

The propagation names (`REQUIRED`, `REQUIRES_NEW`, `NESTED`, …) already came into this ecosystem
from Spring via `typeorm-transactional`, so we inherit them unchanged.

**The one place we deliberately diverge from Spring is jitter defaulting to on.** See §6.

---

## 6. AWS: exponential backoff and jitter

The canonical reference is the AWS Architecture Blog's _"Exponential Backoff And Jitter"_ (Marc
Brooker, 2015), whose measured result is that **full jitter** completes contended work in fewer
total calls than exponential backoff without jitter.

We implement full jitter:

```
delay = random(0, min(capMs, baseMs * 2 ** (attempt - 1)))
```

Defaults: `baseMs: 25`, `capMs: 500`, `strategy: 'exponential-full-jitter'`.

The reason this is the default rather than an option is specific to our failure mode and worth
stating precisely: **two transactions that just deadlocked are, by construction, synchronised.**
Postgres detected the cycle and killed one of them at the same instant it let the other proceed. If
both retry after an identical `baseMs * 2^n` delay, they re-enter the same lock-acquisition order at
the same moment and deadlock again — and naive exponential backoff makes each successive collision
_more_ expensive, not less. Jitter is what breaks the phase lock.

Phase 3 must include a test demonstrating a measurably higher success rate with jitter than without,
under identical contention. If that test does not show a difference, this rationale is wrong and
this document gets corrected.

---

## 7. PostgreSQL documentation

Cited in code comments where the behaviour is relied upon.

**[Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)** — the
`SERIALIZABLE` section states that applications using this level must be prepared to retry
transactions that fail with serialization failures. This is the load-bearing citation for the whole
project: retry is not a workaround, it is the documented contract.

Also relevant: under `SERIALIZABLE`, a `40001` can be raised at **`COMMIT`** time, not just mid-
transaction — which is why retry must wrap the entire method body including the commit, and why a
per-query retry (what #9806 literally asked for) cannot work.

**[Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)** — documents
that deadlocks arise from inconsistent lock acquisition order and that the application-level fix is
to acquire locks in a consistent order. This is the basis for `lockRowsInOrder` (Phase 5): surviving
deadlocks is good, not having them is better.

**[Error Codes](https://www.postgresql.org/docs/current/errcodes-appendix.html)** — Class 40
(Transaction Rollback) and Class 08 (Connection Exception). Our default `retryOn` set:

| SQLSTATE | Name                    | Default                 | Rationale                                                                              |
| -------- | ----------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `40001`  | `serialization_failure` | ✅ retry                | Documented cost of `SERIALIZABLE`; also raised for hot-standby recovery conflicts (§3) |
| `40P01`  | `deadlock_detected`     | ✅ retry                | Inevitable under out-of-order lock acquisition                                         |
| `55P03`  | `lock_not_available`    | ✅ retry                | From `NOWAIT`; the caller asked not to wait, not to fail                               |
| `57014`  | `query_canceled`        | ⚠️ opt-in               | May be a `statement_timeout`; retrying amplifies the load that caused it               |
| `08xxx`  | connection exceptions   | ❌ **never by default** | See below                                                                              |

**Why connection errors are not retried by default — this is a feature.** If the connection drops
during `COMMIT`, the client cannot know whether the server applied the commit before the socket
died. Retrying may **double-apply** the transaction. Refusing to guess is the only safe default; a
library that silently retried these would be actively dangerous for exactly the financial workloads
that need `SERIALIZABLE` most. Users may opt in per-SQLSTATE, behind a documented warning.

---

## 8. Verdict: copy / improve / reject

### Copy

| From                    | What                                                                                                                                                                             | Why                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `typeorm-transactional` | Public API names — `@Transactional`, `Propagation`, `IsolationLevel`, `initializeTransactionalContext`, `addTransactionalDataSource`, `runOnTransactionCommit/Rollback/Complete` | Compatibility is the adoption lever; a one-line import change is the whole migration story                           |
| `typeorm-transactional` | Prototype getter+setter pair to intercept `Repository`'s ctor assignment (§1.2)                                                                                                  | The only technique that works given `this.manager = manager`; correct, and we verified it against both TypeORM lines |
| `typeorm-transactional` | Per-instance `DataSource.manager` patching + named multi-datasource registry                                                                                                     | Sound, and required for multi-tenant setups                                                                          |
| `nestjs-cls`            | Internal `wrap` / `wrapNested` / `fallback` boundary                                                                                                                             | Keeps `src/core/` honest and framework-free                                                                          |
| Spring Retry            | `maxAttempts`, backoff vocabulary, `recover` concept                                                                                                                             | Zero-cost familiarity for the target user                                                                            |
| TypeORM                 | `QueryRunner.transactionDepth` savepoint machinery (§4.2)                                                                                                                        | Already correct; we route to it instead of reimplementing                                                            |

### Improve

| Their behaviour                                                                     | Ours                                                                          | Why                                                                                                                    |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| No retry anywhere in the ecosystem                                                  | Owner-only retry with SQLSTATE classification, full jitter, wall-clock budget | The entire reason this library exists                                                                                  |
| Arity checks that throw at bootstrap (§1.3)                                         | Behavioural capability detection; degrade with a warning                      | A TypeORM patch release must not hard-crash every consumer                                                             |
| Commit hooks via `setImmediate`, unawaited, throwing hooks crash the process (§1.5) | Awaited after `COMMIT`, per-hook try/catch, errors logged not thrown          | Callers can await side effects; one bad listener can't take down the process                                           |
| Hooks are per-context                                                               | Hooks are **per-attempt**, reset on retry                                     | A hook registered during a failed attempt must never fire                                                              |
| `NESTED` silently means `REQUIRES_NEW` (§1.4)                                       | Real savepoints, retry disabled by default at savepoint level                 | Correctness — and `40001`/`40P01` abort the whole transaction anyway, so savepoint-level retry for them would be a lie |
| ALS driver silently swallows out-of-context writes (§1.1)                           | Explicit `isInTransaction()` / `getTransactionContext()`, no silent no-op     | Silent failure is the worst failure mode in a correctness library                                                      |
| 3 runtime dependencies                                                              | **Zero**                                                                      | Smaller install, no `cls-hooked` (which relies on `async_hooks` internals), no transitive CVE surface                  |

### Reject

| Idea                                             | Why not                                                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Multi-ORM adapter layer (`nestjs-cls` style)     | Declared non-goal. It costs the transparent-repository behaviour that makes migration one line                         |
| Retrying `08xxx` connection errors by default    | Unknown commit state → possible double-apply (§7)                                                                      |
| Per-query retry, as literally requested in #9806 | `40001` can surface at `COMMIT`; only whole-transaction retry is sound (§7)                                            |
| Savepoint-level retry for `40001` / `40P01`      | Both abort the entire transaction in Postgres — rolling back to a savepoint cannot recover it                          |
| Retry on inner (joined) `REQUIRED` methods       | Only the transaction owner can retry; anything else silently does nothing. We **throw at bootstrap** instead           |
| Hard-throwing version guards                     | See §1.3                                                                                                               |
| `cls-hooked`                                     | Unmaintained, depends on `async_hooks` internals, and `AsyncLocalStorage` is built in on every Node version we support |

---

## 9. Naming and discoverability

**Package name: `typeorm-resilient-transactional`** — verified unclaimed on npm 2026-08-11
(all of `typeorm-resilient-transactional`, `nestjs-transactional-retry`, `@resilient-tx/nestjs`,
`@resilient-tx/core`, `typeorm-transactional-retry`, and `resilient-transactional` return 404).
Chosen for keyword adjacency to the 172K/wk package users are migrating from.

```json
"keywords": [
  "typeorm", "nestjs", "transaction", "transactional", "retry", "deadlock",
  "serializable", "isolation-level", "postgres", "postgresql", "concurrency",
  "pessimistic-locking", "async-local-storage", "serialization-failure",
  "40001", "40P01", "write-skew", "sqlstate"
]
```

The bare SQLSTATE codes are deliberate: `40001` and `40P01` are what people paste into a search box
at 2am, and no existing package targets those strings.

## 10. Proposed ADRs

| ADR                                     | Decision                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `0001-async-local-storage`              | ALS over `cls-hooked`; why zero-dependency matters more than the ALS choice itself            |
| `0002-owner-only-retry`                 | Only the transaction owner retries; inner retry config throws at bootstrap                    |
| `0003-nested-savepoint-deviation`       | Real savepoints, deviating from `typeorm-transactional`; savepoint-level retry off by default |
| `0004-typeorm-dual-version-support`     | `^0.3.31 \|\| ^1` on a verified-identical patch surface                                       |
| `0005-no-connection-error-retry`        | Unknown commit state; opt-in only                                                             |
| `0006-behavioural-capability-detection` | No arity assertions; degrade with a warning                                                   |
| `0007-full-jitter-default`              | Jitter on by default, diverging from Spring; deadlocked peers are phase-locked                |
