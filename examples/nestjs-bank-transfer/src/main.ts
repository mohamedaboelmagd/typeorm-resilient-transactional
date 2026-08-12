import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import {
  addResilientDataSource,
  initializeResilientContext,
} from 'typeorm-resilient-transactional';

import { AppModule } from './app.module.js';

/**
 * Ordering matters here, and it is the one thing people get wrong.
 *
 * `initializeResilientContext()` patches `Repository.prototype`, and that has to
 * happen **before** NestJS constructs any repository during dependency
 * injection. Calling it at the top of `main.ts` — before `NestFactory.create()` —
 * is the reliable place.
 */
export async function bootstrap(): Promise<void> {
  initializeResilientContext();

  const app = await NestFactory.create(AppModule);

  // Registering is explicit so the library never has to guess which DataSource
  // you meant in a multi-database application.
  addResilientDataSource(app.get(DataSource));

  await app.listen(3000);
}

if (process.env['NODE_ENV'] !== 'test') {
  void bootstrap();
}
