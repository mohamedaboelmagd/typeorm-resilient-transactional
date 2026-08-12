# Lock ordering: does `ORDER BY … FOR UPDATE` actually lock in order?

Surviving deadlocks is what retry is for. Not having them is better.

A deadlock needs two transactions to take the same locks in opposite orders. If every transaction
sorts its identifiers first, the cycle cannot form — this is the application-level fix PostgreSQL's
own [Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) documentation
recommends.

Implementing that raises a question I could not answer from the documentation:

> Does `SELECT … WHERE id = ANY($1) ORDER BY id FOR UPDATE` acquire its row locks in `ORDER BY`
> order — under **every** plan shape?

If yes, `lockRowsInOrder` is one round trip. If no, it needs one statement per row. PostgreSQL
documents the _result_ ordering of `ORDER BY`; it does not promise anything about the order in which
`FOR UPDATE` takes locks.

So I measured it.

**Answer: yes — locks are acquired in `ORDER BY` order under index-scan, bitmap-heap-scan, and
sequential-scan plans.** `lockRowsInOrder` uses the single-statement form by default. The evidence
is below, along with the cases where it still falls back to row-by-row.

---

## 1. Setup

```
PostgreSQL 17.10 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit
```

```sql
CREATE TABLE lockorder (id int PRIMARY KEY, value int NOT NULL);
INSERT INTO lockorder (id, value) SELECT g, 0 FROM generate_series(1, 20000) g;
ANALYZE lockorder;
```

20,000 rows so the planner has a realistic choice, and each plan shape is forced with
`SET LOCAL enable_seqscan / enable_bitmapscan / enable_indexscan / enable_indexonlyscan`.

---

## 2. What the planner builds

`EXPLAIN (ANALYZE, VERBOSE, COSTS OFF, TIMING OFF, SUMMARY OFF)` for

```sql
SELECT id FROM lockorder WHERE id = ANY('{7,3,11,5,9}') ORDER BY id FOR UPDATE
```

### Index scan

```
LockRows (actual rows=5 loops=1)
  Output: id, ctid
  ->  Index Scan using lockorder_pkey on public.lockorder (actual rows=5 loops=1)
        Output: id, ctid
        Index Cond: (lockorder.id = ANY ('{7,3,11,5,9}'::integer[]))
```

No `Sort` node at all. The planner is relying on the index to deliver rows in `id` order — a btree
index scan with `= ANY(array)` sorts and deduplicates the array internally, so the output is ordered
without an explicit sort step.

### Bitmap heap scan

```
LockRows (actual rows=5 loops=1)
  Output: id, ctid
  ->  Sort (actual rows=5 loops=1)
        Output: id, ctid
        Sort Key: lockorder.id
        Sort Method: quicksort  Memory: 25kB
        ->  Bitmap Heap Scan on public.lockorder (actual rows=5 loops=1)
              Output: id, ctid
              Recheck Cond: (lockorder.id = ANY ('{7,3,11,5,9}'::integer[]))
              Heap Blocks: exact=1
              ->  Bitmap Index Scan on lockorder_pkey (actual rows=5 loops=1)
                    Index Cond: (lockorder.id = ANY ('{7,3,11,5,9}'::integer[]))
```

### Sequential scan

```
LockRows (actual rows=5 loops=1)
  Output: id, ctid
  ->  Sort (actual rows=5 loops=1)
        Output: id, ctid
        Sort Key: lockorder.id
        Sort Method: quicksort  Memory: 25kB
        ->  Seq Scan on public.lockorder (actual rows=5 loops=1)
              Output: id, ctid
              Filter: (lockorder.id = ANY ('{7,3,11,5,9}'::integer[]))
              Rows Removed by Filter: 19995
```

### The structural observation

**`LockRows` is the topmost node in all three plans.** A bitmap or sequential scan gets a `Sort`
underneath it; an index scan supplies the ordering itself. Either way, `LockRows` consumes
already-ordered output, so it locks in that order.

That is a strong argument. It is not a measurement.

---

## 3. Measuring the acquisition order directly

Plan shape suggests the answer; it does not prove it. Three sessions do.

```
Session A ── locks row 5, holds it
Session B ── SELECT … WHERE id = ANY('{9,5,1}') ORDER BY id FOR UPDATE   ← must stall on row 5
Session C ── probes which rows B actually took, using FOR UPDATE NOWAIT
```

The array is deliberately `{9, 5, 1}`, not ascending, so array order and `ORDER BY` order disagree.
Session C's probe then distinguishes them:

| C observes               | Conclusion                                                     |
| ------------------------ | -------------------------------------------------------------- |
| row 1 locked, row 9 free | B locked **ascending** — took 1, stalled at 5, never reached 9 |
| row 9 locked, row 1 free | B locked in **array order** — took 9 first                     |

Each probe runs inside a `SAVEPOINT` so a refused `NOWAIT` lock does not abort the probing
transaction.

