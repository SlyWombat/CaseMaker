/**
 * #962 — RED-FIRST, THE ORGANIZER'S 77 mm GROOVE.
 *
 * E's render set found the organizer posting a 77.2 mm lateral FEED at a constant chamfer depth,
 * `G1` from (26.465, 88.947, −1.300) to (81.053, 143.535, −1.300) — dx = dy = 54.588 mm. It is not
 * a `link()` defect: `link()` never emits a lateral feed (its horizontal leg is always a rapid;
 * only its vertical legs feed). It is `findRims`' own edge-chaining (`features/rims.ts`'s `chain`)
 * leaving a complex rim's loop OPEN — a branch point in the sharp floor|wall graph took the wrong
 * one of several unused edges — and `cam/model/ops/chamfer.ts`'s `closedRing()` not knowing the
 * difference: it closes ANY polyline whose own first and last point do not already coincide with
 * one more straight point, bridging whatever lies between them. Confirmed on the real organizer
 * mesh (`_diagRimDump962.spec.ts`, not committed): rim `rim-5`'s own closing segment is
 * `(-3.911, 58.500) -> (-58.500, 3.911)`, length 77.20 mm, dx = dy = 54.59 — the same move, same
 * numbers, in the recognition frame.
 *
 * This fixture reproduces it directly: a POCKET rim (the real rim-5 is `of: "pocket-16"`, not the
 * contour) whose polyline is intentionally OPEN by 77.2 mm (`chain()`'s own real gap), fed through
 * `planCurvedForTree`'s rim loop exactly as the organizer's rim would be. RED (before the fix): the
 * posted chamfer program contains that 77.2 mm lateral feed at depth. GREEN (after): the rim is
 * refused with a stated note, no moves posted for it, and the SET of posted chamfer feeds move no
 * more than a few mm laterally, the real bevel's own width.
 *
 * THE GUARD IS SCOPED TO POCKET RIMS. A pocket encloses a cavity, so its rim must close; the
 * CONTOUR (the outer silhouette) may legitimately run open to the stock's own edge — confirmed on
 * `buildRandomPart`'s own fixture (`#962 property`, below): EVERY synthetic kind and seed carries
 * a genuine 8 mm open contour rim, the "shoulder open to the +X edge" cut, (20, −4) → (20, 4). A
 * contour rim is left to `closedRing()`'s existing bridge either way: closing a short, already-
 * on-its-own-line segment like that one retraces real geometry, it does not cross open ground.
 */

import { describe, expect, it } from 'vitest';
import { loadStepMesh } from './helpers/trayAcceptance';

