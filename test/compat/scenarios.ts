import type { DataSource } from 'typeorm';

import { Note, noteIds, resetFixtures } from '../integration/harness/fixtures.js';

/**
 * The behaviours `typeorm-transactional` and this library must agree on.
 *
 * Both suites drive this same list, so "drop-in compatible" is a property the CI
 * checks rather than a claim in the README. The one intentional divergence —
 * `NESTED` — is declared per library below, so a *silent* change to it fails the
 * build too.
 */

/** The subset of each library's API these scenarios need. */
export interface TransactionalApi {
  readonly label: string;
  readonly Propagation: Record<string, string>;
  wrap<F extends (...args: never[]) => unknown>(fn: F, propagation: string): F;
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>;
}

export interface Outcome {
  /** Ids surviving in `note` once everything settled. */
  readonly notes: readonly string[];
  /** Whether the scenario's outermost call rejected. */
  readonly threw: boolean;
}

export interface ScenarioContext {
  readonly api: TransactionalApi;
  readonly dataSource: DataSource;
  writeNote(id: string): Promise<void>;
}

export interface Scenario {
  readonly name: string;
  run(ctx: ScenarioContext): Promise<void>;
}

class Boom extends Error {}

/** Records whether the call threw instead of letting it fail the test. */
async function swallow(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

let lastThrew = false;

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'REQUIRED / no transaction / commits',
    async run({ api, writeNote }) {
      const fn = api.wrap(async () => {
        await writeNote('a');
      }, api.Propagation['REQUIRED']!);
      lastThrew = await swallow(fn);
    },
  },
  {
    name: 'REQUIRED / no transaction / rolls back on throw',
    async run({ api, writeNote }) {
      const fn = api.wrap(async () => {
        await writeNote('a');
        throw new Boom('fail');
      }, api.Propagation['REQUIRED']!);
      lastThrew = await swallow(fn);
    },
  },
  {
    name: 'REQUIRED / joined / undone by outer rollback',
    async run({ api, writeNote }) {
      const inner = api.wrap(async () => {
        await writeNote('inner');
      }, api.Propagation['REQUIRED']!);

      lastThrew = await swallow(() =>
        api.runInTransaction(async () => {
          await inner();
          throw new Boom('outer');
        }),
      );
    },
  },
  {
    name: 'REQUIRES_NEW / joined / survives outer rollback',
    async run({ api, writeNote }) {
      const inner = api.wrap(async () => {
        await writeNote('inner');
      }, api.Propagation['REQUIRES_NEW']!);

      lastThrew = await swallow(() =>
        api.runInTransaction(async () => {
          await inner();
          throw new Boom('outer');
        }),
      );
    },
  },
  {
    name: 'SUPPORTS / no transaction / runs bare',
    async run({ api, writeNote }) {
      const fn = api.wrap(async () => {
        await writeNote('a');
      }, api.Propagation['SUPPORTS']!);
      lastThrew = await swallow(fn);
    },
  },
  {
    name: 'SUPPORTS / joined / undone by outer rollback',
    async run({ api, writeNote }) {
      const inner = api.wrap(async () => {
        await writeNote('a');
      }, api.Propagation['SUPPORTS']!);

      lastThrew = await swallow(() =>
        api.runInTransaction(async () => {
          await inner();
          throw new Boom('outer');
        }),
      );
    },
  },
  {
    name: 'NOT_SUPPORTED / suspends / survives outer rollback',
    async run({ api, writeNote }) {
      const inner = api.wrap(async () => {
        await writeNote('escaped');
      }, api.Propagation['NOT_SUPPORTED']!);

      lastThrew = await swallow(() =>
        api.runInTransaction(async () => {
          await inner();
          throw new Boom('outer');
        }),
      );
    },
  },
  {
    name: 'MANDATORY / no transaction / throws',
    async run({ api, writeNote }) {
      const fn = api.wrap(async () => {
        await writeNote('a');
      }, api.Propagation['MANDATORY']!);
      lastThrew = await swallow(fn);
    },
  },
  {
    name: 'MANDATORY / joined / commits',
    async run({ api, writeNote }) {
      const inner = api.wrap(async () => {
        await writeNote('a');
      }, api.Propagation['MANDATORY']!);

      lastThrew = await swallow(() => api.runInTransaction(async () => inner()));
    },
  },
  {
    name: 'NEVER / no transaction / runs bare',
    async run({ api, writeNote }) {
      const fn = api.wrap(async () => {
        await writeNote('a');
      }, api.Propagation['NEVER']!);
      lastThrew = await swallow(fn);
    },
  },
  {
    name: 'NEVER / inside a transaction / throws',
    async run({ api, writeNote }) {
      const inner = api.wrap(async () => {
        await writeNote('a');
      }, api.Propagation['NEVER']!);

      lastThrew = await swallow(() => api.runInTransaction(async () => inner()));
    },
  },
  {
    // The distinguishing case. A real savepoint is part of the enclosing
    // transaction and dies with it; an independent transaction commits and
    // survives. Every other NESTED scenario produces identical output for both
    // implementations, which is exactly why the difference goes unnoticed.
    name: 'NESTED / inner commits / outer rolls back',
    async run({ api, writeNote }) {
      const inner = api.wrap(async () => {
        await writeNote('inner');
      }, api.Propagation['NESTED']!);

      lastThrew = await swallow(() =>
        api.runInTransaction(async () => {
          await inner();
          throw new Boom('outer');
        }),
      );
    },
  },
];

/** Shared expectations. `NESTED` is supplied per library. */
export const EXPECTED_SHARED: Readonly<Record<string, Outcome>> = {
  'REQUIRED / no transaction / commits': { notes: ['a'], threw: false },
  'REQUIRED / no transaction / rolls back on throw': { notes: [], threw: true },
  'REQUIRED / joined / undone by outer rollback': { notes: [], threw: true },
  'REQUIRES_NEW / joined / survives outer rollback': { notes: ['inner'], threw: true },
  'SUPPORTS / no transaction / runs bare': { notes: ['a'], threw: false },
  'SUPPORTS / joined / undone by outer rollback': { notes: [], threw: true },
  'NOT_SUPPORTED / suspends / survives outer rollback': { notes: ['escaped'], threw: true },
  'MANDATORY / no transaction / throws': { notes: [], threw: true },
  'MANDATORY / joined / commits': { notes: ['a'], threw: false },
  'NEVER / no transaction / runs bare': { notes: ['a'], threw: false },
  'NEVER / inside a transaction / throws': { notes: [], threw: true },
};

export const NESTED_SCENARIO = 'NESTED / inner commits / outer rolls back';

/** `typeorm-transactional` gives NESTED its own query runner, so the write commits. */
export const EXPECTED_NESTED_TYPEORM_TRANSACTIONAL: Outcome = { notes: ['inner'], threw: true };

/** Ours uses a real savepoint, so the outer rollback takes the write with it. */
export const EXPECTED_NESTED_RESILIENT: Outcome = { notes: [], threw: true };

export async function runScenario(scenario: Scenario, ctx: ScenarioContext): Promise<Outcome> {
  await resetFixtures(ctx.dataSource);
  lastThrew = false;

  await scenario.run(ctx);

  return { notes: await noteIds(ctx.dataSource), threw: lastThrew };
}

export function makeWriteNote(dataSource: DataSource): (id: string) => Promise<void> {
  return async (id: string) => {
    await dataSource.getRepository(Note).save({ id, body: id });
  };
}
