/**
 * #1180 — the bench-jobs harness, shared by the split files.
 *
 * `benchTypicalJobs.spec.ts` ran every job family in ONE file, so its measured 348 s could not use
 * more than one worker. The harness (scratch dir, the bench's cutters, the location/catalogue
 * builders, the CLI `cut`) is moved here unchanged; each split file imports it and runs its own
 * family in its own worker. Nothing about a job or an assertion changed — the per-file test counts
 * are in the split commit.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'vitest';

import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob } from '@/types/engraveJob';
import { engraveJobMain } from '../../../scripts/lib/casemaker/engrave';
import { HUMAN, type CommandOptions } from '../../../scripts/lib/casemaker/output';
import { parseReceipt, type Receipt } from '../../../src/platform/headless/receipt';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..', '..');
const REPO = join(APP, '..');
export const JOBS = join(REPO, 'docs', 'bench', '2026-10-27-z1-typical-jobs', 'jobs');
export const REAL_JOBS = join(REPO, 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');
const LOCATION_FIXTURE = join(HERE, '..', 'fixtures', 'location-doc.json');

export const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-bench-734-'));

/** A path as the command will read it — relative to the cwd the spec runs in. */
const asArg = (path: string): string => relative(process.cwd(), path);

/**
 * The bench's owned cutters, as inventory entries (the `inv:` keys the job files name).
 *
 * The numbers are the exercise's own records: a 3.175 mm single-flute flat with a 25 mm flute, and
 * the two 30° single-flute engravers with 0.3 and 0.5 mm tips. Only the fields the registry reads
 * are stated; the rest keep the schema's defaults.
 */
export const BENCH_CUTTERS = [
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
export const J24_CUTTER_ID = '112111313812';
export const J24_CUTTER = {
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
export function j24Location(): string {
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
export function benchLocation(): string {
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

export interface Run {
  code: number;
  receipt: Receipt;
  progress: string[];
  outDir: string;
}

/** Run `casemaker cut <job>` the way the CLI does, capturing its receipt and progress lines. */
export async function cut(
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
  const parsed = parseReceipt(receipt!);
  // #926 — EVERY receipt states what each program spends its time and its material on. The 10-27
  // and 10-28 corpora run through this helper, so this is the corpus's own check that the
  // efficiency measures reach the receipt an operator and a reviewer read, not just the sheet.
  if (parsed.command === 'engrave' && parsed.details !== null) {
    for (const program of parsed.details.programs) {
      if (program.cam === null) continue; // a refusal may never have recorded a CAM summary
      expect(program.cam.efficiency, `${program.name} carries the efficiency measures (#926)`).toBeDefined();
    }
  }
  return { code, receipt: parsed, progress, outDir };
}

/** The text of one `.nc` the run wrote. */
export function programText(run: Run, ncFile: string): string {
  return readFileSync(join(run.outDir, ncFile), 'utf8');
}

/**
 * A copy of a committed bench job with NO cutter named (#760), written into the scratch dir, so
 * the CLI's own pick runs on the same document the bench cut by hand.
 */
export function pickedVariant(jobFile: string, jobsDir: string): string {
  const name = jobFile.replace(/\.json$/, '') + '-picked.json';
  const job = JSON.parse(readFileSync(join(jobsDir, jobFile), 'utf8')) as Record<string, unknown>;
  job.toolKey = '';
  delete job.setups;
  writeFileSync(join(SCRATCH, name), JSON.stringify(job, null, 2) + '\n');
  return name;
}

/**
 * #1010 — a copy of a committed bench job with ONE HOUSE CUTTER NAMED, written into the scratch
 * dir. The demo set's job file names none (that is what makes the demo search run); a case pinned
 * at the END STATE — what the plan posts and what it measures — names the cutter the search would
 * have to find, so the run is one plan rather than a full-fidelity search over every candidate.
 */
export function namedVariant(jobFile: string, jobsDir: string, toolKey: string): string {
  const name = jobFile.replace(/\.json$/, '') + '-named.json';
  const job = JSON.parse(readFileSync(join(jobsDir, jobFile), 'utf8')) as Record<string, unknown>;
  job.toolKey = toolKey;
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
export const BUDGET_MS = 60_000;

/** The j05 cutter as the bench inventory states it: a 30° V-bit with a 0.3 mm flat tip. */
export function benchEngraver(tipDiameter: number): Tool {
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
export function benchJob(jobFile: string): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(join(JOBS, jobFile), 'utf8')));
  if (!parsed.ok) throw new Error(`${jobFile}: ${parsed.errors.join('; ')}`);
  return parsed.job;
}

/** Total vertices across a region's contours. */
export const vertexCount = (region: Polygons): number => region.reduce((n, contour) => n + contour.length, 0);

/** Every diagnostic in one string, so a failed length assertion prints the whole finding list. */
export const allDiagnostics = (receipt: Receipt): string =>
  receipt.diagnostics.map((d) => `${d.severity} ${d.code}: ${d.message}`).join('\n');

/** Remove this file's scratch tree. Each split file owns its own (a worker per file). */
export function cleanupBenchScratch(): void {
  rmSync(SCRATCH, { recursive: true, force: true });
}

