/**
 * #1146 — the cleaning pass and the air walk: the pure file generator, red-first.
 *
 * The maintainer's ruling (2026-11-09): after every program a cleaning pass, before the first cut
 * an air walk over the outside; both default, both selectable. The motion goes as a FILE — a burst
 * of console lines froze the controller (#1123 item 43) — and the sweep's Z is the job's own
 * fixtures' top plus the shop's clearance, so it can never go below a clamp or bracket.
 */
import { describe, expect, it } from 'vitest';

import {
  cleanSweepZ,
  cleanWalkFile,
  type CleanWalkInput,
  type CleanWalkObstacle,
} from '@/engine/cnc/engrave/cleanWalk';
import { planCleanWalks } from '@/engine/cnc/engrave/cleanWalkPlan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobMountObstacles } from '@/engine/cnc/engrave/jobSetup';
import type { EngraveJob } from '@/types/engraveJob';
import { flatEndMill } from '@/engine/cnc/tool';
import { postFor } from '@/engine/cnc/post';
import type { PostContext } from '@/engine/cnc/post/z1';
import { Z1 } from '@/engine/cnc/machine';

const TOOL = flatEndMill(3.175, { number: 1, name: 'flat-3.175' });
const SETTINGS = { clearanceMm: 5, rowSpacingMm: 12, feedMmPerMin: 1500 };
/** The bench's blank: 160 × 126; two clamps standing 12 mm above the top face. */
const CLAMPS: CleanWalkObstacle[] = [
  { min: [10, 120], max: [30, 126], topZ: 12 },
  { min: [130, 120], max: [150, 126], topZ: 12 },
];
const base = (over: Partial<CleanWalkInput> = {}): CleanWalkInput => ({
  stock: { length: 160, width: 126 },
  obstacles: CLAMPS,
  travelWorkZMm: 46,
  settings: SETTINGS,
  tool: TOOL,
  rapid: Z1.rapidEstimate,
  ...over,
});

describe('#1146 — the sweep Z comes from the job’s fixtures', () => {
  it('is the highest fixture top plus the shop clearance — the stock top when nothing stands above it', () => {
    expect(cleanSweepZ(CLAMPS, 5)).toBe(17);
    expect(cleanSweepZ([], 5)).toBe(5);
    // A clamp BELOW the stock top does not lift the sweep below it.
    expect(cleanSweepZ([{ min: [0, 0], max: [1, 1], topZ: -14 }], 5)).toBe(5);
  });

  it('refuses a sweep above the machine’s travel height, naming both numbers', () => {
    const r = cleanWalkFile(base({ obstacles: [{ min: [0, 0], max: [10, 10], topZ: 50 }] }), 'clean');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("above the machine's travel height");
      expect(r.reason).toContain('55.00');
      expect(r.reason).toContain('46.00');
    }
  });
});

describe('#1146 — the cleaning file', () => {
  it('sweeps the stock footprint in rows at the sweep Z, rapids only', () => {
    const r = cleanWalkFile(base(), 'clean');
    if (!r.ok) throw new Error(r.reason);
    expect(r.sweepZ).toBe(17);
    expect(r.rows).toBe(10); // 126 / 12 → y = 6, 18, …, 114
    const moves = r.ir.operations[0]!.moves;
    expect(moves.length).toBe(20);
    for (const m of moves) {
      // Rapids: the Z1's X/Y ceiling IS 1200 mm/min, so the bench's F1500 could not be a file's
      // feed and a G0 runs at that same controller rate (see cleanWalk.ts).
      expect(m.kind).toBe('rapid');
      expect(m.z).toBe(17);
    }
    // The file's estimate is the raster's own time at that feed, and it is not zero.
    expect(r.estimatedSeconds).toBeGreaterThan(0);
    // The boustrophedon alternates: row 1 left→right, row 2 right→left.
    expect([moves[0]!.x, moves[1]!.x]).toEqual([0, 160]);
    expect([moves[2]!.x, moves[3]!.x]).toEqual([160, 0]);
    // Every row lies inside the footprint.
    for (const m of moves) {
      expect(m.x).toBeGreaterThanOrEqual(0);
      expect(m.x).toBeLessThanOrEqual(160);
      expect(m.y).toBeGreaterThanOrEqual(0);
      expect(m.y).toBeLessThanOrEqual(126);
    }
  });

  it('carries no vacuum words and no spindle: the pass moves air', () => {
    const r = cleanWalkFile(base(), 'clean');
    if (!r.ok) throw new Error(r.reason);
    expect(r.ir.air).toBe(false);
    expect(r.ir.spindleRpm).toBe(0);
  });

  it('the air walk traces the stock outline once at the same Z', () => {
    const r = cleanWalkFile(base({ obstacles: [] }), 'airwalk');
    if (!r.ok) throw new Error(r.reason);
    expect(r.sweepZ).toBe(5);
    const pts = r.ir.operations[0]!.moves.map((m) => [m.x, m.y]);
    expect(pts).toEqual([
      [0, 0],
      [160, 0],
      [160, 126],
      [0, 126],
      [0, 0],
    ]);
    for (const m of r.ir.operations[0]!.moves) {
      expect(m.kind).toBe('rapid');
      expect(m.z).toBe(5);
    }
  });
});

