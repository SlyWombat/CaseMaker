/**
 * #1117 — THE PRE-PLAN JAW-CLEARANCE CHECK, END TO END. The ref-tray70 shape: a 106 × 136 part on
 * a 110 × 140 blank (a 2 mm silhouette margin), the shipped Z1 vise, and a τ6-shank ball with a
 * 2 mm tip. The tip clears the moving jaw; the shank does not. The plan must REFUSE with the one
 * clamp-in-path sentence — nothing posted, no 29 sweep errors — while the same job on tape plans.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { tl } from './helpers/manifoldExec';

afterEach(() => clearTargetObjectMeshCache());

// The ref-tray70 part as a CLOSED box: its top at the stock top and its base H down — a freeable
// solid whose silhouette leaves a 2 mm rim on every side. (The #754 shell is an OPEN surface,
// which the plan rightly treats as a relief and never frees.)
// The ref-tray70 geometry at plan-scale: the same 2 mm rim and tall part, small enough that the
// plan is fast in a unit test.
const A = 15;
const B = 20;
const H = 6;
const STOCK = { length: 34, width: 44, thickness: 7 };

type V = [number, number, number];
type Tri = [V, V, V];

/** A closed box: ±A, ±B, −H..0 (top on the stock top), 12 triangles, outward winding. */
function boxTris(): Tri[] {
  const p = (x: number, y: number, z: number): V => [x, y, z];
  const a = [-A, -B, -H] as const;
  const b = [A, -B, -H] as const;
  const c = [A, B, -H] as const;
  const d = [-A, B, -H] as const;
  const e = [-A, -B, 0] as const;
  const f = [A, -B, 0] as const;
  const g = [A, B, 0] as const;
  const h = [-A, B, 0] as const;
  return [
    [p(...a), p(...c), p(...b)], [p(...a), p(...d), p(...c)], // bottom
    [p(...e), p(...f), p(...g)], [p(...e), p(...g), p(...h)], // top
    [p(...a), p(...b), p(...f)], [p(...a), p(...f), p(...e)], // front (y=-B)
    [p(...c), p(...d), p(...h)], [p(...c), p(...h), p(...g)], // back
    [p(...b), p(...c), p(...g)], [p(...b), p(...g), p(...f)], // right
    [p(...d), p(...a), p(...e)], [p(...d), p(...e), p(...h)], // left
  ];
}

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

function goal(): EngraveTargetObject {
  return {
    id: 'ref-tray70-shape',
    name: 'tray.stl',
    format: 'stl',
    sha256: 'a'.repeat(64),
    data: stl(boxTris()),
    size: { x: 2 * A, y: 2 * B, z: H },
    // The real job's own setting: the plan stops at the cutter's reach.
    cutWithinReach: true,
    position: { x: STOCK.length / 2, y: STOCK.width / 2, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

/** A flat beside the ball, so the plan frees the part; the contour runs on the chain's last
 *  cutter — here the 6 mm-shank ball, exactly the real job's collision. */
const FLAT = flatEndMill(3.175, { id: 'inv:lib-flat-3175', name: '3.175 mm flat', fluteLength: 25 });

/** τ2 tip on a τ6 shank, 30.5 mm flute — the real job's `inv:lib-161032205031` geometry. */
const BALL: Tool = flatEndMill(2, {
  id: 'inv:lib-161032205031',
  name: '6 mm shank, 2 mm ball',
  shape: 'ball',
  typeText: 'Ball Nose',
  handleDiameter: 6,
  fluteLength: 30.5,
});

/** The real job's vise and clearance, its stock, and the goal 2 mm inside on every side. */
function job(workholding: EngraveJob['workholding']): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, ...STOCK },
    jawClearance: 1,
    workholding,
    targetObject: goal(),
    toolKey: 'inv:lib-161032205031',
    tool: BALL,
  };
}

const VISE: EngraveJob['workholding'] = {
  kind: 'vise',
  vise: {
    stockProud: 4,
    fixedJawThickness: 10,
    movingJawThickness: 10,
    jawLength: 100,
    jawStartY: -10,
    source: 'default',
    uncertainty: 0.5,
  },
};

const TAPE: EngraveJob['workholding'] = {
  kind: 'tape',
  tape: { width: 25, thickness: 0.1, inset: 2, where: null, squareTo: 'front', source: 'default' },
};

describe('#1117 the plan refuses a shank that reaches a jaw, and only then', () => {
  it('the vise job refuses at plan stage with ONE clamp-in-path sentence and posts nothing', async () => {
    const out = await engraveGenerate(tl, job(VISE), BALL, [], null, undefined, { tools: [
      { key: 'inv:lib-flat-3175', tool: FLAT, provenance: 'spec' },
      { key: 'inv:lib-161032205031', tool: BALL, provenance: 'spec' },
    ] });
    expect(out.ok).toBe(false);
    expect(out.stage).toBe('findings');
    expect(out.nc).toBeNull();
    const findings = out.findings.filter((f) => f.code === 'clamp-in-path');
    expect(findings).toHaveLength(1);
    // The sentence states the numbers it judged — the shank, the rim, the jaw — at plan stage.
    // (The pure cases pin the exact wording and figures on the ref-tray70 6 mm-shank geometry;
    // here the plan's own contour decides which cutter runs it.)
    expect(findings[0]!.message).toContain('mm shank');
    expect(findings[0]!.message).toContain('from the stock’s edge');
    expect(findings[0]!.message).toMatch(/jaw \((left|right)\)/);
    expect(findings[0]!.message).toContain('plan stage');
    expect(findings[0]!.message).toContain('is no wider than');
    // No verify report for a program that never posted, and no sweep to raise its 29 errors.
    expect(out.verify).toBeNull();
  }, 300_000);

  it('the same job on tape plans: the check is the VISE’s, not the contour’s', async () => {
    const out = await engraveGenerate(tl, job(TAPE), BALL, [], null, undefined, { tools: [
      { key: 'inv:lib-flat-3175', tool: FLAT, provenance: 'spec' },
      { key: 'inv:lib-161032205031', tool: BALL, provenance: 'spec' },
    ] });
    expect(out.ok).toBe(true);
    expect(out.nc).not.toBeNull();
    expect(out.findings.some((f) => f.code === 'clamp-in-path')).toBe(false);
  }, 300_000);
});
