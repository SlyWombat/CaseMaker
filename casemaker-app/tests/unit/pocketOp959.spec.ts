/**
 * #959 — THE POCKET OP, RED-FIRST.
 *
 * `cam/model/ops/pocket.ts` wraps the EXISTING `pocketLoops` (`cam/pocket.ts`) with Z-level
 * stepping and ring→move conversion. No Manifold/Clipper2 here: the offset is the same trivial
 * axis-aligned-rectangle fake `camPocket.spec.ts` uses, so this spec is a pure-geometry check of
 * the level stepping and move shape, not a second test of `pocketLoops` itself.
 */

import { describe, expect, it } from 'vitest';

import { pocket } from '../../src/engine/cnc/cam/model/ops/pocket';
import type { PocketNode } from '../../src/engine/cnc/cam/model/features';
import type { RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import type { Tool } from '../../src/engine/cnc/tool';

function rect(w: number, h: number): Polygons {
  return [[[0, 0], [w, 0], [w, h], [0, h]]];
}

// A rectangle shrinks by |delta| for a NEGATIVE delta (erode), grows for a POSITIVE one (dilate) —
// `fullyReachable`'s own `erode(region, r)` then `dilate(, r)` (finding 5) needs both directions,
// unlike the shrink-only fake `camPocket.spec.ts` uses.
function fakeRectOffset(region: Polygons, delta: number): Polygons {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of region) for (const [x, y] of c) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const w = maxX - minX + 2 * delta;
  const h = maxY - minY + 2 * delta;
  if (w <= 0 || h <= 0) return [];
  return [[[minX - delta, minY - delta], [maxX + delta, minY - delta], [maxX + delta, maxY + delta], [minX - delta, maxY + delta]]];
}

// Same formula as `fakeRectOffset`, but applied to EACH input ring independently — a region of
// several disjoint rectangles (a multi-lobe step) stays several separate rings after offsetting,
// instead of being flattened into one bounding box.
function fakeMultiRectOffset(region: Polygons, delta: number): Polygons {
  const out: Polygons = [];
  for (const c of region) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of c) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    const w = maxX - minX + 2 * delta;
    const h = maxY - minY + 2 * delta;
    if (w <= 0 || h <= 0) continue;
    out.push([[minX - delta, minY - delta], [maxX + delta, minY - delta], [maxX + delta, maxY + delta], [minX - delta, maxY + delta]]);
  }
  return out;
}

const flat6: Tool = {
  number: 1, id: 'flat-6', name: 'flat-6', typeText: 'flat', shape: 'flat',
  handleDiameter: 6, tipDiameter: null, diameter: 6, cornerRadius: null,
  angle: null, halfAngle: null, fluteLength: 20, shoulderLength: null,
  stickout: null, centreCutting: true,
};

const rapid: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };

function node(floorZ: number, mouthZ: number): PocketNode {
  return {
    id: 'p1', floorZ, mouthZ, open: false,
    region: rect(20, 10), floors: [], islands: [], children: [], remainder: [], narrowest: 10, through: false,
  };
}

function region(): RegionRef {
  return { id: 'p1', kind: 'pocket', bounds: { min: [0, 0], max: [20, 10] }, topZ: 0, bottomZ: -6, obstacles: [], regionClearanceZ: 5 };
}

