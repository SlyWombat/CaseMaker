/**
 * #958 acceptance items 2 and 3 on the Makerables reference parts (pinned in #958 6620460283,
 * read as FLOOR PARTS per 6621175466).
 *
 * The expected numbers are E's (#958 6620425916): Makera's NC Z levels, measured on the goal
 * heightfield with a ±0.01 mm window. Nothing here comes from this engine. The parts are licensed
 * NC/ND and never committed; this spec runs on the machine that holds them:
 *
 *   CM_958_TRAY_STEP=…/modular-stackable-tool-trays/<tray 70>.step \
 *   CM_958_ORGANIZER_STEP=…/makera-tool-organizer/<organizer>.step \
 *   CM_958_OUT=…/958-acceptance/ \
 *   npx vitest run tests/unit/featureAcceptance958.spec.ts
 *
 * Placement is E's: the model centred on the stock in XY, its top at −1.20 (tray, stock
 * 110 × 140) or −0.80 (organizer, 170 × 170), stock top at z 0. Every number below is in that
 * stock frame. With CM_958_OUT set, the remainder regions are written as JSON for E's relation
 * checks (1–4) against the heightfield masks.
 *
 * Tolerances (6620460283): depth ±0.01 INCLUSIVE (E's window is ±0.01 about Makera's level, so a
 * plane exactly 0.01 away is inside it); area |Δ| ≤ max(1 %, 0.05 mm × perimeter); centroid 0.2 mm;
 * bbox 0.2 mm. After E's second run (6621355983), one more allowance, ONE-SIDED: E's ±0.01 window
 * also takes in the tangent band where a filleted floor meets its wall (√(2r·0.01), 0.2 mm at r 2,
 * 0.25 at r 3), so E's area may exceed the plane's by up to 0.25 mm × perimeter, never the reverse.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { stepToMesh } from '@/engine/import/stepMesh';
import { recogniseFeatures, type FeatureTree, type PocketNode } from '@/engine/cnc/cam/model/features';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import { DEFAULT_FEATURE_TOLERANCES, classifyPatches, patchesFromFaces, type FrameMesh } from '@/engine/cnc/cam/model/features/patches';

interface Part {
  area: number;
  perimeter: number;
  centroid: [number, number];
  size: [number, number];
}

function partOf(polys: Polygons, area: number): Part {
  let a = 0;
  let cx = 0;
  let cy = 0;
  let per = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of polys) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i]!;
      const [x1, y1] = ring[(i + 1) % ring.length]!;
      const w = x0 * y1 - x1 * y0;
      a += w;
      cx += (x0 + x1) * w;
      cy += (y0 + y1) * w;
      per += Math.hypot(x1 - x0, y1 - y0);
      minX = Math.min(minX, x0);
      minY = Math.min(minY, y0);
      maxX = Math.max(maxX, x0);
      maxY = Math.max(maxY, y0);
    }
  }
  return { area, perimeter: per, centroid: [cx / (3 * a), cy / (3 * a)], size: [maxX - minX, maxY - minY] };
}

const all = (nodes: PocketNode[]): PocketNode[] => nodes.flatMap((n) => [n, ...all(n.children)]);
/** Float dust on a comparison against a stated tolerance (E's fourth run: 0.2 read 0.20000000000000284). */
const EPS = 1e-9;
/** E's window, inclusive, plus float noise. */
const LEVEL_TOL = 0.01 + 1e-6;
/** The tangent band E's window takes in beyond a filleted floor's edge, mm (one-sided). */
const TANGENT_BAND_MM = 0.25;
const areaTol = (p: Part): number => Math.max(0.01 * p.area, 0.05 * p.perimeter);

/** One expected floor part: a centroid (either coordinate may be unknown), an area range, a size. */
interface Want {
  x?: number;
  y?: number;
  area: [number, number];
  size?: [number, number];
}

/** Greedy match by centroid distance on the known coordinates; then the area range and size. */
const describeParts = (got: Part[]): string =>
  got
    .map(
      (p) =>
        `    ${p.area.toFixed(2)} mm² @ (${p.centroid[0].toFixed(2)}, ${p.centroid[1].toFixed(2)}) ${p.size[0].toFixed(2)} × ${p.size[1].toFixed(2)}, mean width 2A/P ${((2 * p.area) / p.perimeter).toFixed(3)} mm`,
    )
    .join('\n');

