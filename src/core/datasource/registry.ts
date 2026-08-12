import type { DataSource } from 'typeorm';

import { DEFAULT_DATA_SOURCE_NAME } from '../context/store.js';
import { DataSourceNotRegisteredError, ResilientTransactionalError } from '../errors/index.js';
import { sharedState } from '../shared-state.js';
import { patchDataSource, patchRepositoryPrototype } from './patch.js';

export interface AddResilientDataSourceInput {
  dataSource: DataSource;
  /** Distinguishes data sources in multi-database setups. Defaults to `'default'`. */
  name?: string;
  /**
   * Whether to patch `DataSource` accessors (`manager`, `query`,
   * `createQueryBuilder`, `transaction`).
   *
   * Repositories work either way — those go through the `Repository.prototype`
   * patch. Set `false` only if you never touch `dataSource.*` inside a transaction
   * and want to leave TypeORM's own accessors untouched.
   */
  patch?: boolean;
}

/**
 * Both shared across duplicate module copies. The flag lives in a box rather than
 * a module variable so a change made through one copy is visible to the others.
 * @see ../shared-state.ts
 */
const dataSources = sharedState('dataSources', () => new Map<string, DataSource>());
const flags = sharedState('flags', () => ({ contextInitialized: false }));

/**
 * Installs the transactional context.
 *
 * Call once, before your application starts and before any repository is created.
 * Safe to call more than once — later calls are no-ops.
 */
export function initializeResilientContext(): void {
  if (flags.contextInitialized) return;

  patchRepositoryPrototype();
  flags.contextInitialized = true;
}

export function isContextInitialized(): boolean {
  return flags.contextInitialized;
}

/**
 * Registers a `DataSource` so `@Transactional()` can find it, returning the same
 * instance for chaining.
 */
export function addResilientDataSource(
  input: AddResilientDataSourceInput | DataSource,
): DataSource {
  const normalized: AddResilientDataSourceInput =
    'dataSource' in input ? input : { dataSource: input };

  const { dataSource, name = DEFAULT_DATA_SOURCE_NAME, patch = true } = normalized;

  if (dataSources.has(name)) {
    throw new ResilientTransactionalError(
      `A data source named "${name}" is already registered. Pass a distinct \`name\` when ` +
        'registering more than one data source.',
    );
  }

  // Registering before initialization is a common ordering mistake, and the
  // failure it produces — repositories silently ignoring the transaction — is
  // very hard to debug. Just do the right thing.
  initializeResilientContext();

  if (patch) patchDataSource(dataSource, name);

  dataSources.set(name, dataSource);

  return dataSource;
}

export function getDataSourceByName(name: string = DEFAULT_DATA_SOURCE_NAME): DataSource {
  const dataSource = dataSources.get(name);
  if (dataSource === undefined) throw new DataSourceNotRegisteredError(name);
  return dataSource;
}

export function hasDataSource(name: string = DEFAULT_DATA_SOURCE_NAME): boolean {
  return dataSources.has(name);
}

export function deleteDataSourceByName(name: string = DEFAULT_DATA_SOURCE_NAME): boolean {
  return dataSources.delete(name);
}

/**
 * Clears the registry. Test seam — the `Repository.prototype` patch is global and
 * deliberately stays installed, since it is idempotent and harmless.
 */
export function clearResilientDataSources(): void {
  dataSources.clear();
}