import { tl } from './helpers/manifoldExec';
import { makeClipperOffset } from '../../src/engine/cnc/cam/engraveJob';
import { planCurvedForTree } from '../../src/engine/cnc/cam/model/plan';
import type { FeatureTree, PocketNode, Rim } from '../../src/engine/cnc/cam/model/features';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';
import { buildRandomPart, type PartKind } from '../tools/randomParts';
import { recogniseFeatures } from '../../src/engine/cnc/cam/model/features';
import { planModelCam, type ModelPlanInput } from '../../src/engine/cnc/cam/model/plan';
import type { CamMove } from '../../src/engine/cnc/cam/ir';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const flat: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const ball: Tool = { ...flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6' }), shape: 'ball', typeText: 'Ball Nose' };
const vbit: Tool = flatEndMill(3.175, { number: 3, id: 'v90', name: '90 chamfer', shape: 'chamfer', typeText: 'Chamfer', angle: 90, halfAngle: 45, tipDiameter: 0.1 });

// The exact proven exposure fixture (`planZRebase959.spec.ts`'s `rampAtStockTop`): a ramp from the
// rim's own Z down to a low floor, margin past the footprint held at the SAME low floor rather
// than continuing the slope — the fix that fixture itself needed to read as genuinely exposed.
const STOCK_TOP = 10;
const X0 = 2, X1 = 42, Y0 = -12, Y1 = 12;
const Z_LOW = -10;

function rampTree(rims: Rim[]): { tree: FeatureTree; geometry: { triangles: { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } } } {
  const MX0 = -10, MX1 = 50, MY0 = -20, MY1 = 20;
  const footprint: Polygons = [[[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]]];
  const geometry = {
    triangles: {
      positions: Float32Array.from([
        MX0, MY0, Z_LOW, MX1, MY0, Z_LOW, MX1, MY1, Z_LOW,
        MX0, MY0, Z_LOW, MX1, MY1, Z_LOW, MX0, MY1, Z_LOW,
      ]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
      triangleCount: 2,
      bbox: { min: [MX0, MY0, Z_LOW] as [number, number, number], max: [MX1, MY1, STOCK_TOP] as [number, number, number] },
    },
  };
  const tree: FeatureTree = {
    frame: { up: [0, 0, 1], stockTop: STOCK_TOP, partTop: STOCK_TOP, partBottom: Z_LOW },
    levels: [Z_LOW],
    top: { z: STOCK_TOP, floors: [], area: 0 },
    contour: { outline: footprint, area: (X1 - X0) * (Y1 - Y0), zTo: Z_LOW, frees: true, shoulders: [] },
    pockets: [],
    rims,
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: (X1 - X0) * (Y1 - Y0), remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
  return { tree, geometry };
}

// The organizer's own rim-5 rectangle corners, plus the EXACT gap its own closing segment left:
// dx = dy = 54.588 mm, 77.20 mm direct. Both rims below share these same four real corners
// (a valid rim on the ramp's own footprint, proven exposed by `rampAtStockTop`'s own fixture) —
// they differ only in whether the polyline's own last point returns home or strays by that gap.
const CORNERS: [number, number][] = [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]];
const GAP_XY = 54.588;

describe('#962 — an open rim loop is refused, never bridged with a straight phantom cut', () => {
  it('a rim 77.2 mm open (the organizer\'s own gap) posts no chamfer moves, and is named in the notes', () => {
    const openRim: Rim = {
      id: 'rim-5',
      // The organizer's own failure mode: the chain never returns to its own start, so the last
      // point is NOT a closing duplicate — it is 77.2 mm away, dx = dy, same as the real gap.
      polyline: [...CORNERS, [X0 + GAP_XY, Y0 + GAP_XY]],
      z: STOCK_TOP,
      // The real rim-5 belongs to a POCKET ("pocket-16"), not the contour — the guard is scoped
      // to pocket rims exactly because a pocket encloses a cavity and must close; a contour may
      // legitimately run open to the stock edge (the property test below, on `buildRandomPart`'s
      // own "shoulder open to +X" rim).
      of: 'pocket-16',
      kind: 'sharp',
    };
    const first = openRim.polyline[0]!;
    const last = openRim.polyline[openRim.polyline.length - 1]!;
    const openGap = Math.hypot(first[0] - last[0], first[1] - last[1]);
    expect(openGap, 'the fixture must actually be open, by the organizer\'s own measured amount').toBeCloseTo(77.2, 1);

    const { tree, geometry } = rampTree([openRim]);
    const result = planCurvedForTree(tree, {
      geometry, offset: makeClipperOffset(tl), flat, ball, vbit,
      stepDownMm: 1.5, bandMm: 0.3, feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
      rapid: RAPID, spindleRpm: 12000, air: true, safeZMm: 5, hopZMm: 1,
      edgeBreak: { legMm: 0.5 }, toolNumberFor: (t) => t.number ?? 1,
    });

    const chamferOps = result.ops.filter((op) => op.kind === 'chamfer');
    expect(chamferOps, 'an open rim must post no chamfer op at all').toHaveLength(0);
    expect(result.notes.some((n) => n.includes('rim-5') && n.includes('not closed')), `notes: ${result.notes.join(' | ')}`).toBe(true);

    // The universal, real-program form of the same check (the manager's #962 ask): no FEED in
    // ANY posted chamfer op travels anywhere near the organizer's own 77 mm bridge.
    const chamferFeeds = chamferOps.flatMap((op) => op.outcome.ir.operations.flatMap((o) => o.moves)).filter((m) => m.kind === 'feed');
    for (let i = 1; i < chamferFeeds.length; i++) {
      const a = chamferFeeds[i - 1]!, b = chamferFeeds[i]!;
      const lateral = Math.hypot(b.x - a.x, b.y - a.y);
      expect(lateral, `chamfer feed ${i}: ${lateral.toFixed(2)} mm lateral, from (${a.x}, ${a.y}) to (${b.x}, ${b.y})`).toBeLessThan(10);
    }
  });

  it('a genuinely closed rim (first === last) is unaffected: it still posts a chamfer', () => {
    const closedRim: Rim = {
      id: 'rim-closed',
      polyline: [...CORNERS, CORNERS[0]!],
      z: STOCK_TOP,
      of: 'contour',
      kind: 'sharp',
    };
    const { tree, geometry } = rampTree([closedRim]);
    const result = planCurvedForTree(tree, {
      geometry, offset: makeClipperOffset(tl), flat, ball, vbit,
      stepDownMm: 1.5, bandMm: 0.3, feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
      rapid: RAPID, spindleRpm: 12000, air: true, safeZMm: 5, hopZMm: 1,
      edgeBreak: { legMm: 0.5 }, toolNumberFor: (t) => t.number ?? 1,
    });
    const chamferOps = result.ops.filter((op) => op.kind === 'chamfer');
    expect(chamferOps, `notes: ${result.notes.join(' | ')}`).toHaveLength(1);
    const feeds = chamferOps[0]!.outcome.ir.operations.flatMap((o) => o.moves).filter((m) => m.kind === 'feed');
    expect(feeds.length).toBeGreaterThan(0);
  });
});

// A property check on the real Manifold kernel's own rim recognition: every rim `findRims`
// returns on a genuinely closed solid must itself already be closed, within float noise of the
// mesh — not "closed, so my own guard is a no-op" by assumption, but asserted directly, seed by
// seed, so a future regression in `chain()`'s own stitching shows up here before it reaches a
// real part. `rectilinear`/`filleted` are the kinds with real rims (a flat contour plus pockets).
const RIM_KINDS: PartKind[] = ['rectilinear', 'filleted'];
const RIM_SEEDS = [1, 2, 3, 4, 5];

describe('#962 property — every recognised POCKET rim on a real random part is already closed', () => {
  for (const kind of RIM_KINDS) {
    for (const seed of RIM_SEEDS) {
      it(`${kind} seed ${seed}: every pocket rim's own first and last point already coincide`, () => {
        const part = buildRandomPart(seed, kind, tl);
        expect(part.tree.rims.length, `${kind} seed ${seed}: the fixture must actually carry rims`).toBeGreaterThan(0);
        // CONTOUR rims are exempt (see plan.ts's own comment): the outer silhouette can
        // legitimately run open to the stock's own edge — `buildRandomPart`'s own "shoulder open
        // to +X" fixture is exactly this, on every kind and seed, not a chain() defect.
        const pocketRims = part.tree.rims.filter((r) => r.of !== 'contour');
        expect(pocketRims.length, `${kind} seed ${seed}: the fixture must actually carry pocket rims`).toBeGreaterThan(0);
        for (const rim of pocketRims) {
          const first = rim.polyline[0]!;
          const last = rim.polyline[rim.polyline.length - 1]!;
          const gap = Math.hypot(first[0] - last[0], first[1] - last[1]);
          expect(gap, `${kind} seed ${seed}: pocket rim "${rim.id}" is open by ${gap.toFixed(4)} mm`).toBeLessThan(0.01);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// The manager's #962 review: a GENERAL guard, independent of the fix's own reasoning — every
// posted chamfer FEED segment must lie on an edge `findRims` actually reported for that rim, not
// a synthetic bridge `closedRing()` added. Checked against the posted MOVES directly, on the real
// tray and organizer plus the synthetic parts, so a different bridging bug (not this exact open-
// pocket shape) still gets caught.
// ---------------------------------------------------------------------------------------------

// `chamfer()` posts the rim's OWN polyline offset by the cutter's tip radius (`cone.tipRadius`,
// 0.05 mm for the fixtures' own V-bit — `tipDiameter: 0.1`), not the raw polyline itself, so every
// legitimate posted segment sits that far from a "given" edge by construction. The tolerance
// covers that known offset (3x it, for Clipper's own rounding) while staying two orders of
// magnitude below the organizer's real bridge (77 mm) and the synthetic shoulder's own gap (8 mm).
const EDGE_TOL_MM = 0.15;

/** The edges `findRims` actually gave this rim — consecutive pairs of its OWN polyline, as
 * recognised, never auto-closed: the synthetic bridge `closedRing()`/`rimRing()` may add is
 * deliberately excluded, so a segment that only exists because of that bridge fails to match. */
function givenEdges(polyline: readonly [number, number][]): [[number, number], [number, number]][] {
  const edges: [[number, number], [number, number]][] = [];
  for (let i = 1; i < polyline.length; i++) edges.push([polyline[i - 1]!, polyline[i]!]);
  return edges;
}

function distToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** The furthest any of {a, b, midpoint} sits from every given edge — a straight feed segment
 * that truly traces one of the rim's own edges keeps all three on it; a bridge does not. */
function worstDistanceToEdges(a: [number, number], b: [number, number], edges: readonly [[number, number], [number, number]][]): number {
  if (edges.length === 0) return Infinity;
  const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const nearest = (p: [number, number]): number => Math.min(...edges.map(([ea, eb]) => distToSegment(p, ea, eb)));
  return Math.max(nearest(a), nearest(b), nearest(mid));
}

interface EdgeViolation { rimId: string; of: string; a: [number, number]; b: [number, number]; dist: number }

/** Every posted chamfer op's own feed segments, checked against ITS rim's given edges. */
function chamferEdgeViolations(ops: readonly { kind: string; region: { id: string }; outcome: { ir: { operations: readonly { moves: readonly CamMove[] }[] } } }[], rims: readonly Rim[]): EdgeViolation[] {
  const violations: EdgeViolation[] = [];
  for (const op of ops) {
    if (op.kind !== 'chamfer') continue;
    const rim = rims.find((r) => r.id === op.region.id);
    if (rim === undefined) continue;
    const edges = givenEdges(rim.polyline);
    for (const operation of op.outcome.ir.operations) {
      let prev: [number, number] | null = null;
      for (const m of operation.moves) {
        if (m.kind === 'feed' && prev !== null) {
          const dist = worstDistanceToEdges(prev, [m.x, m.y], edges);
          if (dist > EDGE_TOL_MM) violations.push({ rimId: rim.id, of: rim.of, a: prev, b: [m.x, m.y], dist });
        }
        prev = [m.x, m.y];
      }
    }
  }
  return violations;
}


// ---------------------------------------------------------------------------------------------
// #974 — B's #962 guard, extended from POSITION to DEPTH (the manager's 2026-11-05 item): every
// posted chamfer FEED must be no deeper than the rim's own TOP minus the job's edge-break leg.
// The rim's top is the TOP SURFACE its edge sits under — for a NESTED pocket that is the ROOT
// ancestor's mouth, not the node's own mouth: the tray's pocket-7 lives inside pocket-6 (the land
// at -1.2), while its own mouth states the parent floor (-4.2). E's finding at 597d4824: a feed
// at (19.800, 12.050, -4.692), 3.49 mm into the land against the V's own 1.54 mm leg. The 0.05
// position guard cannot see it — the path IS on the rim; only the depth is wrong.
// ---------------------------------------------------------------------------------------------

interface DepthViolation {
  rimId: string;
  of: string;
  at: [number, number];
  z: number;
  /** The deepest z a feed may reach: the rim's own top minus the job's edge-break leg. */
  limit: number;
}

function allPocketNodes(ns: readonly PocketNode[]): PocketNode[] {
  const out: PocketNode[] = [];
  for (const n of ns) {
    out.push(n);
    out.push(...allPocketNodes(n.children));
  }
  return out;
}

/** The rim's own TOP: the mouth of the node's ROOT ancestor (the top surface its edge sits
 * under). The contour's is the part's top; a 'top'-assigned rim has no node and is not checked. */
function rimTopOf(tree: FeatureTree, of: string): number | null {
  // Only a POCKET mouth rim is judged: a pocket's mouth can sit at a parent's floor while the
  // material above it is the parent's own top. The contour's rim is its own outer edge, stated at
  // the edge's own z (its bevel is the design's edge break, and the gate already adjudicates it).
  if (of === 'contour' || of === 'top') return null;
  const all = allPocketNodes(tree.pockets);
  const start = all.find((n) => n.id === of);
  if (start === undefined) return null;
  let cur: PocketNode = start;
  for (;;) {
    const node: PocketNode = cur;
    const parent: PocketNode | undefined = all.find((n) => n.children.some((c) => c.id === node.id));
    if (parent === undefined) break;
    cur = parent;
  }
  return cur.mouthZ;
}

/** The depth guard's tolerance, mm: the rim polyline's own z jitters by the mesh's tessellation
 * (a legitimate feed lands at rimTop − leg ± the edge's own z noise, measured here at ≤ 0.001 mm);
 * 0.05 is two orders below the 3.49 mm defect and a tenth of the 0.5 mm leg. */
const DEPTH_TOL_MM = 0.05;

/** Every chamfer FEED deeper than its rim's top minus the job's edge-break leg (tolerance above). */
function chamferDepthViolations(
  ops: readonly { kind: string; region: { id: string }; outcome: { ir: { operations: readonly { moves: readonly CamMove[] }[] } } }[],
  tree: FeatureTree,
  legMm: number,
): DepthViolation[] {
  const out: DepthViolation[] = [];
  for (const op of ops) {
    if (op.kind !== 'chamfer') continue;
    const rim = tree.rims.find((r) => r.id === op.region.id);
    if (rim === undefined) continue;
    const top = rimTopOf(tree, rim.of);
    if (top === null) continue;
    const limit = top - legMm;
    for (const operation of op.outcome.ir.operations) {
      for (const m of operation.moves) {
        if (m.kind !== 'feed' || !('z' in m)) continue;
        if (m.z! < limit - DEPTH_TOL_MM) out.push({ rimId: rim.id, of: rim.of, at: [m.x!, m.y!], z: m.z!, limit });
      }
    }
  }
  return out;
}

describe('#962 guard — every posted chamfer feed lies on a real rim edge, not a synthetic bridge', () => {
  for (const kind of RIM_KINDS) {
    for (const seed of RIM_SEEDS) {
      it(`${kind} seed ${seed}: no violation on a POCKET rim; the known open-contour bridge is the only one, and it is short`, () => {
        const part = buildRandomPart(seed, kind, tl);
        const result = planCurvedForTree(part.tree, {
          geometry: { triangles: part.mesh }, offset: makeClipperOffset(tl), flat, ball, vbit,
          stepDownMm: 1.5, bandMm: 0.3, feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
          rapid: RAPID, spindleRpm: 12000, air: true, safeZMm: 5, hopZMm: 1,
          edgeBreak: { legMm: 0.5 }, toolNumberFor: (t) => t.number ?? 1,
        });
        const violations = chamferEdgeViolations(result.ops, part.tree.rims);
        const onPocket = violations.filter((v) => v.of !== 'contour');
        expect(onPocket, `pocket violations: ${JSON.stringify(onPocket)}`).toHaveLength(0);
        // The one already-documented exception: the open contour's own closing retrace
        // (buildRandomPart's "shoulder open to +X", 8 mm) — never longer than that fixture's own
        // scale, and never more than one of them.
        const onContour = violations.filter((v) => v.of === 'contour');
        expect(onContour.length, `contour violations: ${JSON.stringify(onContour)}`).toBeLessThanOrEqual(1);
        for (const v of onContour) expect(v.dist, JSON.stringify(v)).toBeLessThan(20);
      }, 60_000);
    }
  }
});

const TRAY_STEP = process.env.CM_959_TRAY_STEP;
const ORGANIZER_STEP = process.env.CM_959_ORGANIZER_STEP;
const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 32 });
const FLAT3175: Tool = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175', fluteLength: 25 });
const BALL6: Tool = { ...flatEndMill(6, { number: 3, id: 'ball-6', name: 'ball-6', fluteLength: 32 }), typeText: 'Ball Nose', shape: 'ball' };
const CHAMFER3175: Tool = {
  ...flatEndMill(3.175, { number: 4, id: 'chamfer-90', name: '3.175mm*90º Chamfer' }),
  typeText: 'V-Bit', shape: 'chamfer', tipDiameter: 0.1, diameter: 3.175, cornerRadius: 0, angle: 90, halfAngle: 45,
};

/**
 * #1180 — THE REAL TRAY IS PLANNED ONCE. Both tests below call this with the identical tuple
 * (same STEP, centre, top and stock), and the plan is the file's whole cost; the memo makes the
 * second case read the first's plan. Assertions stay where they are.
 */
const violationsCache = new Map<string, Promise<{ edge: EdgeViolation[]; depth: DepthViolation[] }>>();
function realPartViolations(
  stepPath: string,
  centre: [number, number],
  topZ: number,
  stockWH: [number, number],
): Promise<{ edge: EdgeViolation[]; depth: DepthViolation[] }> {
  const key = `${stepPath}|${centre[0]},${centre[1]}|${topZ}|${stockWH[0]}x${stockWH[1]}`;
  let hit = violationsCache.get(key);
  if (hit === undefined) {
    hit = computeViolations(stepPath, centre, topZ, stockWH);
    violationsCache.set(key, hit);
  }
  return hit;
}

async function computeViolations(stepPath: string, centre: [number, number], topZ: number, stockWH: [number, number]): Promise<{ edge: EdgeViolation[]; depth: DepthViolation[] }> {
  const read = await loadStepMesh(stepPath);
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const positions = Float32Array.from(read.mesh.positions);
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c]!, positions[i + c]!);
      hi[c] = Math.max(hi[c]!, positions[i + c]!);
    }
  }
  const dx = centre[0] - (lo[0] + hi[0]) / 2;
  const dy = centre[1] - (lo[1] + hi[1]) / 2;
  const dz = topZ - hi[2];
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! + dx;
    positions[i + 1] = positions[i + 1]! + dy;
    positions[i + 2] = positions[i + 2]! + dz;
  }
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c]!, positions[i + c]!);
      hi[c] = Math.max(hi[c]!, positions[i + c]!);
    }
  }
  const triangles = { positions, indices: read.mesh.indices, triangleCount: read.mesh.indices.length / 3, bbox: { min: lo, max: hi } };
  const input: ModelPlanInput = {
    geometry: { triangles, ...(read.faceId === undefined ? {} : { faceId: read.faceId }) },
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0 }, underside: 'flatOnStockBottom' }],
    stock: { length: stockWH[0], width: stockWH[1], thickness: -lo[2], material: 'hardwood' },
    fixture: { mount: 'tape', envelope: null },
    cutters: { house: [FLAT6, FLAT3175, BALL6, CHAMFER3175], catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0.5 },
  };
  const setup = (await planModelCam(input)).perSetup[0]!;
  const tree = recogniseFeatures({ triangles, ...(read.faceId === undefined ? {} : { faceId: read.faceId }) }, { up: [0, 0, 1], stockTop: 0 }, tl);
  return {
    edge: chamferEdgeViolations(setup.ops, tree.rims),
    depth: chamferDepthViolations(setup.ops, tree, input.edgeBreak.legMm),
  };
}

