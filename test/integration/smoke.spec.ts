import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';

import { createTestDataSource, getPgConnection } from './harness/postgres.js';

@Entity('smoke_account')
class SmokeAccount {
  @PrimaryColumn('int')
  id!: number;

  @Column('bigint')
  balance!: string;
}

describe('testcontainers harness', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource([SmokeAccount]);
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('connects to a real PostgreSQL server', async () => {
    const rows = await dataSource.query<{ version: string }[]>('SELECT version()');
    expect(rows[0]?.version).toMatch(/^PostgreSQL /);
  });

  it('reports the image the run is pinned to', () => {
    expect(getPgConnection().image).toMatch(/^postgres:/);
  });

  it('applied the harness postgres settings', async () => {
    const rows = await dataSource.query<{ name: string; setting: string }[]>(
      `SELECT name, setting FROM pg_settings WHERE name IN ('deadlock_timeout','log_lock_waits')`,
    );

    const settings = Object.fromEntries(rows.map((r) => [r.name, r.setting]));

    // Set in global-setup.ts so deadlock tests resolve in ~200ms rather than
    // sitting on the 1s default. If this drifts, the Phase 3 suite gets slow.
    expect(settings['deadlock_timeout']).toBe('200');
    expect(settings['log_lock_waits']).toBe('on');
  });

  it('synchronized the schema', async () => {
    await dataSource.getRepository(SmokeAccount).save({ id: 1, balance: '100' });
    const found = await dataSource.getRepository(SmokeAccount).findOneByOrFail({ id: 1 });
    expect(found.balance).toBe('100');
  });

  // The whole library rests on SERIALIZABLE being available and on TypeORM's
  // QueryRunner savepoint machinery (docs/prior-art.md §4.2). Both are asserted
  // here so a driver or version change surfaces in Phase 1, not Phase 5.
  it('supports SERIALIZABLE and nested savepoints on one query runner', async () => {
    const qr = dataSource.createQueryRunner();
    try {
      await qr.connect();
      await qr.startTransaction('SERIALIZABLE');

      const iso = (await qr.query('SHOW transaction_isolation')) as {
        transaction_isolation: string;
      }[];
      expect(iso[0]?.transaction_isolation).toBe('serializable');

      // Depth 1 → 2 must emit SAVEPOINT rather than a second START TRANSACTION.
      await qr.startTransaction();
      await qr.query(`INSERT INTO smoke_account (id, balance) VALUES (2, 5)`);
      await qr.rollbackTransaction(); // ROLLBACK TO SAVEPOINT

      // The outer transaction survived the savepoint rollback.
      await qr.query(`INSERT INTO smoke_account (id, balance) VALUES (3, 7)`);
      await qr.commitTransaction();

      const ids = await dataSource.query<{ id: number }[]>(
        'SELECT id FROM smoke_account ORDER BY id',
      );
      expect(ids.map((r) => r.id)).toEqual([1, 3]);
    } finally {
      await qr.release();
    }
  });
});
