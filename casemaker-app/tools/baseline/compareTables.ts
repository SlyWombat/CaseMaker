/**
 * #1233 — THE BEFORE/AFTER COMPARISON, AS PURE FUNCTIONS.
 *
 * `compare.mts` reads two baseline folders (the layout #1212 saved) into the plain objects below
 * and hands them to `buildComparison`, which returns COMPARISON.md. Nothing here touches a file,
 * and nothing here recomputes a figure from a program: every number was read from a saved file and
 * is only subtracted, ranked or printed. A figure missing on a side prints "—", never 0.
 */

/**
 * A Generate wall that moves by less than this many percent between two runs is not called a
 * change: the same build repeated on the same idle machine varies by about this much, so a smaller
 * difference is not an improvement or a regression.
 */
export const NOISE_PCT = 5;

const MINUS = '−';
const MISSING = '—';
const NOT_AT_FLOOR = 'not recorded at this floor';

export type Maybe = number | null | undefined;

function finite(n: Maybe): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** A number to `digits` decimals with trailing zeros kept (`8005`, `99.63`), or "—" when absent. */
export function fmtNumber(n: Maybe, digits = 0): string {
  return finite(n) ? n.toFixed(digits) : MISSING;
}

/** The shortest form of a percentage figure (`0`, `0.09`, `0.22`): two decimals at most. */
function fmtPct(n: number): string {
  return `${Number(n.toFixed(2))} %`;
}

export function fmtSigned(n: number, digits: number): string {
  const text = Math.abs(n).toFixed(digits);
  if (Number(text) === 0) return '0';
  return `${n < 0 ? MINUS : '+'}${text}`;
}

export interface ChangeOptions {
  /** Decimals of the absolute change. Default 0. */
  digits?: number;
  /** Print a change under {@link NOISE_PCT} % as "within noise". The Generate wall's rule alone. */
  noise?: boolean;
}

/** `after − before`, and the percentage to one decimal. "—" when either side is missing. */
export function changeText(before: Maybe, after: Maybe, o: ChangeOptions = {}): string {
  if (!finite(before) || !finite(after)) return MISSING;
  const digits = o.digits ?? 0;
  const delta = after - before;
  const pct = before === 0 ? null : (delta / before) * 100;
  if (o.noise === true && pct !== null && Math.abs(pct) < NOISE_PCT) return `within noise (${fmtSigned(pct, 1)} %)`;
  if (delta === 0) return '0';
  return pct === null ? fmtSigned(delta, digits) : `${fmtSigned(delta, digits)} (${fmtSigned(pct, 1)} %)`;
}

// ----------------------------------------------------------------------------------------------
// 2. headline

export interface TrayRunFacts {
  /** Estimated cycle seconds of the owned plan. */
  owned?: Maybe;
  ideal?: Maybe;
  bitChanges?: Maybe;
  programs?: Maybe;
  coveragePct?: Maybe;
  /** Share of the goal's cells still standing more than 1 mm proud (the receipt's third leftover band). */
  cellsOver1mmPct?: Maybe;
  /** Adjudicated cut-into, as the receipt's fraction. */
  adjudicated?: Maybe;
  /** Generate wall seconds. */
  wall?: Maybe;
  peakRssMiB?: Maybe;
}

export interface SuiteCounts {
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  wall: number | null;
}

export interface SuiteFacts {
  vitest?: SuiteCounts | null;
  cargo?: SuiteCounts | null;
  e2e?: SuiteCounts | null;
  tsc?: { b: number | null; tests: number | null } | null;
}

export interface HeadlineInput {
  tray: Record<string, TrayRunFacts>;
  suites: SuiteFacts;
}

export interface Row {
  label: string;
  before: string;
  after: string;
  change: string;
}

/** The tray runs the baseline saved, in the order the document lists them. */
export const TRAY_RUNS = ['plain-top', 'plain-bottom', 'app-top', 'app-bottom', 'live-house/app-top', 'live-house/app-bottom'];

function pairRow(label: string, b: Maybe, a: Maybe, digits: number, o: ChangeOptions = {}): Row {
  return { label, before: fmtNumber(b, digits), after: fmtNumber(a, digits), change: changeText(b, a, { digits: o.digits ?? digits, ...o }) };
}