describe.skipIf(TRAY_STEP === undefined)('#962 guard — the real tray', () => {
  it('no posted chamfer feed bridges across a rim that is not its own, and none cuts deeper than its rim\'s top minus the leg', async () => {
    const { edge, depth } = await realPartViolations(TRAY_STEP!, [55, 70], -1.2, [110, 140]);
    const onPocket = edge.filter((v) => v.of !== 'contour');
    expect(onPocket, `pocket violations: ${JSON.stringify(onPocket)}`).toHaveLength(0);
    const onContour = edge.filter((v) => v.of === 'contour');
    for (const v of onContour) expect(v.dist, JSON.stringify(v)).toBeLessThan(20);
    expect(depth, `depth violations: ${JSON.stringify(depth.slice(0, 6))}`).toHaveLength(0);
  }, 1_800_000);

  // RED FIRST (#974, the manager's item 3): E's own point. On the branch before the rim-top fix
  // this feed sits at (19.800, 12.050, -4.692) — the V below the land (-1.2) by 3.49 mm against
  // the leg it is allowed — and this case fails on it by name.
  it('red-first: no chamfer feed at the tray\'s (19.7, 12.0) cuts deeper than its rim\'s top minus the leg', async () => {
    const { depth } = await realPartViolations(TRAY_STEP!, [55, 70], -1.2, [110, 140]);
    const near = depth.filter((v) => Math.hypot(v.at[0] - 19.7, v.at[1] - 12.0) < 2);
    expect(near, `E's gouge is still posted: ${JSON.stringify(near)}`).toHaveLength(0);
  }, 1_800_000);
});

describe.skipIf(ORGANIZER_STEP === undefined)('#962 guard — the real organizer', () => {
  it('no posted chamfer feed bridges across a rim that is not its own, and none cuts deeper than its rim\'s top minus the leg (rim-5\'s own 77 mm gouge, specifically)', async () => {
    const { edge, depth } = await realPartViolations(ORGANIZER_STEP!, [85, 85], -0.8, [170, 170]);
    const onPocket = edge.filter((v) => v.of !== 'contour');
    expect(onPocket, `pocket violations: ${JSON.stringify(onPocket)}`).toHaveLength(0);
    const onContour = edge.filter((v) => v.of === 'contour');
    for (const v of onContour) expect(v.dist, JSON.stringify(v)).toBeLessThan(20);
    expect(depth, `depth violations: ${JSON.stringify(depth.slice(0, 6))}`).toHaveLength(0);
  }, 1_800_000);
});