function expectParts(label: string, got: Part[], want: Want[]): void {
  expect(got.length, `${label}: ${got.length} parts, want ${want.length}; ours:\n${describeParts(got)}`).toBe(want.length);
  const free = [...got];
  for (const w of want) {
    const dist = (p: Part): number => Math.hypot(w.x === undefined ? 0 : p.centroid[0] - w.x, w.y === undefined ? 0 : p.centroid[1] - w.y);
    // Distance first; area breaks ties (the tray's 3.00 ledge and its middle channel floor share
    // the centroid (55, 70)).
    const mid = (w.area[0] + w.area[1]) / 2;
    const key = (p: Part): number => dist(p) + Math.abs(Math.log(Math.max(p.area, 1e-9) / mid));
    free.sort((a, b) => key(a) - key(b));
    const p = free.shift()!;
    const where = `${label} @ (${w.x ?? '?'}, ${w.y ?? '?'}) got (${p.centroid[0].toFixed(2)}, ${p.centroid[1].toFixed(2)}) ${p.area.toFixed(2)} mm²`;
    expect(dist(p), where).toBeLessThanOrEqual(0.2 + EPS);
    const tol = areaTol(p);
    expect(p.area, where).toBeGreaterThanOrEqual(w.area[0] - tol - TANGENT_BAND_MM * p.perimeter);
    expect(p.area, where).toBeLessThanOrEqual(w.area[1] + tol);
    if (w.size !== undefined) {
      // One-sided like the area: E's window widens each filleted edge by up to the tangent band.
      for (const k of [0, 1] as const) {
        expect(p.size[k] - w.size[k], where).toBeLessThanOrEqual(0.2 + EPS);
        expect(w.size[k] - p.size[k], where).toBeLessThanOrEqual(0.2 + 2 * TANGENT_BAND_MM + EPS);
      }
    }
  }
}

/**
 * Levels (re-pinned after E's run, 6621257151): E's levels come from Makera's constant-Z feed
 * moves of 20 mm or more, so a real flat Makera reaches another way (a short pass, a helix) is
 * not in E's list. Every level E reads must be a level of the tree, within 0.01. A level of the
 * tree that E doesn't list passes only once E's heightfield confirms it flat (cells within ±0.01 of
 * it at slope ≤ 5°, the same rule E used for the listed levels) and the depth is added below.
 * The levels E flagged as slope crossings must stay absent.
 */
const TRAY_CONFIRMED_EXTRA_DEPTHS: number[] = [];
/**
 * E's second run (6621355983): 0.60 (82.8 mm² in 15 flats) and 14.00 (59.5 mm², two flats) read
 * flat. 8.00: E's heightfield reads 85.9 mm² flat there; the third run's plane fit (6621468987)
 * shows one STEP face, 66.00 mm², deviation 0, normal spread 0°: a modelled 1 mm flat, admitted.
 */
const ORGANIZER_CONFIRMED_EXTRA_DEPTHS: number[] = [0.6, 8, 14];

function expectLevels(tree: FeatureTree, modelTop: number, want: number[], confirmed: number[], absent: number[]): void {
  const depths = tree.levels.map((z) => modelTop - z);
  const shown = depths.map((d) => d.toFixed(3)).join(', ');
  for (const d of want) expect(depths.some((x) => Math.abs(x - d) <= LEVEL_TOL), `level ${d} missing; levels ${shown}`).toBe(true);
  for (const d of absent) expect(depths.some((x) => Math.abs(x - d) <= LEVEL_TOL), `level ${d} must be absent; levels ${shown}`).toBe(false);
  const extra = depths.filter((x) => !want.some((d) => Math.abs(x - d) <= LEVEL_TOL));
  const unconfirmed = extra.filter((x) => !confirmed.some((d) => Math.abs(x - d) <= LEVEL_TOL));
  expect(unconfirmed.map((d) => d.toFixed(3)), `levels not in E's list and not yet confirmed flat by E; levels ${shown}`).toEqual([]);
}

const placedMeshes = new Map<FeatureTree, { positions: Float32Array; indices: Uint32Array; faceId?: Uint32Array }>();

