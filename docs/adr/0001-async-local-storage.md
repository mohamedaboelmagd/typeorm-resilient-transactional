# 1. AsyncLocalStorage, and zero runtime dependencies

- **Status:** accepted
- **Date:** 2026-08-11

## Context

The transactional `EntityManager` has to reach repositories several call frames deep without being
threaded through every signature. The ecosystem offers three mechanisms: `cls-hooked`, `zone.js`,
and Node's built-in `AsyncLocalStorage`.

`typeorm-transactional` supports both `cls-hooked` and ALS behind a `StorageDriver` interface, and
**declares `cls-hooked`, `@types/cls-hooked`, and `semver` as runtime `dependencies`** — so every
consumer installs all three regardless of which driver they select.

## Decision

Use `AsyncLocalStorage` exclusively. Ship **zero runtime dependencies**; everything else is a peer.

Do not offer a driver abstraction. There is nothing to select between.

## Consequences

`cls-hooked` reaches into `async_hooks` internals and is effectively unmaintained; ALS is a stable
public API present in every Node version we support (`>=20`).

Zero dependencies means no transitive CVE surface and no version-resolution conflicts in consumer
lockfiles — a meaningful claim for a library that sits in the transaction path of financial code.

We give up the ability to run on a runtime without `AsyncLocalStorage`. Given `engines.node >= 20`
this costs nothing.

**ALS is not a differentiator on its own.** `typeorm-transactional` already ships an ALS driver.
The differentiators are zero dependencies and retry — the README should not claim otherwise.

## Notes

Our store is a `ReadonlyMap` copied on entry and scoped by `ALS.run`, rather than a mutable stack
with paired `enter()`/`exit()` calls. Unwinding becomes the runtime's job, so no code path can
leave a stale entry behind. See [internals](../internals.md#1-context-propagation).
