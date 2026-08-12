# 8. Share the critical singletons on `globalThis`

- **Status:** accepted
- **Date:** 2026-08-12

## Context

The package ships three entry points — the root, `/compat`, and `/nestjs` — and a dual ESM/CJS
build. esbuild can only code-split **ESM**. Under CommonJS each entry point therefore bundles its
own copy of `src/core/`, with its own module-level state.

Installing the packed tarball into a clean project exposed what that means:

```js
const root = require('typeorm-resilient-transactional');
const nest = require('typeorm-resilient-transactional/nestjs');

nest.ResilientTransactionalModule.forRoot({ retry: { maxAttempts: 9 } });

root.isContextInitialized(); // false
root.getResilientDefaults(); // {}
```

That is the **documented NestJS quickstart**, and under CommonJS — most of the NestJS ecosystem — it
silently did nothing. `forRoot()` initialized one copy's context and configured one copy's defaults;
`@Transactional()`, imported from the root, read a different copy's.

No in-repo test could catch it. Vitest resolves everything through one module graph, so `src/` is
loaded exactly once and the duplication does not exist.

The same hazard arises without our build at all: two installed copies of the package, from a pnpm
layout, a monorepo, or a transitive dependency on a different version.

## Decision

Hold the state whose duplication breaks correctness in a bag keyed on
`Symbol.for('typeorm-resilient-transactional.state.v1')`, so every copy in the process finds the
same one:

- the `AsyncLocalStorage` instance
- the data source registry and the initialized flag
- the application-wide defaults

Mutable values are stored in a **box** rather than as a bare value, so a change made through one copy
is visible to the others.

Add `scripts/verify-package.mjs` — pack, install into a throwaway project, assert cross-entry-point
behaviour — and run it in CI.

## Consequences

The failure mode this removes is the worst kind available to this library: no error, no warning,
just repositories quietly running outside the transaction they appear to be in.

Diagnostics handlers and the OpenTelemetry reference are deliberately **not** shared. Duplicating
those is cosmetic — a warning printed by one copy and not another — and keeping the shared surface
minimal keeps the coupling minimal.

`Symbol.for` is a global namespace, so the key is versioned. If the shape ever changes, the suffix
changes with it and an older copy still resident in the process cannot silently misread it.

We accept a small amount of global state. The alternative — ESM-only, or a single entry point — would
either exclude most of the NestJS ecosystem or force `@nestjs/common` on users who do not want it.

**The lesson worth keeping is about testing, not globals.** A library with multiple entry points
cannot be verified only from inside its own repository; the packaged artifact is a different
artifact. That check is now a CI job.
