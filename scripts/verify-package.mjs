#!/usr/bin/env node
/**
 * Packs the library, installs the tarball into a throwaway project, and checks
 * that it actually works from the outside.
 *
 * This exists because of a real bug it caught: esbuild can only code-split ESM, so
 * each CommonJS entry point (`index.js`, `compat.js`, `nestjs.js`) bundles its own
 * copy of the core. `ResilientTransactionalModule.forRoot()` imported from
 * `/nestjs` was initializing a context that `@Transactional()` imported from the
 * package root could not see — the documented NestJS quickstart, silently doing
 * nothing. No test inside the repo could find that, because in-repo tests share
 * one module graph.
 *
 *   node scripts/verify-package.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '[32m✔[0m' : '[31m✘[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const workDir = await mkdtemp(path.join(tmpdir(), 'resilient-tx-verify-'));

try {
  console.log('Building and packing…');
  run('pnpm', ['build'], repoRoot);

  const packed = run('npm', ['pack', '--pack-destination', workDir, '--silent'], repoRoot)
    .trim()
    .split('\n')
    .at(-1);
  const tarball = path.join(workDir, packed);

  console.log(`Installing ${packed} into a clean project…\n`);
  await writeFile(
    path.join(workDir, 'package.json'),
    JSON.stringify({ name: 'verify', private: true }),
  );
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--silent',
      'typeorm@1',
      'reflect-metadata',
      '@nestjs/common@11',
      'rxjs',
      tarball,
    ],
    workDir,
  );

  // ── the state-sharing regression ───────────────────────────────────────────
  const stateProbe = `
    require('reflect-metadata');
    const root = require('typeorm-resilient-transactional');
    const nest = require('typeorm-resilient-transactional/nestjs');
    nest.ResilientTransactionalModule.forRoot({ retry: { maxAttempts: 9 }, useNestLogger: false });
    console.log(JSON.stringify({
      initialized: root.isContextInitialized(),
      maxAttempts: root.getResilientDefaults().retry?.maxAttempts ?? null,
    }));
  `;
  await writeFile(path.join(workDir, 'state.cjs'), stateProbe);
  const state = JSON.parse(run('node', ['state.cjs'], workDir));

  check(
    'CJS: forRoot() from /nestjs reaches the package root',
    state.initialized === true && state.maxAttempts === 9,
    `initialized=${String(state.initialized)} maxAttempts=${String(state.maxAttempts)}`,
  );

  await writeFile(
    path.join(workDir, 'state.mjs'),
    `
    import 'reflect-metadata';
    import { isContextInitialized, getResilientDefaults } from 'typeorm-resilient-transactional';
    import { ResilientTransactionalModule } from 'typeorm-resilient-transactional/nestjs';
    ResilientTransactionalModule.forRoot({ retry: { maxAttempts: 9 }, useNestLogger: false });
    console.log(JSON.stringify({
      initialized: isContextInitialized(),
      maxAttempts: getResilientDefaults().retry?.maxAttempts ?? null,
    }));
  `,
  );
  const stateEsm = JSON.parse(run('node', ['state.mjs'], workDir));
  check(
    'ESM: forRoot() from /nestjs reaches the package root',
    stateEsm.initialized === true && stateEsm.maxAttempts === 9,
  );

  // ── the public surface resolves in both formats ────────────────────────────
  const surface = `
    import 'reflect-metadata';
    import * as root from 'typeorm-resilient-transactional';
    import * as compat from 'typeorm-resilient-transactional/compat';
    const missing = [
      'Transactional', 'runInResilientTransaction', 'runOnCommit', 'lockRowsInOrder',
      'withLockTimeout', 'extractSqlState', 'IsolationLevel', 'Propagation',
      'RetriesExhaustedError', 'initializeResilientContext', 'addResilientDataSource',
    ].filter((k) => root[k] === undefined);
    const compatMissing = [
      'initializeTransactionalContext', 'addTransactionalDataSource',
      'runInTransaction', 'runOnTransactionCommit',
    ].filter((k) => compat[k] === undefined);
    console.log(JSON.stringify({ missing, compatMissing }));
  `;
  await writeFile(path.join(workDir, 'surface.mjs'), surface);
  const { missing, compatMissing } = JSON.parse(run('node', ['surface.mjs'], workDir));

  check('ESM: the documented exports are all present', missing.length === 0, missing.join(', '));
  check(
    'ESM: /compat aliases are all present',
    compatMissing.length === 0,
    compatMissing.join(', '),
  );

  await writeFile(
    path.join(workDir, 'surface.cjs'),
    `
    require('reflect-metadata');
    const root = require('typeorm-resilient-transactional');
    const compat = require('typeorm-resilient-transactional/compat');
    console.log(JSON.stringify({
      root: typeof root.Transactional === 'function' && typeof root.lockRowsInOrder === 'function',
      compat: typeof compat.runOnTransactionCommit === 'function',
    }));
  `,
  );
  const cjsSurface = JSON.parse(run('node', ['surface.cjs'], workDir));
  check('CJS: root and /compat both load', cjsSurface.root === true && cjsSurface.compat === true);

  // ── no dependency creep ────────────────────────────────────────────────────
  // Read from the *installed* copy rather than the source tree, so this reflects
  // what a consumer actually receives.
  const installed = JSON.parse(
    await readFile(
      path.join(workDir, 'node_modules', 'typeorm-resilient-transactional', 'package.json'),
      'utf8',
    ),
  );
  const deps = Object.keys(installed.dependencies ?? {});
  check(
    'the published package declares zero runtime dependencies',
    deps.length === 0,
    deps.length === 0 ? 'none' : deps.join(', '),
  );
} finally {
  await rm(workDir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
if (failed.length > 0) {
  console.log(`\n${String(failed.length)} of ${String(checks.length)} package checks failed.`);
  process.exit(1);
}

console.log(`\nAll ${String(checks.length)} package checks passed.`);
