import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource, QueryRunner } from 'typeorm';

import {
  Propagation,
  Transactional,
  TransactionalError,
  addResilientDataSource,
  clearResilientDataSources,
  getTransactionContext,
  initializeResilientContext,
  isInTransaction,
  runInResilientTransaction,
} from '../../src/index.js';
import { Note, createFixtureDataSource, noteIds, resetFixtures } from './harness/fixtures.js';

let dataSource: DataSource;

/** Writes a note through a repository, so the repository patch is exercised too. */
async function writeNote(id: string): Promise<void> {
  await dataSource.getRepository(Note).save({ id, body: id });
}

function currentRunner(): QueryRunner | undefined {
  return getTransactionContext()?.queryRunner;
}

class Service {
  @Transactional()
  async required(id: string, then?: () => Promise<void>): Promise<void> {
    await writeNote(id);
    await then?.();
  }

  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  async requiresNew(id: string, then?: () => Promise<void>): Promise<void> {
    await writeNote(id);
    await then?.();
  }

  @Transactional({ propagation: Propagation.NESTED })
  async nested(id: string, then?: () => Promise<void>): Promise<void> {
    await writeNote(id);
    await then?.();
  }

  @Transactional({ propagation: Propagation.SUPPORTS })
  async supports(id: string): Promise<void> {
    await writeNote(id);
  }

  @Transactional({ propagation: Propagation.NOT_SUPPORTED })
  async notSupported(id: string): Promise<void> {
    await writeNote(id);
  }

  @Transactional({ propagation: Propagation.MANDATORY })
  async mandatory(id: string): Promise<void> {
    await writeNote(id);
  }

  @Transactional({ propagation: Propagation.NEVER })
  async never(id: string): Promise<void> {
    await writeNote(id);
  }
}

const service = new Service();

class Boom extends Error {}

beforeAll(async () => {
  initializeResilientContext();
  dataSource = createFixtureDataSource();
  await dataSource.initialize();
  addResilientDataSource(dataSource);
});

afterAll(async () => {
  clearResilientDataSources();
  if (dataSource?.isInitialized) await dataSource.destroy();
});

beforeEach(async () => {
  await resetFixtures(dataSource);
});

describe('REQUIRED', () => {
  it('starts a transaction when there is none', async () => {
    expect(isInTransaction()).toBe(false);
    await service.required('a');
    expect(await noteIds(dataSource)).toEqual(['a']);
  });

  it('rolls back its own writes on throw', async () => {
    await expect(service.required('a', () => Promise.reject(new Boom('fail')))).rejects.toThrow(
      Boom,
    );
    expect(await noteIds(dataSource)).toEqual([]);
  });

  it('joins an existing transaction rather than starting a second one', async () => {
    let outer: QueryRunner | undefined;
    let inner: QueryRunner | undefined;

    await runInResilientTransaction(async () => {
      outer = currentRunner();
      await service.required('a', async () => {
        inner = currentRunner();
        await Promise.resolve();
      });
    });

    expect(inner).toBe(outer);
  });

  it('reports isOwner false for the joined scope', async () => {
    await runInResilientTransaction(async () => {
      expect(getTransactionContext()?.isOwner).toBe(true);
      await service.required('a', () => {
        expect(getTransactionContext()?.isOwner).toBe(false);
        return Promise.resolve();
      });
    });
  });

  it('is undone by the outer rollback when joined', async () => {
    await expect(
      runInResilientTransaction(async () => {
        await service.required('inner');
        throw new Boom('outer fails');
      }),
    ).rejects.toThrow(Boom);

    expect(await noteIds(dataSource)).toEqual([]);
  });
});

describe('REQUIRES_NEW', () => {
  it('uses a different query runner from the surrounding transaction', async () => {
    let outer: QueryRunner | undefined;
    let inner: QueryRunner | undefined;

    await runInResilientTransaction(async () => {
      outer = currentRunner();
      await service.requiresNew('a', async () => {
        inner = currentRunner();
        await Promise.resolve();
      });
    });

    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(inner).not.toBe(outer);
  });

  it('commits independently and survives the outer rollback', async () => {
    await expect(
      runInResilientTransaction(async () => {
        await service.requiresNew('independent');
        throw new Boom('outer fails');
      }),
    ).rejects.toThrow(Boom);

    expect(await noteIds(dataSource)).toEqual(['independent']);
  });

  it('restores the outer context after it returns', async () => {
    await runInResilientTransaction(async () => {
      const outer = currentRunner();
      await service.requiresNew('a');
      expect(currentRunner()).toBe(outer);
    });
  });
});

