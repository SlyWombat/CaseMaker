/**
 * #665 — V-CARVE (VARIABLE DEPTH): the medial-axis depth map, cut as a ladder of level sets, with
 * the flat bottom where the V cannot reach.
 *
 * The two review seams first: the ORDER the material comes out in — the ladder is shallowest first,
 * each pass riding over the groove the one before it opened, and the core stands until the rest
 * program clears it — and the DOCUMENT (a mixed, non-happy round trip). The oracle test then
 * sweeps the ladder and checks the ring at the cap, which is exactly the prediction that says the
 * core was NOT cut by the V.
 *
 * Real Manifold, real sweep, plain Node — the harness `boreCam.spec.ts` uses.
 */

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate, regions as cutRegions } from './helpers/engravePipeline';
import { createSimSession, type SimLoadOk, type SimSession } from '@/workers/sim/session';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, toSetup, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { vCone } from '@/engine/cnc/vProfile';
import { vCarveLevels } from '@/engine/cnc/vCarveGeometry';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import type { EngraveJob, EngraveShape, JobSetup } from '@/types/engraveJob';

const TOOL_KEY = 'chamfer-90-vcarve';

/**
 * A 90° cone: a V-bit in everything the carve asks (the flank at 45°, a point tip, the feeds
 * resolved from the flat row for its cutting diameter — the same choice #669 made for a chamfer).
 */
const V_TOOL: Tool = flatEndMill(3.175, {
  id: null,
  name: '3.175 mm 90° V',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: null,
  diameter: 3.175,
  angle: 90,
  halfAngle: null,
});

const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;

function setup(id: string, itemIds: string[], tools: string[]): JobSetup {
  return { id, orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds, tools };
}

/** A rect shape, 20 × 10 — wide enough that the V cannot reach its centre at a 0.5 mm cap. */
function rect(id: string, variable: boolean, extra: Partial<EngraveShape> = {}): EngraveShape {
  return {
    id,
    name: 'plate',
    kind: 'rect',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 0.5,
    enabled: true,
    width: 20,
    height: 10,
    cornerRadius: 0,
    ...(variable ? { vCarveDepth: 'variable' as const } : {}),
    ...extra,
  } as EngraveShape;
}

function variableJob(extra: Partial<EngraveShape> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [],
    traces: [],
    toolKey: TOOL_KEY,
    tool: V_TOOL,
    // 0.25 mm a level: the step-down and the step-over (converted down the 45° flank) agree.
    cutOverride: { stepDown: 0.25, stepOver: 0.25 },
    shapes: [rect('plate', true, extra)],
    setups: [setup('setup-1', ['plate'], [TOOL_KEY])],
  };
}

function operationNames(g: { nc: string | null }): string[] {
  return (g.nc ?? '')
    .split('\n')
    .filter((line) => line.startsWith(';@MKR|TOOLPATH|'))
    .map((line) => line.slice(line.indexOf('name=') + 'name='.length));
}

