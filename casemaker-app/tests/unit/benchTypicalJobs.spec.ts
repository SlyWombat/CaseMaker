// #734 — the typical Z1 jobs that `docs/bench/2026-10-27-z1-typical-jobs` records are run through
// the same `casemaker cut` pipeline the exercise used, so a defect the bench found is a test here
// rather than a note in a manifest.
//
// The job JSONs stay where the bench put them: this spec reads them from `docs/bench`, and never
// rewrites them. The bench's own location document is not committed (it is the operator's machine),
// so the cutters those jobs name are built here from the same inventory entries the exercise used.
// The rest of the document is the committed test fixture.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { parseReceipt, type Receipt } from '../../src/platform/headless/receipt';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const REPO = join(APP, '..');
const JOBS = join(REPO, 'docs', 'bench', '2026-10-27-z1-typical-jobs', 'jobs');
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
];

let locationPath: string | null = null;

/** The committed fixture document with the bench's cutters appended, written once. */
function benchLocation(): string {
  if (locationPath !== null) return locationPath;
  const doc = JSON.parse(readFileSync(LOCATION_FIXTURE, 'utf8')) as { inventory: unknown[] };
  doc.inventory.push(...BENCH_CUTTERS);
  locationPath = join(SCRATCH, 'location.json');
  writeFileSync(locationPath, JSON.stringify(doc));
  return locationPath;
}

interface Run {
  code: number;
  receipt: Receipt;
  progress: string[];
}

/** Run `casemaker cut <job>` the way the CLI does, capturing its receipt and progress lines. */
async function cut(jobFile: string): Promise<Run> {
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
    [asArg(join(JOBS, jobFile)), '--out', outDir, '--location', asArg(benchLocation())],
    options,
  );
  expect(receipt, 'the command must emit a receipt, even on a refusal').not.toBeNull();
  return { code, receipt: parseReceipt(receipt!), progress };
}

/**
 * The exercise ran each job under a 600 s command timeout; j05 and j11 hit it (exit 124) before
 * #734's pocket fix. Both now finish the whole generate → verify → simulate pipeline in under
 * 0.3 s (measured by the tests below), so a minute is ample headroom for a slow runner and still
 * an unambiguous regression: the pre-fix run never finished at all.
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

  it('j11 inlay female: the 30° 0.5 V-bit inlay finishes inside the 600 s budget', async () => {
    const started = Date.now();
    const { code, receipt } = await cut('j11-inlay-female.json');
    const elapsed = Date.now() - started;
    const errors = receipt.diagnostics.filter((d) => d.severity === 'error');
    expect(errors, 'the bench job must cut without an error diagnostic').toEqual([]);
    expect(code, 'a clean job must complete, not be refused').toBe(0);
    expect(elapsed, `cut took ${elapsed} ms`).toBeLessThan(BUDGET_MS);
  }, 150_000);
});
