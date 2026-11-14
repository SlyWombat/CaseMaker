/**
 * The gate's FILE CENSUS — a gate reports files as well as tests.
 *
 * A green "13,014 tests passed" says nothing about a spec file that never ran: one that failed to
 * load, one outside every project's match, one skipped whole. This reads a runner's JSON report and
 * the files on disk and prints one table per runner:
 *
 *   on disk      the spec files the repo holds (vitest: tests/unit/**\/*.spec.{ts,tsx};
 *                playwright: tests/e2e/**\/*.spec.ts)
 *   discovered   the files the runner's own config selects
 *   ran          files whose tests executed (passed or failed)
 *   skipped      files whose every test was skipped — named
 *   no-load      files that errored while loading, before a test could run — named
 *   unaccounted  files on disk that are in none of ran / skipped / no-load — named
 *   extra        files the runner reported that are NOT on disk — a stray file the gate ran
 *
 * RED (exit 1) when any file failed to load, when any file on disk is unaccounted, or when the
 * on-disk count differs from tools/gate/census-expected.json. The expected count moves only with a
 * commit that adds or removes a spec (`--write-expected` rewrites it from the disk).
 *
 *   npx vitest run --reporter=default --reporter=json --outputFile.json=/tmp/v.json
 *   npx tsx tools/gate/fileCensus.mts vitest /tmp/v.json
 *   PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/p.json npx playwright test --reporter=list,json
 *   npx tsx tools/gate/fileCensus.mts playwright /tmp/p.json
 *
 * `playwright … --lone` also loads every e2e spec ALONE (`playwright test --list <file>`). A whole
 * run loads all the files in one process, so a file that fails only when it is the first entry into
 * a module cycle (simIndexedTurn, 2026-11-14) is masked there; alone it cannot be.
 */
import { globSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const APP = process.cwd();
const EXPECTED = path.join(APP, 'tools', 'gate', 'census-expected.json');
const GLOBS = {
  vitest: 'tests/unit/**/*.spec.{ts,tsx}',
  playwright: 'tests/e2e/**/*.spec.ts',
} as const;
type Runner = keyof typeof GLOBS;

/** A path as the repo names it: a runner on another box reports an absolute path in ITS checkout. */
const rel = (p: string): string => {
  const flat = p.split(path.sep).join('/');
  const m = /(?:^|\/)(tests\/(?:unit|e2e)\/.*)$/.exec(flat);
  return m !== null ? m[1]! : path.relative(APP, path.resolve(APP, p)).split(path.sep).join('/');
};
const onDisk = (r: Runner): string[] => globSync(GLOBS[r], { cwd: APP }).map(rel).sort();

export interface Census {
  runner: Runner;
  onDisk: string[];
  ran: string[];
  skipped: string[];
  noLoad: { file: string; message: string }[];
  unaccounted: string[];
  /** Reported by the runner but not on disk in this checkout — a stray file the gate ran. */
  extra: string[];
}

interface VitestFile {
  name: string;
  status?: string;
  message?: string;
  assertionResults?: { status: string }[];
}

export function vitestCensus(report: { testResults: VitestFile[] }, disk: string[]): Census {
  const ran: string[] = [];
  const skipped: string[] = [];
  const noLoad: Census['noLoad'] = [];
  for (const f of report.testResults) {
    const file = rel(f.name);
    const results = f.assertionResults ?? [];
    if (results.length === 0 && (f.status === 'failed' || (f.message ?? '') !== '')) {
      noLoad.push({ file, message: (f.message ?? '').split('\n')[0] ?? '' });
    } else if (results.length > 0 && results.every((a) => a.status === 'skipped' || a.status === 'pending' || a.status === 'todo')) {
      skipped.push(file);
    } else if (results.length > 0) ran.push(file);
    else skipped.push(file); // a file with no tests at all: named, never silent
  }
  const seen = new Set([...ran, ...skipped, ...noLoad.map((n) => n.file)]);
  return { runner: 'vitest', onDisk: disk, ran, skipped, noLoad, unaccounted: disk.filter((f) => !seen.has(f)), extra: [...seen].filter((f) => !new Set(disk).has(f)).sort() };
}

interface PwSpec { tests?: { status?: string; results?: { status?: string }[] }[] }
interface PwSuite { file?: string; specs?: PwSpec[]; suites?: PwSuite[] }
interface PwReport { suites?: PwSuite[]; errors?: { message?: string; location?: { file?: string } }[] }

export function playwrightCensus(report: PwReport, disk: string[]): Census {
  const perFile = new Map<string, string[]>();
  const walk = (s: PwSuite, file: string | undefined): void => {
    const f = s.file ?? file;
    if (f !== undefined) {
      for (const spec of s.specs ?? []) {
        for (const t of spec.tests ?? []) {
          const status = t.status ?? t.results?.[t.results.length - 1]?.status ?? 'unknown';
          const key = rel(`tests/e2e/${f}`);
          perFile.set(key, [...(perFile.get(key) ?? []), status]);
        }
      }
    }
    for (const c of s.suites ?? []) walk(c, f);
  };
  for (const s of report.suites ?? []) walk(s, s.file);
  const ran: string[] = [];
  const skipped: string[] = [];
  for (const [file, statuses] of perFile) {
    if (statuses.every((s) => s === 'skipped')) skipped.push(file);
    else ran.push(file);
  }
  const noLoad: Census['noLoad'] = [];
  for (const e of report.errors ?? []) {
    const f = e.location?.file;
    if (f !== undefined) noLoad.push({ file: rel(f), message: (e.message ?? '').split('\n')[0] ?? '' });
  }
  const seen = new Set([...ran, ...skipped, ...noLoad.map((n) => n.file)]);
  return { runner: 'playwright', onDisk: disk, ran, skipped, noLoad, unaccounted: disk.filter((f) => !seen.has(f)), extra: [...seen].filter((f) => !new Set(disk).has(f)).sort() };
}

/** Loads each e2e file alone; a non-zero `--list` is a load error the whole-run order can mask. */
export function loneLoads(files: string[]): { file: string; message: string }[] {
  const bad: { file: string; message: string }[] = [];
  for (const file of files) {
    const r = spawnSync('npx', ['playwright', 'test', '--list', '--reporter=line', file], { cwd: APP, encoding: 'utf8', env: process.env });
    if (r.status !== 0) {
      const first = `${r.stdout}\n${r.stderr}`.split('\n').find((l) => /Error/.test(l)) ?? `exit ${String(r.status)}`;
      bad.push({ file, message: first.trim() });
    }
  }
  return bad;
}

export interface Verdict { red: boolean; reasons: string[] }

export function judge(c: Census, expectedCount: number | null, lone: { file: string; message: string }[]): Verdict {
  const reasons: string[] = [];
  if (c.noLoad.length > 0) reasons.push(`${c.noLoad.length} file(s) failed to load`);
  if (lone.length > 0) reasons.push(`${lone.length} file(s) failed to load ALONE`);
  if (c.extra.length > 0) reasons.push(`${c.extra.length} file(s) ran that are not on disk in this checkout`);
  if (c.unaccounted.length > 0) reasons.push(`${c.unaccounted.length} file(s) on disk ran in no column`);
  if (expectedCount !== null && c.onDisk.length !== expectedCount) {
    reasons.push(`${c.onDisk.length} files on disk, ${expectedCount} expected (a spec was added or removed without moving census-expected.json)`);
  }
  return { red: reasons.length > 0, reasons };
}

export function render(c: Census, v: Verdict, expectedCount: number | null, lone: { file: string; message: string }[] | null): string[] {
  const out: string[] = [];
  out.push(`FILE CENSUS — ${c.runner}`);
  out.push(`  on disk      ${c.onDisk.length}${expectedCount === null ? '' : `  (expected ${expectedCount})`}`);
  out.push(`  ran          ${c.ran.length}`);
  out.push(`  skipped      ${c.skipped.length}${c.skipped.length > 0 ? ` — ${c.skipped.map((f) => f.replace(/^tests\/(unit|e2e)\//, '')).join(', ')}` : ''}`);
  out.push(`  no-load      ${c.noLoad.length}${c.noLoad.map((n) => `\n     ${n.file}: ${n.message}`).join('')}`);
  const some = (xs: string[]): string => xs.slice(0, 25).map((f) => `\n     ${f}`).join('') + (xs.length > 25 ? `\n     … and ${xs.length - 25} more` : '');
  out.push(`  unaccounted  ${c.unaccounted.length}${some(c.unaccounted)}`);
  out.push(`  extra        ${c.extra.length}${some(c.extra)}`);
  if (lone !== null) out.push(`  load alone   ${c.onDisk.length - lone.length}/${c.onDisk.length}${lone.map((n) => `\n     ${n.file}: ${n.message}`).join('')}`);
  out.push(v.red ? `  RED — ${v.reasons.join('; ')}` : '  GREEN — every file on disk is accounted for');
  return out;
}

function main(argv: string[]): number {
  const [runner, second, ...rest] = argv;
  if (runner !== 'vitest' && runner !== 'playwright') {
    console.error('usage: fileCensus.mts <vitest|playwright> <report.json> [--lone]   |   <runner> --write-expected');
    return 2;
  }
  const disk = onDisk(runner);
  const expectedAll: Record<string, number> = existsSync(EXPECTED) ? (JSON.parse(readFileSync(EXPECTED, 'utf8')) as Record<string, number>) : {};
  if (second === '--write-expected') {
    writeFileSync(EXPECTED, JSON.stringify({ ...expectedAll, [runner]: disk.length }, null, 2) + '\n');
    console.log(`census-expected.json: ${runner} = ${disk.length}`);
    return 0;
  }
  if (second === undefined) { console.error('a report path is required'); return 2; }
  const report = JSON.parse(readFileSync(second, 'utf8')) as never;
  const census = runner === 'vitest' ? vitestCensus(report, disk) : playwrightCensus(report, disk);
  const lone = runner === 'playwright' && rest.includes('--lone') ? loneLoads(disk) : null;
  const expected = expectedAll[runner] ?? null;
  const verdict = judge(census, expected, lone ?? []);
  console.log(render(census, verdict, expected, lone).join('\n'));
  return verdict.red ? 1 : 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exit(main(process.argv.slice(2)));
}
