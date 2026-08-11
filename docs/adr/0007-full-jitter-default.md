# 7. Full jitter is the default, diverging from Spring

- **Status:** accepted
- **Date:** 2026-08-11

## Context

Spring Retry's `@Backoff` defaults `random` to `false` — plain exponential backoff. Most retry
libraries follow suit, treating jitter as an option for the sophisticated.

That default is wrong for the specific failure this library retries.

Two transactions that just deadlocked are **synchronised by construction**. PostgreSQL's deadlock
detector kills one at the same instant it lets the other proceed. Both then compute
`base * 2^attempt`, get the same number, sleep the same duration, wake together, and acquire locks
in the same conflicting order — deadlocking again. Undithered exponential backoff makes each
successive collision _more_ expensive, not less likely.

The same reasoning applies to `40001`: transactions contending over the same rows are released
into a retry at correlated times.

## Decision

Default to `exponential-full-jitter` with `baseMs: 25`, `capMs: 500`:

```
delay = random(0, min(capMs, baseMs * 2 ** (attempt - 1)))
```

Keep `fixed`, `linear`, `exponential`, and arbitrary functions available for callers who want them.

## Consequences

Retrying peers land on different milliseconds, so the second attempt has a real chance of
succeeding rather than reproducing the first.

Individual delays become unpredictable, which makes latency reasoning harder — a retry may fire
immediately or after the full ceiling. `capMs` bounds the worst case, and `timeoutMs` bounds the
total across all attempts, so the tail stays controllable.

We diverge from Spring's default deliberately. Anyone arriving from that ecosystem gets different
behaviour under the same-looking configuration, which is why the strategy is named explicitly in
the type rather than hidden behind a boolean.

`test/unit/backoff.spec.ts` demonstrates the mechanism directly: undithered exponential collides on
1000 of 1000 sampled pairs, full jitter on fewer than 100. That is a simulation of the delay
distribution, not a throughput measurement — the real contention numbers come from the Phase 7
benchmarks, and if they contradict this reasoning, this ADR gets revised rather than defended.