async function placedTree(file: string, stock: [number, number], modelTop: number): Promise<FeatureTree> {
  const bytes = fs.readFileSync(file);
  const read = await stepToMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'recognition');
  const { min, max } = read.mesh.bbox;
  const dx = stock[0] / 2 - (min[0] + max[0]) / 2;
  const dy = stock[1] / 2 - (min[1] + max[1]) / 2;
  const dz = modelTop - max[2];
  const positions = Float32Array.from(read.mesh.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! + dx;
    positions[i + 1] = positions[i + 1]! + dy;
    positions[i + 2] = positions[i + 2]! + dz;
  }
  const mesh = { ...read.mesh, positions };
  const tree = recogniseFeatures({ triangles: mesh, faceId: read.faceId }, { up: [0, 0, 1], stockTop: 0 }, tl);
  placedMeshes.set(tree, { positions, indices: read.mesh.indices, ...(read.faceId ? { faceId: read.faceId } : {}) });
  return tree;
}

/** Floor parts at a depth below the model top (top land at depth 0). */
function floorsAt(tree: FeatureTree, modelTop: number, depth: number): Part[] {
  const z = modelTop - depth;
  if (Math.abs(depth) < 1e-9) return tree.top.floors.map((f) => partOf(f.polygons, f.area));
  return all(tree.pockets)
    .filter((n) => !n.through && Math.abs(n.floorZ - z) <= LEVEL_TOL)
    .flatMap((n) => n.floors.map((f) => partOf(f.polygons, f.area)));
}

/**
 * For E's relation checks, in the stock frame:
 *   <name>-remainder.json  each region's footprint AND its triangles (xyz), so E can rasterise the
 *                          surface's z on the heightfield grid and apply the same ±0.05 band to
 *                          ours as to the masks before comparing areas and slopes (R4, slope)
 *   <name>-floors.json     every floor part per level, and every level's depth, so E can check our
 *                          levels against the heightfield and R1/R2 against our floors
 */
function writeForE(tree: FeatureTree, name: string, modelTop: number, mesh: { positions: Float32Array; indices: Uint32Array }): void {
  const out = process.env.CM_958_OUT;
  if (out === undefined) return;
  fs.mkdirSync(out, { recursive: true });
  const regions = tree.remainder.map((r) => {
    const triangles: number[][] = [];
    for (const t of r.triangles) {
      const tri: number[] = [];
      for (let k = 0; k < 3; k++) {
        const v = mesh.indices[3 * t + k]! * 3;
        tri.push(mesh.positions[v]!, mesh.positions[v + 1]!, mesh.positions[v + 2]!);
      }
      triangles.push(tri);
    }
    return { id: r.id, area: r.area, zTop: r.zTop, zBottom: r.zBottom, slopeMedianDeg: r.slopeMedianDeg, footprint: r.footprint, triangles };
  });
  fs.writeFileSync(path.join(out, `${name}-remainder.json`), JSON.stringify({ frame: 'stock', regions }));
  const levels = tree.levels.map((z) => ({
    z,
    depth: modelTop - z,
    parts: (Math.abs(z - tree.top.z) < 1e-9 ? tree.top.floors : all(tree.pockets).filter((n) => !n.through && Math.abs(n.floorZ - z) <= 0.01).flatMap((n) => n.floors)).map((f) => ({
      ...partOf(f.polygons, f.area),
      polygons: f.polygons,
    })),
  }));
  fs.writeFileSync(path.join(out, `${name}-floors.json`), JSON.stringify({ frame: 'stock', levels, slivers: tree.report.slivers }));
}

/**
 * The plane-fit evidence for every floor patch at a level E does not list: its largest vertex
 * deviation from the fitted plane and the spread of its triangles' normals. A planar B-rep face
 * reads ~0 on both; a cylinder of R over a width w reads ≈ w²/(16R) and ≈ w/(2R) rad, which fails
 * the 0.005 mm / 0.5° tests (#958 §3.1). Printed so a disputed level is settled by the geometry.
 */
