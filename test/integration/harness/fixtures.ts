import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';

import { createTestDataSource } from './postgres.js';

@Entity('account')
export class Account {
  @PrimaryColumn('int')
  id!: number;

  @Column('int')
  balance!: number;
}

/**
 * A note row, used to observe which writes survived. Separate from `Account` so
 * propagation tests can write without contending on the same rows.
 */
@Entity('note')
export class Note {
  @PrimaryColumn('text')
  id!: string;

  @Column('text')
  body!: string;
}

export const ENTITIES = [Account, Note];

export function createFixtureDataSource(): DataSource {
  return createTestDataSource(ENTITIES);
}

/** Truncates between tests so each one starts from a known state. */
export async function resetFixtures(dataSource: DataSource): Promise<void> {
  await dataSource.query('TRUNCATE TABLE account, note');
}

export async function seedAccounts(
  dataSource: DataSource,
  accounts: readonly { id: number; balance: number }[],
): Promise<void> {
  await dataSource.getRepository(Account).save([...accounts]);
}

/** Reads a note's existence without going through any transactional context. */
export async function noteIds(dataSource: DataSource): Promise<string[]> {
  const rows = await dataSource.query<{ id: string }[]>('SELECT id FROM note ORDER BY id');
  return rows.map((r) => r.id);
}

export async function balanceOf(dataSource: DataSource, id: number): Promise<number | undefined> {
  const rows = await dataSource.query<{ balance: number }[]>(
    'SELECT balance FROM account WHERE id = $1',
    [id],
  );
  return rows[0]?.balance;
}
