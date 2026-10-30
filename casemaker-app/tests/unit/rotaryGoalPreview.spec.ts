/**
 * #723 R-3 preview — the goal on a rod, drawn from the SAME field the CAM reads.
 *
 * The component itself is React/three in the viewport; what is pinned here is the picture's two
 * facts: the surface is built from the field's covered cells at `(x0 + i·p, j·p, z)`, and the
 * Stock view wraps THAT buffer onto the cylinder so a map point (x, s, z) is the stock point at
 * radius R + z — the same coordinate change #716 pinned for the floors.
 */
import { describe, expect, it } from 'vitest';
import {
  rotaryGoalSurfaceGeometry,
  rotaryGoalTarget,
  ROTARY_GOAL_PREVIEW_MAX_CELLS,
  ROTARY_GOAL_PREVIEW_PITCH_MM,
} from '@/components/viewport/rotaryGoalPreview';
import { wrapMapGeometry } from '@/components/viewport/rotaryStockView';
import { sampleGoalRadialField, type GoalRadialField } from '@/engine/cnc/cam/rotaryRelief';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

type V = [number, number, number];
type Tri = [V, V, V];

function stl(tris: Tri[]): string {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

const R = 10;
const LENGTH = 20;
const CX = 30;
const TAU = Math.PI * 2;

/** A barrel: radius 6 at both ends, 9 at the middle, as a solid of revolution about X. */
const rOf = (x: number): number => 6 + 3 * Math.sin(((x - (CX - LENGTH / 2)) / LENGTH) * Math.PI);

function barrelStrip(seg = 96): Tri[] {
  const tris: Tri[] = [];
  const at = (x: number, a: number): V => {
    const r = rOf(CX + x);
    return [x, r * Math.sin(a), r * Math.cos(a)];
  };
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * TAU;
    const a1 = ((i + 1) / seg) * TAU;
    tris.push(
      [at(-LENGTH / 2, a0), at(LENGTH / 2, a0), at(LENGTH / 2, a1)],
      [at(-LENGTH / 2, a0), at(LENGTH / 2, a1), at(-LENGTH / 2, a1)],
    );
  }
  return tris;
}

function goal(over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: 'barrel',
    name: 'barrel.stl',
    format: 'stl',
    sha256: 'b'.repeat(64),
    data: stl(barrelStrip()),
    size: { x: LENGTH, y: 18, z: 18 },
    position: { x: CX, y: 0, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

function jobWith(target: EngraveTargetObject | undefined): EngraveJob {
  return { targetObject: target } as unknown as EngraveJob;
}

/** A hand-built field: `z` from the barrel's closed form at every cell, all covered. */
function analyticField(): GoalRadialField {
  const nx = 41;
  const ny = 80;
  const pitch = LENGTH / (nx - 1);
  const z = new Float32Array(nx * ny);
  const covered = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = CX - LENGTH / 2 + i * pitch;
      z[j * nx + i] = rOf(x) - R;
      covered[j * nx + i] = 1;
    }
  }
  return {
    nx,
    ny,
    x0: CX - LENGTH / 2,
    y0: 0,
    pitch,
    radius: R,
    minRadius: 6,
    maxRadius: 9,
    z,
    covered,
    coveredCount: nx * ny,
    resolutionNote: 'test',
  };
}

describe('#723 R-3 the goal a rotary job cuts', () => {
  it('is an enabled goal with mesh bytes; a picture, a reference or a disabled target is not', () => {
    expect(rotaryGoalTarget(jobWith(goal()))).not.toBeNull();
    expect(rotaryGoalTarget(jobWith(goal({ format: 'png' })))).toBeNull();
    expect(rotaryGoalTarget(jobWith(goal({ role: 'reference' })))).toBeNull();
    expect(rotaryGoalTarget(jobWith(goal({ enabled: false })))).toBeNull();
    expect(rotaryGoalTarget(jobWith(undefined))).toBeNull();
    const { data: _data, ...noBytes } = goal();
    expect(rotaryGoalTarget(jobWith(noBytes as EngraveTargetObject))).toBeNull();
  });

  it('samples the preview at its own coarse pitch, capped below the CAM’s millions', () => {
    const field = sampleGoalRadialField(goal(), R, {
      pitchMm: ROTARY_GOAL_PREVIEW_PITCH_MM,
      maxCells: ROTARY_GOAL_PREVIEW_MAX_CELLS,
    });
    expect(field.nx * field.ny).toBeLessThanOrEqual(ROTARY_GOAL_PREVIEW_MAX_CELLS);
    expect(field.coveredCount).toBeGreaterThan(0);
    // The placed mesh's centre is position.x: the field's X extent is the mesh's, about it.
    expect(field.x0).toBeCloseTo(CX - LENGTH / 2, 6);
    expect(field.x0 + (field.nx - 1) * field.pitch).toBeCloseTo(CX + LENGTH / 2, 6);
  });
});

describe('#723 R-3 the surface the preview draws', () => {
  it('is the field’s own surface: every vertex sits at (x0 + i·p, j·p, z)', () => {
    const field = analyticField();
    const geom = rotaryGoalSurfaceGeometry(field);
    const pos = geom.getAttribute('position');
    expect(pos.count).toBeGreaterThan(0);
    // Every vertex is inside the map's X extent and the circumference, and its z is a value the
    // field holds (heights are per-cell; the mesh emits each cell's own corner heights).
    const box = geom.boundingBox!;
    expect(box.min.x).toBeCloseTo(CX - LENGTH / 2, 6);
    expect(box.max.x).toBeCloseTo(CX + LENGTH / 2, 6);
    expect(box.min.y).toBeCloseTo(0, 6);
    expect(box.max.y).toBeLessThanOrEqual(TAU * R + 1e-6);
    const heights = new Set(Array.from(field.z, (v) => Number(v.toFixed(5))));
    for (let v = 0; v < pos.count; v++) {
      expect(heights.has(Number(pos.getZ(v).toFixed(5)))).toBe(true);
    }
    geom.dispose();
  });

  it('draws only the covered cells', () => {
    const field = analyticField();
    // Half the circumference covered: the geometry must reach no further than that arc.
    for (let j = 40; j < field.ny; j++) {
      for (let i = 0; i < field.nx; i++) field.covered[j * field.nx + i] = 0;
    }
    field.coveredCount = 40 * field.nx;
    const geom = rotaryGoalSurfaceGeometry(field);
    const box = geom.boundingBox!;
    expect(box.max.y).toBeLessThanOrEqual(40 * field.pitch + 1e-6);
    geom.dispose();
  });

  it('wraps onto the stock at radius R + z — one geometry, two views', () => {
    const field = analyticField();
    const map = rotaryGoalSurfaceGeometry(field);
    const wrap = wrapMapGeometry(map, R);
    const flat = map.getAttribute('position');
    const pos = wrap.getAttribute('position');
    expect(pos.count).toBe(flat.count);
    for (let v = 0; v < Math.min(pos.count, 64); v++) {
      // The part's surface sits INSIDE the rod by its depth below the surface.
      expect(Math.hypot(pos.getY(v), pos.getZ(v) + R)).toBeCloseTo(R + flat.getZ(v), 6);
      expect(pos.getX(v)).toBeCloseTo(flat.getX(v), 6);
    }
    map.dispose();
    wrap.dispose();
  });
});
