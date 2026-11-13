/**
 * #1233 — compare two baseline folders (the layout #1212 saved) and write COMPARISON.md.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json tools/baseline/compare.mts <before-dir> <after-dir> --out <dir> [--makerables <dir>]
 *
 * --makerables (or $CM_MAKERABLES, or ~/makerables) is where the vendor's posted programs live: each is put on OUR clock
 * (vendorClock.ts) so every ratio in section 3 is taken on one clock; without it those columns read "not recorded".
 *
 * READ-ONLY on both folders. Writes <out>/COMPARISON.md and <out>/pictures/. Every figure is read
 * from a saved file (`tray/<run>/{facts,timing}.json`, `references/<part>/card.json` or the demo's
 * `runs/**\/ref-*\/card.json`, `samples/results.json`, the suites' logs); the tables themselves are
 * the pure functions in `compareTables.ts`. A folder from `rerun.sh` and the v0.2 folder differ in
 * small ways (no `references/` split, no `timing.csv`), so each loader tries both shapes.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { vendorClock, type VendorClock } from './vendorClock';
import {
  TRAY_RUNS,
  buildComparison,
  parseCargoLog,
  parseE2eLog,
  parseTscLog,
  parseVitestLog,
  programRows,
  type CutFigure,
  type CutPart,
  type CutTable,
  type HeadlineInput,
  type PictureSet,
  type ProgramGroup,
  type RefFacts,
  type RunHeader,
  type StatusRec,
  type SuiteFacts,
  type TrayRunFacts,
} from './compareTables';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function readJson(path: string): Json | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Json;
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function dirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

function files(path: string, re: RegExp): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((d) => d.isFile() && re.test(d.name)).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// -------------------------------------------------------------------------------------- header

function loadHeader(dir: string): RunHeader {
  const m = readJson(join(dir, 'manifest.json')) ?? {};
  let machine: string | undefined;
  const mm = (m.machine ?? {}) as Json;
  const host = mm.hostname ? mm : Object.values(mm).find((v) => v && typeof v === 'object' && (v as Json).hostname);
  if (host) {
    const h = host as Json;
    machine = [h.hostname, h.cpu, h.cores ? `${h.cores} cores` : null, h.ramGiB ? `${h.ramGiB} GiB` : null, h.node].filter(Boolean).join(', ');
  }
  const patches = (Array.isArray(m.harnessPatches) ? m.harnessPatches : []).map((p: unknown) =>
    typeof p === 'string' ? p : String(((p as Json).what as string | undefined) ?? JSON.stringify(p)),
  );
  const busyRuns = Array.isArray(m.busyRuns) ? (m.busyRuns as unknown[]).map(String) : undefined;
  return { sha: String(m.sha ?? 'unknown'), tag: typeof m.tag === 'string' ? m.tag : null, startedAt: m.startedAt, machine, harnessPatches: patches, busyRuns };
}

// -------------------------------------------------------------------------------------- tray + suites

/** The first run's wall plus every repeat-k/tray/<run>/timev.json that rerun.sh --repeat wrote. */
function repeatWalls(dir: string, run: string, first: number | null): number[] {
  const out: number[] = first === null ? [] : [first];
  for (const r of dirs(dir).filter((d) => /^repeat-\d+$/.test(d)).sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)))) {
    const t = readJson(join(dir, r, 'tray', run, 'timev.json'));
    const w = t ? num(t.wallSeconds) : null;
    if (w !== null) out.push(w);
  }
  return out;
}

/** A run whose receipt says `ok: false` refused: "refused at <stage>: <first reason>", or null when it planned. */
function refusalOf(dir: string, run: string): string | null {
  const r = readJson(join(dir, 'tray', run, 'receipt.json'));
  if (!r || r.ok !== false) return null;
  const first = Array.isArray(r.refusals) ? ((r.refusals as Json[]).find((x) => x.code !== 'stopped') ?? (r.refusals as Json[])[0]) : null;
  return `refused at ${String(r.stage ?? '?')}${first ? `: ${String(first.reason ?? first.code).replace(/\s+/g, ' ').slice(0, 110)}` : ''}`;
}