export function headlineRows(before: HeadlineInput, after: HeadlineInput): Row[] {
  const rows: Row[] = [];
  const runs = TRAY_RUNS.filter((r) => r in before.tray || r in after.tray);
  for (const run of runs) {
    const b = before.tray[run] ?? {};
    const a = after.tray[run] ?? {};
    // The plan facts are the same for the plain and the app-flags run of one job, so they are
    // listed once, on the plain run; the other runs carry timing and memory.
    if (run.startsWith('plain') || !runs.some((r) => r.startsWith('plain'))) {
      rows.push(pairRow(`${run}: cycle, owned (s)`, b.owned, a.owned, 0));
      if (finite(b.ideal) || finite(a.ideal)) rows.push(pairRow(`${run}: cycle, ideal (s)`, b.ideal, a.ideal, 0));
      rows.push(pairRow(`${run}: bit changes`, b.bitChanges, a.bitChanges, 0));
      rows.push(pairRow(`${run}: programs`, b.programs, a.programs, 0));
      rows.push(pairRow(`${run}: coverage (%)`, b.coveragePct, a.coveragePct, 2));
      const over = pairRow(`${run}: cells standing > 1 mm (%)`, b.cellsOver1mmPct, a.cellsOver1mmPct, 2);
      if (!finite(b.cellsOver1mmPct)) over.before = 'not recorded';
      if (!finite(a.cellsOver1mmPct)) over.after = 'not recorded';
      rows.push(over);
      rows.push(pairRow(`${run}: adjudicated cut-into (fraction)`, b.adjudicated, a.adjudicated, 4));
    }
    rows.push(pairRow(`${run}: Generate wall (s)`, b.wall, a.wall, 0, { noise: true }));
    rows.push(pairRow(`${run}: peak memory (MiB)`, b.peakRssMiB, a.peakRssMiB, 0));
  }
  for (const [name, key] of [['vitest', 'vitest'], ['cargo test --lib', 'cargo'], ['Playwright e2e', 'e2e']] as const) {
    const b = before.suites[key];
    const a = after.suites[key];
    if (!b && !a) continue;
    rows.push(pairRow(`${name}: passed`, b?.passed, a?.passed, 0));
    rows.push(pairRow(`${name}: failed`, b?.failed, a?.failed, 0));
    rows.push(pairRow(`${name}: wall (s)`, b?.wall, a?.wall, 0));
  }
  if (before.suites.tsc || after.suites.tsc) {
    rows.push(pairRow('tsc -b: exit code', before.suites.tsc?.b, after.suites.tsc?.b, 0));
    rows.push(pairRow('tsc (tests): exit code', before.suites.tsc?.tests, after.suites.tsc?.tests, 0));
  }
  return rows;
}

// ----------------------------------------------------------------------------------------------
// 3. reference parts

export interface RefFacts {
  part: string;
  /** The card's own verdict (match, deviates, refused, error, unchecked). */
  verdict: string | null;
  /** The refusal sentence, when refused. */
  reason?: string | null;
  makeraCutters?: string | null;
  makeraCycle?: string | null;
  cutters?: Maybe;
  cycleSeconds?: Maybe;
  /** Generate wall: the card's own compute seconds. */
  wall?: Maybe;
}

export const REF_HEADERS = [
  'part',
  'Makera cutters',
  'Makera cycle',
  'verdict before',
  'verdict after',
  'ours cutters before',
  'ours cutters after',
  'ours cycle before (s)',
  'ours cycle after (s)',
  'cycle change',
  'Generate wall before (s)',
  'Generate wall after (s)',
  'wall change',
];

export interface HighlightRow {
  part: string;
  text: string;
}

const isRefused = (v: string | null | undefined): boolean => v === 'refused';

export function referenceRows(before: RefFacts[], after: RefFacts[]): { rows: string[][]; highlighted: HighlightRow[] } {
  const parts = [...new Set([...before.map((r) => r.part), ...after.map((r) => r.part)])].sort();
  const rows: string[][] = [];
  const highlighted: HighlightRow[] = [];
  for (const part of parts) {
    const b = before.find((r) => r.part === part);
    const a = after.find((r) => r.part === part);
    rows.push([
      part,
      (b ?? a)?.makeraCutters ?? MISSING,
      (b ?? a)?.makeraCycle ?? MISSING,
      b?.verdict ?? MISSING,
      a?.verdict ?? MISSING,
      fmtNumber(b?.cutters),
      fmtNumber(a?.cutters),
      fmtNumber(b?.cycleSeconds),
      fmtNumber(a?.cycleSeconds),
      changeText(b?.cycleSeconds, a?.cycleSeconds),
      fmtNumber(b?.wall, 1),
      fmtNumber(a?.wall, 1),
      changeText(b?.wall, a?.wall, { digits: 1, noise: true }),
    ]);
    if (b && a && isRefused(b.verdict) !== isRefused(a.verdict)) {
      const refusedSide = isRefused(b.verdict) ? `refused before: ${b.reason ?? 'no reason saved'}` : `refused after: ${a.reason ?? 'no reason saved'}`;
      highlighted.push({ part, text: `**${part}**: ${b.verdict} → ${a.verdict} (${refusedSide})` });
    }
  }
  return { rows, highlighted };
}

