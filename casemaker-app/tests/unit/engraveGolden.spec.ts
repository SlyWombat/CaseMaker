// #921 — THE BADGE'S BYTES CANNOT MOVE UNNOTICED.
//
// The 2026-10-24 badge is the one job with a bench-verified 0/0, and `engraveOracleSurface.spec.ts`
// proves that verdict. This spec freezes the artefacts that verdict was made on, for the three
// inputs Milestone 1's first job is built from:
//
//   * the committed 10-24 badge job (`fixtures/badge-2026-10-24-vbit.job.json`);
//   * `docs/bench/450-laminate-base.job.json` — the laminate feed ladder's base job;
//   * the `single-thin.3mf` badge import, built the way `casemaker cut --from-3mf … --tool
//     inv:kz-engrave-30-0-3 --rest none` builds it (scripts/lib/casemaker/engrave.ts:1711–1776:
//     `readDesign(parsePrusaThreeMf(…))` → `designJobFor` → `defaultEngraveJob(viseForNewJob(…))`).
//     The cutter is put on the document because a spec has no house catalogue to resolve the
//     `inv:` key from; it is the same 30° × 0.3 bit the bench job names.
//
// WHAT IS PINNED, per input, under `fixtures/golden/<case>/`:
//
//   program.nc.sha256  the posted program's PATH bytes — the text with its ONE
//                      `;@MKR|TIME|seconds=<N>` record removed — as byte count + sha256. Everything
//                      else (path, feeds, every other `;@MKR` tag) is in the pinned bytes exactly as
//                      posted. The text is 100–200 kB, so the hash is the pin; a failure names the
//                      expected and actual hash and size.
//   time-seconds.json  that TIME record's own number (`{ "seconds": N }`), with a band: ±2 %,
//                      floored at ±2 s. The estimate is a pure estimate (`estimateIRCycleSeconds`,
//                      post/z1.ts's `mkr('TIME', …)`); an estimator-only change moves this number
//                      and no toolpath, so it moves THIS pin and never the hash. The band absorbs
//                      rounding and float drift across Node/OS; a real estimator change moves the
//                      number past it.
//   verifier.json      the pipeline's own `VerifyReport` on that text (`EngraveGenerated.verify`).
//   oracle.json        the oracle's numbers: the WORK frame for every job, and — for the badge
//                      only — the SURFACE frame against the 10-24 run-6 plane. The other two jobs
//                      have no measured plane, and inventing one would freeze an assumption rather
//                      than a measurement.
//   run-sheet.md       `buildRunSheet` + `renderRunSheetMarkdown` at the pinned clock below.
//
// HELD FIXED so the bytes are a property of the code, not of the machine: no house catalogue, no
// calibration, no location document (hence no shop options), the default margins, and the sheet's
// clock at `NOW`. These are the defaults `helpers/engravePipeline.ts` gives every spec, and the
// same call the app makes on a machine that has never synced the house library (#310/#324).
//
// REGENERATION IS A DELIBERATE ACT, never automatic:
//
//   CASEMAKER_UPDATE_GOLDEN=1 npx vitest run tests/unit/engraveGolden.spec.ts
//
// rewrites every expectation — with one rule that keeps an estimator change from churning the
// golden: the PATH pin is rewritten whenever the path bytes differ (an unchanged path writes the
// same file, so no diff), and the TIME pin KEEPS its committed number while the new estimate is
// inside its band, rewriting it only when the estimate moved past it. The run logs which one moved,
// so the landing note can say "TIME only" instead of "the hash changed". That is allowed only when
// a landing INTENDS to change what is posted — a feeds row, a post change, a changed default — with
// a review note naming which artefact moved and why. The diff is then read artefact by artefact.
// Bytes that move without that note are the defect this spec exists to catch.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { designJobFor } from '@/engine/cnc/engrave/fromDesign';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { viseForNewJob } from '@/engine/cnc/fixture';
import { Z1 } from '@/engine/cnc/machine';
import { parsePrusaThreeMf } from '@/engine/import/prusa3mf';
import { readDesign } from '@/engine/import/design3mf';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { createSimSession } from '@/workers/sim/session';
import type { SurfaceFrame } from '@/engine/cnc/engrave/surfacePlane';
import type { OracleReport } from '@/engine/cnc/engrave/oracle';
import type { Tool } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import { renderRunSheetMarkdown } from '../../scripts/runSheetMarkdown';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const REPO = join(APP, '..');
const GOLDEN = join(HERE, 'fixtures', 'golden');
const UPDATE = process.env.CASEMAKER_UPDATE_GOLDEN === '1';

