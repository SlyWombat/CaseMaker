#!/usr/bin/env node
// cPanel UAPI quota check — bandwidth + disk + database / domain caps.
// Reads the same .env at the repo root that scripts/deploy-cpanel.mjs uses
// (CPANEL_HOST / CPANEL_PORT / CPANEL_USER / CPANEL_TOKEN).
//
// Usage:
//   npm run quota
//   npm run quota -- --json   # raw JSON for scripting
//
// Notes:
// - StatsBar::get_stats reliably returns bandwidth + disk on every cPanel
//   version we've seen. ResourceUsage::get_usages adds the LVE caps (CPU,
//   memory, processes, IOPS) when the host has CloudLinux installed.
// - Bandwidth::query needs a `grouping` parameter to work; not used here
//   because StatsBar already gives us the monthly headline number.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const ENV_PATH = process.env.CASEMAKER_ENV ?? resolve(REPO_ROOT, '.env');
const JSON_OUTPUT = process.argv.includes('--json');

if (!existsSync(ENV_PATH)) {
  console.error(`No .env found at ${ENV_PATH}. Set CASEMAKER_ENV or create it.`);
  process.exit(1);
}

const env = {};
for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

for (const k of ['CPANEL_HOST', 'CPANEL_USER', 'CPANEL_TOKEN']) {
  if (!env[k]) {
    console.error(`Missing ${k} in ${ENV_PATH}`);
    process.exit(1);
  }
}

const HOST = env.CPANEL_HOST;
const PORT = env.CPANEL_PORT || '2083';
const USER = env.CPANEL_USER;
const TOKEN = env.CPANEL_TOKEN;
const auth = `cpanel ${USER}:${TOKEN}`;
const baseUrl = `https://${HOST}:${PORT}`;

async function uapi(module, fn, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${baseUrl}/execute/${module}/${fn}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) {
    throw new Error(`${module}::${fn} → HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

const stats = await uapi('StatsBar', 'get_stats', { display: 'bandwidthusage|diskusage' });
const usages = await uapi('ResourceUsage', 'get_usages').catch(() => null);

const bandwidth = stats.data?.find((s) => s.id === 'bandwidthusage');
const disk = stats.data?.find((s) => s.id === 'diskusage');

if (JSON_OUTPUT) {
  console.log(JSON.stringify({ bandwidth, disk, resourceUsages: usages?.data ?? null }, null, 2));
  process.exit(0);
}

function fmt(label, item) {
  if (!item) {
    console.log(`  ${label.padEnd(12)} (unavailable)`);
    return;
  }
  const used = item.count;
  const cap = item.max;
  const pct = item.percent;
  console.log(`  ${label.padEnd(12)} ${used.padEnd(12)} of ${cap.padEnd(8)} (${pct}%)`);
}

console.log(`\ncPanel quota — ${USER}@${HOST}\n`);
console.log(`  ${'metric'.padEnd(12)} ${'used'.padEnd(12)}    ${'cap'.padEnd(8)}`);
console.log(`  ${'-'.repeat(12)} ${'-'.repeat(12)}    ${'-'.repeat(12)}`);
fmt('Bandwidth', bandwidth);
fmt('Disk', disk);

if (usages?.data) {
  const inMb = (n) => (typeof n === 'string' ? parseInt(n, 10) : n) / 1_000_000;
  const fmtBytes = (n, max) => `${inMb(n).toFixed(1)} MB / ${(inMb(max) / 1024).toFixed(2)} GB`;
  const dbDisk = usages.data.find((u) => u.id === 'cachedmysqldiskusage');
  const procs = usages.data.find((u) => u.id === 'lvenproc');
  const mem = usages.data.find((u) => u.id === 'lvememphy');
  if (dbDisk) console.log(`  ${'DB disk'.padEnd(12)} ${fmtBytes(dbDisk.usage, dbDisk.maximum)}`);
  if (procs) console.log(`  ${'Processes'.padEnd(12)} ${procs.usage} / ${procs.maximum}`);
  if (mem) console.log(`  ${'Memory'.padEnd(12)} ${(inMb(mem.usage) / 1024).toFixed(2)} GB / ${(inMb(mem.maximum) / 1024).toFixed(2)} GB`);
}

console.log();
