#!/usr/bin/env node
/**
 * Loads the built package on the minimum supported Node and exercises it.
 *
 * `engines.node` says `>=20`, but the *toolchain* cannot run there — pnpm 11
 * requires Node >= 22.13 — so the usual matrix job would fail at `pnpm install`
 * for a reason that has nothing to do with the library. This checks the thing we
 * actually promise: that the shipped artifact works on Node 20.
 *
 * Run after `pnpm build`, with any Node >= 20.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const major = Number(process.versions.node.split('.')[0]);
assert.ok(major >= 20, `expected Node >= 20, got ${process.versions.node}`);

// ── ESM ──────────────────────────────────────────────────────────────────────
const esm = await import('../dist/index.mjs');

assert.equal(typeof esm.Transactional, 'function');
assert.equal(typeof esm.runInResilientTransaction, 'function');
assert.equal(typeof esm.runOnCommit, 'function');
assert.equal(typeof esm.lockRowsInOrder, 'function');
assert.equal(esm.extractSqlState({ driverError: { code: '40P01' } }), '40P01');
assert.equal(esm.isRetryable({ code: '40001' }, esm.DEFAULT_RETRYABLE_SQLSTATES), true);
assert.equal(esm.isRetryable({ code: '08006' }, esm.DEFAULT_RETRYABLE_SQLSTATES), false);

const delay = esm.computeBackoff(3, { strategy: 'exponential', baseMs: 25, capMs: 500 });
assert.equal(delay, 100);

// AsyncLocalStorage is the one runtime API the whole library rests on.
esm.initializeResilientContext();
assert.equal(esm.isContextInitialized(), true);
assert.equal(esm.isInTransaction(), false);
assert.equal(esm.currentAttempt(), 0);

// Optional peer absent or present, annotating must never throw.
esm.annotateActiveSpan({ 'db.transaction.attempt': 1 });

// ── CJS ──────────────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
const cjs = require('../dist/index.js');
const compat = require('../dist/compat.js');

assert.equal(typeof cjs.Transactional, 'function');
assert.equal(typeof compat.runOnTransactionCommit, 'function');
assert.equal(cjs.Propagation.NESTED, 'NESTED');
assert.equal(cjs.IsolationLevel.SERIALIZABLE, 'SERIALIZABLE');

console.log(`Built package loads and behaves correctly on Node ${process.versions.node}.`);