/** The sheet's clock (#484's seam): a pinned instant keeps the rendered text identical every run. */
const NOW = new Date('2026-11-02T12:00:00.000Z');

/**
 * The 10-24 run-6 plane, the same measured frame `engraveOracleSurface.spec.ts` judges the badge
 * against: 0.817° fitted to the bench readings, in machine Z. It is a measurement, not a knob —
 * if a future badge registration states a different plane, that is a new fixture, not an edit.
 */
const BENCH_TILT: SurfaceFrame = {
  plane: { offset: -54.73947, slopeX: -0.013348, slopeY: -0.005035 },
  z0: -55.466,
};

/** The bench's 30° × 0.3 engraver, the cutter the single-thin import names. */
function bit30(): Tool {
  return {
    number: 1,
    id: 'kz-engrave-30-0-3',
    name: 'Single Flute Engraving Bit 30 x 0.3',
    typeText: 'Engraving',
    shape: 'engraving',
    handleDiameter: 3.175,
    tipDiameter: 0.3,
    diameter: 3.175,
    cornerRadius: 0,
    angle: 30,
    halfAngle: 15,
    fluteLength: null,
    shoulderLength: null,
    stickout: null,
    centreCutting: null,
  };
}

function jobFrom(path: string): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.ok) throw new Error(`${path} does not parse: ${parsed.errors.join('; ')}`);
  return parsed.job;
}

/** The single-thin badge project through the import door, and the cutter the bench run names. */
function singleThinJob(): EngraveJob {
  const bytes = readFileSync(join(REPO, 'samples', 'badge-blank', 'thin-film', 'single-thin.3mf'));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const patch = designJobFor(readDesign(tl, parsePrusaThreeMf(buffer)), { direction: 'ccw' });
  const base = defaultEngraveJob(viseForNewJob(undefined, patch.stock));
  return {
    ...base,
    name: patch.name,
    stock: { ...patch.stock, material: patch.stock.material ?? base.stock.material },
    labels: [],
    // The import mints a fresh `shp-…` id per read, and the sheet prints it in the diagram. The
    // golden gives the three items positional ids so the sheet is a property of the code; the ids
    // are bookkeeping, not toolpath.
    vectors: patch.vectors.map((v, i) => ({ ...v, id: `shp-item-${i + 1}` })),
    keepOuts: patch.keepOut ? [patch.keepOut] : [],
    sources: { ...base.sources, ...patch.sources },
    toolKey: 'inv:kz-engrave-30-0-3',
    tool: bit30(),
  };
}

interface Case {
  name: string;
  job: () => EngraveJob;
  /** The frame the surface verdict is taken in, or null for a job with no measured plane. */
  tilt: SurfaceFrame | null;
}

const CASES: readonly Case[] = [
  { name: 'badge-2026-10-24', job: () => jobFrom(join(HERE, 'fixtures', 'badge-2026-10-24-vbit.job.json')), tilt: BENCH_TILT },
  { name: '450-laminate-base', job: () => jobFrom(join(REPO, 'docs', 'bench', '450-laminate-base.job.json')), tilt: null },
  { name: 'single-thin', job: singleThinJob, tilt: null },
];

/**
 * THE TIME RECORD — `;@MKR|TIME|seconds=<N>` (post/z1.ts's `mkr('TIME', …)`), ONE anchored line:
 * the post's cycle estimate, and nothing else in the file matches it. The path pin strips it; the
 * number is pinned on its own with the band below.
 */
const TIME_LINE = /^;@MKR\|TIME\|seconds=(\d+)$/;

