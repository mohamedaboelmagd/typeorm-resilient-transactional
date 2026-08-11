import type { PgConnection } from './integration/harness/postgres.js';

declare module 'vitest' {
  interface ProvidedContext {
    pg: PgConnection;
  }
}

export {};
