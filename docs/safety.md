# Safety

Retry is not free and it is not invisible. It re-runs your method body. Everything below is a way
that can go wrong, with the fix.

Read §1 even if you read nothing else.

**Contents:** [Side effects](#1-retry-re-runs-the-whole-method-body) ·
[In-memory state](#2-in-memory-mutation-accumulates-across-attempts) ·
[Non-deterministic reads](#3-clocks-random-ids-and-external-reads-make-attempts-diverge) ·
[Nested transactions](#4-nested-transactions-never-retry) ·
[Connection errors](#5-connection-errors-are-not-retried-by-default) ·
[Cost](#6-retries-are-not-free)

---

## 1. Retry re-runs the whole method body

PostgreSQL raises `40001` whenever its serializable-snapshot machinery notices the conflict — which
may be at the offending statement, or deferred to **`COMMIT`** once everything has already appeared
to succeed. Both happen; neither is predictable. Either way the entire transaction is aborted, so
there is nothing to retry but the whole thing.

So this method sends two emails when it retries once:

```ts
// ✗ BROKEN
@Transactional({ isolation: 'SERIALIZABLE', retry: { maxAttempts: 5 } })
async transfer(from: string, to: string, amount: number) {
  await this.accounts.decrement({ id: from }, 'balance', amount);
  await this.accounts.increment({ id: to }, 'balance', amount);

  await this.mailer.send(to, 'You received a payment');   // ← runs on every attempt
  await this.stripe.charges.create({ amount });           // ← charges twice
  await this.kafka.publish('transfer.completed', { from, to });
}
```

Move anything that is not a database write into `runOnCommit`. It runs once, after the transaction
is durable, and never for an attempt that failed:

```ts
// ✓ FIXED
@Transactional({ isolation: 'SERIALIZABLE', retry: { maxAttempts: 5 } })
async transfer(from: string, to: string, amount: number) {
  await this.accounts.decrement({ id: from }, 'balance', amount);
  await this.accounts.increment({ id: to }, 'balance', amount);

  runOnCommit(async () => {
    await this.mailer.send(to, 'You received a payment');
    await this.kafka.publish('transfer.completed', { from, to });
  });
}
```

The rule of thumb: **if undoing it requires more than `ROLLBACK`, it belongs in `runOnCommit`.**

### Commit hooks run outside the transaction

By the time a commit hook fires, the transaction is over. That is deliberate — a hook that queries
the database gets a pooled connection rather than the finished transaction's. Two consequences:

- `getTransactionContext()`, `isInTransaction()`, and `currentAttempt()` all report "no
  transaction" inside a hook. Capture what you need at registration time:

  ```ts
  const attempt = currentAttempt();
  runOnCommit(() => metrics.record({ attempt }));
  ```

- A hook that throws is **logged and swallowed**. The transaction is already durable; failing the
  caller afterwards would misrepresent what happened. If delivery matters, write to an outbox table
  inside the transaction instead.

### The library tells you when this happens

The first time a method is retried, you get one warning naming it:

```
[typeorm-resilient-transactional] transfer was retried, so its body ran more than once.
Anything it does outside the database — emails, webhooks, payments, queue publishes —
happened again. Move those into runOnCommit(). See docs/safety.md.
```

Route it wherever your logs go with `setDiagnosticHandler()`.

---

## 2. In-memory mutation accumulates across attempts

The transaction rolls back. Your JavaScript objects do not.

```ts
// ✗ BROKEN
class ReportService {
  private processed: string[] = [];

  @Transactional({ retry: { maxAttempts: 3 } })
  async build(ids: string[]) {
    for (const id of ids) {
      await this.rows.insert({ id });
      this.processed.push(id); // ← 3 attempts leaves 3× the entries
    }
    return this.processed.length;
  }
}
```

After two retries `processed` holds every id three times, and the returned count is wrong. Class
fields, module-level caches, and arrays captured from an enclosing scope all behave this way.

Keep per-attempt state inside the method, so each attempt starts from nothing:

```ts
// ✓ FIXED
@Transactional({ retry: { maxAttempts: 3 } })
async build(ids: string[]) {
  const processed: string[] = [];      // ← fresh on every attempt
  for (const id of ids) {
    await this.rows.insert({ id });
    processed.push(id);
  }
  return processed.length;
}
```

Mutating an argument has the same problem, because the caller's object survives the rollback. Treat
inputs as read-only and return new values.

---

## 3. Clocks, random IDs, and external reads make attempts diverge

A retried attempt should do the _same work_. Anything read from outside the database changes
between attempts.

```ts
// ✗ BROKEN
@Transactional({ retry: { maxAttempts: 5 } })
async createInvoice(customerId: string) {
  const id = randomUUID();                        // ← different id per attempt
  const issuedAt = new Date();                    // ← different timestamp per attempt
  const rate = await this.fx.getRate('USD');      // ← an HTTP call per attempt, possibly a different rate

  await this.invoices.insert({ id, customerId, issuedAt, rate });
  return id;
}
```

Generate identifiers and capture the clock **before** the transaction, and pass them in:

```ts
// ✓ FIXED
async createInvoice(customerId: string) {
  const id = randomUUID();
  const issuedAt = new Date();
  const rate = await this.fx.getRate('USD');      // one HTTP call, outside the transaction

  return this.persistInvoice({ id, customerId, issuedAt, rate });
}

@Transactional({ retry: { maxAttempts: 5 } })
private async persistInvoice(invoice: NewInvoice) {
  await this.invoices.insert(invoice);
  return invoice.id;
}
```

This also keeps a slow third-party call out of your transaction, which is worth doing regardless of
retry — an open transaction holding locks while it waits on an HTTP round trip is its own problem.

---

## 4. Nested transactions never retry

Only the transaction **owner** can retry. Re-running a method that _joined_ someone else's
transaction would replay half of it, against a query runner whose transaction the error already
aborted.

```ts
// ✗ THROWS RetryNotPermittedError on the first call
@Transactional({ retry: { maxAttempts: 5 } })   // this method is usually called from another @Transactional
async debit(accountId: string, amount: number) { ... }
```

Rather than ignore the setting, the library refuses it — because code that looks like it retries and
does not is worse than code that plainly does not.

```
         ┌─ transfer()  @Transactional({ retry })   ← owner: retries here
         │
         ├──── debit()  @Transactional()            ← joins; retry would throw
         │
         └──── credit() @Transactional()            ← joins; retry would throw
```

Put retry on the **outermost** `@Transactional()` — the one that opens the transaction. That is also
the only place a wall-clock `timeoutMs` is meaningful.

If an inner step genuinely needs to retry on its own, declare `REQUIRES_NEW` and accept that it
commits separately from its caller.

**`NESTED` cannot retry either**, and not for a policy reason. PostgreSQL aborts the _entire_
transaction on `40001` and `40P01` — after either, even `ROLLBACK TO SAVEPOINT` is rejected. A
savepoint cannot recover from the two errors you would most want to retry. See
[ADR 0002](adr/0002-owner-only-retry.md).

---

## 5. Connection errors are not retried by default

> **If the connection drops during `COMMIT`, nobody knows whether the commit happened.**
>
> The client sent the commit and never got the acknowledgement. The server may have applied it, or
> may not have. Retrying can **apply the transaction twice**.

That is why Class 08 SQLSTATEs — `08000`, `08001`, `08003`, `08004`, `08006` — are **not** in the
default retry set, and why `57014` (`query_canceled`, usually a `statement_timeout`) is not either.
Retrying a query that already exhausted its time budget amplifies the load that caused it.

Refusing to guess is the feature. The library cannot know whether your transaction is idempotent;
you can.

If it is — a pure insert with a unique key, say — opt in explicitly:

```ts
@Transactional({
  retry: { retryOn: [...DEFAULT_RETRYABLE_SQLSTATES, '08006'] },
})
async recordEvent(event: Event) { ... }
```

You will get one warning telling you exactly what you accepted. See
[ADR 0005](adr/0005-no-connection-error-retry.md).

---

## 6. Retries are not free

Under heavy contention, retries add load to a system that is already struggling. Every retry is a
transaction's worth of work thrown away and repeated, and if the conflict rate is high enough,
retrying makes throughput _worse_ rather than better.

Three settings bound that:

| Setting         | Bounds                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| `maxAttempts`   | how many times one transaction may repeat (default 3)                      |
| `backoff.capMs` | the longest single wait (default 500ms)                                    |
| `timeoutMs`     | wall-clock across **all** attempts — the only one that bounds tail latency |

`timeoutMs` is the one people forget. Without it, `maxAttempts: 10` with an exponential cap of 500ms
can take five seconds before failing, and your HTTP request has long since timed out.

### How many attempts a conflict actually needs depends on the host, not just the workload

A retry does not automatically succeed. The loser of a conflict re-reads the same rows, and if the
winner's `COMMIT` is still in flight it sees the same state and conflicts again. So the number of
attempts a transaction needs tracks **how long the winner holds its transaction open**, which
stretches when the machine is busy.

Measured on `postgres:17-alpine`, two sessions racing over the on-call-doctors write skew
(`test/integration/hooks.spec.ts`), full-jitter backoff with `baseMs: 1, capMs: 20`:

| Host                        | Rounds | Rounds needing a third attempt |
| --------------------------- | -----: | -----------------------------: |
| Idle 12-core machine        |    120 |                              0 |
| Same machine, CPU saturated |    620 |                      17 (1–4%) |

On an idle host the retry always succeeded on the second attempt. Under CPU pressure the chain
lengthened — with the same database, the same query, and the same conflict. A budget tuned on a quiet
laptop can therefore be too small on a loaded production box or a shared CI runner.

Size `maxAttempts` for the loaded case, and use `timeoutMs` rather than a small attempt count to
bound tail latency. The two do different jobs: `maxAttempts` decides how hard to try, `timeoutMs`
decides how long the caller is willing to wait.

Jitter is on by default because two transactions that just deadlocked are synchronised — PostgreSQL
killed one at the instant it let the other proceed. Without jitter they back off by the same amount,
wake together, and deadlock again. See [ADR 0007](adr/0007-full-jitter-default.md).

**If your retry rate is high, retry is treating a symptom.** Fix the contention instead:

- acquire locks in a consistent order — see [lock ordering](lock-ordering.md) _(Phase 5)_
- shorten transactions; do not hold locks across network calls (§3)
- consider whether `READ COMMITTED` with explicit locking fits the workload better than
  `SERIALIZABLE`

### This is measured, not asserted

From [`benchmarks/RESULTS.md`](../benchmarks/RESULTS.md), 600 contended transfers per
configuration against a containerised PostgreSQL 17:

| 100 concurrent workers            | Unretried SERIALIZABLE |     + retry | READ COMMITTED + ordered locks |
| --------------------------------- | ---------------------: | ----------: | -----------------------------: |
| **1,000 accounts** — failure rate |                    87% |      **0%** |                             0% |
| **1,000 accounts** — throughput   |              109 ops/s | 109.8 ops/s |                      382 ops/s |
| **10 accounts** — failure rate    |                    96% |         49% |                             0% |
| **10 accounts** — throughput      |              6.3 ops/s |   6.6 ops/s |                    101.7 ops/s |

Two things to take from that.

**Retry does what it claims.** At realistic contention it turns an 87% failure rate into
zero. That is the difference between SERIALIZABLE being unusable and usable.

**Retry does not make anything faster.** Under pathological contention its throughput
_falls_ as workers are added — 77.6 ops/s at concurrency 1 down to 6.6 at concurrency 100 —
because every conflict throws away a whole transaction's work. Ordered pessimistic locking
was faster at every concurrency level we measured, in both profiles.

So: reach for SERIALIZABLE + retry when you need a correctness property only
serializability gives you — write skew across rows you cannot name in advance. Reach for
[`lockRowsInOrder()`](lock-ordering.md) when you _can_ name the rows. This library ships
both because neither is the right answer everywhere.

Numbers vary by machine; re-run `pnpm bench` on yours before quoting them.

---

## Checklist

Before shipping a method with `retry` enabled:

- [ ] No emails, webhooks, payments, or queue publishes outside `runOnCommit`
- [ ] No mutation of class fields, captured arrays, or arguments
- [ ] IDs and timestamps generated before the transaction, not inside it
- [ ] No HTTP calls inside the transaction
- [ ] `retry` is on the outermost `@Transactional()`, not an inner one
- [ ] `timeoutMs` set if the caller has a deadline
- [ ] You have decided, deliberately, whether connection errors are retryable here
