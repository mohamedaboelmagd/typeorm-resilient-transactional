import type { DataSource, EntityManager } from 'typeorm';

/** Stamped on every registered `DataSource` so patched accessors can find its name. */
export const DATA_SOURCE_NAME = Symbol.for('resilient-tx:data-source-name');

/**
 * Where a `Repository`'s real (non-contextual) `EntityManager` lives once the
 * prototype accessor takes over the `manager` property.
 */
export const ORIGINAL_MANAGER = Symbol.for('resilient-tx:original-manager');

/** Marks an object as already patched, so re-running setup is a no-op. */
export const PATCHED = Symbol.for('resilient-tx:patched');

/**
 * Resolves the `DataSource` behind an `EntityManager`.
 *
 * TypeORM 0.3.x calls this `connection`; 1.x renamed it to `dataSource`. We read
 * whichever exists so one build supports both lines — the CI `typeorm-compat` job
 * is what keeps this honest.
 */
export function dataSourceOf(manager: EntityManager | undefined): DataSource | undefined {
  if (manager === undefined) return undefined;

  const candidate = manager as Partial<{ dataSource: DataSource; connection: DataSource }>;
  return candidate.dataSource ?? candidate.connection;
}

/** The registered name of a `DataSource`, or `undefined` if it was never registered. */
export function nameOf(dataSource: DataSource | undefined): string | undefined {
  if (dataSource === undefined) return undefined;
  return (dataSource as Partial<Record<typeof DATA_SOURCE_NAME, string>>)[DATA_SOURCE_NAME];
}