function loadTray(dir: string): Record<string, TrayRunFacts> {
  const out: Record<string, TrayRunFacts> = {};
  for (const run of TRAY_RUNS) {
    const facts = readJson(join(dir, 'tray', run, 'facts.json'));
    if (!facts) continue;
    const timing = readJson(join(dir, 'tray', run, 'timing.json')) ?? {};
    const est = (facts.estimatedCycleSeconds ?? {}) as Json;
    const lo = Array.isArray(facts.leftoverFractions) ? (facts.leftoverFractions as unknown[]) : [];
    out[run] = {
      owned: num(est.owned),
      ideal: num(est.ideal),
      bitChanges: num(facts.bitChanges),
      programs: num(facts.programCount),
      coveragePct: num(facts.coveragePct),
      cellsOver1mmPct: num(lo[2]) === null ? null : (lo[2] as number) * 100,
      adjudicated: num(facts.adjudicatedFraction),
      wall: num(timing.totalWallSeconds),
      walls: repeatWalls(dir, run, num(timing.totalWallSeconds)),
      peakRssMiB: num(timing.peakRssMiB),
      refused: refusalOf(dir, run),
    };
  }
  return out;
}

function logFor(dir: string, name: string): string | null {
  const logs = join(dir, 'logs');
  const re = new RegExp(`^(\\d+-)?${name}(-full)?\\.log$`);
  const f = files(logs, re)[0];
  return f ? readText(join(logs, f)) : null;
}

function loadSuites(dir: string): SuiteFacts {
  const v = logFor(dir, 'vitest');
  const c = logFor(dir, 'cargo');
  const e = logFor(dir, 'e2e');
  const t = logFor(dir, 'tsc');
  return {
    vitest: v ? parseVitestLog(v) : null,
    cargo: c ? parseCargoLog(c) : null,
    e2e: e ? parseE2eLog(e) : null,
    tsc: t ? parseTscLog(t) : null,
  };
}

// -------------------------------------------------------------------------------------- cards

/** Every card.json under demo/runs (v0.2's flattened layout, or the raw runs/<sha>/<card>/), plus the j28/j29 rerun. */
function loadCards(dir: string): Map<string, { card: Json; path: string }> {
  const out = new Map<string, { card: Json; path: string }>();
  const scan = (root: string): void => {
    for (const a of dirs(root)) {
      const direct = join(root, a, 'card.json');
      if (existsSync(direct)) {
        const card = readJson(direct);
        if (card) out.set(a, { card, path: join(root, a) });
        continue;
      }
      for (const b of dirs(join(root, a))) {
        const nested = join(root, a, b, 'card.json');
        const card = existsSync(nested) ? readJson(nested) : null;
        if (card) out.set(b, { card, path: join(root, a, b) });
      }
    }
  };
  scan(join(dir, 'demo', 'runs'));
  scan(join(dir, 'demo', 'rerun-j28-j29', 'runs')); // v0.2: the later, mesh-supplied run of j28/j29 replaces the first run's error cards
  scan(join(dir, 'demo-j28-j29', 'runs')); // a rerun folder keeps that run as its own command's output
  return out;
}

function toStatus(cards: Map<string, { card: Json; path: string }>): StatusRec[] {
  return [...cards].map(([id, { card }]) => {
    const ol = card.overLimit as Json | undefined;
    const reached = (ol?.reached ?? null) as Json | null;
    return {
      id,
      status: String(card.verdict ?? 'unknown'),
      seconds: num(card.computeSeconds),
      limitSeconds: num((card.limit as Json | undefined)?.limitSeconds),
      overLimit: ol
        ? { elapsedSeconds: num(ol.elapsedSeconds) ?? 0, limitSeconds: num(ol.limitSeconds) ?? 0, phase: reached ? String(reached.phase) : null, tMs: reached ? num(reached.tMs) : null }
        : undefined,
    };
  });
}

