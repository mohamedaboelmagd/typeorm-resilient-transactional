import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';

import {
  ContextNotInitializedError,
  DataSourceNotRegisteredError,
  IsolationLevel,
  Transactional,
  addResilientDataSource,
  clearResilientDataSources,
  currentAttempt,
  getTransactionContext,
  initializeResilientContext,
  isInTransaction,
  runInResilientTransaction,
} from '../../src/index.js';
import { createTestDataSource } from './harness/postgres.js';
import {
  ENTITIES,
  Note,
  createFixtureDataSource,
  noteIds,
  resetFixtures,
} from './harness/fixtures.js';

let dataSource: DataSource;
let secondary: DataSource;

class Boom extends Error {}

beforeAll(async () => {
  initializeResilientContext();

  dataSource = createFixtureDataSource();
  await dataSource.initialize();
  addResilientDataSource(dataSource);

  // Same physical database, registered under a second name — enough to prove the
  // context is keyed per data source. It must not re-synchronize the schema.
  secondary = createTestDataSource(ENTITIES, { synchronize: false, dropSchema: false });
  await secondary.initialize();
  addResilientDataSource({ dataSource: secondary, name: 'secondary' });
});

afterAll(async () => {
  clearResilientDataSources();
  if (secondary?.isInitialized) await secondary.destroy();
  if (dataSource?.isInitialized) await dataSource.destroy();
});

beforeEach(async () => {
  await resetFixtures(dataSource);
});

describe('repository resolution', () => {
  it('routes a repository resolved outside the transaction through the tx manager', async () => {
    // Resolved up front, before any transaction exists — the case the prototype
    // patch has to handle, since Repository assigns `manager` in its constructor.
    const repository = dataSource.getRepository(Note);

    await expect(
      runInResilientTransaction(async () => {
        await repository.save({ id: 'a', body: 'a' });
        throw new Boom('rollback');
      }),
    ).rejects.toThrow(Boom);

    expect(await noteIds(dataSource)).toEqual([]);
  });

  it('resolves to the real manager outside a transaction', async () => {
    const repository = dataSource.getRepository(Note);
    await repository.save({ id: 'a', body: 'a' });
    expect(await noteIds(dataSource)).toEqual(['a']);
  });

  it('gives the repository the transactional manager identity', async () => {
    const repository = dataSource.getRepository(Note);

    await runInResilientTransaction((manager) => {
      expect(repository.manager).toBe(manager);
      return Promise.resolve();
    });
  });
});

describe('patched DataSource accessors', () => {
  it('makes dataSource.query see uncommitted work inside the transaction', async () => {
    await runInResilientTransaction(async () => {
      await dataSource.getRepository(Note).save({ id: 'pending', body: 'x' });

      const rows = await dataSource.query<{ id: string }[]>('SELECT id FROM note');
      expect(rows.map((r) => r.id)).toEqual(['pending']);

      throw new Boom('rollback');
    }).catch(() => undefined);

    expect(await noteIds(dataSource)).toEqual([]);
  });

  it('makes dataSource.createQueryBuilder join the transaction', async () => {
    await expect(
      runInResilientTransaction(async () => {
        await dataSource.getRepository(Note).save({ id: 'qb', body: 'x' });

        const found = await dataSource
          .createQueryBuilder(Note, 'note')
          .where('note.id = :id', { id: 'qb' })
          .getOne();

        expect(found?.id).toBe('qb');
        throw new Boom('rollback');
      }),
    ).rejects.toThrow(Boom);

    expect(await noteIds(dataSource)).toEqual([]);
  });

  it('keeps dataSource.transaction independent, matching native TypeORM', async () => {
    await expect(
      runInResilientTransaction(async () => {
        await dataSource.transaction(async (manager) => {
          await manager.getRepository(Note).save({ id: 'independent', body: 'x' });
        });
        throw new Boom('outer rolls back');
      }),
    ).rejects.toThrow(Boom);

    expect(await noteIds(dataSource)).toEqual(['independent']);
  });
});