// ----------------------------------------------------------------------------------------------
// 4. cut-into, like for like

export interface CutFigure {
  pct: number;
  /** The floor the cells were counted at: 0.1 mm (the page's) or 0.01 mm (the receipt's raw). */
  floorMm: number;
  /** Whether the stated allowances (edge break, wall cells, wall shadow, border) were taken out first. */
  afterAllowances: boolean;
  maxMm?: Maybe;
}

export interface CutPart {
  part: string;
  makera: CutFigure | null;
  before: CutFigure | null;
  after: CutFigure | null;
}

export interface CutFloor {
  floorMm: number;
  afterAllowances: boolean;
}

function cutCell(f: CutFigure | null, floor: CutFloor): string {
  if (f === null || f.floorMm !== floor.floorMm || f.afterAllowances !== floor.afterAllowances) return NOT_AT_FLOOR;
  return finite(f.maxMm) ? `${fmtPct(f.pct)} · max ${Number(f.maxMm.toFixed(3))} mm` : fmtPct(f.pct);
}

/** One row per part, every figure at the one floor: a figure recorded at another floor is never substituted. */
export function cutIntoRows(parts: CutPart[], floor: CutFloor): string[][] {
  const same = (f: CutFigure | null): f is CutFigure => f !== null && f.floorMm === floor.floorMm && f.afterAllowances === floor.afterAllowances;
  return parts.map((p) => [
    p.part,
    cutCell(p.makera, floor),
    cutCell(p.before, floor),
    cutCell(p.after, floor),
    same(p.before) && same(p.after) ? changeText(p.before.pct, p.after.pct, { digits: 2 }) : MISSING,
  ]);
}

// ----------------------------------------------------------------------------------------------
// 5, 6. samples and demo cards: statuses, changed items, largest wall changes

export interface StatusRec {
  id: string;
  status: string;
  seconds?: Maybe;
}

export function statusTables(
  before: StatusRec[],
  after: StatusRec[],
): { counts: string[][]; changed: string[][]; largest: string[][] } {
  const tally = (recs: StatusRec[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of recs) m.set(r.status, (m.get(r.status) ?? 0) + 1);
    return m;
  };
  const tb = tally(before);
  const ta = tally(after);
  const statuses = [...new Set([...tb.keys(), ...ta.keys()])].sort();
  const counts = statuses.map((s) => [s, String(tb.get(s) ?? 0), String(ta.get(s) ?? 0)]);
  const ids = [...new Set([...before.map((r) => r.id), ...after.map((r) => r.id)])].sort();
  const changed: string[][] = [];
  const moves: { id: string; b: number; a: number }[] = [];
  for (const id of ids) {
    const b = before.find((r) => r.id === id);
    const a = after.find((r) => r.id === id);
    if ((b?.status ?? MISSING) !== (a?.status ?? MISSING)) changed.push([id, b?.status ?? MISSING, a?.status ?? MISSING]);
    if (b && a && finite(b.seconds) && finite(a.seconds) && a.seconds !== b.seconds) moves.push({ id, b: b.seconds, a: a.seconds });
  }
  const largest = moves
    .sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b) || x.id.localeCompare(y.id))
    .slice(0, 10)
    .map((m) => [m.id, fmtNumber(m.b, 1), fmtNumber(m.a, 1), changeText(m.b, m.a, { digits: 1 })]);
  return { counts, changed, largest };
}

// ----------------------------------------------------------------------------------------------
// 7. programs

export type ProgramStatus = 'identical' | 'changed' | 'added' | 'removed';

export interface ProgramRow {
  name: string;
  status: ProgramStatus;
  before: string | null;
  after: string | null;
}

