/**
 * #748 — A CUT ON A POCKET'S FLOOR IS PLANNED AND JUDGED FROM THAT FLOOR.
 *
 * The spoke wrench engraves "13G"…"16G" 0.25 mm into the floor of a 4 mm recess, but the V-carve
 * model measured the cone from the STOCK'S TOP FACE: `surfaceOutset = 4.25·tan15° = 1.139 mm`
 * and a merge warning "closer than 2.278 mm". Only 0.25 mm of that depth is in material, so the
 * real opening is `0.25·tan15° = 0.067 mm` per side. The coaster V-carves into a 10 mm pocket from
 * 10 to 14 mm and got `3.751 mm` per side instead of `1.072 mm` — 4× too wide.
 *
 * THE FIXTURE is the bench's j24 hand split: `-c` is the labels' program, `-a` cuts the recess.
 * Run alone, `-c`'s document holds no recess, so the labels ARE on the top face and the warning is
 * right. The plan that knows both is the document with the recess in it — the combined job's plan,
 * cut as separate programs — so the tests merge `-a`'s recess into `-c`'s document, the same list
 * `engraveGenerate` reads when it computes the run's floors once for every program.
 *
 * The bench's real run cuts the labels after the recess with the same document, and the posted
 * label moves must NOT move: a fixed V-carve's toolpath reads `planeRadius` (the tip width on a
 * blank with no film), never the surface outset. The tests pin that too.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { engraveRegions } from '@/workers/sim/engraveGenerate';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { generateEngrave, type EngraveRegion, type VCarveRegion } from '@/engine/cnc/cam/engraveJob';
import { Z1 } from '@/engine/cnc/machine';
import type { CutParams } from '@/engine/cnc/feeds';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import { coreOffsetRadius, vCarvePlane } from '@/engine/cnc/vCarveGeometry';
import { vCone, type VCone } from '@/engine/cnc/vProfile';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob, EngraveShape } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const REAL = join(REPO, 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');
const TAN15 = Math.tan(Math.PI / 12);

/** The bench's 30° / 0.2 mm engraver — j24's `inv:kz-engrave-m-30-0-2`. */
const ENGRAVER: Tool = flatEndMill(0.2, {
  name: 'Single Flute Engraving Bit 30° × 0.2 mm',
  typeText: 'Engraving',
  shape: 'engraving',
  diameter: 3.175,
  halfAngle: 15,
  angle: 30,
});

const PARAMS: CutParams = {
  rpm: 12000,
  feed: 500,
  plungeFeed: 200,
  stepDown: 0.25,
  stepOver: 0.2,
  peck: 1,
  air: false,
};

const r6 = (v: number): number => Number(v.toFixed(6));

function loadJob(file: string): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(join(REAL, file), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.job;
}

/**
 * j24's labels document with the recess program `-a` cuts added to the SAME plan. The combined
 * j24 document carries both and is refused for its later-cutter setup (#746), so this is the
 * plan-shaped stand-in for "the document that knows the floor".
 */
function spokeWrenchOnRecess(): EngraveJob {
  const labels = loadJob('j24-spoke-wrench-c.json');
  const recessJob = loadJob('j24-spoke-wrench-a.json');
  const recess = recessJob.shapes.find((shape) => shape.id === 'recess');
  if (recess === undefined) throw new Error('j24 -a has no recess shape');
  return { ...labels, shapes: [...labels.shapes, recess] };
}

/** The label regions only — the labels' own program, which the bench cuts with the `-c` file. */
function labelRegions(regions: readonly EngraveRegion[]): EngraveRegion[] {
  return regions.filter((region) => region.id.startsWith('lab-'));
}

function rectShape(over: Partial<EngraveShape> & Pick<EngraveShape, 'id'>): EngraveShape {
  return {
    kind: 'rect',
    position: { x: 25, y: 20 },
    rotation: 0,
    depth: 1,
    enabled: true,
    width: 20,
    height: 10,
    cornerRadius: 0,
    ...over,
  } as EngraveShape;
}

function rectPolygons(width: number, height: number): Polygons {
  return [
    [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ],
  ];
}

