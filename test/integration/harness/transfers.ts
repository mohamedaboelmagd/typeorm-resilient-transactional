import { Column, Entity, PrimaryColumn, type DataSource } from 'typeorm';

import {
  IsolationLevel,
  lockRowsInOrder,
  runInResilientTransaction,
  type RetryInfo,
} from '../../../src/index.js';

/**
 * A real entity, not a bare table name: `lockRowsInOrder` resolves the primary
 * key through TypeORM's metadata, which only exists for registered entities.
 */
@Entity('bench_account')
export class BenchAccount {
  @PrimaryColumn('int')
  id!: number;

  @Column('bigint')
  balance!: string;
}

/**
 * The canonical contended workload: money moving between a small pool of
 * accounts, from many concurrent transactions.
 *
 * Shared by the invariant test and the benchmarks so both measure the same thing.
 * Deliberately read-then-write — that is what produces serialization conflicts
 * under SERIALIZABLE, and what a blind `UPDATE … SET balance = balance - $1`
 * would hide.
 */

export const ACCOUNT_TABLE = 'bench_account';

export type Strategy =
  /** SERIALIZABLE with automatic retry — what this library exists to make usable. */
  | 'serializable-retry'
  /** READ COMMITTED with ordered `FOR UPDATE` locks — the usual alternative. */
  | 'read-committed-locks'
  /** SERIALIZABLE with no retry — the status quo this library replaces. */
  | 'serializable-no-retry';

export interface TransferOptions {
  maxAttempts?: number;
  onRetry?: (info: RetryInfo) => void;
}

export async function setupAccounts(
  dataSource: DataSource,
  count: number,
  startingBalance: number,
): Promise<void> {
  // The table itself is created by `synchronize` from the entity above; this only
  // resets its contents between rounds.
  await dataSource.query(`TRUNCATE TABLE ${ACCOUNT_TABLE}`);
  await dataSource.query(
    `INSERT INTO ${ACCOUNT_TABLE} (id, balance)
     SELECT g, $1 FROM generate_series(1, $2) g`,
    [startingBalance, count],
  );
}

export interface Totals {
  readonly total: number;
  readonly negatives: number;
}

export async function accountTotals(dataSource: DataSource): Promise<Totals> {
  const rows = await dataSource.query<{ total: string; negatives: string }[]>(
    `SELECT COALESCE(SUM(balance), 0)::text AS total,
            COUNT(*) FILTER (WHERE balance < 0)::text AS negatives
     FROM ${ACCOUNT_TABLE}`,
  );

  return {
    total: Number(rows[0]?.total ?? 0),
    negatives: Number(rows[0]?.negatives ?? 0),
  };
}

/**
 * Moves `amount` from one account to another, or does nothing if the source
 * cannot cover it.
 *
 * The balance check is what makes this a *read-then-write*: two transactions
 * both reading a balance and both deciding they can afford a withdrawal is the
 * write skew SERIALIZABLE exists to catch.
 */
export function makeTransfer(
  strategy: Strategy,
  options: TransferOptions = {},
): (from: number, to: number, amount: number) => Promise<boolean> {
  const { maxAttempts = 10, onRetry } = options;

  return async (from, to, amount) => {
    const body = async (
      manager: Parameters<Parameters<typeof runInResilientTransaction>[0]>[0],
    ) => {
      if (strategy === 'read-committed-locks') {
        // Sorted acquisition — without it this workload deadlocks constantly,
        // which would make the comparison a measurement of our own carelessness.
        await lockRowsInOrder(manager, BenchAccount, [from, to]);
      }

      const rows = await manager.query<{ id: number; balance: string }[]>(
        `SELECT id, balance FROM ${ACCOUNT_TABLE} WHERE id = ANY($1)`,
        [[from, to]],
      );

      const source = rows.find((r) => r.id === from);
      if (source === undefined || Number(source.balance) < amount) return false;

      await manager.query(`UPDATE ${ACCOUNT_TABLE} SET balance = balance - $1 WHERE id = $2`, [
        amount,
        from,
      ]);
      await manager.query(`UPDATE ${ACCOUNT_TABLE} SET balance = balance + $1 WHERE id = $2`, [
        amount,
        to,
      ]);

      return true;
    };

    if (strategy === 'read-committed-locks') {
      return runInResilientTransaction(body, {
        isolation: IsolationLevel.READ_COMMITTED,
        retry: false,
      });
    }

    if (strategy === 'serializable-no-retry') {
      return runInResilientTransaction(body, {
        isolation: IsolationLevel.SERIALIZABLE,
        retry: false,
      });
    }

    return runInResilientTransaction(body, {
      isolation: IsolationLevel.SERIALIZABLE,
      retry: {
        maxAttempts,
        backoff: { strategy: 'exponential-full-jitter', baseMs: 2, capMs: 50 },
      },
      ...(onRetry === undefined ? {} : { onRetry }),
    });
  };
}

/** Distinct random pair, so a transfer never has the same source and destination. */
export function randomPair(accountCount: number): [number, number] {
  const from = 1 + Math.floor(Math.random() * accountCount);
  let to = from;
  while (to === from) to = 1 + Math.floor(Math.random() * accountCount);
  return [from, to];
}
