import { Logger, type LoggerService } from '@nestjs/common';

import { setDiagnosticHandler, type DiagnosticEvent } from '../core/diagnostics.js';

export type LogLevel = 'error' | 'warn' | 'log' | 'debug' | 'verbose' | 'silent';

/**
 * Which level each diagnostic is emitted at.
 *
 * Retry warnings are the ones people most often want to turn down — a busy system
 * under `SERIALIZABLE` legitimately retries, and a warning per method is
 * informative once and noise thereafter. Patch degradations are the ones nobody
 * should be able to silence casually, since they mean part of the library quietly
 * stopped working.
 */
export interface LogLevels {
  /** Patch degradation, hook failures, rollback/release failures. Default `warn`. */
  warn?: LogLevel;
  /** Diagnostics the library emits for information. Default `debug`. */
  debug?: LogLevel;
}

const DEFAULT_CONTEXT = 'ResilientTransactional';

/**
 * Routes library diagnostics into NestJS's logger.
 *
 * Without this they go to `console.warn`, which bypasses your log formatting,
 * levels, and transports — and in a JSON-logging service is exactly the line
 * nobody sees.
 */
export function useNestLogger(
  logger: LoggerService = new Logger(DEFAULT_CONTEXT),
  levels: LogLevels = {},
): void {
  const warnLevel = levels.warn ?? 'warn';
  const debugLevel = levels.debug ?? 'debug';

  setDiagnosticHandler((event: DiagnosticEvent) => {
    const level = event.level === 'warn' ? warnLevel : debugLevel;
    if (level === 'silent') return;

    const message = `[${event.code}] ${event.message}`;

    switch (level) {
      case 'error':
        logger.error(message, DEFAULT_CONTEXT);
        return;
      case 'warn':
        logger.warn(message, DEFAULT_CONTEXT);
        return;
      case 'log':
        logger.log(message, DEFAULT_CONTEXT);
        return;
      case 'debug':
        logger.debug?.(message, DEFAULT_CONTEXT);
        return;
      case 'verbose':
        logger.verbose?.(message, DEFAULT_CONTEXT);
        return;
    }
  });
}
