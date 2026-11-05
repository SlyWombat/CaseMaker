/**
 * #966 — VALIDATES `tests/tools/figure-coverage-split.ts`'s 3-way split against a hand-built
 * synthetic solid, by hand-computed expectation, BEFORE trusting the tool on a real figure (which
 * Session F runs elsewhere — this repo holds no figure meshes).
 *
 * THE SOLID (local mm, before centring — `figureCoverageSplit` places it like any other goal):
 * a "step" — a full-height SUPPORT COLUMN (X 0–4, Y 0–8, Z 0–6) and a CANTILEVERED ARM (X 4–10,
 * Y 0–8, Z 4–6) with completely open air underneath it (nothing from X 4–10, Z 0–4) — plus two
 * small blind pockets cut into the column's own top (floor at Z 4), narrower than the house's
 * cutters in X:
 *
 *   - FEATURE A (category 1 — needs a flip): the arm's UNDERSIDE (Z 4, facing down, X 4–10). The
 *     column's top and the arm's top are one continuous flat surface — nothing else occupies this
 *     column, so there is no competing surface at the same world XY for a shared heightfield to
 *     conflate (see `figure-coverage-split.ts`'s own header on why that matters). Hand-verified:
 *     a world `nz = -1` face is 'facingAway' from TOP (never covered today); rotating it into the
 *     BOTTOM frame (`toSetupFrame`'s half turn about X: local_z = -world_z) makes it the ONLY
 *     material in that rotated column, hence 'visible' and reachable there.
 *   - FEATURE B (category 2 — reachable by nothing): a 0.6 × 2.0 mm pocket (X half-width 0.3 mm),
 *     floor at Z 4. Hand-verified via `dropcutter.ts`'s own exact formulas (see `dropCutterHeight`
 *     assertions below): every house cutter, from EITHER top or bottom, is blocked by the
 *     pocket's own rim before it reaches the floor.
 *   - FEATURE C (category 3 — reachable, not cut): a 2.0 × 2.0 mm pocket (X half-width 1.0 mm),
 *     floor at Z 4. `ball-0.5` (radius 0.25 mm) clears the rim (hand-verified) and reaches the
 *     floor; `ball-2`/`flat-3.175`/`flat-6` (radius >= 1 mm) do not. Planning with `ball-0.5`
 *     EXCLUDED from `planCutterIds` (the task's own suggested mechanism) guarantees no available
 *     cutter cuts it, while the category-2 probe (always the FULL house) still finds it reachable.
 *
 * Both pockets share one Y band (Y 3–5, half-width 1 mm) specifically so the X-direction blocking
 * distance — the only one that matters for either pocket — does not depend on Y at all (derived
 * in the comments below), which is what makes the two pockets' reachability hand-computable
 * exactly rather than merely plausible.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { figureCoverageSplit, restrictHouse, DEFAULT_HOUSE } from '../tools/figure-coverage-split';
import { dropCutterHeight, profileOf } from '@/engine/cnc/cam/model/dropcutter';
import { getToplevel } from '@/workers/geometry/ManifoldRuntime';
import type { EngraveJob } from '@/types/engraveJob';

// ───────────────────────────────────────────────────────────────────────────────────────────
// THE MESH — built through the REAL Manifold kernel (`getToplevel`/`.cube`/`.add`/`.subtract`,
// the same primitives `workers/geometry/sweep.ts`/`evaluateOp.ts` already use), not hand-wound
// triangles: a boolean union/difference of simple cuboids is guaranteed watertight and
// consistently outward-wound, which `recogniseFeatures`'s own CSG (stock minus this design mesh)
// needs — a first, hand-triangulated attempt at this same shape hit exactly that ("Not manifold"
// from the kernel on a T-junction where one face's long edge abutted two shorter neighbours).
// ───────────────────────────────────────────────────────────────────────────────────────────

const HOLE_B = { x0: 0.6, x1: 1.2, y0: 3, y1: 5 }; // 0.6 (X) x 2.0 (Y) mm, half-width-X 0.3 mm
const HOLE_C = { x0: 1.6, x1: 3.6, y0: 3, y1: 5 }; // 2.0 (X) x 2.0 (Y) mm, half-width-X 1.0 mm
const Z_FLOOR = 4;
const Z_TOP = 6;

async function buildSyntheticSolid(): Promise<{ positions: Float32Array; indices: Uint32Array; triangleCount: number }> {
  const tl = await getToplevel();
  const column = tl.Manifold.cube([4, 8, 6], false); // X[0,4], Y[0,8], Z[0,6]
  const arm = tl.Manifold.cube([6, 8, 2], false).translate([4, 0, 4]); // X[4,10], Y[0,8], Z[4,6] — the cantilever (feature A is its own underside)
  const holeB = tl.Manifold.cube([HOLE_B.x1 - HOLE_B.x0, HOLE_B.y1 - HOLE_B.y0, Z_TOP - Z_FLOOR], false).translate([HOLE_B.x0, HOLE_B.y0, Z_FLOOR]);
  const holeC = tl.Manifold.cube([HOLE_C.x1 - HOLE_C.x0, HOLE_C.y1 - HOLE_C.y0, Z_TOP - Z_FLOOR], false).translate([HOLE_C.x0, HOLE_C.y0, Z_FLOOR]);
  const solid = column.add(arm).subtract(holeB).subtract(holeC);
  const mesh = solid.getMesh();
  const positions = new Float32Array(mesh.vertProperties);
  const indices = new Uint32Array(mesh.triVerts);
  return { positions, indices, triangleCount: indices.length / 3 };
}

/** Binary STL: an 80-byte header, a uint32 triangle count, then 50 bytes/triangle (a zero normal
 * — `parseBinaryStl` never reads it — 3 vertices by INDEX, a zero attribute word). */
