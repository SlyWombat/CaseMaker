// #734 — the typical Z1 jobs that `docs/bench/2026-10-27-z1-typical-jobs` records are run through
// the same `casemaker cut` pipeline the exercise used, so a defect the bench found is a test here
// rather than a note in a manifest.
//
// The job JSONs stay where the bench put them: this spec reads them from `docs/bench`, and never
// rewrites them. The bench's own location document is not committed (it is the operator's machine),
// so the cutters those jobs name are built here from the same inventory entries the exercise used.
// The rest of the document is the committed test fixture.
//
// #738 — the follow-up exercise's jobs (`2026-10-28-z1-real-jobs`) join the same harness: the
// relief jobs' rapids-through-stock refusal was a surfacing CAM defect, and the tool tray was the
// #734 item-1 false positive. Their two ball-nose cutters are added to the same location document.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import { pocketLoops, type Polygons } from '@/engine/cnc/cam/pocket';
import { resetRegistry } from '@/engine/cnc/toolRegistry';
import { engraveRegions } from '@/workers/sim/engraveGenerate';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob } from '@/types/engraveJob';
import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import { HUMAN, type CommandOptions } from '../../scripts/lib/casemaker/output';
import { parseReceipt, renderReceipt, type Receipt } from '../../src/platform/headless/receipt';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const REPO = join(APP, '..');
const JOBS = join(REPO, 'docs', 'bench', '2026-10-27-z1-typical-jobs', 'jobs');
const REAL_JOBS = join(REPO, 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');
const LOCATION_FIXTURE = join(HERE, 'fixtures', 'location-doc.json');

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-bench-734-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
afterEach(() => resetRegistry());

/** A path as the command will read it — relative to the cwd the spec runs in. */
const asArg = (path: string): string => relative(process.cwd(), path);

/**
 * The bench's owned cutters, as inventory entries (the `inv:` keys the job files name).
 *
 * The numbers are the exercise's own records: a 3.175 mm single-flute flat with a 25 mm flute, and
 * the two 30° single-flute engravers with 0.3 and 0.5 mm tips. Only the fields the registry reads
 * are stated; the rest keep the schema's defaults.
 */
const BENCH_CUTTERS = [
  {
    id: 'kz-o-flute-3-175-25',
    tool: {
      number: null,
      id: null,
      name: 'Spiral \'O\' Single Flute Bit - 1/8" Shank 3.175mm * 25mm',
      typeText: 'Flat End',
      shape: 'flat',
      handleDiameter: 3.175,
      tipDiameter: 3.175,
      diameter: 3.175,
      cornerRadius: 0,
      angle: null,
      halfAngle: null,
      fluteLength: 25,
      shoulderLength: null,
      stickout: null,
      centreCutting: true,
    },
    origin: null,
    quantity: 1,
    codes: [],
    addedAt: '2026-10-27T00:00:00.000Z',
    notes: null,
  },
  // #739 — the real-jobs exercise's 1 mm corn bit (j03, j04), as its inventory holds it: a flat
  // 1 mm cutting diameter on a 1/8" shank with a 7 mm flute.
  {
    id: 'kz-corn-1-7',
    tool: {
      number: null,
      id: null,
      name: 'Corn Bit - 1/8" Shank 1mm * 7mm',
      typeText: 'Flat End',
      shape: 'flat',
      handleDiameter: 3.175,
      tipDiameter: 1,
      diameter: 1,
      cornerRadius: 0,
      angle: null,
      halfAngle: null,
      fluteLength: 7,
      shoulderLength: null,
      stickout: null,
      centreCutting: null,
    },
    origin: null,
    quantity: 1,
    codes: [],
    addedAt: '2026-10-28T00:00:00.000Z',
    notes: null,
  },
  {
    id: 'kz-engrave-30-0-3',
    tool: {
      number: null,
      id: null,
      name: 'Single Flute Engraving Bit - 1/8" Shank 30° * 0.3mm',
      typeText: 'Engraving',
      shape: 'engraving',
      handleDiameter: 3.175,
      tipDiameter: 0.3,
      diameter: 3.175,
      cornerRadius: null,
      angle: null,
      halfAngle: 15,
      fluteLength: null,
      shoulderLength: null,
      stickout: null,
      centreCutting: null,
    },
    origin: null,
    quantity: 1,
    codes: [],
    addedAt: '2026-10-27T00:00:00.000Z',
    notes: null,
  },
  {
    id: 'kz-engrave-30-0-5',
    tool: {
      number: null,
      id: null,
      name: 'Single Flute Engraving Bit - 1/8" Shank 30° * 0.5mm',
      typeText: 'Engraving',
      shape: 'engraving',
      handleDiameter: 3.175,
      tipDiameter: 0.5,
      diameter: 3.175,
      cornerRadius: null,
      angle: null,
      halfAngle: 15,
      fluteLength: null,
      shoulderLength: null,
      stickout: null,
      centreCutting: null,
    },
    origin: null,
    quantity: 1,
    codes: [],
    addedAt: '2026-10-27T00:00:00.000Z',
    notes: null,
  },
  // #746 — THE REAL JOBS' THREE-CUTTER SET (j19, j24, j25), as the house location holds them:
  // the two single-flute flats and the 30° 0.2 mm engraver, with their confirmed Makera ids.
  {
    id: 'kz-o-flute-m-3-175-12',
    tool: {
      number: null,
      id: '112111313812',
      name: 'Single Flute O-Flute Bit for Metal - 1/8" Shank 3.175mm * 12mm',
      typeText: 'Flat End',
      shape: 'flat',
      handleDiameter: 3.175,
      tipDiameter: 3.175,
      diameter: 3.175,
      cornerRadius: 0,
      angle: null,
      halfAngle: null,
      fluteLength: 12,
      shoulderLength: null,
      stickout: null,
      centreCutting: true,
    },
    origin: null,
    quantity: 1,
    codes: [],
    addedAt: '2026-10-28T00:00:00.000Z',
    notes: null,
  },
  {
    id: 'kz-o-flute-m-1-5-6',
    tool: {
      number: null,
      id: '112111153806',
      name: 'Single Flute O-Flute Bit for Metal - 1/8" Shank 1.5mm * 6mm',
      typeText: 'Flat End',
      shape: 'flat',
      handleDiameter: 3.175,
      tipDiameter: 1.5,
      diameter: 1.5,
      cornerRadius: 0,
      angle: null,
      halfAngle: null,
      fluteLength: 6,
      shoulderLength: null,
      stickout: null,
      centreCutting: true,
    },
    origin: null,
    quantity: 1,
    codes: [],
    addedAt: '2026-10-28T00:00:00.000Z',
    notes: null,
  },
  {
    id: 'kz-engrave-m-30-0-2',
    tool: {
      number: null,
      id: '122111023830',
      name: 'Single Flute Engraving Bit for Metal - 1/8" Shank 30° * 0.2mm',
      typeText: 'Engraving',
      shape: 'engraving',
      handleDiameter: 3.175,
      tipDiameter: 0.2,
      diameter: 3.175,
      cornerRadius: null,
      angle: 30,
      halfAngle: 15,
      fluteLength: null,
      shoulderLength: null,
      stickout: null,
      centreCutting: null,
    },
    origin: null,
    quantity: 1,
    codes: [],
    addedAt: '2026-10-28T00:00:00.000Z',
    notes: null,
  },
  // #738 — the real-jobs exercise's ball noses, as `2026-10-28-z1-real-jobs` used them.
  {
    id: 'kz-ball-nose-2-12',
    tool: {
      number: null,
      id: null,
      name: 'Two Flute Ball Nose Bit - 1/8" Shank 2mm * 12mm',
      typeText: 'Ball Nose',
      shape: 'ball',
      handleDiameter: 3.175,
      tipDiameter: 2,
      diameter: 3.175,
      cornerRadius: 1,
      angle: null,
      halfAngle: null,
      fluteLength: 12,
      shoulderLength: null,
      stickout: null,
      centreCutting: null,
    },
    origin: null,
    quantity: 1,
    codes: [],
    addedAt: '2026-10-12T00:00:00.000Z',
    notes: null,
  },
  {
    id: 'kz-ball-nose-1-4',
    tool: {
      number: null,
      id: null,
      name: 'Two Flute Ball Nose Bit - 1/8" Shank 1mm * 4mm',
      typeText: 'Ball Nose',
      shape: 'ball',
      handleDiameter: 3.175,
      tipDiameter: 1,
      diameter: 3.175,
      cornerRadius: 0.5,
      angle: null,
      halfAngle: null,
      fluteLength: 4,
      shoulderLength: null,
      stickout: null,
      centreCutting: null,
    },
    origin: null,
    quantity: 1,
    codes: [],
    addedAt: '2026-10-12T00:00:00.000Z',
    notes: null,
  },
];

/**
 * #749 — j24's cutter: the 3.175 mm single-flute METAL O-flute (Makera 112111313812), with the
 * 12 mm flute the bench's box states. It is not in `BENCH_CUTTERS` because its job needs a
 * catalogue row of its own (6061 Aluminium, 0.2 mm step-down) and a catalogue beside the location
 * would change every other bench job's feeds tiers; `j24Location` writes both in their own dir.
 */
const J24_CUTTER_ID = '112111313812';
const J24_CUTTER = {
  id: 'kz-o-flute-m-3-175-12',
  tool: {
    number: null,
    id: J24_CUTTER_ID,
    name: 'Spiral \'O\' Single Flute Bit for Metal - 1/8" Shank 3.175mm * 12mm',
    typeText: 'Flat End',
    shape: 'flat',
    handleDiameter: 3.175,
    tipDiameter: 3.175,
    diameter: 3.175,
    cornerRadius: 0,
    angle: null,
    halfAngle: null,
    fluteLength: 12,
    shoulderLength: null,
    stickout: null,
    centreCutting: null,
  },
  origin: null,
  quantity: 1,
  codes: [],
  addedAt: '2026-10-12T00:00:00.000Z',
  notes: null,
};

/** A location carrying that cutter, with the vendor's row beside it (#749's j24 run). */
function j24Location(): string {
  const dir = join(SCRATCH, 'j24-catalogue');
  mkdirSync(dir, { recursive: true });
  const doc = JSON.parse(readFileSync(LOCATION_FIXTURE, 'utf8')) as { inventory: unknown[] };
  doc.inventory.push(J24_CUTTER);
  const path = join(dir, 'location.json');
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  // `6061 Aluminum` is the vendor's own material name; the row is the one Makera's catalogue
  // served for this cutter, and `feeds.ts` maps it to the job's `aluminium-6061`.
  writeFileSync(
    join(dir, 'catalogue.json'),
    JSON.stringify(
      {
        kind: 'casemaker-catalogue',
        schemaVersion: 1,
        syncedAt: '2026-10-20T08:00:00.000Z',
        tools: [
          {
            key: 'cat:fixture-j24-o-flute',
            tool: J24_CUTTER.tool,
            provenance: 'fixture row for #749',
          },
        ],
        feeds: [
          { cutterId: J24_CUTTER_ID, material: '6061 Aluminum', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.2 },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  return path;
}

let locationPath: string | null = null;

/** The committed fixture document with the bench's cutters appended, written once. */
function benchLocation(): string {
  if (locationPath !== null) return locationPath;
  const doc = JSON.parse(readFileSync(LOCATION_FIXTURE, 'utf8')) as { inventory: unknown[] };
  doc.inventory.push(...BENCH_CUTTERS);
  locationPath = join(SCRATCH, 'location.json');
  writeFileSync(locationPath, JSON.stringify(doc));
  // #746 — the three real-jobs cutters cut 6061 aluminium, a material the compiled starting table
  // does not cover: the feed row must come from the vendor's catalogue for that exact cutter, as
  // the house location has it. The two flats and the engraver share the exercise's numbers.
  const catalogueTools = ['kz-o-flute-m-3-175-12', 'kz-o-flute-m-1-5-6', 'kz-engrave-m-30-0-2'].map((key) => {
    const entry = BENCH_CUTTERS.find((c) => c.id === key)!;
    return { key: `cat:${entry.tool.id}`, tool: entry.tool, provenance: 'fixture', contentHash: entry.id };
  });
  const catalogueFeeds = catalogueTools.map((row) => ({
    cutterId: (row.tool as { id: string }).id,
    material: '6061 Aluminum',
    rpm: 10_000,
    feed: 400,
    plungeFeed: 100,
    stepDown: 0.4,
  }));
  writeFileSync(
    join(SCRATCH, 'catalogue.json'),
    JSON.stringify({
      kind: 'casemaker-catalogue',
      schemaVersion: 1,
      syncedAt: '2026-10-28T00:00:00.000Z',
      tools: catalogueTools,
      feeds: catalogueFeeds,
    }),
  );
  return locationPath;
}

interface Run {
  code: number;
  receipt: Receipt;
  progress: string[];
  outDir: string;
}

/** Run `casemaker cut <job>` the way the CLI does, capturing its receipt and progress lines. */
async function cut(
  jobFile: string,
  jobsDir: string = JOBS,
  location: string = benchLocation(),
): Promise<Run> {
  const outDir = join(SCRATCH, jobFile.replace(/\.json$/, ''));
  mkdirSync(outDir, { recursive: true });
  let receipt: Receipt | null = null;
  const progress: string[] = [];
  const options: CommandOptions = {
    ...HUMAN,
    sink: {
      progress: (line) => progress.push(line),
      receipt: (r) => {
        receipt = r;
      },
    },
  };
  const code = await engraveJobMain(
    [asArg(join(jobsDir, jobFile)), '--out', outDir, '--location', asArg(location)],
    options,
  );
  expect(receipt, 'the command must emit a receipt, even on a refusal').not.toBeNull();
  return { code, receipt: parseReceipt(receipt!), progress, outDir };
}

/** The text of one `.nc` the run wrote. */
function programText(run: Run, ncFile: string): string {
  return readFileSync(join(run.outDir, ncFile), 'utf8');
}

/**
 * A copy of a committed bench job with NO cutter named (#760), written into the scratch dir, so
 * the CLI's own pick runs on the same document the bench cut by hand.
 */
function pickedVariant(jobFile: string, jobsDir: string): string {
  const name = jobFile.replace(/\.json$/, '') + '-picked.json';
  const job = JSON.parse(readFileSync(join(jobsDir, jobFile), 'utf8')) as Record<string, unknown>;
  job.toolKey = '';
  delete job.setups;
  writeFileSync(join(SCRATCH, name), JSON.stringify(job, null, 2) + '\n');
  return name;
}

/**
 * The exercise ran each job under a 600 s command timeout; j05 and j11 hit it (exit 124) before
 * #734's pocket fix. j05 now finishes the whole generate → verify → simulate pipeline in under
 * 0.3 s (measured by the test below), so a minute is ample headroom for a slow runner and still an
 * unambiguous regression: the pre-fix run never finished at all. j11 no longer reaches the
 * pipeline: #741 refuses its 5.1 mm pocket on its cutter's 4.992 mm cone (see below).
 */
const BUDGET_MS = 60_000;

/** The j05 cutter as the bench inventory states it: a 30° V-bit with a 0.3 mm flat tip. */
function benchEngraver(tipDiameter: number): Tool {
  return flatEndMill(tipDiameter, {
    name: `Single Flute Engraving Bit - 1/8" Shank 30° * ${tipDiameter}mm`,
    typeText: 'Engraving',
    shape: 'engraving',
    diameter: 3.175,
    halfAngle: 15,
    angle: 30,
  });
}

/** Parse a bench job file the way the CLI does. */
function benchJob(jobFile: string): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(join(JOBS, jobFile), 'utf8')));
  if (!parsed.ok) throw new Error(`${jobFile}: ${parsed.errors.join('; ')}`);
  return parsed.job;
}

/** Total vertices across a region's contours. */
const vertexCount = (region: Polygons): number => region.reduce((n, contour) => n + contour.length, 0);

describe('#734 the typical jobs run clean through the cut pipeline', () => {
  it('j17 PLA proxy: no rapid crosses material still present, so the cut is not refused', async () => {
    // The bench recorded: {"code":"rapid-through-stock","sentence":"7 rapids pass through
    // material still present at that point in the program (first at line 976)"} — the job's own
    // through cuts reach `thickness + breakthrough`, and the sweep's floor did not.
    const { code, receipt } = await cut('j17-faceplate-proxy.json');
    const rapid = receipt.diagnostics.filter((d) => d.code === 'rapid-through-stock');
    expect(rapid, 'the false rapids the bench recorded must not come back').toEqual([]);
    expect(code, 'a clean job must not be refused by its own simulation').toBe(0);
  }, 120_000);

  it('j05 V-carve region: a pocket ring is offset from the original region, so its vertices cannot compound', () => {
    // The bench job's "OPEN" glyph outline is ONE region of 555 vertices. `pocketLoops` used to
    // offset each ring from the PREVIOUS ring, and Clipper's round joins at the glyph's reflex
    // corners add vertices that the next offset doubles again: at this pitch (a coarse 0.5 mm
    // cutter / 0.4 mm step-over, chosen so the old growth is visible in milliseconds) the old
    // rings grow 494 → 886 → 1678 → 3262, and at the job's real 0.15 mm pitch a ring reached
    // 342 494 vertices — which is why the cut never finished. Each ring now offsets the ORIGINAL
    // region and stays near the input's own count (measured 494–553 here). A ring carrying more
    // than twice the input is the compounding defect, not a legitimate offset.
    const job = benchJob('j05-two-colour-sign-adjusted.json');
    const { regions } = engraveRegions(tl, job, benchEngraver(0.3));
    expect(regions.length).toBeGreaterThan(0);
    const region = regions[0]!.polygons;
    const inputVerts = vertexCount(region);
    expect(inputVerts).toBeGreaterThan(300); // the real glyph outline, not a stand-in

    const rings = pocketLoops(region, 0.5, 0.4, makeClipperOffset(tl));
    expect(rings.length).toBeGreaterThan(1);
    rings.forEach((ring, k) => {
      expect(vertexCount(ring), `ring ${k} of ${rings.length}`).toBeLessThanOrEqual(2 * inputVerts);
    });
  });

  it('j05 two-colour sign: the 30° 0.3 V-bit job finishes inside the 600 s budget', async () => {
    const started = Date.now();
    const { code, receipt } = await cut('j05-two-colour-sign-adjusted.json');
    const elapsed = Date.now() - started;
    const errors = receipt.diagnostics.filter((d) => d.severity === 'error');
    expect(errors, 'the bench job must cut without an error diagnostic').toEqual([]);
    expect(code, 'a clean job must complete, not be refused').toBe(0);
    expect(elapsed, `cut took ${elapsed} ms`).toBeLessThan(BUDGET_MS);
  }, 150_000);

  it('j11 inlay female: the 5.1 mm pocket is refused on the cutter’s 4.992 mm cone (#741)', async () => {
    // The bench's own recipe asks for a 5.1 mm pocket with a 30° × 0.5 mm engraver whose cone
    // reaches its ⌀3.175 mm body at 4.9916 mm. Above the cone the bit's BODY cuts a vertical wall,
    // not a V, so the pocket would not be the inlay it claims to be. #741 refuses it by name, and
    // the refusal comes before any program is written — which is why the finish-time budget #734
    // pinned no longer applies to this job; j05 above still pins the ring-growth fix.
    const { code, receipt } = await cut('j11-inlay-female.json');
    const depth = receipt.diagnostics.filter((d) => d.code === 'vcarve-depth-beyond-cone');
    expect(depth.map((d) => d.severity), JSON.stringify(receipt.diagnostics)).toEqual(['error']);
    expect(depth[0]!.message).toContain('5.1 mm');
    expect(depth[0]!.message).toContain('4.992 mm');
    expect(receipt.command).toBe('engrave');
    if (receipt.command !== 'engrave') return;
    expect(receipt.details.programs, 'a refused job writes no program').toEqual([]);
    expect(code, 'a refused job exits non-zero').toBe(1);
  }, 60_000);
});

// #738 — THE REAL JOBS' RAPIDS. The bench refused four jobs for `rapid-through-stock`. Splitting
// the refusal by cause is the point of these tests:
//
//   j13 tool tray (10 rapids) — #734 item 1's false positive, not a CAM defect: a taped through
//     cut reaches `thickness + breakthrough`, and the sweep's floor was the blank's bottom. The
//     fix that passes `breakthroughMm` to the sweep clears it; it is pinned here so it cannot
//     regress.
//   j06 wolf and j07 photo relief (16, 5 and 63 rapids) — ONE genuine surfacing CAM defect:
//     `roughingMoves` emerged from a gap with a single `G0 X.. Z..` rapid instead of the house
//     two-move hop (a Z-only retract, then the XY traverse at `HOP_Z`), so the tool climbed away
//     diagonally through material still standing beside the cut. Both goals run through the same
//     `surface3d.ts` pass. j06's STL bytes are deliberately not committed (the exercise README
//     says how to rebuild them), so its committed job cannot be surfaced by a test; the IR-level
//     rule is asserted for the same code path in `surface3d.spec.ts`.
//
// The exercise ran each job under a 600 s timeout. The surfacing jobs measured here generate in
// 1.3–2.0 s and sweep in 5.8–6.6 s (j06's uncommitted bench copy: 10.5 s), so 150 s is ample.
describe('#738 the real jobs leave no rapid through material', () => {
  it('j07 photo relief (2 mm ball): a gap retract lifts before it travels', async () => {
    // Recorded: "5 rapids pass through material still present ... (first at line 72655)", that
    // line being `G0 X49.5 Z1` straight out of `G1 X49.6 Z-0.794`.
    const { code, receipt } = await cut('j07-photo-relief.json', REAL_JOBS);
    const rapid = receipt.diagnostics.filter((d) => d.code === 'rapid-through-stock');
    expect(rapid, 'the rapids the bench recorded must not come back').toEqual([]);
    expect(code, 'a clean job must not be refused by its own simulation').toBe(0);
  }, 150_000);

  it('j07 photo relief (1 mm ball): the same roughing hop at the finer cutter', async () => {
    // Recorded: 63 rapids, first at line 26169.
    const { code, receipt } = await cut('j07-photo-relief-1mm-ball.json', REAL_JOBS);
    const rapid = receipt.diagnostics.filter((d) => d.code === 'rapid-through-stock');
    expect(rapid, 'the rapids the bench recorded must not come back').toEqual([]);
    expect(code, 'a clean job must not be refused by its own simulation').toBe(0);
  }, 150_000);

  it('j13 tool tray: the through cuts’ breakthrough keeps the sweep’s floor below them', async () => {
    // Recorded: 10 rapids. This job is 2.5D (no surfacing): its refusals were #734 item 1's false
    // positive, and this test pins the `breakthroughMm` plumbing that cleared them.
    const { code, receipt } = await cut('j13-tool-tray.json', REAL_JOBS);
    const rapid = receipt.diagnostics.filter((d) => d.code === 'rapid-through-stock');
    expect(rapid, 'the rapids the bench recorded must not come back').toEqual([]);
    expect(code, 'a clean job must not be refused by its own simulation').toBe(0);
  }, 150_000);
});

/** Every diagnostic in one string, so a failed length assertion prints the whole finding list. */
const allDiagnostics = (receipt: Receipt): string =>
  receipt.diagnostics.map((d) => `${d.severity} ${d.code}: ${d.message}`).join('\n');

// #739 — RAISED TEXT NARROWER THAN THE CUTTER. j02 clears a 92 × 82 mm panel 1 mm deep with a
// 3.175 mm flat and leaves two construction labels standing: "CNX" at 24 mm survives as three
// separate letters, while "Software" at 14 mm fuses into one blob — the bench saw it and the
// engine said nothing. j04 is the same failure in the coin proxy: "Software" at 3.6 mm with a
// 1 mm flat. The trigger must be the measured geometry, not a size threshold: "CNX" is smaller
// than the cutter in pairwise places (N–X come within 3.11 mm) yet the opening still clears the
// gaps, which is why it must stay silent.
describe('#739 raised text warns when its gaps are narrower than the cutter', () => {
  it('j02 raised CNX: "Software" fuses at the 3.175 mm cutter, and "CNX" is left alone', async () => {
    const { code, receipt } = await cut('j02-raised-cnx.json', REAL_JOBS);
    const fused = receipt.diagnostics.filter((d) => d.code === 'raised-text-fused');
    expect(fused, allDiagnostics(receipt)).toHaveLength(1);
    const warning = fused[0]!;
    expect(warning.severity, 'a narrowed gap is a warning, not a refusal').toBe('warning');
    expect(warning.message).toContain('"Software"');
    expect(warning.message).toContain('14 mm');
    expect(warning.message).toContain('1.08 mm');
    expect(warning.message).toContain('3.175 mm');
    expect(warning.message).toContain('42 mm');
    expect(allDiagnostics(receipt), '"CNX" survives the same cutter and must not be warned about').not.toContain(
      '"CNX"',
    );
    expect(code, 'a warning must not refuse the job').toBe(0);
  }, 150_000);

  it('j04 coin proxy: "Software" at 3.6 mm fuses at the 1 mm corn bit', async () => {
    const { code, receipt } = await cut('j04-coin-pla-proxy.json', REAL_JOBS);
    const fused = receipt.diagnostics.filter((d) => d.code === 'raised-text-fused');
    expect(fused, allDiagnostics(receipt)).toHaveLength(1);
    const warning = fused[0]!;
    expect(warning.message).toContain('"Software"');
    expect(warning.message).toContain('3.6 mm');
    expect(warning.message).toContain('0.278 mm');
    expect(warning.message).toContain('1 mm cutter');
    expect(warning.message).toContain('13 mm');
    expect(allDiagnostics(receipt), '"CNX" at 7 mm survives the same cutter').not.toContain('"CNX"');
    expect(code, 'a warning must not refuse the job').toBe(0);
  }, 150_000);
});

// #760/#765/#766 — THE PICK IS MEASURED. A raised cut-away's detail is what the simulation says
// the cut leaves; the search tries the kind-valid plans (a clearance cutter plus a finer rest, a
// V rest included) and hands back the best POSTING one. These two demo jobs are the acceptance:
// j02's "Software" at 14 mm and the coin's at 3.6 mm both get a rest cutter that separates the
// word (with the pinches that still touch named), and the run still cuts.
describe('#760/#766 the measured pick gives raised text a cutter that fits its gaps', () => {
  it('j02 with no cutter named: a finer rest separates "Software", and the run says how it chose', async () => {
    const variant = pickedVariant('j02-raised-cnx.json', REAL_JOBS);
    const { code, receipt, progress } = await cut(variant, SCRATCH);
    expect(code, allDiagnostics(receipt)).toBe(0);
    const lines = progress.join('\n');
    expect(lines).toContain('Chosen by simulation');
    expect(lines).toContain('rest —');
    // The 1.08 mm gaps are wider than the rest cutter the search finds (a V or a 1 mm flat), so
    // the raised warning has nothing to say once the finding is judged at the rest's width.
    expect(
      allDiagnostics(receipt),
      'the rest cutter separates "Software", so no raised-text warning belongs on this run',
    ).not.toContain('raised-text-fused');
  }, 150_000);

  it('the coin disc with no cutter named: the pick names the pinches that still touch, and "CNX" is left alone', async () => {
    const variant = pickedVariant('j04-coin-disc-pla.json', REAL_JOBS);
    const { code, receipt, progress } = await cut(variant, SCRATCH);
    expect(code, allDiagnostics(receipt)).toBe(0);
    const lines = progress.join('\n');
    expect(lines, 'the pick is measured and explained').toContain('Chosen by simulation');
    // The chosen rest states the raised pinches: how many, where, and the tightest gap.
    expect(lines).toMatch(/pinches? in clear stay joined/);
    expect(lines).toContain('0.278 mm');
    // Judged at the FINEST cutter that cuts the item (the rest), not the clearance cutter: "CNX"
    // survives that width and must not be warned about.
    const fused = receipt.diagnostics.filter((d) => d.code === 'raised-text-fused');
    for (const warning of fused) expect(warning.message).not.toContain('"CNX"');
    expect(allDiagnostics(receipt), '"CNX" at 7 mm survives the rest cutter').not.toContain('"CNX"');
  }, 150_000);
});

// #749 — A THROUGH CUT-OUT REPEATS ONE FOOTPRINT AT EVERY STEP-DOWN. j24 cuts a puck out of
// 60×60×10 mm 6061 with the 3.175 mm metal O-flute: one closed contour at every pass, so the
// sweep's columns are identical in XY and nested in Z. On the bench that exhausted the wasm heap
// (`RuntimeError: memory access out of bounds`, 4.3 GB, ~100 s); the direct reduction's 64
// columns cost 1 067 840 triangles. The sweep now unions one column per footprint, so the job
// generates, verifies and simulates. The bench recorded no removal for it (it crashed); this is
// the exact sweep's clipped volume for this job's own toolpath, identical over three CLI runs.
describe('#749 the j24 through cut-out sweeps its 103 repeated footprints', () => {
  it('generates the puck program and reports the exact removal inside the bench budget', async () => {
    const started = Date.now();
    const { code, receipt } = await cut('j24-spoke-wrench-z.json', REAL_JOBS, j24Location());
    const elapsed = Date.now() - started;
    expect(allDiagnostics(receipt), 'the kernel crash must not be reported as a stage error').not.toContain(
      'stage-error',
    );
    expect(code, allDiagnostics(receipt)).toBe(0);
    if (receipt.command !== 'engrave') throw new Error('expected the engrave receipt');
    const program = receipt.details.programs[0]!;
    expect(program.sim, 'the puck program must be swept').not.toBeNull();
    expect(program.sim!.ok, allDiagnostics(receipt)).toBe(true);
    expect(program.sim!.engine).toBe('exact');
    expect(program.sim!.errorCount).toBe(0);
    // One checkpoint per depth pass (the job's 0.2 mm step-down leaves 100) plus the plunge.
    // The old union still returned at 16 passes; this is the count that used to crash.
    expect(program.sim!.count).toBe(103);
    // Exactly the material one column removes — not a sum over stacked duplicates, and not less.
    // A dedupe that dropped a non-nested column would move this by hundreds of mm³.
    expect(program.sim!.removedVolumeMm3).toBeCloseTo(4705.0126, 1);
    expect(elapsed, `cut took ${elapsed} ms`).toBeLessThan(BUDGET_MS);
  }, 150_000);
});

// #746 — A SETUP'S LATER CUTTERS CUT THEIR OWN ITEMS. j19, j24 and j25 each name one setup with
// three cutters and a `toolItems` map, and every one of them was refused before the fix: each item
// assigned to a later cutter was re-planned as a REST pass of the first cutter's design ("rest of
// Bore ⌀14", 10.3 mm deep on 10 mm stock; "rest of Pocket rect 78×48"), a cut-out lost the
// construction outline it follows, and a V-bit after a flat was refused outright. The tests below
// run the committed fixture as ONE job and read the written programs:
//
//   - every cutter gets exactly one program, in the setup's cut order;
//   - the later cutter's program cuts ITS items at THEIR depth — a through item is posted to
//     `thickness + breakthrough` and nothing at the first cutter's through depth leaks into it;
//   - no program calls anything "rest of …" (that was the defect's fingerprint).
describe('#746 a setup’s later cutters cut the items they own, as those items', () => {
  /** Every engrave program the run wrote, in cut order. */
  function programs(run: Run) {
    const { receipt } = run;
    if (receipt.command !== 'engrave' || receipt.details === null) throw new Error('not an engrave receipt');
    return receipt.details.programs;
  }

  /** The cutter key the program's own header states. */
  function cutterOf(nc: string): string {
    return /^;@CM\|TOOL\|key=(.+)$/m.exec(nc)?.[1] ?? 'no tool key';
  }

  /**
   * Every Z word the program posts, exactly as written. `toContain('Z-4')` matched `Z-4.25` too;
   * an exact word cannot (`'-4'` is not `'-4.25'`), so a floor assertion cannot be satisfied by a
   * deeper cut on another item by accident.
   */
  function zWords(nc: string): string[] {
    return [...nc.matchAll(/\bZ(-?\d+(?:\.\d+)?)\b/g)].map((match) => match[1]!);
  }

  it('j19 accuracy sample: four programs, the cut-out last, and the 1.5’s through items stay through', async () => {
    const run = await cut('j19-accuracy-sample.json', REAL_JOBS);
    const text = allDiagnostics(run.receipt);
    // The defect's own refusals: a combined cutaway's operands were dropped from the sub-job, and a
    // later cutter's items were re-planned as "rest of …".
    expect(text, 'the combined cutaway’s construction operands must resolve').not.toContain('item-reference');
    expect(text, 'no item may be re-planned as a rest pass it was not assigned').not.toContain('rest of');
    expect(run.code, text).toBe(0);
    const written = programs(run);
    // #746 CUT-OUTS POST LAST. The 3.175 owns `outline` (the cut-out) but also `skim`, so cutting
    // both in one file would free the part before the 1.5 and the engraver touched it. The cut-out
    // is the setup's final program, on the first cutter again.
    expect(written).toHaveLength(4);
    const nc = written.map((p) => programText(run, p.ncFile));
    expect(nc.map(cutterOf)).toEqual([
      'inv:kz-o-flute-m-3-175-12',
      'inv:kz-o-flute-m-1-5-6',
      'inv:kz-engrave-m-30-0-2',
      'inv:kz-o-flute-m-3-175-12',
    ]);
    // Only the last file cuts the outline free; nothing before it may release the part.
    for (const early of nc.slice(0, 3)) expect(early).not.toContain('Cut out ');
    expect(nc[3]).toContain('Cut out ');
    // The flat cutter that owns the through vectors and bores cuts them THROUGH: 5 mm stock plus
    // the setup's 0.3 mm breakthrough.
    expect(zWords(nc[1]!), 'the 1.5 mm cutter’s through items are posted through the stock').toContain('-5.3');
    // The engraver owns the logo and its frame, at their stated 1.3 mm — not a rest of anything.
    expect(zWords(nc[2]!), 'the engraver’s own floor is exactly 1.3 mm').toContain('-1.3');
  }, 240_000);

  it('j24 spoke wrench: the bore on the 3.175, the notches on the 1.5, the labels on the engraver, the cut-out last', async () => {
    const run = await cut('j24-spoke-wrench.json', REAL_JOBS);
    const text = allDiagnostics(run.receipt);
    // Recorded: `depth-exceeds-stock` on "rest of Bore ⌀14" and "rest of Cut out outside Pocket
    // circle ⌀44" (both 10.3 mm deep on a 10 mm stock), `item-reference` on "puck", and
    // `through-tool-reach` on the later cutter for a cut-out that is the first cutter's.
    for (const code of ['depth-exceeds-stock', 'item-reference', 'through-tool-reach', 'item-detail-lost']) {
      expect(text, `the recorded ${code} refusal must not come back`).not.toContain(code);
    }
    expect(text).not.toContain('rest of');
    expect(run.code, text).toBe(0);
    const written = programs(run);
    expect(written).toHaveLength(4);
    const nc = written.map((p) => programText(run, p.ncFile));
    expect(nc.map(cutterOf)).toEqual([
      'inv:kz-o-flute-m-3-175-12',
      'inv:kz-o-flute-m-1-5-6',
      'inv:kz-engrave-m-30-0-2',
      'inv:kz-o-flute-m-3-175-12',
    ]);
    // The puck cut-out frees the part, so it is the LAST file and no earlier file cuts it.
    for (const early of nc.slice(0, 3)) expect(early).not.toContain('Cut out ');
    expect(nc[3]).toContain('Cut out ');
    // The first cutter owns the bore (⌀14, through): 10 mm stock.
    expect(zWords(nc[0]!), 'the bore is posted through the 10 mm stock').toContain('-10.3');
    // #666 — the recess is a SHAPE pocket in 6061 aluminium cut by a flat end mill, so the first
    // cutter clears it ADAPTIVELY: the real job takes the route the unit fixture does, the run
    // states the plan, and the program names the operation. (The notch and label cutters own
    // vectors and text, not pockets, so they keep their rings.)
    expect(text, 'the recess is cleared adaptively (#666)').toContain('adaptive-clearing');
    expect(nc[0]).toContain('(adaptive)');
    expect(text, 'the planner must not decline the recess').not.toContain('adaptive-fallback');
    // The 1.5 mm cutter owns four 4 mm notches. Its file must NOT carry the first cutter's through
    // depth — that was "rest of Bore ⌀14", refused at 10.3 mm — and its own floor is exactly 4 mm
    // (`Z-4` would also be a prefix of the engraver's `Z-4.25`; the exact word is not).
    const notches = zWords(nc[1]!);
    expect(notches, 'the 1.5’s own floor is exactly 4 mm').toContain('-4');
    expect(notches, 'the first cutter’s through bore must not be re-cut by the 1.5').not.toContain('-10.3');
    expect(notches, 'the engraver’s 4.25 mm floor is not the 1.5’s').not.toContain('-4.25');
    // The engraver owns the labels at 4.25 mm, and nothing else.
    const engraver = zWords(nc[2]!);
    expect(engraver, 'the engraver’s own floor is exactly 4.25 mm').toContain('-4.25');
    expect(engraver).not.toContain('-10.3');
  }, 240_000);

  it('j25 truing wrench: the hole on the 3.175, the rotor slot on the 1.5, the grooves on the engraver, the cut-out last', async () => {
    const run = await cut('j25-truing-wrench.json', REAL_JOBS);
    const text = allDiagnostics(run.receipt);
    // Recorded: the job was refused `setup-rest-unavailable` because the third cutter is a V-bit —
    // it was being asked to be a rest cutter instead of cutting its own grooves.
    expect(text, 'a V-bit that owns items must not be refused as a rest cutter').not.toContain('setup-rest-unavailable');
    expect(text).not.toContain('rest of');
    expect(run.code, text).toBe(0);
    const written = programs(run);
    expect(written).toHaveLength(4);
    const nc = written.map((p) => programText(run, p.ncFile));
    expect(nc.map(cutterOf)).toEqual([
      'inv:kz-o-flute-m-3-175-12',
      'inv:kz-o-flute-m-1-5-6',
      'inv:kz-engrave-m-30-0-2',
      'inv:kz-o-flute-m-3-175-12',
    ]);
    // `bar-out` frees the bar, so it posts after every other cutter.
    for (const early of nc.slice(0, 3)) expect(early).not.toContain('Cut out ');
    expect(nc[3]).toContain('Cut out ');
    // The 1.5 mm cutter owns the rotor slot, a THROUGH vector on 4 mm stock: posted to 4 + 0.3.
    // The through flag is what the defect dropped, and re-planning it as a 4 mm-deep pocket on a
    // 4 mm stock is what `depth-exceeds-stock` refused.
    expect(zWords(nc[1]!), 'the later cutter’s through slot stays through').toContain('-4.3');
    // The engraver owns the three 0.3 mm grooves and cuts them at their own depth.
    const grooves = zWords(nc[2]!);
    expect(grooves, 'the engraver’s own floor is exactly 0.3 mm').toContain('-0.3');
    expect(grooves, 'the engraver must not re-cut the earlier cutters’ work').not.toContain('-4.3');
  }, 240_000);
});

// #747 — THE FRAME'S Z IS THE MACHINE'S, NOT A CONSTANT. `fx-frame-pocket` is a 22.8 mm hardwood
// bracket job whose own program verified, but whose frame trace was refused with five
// `outside-envelope` errors, none of which the receipt carried, and the whole run stopped at
// verify with no file written. The cause is arithmetic, not the fixture: the stub puts every
// blank's top face at the machine's tool-change safe Z, so a frame at work Z 20 lands exactly on
// the envelope's top; for a 22.8 mm blank the WCS origin is -19.999999999999996 and 20 + origin is
// +3.6e-15 mm — outside by femtometres. The frame now traces at the highest work Z that posts
// inside the envelope (19.999 here, machine -0.001), and a frame that cannot be traced at all is
// withheld with its findings on the receipt while the verified program is still written.
describe('#747 the frame is traced inside the envelope, and never gates a verified program', () => {
  it('fx-frame-pocket (22.8 mm hardwood): the frame is written at a reachable Z', async () => {
    const { code, receipt } = await cut('fx-frame-pocket.json', REAL_JOBS);
    if (receipt.command !== 'engrave') throw new Error('expected the engrave receipt');
    // Before #747: exit 1, stage verify, "the frame file has 5 verifier error(s)", no program and
    // no frame file in `outputs`, and the five findings absent from `diagnostics`.
    expect(code, allDiagnostics(receipt)).toBe(0);
    expect(receipt.refusals, allDiagnostics(receipt)).toEqual([]);
    expect(receipt.diagnostics.filter((d) => d.message.includes('outside-envelope'))).toEqual([]);
    expect(receipt.details.programs[0]!.frameFile).toBe('fx-frame-pocket-frame.nc');
    const frame = receipt.outputs.find((o) => o.path.endsWith('-frame.nc'));
    expect(frame, 'the frame file the operator loads must be written').toBeDefined();
    // The POSTED height, to the dialect's three decimals: 19.999 + the 22.8 mm WCS origin is
    // machine Z -0.001, inside the envelope; 20 would be +3.6e-15 and refused.
    const frameText = readFileSync(frame!.path, 'utf8');
    expect(frameText).toContain('G0 Z19.999');
    // ... and the sheet prints the height in the file, never the 20 mm constant.
    const sheetPath = receipt.outputs.find((o) => o.path.endsWith('-run-sheet.md'))!.path;
    expect(readFileSync(sheetPath, 'utf8')).toContain('19.999 mm above the work');
  }, 150_000);

  it('a frame that leaves the envelope is WITHHELD with its findings on the receipt, and the program is still written', async () => {
    // The forced case: a 200 mm blank fills the envelope exactly, its under-board overhangs 6 mm
    // to the right, and a 5 mm pocket sits at the right edge. The job's own cutter CENTRE path
    // stays inside (machine X <= 0), so its verifier passes; the frame is the cutter's FOOTPRINT,
    // grown by its radius, and reaches machine X +1.494 — outside. The overhang keeps the depth
    // limit positive where the footprint reaches, so `cut-outside-stock` stays happy: this is the
    // frame's failure alone.
    const parsed = parseEngraveJob(JSON.parse(readFileSync(join(REAL_JOBS, 'fx-frame-pocket.json'), 'utf8')));
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    const job = parsed.job;
    job.name = 'fx-frame-outside';
    job.stock.length = 200;
    job.stock.thickness = 12;
    if (job.sacrificial?.under == null) throw new Error('the fixture must carry its under-board');
    job.sacrificial.under.thickness = 3;
    job.sacrificial.under.overhang = { left: 0, right: 6, front: 0, back: 0 };
    const hold = job.workholding;
    if (hold.kind !== 'bracket') throw new Error('the fixture must hold with the bracket');
    const shape = job.shapes[0]!;
    if (shape.kind !== 'circle') throw new Error('the fixture shape must be the circle pocket');
    shape.diameter = 5;
    shape.depth = 2;
    shape.position = { x: 199, y: 67 };
    for (const clamp of hold.bracket.clamps) clamp.at = clamp.edge === 'back' ? 100 : 67;
    writeFileSync(join(SCRATCH, 'fx-frame-outside.json'), JSON.stringify(job, null, 2));

    const { code, receipt } = await cut('fx-frame-outside.json', SCRATCH);
    if (receipt.command !== 'engrave') throw new Error('expected the engrave receipt');
    // Before #747 this run STOPPED: the frame's two errors made the whole result `ok: false`, no
    // program was written, and the findings never reached the receipt.
    expect(code, allDiagnostics(receipt)).toBe(0);
    expect(receipt.refusals, allDiagnostics(receipt)).toEqual([]);
    const program = receipt.details.programs[0]!;
    expect(program.frameFile, 'a refused frame is withheld, not handed over').toBeNull();
    expect(receipt.outputs.some((o) => o.path.endsWith('-frame.nc')), 'no frame file may be written').toBe(false);
    expect(
      receipt.outputs.some((o) => o.path.endsWith('.nc') && !o.path.endsWith('-frame.nc')),
      'the verified program itself is still written',
    ).toBe(true);
    // The frame's findings, with their machine coordinates, are on the receipt as the FRAME'S —
    // `source: 'frame'`, so they cannot be read as the program's — and, the frame being withheld,
    // demoted to warnings: the program itself passed and is still runnable.
    const frameErrors = receipt.diagnostics.filter(
      (d) => d.source === 'frame' && d.message.includes('outside-envelope'),
    );
    expect(frameErrors.length, allDiagnostics(receipt)).toBeGreaterThan(0);
    expect(frameErrors[0]!.severity).toBe('warning');
    expect(frameErrors[0]!.message).toContain("leaves the Makera Z1's envelope");
    // The TEXT receipt prints them, labelled as the frame's, as well as carrying them as data.
    const rendered = renderReceipt(receipt).join('\n');
    expect(rendered).toContain('     frame warn  runner-error: outside-envelope:');
    // ... and why the frame is absent: a warning, because the program never depended on the trace.
    const withheld = receipt.diagnostics.find((d) => d.code === 'no-frame');
    expect(withheld, allDiagnostics(receipt)).toBeDefined();
    expect(withheld!.severity).toBe('warning');
    expect(withheld!.source).toBe('frame');
    expect(withheld!.message).toContain('withheld');
    expect(rendered).toContain('     frame warn  no-frame: The frame file was withheld');
    // The sheet says the program can still be cut, rather than "do not run this file".
    const sheetPath = receipt.outputs.find((o) => o.path.endsWith('-run-sheet.md'))!.path;
    const sheet = readFileSync(sheetPath, 'utf8');
    expect(sheet).toContain('itself passed verification, so it can still be cut');
    expect(sheet).not.toContain('Do not run this file');
  }, 150_000);
});

// #766 slice E — THE DEMO SET. The 2026-10-29 demo re-run (`results8`) ran the fifty recordings
// in `docs/bench/2026-10-28-z1-real-jobs` with each job's cutter REMOVED, so the app chooses as a
// demo visitor would. Nine stopped posting under the measured search that had posted under the
// rules before it; the fix (19f18d40) makes the measured search never do worse than the rule, and
// the rows below pin what it chooses now.
//
// THE WOLF PAIR IS NOT HERE. Its 24 MB mesh bytes are not committed with the corpus document (the
// demo run used a scratch copy that carried them), so the committed job cannot generate at all.
// The goal-item seam its refusal named is covered by the photo-relief rows (a PNG relief) and the
// mouse shell (a 1.2 MB STL); the two coaster rows that complete the nine exist only in the demo
// scratch set. Every row here records the cutter the search chose and the fidelity it measured, so
// a choice that drifts — a different cutter, a lower score, a refusal — turns the gate red.

/**
 * The bench location plus ONE cutter: a ball whose flute reaches j27's 26 mm stock. The demo
 * library holds such a cutter; every ball in the bench fixture is 12 mm or shorter, and the reach
 * filter then leaves the 26 mm job with no candidate plan at all — a library limit, not the
 * search behaviour this suite pins. The catalogue is the bench one in the same directory.
 */
const DEMO_LONG_BALL = {
  id: 'demo-ball-nose-2-30',
  tool: {
    number: null,
    id: null,
    name: 'Two Flute Ball Nose Bit - 1/8" Shank 2mm * 30mm',
    typeText: 'Ball Nose',
    shape: 'ball',
    handleDiameter: 3.175,
    tipDiameter: 2,
    diameter: 3.175,
    cornerRadius: 1,
    angle: null,
    halfAngle: null,
    fluteLength: 30,
    shoulderLength: null,
    stickout: null,
    centreCutting: null,
  },
  origin: null,
  quantity: 1,
  codes: [],
  addedAt: '2026-10-29T00:00:00.000Z',
  notes: null,
};

let demoLocationPath: string | null = null;

/** The bench location with `DEMO_LONG_BALL` appended, written once beside the bench catalogue. */
function demoSetLocation(): string {
  if (demoLocationPath !== null) return demoLocationPath;
  const doc = JSON.parse(readFileSync(benchLocation(), 'utf8')) as { inventory: unknown[] };
  doc.inventory.push(DEMO_LONG_BALL);
  demoLocationPath = join(SCRATCH, 'location-demo-set.json');
  writeFileSync(demoLocationPath, JSON.stringify(doc));
  return demoLocationPath;
}

describe.skipIf(!existsSync(REAL_JOBS))('#766 slice E the demo set’s no-cutter jobs are given a plan that posts', () => {
  /**
   * The five committed demo documents the 2026-10-29 run refused, and the cutter the fixed search
   * chooses for each on 2026-10-30. The choice is LIBRARY-DEPENDENT by design — it is the bench
   * location's cutter set, not the demo's 134 — so what is pinned is that this library's best
   * measured plan is this cutter, with its worst item at full fidelity.
   */
  const CHOICES_ON_2026_10_30 = [
    // Was refused with "Setup 1 assigns an item that is not in it: g1" — the goal-item seam.
    { job: 'j07-photo-relief.json', chosen: 'inv:demo-ball-nose-2-30' },
    { job: 'j07-photo-relief-1mm-ball.json', chosen: 'inv:demo-ball-nose-2-30' },
    // The mouse shell: the same seam, on an STL goal whose 26 mm stock needs the long ball. #785 —
    // the 1 mm ball has a 4 mm flute and the goal is 17.255 mm deep, so it cannot reach it (the
    // holder would enter the part); the 30 mm-flute ball is the candidate that both reaches and
    // posts at full fidelity.
    { job: 'j27-mouse-shell-side1.json', chosen: 'inv:demo-ball-nose-2-30' },
    // Was refused with the cutaway's missing reference — the plan's setup dropped it.
    { job: 'j11-inlay-female-30v-male.json', chosen: 'inv:kz-engrave-30-0-5' },
    // Was refused with "Characters lost to a 1 mm cutter" under the demo library; the bench
    // location's finest metal engraver holds the tag's "555-0100" instead.
    { job: 'j14-dog-tag-alu.json', chosen: 'inv:kz-engrave-m-30-0-2' },
  ] as const;

  for (const { job, chosen } of CHOICES_ON_2026_10_30) {
    it(`${job} posts, with ${chosen}`, async () => {
      const { code, receipt, progress } = await cut(pickedVariant(job, REAL_JOBS), SCRATCH, demoSetLocation());
      const lines = progress.join('\n');
      expect(code, allDiagnostics(receipt)).toBe(0);
      expect(lines, 'the pick is measured and explained').toContain('Chosen by simulation');
      // The CHOSEN cutter, not the runner-up the "also" line names: the cutter line says "cuts".
      expect(lines, `the search must choose ${chosen} for this library`).toContain(`(${chosen}) cuts`);
      expect(lines).toContain('100 % fidelity on the worst item');
    }, 600_000);
  }

  it('j16 chamfer bevel — a job the search posted on 2026-10-29 keeps posting, with the cutter it chose', async () => {
    const { code, receipt, progress } = await cut(pickedVariant('j16-chamfer-a-bevel.json', REAL_JOBS), SCRATCH, demoSetLocation());
    expect(code, allDiagnostics(receipt)).toBe(0);
    const lines = progress.join('\n');
    expect(lines, 'the pick is measured and explained').toContain('Chosen by simulation');
    expect(lines).toContain('(inv:kz-engrave-30-0-5) cuts');
    expect(lines).toContain('100 % fidelity on the worst item');
  }, 240_000);
});