/** The program split into its path bytes (no TIME record) and the estimated seconds. */
function splitTime(nc: string): { text: string; seconds: number } {
  const lines = nc.split('\n');
  const hits = lines.map((line, index) => ({ line, index })).filter(({ line }) => TIME_LINE.test(line));
  if (hits.length !== 1) {
    throw new Error(
      `the program carries ${hits.length} records matching ${TIME_LINE} — the golden expects exactly one`,
    );
  }
  const seconds = Number(TIME_LINE.exec(hits[0]!.line)![1]);
  return { text: lines.filter((_, index) => index !== hits[0]!.index).join('\n'), seconds };
}

/**
 * THE TIME PIN'S BAND: ±2 %, floored at ±2 s (#921 review). `estimateIRCycleSeconds` runs from tens
 * of seconds to several minutes on these fixtures, so a flat ±2 s is too tight on the long jobs and
 * a flat 2 % too loose on the short ones; the floor covers both. The band absorbs rounding and
 * float drift across Node/OS, not a real estimator change.
 */
const TIME_FRACTION = 0.02;
const TIME_FLOOR_SECONDS = 2;

function timeBand(pinned: number): number {
  return Math.max(TIME_FLOOR_SECONDS, pinned * TIME_FRACTION);
}

function withinTimeBand(pinned: number, actual: number): boolean {
  return Math.abs(actual - pinned) <= timeBand(pinned);
}

function oracleOf(job: EngraveJob, gen: EngraveGenerated, surface: SurfaceFrame | null): OracleReport {
  const tool = jobTool(job);
  if (tool === null) throw new Error(`${job.name}: the job names no resolvable cutter`);
  if (gen.nc === null) throw new Error(`${job.name}: generation posted no program`);
  const session = createSimSession(tl);
  const loaded = session.load(gen.nc, toSetup(job, Z1), tool, Z1.id, surface === null ? undefined : { surface });
  if (!loaded.ok) throw new Error(`${job.name}: the sim refused the program: ${JSON.stringify(loaded.diagnostics)}`);
  try {
    return session.oracle(gen.predicted);
  } finally {
    session.dispose();
  }
}

async function record(c: Case): Promise<{ nc: string; verify: unknown; work: OracleReport; surface: OracleReport | null; sheet: string }> {
  const job = c.job();
  const gen = await generate(tl, job);
  if (!gen.ok || gen.nc === null || gen.verify === null) {
    throw new Error(`${c.name}: generation stopped at ${gen.stage}: ${gen.errors.map((e) => e.message).join('; ')}`);
  }
  let surface: OracleReport | null = null;
  if (c.tilt !== null) {
    const lifted = await generate(tl, job, null, [], undefined, { surface: c.tilt });
    if (!lifted.ok || lifted.nc === null) throw new Error(`${c.name}: the surface post was refused: ${lifted.errors.map((e) => e.message).join('; ')}`);
    surface = oracleOf(job, lifted, c.tilt);
  }
  // #947 gate statement 7 — the sheet now states the oracle's band AND the sliver width under the
  // band, so the frozen sheet is built with the report the app hands it (`EngravePanel`), not with
  // no simulation at all. The band sentences were never in the goldens before this; they are the
  // app's own sheet as of the same change.
  const work = oracleOf(job, gen, null);
  return {
    nc: gen.nc,
    verify: gen.verify,
    work,
    surface,
    sheet: renderRunSheetMarkdown(
      buildRunSheet(job, gen, { diagnostics: [], oracleBand: work.band, sliverWidthMm: work.sliverWidthMm }, NOW),
    ),
  };
}

/** One-line account of the first difference, so a failure names the artefact and the line. */
function firstDifference(expected: string, actual: string): string {
  if (expected === actual) return '';
  const e = expected.split('\n');
  const a = actual.split('\n');
  let i = 0;
  while (i < e.length && i < a.length && e[i] === a[i]) i++;
  return i < e.length && i < a.length
    ? `line ${i + 1}: ${JSON.stringify(e[i])} → ${JSON.stringify(a[i])}`
    : `${e.length} lines → ${a.length} lines`;
}