function toBinaryStl(mesh: { positions: Float32Array; indices: Uint32Array; triangleCount: number }): Buffer {
  const buf = Buffer.alloc(84 + mesh.triangleCount * 50);
  buf.write('synthetic 966 solid', 0, 'ascii');
  buf.writeUInt32LE(mesh.triangleCount, 80);
  let off = 84;
  for (let t = 0; t < mesh.triangleCount; t++) {
    buf.writeFloatLE(0, off); buf.writeFloatLE(0, off + 4); buf.writeFloatLE(0, off + 8);
    off += 12;
    for (let v = 0; v < 3; v++) {
      const vi = mesh.indices[t * 3 + v]! * 3;
      buf.writeFloatLE(mesh.positions[vi]!, off);
      buf.writeFloatLE(mesh.positions[vi + 1]!, off + 4);
      buf.writeFloatLE(mesh.positions[vi + 2]!, off + 8);
      off += 12;
    }
    buf.writeUInt16LE(0, off);
    off += 2;
  }
  return buf;
}

const SYNTHETIC_SOLID = await buildSyntheticSolid();
const MESH_BYTES = toBinaryStl(SYNTHETIC_SOLID);
const MESH_SHA256 = createHash('sha256').update(MESH_BYTES).digest('hex');

/** The SAME column+arm shape (no pockets — this one is only for the registration/plannable
 * check below), but 20mm in Y instead of 8: `registerSetupOrigin`'s own `MIN_EDGE_LENGTH_MM`
 * threshold is 15 mm, so THIS part's outline (a plain 10 x 20 mm rectangle in XY projection — the
 * column and the arm share one footprint) clears it on the long edge, where the 10x8 part above
 * (THE Manager's own flagged risk, confirmed empirically above) does not. */
async function buildWidePlank(widthY: number): Promise<{ positions: Float32Array; indices: Uint32Array; triangleCount: number }> {
  const tl = await getToplevel();
  const column = tl.Manifold.cube([4, widthY, 6], false);
  const arm = tl.Manifold.cube([6, widthY, 2], false).translate([4, 0, 4]);
  const solid = column.add(arm);
  const mesh = solid.getMesh();
  return { positions: new Float32Array(mesh.vertProperties), indices: new Uint32Array(mesh.triVerts), triangleCount: mesh.triVerts.length / 3 };
}

function wideSyntheticJob(widthY: number, sha256: string): EngraveJob {
  const base = syntheticJob();
  return {
    ...base,
    stock: { ...base.stock, width: widthY },
    targetObject: { ...base.targetObject, sha256, size: { x: 10, y: widthY, z: 6 } },
  } as EngraveJob;
}

