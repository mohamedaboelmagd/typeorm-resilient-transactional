import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  IsolationLevel,
  Transactional,
  currentAttempt,
  lockRowsInOrder,
  runOnCommit,
} from 'typeorm-resilient-transactional';

import { Account } from './account.entity.js';

export class InsufficientFunds extends Error {}

/** Stand-in for whatever actually sends things in your application. */
export interface Notifier {
  transferCompleted(to: string, amount: number): Promise<void>;
}

/** An interface has no runtime value, so injection needs an explicit token. */
export const NOTIFIER = Symbol.for('example:notifier');

@Injectable()
export class LedgerService {
  constructor(
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
  ) {}

  /**
   * The optimistic path: SERIALIZABLE plus retry.
   *
   * Reads both balances and decides whether the transfer is allowed — a
   * read-then-write, which is exactly the shape SERIALIZABLE exists to protect
   * and which weaker isolation silently gets wrong under concurrency.
   *
   * `timeoutMs` bounds the *total* wall clock across every attempt, so an HTTP
   * caller cannot be left waiting while the transaction keeps retrying.
   */
  @Transactional({
    isolation: IsolationLevel.SERIALIZABLE,
    retry: { maxAttempts: 5 },
    timeoutMs: 5_000,
  })
  async transfer(fromId: string, toId: string, amount: number): Promise<void> {
    const from = await this.accounts.findOneByOrFail({ id: fromId });

    if (Number(from.balance) < amount) {
      // Not retryable, and correctly so: this will fail identically every time.
      throw new InsufficientFunds(`${fromId} cannot cover ${String(amount)}`);
    }

    await this.accounts.decrement({ id: fromId }, 'balance', amount);
    await this.accounts.increment({ id: toId }, 'balance', amount);

    // The whole reason this hook exists. The method body above re-runs on every
    // retry; this fires once, after the transaction is durable, and never at all
    // if it is abandoned. Sending the notification inline would email the
    // customer once per attempt.
    const attempt = currentAttempt();
    runOnCommit(async () => {
      await this.notifier.transferCompleted(toId, amount);
      if (attempt > 1) {
        // Captured before registering: hooks run outside the transaction context,
        // so currentAttempt() reads 0 by the time this executes.
        console.warn(`transfer to ${toId} succeeded on attempt ${String(attempt)}`);
      }
    });
  }

  /**
   * The pessimistic path: READ COMMITTED plus ordered locks.
   *
   * Faster than retrying under contention — see benchmarks/RESULTS.md — and
   * available whenever you can name the rows a transaction will touch, which for
   * a transfer you always can.
   *
   * `lockRowsInOrder` sorts the ids, so two opposing transfers (A→B and B→A)
   * take the same locks in the same order and cannot deadlock.
   */
  @Transactional({ isolation: IsolationLevel.READ_COMMITTED })
  async transferWithLocks(fromId: string, toId: string, amount: number): Promise<void> {
    const [first, second] = await lockRowsInOrder(this.accounts.manager, Account, [fromId, toId]);

    const from = [first, second].find((a) => a?.id === fromId);
    if (from === undefined) throw new Error(`account ${fromId} not found`);

    if (Number(from.balance) < amount) {
      throw new InsufficientFunds(`${fromId} cannot cover ${String(amount)}`);
    }

    await this.accounts.decrement({ id: fromId }, 'balance', amount);
    await this.accounts.increment({ id: toId }, 'balance', amount);

    runOnCommit(() => this.notifier.transferCompleted(toId, amount));
  }
}
