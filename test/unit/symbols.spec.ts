import { describe, expect, it } from 'vitest';
import type { DataSource, EntityManager } from 'typeorm';

import { DATA_SOURCE_NAME, dataSourceOf, nameOf } from '../../src/core/datasource/symbols.js';

/**
 * These two helpers are the whole of our TypeORM version tolerance, and the
 * 0.3.x branch is unreachable from the installed TypeORM. Exercising both shapes
 * directly is what keeps `typeorm@^0.3.31 || ^1` an honest claim between CI runs
 * of the compat job.
 */

describe('dataSourceOf', () => {
  it('reads `dataSource`, the TypeORM 1.x property', () => {
    const ds = { name: '1.x' } as unknown as DataSource;
    const manager = { dataSource: ds } as unknown as EntityManager;

    expect(dataSourceOf(manager)).toBe(ds);
  });

  it('falls back to `connection`, the TypeORM 0.3.x property', () => {
    const ds = { name: '0.3.x' } as unknown as DataSource;
    const manager = { connection: ds } as unknown as EntityManager;

    expect(dataSourceOf(manager)).toBe(ds);
  });

  it('prefers `dataSource` when a build somehow exposes both', () => {
    const modern = { name: 'modern' } as unknown as DataSource;
    const legacy = { name: 'legacy' } as unknown as DataSource;
    const manager = { dataSource: modern, connection: legacy } as unknown as EntityManager;

    expect(dataSourceOf(manager)).toBe(modern);
  });

  it('returns undefined for an absent manager', () => {
    expect(dataSourceOf(undefined)).toBeUndefined();
  });

  it('returns undefined when neither property exists', () => {
    expect(dataSourceOf({} as unknown as EntityManager)).toBeUndefined();
  });
});

describe('nameOf', () => {
  it('reads the name stamped at registration', () => {
    const ds = { [DATA_SOURCE_NAME]: 'primary' } as unknown as DataSource;
    expect(nameOf(ds)).toBe('primary');
  });

  it('returns undefined for an unregistered data source', () => {
    expect(nameOf({} as unknown as DataSource)).toBeUndefined();
  });

  it('returns undefined for an absent data source', () => {
    expect(nameOf(undefined)).toBeUndefined();
  });
});