function syntheticJob(): EngraveJob {
  return {
    schemaVersion: 3,
    name: 'Synthetic 966 figure',
    machineId: 'Z1',
    stock: { length: 10, width: 8, thickness: 6, material: 'hardwood' },
    labels: [],
    toolKey: '',
    minFloor: 1,
    edgeMargin: 1,
    customFonts: [],
    sacrificial: { under: null, sides: { left: null, right: null, front: null, back: null }, source: 'default' },
    breakthrough: 0.3,
    jawClearance: 1,
    shapes: [],
    workholding: {
      kind: 'vise',
      vise: { stockProud: 5.9, fixedJawThickness: 10, movingJawThickness: 10, jawLength: 20, jawStartY: -6, source: 'default', uncertainty: 0.5 },
    },
    targetObject: {
      id: 'g1',
      name: 'synthetic-966.stl',
      format: 'stl',
      sha256: MESH_SHA256,
      size: { x: 10, y: 8, z: 6 },
      position: { x: 0, y: 0, z: 0 },
      rotation: 0,
      enabled: true,
      role: 'goal',
      cutWithinReach: true,
      scale: { x: 1, y: 1, z: 1 },
    },
  } as unknown as EngraveJob;
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// HAND-COMPUTED VALIDATION of the pockets' reachability, directly against `dropcutter.ts`'s own
// functions — BEFORE trusting the tool's own categorisation on the same mesh (the task's own
// instruction: validate against hand-computed expectation first).
// ───────────────────────────────────────────────────────────────────────────────────────────

describe('#966 synthetic solid — hand-computed dropCutterHeight sanity (before trusting the tool)', () => {
  const mesh = SYNTHETIC_SOLID;

  const BALL05 = { ...DEFAULT_HOUSE.find((t) => t.id === 'ball-0.5')! };
  const BALL2 = { ...DEFAULT_HOUSE.find((t) => t.id === 'ball-2')! };
  const FLAT6 = { ...DEFAULT_HOUSE.find((t) => t.id === 'flat-6')! };

  // A point 1/3 of the way in from a pocket's own (x0, y0) corner — ALWAYS inside the floor
  // rectangle regardless of how the kernel's own `getMesh()` happened to triangulate it (the
  // floor is one flat plane either way, and `dropCutterHeight`'s facet contact only needs the
  // query point to fall inside SOME triangle covering it). Its distance to the nearest wall is
  // `min(2*(x1-x0), 2*(y1-y0)) / 3` — the GOVERNING blocking distance this file's header derives.
  function worstCaseFloorPoint(x0: number, x1: number, y0: number, y1: number): [number, number] {
    return [x0 + (x1 - x0) / 3, y0 + (y1 - y0) / 3];
  }

  it('hole B (half-width 0.3 mm): every house cutter is blocked near the rim, from the top', () => {
    const [cx, cy] = worstCaseFloorPoint(HOLE_B.x0, HOLE_B.x1, HOLE_B.y0, HOLE_B.y1);
    for (const tool of [BALL05, BALL2, FLAT6]) {
      const profile = profileOf(tool)!;
      const z = dropCutterHeight(profile, mesh, cx, cy)!;
      expect(z, `${tool.name} at hole B`).toBeGreaterThan(Z_FLOOR + 0.5); // nowhere near the floor (Z 4)
    }
  });

  it('hole C (half-width 1.0 mm): ball-0.5 reaches the floor exactly; the bigger cutters do not', () => {
    const [cx, cy] = worstCaseFloorPoint(HOLE_C.x0, HOLE_C.x1, HOLE_C.y0, HOLE_C.y1);
    const ballProfile = profileOf(BALL05)!;
    const zBall05 = dropCutterHeight(ballProfile, mesh, cx, cy)!;
    expect(zBall05).toBeCloseTo(Z_FLOOR, 3);

    for (const tool of [BALL2, FLAT6]) {
      const profile = profileOf(tool)!;
      const z = dropCutterHeight(profile, mesh, cx, cy)!;
      expect(z, `${tool.name} at hole C`).toBeGreaterThan(Z_FLOOR + 0.5);
    }
  });

  it("the arm's underside (feature A) is unreachable from a straight top-down probe at all", () => {
    // Anywhere under the arm (X 4-10), the top-down probe only ever meets the arm's own TOP
    // (Z 6) — there is nothing between Z 6 and the underside (Z 4) in this column from above.
    const profile = profileOf(FLAT6)!;
    const z = dropCutterHeight(profile, mesh, 7, 4)!;
    expect(z).toBeCloseTo(Z_TOP, 3);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// THE TOOL, end to end, against the SAME mesh — asserting the hand-computed expectations above
// actually land in the categories the tool reports.
// ───────────────────────────────────────────────────────────────────────────────────────────

describe('#966 figureCoverageSplit — the 3-way split on the synthetic solid', () => {
  it('splits feature A into category 1, feature B into category 2, and (with ball-0.5 excluded from planning) feature C into category 3', async () => {
    const job = syntheticJob();
    const result = await figureCoverageSplit({
      job,
      meshBytes: MESH_BYTES,
      meshFileName: 'synthetic-966.stl',
      label: 'synthetic966',
      underside: 'flippedTabs',
      pitchMm: 0.1,
      planCutterIds: ['flat-6', 'flat-3.175', 'ball-2'], // ball-0.5 withheld from PLANNING only
    });

    // #966 (Manager, 2026-11-04 REWORK) — THE PRIMARY CORRECTNESS BAR: covered + cat1 + cat2 +
    // cat3 sum to EXACTLY totals.totalAreaMm2 (the whole-surface triangle-area basis), because
    // every mesh triangle (or, for one straddling a category boundary, every LEAF piece of it
    // after clipping — see figure-coverage-split.ts's own "TRIANGLE-LEVEL AREA ACCOUNTING"
    // section) is assigned to EXACTLY ONE of the four buckets. Checked BOTH as a tight absolute
    // tolerance AND as the ±0.1 % relative bound the ruling itself states.
    const partitionSumMm2 =
      result.totals.coveredTodayAreaMm2 + result.category1.plannableAreaMm2 + result.category2.areaMm2 + result.category3.areaMm2;
    expect(partitionSumMm2).toBeCloseTo(result.totals.totalAreaMm2, 3);
    expect(Math.abs(partitionSumMm2 - result.totals.totalAreaMm2) / result.totals.totalAreaMm2).toBeLessThan(0.001);
    // The same identity, restated as the gap (cat1+cat2+cat3 alone) — kept from the previous pass.
    expect(result.category1.plannableAreaMm2 + result.category2.areaMm2 + result.category3.areaMm2).toBeCloseTo(result.totals.gapAreaMm2, 3);

    // #966 (Manager, 2026-11-04 REWORK, point 1) — THE WHOLE-SURFACE TRIANGLE-AREA BASIS,
    // HAND-DERIVED from the solid's own geometry (not read back from the tool). The shape is
    // Column(X0-4,Y0-8,Z0-6) ∪ Arm(X4-10,Y0-8,Z4-6) minus two blind pockets, all faces flat and
    // axis-aligned (no foreshortening anywhere), so every face's true area is exactly computable:
    //   - Column alone (4x8x6 box): 2*(4*8 + 4*6 + 8*6)                         = 208 mm²
    //   - Arm alone (6x8x2 box):    2*(6*8 + 6*2 + 8*2)                         = 152 mm²
    //   - minus the shared interface where the arm attaches (X=4, Y0-8, Z4-6),
    //     counted twice (once on each box) and so removed twice: 2 * (8*2)      = -32 mm²
    //   Union total (before pockets)                                           = 328 mm²
    // Each pocket punches a hole through the (otherwise continuous) top surface and opens an
    // equal-area floor at Z4 instead — those two swaps cancel exactly in the TOTAL area sum — and
    // adds its own 4 new vertical walls (perimeter x depth, depth = Z_TOP - Z_FLOOR = 2 mm):
    //   - hole B (0.6 x 2.0 mm): perimeter 2*(0.6+2.0) = 5.2 mm, walls 5.2*2    = 10.4 mm²
    //   - hole C (2.0 x 2.0 mm): perimeter 2*(2.0+2.0) = 8.0 mm, walls 8.0*2    = 16.0 mm²
    // Hand-derived total mesh surface area                                    = 328 + 26.4 = 354.4 mm²
    const expectedMeshTriangleAreaMm2 = 354.4;
    expect(result.totals.meshTriangleAreaMm2).toBeCloseTo(expectedMeshTriangleAreaMm2, 1);
    // underside = 'flippedTabs' here (not 'flatOnStockBottom') — the stock-bottom exclusion (point
    // 4) does NOT apply, so the whole-surface total is the mesh's own total, unreduced.
    expect(result.totals.stockBottomFaceAreaMm2).toBe(0);
    expect(result.totals.stockBottomExcluded).toBe(false);
    expect(result.totals.totalAreaMm2).toBeCloseTo(result.totals.meshTriangleAreaMm2, 6);

    // #966 (Manager, 2026-11-04, point 3) — THE COLUMN-BASED NUMBER, KEPT SEPARATE, hand-derived
    // exactly as the previous pass derived it (never mixed into totalAreaMm2 above). This
    // synthetic solid's footprint (column X0-4 union arm X4-10, both Y0-8) fills the WHOLE 10 x 8
    // mm stock rectangle with no gaps (even the two blind pockets stay "covered" — their floor is
    // still a surface, just a lower one), so `sampleGoalHeightfield`'s own grid — `planGrid`'s
    // `ceil(extent/pitch) + 1` per axis, goalHeightfield.ts:315-337 — covers every cell:
    // (ceil(10/0.1)+1) x (ceil(8/0.1)+1) = 101 x 81 cells, each 0.1 x 0.1 mm — an EXACT figure.
    const expectedNx = Math.ceil(10 / 0.1) + 1;
    const expectedNy = Math.ceil(8 / 0.1) + 1;
    const expectedColumnBasedAreaMm2 = expectedNx * expectedNy * 0.1 * 0.1;
    expect(result.totals.columnBasedAreaMm2).toBeCloseTo(expectedColumnBasedAreaMm2, 2);

    // pct is the SAME area divided by the ONE whole-surface total above — an algebraic identity,
    // checked directly against the formula rather than a magic number copied from the tool's own
    // output (the task's own instruction: hand-check the new basis, don't just mirror the code).
    const pctOf = (areaMm2: number, totalMm2: number): number => (totalMm2 > 0 ? (areaMm2 / totalMm2) * 100 : 0);
    expect(result.totals.coveredTodayPct).toBeCloseTo(pctOf(result.totals.coveredTodayAreaMm2, result.totals.totalAreaMm2), 6);
    expect(result.totals.gapPct).toBeCloseTo(pctOf(result.totals.gapAreaMm2, result.totals.totalAreaMm2), 6);
    expect(result.category2.pct).toBeCloseTo(pctOf(result.category2.areaMm2, result.totals.totalAreaMm2), 6);
    expect(result.category3.pct).toBeCloseTo(pctOf(result.category3.areaMm2, result.totals.totalAreaMm2), 6);
    expect(result.category1.geometricReachPct).toBeCloseTo(pctOf(result.category1.geometricReachAreaMm2, result.totals.totalAreaMm2), 6);
    // ... and `coveredTodayColumnBasedPct` is the SAME `coveredTodayAreaMm2` numerator divided by
    // the DIFFERENT (column-based) denominator above — the intentionally mixed-basis ratio.
    expect(result.totals.coveredTodayColumnBasedPct).toBeCloseTo(
      pctOf(result.totals.coveredTodayAreaMm2, result.totals.columnBasedAreaMm2),
      6,
    );

    // #966 (Manager, 2026-11-04 REWORK) — `coveredTodayPct` is now ALWAYS a true in-bounds
    // percentage (<= 100), because it is exactly one of the four triangle-partition shares of
    // `totalAreaMm2` (the identity asserted above) — this is the fix the rework exists for: the
    // previous pass's basis mismatch (confirmed ~275 % on this fixture) cannot recur here.
    // `coveredTodayColumnBasedPct`, the SEPARATE, intentionally mixed-basis figure kept for
    // comparison with F's own quoted numbers, carries NO such guarantee and, as before, DOES read
    // over 100 % on this fixture (the cantilevered arm and the pockets' own walls add real
    // triangle-summed surface area the column grid structurally never sees at all) — both facts
    // stated so a future change cannot silently "fix" one by conflating it with the other.
    expect(result.totals.coveredTodayPct).toBeLessThanOrEqual(100 + 1e-6);
    expect(result.totals.coveredTodayColumnBasedPct).toBeGreaterThan(100);

    // Feature A — AN UNPLANNED FINDING THAT TURNED OUT TO VALIDATE THE MANAGER's OWN CONCERN
    // (2026-11-04, see this file's header): this 10x8mm block is itself too small to clear
    // `registerSetupOrigin`'s own `MIN_EDGE_LENGTH_MM = 15` (its longest outline run is 10mm) —
    // registration REFUSES for this synthetic part exactly as it would for a real figure with no
    // usable datum. category 1 is therefore reported `geometric-only`, never silently as
    // "plannable": `plannableAreaMm2` is 0, and `geometricReachAreaMm2` (the raw bottom-orientation
    // probe, independent of registration) is what carries the arm's underside instead.
    expect(result.category1.registration.ok, JSON.stringify(result.caveats)).toBe(false);
    expect(result.category1.realistic).toBe('geometric-only');
    expect(result.category1.plannableAreaMm2).toBe(0);
    // The arm's underside (X 4-10, Y 0-8) PLUS the void's own left wall (X=4, Z 0-4, Y 0-8) — the
    // wall is shadowed by the overhanging arm from the top exactly as the underside is, and
    // becomes visible from the bottom exactly the same way (found empirically validating this
    // spec, not assumed in advance — stated here rather than silently narrowed to one face).
    const flipAreaMm2 = 6 * 8 + 4 * 8;
    expect(result.category1.geometricReachAreaMm2).toBeGreaterThan(flipAreaMm2 * 0.9);
    expect(result.category1.geometricReachAreaMm2).toBeLessThan(flipAreaMm2 * 1.1);
    // Un-plannable today, the arm's underside falls into category 3 (reachable, not cut) rather
    // than vanishing — the geometric number above is reported as an OVERLAY on it, never merged.
    expect(result.category3.areaMm2).toBeGreaterThan(result.category1.geometricReachAreaMm2 * 0.9);

    // Feature B — reachable by nothing, either orientation.
    const holeBFloorAreaMm2 = (HOLE_B.x1 - HOLE_B.x0) * (HOLE_B.y1 - HOLE_B.y0);
    expect(result.category2.areaMm2).toBeGreaterThan(holeBFloorAreaMm2 * 0.5);

    // Feature C — reachable (by ball-0.5, per the hand-computed check above), but ball-0.5 was
    // withheld from planning, so nothing cuts it: category 3 as well, attributed to SOME
    // stage/cutter from the house ball-0.5 was not allowed to be part of (or left unattributed,
    // named as such). Together with feature A, category 3 here is the union of "a real datum-less
    // part's unreachable-today flip gain" and "a genuine stage/cutter miss" — both real, both
    // honestly the same bucket until #965 gives this part a datum.
    const holeCFloorAreaMm2 = (HOLE_C.x1 - HOLE_C.x0) * (HOLE_C.y1 - HOLE_C.y0);
    expect(result.category3.areaMm2).toBeGreaterThan(result.category1.geometricReachAreaMm2 + holeCFloorAreaMm2 * 0.5);

    // #966 (Manager, 2026-11-04) — the bounding-box attribution caveat is in the OUTPUT itself,
    // not only a source comment, so a caller reading the JSON (never the tool's own file) still
    // sees it stated plainly.
    expect(result.category3.attributionCaveat).toMatch(/bounding-box/i);
    expect(result.category3.attributionCaveat).toMatch(/NOT proof/);
  }, 120_000);

  it('the OTHER outcome: a part long enough to carry an edge datum DOES register, and category 1 is plannable', async () => {
    const widthY = 20; // clears registerSetupOrigin's MIN_EDGE_LENGTH_MM = 15
    const mesh = await buildWidePlank(widthY);
    const bytes = toBinaryStl(mesh);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const job = wideSyntheticJob(widthY, sha256);

    const result = await figureCoverageSplit({
      job,
      meshBytes: bytes,
      meshFileName: 'synthetic-966-wide.stl',
      label: 'synthetic966wide',
      underside: 'flippedTabs',
      pitchMm: 0.2,
    });

    expect(result.category1.registration.ok, JSON.stringify(result.caveats)).toBe(true);
    expect(result.category1.realistic).toBe('plannable');
    const flipAreaMm2 = 6 * widthY + 4 * widthY; // arm underside + the void's own left wall
    expect(result.category1.plannableAreaMm2).toBeGreaterThan(flipAreaMm2 * 0.9);
    expect(result.category1.plannableAreaMm2).toBeLessThan(flipAreaMm2 * 1.1);
    // Plannable and geometric LARGELY agree once a real plan actually exists — within a few
    // percent, not exactly: the finer leaf-level clipping this rework adds (see
    // figure-coverage-split.ts's own "TRIANGLE-LEVEL AREA ACCOUNTING" section) now resolves a
    // real, small sliver near the reach boundary where the ACTUAL posted program's engagement
    // (a cutter's own stepover/clearance) misses geometric reach by a hair that a single
    // whole-triangle sample previously averaged away. A tight absolute tolerance here would be
    // re-fitting to that artifact, not asserting a real invariant.
    expect(Math.abs(result.category1.plannableAreaMm2 - result.category1.geometricReachAreaMm2) / result.category1.geometricReachAreaMm2).toBeLessThan(
      0.05,
    );

    // #966 (Manager, 2026-11-04 REWORK, point 1/2) — THE PRIMARY CORRECTNESS BAR, on this SECOND,
    // differently sized/pitched/registered fixture too.
    const partitionSumMm2 =
      result.totals.coveredTodayAreaMm2 + result.category1.plannableAreaMm2 + result.category2.areaMm2 + result.category3.areaMm2;
    expect(partitionSumMm2).toBeCloseTo(result.totals.totalAreaMm2, 3);
    expect(Math.abs(partitionSumMm2 - result.totals.totalAreaMm2) / result.totals.totalAreaMm2).toBeLessThan(0.001);

    // THE WHOLE-SURFACE TRIANGLE-AREA BASIS, hand-derived exactly as the first test's comment
    // derives it, for THIS plank's own box dimensions (no pockets here):
    //   - Column alone (4 x widthY x 6 box): 2*(4*widthY + 4*6 + widthY*6)
    //   - Arm alone (6 x widthY x 2 box):     2*(6*widthY + 6*2 + widthY*2)
    //   - minus the shared interface (X=4, Y0-widthY, Z4-6), counted twice: 2*(widthY*2)
    const columnAloneMm2 = 2 * (4 * widthY + 4 * 6 + widthY * 6);
    const armAloneMm2 = 2 * (6 * widthY + 6 * 2 + widthY * 2);
    const sharedInterfaceMm2 = 2 * (widthY * 2);
    const expectedMeshTriangleAreaMm2 = columnAloneMm2 + armAloneMm2 - sharedInterfaceMm2;
    expect(result.totals.meshTriangleAreaMm2).toBeCloseTo(expectedMeshTriangleAreaMm2, 1);
    expect(result.totals.stockBottomFaceAreaMm2).toBe(0);
    expect(result.totals.stockBottomExcluded).toBe(false);
    expect(result.totals.totalAreaMm2).toBeCloseTo(result.totals.meshTriangleAreaMm2, 6);

    // #966 (Manager, 2026-11-04, point 3) — the SEPARATE column-based number on this SECOND,
    // differently sized/pitched fixture: this part's own footprint (10 x widthY mm) also fills
    // its whole stock rectangle with no gaps, at pitchMm = 0.2 this time — (ceil(10/0.2)+1) x
    // (ceil(widthY/0.2)+1) cells, each 0.2 x 0.2 mm, hand-derived exactly as the first test does.
    const expectedNx = Math.ceil(10 / 0.2) + 1;
    const expectedNy = Math.ceil(widthY / 0.2) + 1;
    const expectedColumnBasedAreaMm2 = expectedNx * expectedNy * 0.2 * 0.2;
    expect(result.totals.columnBasedAreaMm2).toBeCloseTo(expectedColumnBasedAreaMm2, 1);
    // category1.plannablePct is the SAME area divided by the ONE whole-surface total — checked as
    // a formula, not a number copied from the tool's own run.
    expect(result.category1.plannablePct).toBeCloseTo((result.category1.plannableAreaMm2 / result.totals.totalAreaMm2) * 100, 6);
  }, 120_000);

  it(
    "#966 (Manager, 2026-11-04, point 4) — underside = 'flatOnStockBottom' excludes the column's own bottom face, named and printed, never folded into a category",
    async () => {
      const job = syntheticJob();
      const result = await figureCoverageSplit({
        job,
        meshBytes: MESH_BYTES,
        meshFileName: 'synthetic-966.stl',
        label: 'synthetic966-stockbottom',
        underside: 'flatOnStockBottom',
        pitchMm: 0.1,
        planCutterIds: ['flat-6', 'flat-3.175', 'ball-2'],
      });

      // #898/point 4 — the column's own bottom face (X0-4, Y0-8; the arm never reaches down to
      // Z0 — it is suspended from Z4 up — so it contributes nothing to this face) lies EXACTLY in
      // the stock's bottom plane under this underside choice, and is excluded — printed as its
      // own figure, never folded into a category or dropped.
      const expectedStockBottomFaceAreaMm2 = 4 * 8;
      expect(result.totals.stockBottomExcluded).toBe(true);
      expect(result.totals.stockBottomFaceAreaMm2).toBeCloseTo(expectedStockBottomFaceAreaMm2, 1);

      // The mesh's own full area is unchanged from the first test above (same mesh, 354.4 mm²,
      // hand-derived there) — only the CLASSIFIABLE total (`totalAreaMm2`) is reduced, by EXACTLY
      // the exclusion above.
      expect(result.totals.meshTriangleAreaMm2).toBeCloseTo(354.4, 1);
      expect(result.totals.totalAreaMm2).toBeCloseTo(result.totals.meshTriangleAreaMm2 - result.totals.stockBottomFaceAreaMm2, 1);

      // The primary identity still holds on the REDUCED total — the excluded face sits in
      // NEITHER side of it (point 2 of the ruling, re-asserted on this exclusion run too).
      const partitionSumMm2 =
        result.totals.coveredTodayAreaMm2 + result.category1.plannableAreaMm2 + result.category2.areaMm2 + result.category3.areaMm2;
      expect(partitionSumMm2).toBeCloseTo(result.totals.totalAreaMm2, 3);
      expect(Math.abs(partitionSumMm2 - result.totals.totalAreaMm2) / result.totals.totalAreaMm2).toBeLessThan(0.001);

      // #898's own rule (setups.ts) — flatOnStockBottom never offers the bottom as a flip
      // candidate at all, so no second setup is even proposed; category 1 is 'geometric-only' for
      // a DIFFERENT reason than the first test's registration refusal above: there is no
      // registration FAILURE here (`registerSetupOrigin` is never even called for a single-setup
      // plan) — `buildSetupSpecs` simply never proposed a second setup to register.
      expect(result.category1.registration.ok, JSON.stringify(result.caveats)).toBe(true);
      expect(result.category1.realistic).toBe('geometric-only');
      expect(result.category1.plannableAreaMm2).toBe(0);
    },
    120_000,
  );

  it('restrictHouse filters the planning house by id, leaving the probe house (caller-supplied) untouched', () => {
    const restricted = restrictHouse(DEFAULT_HOUSE, ['flat-6', 'ball-2']);
    expect(restricted.map((t) => t.id)).toEqual(['flat-6', 'ball-2']);
    expect(restrictHouse(DEFAULT_HOUSE, null)).toHaveLength(DEFAULT_HOUSE.length);
  });

  it('refuses a mesh whose sha256 does not match the job (never silently plans the wrong file)', async () => {
    const job = syntheticJob();
    (job.targetObject as { sha256: string }).sha256 = '0'.repeat(64);
    await expect(
      figureCoverageSplit({ job, meshBytes: MESH_BYTES, meshFileName: 'synthetic-966.stl', label: 'synthetic966' }),
    ).rejects.toThrow(/sha256/);
  });
});
