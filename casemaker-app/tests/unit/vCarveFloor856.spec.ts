// #856 — A V-CARVE IS MEASURED FROM THE FLOOR IT SITS ON.
//
// The demo's coaster inlay (j21) has a pocket on a 10 mm floor with letters 14 mm deep cut by a
// 30° × 0.5 mm engraver. Slice 3's clamp compared the letters' ABSOLUTE depth (14) with the
// cone's reach (4.9916) and rewrote the cut to 4.9916 mm — a depth ABOVE the 10 mm floor. The CAM
// then found no material and THREW ("…sits on a floor 10 mm down and states a depth of 4.99…"),
// so the job did not post.
//
// The rule is the MATERIAL above the floor: `depth − floor`. That is what the cone reaches; the
// clamp writes `floor + reach`; and when an item still has nothing to cut it is LEFT UNCUT and
// SAID (`item-left-uncut`), never a stage error.

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate as generateJob } from './helpers/engravePipeline';
import { engraveRegions } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { generateEngrave, type EngraveRegion } from '@/engine/cnc/cam/engraveJob';
import { Z1 } from '@/engine/cnc/machine';
import type { CutParams } from '@/engine/cnc/feeds';
import type { EngraveJob, EngraveRectShape } from '@/types/engraveJob';

const CAM_PARAMS: CutParams = { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.2, stepOver: 0.2, peck: 1, air: false };

/** The demo's 30° × 0.5 mm engraver: a cone 4.9916 mm tall, no stated flute. */
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

const REACH_30 = 4.991617955123373;

function rect(id: string, depth: number, width: number, height: number, cx: number, cy: number, variable = false): EngraveRectShape {
  return {
    id,
    name: id,
    kind: 'rect',
    position: { x: cx, y: cy },
    rotation: 0,
    depth,
    enabled: true,
    width,
    height,
    cornerRadius: 0,
    ...(variable ? { vCarveDepth: 'variable' as const } : {}),
  };
}

/**
 * The coaster's shape: a 24 × 16 pocket cut to 10 mm, and a variable V-carve inside it at
 * `innerDepth`. The inner item's floor is the pocket's 10 mm.
 */
function floorJob(innerDepth: number, innerSize = { width: 8, height: 4 }): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: 40, width: 30, thickness: 22.8 },
    labels: [],
    traces: [],
    shapes: [
      rect('pocket', 10, 24, 16, 20, 15),
      rect('inner', innerDepth, innerSize.width, innerSize.height, 20, 15, true),
    ],
    toolKey: 'bench-cutter',
    tool: ENGRAVER_30,
    cutOverride: { stepDown: 0.2, stepOver: 1.42875 },
  };
}

const generate = (job: EngraveJob) => generateJob(tl, { ...job, tool: ENGRAVER_30 });

