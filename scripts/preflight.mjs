#!/usr/bin/env node
/**
 * Verifies the local toolchain can actually run this repo's test suite.
 *
 * Integration tests need a real PostgreSQL via Testcontainers — mocking a deadlock
 * proves nothing — so a reachable Docker daemon is a hard requirement, not a
 * nice-to-have. Each check prints the specific remedy rather than a generic failure.
 */

import { execFileSync } from 'node:child_process';

const MIN_NODE_MAJOR = 20;

/** @type {{ name: string, ok: boolean, detail: string, remedy?: string }[]} */
const results = [];

function record(name, ok, detail, remedy) {
  results.push(remedy === undefined ? { name, ok, detail } : { name, ok, detail, remedy });
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// ── Node ─────────────────────────────────────────────────────────────────────
{
  const major = Number(process.versions.node.split('.')[0]);
  record(
    'Node >= 20',
    major >= MIN_NODE_MAJOR,
    `found v${process.versions.node}`,
    'nvm use 24   (TypeORM 1.x requires ^20.19.0 || ^22.13.0 || >=24.11.0)',
  );
}

// ── pnpm ─────────────────────────────────────────────────────────────────────
try {
  record('pnpm available', true, `found v${run('pnpm', ['--version'])}`);
} catch {
  record(
    'pnpm available',
    false,
    'not on PATH',
    'corepack enable && corepack prepare pnpm@latest --activate',
  );
}

// ── Docker ───────────────────────────────────────────────────────────────────
try {
  const server = run('docker', ['info', '--format', '{{.ServerVersion}}']);
  record('Docker daemon reachable', true, `server v${server}`);
} catch (err) {
  const stderr = String(err?.stderr ?? err?.message ?? '');
  let remedy = 'Start Docker, then verify with: docker run --rm hello-world';

  if (stderr.includes('permission denied')) {
    let inGroup = false;
    try {
      inGroup = run('getent', ['group', 'docker']).includes(process.env.USER ?? '\0');
    } catch {
      /* getent is not available everywhere; fall through to the general remedy */
    }
    remedy = inGroup
      ? 'You are in the docker group but this shell predates that change.\n' +
        '            Log out and back in, or prefix commands with: sg docker -c "<command>"'
      : 'sudo usermod -aG docker $USER   (then log out and back in)';
  } else if (stderr.includes('Cannot connect to the Docker daemon')) {
    remedy =
      'docker context use default   (a stale Docker Desktop context points at a dead socket)';
  }

  record('Docker daemon reachable', false, stderr.split('\n')[0]?.trim() || 'unreachable', remedy);
}

// ── Report ───────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);

for (const r of results) {
  console.log(`${r.ok ? '[32m✔[0m' : '[31m✘[0m'} ${r.name} — ${r.detail}`);
  if (!r.ok && r.remedy) console.log(`    [33mremedy:[0m ${r.remedy}`);
}

if (failed.length > 0) {
  console.log(`\n${failed.length} of ${results.length} preflight checks failed.`);
  process.exit(1);
}

console.log(`\nAll ${results.length} preflight checks passed.`);