// This is where we deliberately differ from typeorm-transactional, whose NESTED
// allocates a new query runner and therefore behaves as REQUIRES_NEW.
// @see docs/adr/0003-nested-savepoint-deviation.md
describe('NESTED', () => {
  it('reuses the surrounding query runner, so it is a real savepoint', async () => {
    let outer: QueryRunner | undefined;
    let inner: QueryRunner | undefined;

    await runInResilientTransaction(async () => {
      outer = currentRunner();
      await service.nested('a', async () => {
        inner = currentRunner();
        await Promise.resolve();
      });
    });

    expect(inner).toBe(outer);
  });

  it('increments depth', async () => {
    await runInResilientTransaction(async () => {
      expect(getTransactionContext()?.depth).toBe(0);
      await service.nested('a', () => {
        expect(getTransactionContext()?.depth).toBe(1);
        return Promise.resolve();
      });
      expect(getTransactionContext()?.depth).toBe(0);
    });
  });

  it('rolls back only to the savepoint, leaving the outer transaction usable', async () => {
    await runInResilientTransaction(async () => {
      await writeNote('outer');

      await expect(
        service.nested('inner', () => Promise.reject(new Boom('inner fails'))),
      ).rejects.toThrow(Boom);

      // The outer transaction survived and can still write.
      await writeNote('after');
    });

    expect(await noteIds(dataSource)).toEqual(['after', 'outer']);
  });

  it('is undone by the outer rollback, unlike REQUIRES_NEW', async () => {
    await expect(
      runInResilientTransaction(async () => {
        await service.nested('inner');
        throw new Boom('outer fails');
      }),
    ).rejects.toThrow(Boom);

    expect(await noteIds(dataSource)).toEqual([]);
  });

  it('starts a plain transaction when there is nothing to nest inside', async () => {
    await service.nested('a');
    expect(await noteIds(dataSource)).toEqual(['a']);
  });
});

describe('SUPPORTS', () => {
  it('runs without a transaction when there is none', async () => {
    await service.supports('a');
    expect(isInTransaction()).toBe(false);
    expect(await noteIds(dataSource)).toEqual(['a']);
  });

  it('joins an existing transaction and is rolled back with it', async () => {
    await expect(
      runInResilientTransaction(async () => {
        await service.supports('a');
        expect(isInTransaction()).toBe(true);
        throw new Boom('outer fails');
      }),
    ).rejects.toThrow(Boom);

    expect(await noteIds(dataSource)).toEqual([]);
  });
});

describe('NOT_SUPPORTED', () => {
  it('suspends the surrounding transaction, so its writes survive the rollback', async () => {
    await expect(
      runInResilientTransaction(async () => {
        await service.notSupported('escaped');
        throw new Boom('outer fails');
      }),
    ).rejects.toThrow(Boom);

    expect(await noteIds(dataSource)).toEqual(['escaped']);
  });

  it('reports no active transaction inside', async () => {
    await runInResilientTransaction(async () => {
      expect(isInTransaction()).toBe(true);
      await service.notSupported('a');
    });
  });

  it('restores the surrounding transaction afterwards', async () => {
    await runInResilientTransaction(async () => {
      const outer = currentRunner();
      await service.notSupported('a');
      expect(currentRunner()).toBe(outer);
    });
  });
});

describe('MANDATORY', () => {
  it('throws when there is no transaction', async () => {
    await expect(service.mandatory('a')).rejects.toThrow(TransactionalError);
    expect(await noteIds(dataSource)).toEqual([]);
  });

  it('names the offending method in the error', async () => {
    await expect(service.mandatory('a')).rejects.toThrow(/mandatory/);
  });

  it('joins when a transaction exists', async () => {
    await runInResilientTransaction(async () => {
      await service.mandatory('a');
    });
    expect(await noteIds(dataSource)).toEqual(['a']);
  });
});

describe('NEVER', () => {
  it('runs when there is no transaction', async () => {
    await service.never('a');
    expect(await noteIds(dataSource)).toEqual(['a']);
  });

  it('throws when a transaction exists', async () => {
    await expect(
      runInResilientTransaction(async () => {
        await service.never('a');
      }),
    ).rejects.toThrow(TransactionalError);
  });
});