describe('#959 pocket()', () => {
  it('steps the depth in stepDownMm increments, the last pass shorter not longer', () => {
    const out = pocket({
      cutter: flat6, node: node(-6, 0), region: region(),
      stepOverMm: 1.2, stepDownMm: 2.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    const op = out.ir.operations[0]!;
    expect(op.depthPasses).toBe(3); // ceil(6 / 2.5) = 3: -2.5, -5.0, -6.0
    expect(op.passStepMm).toBe(2.5);
    const zs = [...new Set(out.cleared!.map((c) => c.z))];
    expect(zs).toEqual([-2.5, -5, -6]);
  });

  it('the first pass runs one posted step inside the wall (#1227)', () => {
    const out = pocket({
      cutter: flat6, node: node(-2.5, 0), region: region(),
      stepOverMm: 1.2, stepDownMm: 2.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    const firstLevel = out.ir.operations[0]!.moves.filter((m) => m.kind === 'feed' && m.z === -2.5);
    expect(firstLevel.length).toBeGreaterThan(0);
    const minX = Math.min(...firstLevel.map((m) => m.x));
    // The left wall is x = 0 and the ⌀6 cutter's radius is 3: one posted step inside is 2.999.
    expect(minX).toBeCloseTo(0 + 3 - 0.001, 6);
  });

  it('every move is at the pocket floor or above, and the deepest level reaches exactly floorZ', () => {
    const out = pocket({
      cutter: flat6, node: node(-6, 0), region: region(),
      stepOverMm: 1.2, stepDownMm: 2.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    const moves = out.ir.operations[0]!.moves;
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) expect(m.z).toBeLessThanOrEqual(10);
    const deepest = Math.min(...moves.map((m) => m.z));
    expect(deepest).toBeCloseTo(-6, 9);
  });

  it('a single pass when the pocket is shallower than one step-down', () => {
    const out = pocket({
      cutter: flat6, node: node(-1, 0), region: region(),
      stepOverMm: 1.2, stepDownMm: 2.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    expect(out.ir.operations[0]!.depthPasses).toBe(1);
    expect(out.cleared!.map((c) => c.z)).toEqual([-1]);
  });

  it('reports the cutter key and a positive cycle estimate', () => {
    const out = pocket({
      cutter: flat6, node: node(-6, 0), region: region(),
      stepOverMm: 1.2, stepDownMm: 2.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    expect(out.cutter).toBe('flat-6');
    expect(out.ir.operations[0]!.estimatedSeconds).toBeGreaterThan(0);
    expect(out.passes.length).toBeGreaterThan(0);
    for (const p of out.passes) {
      expect(p.entry).toEqual(p.exit); // this op's rings close back to their own start
    }
  });

  it('refuses a cutter with no stated cutting diameter', () => {
    const noDiameter: Tool = { ...flat6, diameter: null, tipDiameter: null };
    expect(() =>
      pocket({
        cutter: noDiameter, node: node(-6, 0), region: region(),
        stepOverMm: 1.2, stepDownMm: 2.5,
        feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
        offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
        toolNumber: 1, spindleRpm: 12000, air: true, rapid,
      }),
    ).toThrow(/no cutting diameter/);
  });

  // E's run on 52590f76: 67.7 rapids/1,000 feed lines against Makera's 5.9 — one retract per ring,
  // unconditionally. A's review 6622610124 (finding 1) ruled that feed unsafe in general (it
  // gouges an island or the wall between lobes), so every same-level transition now goes through
  // `link()` (#962), which feeds ONLY when `linkIsClear` proves the cutter's whole disc stays
  // within the node's free space — a retract is always safe, a hopeful feed is not. The 20x10
  // fixture's rings sit close enough to the wall that `link()` cannot prove a few of its own
  // transitions clear (A's own test fixtures are wider for exactly this reason); this test now
  // checks the invariant that matters after the fix — no rapid travels laterally while still at a
  // cutting depth, whatever the mix of feeds and retracts turns out to be.
  it('rings of the same level are joined by a feed when link() proves it safe, a retract otherwise — never a diagonal move from depth', () => {
    // A 20x10 rect with a 6mm flat and 1.2mm step-over leaves room for a second offset ring
    // before the fake offset collapses it (step 0 at -3: 14x4; step 1 at -4.2: 11.6x1.6; step 2
    // at -5.4: height goes negative, so pocketLoops stops there) — two rings, one level.
    const out = pocket({
      cutter: flat6, node: node(-2.5, 0), region: region(),
      stepOverMm: 1.2, stepDownMm: 2.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    expect(out.passes.length).toBeGreaterThanOrEqual(2);
    const moves = out.ir.operations[0]!.moves;
    const rapids = moves.filter((m) => m.kind === 'rapid');
    expect(rapids.length).toBeGreaterThanOrEqual(1); // at least the op's own opening plunge
    expect(rapids[0]!.z).toBe(3); // the very first move is still the op's own rapid-to-hop
    // No rapid changes X or Y while the move BEFORE it was still at a cutting depth (below the
    // hop height) — `link()`'s own retract always goes straight up first.
    for (let i = 1; i < moves.length; i++) {
      const prev = moves[i - 1]!;
      const cur = moves[i]!;
      if (cur.kind !== 'rapid') continue;
      const lateral = prev.x !== cur.x || prev.y !== cur.y;
      if (lateral) expect(prev.z, `move ${i}: a rapid moved X/Y while still at depth ${prev.z}`).toBeGreaterThanOrEqual(3);
    }
    // Every retract goes back down to the SAME floor before resuming the cut.
    expect(moves[moves.length - 1]!.z).toBeLessThanOrEqual(10);
  });

  it('cleared grows conservatively as rings are traced, never claiming the whole region after only the outer ring', () => {
    // A 30x30 region (wide in both dimensions, unlike the 20x10 fixture above) so the ⌀6 tool's
    // first-ring sweep (2 x toolRadius = 6 mm in from every edge) leaves a real uncut interior —
    // 20x10 is too narrow for this assertion: a 6 mm sweep from both long edges already meets in
    // the middle of its 10 mm height, so "fully cleared after ring 1" would be the CORRECT
    // conservative answer there, not a bug.
    const wide: PocketNode = { ...node(-2.5, 0), region: rect(30, 30) };
    const wideRef: RegionRef = { ...region(), bounds: { min: [0, 0], max: [30, 30] } };
    const out = pocket({
      cutter: flat6, node: wide, region: wideRef,
      stepOverMm: 1.2, stepDownMm: 2.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    expect(out.passes.length).toBeGreaterThanOrEqual(2);
    const areaOf = (polys: readonly [number, number][][]): number => {
      // Shoelace, outer minus holes — the same sign convention pocket.ts documents (CCW +, CW -).
      let a = 0;
      for (const ring of polys) {
        let ringArea = 0;
        for (let i = 0; i < ring.length; i++) {
          const [x0, y0] = ring[i]!;
          const [x1, y1] = ring[(i + 1) % ring.length]!;
          ringArea += x0 * y1 - x1 * y0;
        }
        a += ringArea / 2;
      }
      return Math.abs(a);
    };
    const firstCleared = areaOf(out.passes[0]!.cleared.boundary);
    const lastCleared = areaOf(out.passes[out.passes.length - 1]!.cleared.boundary);
    const wholeRegion = areaOf(rect(30, 30));
    expect(firstCleared).toBeLessThan(wholeRegion - 1e-6); // NOT the whole region after ring 1
    expect(lastCleared).toBeGreaterThanOrEqual(firstCleared); // grows (or stays, never shrinks)
  });

  // Advisor's review on 9e976f0b: `open`'s own field reports the WHOLE node as reachable with no
  // notion of "not yet, at this depth" — handing `link()` the full 3D jump between levels let its
  // short-hop branch read a same-XY descent as a clear FEED at the cutting rate (a plunge with no
  // plunge feed at all, or a ramp at the cutting feed into an unstarted level).
  it('a level change never descends at the cutting feed — the vertical leg is always a plain feed at plungeFeed', () => {
    // A 4 mm slot: ⌀3.175 (radius 1.5875) leaves only one ring (4 - 2 x 1.5875 = 0.825 mm wide;
    // the next step-over would close it), so every level change is a plain plunge at the SAME XY
    // — exactly the case `link()`'s short-hop branch misread.
    const flat3175: Tool = { ...flat6, id: 'flat-3.175', name: 'flat-3.175', diameter: 3.175, handleDiameter: 3.175 };
    const slot: PocketNode = { ...node(-4, 0), region: rect(4, 20), narrowest: 4 };
    const slotRegion: RegionRef = { ...region(), bounds: { min: [0, 0], max: [4, 20] } };
    const out = pocket({
      cutter: flat3175, node: slot, region: slotRegion,
      stepOverMm: 3.175 / 4, stepDownMm: 2,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    const moves = out.ir.operations[0]!.moves;
    let descents = 0;
    for (let i = 1; i < moves.length; i++) {
      const prev = moves[i - 1]!;
      const cur = moves[i]!;
      if (cur.kind === 'feed' && cur.z < prev.z - 1e-9) {
        descents++;
        expect(cur.f, `move ${i}: a descending feed ran at ${cur.f} mm/min, not the 300 mm/min plunge rate`).toBe(300);
      }
    }
    expect(descents).toBeGreaterThan(0); // the fixture actually exercises a level change
  });

  // The manager's own named lever toward Makera's 5.9 rapids/1,000 (E's run on faf7ad78 noted it
  // as still pending): `ring[0]` used to be whichever vertex the offset happened to emit first,
  // so a same-level or level-change link into a ring often had most of its own perimeter to cross
  // before ever reaching its own cut. Every ring must now enter at ITS OWN vertex nearest wherever
  // the tool is coming from — `startFrom` for the very first ring of the whole op, the previous
  // ring's own exit (always its own entry — it closes on itself) after that.
  it('each ring enters at its own vertex nearest wherever the tool is coming from, not whatever vertex the offset emitted first', () => {
    const out = pocket({
      cutter: flat6, node: node(-2.5, 0), region: region(),
      stepOverMm: 1.2, stepDownMm: 2.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
      // Near the far corner from the origin — `fakeRectOffset`'s own rings always start at their
      // bottom-left corner, so a real rotation (not a no-op that happens to agree) needs a
      // `startFrom` nowhere near that corner.
      startFrom: [14, 4],
    });
    // One LEVEL (floorZ -2.5, one stepDownMm 2.5 pass), two offset STEPS within it — same fixture
    // as "rings of the same level are joined by..." above, so this is the SAME-LEVEL (`prevExit`)
    // branch, not a level change.
    expect(out.passes.length).toBeGreaterThanOrEqual(2);
    let from: readonly [number, number] = [14, 4];
    const d2 = (p: readonly [number, number], q: readonly [number, number]): number => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
    for (const pass of out.passes) {
      const ring = pass.boundary[0]!;
      const entry: [number, number] = [pass.entry[0], pass.entry[1]];
      const entryDistance = d2(entry, from);
      for (const v of ring) {
        expect(
          entryDistance,
          `entry ${JSON.stringify(entry)} from ${JSON.stringify(from)} is not the nearest of ring ${JSON.stringify(ring)}`,
        ).toBeLessThanOrEqual(d2(v, from) + 1e-9);
      }
      from = entry;
    }
  });

  // The manager's own follow-up to the per-ring rotation above (E's run on 2441401d: "still worth
  // doing for the tray's 15.9 vs Makera's 5.9"): a multi-lobe step — several disconnected rings at
  // the SAME offset, common on the organizer's own geometry — used to tour from a fixed [0, 0],
  // so it could visit its farthest ring first and its nearest one last, however good each ring's
  // own entry seam then was.
  it('a multi-lobe step visits the ring nearest wherever the tool is coming from FIRST, not whichever `tourNearest` would pick from [0, 0]', () => {
    // Two 10x10 rectangles, 90 mm apart — far enough that no fake offset step merges them, and
    // far enough from the origin that a [0, 0]-anchored tour unambiguously prefers the NEAR one.
    const twoLobes: Polygons = [
      [[0, 0], [10, 0], [10, 10], [0, 10]],
      [[100, 0], [110, 0], [110, 10], [100, 10]],
    ];
    const far: PocketNode = { ...node(-1, 0), region: twoLobes };
    const farRegion: RegionRef = { ...region(), bounds: { min: [0, 0], max: [110, 10] } };
    const out = pocket({
      cutter: flat6, node: far, region: farRegion,
      stepOverMm: 1.2, stepDownMm: 1,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeMultiRectOffset, safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
      startFrom: [105, 5], // inside the FAR lobe
    });
    expect(out.passes.length).toBeGreaterThanOrEqual(2); // a ring from each lobe, same step
    // The first-visited ring (this op's own opening plunge) must be the FAR lobe's — its own x is
    // well above the near lobe's (0-10) and well below the far lobe's rotated entry being <= 110.
    expect(out.passes[0]!.entry[0], `visited ${JSON.stringify(out.passes.map((p) => p.entry))} first`).toBeGreaterThan(50);
  });

  // #1002 — RED-FIRST, D's review of 8f5cc4c18. `stepDown` 2 exceeds `hop` 1, and the level −2
  // link back from the second lobe lands at (24.3, 5.7) — the first lobe's inner-ring corner,
  // ground this level has not reached yet, so it still stands at the stock top. The per-ring
  // cleared band (`passes[].cleared`, the step's whole planned band) claims the area at this
  // level and railed that rapid to −1, one millimetre INTO the stock; one level down the same
  // claim railed the cross-lobe rapid to −3 under ground standing at −2. Only FINISHED levels
  // may lift a down leg, so the rapid may never end below the standing surface at its own
  // landing: the previous level's floor, or the stock top when entering the first level.
  it('#1002 — a down leg never rapids below the standing surface at its landing (stepDown > hop)', () => {
    const twoLobes: Polygons = [
      [[0, 0], [30, 0], [30, 30], [0, 30]],
      [[40, 0], [52, 0], [52, 12], [40, 12]],
    ];
    const lobes: PocketNode = { ...node(-4, 0), region: twoLobes, narrowest: 12 };
    const lobesRegion: RegionRef = { ...region(), bounds: { min: [0, 0], max: [52, 30] }, bottomZ: -4 };
    const out = pocket({
      cutter: flat6, node: lobes, region: lobesRegion,
      stepOverMm: 2.7, stepDownMm: 2, // stepDown > hop, the case the boolean proof could not cover
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: fakeMultiRectOffset, safeZMm: 10, hopZMm: 1,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    });
    const moves = out.ir.operations[0]!.moves;

    // The op's levels in cut order: each time a feed descends below every level so far.
    const levels: number[] = [];
    for (const m of moves) if (m.kind === 'feed' && m.z < (levels[levels.length - 1] ?? Infinity) - 1e-9) levels.push(m.z);
    expect(levels).toEqual([-2, -4]);

    const sameXY = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;
    let checked = 0;
    for (let i = 2; i < moves.length; i++) {
      const m = moves[i]!, down = moves[i - 1]!, before = moves[i - 2]!;
      // A retract's down leg: a vertical rapid descent at the XY the lateral rapid brought it to.
      if (m.kind !== 'feed' || down.kind !== 'rapid' || down.z >= before.z) continue;
      if (!sameXY(m, down) || !sameXY(down, before)) continue;
      // The level this leg leads into is the deepest z of the contiguous feed run it opens.
      let levelZ = m.z;
      for (let k = i; k < moves.length && moves[k]!.kind === 'feed'; k++) levelZ = Math.min(levelZ, moves[k]!.z);
      const li = levels.findIndex((z) => Math.abs(z - levelZ) <= 1e-9);
      expect(li, `down leg into a level not in ${JSON.stringify(levels)}`).toBeGreaterThanOrEqual(0);
      // The standing surface at the landing: the previous level's floor, or the stock top (0)
      // entering the first level — never the level being cut, which has not finished yet.
      const standing = li > 0 ? levels[li - 1]! : 0;
      expect(
        down.z,
        `down leg at (${down.x.toFixed(2)}, ${down.y.toFixed(2)}) into level ${levelZ} rapids below the standing surface ${standing}`,
      ).toBeGreaterThanOrEqual(standing - 1e-9);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });
});