export function programRows(before: Record<string, string>, after: Record<string, string>): ProgramRow[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names.map((name) => {
    const b = before[name] ?? null;
    const a = after[name] ?? null;
    const status: ProgramStatus = b === null ? 'added' : a === null ? 'removed' : b === a ? 'identical' : 'changed';
    return { name, status, before: b, after: a };
  });
}

// ----------------------------------------------------------------------------------------------
// suite logs

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function lastInt(text: string, re: RegExp): number | null {
  let out: number | null = null;
  for (const m of text.matchAll(re)) out = Number(m[1]);
  return out;
}

function wallOf(text: string): number | null {
  return (
    lastInt(text, /wall_seconds=(\d+)/g) ??
    lastInt(text, /^# rc=-?\d+ seconds=(\d+)/gm) ??
    lastInt(text, /CARGO_SECONDS=(\d+)/g) ??
    lastInt(text, /e2e_rc=-?\d+ seconds=(\d+)/g)
  );
}

export function parseVitestLog(raw: string): SuiteCounts {
  const text = raw.replace(ANSI, '');
  const line = text.split('\n').filter((l) => /^\s*Tests\s/.test(l)).pop() ?? '';
  const n = (word: string): number | null => {
    const m = line.match(new RegExp(`(\\d+) ${word}\\b`));
    return m ? Number(m[1]) : null;
  };
  return { passed: n('passed'), failed: line === '' ? null : (n('failed') ?? 0), skipped: n('skipped'), wall: wallOf(text) };
}

export function parseCargoLog(raw: string): SuiteCounts {
  const text = raw.replace(ANSI, '');
  const line = text.split('\n').filter((l) => /^test result:/.test(l)).pop() ?? '';
  const n = (word: string): number | null => {
    const m = line.match(new RegExp(`(\\d+) ${word}`));
    return m ? Number(m[1]) : null;
  };
  return { passed: n('passed'), failed: n('failed'), skipped: n('ignored'), wall: lastInt(text, /CARGO_SECONDS=(\d+)/g) ?? wallOf(text) };
}

export function parseE2eLog(raw: string): SuiteCounts {
  const text = raw.replace(ANSI, '');
  const passed = lastInt(text, /^\s*(\d+) passed\b/gm);
  return {
    passed,
    failed: lastInt(text, /^\s*(\d+) failed\s*$/gm) ?? (passed === null ? null : 0),
    skipped: lastInt(text, /^\s*(\d+) skipped\s*$/gm) ?? (passed === null ? null : 0),
    wall: wallOf(text),
  };
}

export function parseTscLog(raw: string): { b: number | null; tests: number | null } {
  return { b: lastInt(raw, /tsc_b_rc=(\d+)/g), tests: lastInt(raw, /tsc_tests_rc=(\d+)/g) };
}

// ----------------------------------------------------------------------------------------------
// the document

export interface RunHeader {
  sha: string;
  tag: string | null;
  startedAt?: string;
  machine?: string;
  harnessPatches: string[];
}

export interface CutTable {
  title: string;
  floor: CutFloor;
  parts: CutPart[];
}

export interface ProgramGroup {
  group: string;
  rows: ProgramRow[];
}

export interface PictureSet {
  label: string;
  /** Paths relative to COMPARISON.md; null where that run saved no such picture. */
  beforeRel: string | null;
  afterRel: string | null;
}

export interface ComparisonInput {
  before: RunHeader;
  after: RunHeader;
  headline: { before: HeadlineInput; after: HeadlineInput };
  references: { before: RefFacts[]; after: RefFacts[] };
  cutInto: CutTable[];
  samples: { before: StatusRec[]; after: StatusRec[] };
  cards: { before: StatusRec[]; after: StatusRec[] };
  programs: ProgramGroup[];
  pictures: PictureSet[];
}

export function mdTable(headers: string[], rows: string[][]): string {
  const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const line = (cells: string[]): string => `| ${cells.map(esc).join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

const short = (sha: string): string => sha.slice(0, 9);

export function buildComparison(i: ComparisonInput): string {
  const out: string[] = [];
  const b = i.before;
  const a = i.after;
  out.push(`# Before / after: ${b.tag ?? short(b.sha)} (${short(b.sha)}) → ${a.tag ?? short(a.sha)} (${short(a.sha)})\n`);
  out.push('Every figure below was read from the two saved folders. Nothing was recomputed from a program. "—" means a figure is missing on that side; change is after − before. Generate-wall changes under ' + `${NOISE_PCT} % are printed "within noise".\n`);

  out.push('## 1. Header\n');
  out.push(
    mdTable(
      ['', 'before', 'after'],
      [
        ['sha', b.sha, a.sha],
        ['tag', b.tag ?? MISSING, a.tag ?? MISSING],
        ['started', b.startedAt ?? MISSING, a.startedAt ?? MISSING],
        ['machine', b.machine ?? MISSING, a.machine ?? MISSING],
      ],
    ),
  );
  out.push('');
  for (const [side, run] of [['before', b], ['after', a]] as const) {
    if (run.harnessPatches.length === 0) out.push(`- ${side}: no harness patches.`);
    for (const p of run.harnessPatches) out.push(`- ${side} harness patch: ${p}`);
  }
  out.push('');

  out.push('## 2. Headline\n');
  out.push(mdTable(['item', 'before', 'after', 'change'], headlineRows(i.headline.before, i.headline.after).map((r) => [r.label, r.before, r.after, r.change])));
  out.push('');

  out.push('## 3. Reference parts against Makera\n');
  const refs = referenceRows(i.references.before, i.references.after);
  if (refs.highlighted.length > 0) {
    out.push('**Refused on one side only:**\n');
    for (const h of refs.highlighted) out.push(`- ${h.text}`);
    out.push('');
  }
  out.push(mdTable(REF_HEADERS, refs.rows));
  out.push('');

  out.push('## 4. Cut-into, like for like\n');
  out.push('Makera\'s figure and ours are counted at the same floor and on the same side of the allowances in each table; the floor is in the heading. A figure the saved files do not hold at that floor reads "not recorded at this floor" and no other floor is substituted.\n');
  for (const t of i.cutInto) {
    out.push(`### ${t.title}\n`);
    out.push(mdTable(['part', 'Makera', 'ours before', 'ours after', 'change'], cutIntoRows(t.parts, t.floor)));
    out.push('');
  }

  out.push('## 5. Samples\n');
  const s = statusTables(i.samples.before, i.samples.after);
  out.push(mdTable(['import/plan/check', 'before', 'after'], s.counts));
  out.push('\nSamples whose status changed:\n');
  out.push(s.changed.length === 0 ? 'none.' : mdTable(['sample', 'before', 'after'], s.changed));
  out.push('\nTen largest changes in wall seconds:\n');
  out.push(s.largest.length === 0 ? 'none recorded.' : mdTable(['sample', 'before (s)', 'after (s)', 'change'], s.largest));
  out.push('');

  out.push('## 6. Demo cards\n');
  const c = statusTables(i.cards.before, i.cards.after);
  out.push(mdTable(['verdict', 'before', 'after'], c.counts));
  out.push('\nCards whose verdict changed:\n');
  out.push(c.changed.length === 0 ? 'none.' : mdTable(['card', 'before', 'after'], c.changed));
  out.push('\nTen largest changes in compute seconds:\n');
  out.push(c.largest.length === 0 ? 'none recorded.' : mdTable(['card', 'before (s)', 'after (s)', 'change'], c.largest));
  out.push('');

  out.push('## 7. Programs\n');
  if (i.programs.length === 0) out.push('No program lists were saved on both sides.\n');
  for (const g of i.programs) {
    const count = (st: ProgramStatus): number => g.rows.filter((r) => r.status === st).length;
    out.push(`### ${g.group}\n`);
    out.push(`${count('identical')} identical, ${count('changed')} changed, ${count('added')} added, ${count('removed')} removed.\n`);
    const moved = g.rows.filter((r) => r.status !== 'identical');
    if (moved.length > 0) out.push(mdTable(['program', 'status', 'md5 before', 'md5 after'], moved.map((r) => [r.name, r.status, r.before ?? MISSING, r.after ?? MISSING])));
    out.push('');
  }

  out.push('## 8. Pictures\n');
  if (i.pictures.length === 0) out.push('No pictures were saved.\n');
  for (const p of i.pictures) {
    out.push(`### ${p.label}\n`);
    const cell = (rel: string | null): string => (rel === null ? 'no picture in this run' : `<img src="${rel}" width="420">`);
    out.push(mdTable([`before (${short(b.sha)})`, `after (${short(a.sha)})`], [[cell(p.beforeRel), cell(p.afterRel)]]));
    out.push('');
  }
  return out.join('\n');
}
