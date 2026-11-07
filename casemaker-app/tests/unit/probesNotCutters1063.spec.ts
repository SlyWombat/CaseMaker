/**
 * #1063 — A PROBE IS NOT A CUTTER.
 *
 * The k3 shop inventory carries two instrument records (makera-wired-probe-v2 T9999,
 * makera-3d-probe T8888). They are not cutters at all: their typeText is 'Probe' and their shape
 * falls through to 'unknown'. Before this rule the planner asked them for feeds like any house
 * cutter, got a refusal, and stated one `goal-cutter-unfeedable` line each ("no cutting parameters
 * in … — not a candidate") — true of a cutter that cannot be fed, wrong for an instrument.
 *
 * The rule: `isCuttingRecord` (typeText 'Probe' or shape 'unknown' is NOT a cutter) filters the
 * house up front, and ONE aggregate statement names every instrument record instead.
 *
 * RED at m1-follow (217a4f518): two `goal-cutter-unfeedable` statements, no
 * `goal-cutter-instrument`.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, isCuttingRecord, type Tool } from '@/engine/cnc/tool';
import type { ParsedMesh } from '@/engine/import/stlParser';

const FLAT6 = flatEndMill(6, { number: 1, id: 'flat-6-1063', name: 'flat-6' });
const PROBE_V2: Tool = {
  ...flatEndMill(3.175, { number: 9999, id: 'probe-v2', name: 'Makera wired probe V2' }),
  typeText: 'Probe',
  shape: 'unknown',
};
const PROBE_3D: Tool = {
  ...flatEndMill(3.175, { number: 8888, id: 'probe-3d', name: 'Makera 3D probe' }),
  typeText: 'Probe',
  shape: 'unknown',
};

function block(): ParsedMesh {
  const solid = tl.Manifold.cube([20, 20, 10], true).translate([0, 0, 0]);
  const m = solid.getMesh();
  const n = m.vertProperties.length / m.numProp;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) positions[i * 3 + k] = m.vertProperties[i * m.numProp + k]!;
  const indices = new Uint32Array(m.triVerts);
  solid.delete();
  return {
    positions,
    indices,
    triangleCount: indices.length / 3,
    bbox: { min: [-10, -10, -10], max: [10, 10, 10] },
  };
}

const INPUT: ModelPlanInput = {
  geometry: { triangles: block() },
  setups: [{ frame: { up: [0, 0, 1], stockTop: 10, stockBottom: 0 }, underside: 'flatOnStockBottom' }],
  stock: { length: 20, width: 20, thickness: 10, material: 'pla' },
  fixture: { mount: 'tape', envelope: null },
  cutters: { house: [FLAT6, PROBE_V2, PROBE_3D], catalogue: [] },
  tolerances: { finishMm: 0.01 },
  edgeBreak: { legMm: 0 },
};

describe('#1063 isCuttingRecord', () => {
  it('a probe record is not a cutter, on either statement', () => {
    expect(isCuttingRecord({ typeText: 'Probe', shape: 'unknown' })).toBe(false);
    // Either statement alone is enough: a probe shape that classified (until #1053 gives it a real
    // shape), or an unknown shape that calls itself something else.
    expect(isCuttingRecord({ typeText: 'Probe', shape: 'flat' })).toBe(false);
    expect(isCuttingRecord({ typeText: 'Flat End', shape: 'unknown' })).toBe(false);
  });

  it('every ordinary cutter is one', () => {
    expect(isCuttingRecord({ typeText: 'Flat End', shape: 'flat' })).toBe(true);
    expect(isCuttingRecord({ typeText: 'Ball Nose', shape: 'ball' })).toBe(true);
    expect(isCuttingRecord({ typeText: 'Chamfer', shape: 'chamfer' })).toBe(true);
    expect(isCuttingRecord({ typeText: 'Drill', shape: 'drill' })).toBe(true);
  });
});

describe('#1063 the planner states instruments once, never as unfeedable candidates', () => {
  it('two probe records: one aggregate line, and no per-probe "no feeds" line', async () => {
    const out = await planModelCam(INPUT);
    const statements = out.perSetup.at(-1)!.statements;
    const instruments = statements.filter((s) => s.code === 'goal-cutter-instrument');
    expect(instruments).toHaveLength(1);
    expect(instruments[0]!.text).toBe(
      '2 inventory records are instruments, not cutters (Makera wired probe V2 and Makera 3D probe), and were not considered',
    );
    expect(instruments[0]!.severity).toBe('info');
    // The probes never reach the feed test: no unfeedable line names one of them.
    expect(statements.filter((s) => s.code === 'goal-cutter-unfeedable' && /probe/i.test(s.text))).toEqual([]);
    // The plan still ran on the real cutter.
    expect(out.perSetup[0]!.programs.length).toBeGreaterThan(0);
  });

  it('one instrument reads singular', async () => {
    const out = await planModelCam({ ...INPUT, cutters: { house: [FLAT6, PROBE_V2], catalogue: [] } });
    const line = out.perSetup.at(-1)!.statements.find((s) => s.code === 'goal-cutter-instrument');
    expect(line?.text).toBe('1 inventory record is an instrument, not a cutter (Makera wired probe V2), and was not considered');
  });
});
