import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

/**
 * One PostgreSQL container per test run, shared by every integration file.
 *
 * Vitest runs each test file in its own worker, so a module-level singleton would
 * start one container per file. `provide()` hands the connection URL across the
 * worker boundary instead.
 *
 * `PG_IMAGE` lets CI drive the Postgres version matrix (14/15/16/17) without
 * touching this file.
 */

const DEFAULT_IMAGE = 'postgres:17-alpine';

let container: StartedPostgreSqlContainer | undefined;

export default async function setup({ provide }: TestProject) {
  const image = process.env.PG_IMAGE ?? DEFAULT_IMAGE;

  container = await new PostgreSqlContainer(image)
    .withDatabase('resilient_test')
    .withUsername('test')
    .withPassword('test')
    // Deadlock tests should fail fast rather than sit on the default 1s detection
    // timeout, and integration runs must never hang CI on a stuck lock.
    .withCommand([
      'postgres',
      '-c',
      'deadlock_timeout=200ms',
      '-c',
      'log_lock_waits=on',
      '-c',
      'max_connections=200',
    ])
    .start();

  provide('pg', {
    url: container.getConnectionUri(),
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    username: container.getUsername(),
    password: container.getPassword(),
    image,
  });

  return async () => {
    await container?.stop();
  };
}
