# nestjs-bank-transfer

The canonical example: money moving between accounts, both ways of making that safe.

This is a **workspace member**, typechecked in CI against the library source — so if the API changes
and this stops compiling, the build fails. The README's snippets come from here.

## What to look at

| File                    | Shows                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `src/main.ts`           | Bootstrap order — why `initializeResilientContext()` must run before NestJS builds repositories |
| `src/app.module.ts`     | `forRoot()` defaults, retry policy, `onRetry`/`onExhausted`, a `RetryMetrics` implementation    |
| `src/ledger.service.ts` | Both strategies side by side, and `runOnCommit()` for the notification                          |

## The two strategies

`transfer()` uses **SERIALIZABLE + retry**. It reads a balance, decides, then writes — the
read-then-write shape that weaker isolation gets silently wrong under concurrency. Retry is what
makes that affordable.

`transferWithLocks()` uses **READ COMMITTED + `lockRowsInOrder()`**. Because a transfer names its two
accounts up front, they can be locked in a deterministic global order, so opposing transfers cannot
deadlock. [Measurably faster](../../benchmarks/RESULTS.md) under contention.

Neither is universally right. Use the first when you need a correctness property only serializability
provides; the second when you can enumerate the rows.

## The part worth copying

```ts
await this.accounts.decrement({ id: fromId }, 'balance', amount);
await this.accounts.increment({ id: toId }, 'balance', amount);

runOnCommit(() => this.notifier.transferCompleted(toId, amount));
```

The two writes re-run on every retry. The notification does not — it fires once, after commit, and
never at all if the transaction is abandoned. Sending it inline would email the customer once per
attempt. See [safety.md](../../docs/safety.md).

## Running it

```bash
docker run --rm -d -p 5432:5432 \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=bank \
  postgres:17-alpine

pnpm install
DATABASE_URL=postgres://test:test@localhost:5432/bank pnpm start
```
