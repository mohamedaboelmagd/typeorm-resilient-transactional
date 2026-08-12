# typeorm-resilient-transactional

> `@Transactional()` for NestJS + TypeORM that survives deadlocks and serialization failures — so
> you can actually use `SERIALIZABLE` in production.

[![npm](https://img.shields.io/npm/v/typeorm-resilient-transactional.svg)](https://www.npmjs.com/package/typeorm-resilient-transactional)
[![CI](https://github.com/mohamedaboelmagd/typeorm-resilient-transactional/actions/workflows/ci.yml/badge.svg)](https://github.com/mohamedaboelmagd/typeorm-resilient-transactional/actions/workflows/ci.yml)
![coverage](https://img.shields.io/badge/coverage-95%25-brightgreen)
![bundle size](https://img.shields.io/badge/bundle-6.9%20kB-blue)
![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## The problem

```ts
@Transactional({ isolation: 'SERIALIZABLE' })
async transfer(from: string, to: string, amount: number) {
  const balance = await this.accounts.findOneByOrFail({ id: from });
  if (balance.amount < amount) throw new InsufficientFunds();

  await this.accounts.decrement({ id: from }, 'amount', amount);
  await this.accounts.increment({ id: to }, 'amount', amount);
}
// 💥 QueryFailedError: could not serialize access due to read/write dependencies
```

PostgreSQL raises `40001` at **`COMMIT`** — after every statement has already appeared to succeed.
Under 100 concurrent workers, [we measured](benchmarks/RESULTS.md) **87% of these transactions
failing**. That is why teams quietly drop back to `READ COMMITTED` and ship write-skew bugs.

## The fix

```ts
@Transactional({ isolation: 'SERIALIZABLE', retry: { maxAttempts: 5 } })
async transfer(from: string, to: string, amount: number) {
  /* unchanged */
}
// ✅ rolls back, backs off with full jitter, re-runs the whole transaction
```

Same workload, same concurrency: **0% failures.**

## Install

```bash
npm i typeorm-resilient-transactional
```

Peers: `typeorm@^0.3.31 || ^1`, and `@nestjs/common@^10 || ^11` if you use the NestJS module.
**Zero runtime dependencies.** Node ≥ 20.

## Quickstart

```ts
// main.ts — before anything creates a repository
import {
  initializeResilientContext,
  addResilientDataSource,
} from 'typeorm-resilient-transactional';

initializeResilientContext();
addResilientDataSource(dataSource);
```

```ts
// app.module.ts
import { ResilientTransactionalModule } from 'typeorm-resilient-transactional/nestjs';

@Module({
  imports: [
    TypeOrmModule.forRoot({/* ... */}),
    ResilientTransactionalModule.forRoot({
      defaultIsolation: 'READ COMMITTED',
      retry: { maxAttempts: 3 },
      onRetry: (info) => metrics.increment('tx.retry', { code: info.sqlstate }),
    }),
  ],
})
export class AppModule {}
```

```ts
// ledger.service.ts
import { Transactional, runOnCommit } from 'typeorm-resilient-transactional';

class LedgerService {
  @Transactional({ isolation: 'SERIALIZABLE', retry: { maxAttempts: 5 }, timeoutMs: 5_000 })
  async post(cmd: PostEntry) {
    const id = await this.entries.insert(cmd);

    // Side effects go here — the body re-runs on retry, this does not.
    runOnCommit(() => this.events.publish(new EntryPosted(id)));

    return id;
  }
}
```

Repositories injected the normal way resolve to the transactional manager automatically. No
`TransactionHost`, no threading a manager through every signature.

A runnable version is in [`examples/nestjs-bank-transfer`](examples/nestjs-bank-transfer).

## Comparison

|                                          | this library |   `typeorm-transactional`   | `nestjs-cls` + plugin |       hand-rolled loop        |
| ---------------------------------------- | :----------: | :-------------------------: | :-------------------: | :---------------------------: |
| `@Transactional()` with propagation      |      ✅      |             ✅              | via `TransactionHost` |              ❌               |
| **Automatic retry on `40001` / `40P01`** |      ✅      |             ❌              |          ❌           | you write it, in every method |
| Runtime dependencies                     |    **0**     |              3              |           0           |               0               |
| `NESTED` = real savepoints               |      ✅      | ❌ (acts as `REQUIRES_NEW`) |          ✅           |               —               |
| Hooks discarded on a failed attempt      |      ✅      |             n/a             |          n/a          |            rarely             |
| Lock-ordering helpers                    |      ✅      |             ❌              |          ❌           |              ❌               |
| Retry telemetry / OTel span attributes   |      ✅      |             ❌              |          ❌           |              ❌               |
| Repositories work unchanged              |      ✅      |             ✅              |          ❌           |              ✅               |

Migrating from `typeorm-transactional` is [one import line](MIGRATION.md). The behavioural parity is
[asserted in CI](test/compat) against the real package, not claimed.

## ⚠️ Retry re-runs your method body

> Everything the method does **outside the database happens again** — emails, webhooks, Stripe
> charges, queue publishes. Put them in `runOnCommit()`, which fires once, after commit, and never
> for an attempt that failed.
>
> **Connection errors are not retried by default.** If the connection drops during `COMMIT`, nobody
> knows whether the commit landed; retrying could apply the transaction twice. Refusing to guess is
> a feature.

Six ways this bites and how to avoid each: **[docs/safety.md](docs/safety.md)**.

## Benchmarks

100 concurrent workers, 600 contended transfers, 1,000 accounts, PostgreSQL 17
([full matrix](benchmarks/RESULTS.md), `pnpm bench`):

| Strategy                         |  Throughput |      p99 | Failure rate |
| -------------------------------- | ----------: | -------: | -----------: |
| `SERIALIZABLE`, no retry         |   109 ops/s |   623 ms |      **87%** |
| `SERIALIZABLE` + retry           | 109.8 ops/s | 3,794 ms |       **0%** |
| `READ COMMITTED` + ordered locks |   382 ops/s |   619 ms |           0% |

Read that honestly: **retry makes `SERIALIZABLE` usable, not fast.** When you can name the rows a
transaction will touch, ordered pessimistic locking is faster and degrades more gracefully — which
is why [`lockRowsInOrder()`](docs/lock-ordering.md) ships here too. Use `SERIALIZABLE` + retry when
you need a correctness property only serializability provides; use ordered locks when you can
enumerate the rows. Measure your own workload.

Money conservation was asserted at every point on the matrix.

## API

<details>
<summary><b>Bootstrap</b></summary>

```ts
initializeResilientContext(): void;
addResilientDataSource(ds: DataSource | { dataSource, name?, patch? }): DataSource;
getDataSourceByName(name?: string): DataSource;
```

Call `initializeResilientContext()` before anything creates a repository — the
`Repository.prototype` patch has to be installed first.

</details>

<details>
<summary><b>Running transactions</b></summary>

```ts
@Transactional(options?: TransactionOptions)

runInResilientTransaction<T>(fn: (manager) => Promise<T>, options?): Promise<T>;
wrapInResilientTransaction<F>(fn: F, options?): F;

interface TransactionOptions {
  propagation?: Propagation;          // REQUIRED (default) | REQUIRES_NEW | NESTED | SUPPORTS
                                      // | NOT_SUPPORTED | MANDATORY | NEVER
  isolation?: IsolationLevel;         // also accepts `isolationLevel`
  retry?: RetryConfig | false;
  timeoutMs?: number;                 // wall-clock across ALL attempts
  dataSourceName?: string;            // also accepts `connectionName`
  onRetry?: (info: RetryInfo) => void;
  onExhausted?: (info: RetryInfo) => void;
}

interface RetryConfig {
  enabled?: boolean;
  maxAttempts?: number;               // default 3
  retryOn?: readonly string[];        // default ['40001', '40P01', '55P03']
  backoff?: {
    strategy?: 'fixed' | 'linear' | 'exponential' | 'exponential-full-jitter'
             | ((attempt: number) => number);   // default 'exponential-full-jitter'
    baseMs?: number;                  // default 25
    capMs?: number;                   // default 500
  };
}
```

**Retry is only valid where the call owns its transaction.** Configuring it on a method that joins
one throws `RetryNotPermittedError` rather than silently doing nothing —
[why](docs/adr/0002-owner-only-retry.md).

</details>

<details>
<summary><b>Lifecycle hooks</b></summary>

```ts
runOnCommit(cb: () => void | Promise<void>): void;
runOnRollback(cb: (error: unknown) => void | Promise<void>): void;
runOnComplete(cb: (error: unknown) => void | Promise<void>): void;
runOnRetry(cb: (info: RetryInfo) => void): void;
```

Commit hooks run **exactly once**, after `COMMIT`, outside the transaction context, awaited. Hooks
registered during an attempt that failed are discarded. A hook that throws is logged, not rethrown —
the transaction is already durable.

`runOnTransactionCommit` / `Rollback` / `Complete` are aliases, for drop-in compatibility.

</details>

<details>
<summary><b>Locking</b></summary>

```ts
lockRowsInOrder(manager, Entity, ids, options?): Promise<Entity[]>;
withLockTimeout(manager, ms, fn): Promise<T>;      // bounded lock wait  → 55P03 (retryable)
withStatementTimeout(manager, ms, fn): Promise<T>; // bounded execution  → 57014 (not retried)
```

`lockRowsInOrder` sorts and deduplicates, then locks in one statement — [verified](docs/lock-ordering.md)
to acquire in `ORDER BY` order across index-scan, bitmap-heap-scan, and sequential-scan plans. Pass
`Entity`, not a table name: the primary key is resolved through TypeORM metadata.

</details>

<details>
<summary><b>Introspection and observability</b></summary>

```ts
getTransactionContext(name?): TransactionContext | undefined;
isInTransaction(name?): boolean;
currentAttempt(name?): number;                     // 1-based; 0 outside a transaction

setResilientDefaults(defaults: ResilientDefaults): void;
setDiagnosticHandler(handler): void;               // route warnings to your logger
```

`RetryMetrics` is an interface with no implementation and no dependency — implement the two or three
methods your monitoring needs. If `@opentelemetry/api` is installed, the active span is annotated
with `db.transaction.attempt`, `db.transaction.isolation`, and `db.transaction.retry_reason`; if it
is not, that is a silent no-op.

</details>

## FAQ

**Does it work without NestJS?** Yes. The core imports nothing from NestJS; the module lives at a
separate `/nestjs` entry point so the root import never requires `@nestjs/common`.

**MySQL or SQL Server?** PostgreSQL is first-class and the only dialect we test. `RetryableErrorMap`
is exported so you can supply your own codes — but we will not claim support we have not measured.

**Why did my retry setting throw?** It was on a method that joins a caller's transaction. Move it to
the outermost `@Transactional()`, or use `REQUIRES_NEW`.

**Is `NESTED` really different here?** Yes — real savepoints, where `typeorm-transactional` opens an
independent transaction. It is the one intentional behavioural difference, asserted in both
directions in `test/compat/`. See [ADR 0003](docs/adr/0003-nested-savepoint-deviation.md).

## Non-goals

Not an ORM, query builder, or repository abstraction. No TypeORM 0.2.x. No distributed transactions,
2PC, or sagas. No HTTP-layer idempotency keys. No MongoDB.

## Documentation

|                                        |                                                               |
| -------------------------------------- | ------------------------------------------------------------- |
| [Safety](docs/safety.md)               | What retry re-executes, and the six ways it bites             |
| [Lock ordering](docs/lock-ordering.md) | The `ORDER BY … FOR UPDATE` experiment, with `EXPLAIN` output |
| [Internals](docs/internals.md)         | Exactly what we patch and why                                 |
| [Migration](MIGRATION.md)              | From `typeorm-transactional`                                  |
| [Prior art](docs/prior-art.md)         | What we copied, improved, and rejected                        |
| [ADRs](docs/adr)                       | Why each decision went the way it did                         |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Every claim in this README is backed by a test or a
benchmark; please keep it that way.

## License

MIT
