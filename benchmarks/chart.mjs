#!/usr/bin/env node
// Generates benchmarks/results.svg from benchmarks/RESULTS.md.
// No dependencies. Re-run with: node benchmarks/chart.mjs
//
// Plots throughput (ops/s, log-scale) vs concurrency for both contention
// profiles and all three strategies. Numbers are read straight from the
// markdown tables — nothing is estimated.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsPath = path.join(__dirname, 'RESULTS.md');
const outPath = path.join(__dirname, 'results.svg');

const md = fs.readFileSync(resultsPath, 'utf8');

// --- parse the two result tables -------------------------------------------

/**
 * @typedef {{ strategy: string, concurrency: number, throughput: number }} Row
 */

/**
 * Extract rows from the table that follows a heading containing `headingMatch`.
 * @param {string} text
 * @param {string} headingMatch
 * @returns {Row[]}
 */
function parseTable(text, headingMatch) {
  const lines = text.split('\n');
  let i = lines.findIndex((l) => l.includes(headingMatch));
  if (i === -1) throw new Error(`heading "${headingMatch}" not found`);
  // advance to the first table row (line starting with `|`)
  while (i < lines.length && !lines[i].startsWith('|')) i++;
  const rows = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    // skip header separator (---) and the header row
    if (line.includes('---')) continue;
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length);
    // header row: first cell is "Strategy"
    if (cells[0] === 'Strategy') continue;
    if (cells.length < 3) continue;
    const strategy = cells[0];
    const concurrency = Number(cells[1]);
    const throughput = Number(cells[2]);
    if (!Number.isFinite(concurrency) || !Number.isFinite(throughput)) continue;
    rows.push({ strategy, concurrency, throughput });
  }
  return rows;
}

const high = parseTable(md, 'high contention (10 accounts)');
const low = parseTable(md, 'low contention (1,000 accounts)');

if (high.length === 0 || low.length === 0) {
  throw new Error('failed to parse result tables');
}

// --- series definitions -----------------------------------------------------

const series = [
  {
    key: 'SERIALIZABLE + retry',
    color: '#2563eb', // blue
    label: 'SERIALIZABLE + retry',
    dashed: false,
  },
  {
    key: 'READ COMMITTED + locks',
    color: '#16a34a', // green
    label: 'READ COMMITTED + locks',
    dashed: false,
  },
  {
    key: 'SERIALIZABLE, no retry',
    color: '#dc2626', // red
    label: 'SERIALIZABLE, no retry',
    dashed: true,
  },
];

const concurrencies = [1, 10, 50, 100];

/**
 * @param {Row[]} rows
 * @param {string} key
 * @returns {number[]}
 */
function seriesThroughput(rows, key) {
  const byConc = new Map(
    rows.filter((r) => r.strategy === key).map((r) => [r.concurrency, r.throughput]),
  );
  return concurrencies.map((c) => byConc.get(c) ?? NaN);
}

// --- SVG layout -------------------------------------------------------------

const W = 980;
const H = 560;
const PAD_L = 70;
const PAD_R = 30;
const PAD_T = 64;
const PAD_B = 64;
const GAP = 56;

const panelW = (W - PAD_L - PAD_R - GAP) / 2;
const panelH = H - PAD_T - PAD_B;

// log-scale Y. Domain fixed across both panels so they are comparable.
const allVals = [...high, ...low].map((r) => r.throughput).filter((v) => v > 0);
const yMinRaw = Math.min(...allVals);
const yMaxRaw = Math.max(...allVals);
// round to nice log bounds
const yMin = Math.pow(10, Math.floor(Math.log10(yMinRaw)));
const yMax = Math.pow(10, Math.ceil(Math.log10(yMaxRaw)));

const xMin = 0.5;
const xMax = 120;

/**
 * @param {number} c
 * @param {number} originX
 * @returns {number}
 */
function xPos(c, originX) {
  // log-scale X too: 1,10,50,100 spread better
  const t = (Math.log10(c) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin));
  return originX + t * panelW;
}

/**
 * @param {number} v
 * @param {number} originY
 * @returns {number}
 */
function yPos(v, originY) {
  const t = (Math.log10(v) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin));
  return originY + panelH - t * panelH;
}

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {Row[]} rows
 * @param {string} title
 * @param {string} subtitle
 * @param {number} originX
 * @param {number} originY
 * @returns {string}
 */
