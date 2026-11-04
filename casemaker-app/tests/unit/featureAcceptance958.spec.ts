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
 * Tolerances (6620460283): depth ±0.01; area |Δ| ≤ max(1 %, 0.05 mm × perimeter); centroid
 * 0.2 mm; bbox 0.2 mm.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { stepToMesh } from '@/engine/import/stepMesh';
import { recogniseFeatures, type FeatureTree, type PocketNode } from '@/engine/cnc/cam/model/features';
import type { Polygons } from '@/engine/cnc/cam/pocket';

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
const areaTol = (p: Part): number => Math.max(0.01 * p.area, 0.05 * p.perimeter);

/** One expected floor part: a centroid (either coordinate may be unknown), an area range, a size. */
interface Want {
  x?: number;
  y?: number;
  area: [number, number];
  size?: [number, number];
}

/** Greedy match by centroid distance on the known coordinates; then the area range and size. */
function expectParts(label: string, got: Part[], want: Want[]): void {
  expect(got.length, `${label}: ${got.length} parts, want ${want.length}`).toBe(want.length);
  const free = [...got];
  for (const w of want) {
    const dist = (p: Part): number => Math.hypot(w.x === undefined ? 0 : p.centroid[0] - w.x, w.y === undefined ? 0 : p.centroid[1] - w.y);
    free.sort((a, b) => dist(a) - dist(b));
    const p = free.shift()!;
    const where = `${label} @ (${w.x ?? '?'}, ${w.y ?? '?'}) got (${p.centroid[0].toFixed(2)}, ${p.centroid[1].toFixed(2)}) ${p.area.toFixed(2)} mm²`;
    expect(dist(p), where).toBeLessThanOrEqual(0.2);
    const tol = areaTol(p);
    expect(p.area, where).toBeGreaterThanOrEqual(w.area[0] - tol);
    expect(p.area, where).toBeLessThanOrEqual(w.area[1] + tol);
    if (w.size !== undefined) {
      expect(Math.abs(p.size[0] - w.size[0]), where).toBeLessThanOrEqual(0.2);
      expect(Math.abs(p.size[1] - w.size[1]), where).toBeLessThanOrEqual(0.2);
    }
  }
}

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
  return recogniseFeatures({ triangles: mesh, faceId: read.faceId }, { up: [0, 0, 1], stockTop: 0 }, tl);
}

/** Floor parts at a depth below the model top (top land at depth 0). */
function floorsAt(tree: FeatureTree, modelTop: number, depth: number): Part[] {
  const z = modelTop - depth;
  if (Math.abs(depth) < 1e-9) return tree.top.floors.map((f) => partOf(f.polygons, f.area));
  return all(tree.pockets)
    .filter((n) => !n.through && Math.abs(n.floorZ - z) <= 0.01)
    .flatMap((n) => n.floors.map((f) => partOf(f.polygons, f.area)));
}

function writeRemainder(tree: FeatureTree, name: string): void {
  const out = process.env.CM_958_OUT;
  if (out === undefined) return;
  fs.mkdirSync(out, { recursive: true });
  const regions = tree.remainder.map((r) => ({ id: r.id, area: r.area, zTop: r.zTop, zBottom: r.zBottom, slopeMedianDeg: r.slopeMedianDeg, footprint: r.footprint }));
  fs.writeFileSync(path.join(out, `${name}-remainder.json`), JSON.stringify({ frame: 'stock', regions }, null, 1));
}

const TRAY = process.env.CM_958_TRAY_STEP;
const ORGANIZER = process.env.CM_958_ORGANIZER_STEP;

describe.skipIf(TRAY === undefined)('#958 acceptance — tool tray 70, top setup', () => {
  const TOP = -1.2;
  const tree = (): Promise<FeatureTree> => placedTree(TRAY!, [110, 140], TOP);

  it('levels are exactly 0.00 / 0.60 / 3.00 / 6.00 below the model top', async () => {
    const t = await tree();
    writeRemainder(t, 'tray');
    const depths = t.levels.map((z) => TOP - z);
    expect(depths.length, `levels ${depths.map((d) => d.toFixed(3))}`).toBe(4);
    [0, 0.6, 3, 6].forEach((d, i) => expect(Math.abs(depths[i]! - d), `level ${i}`).toBeLessThanOrEqual(0.01));
  });

  it('the floors at each level match E’s parts', async () => {
    const t = await tree();
    expectParts('0.00', floorsAt(t, TOP, 0), [
      { x: 90.7, y: 70.0, area: [3069.1, 3069.1] },
      { x: 19.4, y: 70.2, area: [3006.6, 3006.6] },
    ]);
    expectParts('0.60', floorsAt(t, TOP, 0.6), [
      { x: 12.2, y: 18.3, area: [10.6, 10.6] },
      { x: 12.2, y: 39.1, area: [9.4, 9.4] },
      { x: 12.2, y: 59.6, area: [9.9, 9.9] },
      { x: 12.2, y: 80.3, area: [9.0, 9.0] },
      { x: 12.2, y: 100.7, area: [8.6, 8.6] },
      { x: 12.2, y: 121.2, area: [7.3, 7.3] },
    ]);
    expectParts(
      '3.00',
      floorsAt(t, TOP, 3),
      [28.8, 49.5, 70.0, 90.6, 111.2].map((y) => ({ x: 55.0, y, area: [27.8, 28.1] as [number, number], size: [3.6, 7.5] as [number, number] })),
    );
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

  it('levels are exactly 0 / 3 / 4 / 4.99 / 6 / 10 (not 3.83, not 7.98)', async () => {
    const t = await tree();
    writeRemainder(t, 'organizer');
    const depths = t.levels.map((z) => TOP - z);
    expect(depths.length, `levels ${depths.map((d) => d.toFixed(3))}`).toBe(6);
    [0, 3, 4, 4.99, 6, 10].forEach((d, i) => expect(Math.abs(depths[i]! - d), `level ${i}`).toBeLessThanOrEqual(0.01));
  });

  it('the floors at each level match E’s parts', async () => {
    const t = await tree();
    expectParts('0', floorsAt(t, TOP, 0), [{ x: 85, y: 85, area: [10568.5, 10568.5] }]);
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
      ...[22.5, 59.9, 86.5, 113.1].map((x) => ({ x, y: 87.5, area: [118.8, 123.1] as [number, number] })),
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

  it('eleven through features at 22.00', async () => {
    const t = await tree();
    const through = all(t.pockets)
      .filter((n) => n.through)
      .map((n) => {
        let area = 0;
        for (const ring of n.region) {
          let a = 0;
          for (let i = 0; i < ring.length; i++) {
            const [x0, y0] = ring[i]!;
            const [x1, y1] = ring[(i + 1) % ring.length]!;
            a += x0 * y1 - x1 * y0;
          }
          area += a / 2;
        }
        return partOf(n.region, Math.abs(area));
      });
    expect(Math.abs(t.frame.partBottom - (TOP - 22))).toBeLessThanOrEqual(0.01);
    // E gives the eight at y 37.5 only as "x 20.5–150.5": the two ends are pinned, the six between
    // match on y, area and size alone. Fully placed parts first, so the greedy match takes them.
    const row = { y: 37.5, area: [165.9, 167.0] as [number, number], size: [12.8, 12.8] as [number, number] };
    expectParts('through', through, [
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
