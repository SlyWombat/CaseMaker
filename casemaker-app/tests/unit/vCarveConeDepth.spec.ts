// #741 — A V-CARVE DEEPER THAN THE CUTTER'S CONE.
//
// A V-bit is a cone only up to where its flank meets its cylindrical body. A 3.175 mm 90° chamfer
// bit's cone is (3.175 − 0.1) / (2 · tan 45°) = 1.5375 mm tall; a 30° 0.5 mm engraver's is
// (3.175 − 0.5) / (2 · tan 15°) = 4.9916 mm. Below that height the flank cuts a V; above it the
// bit's BODY cuts a vertical wall, so the pocket is no longer a V and an inlay plug cannot seat.
//
// The rule is REFUSED rather than capped: the depth is the design (an inlay's female depth and
// its derived plug are one number), and a silent cap would change the part and desynchronise the
// plug. The one owner is `vDepthLimit` in `vProfile.ts` — the same cone geometry the column
// engine, the oracle and the panel read. This spec pins the owner's arithmetic, the finding the
// real bench fixture raises (and the 30v job #742 moved inside its cone), and the shared sentence
// the panel shows.
//
// The fixtures stay where the bench put them; none is rewritten. Their job files name their
// cutters by inventory key, so the cutters are built here from the exercise's own records.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate as generateJob } from './helpers/engravePipeline';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { engraveRegions } from '@/workers/sim/engraveGenerate';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { vDepthLimit, vDepthRefusal } from '@/engine/cnc/vProfile';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob, EngraveRectShape } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const REAL_JOBS = join(REPO, 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');

/** The bench location's C1-BIT-CHAMFER-90: a 3.175 mm 90° chamfer with a 0.1 mm tip. */
const CHAMFER_90: Tool = flatEndMill(3.175, {
  id: null,
  name: 'C1-BIT-CHAMFER-90',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: 0.1,
  diameter: 3.175,
  angle: 90,
  halfAngle: 45,
  fluteLength: 1.6,
  cornerRadius: null,
});

/** The bench location's 30° × 0.5 mm engraver: a point-recorded tip, no stated flute. */
const ENGRAVER_30: Tool = flatEndMill(3.175, {
  id: null,
  name: 'Single Flute Engraving Bit - 1/8" Shank 30° * 0.5mm',
  typeText: 'Engraving',
  shape: 'engraving',
  tipDiameter: 0.5,
  diameter: 3.175,
  angle: 30,
  halfAngle: 15,
  fluteLength: null,
  cornerRadius: null,
});

function benchJob(file: string): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(join(REAL_JOBS, file), 'utf8')));
  if (!parsed.ok) throw new Error(`${file}: ${parsed.errors.join('; ')}`);
  // #741 — the cutter's DEPTH is this spec's subject. The bench cut these jobs in a vise, and
  // this no-location harness has no bed to seat its jaws against, so a `vise-jaw-collision` that
  // the CLI run does not raise would refuse them before the depth rule is read. The fixture FILE
  // is untouched; the in-memory job is taped — the hold the volume measurements below use.
  const workholding: EngraveJob['workholding'] = {
    kind: 'tape',
    tape: { width: 20, thickness: 0.2, inset: 2, where: null, squareTo: 'front', source: 'default' },
  };
  return { ...parsed.job, workholding };
}

/**
 * The whole pipeline with the cutter the fixture's `toolKey` names in the bench location, snapped
 * on the job exactly as a saved job carries it — so `jobTool` hands the pipeline this cutter.
 */
function generate(job: EngraveJob, tool: Tool) {
  return generateJob(tl, { ...job, tool });
}

function rect(depth: number): EngraveRectShape {
  return {
    id: 'plate',
    name: 'plate',
    kind: 'rect',
    position: { x: 20, y: 15 },
    rotation: 0,
    depth,
    enabled: true,
    width: 20,
    height: 10,
    cornerRadius: 0,
  };
}

/** A plain V-carve region for the boundary cases: no film, so the plane is the floor. */
function shallowJob(depth: number, tool: Tool): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: 40, width: 30 },
    labels: [],
    traces: [],
    shapes: [rect(depth)],
    toolKey: 'bench-cutter',
    tool,
    cutOverride: { stepDown: 0.2, stepOver: 1.42875 },
  };
}

