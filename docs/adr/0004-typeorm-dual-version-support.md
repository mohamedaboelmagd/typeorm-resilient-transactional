# 4. Support TypeORM 0.3.x and 1.x from one build

- **Status:** accepted
- **Date:** 2026-08-11

## Context

TypeORM 1.0.0 shipped 2026-05-19 and `latest` is now 1.1.0. The `0.3.x` line is tagged `legacy` —
but it is still actively released (`0.3.31` shipped the same day as 1.1.0), and it is what
essentially all of `typeorm-transactional`'s ~172K weekly downloads are on today.

Targeting only 1.x would exclude the exact population our migration story is aimed at. Targeting
only 0.3.x would ship onto a line npm already labels legacy.

## Decision

Peer dependency `typeorm@^0.3.31 || ^1`. One build, no version-specific code paths beyond reading
renamed properties through helpers.

Add a CI job running the full suite against `0.3.31` and `1.1.0`.

## Consequences

The surface we patch was read in both versions and is identical: `DataSource.manager`,
`Repository.manager` (own property assigned in the constructor), `createQueryRunner(mode)`, and
`startTransaction(isolationLevel?)`. So dual support costs one CI dimension, not a compatibility
layer.

Exactly one rename affects us — `EntityManager.connection` became `EntityManager.dataSource` —
handled in a single helper:

```ts
export function dataSourceOf(manager) {
  return manager?.dataSource ?? manager?.connection;
}
```

Two 1.x-only behaviours to keep in mind: `startTransaction` now calls `validateIsolationLevel`
against `driver.supportedIsolationLevels`, so an unsupported level throws before any SQL is sent;
and a `DataSource`-level `isolationLevel` default now exists that our own default must compose
with rather than silently override.

`engines.node` stays `>=20`. TypeORM 1.x additionally requires `^20.19.0 || ^22.13.0 || >=24.11.0`,
which we do not restate — consumers on 1.x already inherit it from TypeORM itself, and restating it
would wrongly exclude 0.3.x users on Node 20.0–20.18.

The claim that both lines share one surface is only as good as the CI job that proves it. If that
job is ever removed, this ADR is void.
