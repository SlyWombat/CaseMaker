// #1164 a — THE ROTARY RELIEF'S PLANNING PITCH. The goal's own `surface.gridPitchMm` wins whenever
// it states one; the shop's `relief.planningPitchMm` (#1207 key, recommendation 1 mm) is read ONLY
// when the goal states none. The probe is the tip-field budget: this slab's true-ray stencil at a
// 0.1 mm planning pitch needs 435,047,415 column evaluations (over the 300,000,000 budget, and
// 8.6 s measured when forced), while the same plan at 1 mm needs ~10^5 — so "did the plan use this
// pitch?" has an observable, discriminating answer in both directions.
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { engraveGenerate, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { tl } from './helpers/manifoldExec';
import { stl } from './helpers/meshes';

type V = [number, number, number];
type Tri = [V, V, V];

/** A thin slab 0.5–0.7 mm from the axis: ρ_min = 0.5 mm « the ball, so the reach is 90° and the
 *  stencil at a fine pitch is huge. */
function slab(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Tri[] {
  const v = (x: number, y: number, z: number): V => [x, y, z];
  return [
    [v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1)], [v(x0, y1, z0), v(x1, y1, z1), v(x0, y1, z1)],
    [v(x0, y0, z1), v(x1, y0, z1), v(x1, y0, z0)], [v(x0, y0, z1), v(x1, y0, z0), v(x0, y0, z0)],
    [v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1)], [v(x0, y0, z1), v(x1, y1, z1), v(x0, y1, z1)],
    [v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0)], [v(x0, y1, z0), v(x1, y0, z0), v(x0, y0, z0)],
    [v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1)], [v(x1, y0, z0), v(x1, y1, z1), v(x1, y0, z1)],
    [v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)], [v(x0, y0, z1), v(x0, y1, z0), v(x0, y0, z0)],
  ];
}

let serial = 0;

function goal(gridPitchMm: number | undefined): EngraveTargetObject {
  return {
    id: 'part',
    name: 'slab.stl',
    format: 'stl',
    sha256: (serial++).toString(16).padStart(64, 'e'),
    data: stl(slab(-10, 10, 0.5, 0.7, -5, 5)),
    size: { x: 20, y: 0.2, z: 10 },
    position: { x: 30, y: 0, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...(gridPitchMm === undefined ? {} : { surface: { gridPitchMm } }),
  };
}

const BALL = flatEndMill(2, { shape: 'ball', name: '2 mm ball', fluteLength: 12, shoulderLength: 20 });

function job(gridPitchMm: number | undefined): EngraveJob {
  return {
    ...defaultEngraveJob(),
    name: 'relief planning pitch',
    stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { stickout: 60, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' },
    },
    labels: [],
    shapes: [],
    targetObject: goal(gridPitchMm),
    toolKey: 'ball-2',
  };
}

/** A shop whose only stated default is the relief planning pitch (a partial map: every other key
 *  falls back to its labelled default). */
function shopWithPlanningPitch(pitchMm: number | null): EngraveShopOpts {
  if (pitchMm === null) return {};
  return {
    defaults: {
      'relief.planningPitchMm': { value: pitchMm, source: 'chosen', setAt: null, unit: 'mm', note: '' },
    } as unknown as ShopDefaults,
  };
}

const budgetRefusal = (out: Awaited<ReturnType<typeof engraveGenerate>>): boolean =>
  out.errors.some((e) => /drop-tip field .*over the .* budget/.test(e.message));

describe('#1164 a the relief planning pitch: the goal owns it, the key fills in only when it states none', () => {
  it('a goal with NO surface grid plans on the key’s fallback (1 mm) and posts', async () => {
    const out = await engraveGenerate(tl, job(undefined), BALL, [], null, undefined, {});
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.programs).toHaveLength(1);
  }, 120_000);

  it('the key IS read when the goal states none — a 0.1 mm key refuses on the tip budget', async () => {
    const out = await engraveGenerate(tl, job(undefined), BALL, [], null, undefined, shopWithPlanningPitch(0.1));
    expect(out.ok).toBe(false);
    expect(budgetRefusal(out), out.errors.map((e) => e.message).join('; ')).toBe(true);
  }, 120_000);

  it('a goal stating surface.gridPitchMm KEEPS its own pitch — 0.1 wins over a 1 mm key', async () => {
    const out = await engraveGenerate(tl, job(0.1), BALL, [], null, undefined, shopWithPlanningPitch(1));
    expect(out.ok).toBe(false);
    expect(budgetRefusal(out), out.errors.map((e) => e.message).join('; ')).toBe(true);
  }, 120_000);

  it('…and a stated 1 mm wins over a 0.1 mm key, so the key is not consulted', async () => {
    const out = await engraveGenerate(tl, job(1), BALL, [], null, undefined, shopWithPlanningPitch(0.1));
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.programs).toHaveLength(1);
  }, 120_000);
});