### Result

| Forced plan      | Verdict                                                 |
| ---------------- | ------------------------------------------------------- |
| Index scan       | **ASCENDING** — locked 1, stopped at 5, never reached 9 |
| Bitmap heap scan | **ASCENDING** — locked 1, stopped at 5, never reached 9 |
| Sequential scan  | **ASCENDING** — locked 1, stopped at 5, never reached 9 |

`ORDER BY` drives lock acquisition under every plan shape tested.

---

## 4. What this earns, and what it does not

`lockRowsInOrder` uses **one round trip** by default:

```sql
SELECT … WHERE id = ANY($1) ORDER BY <pk> ASC FOR UPDATE
```

Two honest caveats.

**This is observed behaviour, not a documented guarantee.** PostgreSQL does not promise a lock
acquisition order for multi-row `FOR UPDATE`. The structural reason it holds — `LockRows` sitting
above the ordering step — is stable and long-standing, but it is an implementation detail.

The test suite therefore asserts _both_ the behaviour and the plan structure. The probe above was
run directly against **PostgreSQL 17.10** and **PostgreSQL 14** — both ends of the supported range —
and passes identically on each; the CI matrix runs the same assertions on **14, 15, 16, and 17**.
If a future planner pushes `LockRows` below the `Sort`, the build fails before anyone's production
system does.

**It only holds for orderings SQL can express.** A JavaScript comparator cannot be handed to
`ORDER BY`, so the database would be free to lock in a different order than you asked for. Those
cases fall back to row-by-row automatically:

| Situation                                   | Strategy           | Why                                                         |
| ------------------------------------------- | ------------------ | ----------------------------------------------------------- |
| Single-column primary key, default ordering | `single-statement` | 1 round trip; `ORDER BY` is authoritative                   |
| Custom `comparator`                         | `row-by-row`       | Only this process can apply the comparator                  |
| Composite primary key                       | `row-by-row`       | Ordering across columns is the caller's semantics, not ours |

Asking for `single-statement` where it cannot be honoured throws rather than silently locking in the
wrong order.

---

## 5. Does ordering actually prevent deadlocks?

Two tests, one contrast.

**Unordered — deadlocks reliably.** Two transactions take rows `[1, 2]` and `[2, 1]` one at a time,
with a barrier between the first and second lock so the interleaving is exact. PostgreSQL kills one
with `40P01`, every time.

**Ordered — never deadlocks.** The same two transactions, handed the same opposite orders, but
routed through `lockRowsInOrder`. Both sort to `[1, 2]`. 25 iterations, both strategies, zero
deadlocks, and both transactions' updates applied exactly once.

The ordered test uses **no barrier**, and that is the finding rather than an omission: once both
sessions sort, whichever arrives first takes _both_ rows and the other blocks until it commits. The
two can no longer interleave, so a rendezvous between them is unreachable by construction.
Serialising them is precisely what removes the cycle.

---

## 6. Using it

```ts
import { lockRowsInOrder, withLockTimeout } from 'typeorm-resilient-transactional';

@Transactional({ retry: { maxAttempts: 5 } })
async transfer(fromId: string, toId: string, amount: number) {
  const manager = getTransactionContext()!.manager;

  // Whatever order the caller passed, both accounts are locked in the same
  // global order — so two opposing transfers cannot deadlock.
  await lockRowsInOrder(manager, Account, [fromId, toId]);

  await this.accounts.decrement({ id: fromId }, 'balance', amount);
  await this.accounts.increment({ id: toId }, 'balance', amount);
}
```

Tenant-scoped or composite keys, where the order is your semantics rather than the primary key's:

```ts
await lockRowsInOrder(manager, Ledger, entries, {
  comparator: (a, b) => a.tenantId.localeCompare(b.tenantId) || a.seq - b.seq,
});
```

### Bounding the wait

`withLockTimeout` turns an unbounded stall behind someone else's long transaction into a fast,
**retryable** failure — `55P03` is in the default retry set:

```ts
await withLockTimeout(manager, 250, () => lockRowsInOrder(manager, Account, ids));
```

`withStatementTimeout` bounds execution instead, raising `57014`, which is **not** retried by
default — a query that already exhausted its budget will usually exhaust it again, and retrying
amplifies the load that caused it.

Both restore the previous setting when they finish. Both are best-effort about that restore: if the
timeout fired, the transaction is aborted and every further statement fails with `25P02`, so
propagating the restore's failure would replace your `55P03` with a meaningless "transaction is
aborted". The original error wins.

---

## 7. Reproducing this

```bash
pnpm preflight
pnpm vitest run --project integration lock-ordering
```

Against another PostgreSQL version:

```bash
PG_IMAGE=postgres:14-alpine pnpm vitest run --project integration lock-ordering
```

The experiment lives in `test/integration/lock-ordering.spec.ts`. Everything on this page came out
of that file; nothing here is estimated.
