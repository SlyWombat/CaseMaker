/**
 * #1085 — FACES AND A GOAL IS TWO PROGRAMS, CORNERS FIRST, AND THE RELIEF READS THE SECTION
 * THE FACES LEAVE.
 *
 * The #1059 readiness job carried both (`faces-all-round` at A 45 on a 44.5 mm square) and posted
 * only the faces program; the goal was dropped with no sentence. The mixed dispatch cuts the
 * faces program first, then the relief — and the relief is planned from the OCTAGON the corner
 * cuts leave (plane 22.25 mm from the axis at A 45/135/225/315), not from the square's 31.466 mm
 * corners.
 *
 * RED at m1-land10 4512c97e5: the job refuses by name (#1084's stopgap) and posts nothing.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill } from '@/engine/cnc/tool';
import { sectionRadiusAt, rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { processedSectionOf } from '@/engine/cnc/rotary/faceOps';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { stl } from './helpers/meshes';

type V = [number, number, number];
type Tri = [V, V, V];

const TAU = Math.PI * 2;

/** A solid of revolution's side surface around local X: radius(x) over [-L/2, L/2]. */
function sideTris(radiusAt: (x: number) => number, length = 30, seg = 180): Tri[] {
  const tris: Tri[] = [];
  const at = (x: number, a: number): V => [x, radiusAt(x) * Math.sin(a), radiusAt(x) * Math.cos(a)];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * TAU;
    const a1 = ((i + 1) / seg) * TAU;
    tris.push([at(-length / 2, a0), at(length / 2, a0), at(length / 2, a1)], [
      at(-length / 2, a0),
      at(length / 2, a1),
      at(-length / 2, a1),
    ]);
  }
  return tris;
}

/** The relief: a cone 4 → 9 mm, well inside the octagon's 22.25 mm flats (14 mm long: the finish's
 * tip budget is the fixture's size, not the fix's). */
const CONE = (x: number): number => 4 + ((x + 7) / 14) * 5;

function goal(): EngraveTargetObject {
  return {
    id: 'part',
    name: 'relief.stl',
    format: 'stl',
    sha256: 'e'.repeat(64),
    data: stl(sideTris(CONE, 14)),
    size: { x: 14, y: 18, z: 18 },
    position: { x: 30, y: 0, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

const TOOL = flatEndMill(3.175, { name: '3.175 mm flat', fluteLength: 25, shoulderLength: 30 });

/** The #1059 fixture's job: a 44.5 mm square block in the chuck, the corners cut to an octagon. */
function blockJob(): EngraveJob {
  return {
    ...defaultEngraveJob(),
    name: 'octagon relief',
    stock: { length: 80, width: 44.5, thickness: 44.5, material: 'hardwood' },
    stockEntry: { kind: 'made', shelfId: null, file: null, form: 'block', finish: 'rough', conductive: false },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { stickout: 50, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' },
    },
    labels: [],
    shapes: [],
    faces: [{ id: 'face-corners', kind: 'faces-all-round', a: 45, count: 8, acrossFlats: 44.5 }],
    targetObject: goal(),
    toolKey: 'flat-3.175',
  };
}

describe('#1085 faces and a goal is two programs', () => {
  it('posts TWO programs — the faces first, the relief second — and stamps the goal', async () => {
    const out = await engraveGenerate(tl, blockJob(), TOOL, [], null, undefined, {});
    // RED at the base: #1084's stopgap refuses the job by name and posts nothing.
    expect(out.errors).toEqual([]);
    expect(out.ok).toBe(true);
    expect(out.programs).toHaveLength(2);
    // Both post in the rotary frame; the SURFACE marker separates them: the indexed face program
    // carries none, the relief carries its surface check — and the relief is the second file.
    expect(out.programs[0]!.surfaceCheck ?? null).toBeNull();
    expect(out.programs[1]!.surfaceCheck?.kind).toBe('surface');
    expect(out.surface3d).not.toBeNull();
  }, 240_000);

  it('the relief is planned from the octagon the faces leave, and the sheet says so', async () => {
    const map = rotaryMapOf(blockJob())!;
    expect(map.section).toEqual({ kind: 'rect', width: 44.5, height: 44.5 });
    // Before the faces: the square's corner stands at half the diagonal.
    expect(sectionRadiusAt(map.section, Math.PI / 4)).toBeCloseTo(31.466, 2);
    const processed = processedSectionOf(map.section, blockJob().faces!);
    // After them: the A 45 cut plane at 22.25 bounds the corner; the flats are unchanged; the
    // octagon's vertex stands where the two meet.
    expect(sectionRadiusAt(processed, Math.PI / 4)).toBeCloseTo(22.25, 6);
    expect(sectionRadiusAt(processed, 0)).toBeCloseTo(22.25, 6);
    expect(sectionRadiusAt(processed, Math.PI / 8)).toBeCloseTo(22.25 / Math.cos(Math.PI / 8), 6);
    const out = await engraveGenerate(tl, blockJob(), TOOL, [], null, undefined, {});
    const told = out.findings.find((f) => f.code === 'faces-before-relief');
    expect(told?.message).toContain('22.25');
  }, 240_000);
});