/** Read a committed expectation, or the "no committed expectation" error. */
function expected(caseName: string, file: string): string {
  const path = join(GOLDEN, caseName, file);
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`${caseName}/${file}: no committed expectation — regenerate with CASEMAKER_UPDATE_GOLDEN=1`);
  }
}

function pin(caseName: string, file: string, actual: string): void {
  const path = join(GOLDEN, caseName, file);
  if (UPDATE) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  const pinned = expected(caseName, file);
  if (pinned !== actual) {
    throw new Error(
      `${caseName}/${file} changed at ${firstDifference(pinned, actual)} — a frozen artefact moved; ` +
        'see the header before regenerating',
    );
  }
}

/** The path pin: the program's bytes without its TIME record, as sha256 + byte count. */
function pathPin(nc: string): string {
  const { text } = splitTime(nc);
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  return `sha256 ${hash} (${Buffer.byteLength(text, 'utf8')} bytes)\n`;
}

/**
 * The TIME pin, as its own number and with its own band. On regeneration the committed number is
 * KEPT while the estimate is inside the band (no churn from rounding drift), and rewritten with a
 * logged "TIME moved" when it is not — the mechanical distinction the review asked for.
 */
function pinTime(caseName: string, seconds: number): void {
  const file = 'time-seconds.json';
  const path = join(GOLDEN, caseName, file);
  if (UPDATE) {
    let pinned: number | null;
    try {
      pinned = (JSON.parse(readFileSync(path, 'utf8')) as { seconds: number }).seconds;
    } catch {
      pinned = null;
    }
    if (pinned !== null && withinTimeBand(pinned, seconds)) {
      console.log(
        `golden ${caseName}: TIME ${seconds} s is inside the pinned ${pinned} s ± ${timeBand(pinned).toFixed(2)} s — pin kept`,
      );
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ seconds }, null, 2) + '\n');
    console.log(
      pinned === null
        ? `golden ${caseName}: TIME pinned at ${seconds} s`
        : `golden ${caseName}: TIME moved ${pinned} → ${seconds} s (past ± ${timeBand(pinned).toFixed(2)} s) — pin rewritten`,
    );
    return;
  }
  const pinned = (JSON.parse(expected(caseName, file)) as { seconds: number }).seconds;
  const band = timeBand(pinned);
  if (!withinTimeBand(pinned, seconds)) {
    throw new Error(
      `${caseName}/${file}: the posted TIME is ${seconds} s, outside the pinned ${pinned} s ± ${band.toFixed(2)} s ` +
        `(±2 %, floored at ±2 s) — the estimate moved, the path pin did not. ` +
        'Regenerate deliberately if that is intended (the header states the rule).',
    );
  }
}

describe('the frozen badge artefacts (#921)', () => {
  for (const c of CASES) {
    it(`${c.name}: posts the same program, verdicts and sheet`, async () => {
      const a = await record(c);
      const { text, seconds } = splitTime(a.nc);
      pin(c.name, 'program.nc.sha256', pathPin(a.nc));
      pinTime(c.name, seconds);
      pin(c.name, 'verifier.json', JSON.stringify(a.verify, null, 2) + '\n');
      pin(c.name, 'oracle.json', JSON.stringify({ work: a.work, surface: a.surface }, null, 2) + '\n');
      pin(c.name, 'run-sheet.md', a.sheet);

      // RED-FIRST, ON THE PROGRAM'S OWN BYTES: an estimator-only change — the same program with a
      // different TIME number — leaves the path pin bit-identical and lands outside the TIME band,
      // so exactly one artefact moves. (A change to anything else moves the path pin.)
      const movedSeconds = seconds + Math.ceil(timeBand(seconds)) + 1;
      const moved = a.nc.replace(TIME_LINE, `;@MKR|TIME|seconds=${movedSeconds}`);
      expect(splitTime(moved).text, `${c.name}: a TIME-only change must not move the path bytes`).toBe(text);
      expect(
        withinTimeBand(seconds, movedSeconds),
        `${c.name}: a TIME change past ± ${timeBand(seconds).toFixed(2)} s must fail the TIME pin`,
      ).toBe(false);
    }, 60_000);
  }
});
