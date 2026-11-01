/**
 * #829 — THE GOAL MESH'S TOP RIM. Synthetic meshes with closed-form answers: a box's four top
 * edges are one closed ring with the corner bisectors as the air side, a flat sheet has no rim,
 * and a tilted top is reported for what it is. The placement shares `targetPlace.ts` with the
 * goal sampler, so these tests also pin that a placed object's rim lands in the work frame.
 */
import { describe, expect, it } from 'vitest';

import { chamferBandFor, targetRim } from '@/engine/cnc/engrave/targetRim';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import type { EngraveTargetObject } from '@/types/engraveJob';

type P = [number, number, number];

/** A binary STL of the triangles, base64 — the form a job embeds. */
function stlBase64(tris: readonly (readonly [P, P, P])[]): string {
  const bytes = new Uint8Array(84 + tris.length * 50);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const [a, b, c] of tris) {
    for (let k = 0; k < 3; k++) dv.setFloat32(off + k * 4, 0, true);
    off += 12;
    for (const p of [a, b, c]) {
      dv.setFloat32(off, p[0], true);
      dv.setFloat32(off + 4, p[1], true);
      dv.setFloat32(off + 8, p[2], true);
      off += 12;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return Buffer.from(bytes).toString('base64');
}

let n = 0;
function target(data: string, over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: `goal-${++n}`,
    name: 'part',
    role: 'goal',
    enabled: true,
    format: 'stl',
    sha256: `sha-${n}`,
    data,
    position: { x: 0, y: 0, z: 5 },
    rotation: 0,
    size: { x: 10, y: 10, z: 5 },
    ...over,
  } as unknown as EngraveTargetObject;
}

/** A 10 × 10 × 5 box, bottom at z = 0 and top at z = 5 (placed with its top at position.z). */
function boxMesh(): string {
  const v: P[] = [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
    [0, 10, 0],
    [0, 0, 5],
    [10, 0, 5],
    [10, 10, 5],
    [0, 10, 5],
  ];
  const tris: [P, P, P][] = [
    // bottom (−Z)
    [v[0]!, v[2]!, v[1]!],
    [v[0]!, v[3]!, v[2]!],
    // top (+Z)
    [v[4]!, v[5]!, v[6]!],
    [v[4]!, v[6]!, v[7]!],
    // front y = 0 (−Y)
    [v[0]!, v[1]!, v[5]!],
    [v[0]!, v[5]!, v[4]!],
    // right x = 10 (+X)
    [v[1]!, v[2]!, v[6]!],
    [v[1]!, v[6]!, v[5]!],
    // back y = 10 (+Y)
    [v[2]!, v[3]!, v[7]!],
    [v[2]!, v[7]!, v[6]!],
    // left x = 0 (−X)
    [v[3]!, v[0]!, v[4]!],
    [v[3]!, v[4]!, v[7]!],
  ];
  return stlBase64(tris);
}

describe('#829 the target mesh’s top rim', () => {
  it('a box’s four top edges are ONE closed ring, with the corner bisector as the air side', () => {
    clearTargetObjectMeshCache();
    const { chains, notes } = targetRim(target(boxMesh()));
    expect(notes).toEqual([]);
    expect(chains).toHaveLength(1);
    const ring = chains[0]!;
    expect(ring.closed).toBe(true);
    expect(ring.points).toHaveLength(4);
    expect(ring.lengthMm).toBeCloseTo(40, 6);
    expect(ring.topTiltDeg).toBeCloseTo(0, 6);
    // Every point is a top corner at z = 5 (the placed top is position.z).
    for (const p of ring.points) expect(p.z).toBeCloseTo(5, 6);
    // At each corner the air is the bisector of the two walls it meets.
    for (const o of ring.outward) expect(Math.hypot(o.x, o.y)).toBeCloseTo(1, 6);
    // The ring visits the corners in order; every outward direction points AWAY from the centre
    // (`position` is the mesh's CENTRE in X/Y, so the ring spans −5…5 here).
    const centre = { x: 0, y: 0 };
    ring.points.forEach((p, i) => {
      const away = { x: p.x - centre.x, y: p.y - centre.y };
      const dot = away.x * ring.outward[i]!.x + away.y * ring.outward[i]!.y;
      expect(dot).toBeGreaterThan(0);
    });
  });

  it('a flat sheet has no rim, and says so', () => {
    clearTargetObjectMeshCache();
    const sheet = stlBase64([
      [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
      ],
      [
        [0, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
    ]);
    const { chains, notes } = targetRim(target(sheet));
    expect(chains).toEqual([]);
    expect(notes.join(' ')).toContain('no top rim');
  });

  it('a top tilted within the limit is a rim, and its tilt is reported', () => {
    clearTargetObjectMeshCache();
    // A 10 × 10 slab whose top falls 1 mm across X: a 5.71° tilt.
    const v: P[] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
      [0, 0, 5],
      [10, 0, 4],
      [10, 10, 4],
      [0, 10, 5],
    ];
    const tris: [P, P, P][] = [
      [v[0]!, v[2]!, v[1]!],
      [v[0]!, v[3]!, v[2]!],
      [v[4]!, v[5]!, v[6]!],
      [v[4]!, v[6]!, v[7]!],
      [v[0]!, v[1]!, v[5]!],
      [v[0]!, v[5]!, v[4]!],
      [v[1]!, v[2]!, v[6]!],
      [v[1]!, v[6]!, v[5]!],
      [v[2]!, v[3]!, v[7]!],
      [v[2]!, v[7]!, v[6]!],
      [v[3]!, v[0]!, v[4]!],
      [v[3]!, v[4]!, v[7]!],
    ];
    const { chains, notes } = targetRim(target(stlBase64(tris), { position: { x: 0, y: 0, z: 5 } }));
    expect(notes).toEqual([]);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.topTiltDeg).toBeCloseTo(5.71, 1);
  });

  it('the placed object’s rim lands in the WORK frame', () => {
    clearTargetObjectMeshCache();
    const { chains } = targetRim(target(boxMesh(), { position: { x: 20, y: 30, z: 5 } }));
    expect(chains).toHaveLength(1);
    const xs = chains[0]!.points.map((p) => p.x);
    const ys = chains[0]!.points.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(15, 6);
    expect(Math.max(...xs)).toBeCloseTo(25, 6);
    expect(Math.min(...ys)).toBeCloseTo(25, 6);
    expect(Math.max(...ys)).toBeCloseTo(35, 6);
  });

  it('#829 — the preview band is the rim and the line its bevel reaches, at the rim’s height', () => {
    clearTargetObjectMeshCache();
    const band = chamferBandFor(target(boxMesh(), { chamfer: { widthMm: 1 } }) as never);
    expect(band).not.toBeNull();
    expect(band!.rings).toHaveLength(2);
    const [edge, inner] = band!.rings;
    // Both rings sit at the rim's own height (the placed top).
    for (const p of [...edge!, ...inner!]) expect(p[2]).toBeCloseTo(5, 6);
    // The inner ring is the edge moved 1 mm toward the part: the box spans −5…5, so each corner
    // moves 1 mm toward the centre (0,0) along the corner bisector.
    edge!.forEach((p, i) => {
      const q = inner![i]!;
      expect(Math.hypot(q[0] - p[0], q[1] - p[1])).toBeCloseTo(1, 6);
      expect(Math.hypot(q[0], q[1])).toBeLessThan(Math.hypot(p[0], p[1]));
    });
  });
});
