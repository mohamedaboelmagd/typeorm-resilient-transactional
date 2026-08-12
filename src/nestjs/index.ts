/**
 * NestJS integration.
 *
 * A separate entry point (`typeorm-resilient-transactional/nestjs`) on purpose:
 * `@nestjs/common` is an *optional* peer, and importing this from the package
 * root would make it mandatory for everyone — including the framework-agnostic
 * users `src/core/` exists to serve.
 */

export {
  ResilientTransactionalModule,
  type ResilientTransactionalModuleOptions,
} from './resilient-transactional.module.js';

export { useNestLogger, type LogLevel, type LogLevels } from './logger.js';
export { RESILIENT_TRANSACTIONAL_OPTIONS } from './tokens.js';
