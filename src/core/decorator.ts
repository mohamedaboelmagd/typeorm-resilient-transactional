import { ResilientTransactionalError } from './errors/index.js';
import type { TransactionOptions } from './runner/run-in-transaction.js';
import { wrapInResilientTransaction } from './runner/wrap-in-transaction.js';

/** `Reflect.getMetadataKeys` exists only once `reflect-metadata` is loaded. */
interface MetadataReflect {
  getMetadataKeys?: (target: object) => unknown[];
  getMetadata?: (key: unknown, target: object) => unknown;
  defineMetadata?: (key: unknown, value: unknown, target: object) => void;
}

/**
 * Copies decorator metadata from the original method onto the wrapper.
 *
 * Replacing `descriptor.value` detaches everything other decorators recorded
 * against the method. Without this, a `@Get()` above a `@Transactional()` would
 * silently stop registering the route. Degrades to a no-op when
 * `reflect-metadata` is absent, since it is an optional peer.
 */
function copyMetadata(from: object, to: object): void {
  const reflect = Reflect as MetadataReflect;

  if (
    typeof reflect.getMetadataKeys !== 'function' ||
    typeof reflect.getMetadata !== 'function' ||
    typeof reflect.defineMetadata !== 'function'
  ) {
    return;
  }

  for (const key of reflect.getMetadataKeys(from)) {
    reflect.defineMetadata(key, reflect.getMetadata(key, from), to);
  }
}

/**
 * Runs the decorated method inside a transaction.
 *
 * ```ts
 * class LedgerService {
 *   @Transactional({ isolation: IsolationLevel.SERIALIZABLE })
 *   async transfer(from: string, to: string, amount: number) { ... }
 * }
 * ```
 *
 * Framework-agnostic — it imports nothing from NestJS and works on any class.
 */
export function Transactional(options?: TransactionOptions): MethodDecorator {
  return function transactionalDecorator<T>(
    _target: object,
    methodName: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ): void {
    const original = descriptor.value;

    if (typeof original !== 'function') {
      throw new ResilientTransactionalError(
        `@Transactional() can only decorate methods, but ${String(methodName)} is ` +
          `${typeof original}. Getters, setters, and properties are not supported.`,
      );
    }

    const wrapped = wrapInResilientTransaction(original as (...args: unknown[]) => unknown, {
      ...options,
      name: options?.name ?? String(methodName),
    });

    copyMetadata(original, wrapped);

    descriptor.value = wrapped as T;
  };
}