const REF_ID = /^ref-(.+)$/;

function refCards(cards: Map<string, { card: Json; path: string }>): Map<string, { card: Json; path: string }> {
  const out = new Map<string, { card: Json; path: string }>();
  for (const [id, v] of cards) {
    const m = REF_ID.exec(id);
    if (m) out.set(m[1]!, v);
  }
  return out;
}

/** The vendor's program on our clock, found by name under the makerables folder and checked by sha256 (the saved card names both). */
const clockCache = new Map<string, VendorClock | null>();
function clockOfVendor(card: Json, makerables: string | null): VendorClock | null {
  const ref = (card.vendor?.ref?.nc ?? []) as string[];
  const [name, sha] = ref;
  if (!name || makerables === null) return null;
  const key = `${name}:${sha}`;
  if (clockCache.has(key)) return clockCache.get(key)!;
  let out: VendorClock | null = null;
  const find = (root: string): string | null => {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      const p = join(root, e.name);
      if (e.isDirectory()) { const r = find(p); if (r) return r; } else if (e.name === name) return p;
    }
    return null;
  };
  try {
    const file = find(makerables);
    if (file) {
      const raw = readFileSync(file);
      // the card names the program by sha256; another download is not the one that was judged
      if (sha === undefined || createHash('sha256').update(raw).digest('hex') === sha) out = vendorClock(raw.toString('utf8'));
    }
  } catch {
    out = null;
  }
  clockCache.set(key, out);
  return out;
}

function loadRefs(cards: Map<string, { card: Json; path: string }>, makerables: string | null): RefFacts[] {
  return [...refCards(cards)].map(([part, { card, path }]) => {
    const clock = clockOfVendor(card, makerables);
    const receipt = readJson(join(path, 'receipt.json'));
    const oursTotal = num((receipt?.details?.runCycle as Json | undefined)?.totalSeconds);
    const vendor = (card.vendor ?? {}) as Json;
    const vn = (vendor.numbers ?? {}) as Json;
    const tools = Array.isArray(vn.programs) && vn.programs[0] && Array.isArray((vn.programs[0] as Json).tools) ? ((vn.programs[0] as Json).tools as unknown[]).length : null;
    const vsec = num(vn.vendorSeconds) ?? num(vendor.seconds);
    const ours = (card.ours ?? {}) as Json;
    return {
      part,
      verdict: typeof card.verdict === 'string' ? card.verdict : null,
      reason: card.verdict === 'refused' ? String(card.sentence ?? '').replace(/\s+/g, ' ').slice(0, 220) : null,
      makeraCutters: tools === null ? null : String(tools),
      makeraCycle: vsec === null ? null : `${(vsec / 60).toFixed(1)} min`,
      makeraHeaderS: vsec,
      makeraClockS: clock === null ? null : clock.totalSeconds,
      oursTotalS: card.verdict === 'refused' ? null : oursTotal,
      cutters: card.verdict === 'refused' ? null : num(ours.cutters),
      cycleSeconds: num(ours.cycleSeconds),
      wall: num(card.computeSeconds),
    };
  });
}

