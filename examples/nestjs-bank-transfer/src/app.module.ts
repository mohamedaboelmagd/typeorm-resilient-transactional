import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IsolationLevel } from 'typeorm-resilient-transactional';
import { ResilientTransactionalModule } from 'typeorm-resilient-transactional/nestjs';

import { Account } from './account.entity.js';
import { LedgerService, NOTIFIER, type Notifier } from './ledger.service.js';

const notifier: Notifier = {
  transferCompleted: (to, amount) => {
    console.log(`notified ${to} of ${String(amount)}`);
    return Promise.resolve();
  },
};

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env['DATABASE_URL'] ?? 'postgres://test:test@localhost:5432/bank',
      entities: [Account],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([Account]),

    ResilientTransactionalModule.forRoot({
      // Applied to any @Transactional() that does not name one.
      defaultIsolation: IsolationLevel.READ_COMMITTED,

      // Application-wide policy. Per-method options are deep-merged over this,
      // so `retry: { maxAttempts: 5 }` on one method keeps this backoff.
      retry: {
        maxAttempts: 3,
        backoff: { strategy: 'exponential-full-jitter', baseMs: 25, capMs: 500 },
      },

      onRetry: (info) => {
        console.warn(`retry ${String(info.attempt)}/${String(info.maxAttempts)}`, {
          method: info.method,
          sqlstate: info.sqlstate,
          delayMs: info.delayMs,
        });
      },

      onExhausted: (info) => {
        console.error('gave up retrying', { method: info.method, sqlstate: info.sqlstate });
      },

      // Any object implementing RetryMetrics. No dependency on a metrics library.
      metrics: {
        recordRetry: (info) => void info,
        recordCommit: (outcome) => {
          if (outcome.attempts > 1) {
            console.log(
              `${outcome.method ?? 'tx'} committed on attempt ${String(outcome.attempts)}`,
            );
          }
        },
      },
    }),
  ],
  providers: [LedgerService, { provide: NOTIFIER, useValue: notifier }],
})
export class AppModule {}
