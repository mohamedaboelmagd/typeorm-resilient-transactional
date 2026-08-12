/**
 * Process-wide singletons, shared across duplicate copies of this module.
 *
 * Two situations put more than one copy of this code in a process, and both are
 * ordinary rather than exotic:
 *
 *  1. **Multiple entry points under CommonJS.** esbuild can only code-split ESM,
 *     so `dist/index.js`, `dist/compat.js`, and `dist/nestjs.js` each bundle their
 *     own copy of the core. Without this file, `ResilientTransactionalModule.forRoot()`
 *     — imported from `/nestjs` — would initialize a context that `@Transactional()`
 *     — imported from the root — could not see. That is the documented quickstart,
 *     and it silently did nothing.
 *
 *  2. **Two installed copies of the package**, via pnpm layouts, monorepos, or a
 *     transitive dependency pinning a different version.
 *
 * The state that matters here is the `AsyncLocalStorage` instance, the data source
 * registry, and the application defaults. If a second copy allocates its own, a
 * transaction opened by one is invisible to the other — a failure that produces no
 * error, just repositories quietly running outside the transaction.
 *
 * `Symbol.for` puts these in the cross-realm registry, so every copy finds the same
 * bag. The version suffix means a future change to the shape cannot silently
 * mismatch an older copy that is still loaded.
 */
const STATE = Symbol.for('typeorm-resilient-transactional.state.v1');

type StateBag = Record<string, unknown>;

function bag(): StateBag {
  const host = globalThis as unknown as Record<symbol, StateBag | undefined>;
  return (host[STATE] ??= {});
}

/**
 * Returns the one instance of `key`, creating it on first use.
 *
 * Mutable values must be wrapped in an object — a shared *box*, not a shared
 * snapshot — or updates made through one copy will not be seen by the others.
 */
export function sharedState<T>(key: string, create: () => T): T {
  const store = bag();

  if (!(key in store)) {
    store[key] = create();
  }

  return store[key] as T;
}

/** Test seam. Drops every shared singleton so a suite can start clean. */
export function resetSharedState(): void {
  const host = globalThis as unknown as Record<symbol, StateBag | undefined>;
  host[STATE] = {};
}
