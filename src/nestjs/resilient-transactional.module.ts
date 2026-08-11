import { Global, Module, type DynamicModule, type LoggerService } from '@nestjs/common';

import { setResilientDefaults, type ResilientDefaults } from '../core/config.js';
import { initializeResilientContext } from '../core/datasource/registry.js';
import { useNestLogger, type LogLevels } from './logger.js';
import { RESILIENT_TRANSACTIONAL_OPTIONS } from './tokens.js';

export interface ResilientTransactionalModuleOptions extends ResilientDefaults {
  /**
   * Route library diagnostics through NestJS's logger instead of `console.warn`.
   * Defaults to `true`.
   */
  useNestLogger?: boolean;
  /** Custom logger, when the default `Logger` is not what you want. */
  logger?: LoggerService;
  /** Per-event log levels. `silent` turns a category off. */
  logLevels?: LogLevels;
}

/**
 * Installs the transactional context and application-wide defaults.
 *
 * ```ts
 * @Module({
 *   imports: [
 *     TypeOrmModule.forRoot({ ... }),
 *     ResilientTransactionalModule.forRoot({
 *       defaultIsolation: IsolationLevel.READ_COMMITTED,
 *       retry: { maxAttempts: 3 },
 *       onRetry: (info) => metrics.increment('tx.retry', { code: info.sqlstate }),
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * Registering data sources stays explicit — call `addResilientDataSource()` where
 * you create them, so the library never has to guess which `DataSource` you meant
 * in a multi-database application.
 *
 * The context is installed in `forRoot()` rather than in a lifecycle hook,
 * because repositories are constructed during dependency injection and the
 * `Repository.prototype` patch has to be in place before that happens.
 */
@Global()
@Module({})
export class ResilientTransactionalModule {
  static forRoot(options: ResilientTransactionalModuleOptions = {}): DynamicModule {
    const { useNestLogger: routeLogs = true, logger, logLevels, ...defaults } = options;

    initializeResilientContext();
    setResilientDefaults(defaults);

    if (routeLogs) {
      useNestLogger(logger, logLevels);
    }

    return {
      module: ResilientTransactionalModule,
      providers: [{ provide: RESILIENT_TRANSACTIONAL_OPTIONS, useValue: options }],
      exports: [RESILIENT_TRANSACTIONAL_OPTIONS],
    };
  }
}