describe('#1146 — the walk is a FILE, and its own words are the direct air', () => {
  const CTX: PostContext = {
    jobName: 'clean-1146',
    stock: { length: 160, width: 126, thickness: 26 },
    materialName: 'hardwood',
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: 'test',
    toolKey: 'flat-3.175',
  };
  it('posts M811 on and M812 off, with no spindle and no vacuum words', () => {
    const r = cleanWalkFile(base(), 'clean');
    if (!r.ok) throw new Error(r.reason);
    const posted = postFor(Z1)(r.ir, CTX, { directAir: true, noSpindle: true });
    if (!posted.ok) throw new Error(posted.errors.join('; '));
    expect(posted.text).toContain('M811');
    expect(posted.text).toContain('M812');
    expect(posted.text).not.toContain('M331');
    expect(posted.text).not.toContain('M332');
    // The spindle is never commanded: the pass moves air.
    expect(posted.text).not.toMatch(/S\d+ M3/);
  });

  it('a normal program’s bytes are untouched without the option', () => {
    const r = cleanWalkFile(base(), 'clean');
    if (!r.ok) throw new Error(r.reason);
    const plain = postFor(Z1)(r.ir, CTX, {});
    if (!plain.ok) throw new Error(plain.errors.join('; '));
    expect(plain.text).not.toContain('M811');
    expect(plain.text).not.toContain('M812');
    expect(plain.text).toMatch(/S0 M3/);
  });
});

describe('#1146 — the job plan reads its own fixtures', () => {
  it('lifts the sweep above the bracket job’s own clamp tops, from jobMountObstacles', () => {
    const base = defaultEngraveJob();
    const job: EngraveJob = {
      ...base,
      name: 'bracket walks',
      stock: { ...base.stock, length: 100, width: 100, thickness: 12 },
      labels: [],
      workholding: {
        kind: 'bracket',
        bracket: { anchor: 1, variant: 'thin', clamps: [{ edge: 'back', at: 90 }], source: 'default' },
      },
    };
    // The fixtures the plan should read, queried from the same derivation rather than typed.
    const obstacles = jobMountObstacles(job, null)?.obstacles ?? [];
    const highest = Math.max(0, ...obstacles.map((o) => o.topZ));
    expect(highest).toBeGreaterThan(0); // the clamp really does stand above the blank

    const plan = planCleanWalks({
      job,
      defaults: null,
      surfaceMachineZ: null,
      settings: SETTINGS,
      wanted: { airwalk: true, clean: true },
    });
    expect(plan.notes).toEqual([]);
    expect(plan.clean).not.toBeNull();
    expect(plan.airwalk).not.toBeNull();
    expect(plan.clean!.sweepZ).toBeCloseTo(highest + SETTINGS.clearanceMm);
    // Posted and verified like any program: the verifier's own report says the text is clean.
    expect(plan.clean!.verify.ok).toBe(true);
    expect(plan.airwalk!.verify.ok).toBe(true);
    // No tool change: the walk plays with whatever cutter the last program left fitted.
    expect(plan.clean!.nc).not.toContain('M6');
    expect(plan.airwalk!.nc).not.toContain('M6');
  });

  it('wants neither walk when both switches are off — no files, no notes', () => {
    const plan = planCleanWalks({
      job: defaultEngraveJob(),
      defaults: null,
      surfaceMachineZ: null,
      settings: SETTINGS,
      wanted: { airwalk: false, clean: false },
    });
    expect(plan.airwalk).toBeNull();
    expect(plan.clean).toBeNull();
    expect(plan.notes).toEqual([]);
  });
});