describe('multiple data sources', () => {
  it('keys the context per data source', async () => {
    await runInResilientTransaction(async () => {
      expect(isInTransaction('default')).toBe(true);
      expect(isInTransaction('secondary')).toBe(false);
      await Promise.resolve();
    });
  });

  it('runs a transaction on a named data source', async () => {
    await runInResilientTransaction(
      async () => {
        expect(isInTransaction('secondary')).toBe(true);
        expect(isInTransaction('default')).toBe(false);
        await secondary.getRepository(Note).save({ id: 'from-secondary', body: 'x' });
      },
      { dataSourceName: 'secondary' },
    );

    expect(await noteIds(dataSource)).toEqual(['from-secondary']);
  });

  it('rejects an unregistered data source by name', async () => {
    await expect(
      runInResilientTransaction(() => Promise.resolve(), { dataSourceName: 'nope' }),
    ).rejects.toThrow(DataSourceNotRegisteredError);
  });

  it('refuses to register the same name twice', () => {
    expect(() => addResilientDataSource(dataSource)).toThrow(/already registered/);
  });
});

describe('introspection', () => {
  it('reports no context outside a transaction', () => {
    expect(getTransactionContext()).toBeUndefined();
    expect(isInTransaction()).toBe(false);
    expect(currentAttempt()).toBe(0);
  });

  it('exposes isolation, depth, and a 1-based attempt inside', async () => {
    await runInResilientTransaction(
      () => {
        const ctx = getTransactionContext();
        expect(ctx?.isolation).toBe(IsolationLevel.SERIALIZABLE);
        expect(ctx?.depth).toBe(0);
        expect(ctx?.isOwner).toBe(true);
        expect(currentAttempt()).toBe(1);
        return Promise.resolve();
      },
      { isolation: IsolationLevel.SERIALIZABLE },
    );
  });

  it('accepts isolationLevel, the typeorm-transactional spelling', async () => {
    await runInResilientTransaction(
      () => {
        expect(getTransactionContext()?.isolation).toBe(IsolationLevel.SERIALIZABLE);
        return Promise.resolve();
      },
      { isolationLevel: IsolationLevel.SERIALIZABLE },
    );
  });

  it('clears the context once the transaction settles', async () => {
    await runInResilientTransaction(() => Promise.resolve());
    expect(isInTransaction()).toBe(false);
  });

  it('clears the context after a rollback too', async () => {
    await expect(runInResilientTransaction(() => Promise.reject(new Boom('x')))).rejects.toThrow(
      Boom,
    );
    expect(isInTransaction()).toBe(false);
  });
});

describe('the decorator', () => {
  it('preserves the method name', () => {
    class Svc {
      @Transactional()
      async doWork(): Promise<void> {
        await Promise.resolve();
      }
    }
    expect(new Svc().doWork.name).toBe('doWork');
  });

  it('rejects non-method targets at decoration time', () => {
    expect(() => {
      const descriptor: TypedPropertyDescriptor<unknown> = { value: 'not a function' };
      Transactional()({}, 'prop', descriptor);
    }).toThrow(/can only decorate methods/);
  });

  it('propagates the return value and preserves `this`', async () => {
    class Svc {
      readonly tag = 'svc';

      @Transactional()
      async whoAmI(): Promise<string> {
        await Promise.resolve();
        return this.tag;
      }
    }
    await expect(new Svc().whoAmI()).resolves.toBe('svc');
  });
});

describe('query runner lifecycle', () => {
  it('releases the runner on success and failure, so the pool never drains', async () => {
    // poolSize is 20 in the harness. Running well past it sequentially would hang
    // on connection acquisition if any path leaked a query runner.
    for (let i = 0; i < 40; i++) {
      await runInResilientTransaction(() => Promise.resolve());
      await expect(runInResilientTransaction(() => Promise.reject(new Boom('x')))).rejects.toThrow(
        Boom,
      );
    }

    // Still usable afterwards.
    await runInResilientTransaction(async () => {
      await dataSource.getRepository(Note).save({ id: 'after', body: 'x' });
    });
    expect(await noteIds(dataSource)).toEqual(['after']);
  });
});

describe('bootstrap errors', () => {
  it('explains what to call when the context was never initialized', () => {
    expect(new ContextNotInitializedError().message).toMatch(/initializeResilientContext/);
  });
});