function variableRegion(depth: number, floorDepth: number | null): EngraveRegion {
  const polygons = rectPolygons(10, 4);
  const vCarve: VCarveRegion = {
    plane: polygons,
    floor: polygons,
    surface: polygons,
    planeDepth: depth,
    // The 30° engraver's tip.
    planeRadius: 0.1,
    floorInset: 0,
    surfaceOutset: 0,
    variable: true,
    ...(floorDepth === null ? {} : { floorDepth }),
  };
  return { id: 'v', text: '', depth, polygons, vCarve };
}

describe('#748 — an item on a pocket floor is planned and judged from that floor', () => {
  it('gives the 13G labels on the 4 mm recess floor no surface-merge warning, and a 0.25 mm outset', () => {
    const out = engraveRegions(tl, spokeWrenchOnRecess(), ENGRAVER);
    // Before #748 the floor was never asked for and this list carried "closer than 2.278 mm
    // (2 × the 1.139 mm surface wall offset)" for every label — 4.25 mm of cone for a 0.25 mm cut.
    const merges = out.findings.filter((finding) => finding.code === 'vcarve-surface-merge');
    expect(merges.map((finding) => `${finding.labelId ?? ''}: ${finding.message}`)).toEqual([]);

    expect(out.floors['lab-13G']).toBe(4);
    expect(out.floors['lab-16G']).toBe(4);

    const cut = out.regions.find((region) => region.id === 'lab-13G');
    expect(cut?.vCarve?.floorDepth).toBe(4);
    // (4.25 − 4) × tan 15°, not 4.25 × tan 15° = 1.139.
    expect(cut?.vCarve?.surfaceOutset).toBeCloseTo(0.25 * TAN15, 9);
    expect(cut?.vCarve?.surfaceOutset).toBeCloseTo(0.06699, 4);
  });

  it('posts the labels the same toolpath as the top-face document (the CAM reads the plane radius)', () => {
    const top = engraveRegions(tl, loadJob('j24-spoke-wrench-c.json'), ENGRAVER);
    const onFloor = engraveRegions(tl, spokeWrenchOnRecess(), ENGRAVER);
    const ir = (regions: readonly EngraveRegion[]) =>
      generateEngrave(tl, labelRegions(regions), ENGRAVER, PARAMS, Z1.rapidEstimate);
    const moves = (irNow: ReturnType<typeof ir>, id: string) =>
      (irNow.operations.find((operation) => operation.labelId === id)?.moves ?? []).map((move) => [
        move.kind,
        r6(move.x),
        r6(move.y),
        r6(move.z),
      ]);
    const topIr = ir(top.regions);
    const floorIr = ir(onFloor.regions);
    for (const id of ['lab-13G', 'lab-14G', 'lab-15G', 'lab-16G']) {
      expect(moves(floorIr, id)).toEqual(moves(topIr, id));
    }
  });

  it('starts a variable V-carve on a pocket floor at the floor, with the same depth map offset by it', () => {
    const ir = (region: EngraveRegion) =>
      generateEngrave(tl, [region], ENGRAVER, PARAMS, Z1.rapidEstimate);
    const feeds = (now: ReturnType<typeof ir>) =>
      now.operations[0]!.moves.filter((move) => move.kind === 'feed');
    // The same carve: a 1 mm cap on the blank's top face, versus the same 1 mm of material under
    // a 1 mm floor (a 2 mm item). Identical XY levels; every Z one millimetre lower.
    const flat = feeds(ir(variableRegion(1, null)));
    const pocketed = feeds(ir(variableRegion(2, 1)));
    expect(pocketed.map((move) => [r6(move.x), r6(move.y)])).toEqual(
      flat.map((move) => [r6(move.x), r6(move.y)]),
    );
    expect(pocketed.map((move) => r6(move.z))).toEqual(flat.map((move) => r6(move.z - 1)));
    // The ladder itself: 0.25 mm rungs from the floor's 1.25 mm to the 2 mm cap, not the 0.25 mm
    // to 2 mm the top-face model would cut (half of it in air above the floor).
    const rungZ = (moves: typeof flat) => [...new Set(moves.map((move) => r6(move.z)))].sort((a, b) => a - b);
    expect(rungZ(flat)).toEqual([-1, -0.75, -0.5, -0.25]);
    expect(rungZ(pocketed)).toEqual([-2, -1.75, -1.5, -1.25]);
  });

  it('plans a variable V-carve on a pocket floor at its material depth, core included', () => {
    const base = defaultEngraveJob();
    const pocket = rectShape({ id: 'pocket', depth: 1, width: 20, height: 10 });
    const v = rectShape({ id: 'v', depth: 3, width: 10, height: 4, vCarveDepth: 'variable' });
    const job: EngraveJob = {
      ...base,
      labels: [],
      toolKey: 'inv:test-engraver',
      tool: ENGRAVER,
      shapes: [pocket, v],
    };
    const out = engraveRegions(tl, job, ENGRAVER);
    expect(out.floors['v']).toBe(1);
    expect(out.floors['pocket']).toBeUndefined();
    expect(out.regions.find((region) => region.id === 'v')?.vCarve?.floorDepth).toBe(1);

    // The prediction's levels are ABSOLUTE depths below the top face: a tenth of the material cap
    // above the floor and the cap itself. Before #748 they started at 0.2 and 2 mm — at the top face.
    const levels = out.predicted
      .filter((entry) => entry.itemId === 'v')
      .map((entry) => r6(entry.depth))
      .sort((a, b) => a - b);
    expect(levels).toEqual([1.2, 3]);

    // The core the flat cutter clears is the middle of the MATERIAL cap: `(10 − 2·coreOffsetRadius
    // (cone, 2))` wide, not the 3 mm cap's narrower ring. The core still bottoms at the absolute
    // 3 mm depth.
    const cone = vCone(ENGRAVER);
    expect(cone).not.toBeNull();
    const core = out.cores.find((entry) => entry.of === 'v');
    expect(core?.depth).toBe(3);
    const xs = (core?.polygons ?? []).flat().map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(
      10 - 2 * coreOffsetRadius(cone as VCone, 3 - 1),
      2,
    );

    // The CAM reads the floor from the region: the ladder over the 2 mm of material under the
    // 1 mm floor starts at the floor (z = −1.25, the first 0.25 mm rung) and only its last pass
    // reaches the item's absolute 3 mm depth. Before #748 it started −0.25 mm below the TOP face.
    const carve = out.regions.find((region) => region.id === 'v');
    expect(carve).toBeDefined();
    const carved = generateEngrave(tl, [carve as EngraveRegion], ENGRAVER, PARAMS, Z1.rapidEstimate);
    const zs = (carved.operations.find((operation) => operation.labelId === 'v')?.moves ?? [])
      .filter((move) => move.kind === 'feed')
      .map((move) => r6(move.z));
    expect(Math.max(...zs)).toBe(-1.25);
    expect(Math.min(...zs)).toBe(-3);
  });

  it('reduces to the top-face model at floor 0, and reads a film from the floor down', () => {
    const cone: VCone = { tipRadius: 0.1, halfAngleDeg: 15, tanHalf: TAN15 };
    const top = vCarvePlane(cone, 4.25, null);
    expect(top.floor).toBe(0);
    expect(top.material).toBe(4.25);
    expect(top.surfaceOutset).toBeCloseTo(4.25 * TAN15, 12);

    const onFloor = vCarvePlane(cone, 4.25, null, 4);
    expect(onFloor.floor).toBe(4);
    expect(onFloor.material).toBeCloseTo(0.25, 12);
    expect(onFloor.planeRadius).toBeCloseTo(0.1, 12);
    expect(onFloor.surfaceOutset).toBeCloseTo(0.25 * TAN15, 12);

    // A colour boundary below the floor is measured from the floor: 5 − 4 = 1 mm of film, so the
    // plane sits at 5 mm absolute and 0.5 mm above the 5.5 mm cut floor.
    const filmed = vCarvePlane(cone, 5.5, 5, 4);
    expect(filmed.film).toBe(5);
    expect(filmed.belowPlane).toBeCloseTo(0.5, 12);
    expect(filmed.surfaceOutset).toBeCloseTo(1 * TAN15, 12);

    // A boundary the recess already cut through is no plane at all: the whole cut is second colour,
    // so the design is correct at the cut floor and the groove is the tip.
    const under = vCarvePlane(cone, 4.25, 0.2, 4);
    expect(under.film).toBe(0);
    expect(under.planeRadius).toBeCloseTo(0.1, 12);
  });
});