function logExtraLevelFits(
  tree: FeatureTree,
  name: string,
  modelTop: number,
  mesh: FrameMesh,
  faceId: Uint32Array | undefined,
  listed: number[],
  alsoAt: number[] = [],
): void {
  if (faceId === undefined) return;
  const tol = DEFAULT_FEATURE_TOLERANCES;
  const patches = patchesFromFaces(mesh, faceId, tol);
  classifyPatches(mesh, patches, tree.frame.partBottom, tol);
  const extra = tree.levels.filter(
    (z) => !listed.some((d) => Math.abs(modelTop - z - d) <= LEVEL_TOL) || alsoAt.some((d) => Math.abs(modelTop - z - d) <= LEVEL_TOL),
  );
  const lines: string[] = [];
  for (const z of extra) {
    for (const patch of patches) {
      if (patch.kind !== 'floor' || Math.abs((patch.zMin + patch.zMax) / 2 - z) > 0.01) continue;
      lines.push(
        `  depth ${(modelTop - z).toFixed(3)}: face patch ${patch.id}, ${patch.area.toFixed(2)} mm², ${patch.triangles.length} tris, plane dev ${patch.planeDevMm.toExponential(2)} mm, normal spread ${patch.normalSpreadDeg.toFixed(4)}°`,
      );
    }
  }
  console.log(`#958 ${name}: plane fits of the floor faces at levels E does not list\n${lines.join('\n')}`);
}

/** Every level with its floor parts, printed so a red run says what the tree found. */
function logLevels(tree: FeatureTree, name: string, modelTop: number): void {
  const lines = tree.levels.map((z) => {
    const parts = Math.abs(z - tree.top.z) < 1e-9 ? tree.top.floors : all(tree.pockets).filter((n) => !n.through && Math.abs(n.floorZ - z) <= 0.01).flatMap((n) => n.floors);
    const nodes = all(tree.pockets).filter((n) => !n.through && Math.abs(n.floorZ - z) <= LEVEL_TOL);
    const nodeLine = nodes.map((n) => `${n.id}${n.open ? ' (open)' : ''} enters ⌀${n.narrowest.toFixed(2)}, ${n.floors.length} floor part(s)`).join('; ');
    return `  depth ${(modelTop - z).toFixed(3)} (z ${z.toFixed(3)}): ${parts.length} parts${nodeLine ? ` — nodes: ${nodeLine}` : ''}\n${describeParts(parts.map((f) => partOf(f.polygons, f.area)))}`;
  });
  console.log(`#958 ${name}: partTop ${tree.frame.partTop.toFixed(3)} partBottom ${tree.frame.partBottom.toFixed(3)}\n${lines.join('\n')}`);
}

const TRAY = process.env.CM_958_TRAY_STEP;
const ORGANIZER = process.env.CM_958_ORGANIZER_STEP;