function renderPanel(rows, title, subtitle, originX, originY) {
  let svg = '';

  // panel frame
  svg += `<rect x="${originX}" y="${originY}" width="${panelW}" height="${panelH}" fill="#ffffff" stroke="#d1d5db" stroke-width="1"/>`;

  // title
  svg += `<text x="${originX}" y="${originY - 28}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="15" font-weight="600" fill="#111827">${esc(title)}</text>`;
  svg += `<text x="${originX}" y="${originY - 11}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" fill="#6b7280">${esc(subtitle)}</text>`;

  // Y gridlines + labels (decade ticks)
  const yDecades = [];
  for (let e = Math.round(Math.log10(yMin)); e <= Math.round(Math.log10(yMax)); e++) {
    yDecades.push(Math.pow(10, e));
  }
  for (const v of yDecades) {
    const y = yPos(v, originY);
    svg += `<line x1="${originX}" y1="${y}" x2="${originX + panelW}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
    svg += `<text x="${originX - 8}" y="${y + 3.5}" text-anchor="end" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" fill="#6b7280">${v}</text>`;
  }
  // Y axis label
  svg += `<text x="${originX - 52}" y="${originY + panelH / 2}" transform="rotate(-90 ${originX - 52} ${originY + panelH / 2})" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" fill="#374151">throughput (ops/s, log)</text>`;

  // X ticks at the actual concurrency points
  for (const c of concurrencies) {
    const x = xPos(c, originX);
    svg += `<line x1="${x}" y1="${originY + panelH}" x2="${x}" y2="${originY + panelH + 5}" stroke="#9ca3af" stroke-width="1"/>`;
    svg += `<text x="${x}" y="${originY + panelH + 18}" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" fill="#6b7280">${c}</text>`;
  }
  svg += `<text x="${originX + panelW / 2}" y="${originY + panelH + 40}" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" fill="#374151">concurrency (workers, log)</text>`;

  // lines
  for (const s of series) {
    const vals = seriesThroughput(rows, s.key);
    const pts = vals
      .map((v, i) => {
        if (!Number.isFinite(v) || v <= 0) return null;
        return `${xPos(concurrencies[i], originX).toFixed(1)},${yPos(v, originY).toFixed(1)}`;
      })
      .filter((p) => p !== null);
    const dash = s.dashed ? ' stroke-dasharray="5 4"' : '';
    svg += `<polyline points="${pts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="2"${dash} stroke-linejoin="round" stroke-linecap="round"/>`;
    // points + value labels
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (!Number.isFinite(v) || v <= 0) continue;
      const x = xPos(concurrencies[i], originX);
      const y = yPos(v, originY);
      svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${s.color}" stroke="#ffffff" stroke-width="1"/>`;
    }
  }

  return svg;
}

const highOriginX = PAD_L;
const lowOriginX = PAD_L + panelW + GAP;
const originY = PAD_T;

let svg = '';
svg += `<?xml version="1.0" encoding="UTF-8"?>\n`;
svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif,system-ui,sans-serif">\n`;
svg += `<rect width="${W}" height="${H}" fill="#fafafa"/>\n`;

// main title
svg += `<text x="${W / 2}" y="30" text-anchor="middle" font-size="17" font-weight="700" fill="#111827">Throughput vs concurrency — bank-transfer workload</text>`;
svg += `<text x="${W / 2}" y="48" text-anchor="middle" font-size="11" fill="#6b7280">600 transfers per point · money conserved at every point · source: benchmarks/RESULTS.md</text>`;

svg += renderPanel(
  high,
  'High contention',
  '10 accounts — every transaction touches a tenth of the dataset',
  highOriginX,
  originY,
);
svg += renderPanel(
  low,
  'Low contention',
  '1,000 accounts — conflicts are occasional, like most real workloads',
  lowOriginX,
  originY,
);

// legend (bottom, spanning both panels)
const legendY = H - 22;
const legendItems = series.map((s) => ({
  label: s.label,
  color: s.color,
  dashed: s.dashed,
}));
let lx = PAD_L;
for (const it of legendItems) {
  const dash = it.dashed ? ' stroke-dasharray="5 4"' : '';
  svg += `<line x1="${lx}" y1="${legendY}" x2="${lx + 26}" y2="${legendY}" stroke="${it.color}" stroke-width="2"${dash}/>`;
  svg += `<circle cx="${lx + 13}" cy="${legendY}" r="3" fill="${it.color}"/>`;
  svg += `<text x="${lx + 33}" y="${legendY + 3.5}" font-size="11" fill="#374151">${esc(it.label)}</text>`;
  lx += 33 + it.label.length * 6.2 + 28;
}

svg += `</svg>\n`;

fs.writeFileSync(outPath, svg, 'utf8');
console.log(
  `wrote ${path.relative(process.cwd(), outPath)} (${high.length} high + ${low.length} low rows, yMin=${yMin} yMax=${yMax})`,
);
