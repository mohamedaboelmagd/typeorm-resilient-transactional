# Contributing

## The one rule

**Every claim is backed by a test or a benchmark.** If a number appears in the docs, a command
produced it. If a behaviour is described, a test asserts it. Where something is unverified, it says
so.

That is the whole reason to trust a library that sits in your transaction path, so it is the rule
that gets enforced hardest in review.

## Setup

```bash
nvm use              # Node 24, per .nvmrc
corepack enable
pnpm install
pnpm preflight       # checks Node, pnpm, and a reachable Docker daemon
```

Integration tests run against a real PostgreSQL through Testcontainers. Mocking a deadlock proves
nothing, so there is no mocked alternative — `preflight` will tell you exactly what is missing.

## Commands

|                                           |                                                 |
| ----------------------------------------- | ----------------------------------------------- |
| `pnpm test`                               | unit + integration + compat                     |
| `pnpm test:unit`                          | fast, no database                               |
| `pnpm test:integration`                   | needs Docker                                    |
| `pnpm test:compat`                        | parity against the real `typeorm-transactional` |
| `pnpm coverage`                           | 90% floor on `src/core/`                        |
| `pnpm bench`                              | regenerates `benchmarks/RESULTS.md`             |
| `pnpm lint` `pnpm typecheck` `pnpm build` |                                                 |

Against another PostgreSQL version: `PG_IMAGE=postgres:14-alpine pnpm test:integration`.

## Things reviewers will ask about

**Did you test it against a real database?** Concurrency bugs do not reproduce against mocks. Use the
barrier harness in `test/integration/harness/` to make an interleaving exact rather than likely — a
flaky concurrency test is worse than none.

**Does `src/core/` still import zero NestJS?** Enforced by ESLint. The boundary exists so extracting
a standalone core package stays a file move.

**Are there still zero runtime dependencies?** `dependencies` must stay empty. Everything else is a
peer, optional where it can be.

**Does it degrade instead of throwing?** We patch TypeORM internals. When a shape changes, we skip
that one patch and warn — a TypeORM patch release must never hard-crash every consumer. See
[ADR 0006](docs/adr/0006-behavioural-capability-detection.md).

## Making a decision

Anything that changes behaviour a user could depend on gets an ADR in `docs/adr/`: the context, the
decision, and the consequences — including the ones we dislike. Deviating from
`typeorm-transactional` always needs one, plus a note in `MIGRATION.md`.

## Commits and releases

Conventional commits. Add a changeset for anything user-visible:

```bash
pnpm changeset
```

Releases are automated — merging the version PR publishes with npm provenance.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