describe.skipIf(TRAY === undefined)('#958 acceptance — tool tray 70, top setup', () => {
  const TOP = -1.2;
  const tree = (): Promise<FeatureTree> => placedTree(TRAY!, [110, 140], TOP);

  it('every level E reads is a level of the tree; any other level is one E confirmed flat', async () => {
    const t = await tree();
    logLevels(t, 'tray', TOP);
    writeForE(t, 'tray', TOP, placedMeshes.get(t)!);
    const placed = placedMeshes.get(t)!;
    // 3.00 too: the ledge's own face fit, the geometry behind pinning it (6621605514 reply).
    logExtraLevelFits(t, 'tray', TOP, placed, placed.faceId, [0, 0.6, 3, 6], [3]);
    expectLevels(t, TOP, [0, 0.6, 3, 6], TRAY_CONFIRMED_EXTRA_DEPTHS, []);
  });

  it('the floors at each level match E’s parts', async () => {
    const t = await tree();
    expectParts('0.00', floorsAt(t, TOP, 0), [
      { x: 90.7, y: 70.0, area: [3069.1, 3069.1] },
      { x: 19.4, y: 70.2, area: [3006.6, 3006.6] },
    ]);
    // E gives these six only as "x ≈ 12.2" with a y each (6620425916), so y is pinned to 0.2 mm
    // and x to E's stated precision, 0.5 mm (third run: (12.57, 59.65) for the island pocket).
    const sixty = floorsAt(t, TOP, 0.6);
    expectParts('0.60', sixty, [
      { y: 18.3, area: [10.6, 10.6] },
      { y: 39.1, area: [9.4, 9.4] },
      { y: 59.6, area: [9.9, 9.9] },
      { y: 80.3, area: [9.0, 9.0] },
      { y: 100.7, area: [8.6, 8.6] },
      { y: 121.2, area: [7.3, 7.3] },
    ]);
    for (const p of sixty) expect(Math.abs(p.centroid[0] - 12.2), `0.60 x ${p.centroid[0].toFixed(2)}`).toBeLessThanOrEqual(0.5);
    // The 1,456.4 mm² rim-shaped component E flagged at −4.20 (6620425916) is pinned as a part:
    // E's own area is ~3 mm × the outline's perimeter (2A/P ≈ 3.07 mm on ours), not the 0.1–0.2 mm
    // fillet sliver first guessed, so it is the outer ledge, an OPEN shoulder (#958 6621605514 reply).
    expectParts('3.00', floorsAt(t, TOP, 3), [
      { x: 55.0, y: 70.0, area: [1456.4, 1456.4], size: [106, 136] },
      ...[28.8, 49.5, 70.0, 90.6, 111.2].map((y) => ({ x: 55.0, y, area: [27.8, 28.1] as [number, number], size: [3.6, 7.5] as [number, number] })),
    ]);
    const ledge = all(t.pockets).find((n) => !n.through && Math.abs(n.floorZ - (TOP - 3)) <= LEVEL_TOL && n.floors.some((f) => f.area > 1000));
    expect(ledge?.open, 'the 3.00 ledge is an open shoulder').toBe(true);
    // x 55.0 is the midpoint of E's bbox x 19.8–90.2, not a centroid E gave; the slots are
    // symmetric end to end, so the two coincide.
    expectParts(
      '6.00',
      floorsAt(t, TOP, 6),
      [18.5, 39.1, 59.8, 80.2, 100.9, 121.5].map((y) => ({ x: 55.0, y, area: [909.5, 923.6] as [number, number], size: [70.4, 12.8] as [number, number] })),
    );
  });

  it('two 0.60 pockets carry an island rising to the top', async () => {
    const t = await tree();
    const islands = all(t.pockets)
      .filter((n) => Math.abs(n.floorZ - (TOP - 0.6)) <= 0.01)
      .flatMap((n) => n.islands.map((i) => ({ ...partOf(i.outline, 0), topZ: i.topZ })));
    expect(islands).toHaveLength(2);
    for (const [x, y] of [
      [12.4, 17.3],
      [12.2, 59.8],
    ] as const) {
      const hit = islands.find((i) => Math.hypot(i.centroid[0] - x, i.centroid[1] - y) <= 0.3);
      expect(hit, `island @ (${x}, ${y})`).toBeDefined();
      expect(Math.abs(hit!.topZ - TOP)).toBeLessThanOrEqual(0.01);
    }
  });

  it('the contour: 14 411.2 mm², 106 × 136, centred (55, 70)', async () => {
    const t = await tree();
    const c = partOf(t.contour.outline, t.contour.area);
    expect(Math.abs(c.area - 14411.2)).toBeLessThanOrEqual(areaTol(c));
    expect(Math.abs(c.size[0] - 106)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(c.size[1] - 136)).toBeLessThanOrEqual(0.2);
    expect(Math.hypot(c.centroid[0] - 55, c.centroid[1] - 70)).toBeLessThanOrEqual(0.2);
  });
});