describe('variable-depth V-carve (#665)', () => {
  it('plans the flag, and refuses a cutter that is not a cone', () => {
    const plan = toPartPlan(variableJob());
    expect(plan.engraves[0]?.variableDepth).toBe(true);

    const flat: EngraveJob = { ...variableJob(), tool: flatEndMill(3.175, { name: '3.175 flat' }) };
    const f = validateJob(flat).find((x) => x.code === 'vcarve-variable-needs-cone');
    expect(f?.severity).toBe('error');
    expect(f?.message).toContain('3.175 flat');
    // A PLANE V-carve on the same flat cutter is not this finding: it is refused by the V gates.
    const plane: EngraveJob = { ...flat, shapes: [rect('plate', false)] };
    expect(validateJob(plane).map((x) => x.code)).not.toContain('vcarve-variable-needs-cone');
  });

  it('cuts the ladder shallowest first, one Z per level, and never deeper than the row allows', () => {
    const job = variableJob();
    const { chamfers: _c, ...regions } = cutRegions(tl, job);
    expect(regions.regions).toHaveLength(1);
    const ir = generate(tl, job);
    expect(
      ir.ok,
      JSON.stringify({ stage: ir.stage, errors: ir.errors, findings: ir.findings.filter((f) => f.severity === 'error').map((f) => f.code) }),
    ).toBe(true);
    expect(ir.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);

    const cone = vCone(V_TOOL)!;
    const levels = vCarveLevels(cone, 0.5, 0.25);
    expect(levels.map((l) => l.depth)).toEqual([0.25, 0.5]);

    // The movess: each cut at a level's own Z, and the Z sequence never dives before a shallower
    // level has run — the ladder is outside-in.
    const names = operationNames(ir);
    expect(names.some((n) => n.startsWith('[T1]Pocket rect') && n.includes('0.5mm'))).toBe(true);
    const nc = ir.nc ?? '';
    const zs = [...nc.matchAll(/^G1 .*Z(-[\d.]+)/gm)].map((m) => Number(m[1]));
    expect(zs.length).toBeGreaterThan(0);
    const depths = [...new Set(zs.map((z) => Math.abs(z)))].sort((a, b) => a - b);
    // Every cut is one of the ladder's levels (the plunge feeds land on them too).
    for (const d of depths) expect(levels.some((l) => Math.abs(l.depth - d) < 1e-6 || d === 0)).toBe(true);
    // The first cutting Z is the shallowest rung, not the cap.
    expect(Math.abs(zs[0]!)).toBeCloseTo(0.25, 6);
    // And the deepest is the cap.
    expect(Math.max(...zs.map(Math.abs))).toBeCloseTo(0.5, 6);
  }, 90_000);

  it('predicts the ring at the cap — the core is what the V does NOT cut', () => {
    const job = variableJob();
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const cap = g.predicted.filter((p) => Math.abs(p.depth - 0.5) < 1e-9);
    expect(cap).toHaveLength(1);
    // The design's area at the cap is the whole rect eroded by the cap; the core is the middle the
    // tip flat cannot reach, and the prediction must exclude it.
    // The ring is an outer contour and a hole: sum the SIGNED areas so the hole subtracts.
    const area = (polygons: readonly (readonly (readonly [number, number])[])[]): number => {
      let total = 0;
      for (const ring of polygons) {
        let sum = 0;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]!;
          const b = ring[(i + 1) % ring.length]!;
          sum += a[0] * b[1] - b[0] * a[1];
        }
        total += sum / 2;
      }
      return Math.abs(total);
    };
    // At the CAP a POINT tip removes exactly its own width — zero — so the cap's ring is empty;
    // the floor the V reaches at the cap is a line at the wall, and the whole middle stands.
    expect(area(cap[0]!.polygons)).toBeCloseTo(0, 1);
    // The shallow level is the ring between `0.1·cap` and where the deepest pass's inner flank
    // has risen back to that level: (2·cap − 0.1·cap)·tan on a 20 × 10 rect.
    const shallow = g.predicted.find((p) => Math.abs(p.depth - 0.05) < 1e-9);
    expect(shallow).toBeDefined();
    const outer = (20 - 2 * 0.05) * (10 - 2 * 0.05);
    const inner = (20 - 2 * 0.95) * (10 - 2 * 0.95);
    expect(area(shallow!.polygons)).toBeCloseTo(outer - inner, 1);
  }, 60_000);

  it('passes the oracle on the ladder, with the core standing', () => {
    const job = variableJob();
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const tool = jobTool(job);
    if (tool === null) throw new Error(`${TOOL_KEY} is not in the tool library`);
    const session: SimSession = createSimSession(tl);
    try {
      const load: SimLoadOk = (() => {
        const l = session.load(g.nc as string, toSetup(job, Z1), tool, Z1.id);
        if (!l.ok) throw new Error(`simulation refused: ${JSON.stringify(l.diagnostics)}`);
        return l;
      })();
      expect(load.diagnostics.filter((d) => d.code === 'rapid-through-stock')).toEqual([]);
      expect(session.oracle(g.predicted).ok).toBe(true);
    } finally {
      session.dispose();
    }
  }, 90_000);

  it('names the standing core when the setup carries no flat cutter to clear it', () => {
    // #677 — one cutter in the setup means no core program: the warning states the area and the
    // depth and says which cutter to add. With a flat end mill after the V the engine clears the
    // core itself and raises nothing (see `vCarveCore.spec.ts`).
    const g = generate(tl, variableJob());
    const f = g.findings.find((x) => x.code === 'vcarve-variable-core');
    expect(f?.severity).toBe('warning');
    expect(f?.message).toContain('Add a flat end mill after');
    expect(f?.message).toContain('in setup 1');
    expect(f?.message).toContain('is not reached by the V');
  }, 60_000);

  it('states the ladder and the flat bottom on the run sheet', () => {
    const job = variableJob();
    const g = generate(tl, job);
    const texts = buildRunSheet(job, g, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    const step = texts.find((t) => t.includes('VARIABLE depth'));
    expect(step).toBeDefined();
    expect(step).toContain('the V follows the design’s width');
    expect(step).toContain('2 levels');
    // #677 — no flat cutter is set up on this job, so the step says what to add; with the clearance
    // program present it names the cutter and the program instead.
    expect(step).toContain('add a flat end mill to the setup');
  }, 60_000);
});

describe('variable-depth document (#665)', () => {
  it('round-trips a MIXED, non-happy job', () => {
    const job: EngraveJob = {
      ...variableJob(),
      shapes: [rect('plate', true), rect('plain', false, { position: { x: 50, y: 45 }, width: 10, height: 6 })],
      setups: [setup('setup-1', ['plate', 'plain'], [TOOL_KEY])],
    };
    const parsed = parseEngraveJob(job);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.shapes[0]!.vCarveDepth).toBe('variable');
    // A plane shape keeps NO key — the pre-#665 document round-trips byte for byte.
    expect('vCarveDepth' in parsed.job.shapes[1]!).toBe(false);
    // A value the schema does not know is refused outright.
    expect(
      parseEngraveJob({
        ...job,
        shapes: [{ ...rect('plate', true), vCarveDepth: 'medial' }] as unknown as EngraveShape[],
      }).ok,
    ).toBe(false);
  });
});