/** Makera's and ours, at the two floors the saved cards hold: 0.1 mm after the allowances, 0.01 mm before. */
function cutParts(before: Map<string, { card: Json; path: string }>, after: Map<string, { card: Json; path: string }>): { page: CutPart[]; raw: CutPart[] } {
  const parts = [...new Set([...refCards(before).keys(), ...refCards(after).keys()])].sort();
  const fig = (pct: unknown, floorMm: number, afterAllowances: boolean, maxMm?: unknown): CutFigure | null => {
    const p = num(pct);
    return p === null ? null : { pct: p, floorMm, afterAllowances, maxMm: num(maxMm) };
  };
  const page: CutPart[] = [];
  const raw: CutPart[] = [];
  for (const part of parts) {
    const b = refCards(before).get(part)?.card;
    const a = refCards(after).get(part)?.card;
    const vendor = (((b ?? a)?.vendor ?? {}) as Json).numbers as Json | undefined;
    page.push({
      part,
      makera: fig(vendor?.cutInto0p1Pct, 0.1, true, vendor?.maxCutIntoMm),
      before: fig((b?.numbers as Json | undefined)?.pageCutInto0p1Pct, 0.1, true),
      after: fig((a?.numbers as Json | undefined)?.pageCutInto0p1Pct, 0.1, true),
    });
    raw.push({
      part,
      makera: fig(vendor?.cutIntoInclEdgePct, 0.01, false),
      before: fig((b?.numbers as Json | undefined)?.pageCutIntoInclEdgePct, 0.01, false),
      after: fig((a?.numbers as Json | undefined)?.pageCutIntoInclEdgePct, 0.01, false),
    });
  }
  return { page, raw };
}

// -------------------------------------------------------------------------------------- samples

function loadSamples(dir: string): StatusRec[] {
  const results = readJson(join(dir, 'samples', 'results.json'));
  if (!results || typeof results.samples !== 'object') return [];
  const secs = new Map<string, number>();
  const csv = readText(join(dir, 'samples', 'timing.csv'));
  if (csv) {
    for (const line of csv.split('\n').slice(1)) {
      const f = line.split(',');
      if (f.length >= 5 && f[0]) secs.set(f[0], Number(f[4]));
    }
  } else {
    // A rerun folder has no timing.csv: the harness prints "<id>: import X / plan Y / check Z (N s)" per sample into its log.
    const logs = join(dir, 'logs');
    for (const f of files(logs, /samples.*\.log$/)) {
      for (const m of (readText(join(logs, f)) ?? '').matchAll(/^(\S+): import \S+ \/ plan \S+ \/ check \S+ \((\d+(?:\.\d+)?) s\)/gm)) secs.set(m[1]!, Number(m[2]));
    }
  }
  return Object.entries(results.samples as Json).map(([id, s]) => {
    const st = s as Json;
    return { id, status: `${st.import?.status ?? '?'}/${st.plan?.status ?? '?'}/${st.check?.status ?? '?'}`, seconds: secs.get(id) ?? null };
  });
}

// -------------------------------------------------------------------------------------- programs + pictures

function md5Of(path: string): string {
  return createHash('md5').update(readFileSync(path)).digest('hex');
}