describe('#856 a V-carve on a floor is measured from the floor', () => {
  it('the coaster’s letters (14 mm deep, on a 10 mm floor) are not clamped: they cut their 4 mm', async () => {
    const job = floorJob(14);
    const regions = engraveRegions(tl, job, ENGRAVER_30);
    // The synthetic job runs ONE cutter for both items (the demo splits the pocket onto the flat),
    // so the 10 mm pocket is itself a real shortfall for the 30° bit. The item under test is the
    // letters: on their 10 mm floor they cut 4 mm, inside the cone.
    expect(regions.findings.some((f) => f.code === 'vcarve-depth-beyond-cone' && f.labelId === 'inner')).toBe(false);
    expect(regions.findings.some((f) => f.code === 'item-left-uncut')).toBe(false);
    // The region keeps its stated depth: 4 mm of material is inside the 30° cone's 4.9916 mm.
    const inner = regions.regions.find((r) => r.id === 'inner')!;
    expect(inner.depth).toBe(14);
    // And the run does not stop at the CAM: this constructed bit has no feed row, which is the
    // stage it reaches — the depth rule (a `findings`/CAM stage error) is not the one that stops it.
    const gen = await generate(job);
    expect(gen.stage).toBe('feeds');
    expect(gen.errors.some((e) => e.message.includes('cuts no material'))).toBe(false);
  });

  it('a real shortfall is named in MATERIAL, with the floor, and the clamp keeps the floor', () => {
    // 17 mm deep on a 10 mm floor: 7 mm of material, past the 4.9916 mm cone.
    const job = floorJob(17);
    const regions = engraveRegions(tl, job, ENGRAVER_30);
    const finding = regions.findings.find((f) => f.code === 'vcarve-depth-beyond-cone' && f.labelId === 'inner');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warning');
    expect(finding!.message).toContain('7 mm of material above its 10 mm floor');
    expect(finding!.message).toContain('4.992 mm');
    expect(finding!.materialMm).toBeCloseTo(7, 9);
    // The clamped depth is the FLOOR plus the cone's reach — never the reach on its own.
    const inner = regions.regions.find((r) => r.id === 'inner')!;
    expect(inner.depth).toBeCloseTo(10 + REACH_30, 9);
  });

  it('an item AT its container’s depth is no deeper than the pocket, and the no-throw path is the CAM’s', async () => {
    // Containment gives a floor only to an item DEEPER than its container (supportingFloors), so a
    // document cannot express "at the floor" through the plan — the material-at-or-under-the-floor
    // case reaches the CAM only as a defensive path, which the block below calls directly. What
    // the pipeline must not do is throw on one item's numbers: the letters at the pocket's own
    // depth are an ordinary too-deep V-carve, said as a warning.
    const job = floorJob(10);
    const regions = engraveRegions(tl, job, ENGRAVER_30);
    expect(regions.findings.some((f) => f.code === 'item-left-uncut')).toBe(false);
    const gen = await generate(job);
    expect(gen.stage).toBe('feeds');
    expect(gen.errors.some((e) => e.message.includes('cuts no material'))).toBe(false);
  });
});

describe('#856 the CAM never throws on an item that cuts nothing', () => {
  function region(depth: number, floorDepth?: number, size = 10): EngraveRegion {
    const box: [number, number][][] = [
      [
        [0, 0],
        [size, 0],
        [size, size],
        [0, size],
      ],
    ];
    return {
      id: 'v1',
      text: '',
      name: 'V region',
      depth,
      polygons: box,
      vCarve: {
        plane: box,
        floor: box,
        surface: box,
        variable: true,
        planeDepth: depth,
        planeRadius: 0.25,
        floorInset: 0,
        surfaceOutset: 0,
        ...(floorDepth === undefined ? {} : { floorDepth }),
      },
    };
  }

  it('a region at its floor writes no operation and reports the item uncut', () => {
    const ir = generateEngrave(tl, [region(10, 10)], ENGRAVER_30, CAM_PARAMS, Z1.rapidEstimate);
    expect(ir.operations).toHaveLength(0);
    expect(ir.uncut).toHaveLength(1);
    expect(ir.uncut![0]!.labelId).toBe('v1');
    expect(ir.uncut![0]!.reason).toContain('left uncut');
  });

  it('a design narrower than the tip is reported uncut, not thrown', () => {
    // 0.4 mm square against a 0.5 mm tip: every level's ring set collapses.
    const ir = generateEngrave(tl, [region(1, 0, 0.4)], ENGRAVER_30, CAM_PARAMS, Z1.rapidEstimate);
    expect(ir.operations).toHaveLength(0);
    expect(ir.uncut).toHaveLength(1);
    expect(ir.uncut![0]!.reason).toContain('narrower than its cutter');
  });

  it('a viable region still cuts, and carries no uncut report', () => {
    const ir = generateEngrave(tl, [region(1, 0, 10)], ENGRAVER_30, CAM_PARAMS, Z1.rapidEstimate);
    expect(ir.uncut).toBeUndefined();
    expect(ir.operations.length).toBeGreaterThan(0);
  });
});
