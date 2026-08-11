import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DataSource, EntityManager } from 'typeorm';

import { patchDataSource, patchRepositoryPrototype } from '../../src/core/datasource/patch.js';
import { ORIGINAL_MANAGER } from '../../src/core/datasource/symbols.js';
import { resetDiagnostics, setDiagnosticHandler } from '../../src/core/diagnostics.js';

/**
 * ADR 0006 promises that a TypeORM signature change degrades one patch with a
 * warning rather than throwing at import time. These tests are that promise.
 */

function fakeDataSource(): DataSource {
  return { manager: { tag: 'root' } } as unknown as DataSource;
}

/** Swaps a prototype method, returning a restore function. */
function stubPrototype(target: object, key: string, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(target, key);

  Object.defineProperty(target, key, { value, configurable: true, writable: true });

  return () => {
    if (previous === undefined) delete (target as Record<string, unknown>)[key];
    else Object.defineProperty(target, key, previous);
  };
}

afterEach(() => {
  resetDiagnostics();
  vi.restoreAllMocks();
});

describe('DataSource patch degradation', () => {
  it('skips the query patch and warns when the arity changed', () => {
    // Two parameters instead of three — what a defaulted argument upstream looks like.
    const restore = stubPrototype(DataSource.prototype, 'query', (_sql: string, _params: []) => {
      /* noop */
    });

    try {
      const handler = vi.fn();
      setDiagnosticHandler(handler);

      const ds = fakeDataSource();
      expect(() => patchDataSource(ds, 'default')).not.toThrow();

      const codes = handler.mock.calls.map((c) => (c[0] as { code: string }).code);
      expect(codes).toContain('patch-arity-query');

      const message = handler.mock.calls
        .map((c) => (c[0] as { message: string }).message)
        .join('\n');
      expect(message).toMatch(/arity 2, expected 3/);
    } finally {
      restore();
    }
  });

  it('still patches `manager` when a method patch degrades', () => {
    const restore = stubPrototype(DataSource.prototype, 'query', (_a: string) => undefined);

    try {
      setDiagnosticHandler(() => undefined);
      const ds = fakeDataSource();
      patchDataSource(ds, 'default');

      // The accessor is what repositories and `dataSource.manager` rely on; it has
      // no arity dependency and must survive regardless.
      const descriptor = Object.getOwnPropertyDescriptor(ds, 'manager');
      expect(descriptor?.get).toBeTypeOf('function');
    } finally {
      restore();
    }
  });

  it('warns when a patched method is missing entirely', () => {
    const restore = stubPrototype(DataSource.prototype, 'createQueryBuilder', undefined);

    try {
      const handler = vi.fn();
      setDiagnosticHandler(handler);

      expect(() => patchDataSource(fakeDataSource(), 'default')).not.toThrow();

      const codes = handler.mock.calls.map((c) => (c[0] as { code: string }).code);
      expect(codes).toContain('patch-missing-createQueryBuilder');
    } finally {
      restore();
    }
  });

  it('is idempotent', () => {
    const ds = fakeDataSource();
    patchDataSource(ds, 'default');
    const first = Object.getOwnPropertyDescriptor(ds, 'manager')?.get;

    patchDataSource(ds, 'other');
    const second = Object.getOwnPropertyDescriptor(ds, 'manager')?.get;

    expect(second).toBe(first);
  });

  it('keeps the real manager reachable outside any transaction', () => {
    const ds = fakeDataSource();
    const root = ds.manager;
    patchDataSource(ds, 'default');

    expect(ds.manager).toBe(root);
  });

  it('lets the manager be reassigned through the setter', () => {
    const ds = fakeDataSource();
    patchDataSource(ds, 'default');

    const replacement = { tag: 'replaced' } as unknown as EntityManager;
    // `manager` is `readonly` to TypeScript but a real accessor at runtime, and
    // TypeORM itself assigns it during initialization.
    (ds as { manager: EntityManager }).manager = replacement;

    expect(ds.manager).toBe(replacement);
  });
});

describe('Repository adoption', () => {
  const adopted: Record<string, unknown> = {};
  const nonConfigurable: Record<string, unknown> = {};
  const warnings: { code: string }[] = [];

  beforeAll(() => {
    // A repository that already owns a plain `manager` property — what exists when
    // repositories are constructed before initializeResilientContext() runs.
    Object.defineProperty(adopted, 'manager', {
      value: { tag: 'pre-existing' },
      configurable: true,
      writable: true,
      enumerable: true,
    });

    Object.defineProperty(nonConfigurable, 'manager', {
      value: { tag: 'frozen' },
      configurable: false,
      writable: false,
    });

    let next: Record<string, unknown> = adopted;
    stubPrototype(EntityManager.prototype, 'getRepository', () => next);

    setDiagnosticHandler((event) => warnings.push({ code: event.code }));
    patchRepositoryPrototype();

    const manager = Object.create(EntityManager.prototype) as {
      getRepository: () => unknown;
    };

    manager.getRepository();
    next = nonConfigurable;
    manager.getRepository();
  });

  it('removes the shadowing own property so the accessor can take over', () => {
    expect(Object.getOwnPropertyDescriptor(adopted, 'manager')).toBeUndefined();
  });

  it('preserves the original manager under the symbol', () => {
    expect(adopted[ORIGINAL_MANAGER as unknown as string]).toEqual({ tag: 'pre-existing' });
  });

  it('warns rather than throwing when the property cannot be replaced', () => {
    expect(warnings.map((w) => w.code)).toContain('patch-repository-non-configurable');
    expect(Object.getOwnPropertyDescriptor(nonConfigurable, 'manager')?.value).toEqual({
      tag: 'frozen',
    });
  });
});