describe.skipIf(ORGANIZER === undefined)('#958 acceptance — tool organizer, top setup', () => {
  const TOP = -0.8;
  const tree = (): Promise<FeatureTree> => placedTree(ORGANIZER!, [170, 170], TOP);

  it('every level E reads is a level of the tree (not 3.83, not 7.98); any other level is one E confirmed flat', async () => {
    const t = await tree();
    logLevels(t, 'organizer', TOP);
    writeForE(t, 'organizer', TOP, placedMeshes.get(t)!);
    const placed = placedMeshes.get(t)!;
    logExtraLevelFits(t, 'organizer', TOP, placed, placed.faceId, [0, 3, 4, 4.99, 6, 10, 22]);
    expectLevels(t, TOP, [0, 3, 4, 4.99, 6, 10, 22], ORGANIZER_CONFIRMED_EXTRA_DEPTHS, [3.83, 7.98]);
  });

  it('the floors at each level match E’s parts', async () => {
    const t = await tree();
    // E gives the land's area and count only, no centroid (6620425916).
    expectParts('0', floorsAt(t, TOP, 0), [{ area: [10568.5, 10568.5] }]);
    expectParts('3', floorsAt(t, TOP, 3), [
      { x: 41.0, y: 129.0, area: [2487.7, 2487.7], size: [100.8, 100.8] },
      ...[73.2, 99.8, 45.9, 127.1].map((x) => ({ x, y: 87.5, area: [1182.6, 1278.9] as [number, number], size: [21.2, 65.8] as [number, number] })),
    ]);
    expectParts(
      '4',
      floorsAt(t, TOP, 4),
      [102.4, 117.9, 133.4].map((x) => ({ x, y: 27.0, area: [13.1, 13.1] as [number, number], size: [4, 4] as [number, number] })),
    );
    expectParts('4.99', floorsAt(t, TOP, 4.99), [
      // E's table grouped x 22.5 with the y 87.5 row; E confirmed its centroid is (22.5, 101.0)
      // on the third run (#958, manager 2026-11-04).
      ...[59.9, 86.5, 113.1].map((x) => ({ x, y: 87.5, area: [118.8, 123.1] as [number, number] })),
      { x: 22.5, y: 101.0, area: [118.8, 123.1] },
      { x: 69.0, y: 147.5, area: [118.8, 123.1] },
      ...[
        [143.5, 11.5],
        [143.5, 26.5],
        [158.5, 11.5],
        [158.5, 26.5],
      ].map(([x, y]) => ({ x, y, area: [18.8, 18.8] as [number, number] })),
    ]);
    expectParts(
      '6',
      floorsAt(t, TOP, 6),
      [41.5, 57.2, 73.0, 88.8, 104.5].map((x) => ({ x, y: 129.5, area: [13.4, 13.5] as [number, number] })),
    );
    // 10: a 5 × 3 grid in x 118.5–155.5, y 126.5–157.5; positions inside that box, no centroid pinned.
    const ten = floorsAt(t, TOP, 10);
    expect(ten).toHaveLength(15);
    for (const p of ten) {
      expect(p.centroid[0]).toBeGreaterThanOrEqual(118.5 - 0.2);
      expect(p.centroid[0]).toBeLessThanOrEqual(155.5 + 0.2);
      expect(p.centroid[1]).toBeGreaterThanOrEqual(126.5 - 0.2);
      expect(p.centroid[1]).toBeLessThanOrEqual(157.5 + 0.2);
      expect(p.area).toBeGreaterThanOrEqual(18.6 - areaTol(p));
      expect(p.area).toBeLessThanOrEqual(18.8 + areaTol(p));
      expect(Math.abs(p.size[0] - 4.8)).toBeLessThanOrEqual(0.2);
    }
  });

  it('eleven pockets with floors at 22.00 (the model is 26 thick, so they are not through)', async () => {
    // Re-pinned after E's run (6621257151): the part's bottom is 26.0 below its top, at the stock's
    // bottom. E's "−22.80" is Makera's contour depth on this side, not the model's bottom, so the
    // eleven are floors at 22, read as floor parts like every other level.
    const t = await tree();
    expect(Math.abs(t.frame.partBottom - (TOP - 26))).toBeLessThanOrEqual(0.01);
    const through = floorsAt(t, TOP, 22);
    // E gives the eight at y 37.5 only as "x 20.5–150.5": the two ends are pinned, the six between
    // match on y, area and size alone. Fully placed parts first, so the greedy match takes them.
    const row = { y: 37.5, area: [165.9, 167.0] as [number, number], size: [12.8, 12.8] as [number, number] };
    expectParts('22', through, [
      { x: 108.5, y: 17.5, area: [103.0, 103.0] },
      { x: 128.5, y: 17.5, area: [103.0, 103.0] },
      { x: 150.5, y: 63.5, area: [77.7, 77.7] },
      { ...row, x: 20.5 },
      { ...row, x: 150.5 },
      ...Array.from({ length: 6 }, () => row),
    ]);
  });

  it('the contour: 25 919.0 mm², 161 × 161, centred (85, 85)', async () => {
    const t = await tree();
    const c = partOf(t.contour.outline, t.contour.area);
    expect(Math.abs(c.area - 25919.0)).toBeLessThanOrEqual(areaTol(c));
    expect(Math.abs(c.size[0] - 161)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(c.size[1] - 161)).toBeLessThanOrEqual(0.2);
    expect(Math.hypot(c.centroid[0] - 85, c.centroid[1] - 85)).toBeLessThanOrEqual(0.2);
  });
});