function ncHashes(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files(path, /\.nc$/).filter((n) => !n.endsWith('-frame.nc'))) out[f] = md5Of(join(path, f));
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const o = args.indexOf('--out');
  const outDir = o >= 0 ? resolve(args[o + 1] ?? '') : '';
  const mk = args.indexOf('--makerables');
  const makerables = mk >= 0 ? resolve(args[mk + 1] ?? '') : process.env.CM_MAKERABLES ? resolve(process.env.CM_MAKERABLES) : existsSync(join(process.env.HOME ?? '', 'makerables')) ? join(process.env.HOME ?? '', 'makerables') : null;
  const pos = args.filter((_, i) => (o < 0 || (i !== o && i !== o + 1)) && (mk < 0 || (i !== mk && i !== mk + 1)));
  if (pos.length !== 2 || outDir === '') {
    process.stderr.write('usage: compare.mts <before-dir> <after-dir> --out <dir> [--makerables <dir>]\n');
    process.exit(2);
  }
  const [beforeDir, afterDir] = [resolve(pos[0]!), resolve(pos[1]!)];
  if (outDir === beforeDir || outDir.startsWith(`${beforeDir}/`) || outDir === afterDir || outDir.startsWith(`${afterDir}/`)) {
    process.stderr.write('compare: the output folder must not be inside either baseline folder\n');
    process.exit(2);
  }
  for (const d of [beforeDir, afterDir]) if (!existsSync(join(d, 'manifest.json'))) process.stderr.write(`compare: ${d} has no manifest.json (continuing with what it holds)\n`);

  const bh = loadHeader(beforeDir);
  const ah = loadHeader(afterDir);
  const bCards = loadCards(beforeDir);
  const aCards = loadCards(afterDir);
  const headline = { before: { tray: loadTray(beforeDir), suites: loadSuites(beforeDir) } as HeadlineInput, after: { tray: loadTray(afterDir), suites: loadSuites(afterDir) } as HeadlineInput };
  const cut = cutParts(bCards, aCards);
  const cutInto: CutTable[] = [
    { title: 'At the 0.1 mm floor, after the stated allowances (edge break, wall cells, wall shadow, border)', floor: { floorMm: 0.1, afterAllowances: true }, parts: cut.page },
    { title: 'At the 0.01 mm floor, before any allowance (raw)', floor: { floorMm: 0.01, afterAllowances: false }, parts: cut.raw },
  ];

  mkdirSync(join(outDir, 'pictures'), { recursive: true });
  const pictures: PictureSet[] = [];
  const programs: ProgramGroup[] = [];
  const copyPic = (from: string, name: string): string | null => {
    if (!existsSync(from)) return null;
    const rel = `pictures/${name}.png`;
    copyFileSync(from, join(outDir, rel));
    return rel;
  };
  const addPair = (label: string, slug: string, bFrom: string, aFrom: string): void => {
    const beforeRel = copyPic(bFrom, `before-${slug}`);
    const afterRel = copyPic(aFrom, `after-${slug}`);
    if (beforeRel !== null || afterRel !== null) pictures.push({ label, beforeRel, afterRel });
  };
  for (const run of ['plain-top', 'plain-bottom']) {
    const b = join(beforeDir, 'tray', run);
    const a = join(afterDir, 'tray', run);
    if (existsSync(b) || existsSync(a)) {
      programs.push({ group: `tray ${run}`, rows: programRows(ncHashes(b), ncHashes(a)) });
      addPair(`tray ${run}: the simulated result`, `tray-${run}-after`, join(b, 'job-after.png'), join(a, 'job-after.png'));
      addPair(`tray ${run}: goal deviation map`, `tray-${run}-deviation`, join(b, 'deviation.png'), join(a, 'deviation.png'));
    }
  }
  const bRefs = refCards(bCards);
  const aRefs = refCards(aCards);
  for (const part of [...new Set([...bRefs.keys(), ...aRefs.keys()])].sort()) {
    const b = bRefs.get(part)?.path ?? '';
    const a = aRefs.get(part)?.path ?? '';
    programs.push({ group: `reference ${part}`, rows: programRows(b ? ncHashes(b) : {}, a ? ncHashes(a) : {}) });
    addPair(`reference ${part}: the simulated result`, `ref-${part}-after`, join(b, 'assets', 'after.png'), join(a, 'assets', 'after.png'));
    addPair(`reference ${part}: the goal deviation map (or design overlay)`, `ref-${part}-deviation`, existsSync(join(b, 'goalcheck.png')) ? join(b, 'goalcheck.png') : join(b, 'overlay.png'), existsSync(join(a, 'goalcheck.png')) ? join(a, 'goalcheck.png') : join(a, 'overlay.png'));
  }

  const doc = buildComparison({
    before: bh,
    after: ah,
    headline,
    references: { before: loadRefs(bCards, makerables), after: loadRefs(aCards, makerables) },
    cutInto,
    samples: { before: loadSamples(beforeDir), after: loadSamples(afterDir) },
    cards: { before: toStatus(bCards), after: toStatus(aCards) },
    programs,
    pictures,
  });
  writeFileSync(join(outDir, 'COMPARISON.md'), doc + '\n');
  process.stdout.write(`compare: ${basename(beforeDir)} -> ${basename(afterDir)}: ${join(outDir, 'COMPARISON.md')} (${pictures.length} picture pairs)\n`);
}

main();