describe('#741 the depth limit is the cutter’s own cone, not a table', () => {
  it('derives the 90° chamfer’s 1.5375 mm cone from its tip, diameter and angle', () => {
    const limit = vDepthLimit(CHAMFER_90)!;
    expect(limit.coneHeightMm).toBeCloseTo(1.5375, 9);
    expect(limit.statedFluteMm).toBe(1.6);
    expect(limit.boundBy).toBe('cone');
    // The CONE binds: it ends before the record's own 1.6 mm flute does.
    expect(limit.limitMm).toBeCloseTo(1.5375, 9);
  });

  it('derives the 30° engraver’s 4.9916 mm cone, with no stated flute', () => {
    const limit = vDepthLimit(ENGRAVER_30)!;
    expect(limit.coneHeightMm).toBeCloseTo((3.175 - 0.5) / (2 * Math.tan(Math.PI / 12)), 9);
    expect(limit.coneHeightMm).toBeCloseTo(4.9916, 3);
    expect(limit.statedFluteMm).toBeNull();
    expect(limit.boundBy).toBe('cone');
    expect(limit.limitMm).toBeCloseTo(4.9916, 3);
  });

  it('a stated flute shorter than the cone is the binding limit, and is named', () => {
    const short = { ...ENGRAVER_30, fluteLength: 3 };
    const limit = vDepthLimit(short)!;
    expect(limit.boundBy).toBe('flute');
    expect(limit.limitMm).toBe(3);
    expect(limit.coneHeightMm).toBeCloseTo(4.9916, 3);
  });

  it('states no limit when the record states neither a diameter nor a flute', () => {
    expect(vDepthLimit({ ...ENGRAVER_30, diameter: null, fluteLength: null })).toBeNull();
  });

  it('the sentence names every number and its unit, and which bound binds', () => {
    const cone = vDepthRefusal('"Star"', 5.1, CHAMFER_90, vDepthLimit(CHAMFER_90)!);
    expect(cone).toContain('"Star" is 5.1 mm deep');
    expect(cone).toContain('C1-BIT-CHAMFER-90');
    expect(cone).toContain('1.538 mm');
    expect(cone).toContain('⌀3.175 mm');
    expect(cone).toContain('1.6 mm flute');
    expect(cone).toContain('5.1 mm');
    expect(cone).not.toMatch(/vcarve|code|error/i);

    const flute = vDepthRefusal('"FF"', 5.1, { ...ENGRAVER_30, fluteLength: 3 }, vDepthLimit({ ...ENGRAVER_30, fluteLength: 3 })!);
    expect(flute).toContain('3 mm flute');
    expect(flute).toContain('4.992 mm');
    expect(flute).toContain('5.1 mm');
  });
});

describe('#741 the bench’s over-deep V-carves are refused by name', () => {
  const depthFinding = (job: EngraveJob, tool: Tool) => {
    const gen = generate(job, tool);
    return {
      gen,
      finding: gen.findings.find((f) => f.code === 'vcarve-depth-beyond-cone'),
    };
  };

  it('the star recipe’s 5.1 mm female pocket on a cone 1.5375 mm tall', () => {
    const job = benchJob('j11-v1-star-female-90.json');
    const { gen, finding } = depthFinding(job, CHAMFER_90);
    expect(finding, JSON.stringify(gen.findings.map((f) => `${f.severity}:${f.code}`))).toBeDefined();
    expect(finding!.severity).toBe('error');
    expect(finding!.labelId).toBe('s1');
    expect(finding!.message).toContain('5.1 mm');
    expect(finding!.message).toContain('1.538 mm');
    expect(finding!.message).toContain('C1-BIT-CHAMFER-90');
    // The program is not written.
    expect(gen.ok).toBe(false);
    expect(gen.programs).toEqual([]);
  });

  it('the derived 3.8 mm male plug on the same 1.5375 mm cone', () => {
    const job = benchJob('j11-v1-star-male-90.json');
    const { gen, finding } = depthFinding(job, CHAMFER_90);
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('3.8 mm');
    expect(finding!.message).toContain('1.538 mm');
    expect(gen.programs).toEqual([]);
  });

  it('the 30v inlay female now sits inside the 4.9916 mm cone, and a 5.1 mm cut is still refused', () => {
    // #742 moved the real bench job from 5.1 mm to 4.8 mm when it gained its female inlay mark,
    // so the fixture no longer exercises the 30° cone's bound — it must generate.
    const job = benchJob('j11-inlay-female-30v.json');
    const { gen } = depthFinding(job, ENGRAVER_30);
    expect(
      gen.findings.filter((f) => f.code === 'vcarve-depth-beyond-cone'),
      JSON.stringify(gen.findings.map((f) => `${f.severity}:${f.code}`)),
    ).toEqual([]);
    expect(gen.ok, JSON.stringify(gen.findings.map((f) => `${f.severity}:${f.code}:${f.message}`))).toBe(true);
    expect(gen.programs.length).toBeGreaterThan(0);

    // The 30° cone's own bound stays pinned on a constructed 5.1 mm cut — the depth the bench
    // recipe asked for before #742 — so the 4.9916 mm sentence cannot regress unseen.
    const over = depthFinding(shallowJob(5.1, ENGRAVER_30), ENGRAVER_30);
    expect(over.finding).toBeDefined();
    expect(over.finding!.severity).toBe('error');
    expect(over.finding!.message).toContain('5.1 mm');
    expect(over.finding!.message).toContain('4.992 mm');
    expect(over.finding!.message).toContain('30°');
    expect(over.gen.programs).toEqual([]);
  });

  it('a cut exactly at the cone height is allowed, and one past it is not', () => {
    const at = engraveRegions(tl, shallowJob(1.5375, CHAMFER_90), CHAMFER_90);
    expect(at.findings.filter((f) => f.code === 'vcarve-depth-beyond-cone')).toEqual([]);
    const past = engraveRegions(tl, shallowJob(1.5376, CHAMFER_90), CHAMFER_90);
    expect(past.findings.find((f) => f.code === 'vcarve-depth-beyond-cone')).toBeDefined();
  });

  it('a plain V-carve inside the limit is unaffected', () => {
    const job = shallowJob(1, CHAMFER_90);
    const gen = generate(job, CHAMFER_90);
    expect(gen.findings.filter((f) => f.code === 'vcarve-depth-beyond-cone')).toEqual([]);
    expect(gen.ok, JSON.stringify(gen.findings.map((f) => `${f.severity}:${f.code}`))).toBe(true);
  });
});
