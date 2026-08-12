import { inject } from 'vitest';
import { DataSource, type DataSourceOptions, type EntitySchema, type MixedList } from 'typeorm';

/** Connection details for the shared container, published by `global-setup.ts`. */
export interface PgConnection {
  url: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  image: string;
}

export function getPgConnection(): PgConnection {
  return inject('pg');
}

/**
 * Builds a DataSource against the shared container.
 *
 * Each caller gets its own pool so tests can hold several concurrent sessions —
 * which is the whole point of the deadlock and serialization-failure harnesses.
 * `poolSize` must exceed the number of sessions a test coordinates, or the test
 * deadlocks on connection acquisition rather than on row locks, which looks
 * identical from the outside and is maddening to debug.
 */
export function createTestDataSource(
  entities: MixedList<string | (new () => unknown) | EntitySchema>,
  overrides: Partial<DataSourceOptions> = {},
): DataSource {
  const pg = getPgConnection();

  return new DataSource({
    type: 'postgres',
    host: pg.host,
    port: pg.port,
    username: pg.username,
    password: pg.password,
    database: pg.database,
    entities,
    synchronize: true,
    dropSchema: true,
    logging: false,
    poolSize: 20,
    ...overrides,
  } as DataSourceOptions);
}
