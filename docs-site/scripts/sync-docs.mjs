#!/usr/bin/env node
/**
 * Copies the repository's Markdown into the Starlight content directory.
 *
 * `docs/` stays the single source of truth — it is what GitHub renders and what
 * every code comment links to. Duplicating prose into a second tree would
 * guarantee the two drift, so the site is generated from those files instead,
 * with only the frontmatter Starlight needs added on the way through.
 *
 * Relative links between docs are rewritten to the site's URL shape.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(siteRoot);
const outDir = path.join(siteRoot, 'src', 'content', 'docs');

/** Ordered so the sidebar reads as a path through the project. */
const PAGES = [
  { from: 'README.md', to: 'index.md', title: 'Overview', order: 1 },
  { from: 'docs/safety.md', to: 'safety.md', title: 'Safety', order: 2 },
  { from: 'docs/lock-ordering.md', to: 'lock-ordering.md', title: 'Lock ordering', order: 3 },
  { from: 'docs/internals.md', to: 'internals.md', title: 'Internals', order: 4 },
  { from: 'MIGRATION.md', to: 'migration.md', title: 'Migration', order: 5 },
  { from: 'docs/prior-art.md', to: 'prior-art.md', title: 'Prior art', order: 6 },
  { from: 'benchmarks/RESULTS.md', to: 'benchmarks.md', title: 'Benchmarks', order: 7 },
];

/** Repo-relative links → site routes. */
const LINK_REWRITES = [
  [/\]\(docs\/adr\/([\w-]+)\.md\)/g, '](/adr/$1/)'],
  [/\]\(adr\/([\w-]+)\.md\)/g, '](/adr/$1/)'],
  [/\]\((?:\.\.\/)*docs\/([\w-]+)\.md\)/g, '](/$1/)'],
  [/\]\((?:\.\.\/)*benchmarks\/RESULTS\.md\)/g, '](/benchmarks/)'],
  [/\]\((?:\.\.\/)*MIGRATION\.md\)/g, '](/migration/)'],
  [/\]\((?:\.\.\/)*README\.md(#[\w-]+)?\)/g, '](/$1)'],
  [/\]\(([\w-]+)\.md\)/g, '](/$1/)'],
];

function rewriteLinks(markdown) {
  return LINK_REWRITES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    markdown,
  );
}

/** Starlight renders the frontmatter title, so drop the leading `# Heading`. */
function stripLeadingHeading(markdown) {
  return markdown.replace(/^#\s+.*\n+/, '');
}

function escapeYaml(value) {
  return value.replace(/"/g, '\\"');
}

async function emit(sourcePath, targetPath, title, order, description) {
  const raw = await readFile(sourcePath, 'utf8');

  const frontmatter = [
    '---',
    `title: "${escapeYaml(title)}"`,
    ...(description === undefined ? [] : [`description: "${escapeYaml(description)}"`]),
    'sidebar:',
    `  order: ${String(order)}`,
    '---',
    '',
  ].join('\n');

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, frontmatter + rewriteLinks(stripLeadingHeading(raw)), 'utf8');
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const page of PAGES) {
  await emit(path.join(repoRoot, page.from), path.join(outDir, page.to), page.title, page.order);
}

// ADRs are numbered, so their filenames already carry the intended order.
const adrDir = path.join(repoRoot, 'docs', 'adr');
const adrs = (await readdir(adrDir)).filter((f) => f.endsWith('.md')).sort();

for (const [index, file] of adrs.entries()) {
  const raw = await readFile(path.join(adrDir, file), 'utf8');
  const heading = /^#\s+(.*)$/m.exec(raw)?.[1] ?? file.replace(/\.md$/, '');

  await emit(
    path.join(adrDir, file),
    path.join(outDir, 'adr', file),
    heading,
    index + 1,
    'Architecture decision record',
  );
}

console.log(
  `Synced ${String(PAGES.length + adrs.length)} pages into ${path.relative(repoRoot, outDir)}`,
);
