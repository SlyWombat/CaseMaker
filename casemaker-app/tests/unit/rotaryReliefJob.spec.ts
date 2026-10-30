/**
 * #723 R-3 — A GOAL ON A ROD, through the generator: a rotary job whose target object is a goal
 * takes the relief path (`generateRotaryGoalProgram` → the radial field → the relief CAM → the
 * rotary post), and the design's three findings refuse what cannot be turned.
 */
import { describe, expect, it } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill } from '@/engine/cnc/tool';
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

const TAU = Math.PI * 2;
let serial = 0;

/** A solid of revolution's side surface around local X: radius(x) over [−L/2, L/2]. */
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

function goal(radiusAt: (x: number) => number, over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  const max = Math.max(radiusAt(-15), radiusAt(15));
  return {
    id: 'part',
    name: 'relief.stl',
    format: 'stl',
    sha256: (serial++).toString(16).padStart(64, 'd'),
    data: stl(sideTris(radiusAt)),
    size: { x: 30, y: 2 * max, z: 2 * max },
    position: { x: 30, y: 0, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

const BALL = flatEndMill(2, { shape: 'ball', name: '2 mm ball', fluteLength: 12, shoulderLength: 20 });

function rotaryJob(target: EngraveTargetObject): EngraveJob {
  return {
    ...defaultEngraveJob(),
    name: 'rotary relief',
    stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { stickout: 60, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' },
    },
    labels: [],
    shapes: [],
    targetObject: target,
    toolKey: 'ball-2',
  };
}

const CONE = (x: number): number => 4 + ((x + 15) / 30) * 5; // 4 → 9 mm over 30 mm

describe('#723 R-3 — a goal on a rod generates the relief program', () => {
  it('posts a rotary program and says what it is on the sheet facts', () => {
    const job = rotaryJob(goal(CONE));
    const out = engraveGenerate(tl, job, BALL, [], null, undefined, {});
    expect(out.errors).toEqual([]);
    expect(out.ok).toBe(true);
    expect(out.programs).toHaveLength(1);
    const program = out.programs[0]!;
    expect(program.frame).toBe('rotary');
    expect(program.nc).toContain('A');
    expect(program.surfaceCheck?.kind).toBe('surface');
    expect(out.surface3d?.notes.some((n) => /simulated here/.test(n))).toBe(true);
    expect(out.surface3d?.resolutionNote).toContain('rod');
  });

  it('refuses a part wider than the rod, by name', () => {
    const wide = goal(() => 12);
    const out = engraveGenerate(tl, rotaryJob(wide), BALL, [], null, undefined, {});
    expect(out.ok).toBe(false);
    expect(out.findings.some((f) => f.code === 'goal-rotary-oversize')).toBe(true);
  });

  it('refuses a part that reaches the axis with the design’s sentence', () => {
    const out = engraveGenerate(tl, rotaryJob(goal((x) => Math.max(0, 4 + (x / 15) * -4))), BALL, [], null, undefined, {});
    expect(out.ok).toBe(false);
    expect(out.findings.some((f) => f.code === 'axis-crossing')).toBe(true);
  });

  it('refuses a part outside the free span', () => {
    const out = engraveGenerate(tl, rotaryJob(goal(CONE, { position: { x: 80, y: 0, z: 0 } })), BALL, [], null, undefined, {});
    expect(out.ok).toBe(false);
    expect(out.findings.some((f) => f.code === 'wrap-off-free-end')).toBe(true);
  });

  it('refuses a V-bit as the relief’s cutter', () => {
    const v = flatEndMill(0.3, { shape: 'engraving', name: '0.3 mm V', tipDiameter: 0.3, halfAngle: 15 });
    const out = engraveGenerate(tl, rotaryJob(goal(CONE)), v, [], null, undefined, {});
    expect(out.ok).toBe(false);
    expect(out.errors[0]?.message).toMatch(/cannot finish a rotary relief/);
  });
});
