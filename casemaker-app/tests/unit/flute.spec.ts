/**
 * #674 — FLUTES: a line cut with a Z profile instead of a plunge.
 *
 * The review seams. FUNNEL: the profile is derived once, in the plan (`plan.traces[].depths`), and
 * the CAM, the prediction and the picture read that one array. THE RAMP: the tool starts on the
 * surface and feeds down, so no move ever plunges to depth and none retracts out of a groove —
 * every cut stays at or above its point's depth. THE ORACLE: the prediction is one #408 groove per
 * SEGMENT at the segment's END depth, which is exactly the reduction both sweep engines make, so
 * the file, the sim and the oracle describe one staircase. A SHORT PATH: the ramps meet in the
 * middle and the groove never reaches the stated depth — a warning that names both numbers.
 */

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { createSimSession } from '@/workers/sim/session';
import { createEngravePreviewer } from '@/workers/sim/engravePreview';
import { preview } from './helpers/engravePipeline';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { jobTool, toSetup, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import {
  DEFAULT_FLUTE_RAMP_FACTOR,
  FLUTE_RAMP_STEPS,
  fluteNumbers,
  fluteOperationName,
  fluteProfile,
} from '@/engine/cnc/engrave/flute';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { EngraveJob, EngraveLineItem } from '@/types/engraveJob';

const TOOL_KEY = 'chamfer-90-vcarve';

/** A 90° V: tan(halfAngle) = 1, point tip. */
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

function line(extra: Partial<EngraveLineItem> = {}): EngraveLineItem {
  return {
    id: 'flute',
    name: 'grip',
    kind: 'line',
    position: { x: 20, y: 15 },
    rotation: 0,
    depth: 2,
    enabled: true,
    points: [
      [-15, 0],
      [15, 0],
    ],
    closed: false,
    flute: {},
    ...extra,
  };
}

function fluteJob(trace: EngraveLineItem = line(), over: Partial<EngraveJob> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: 40, width: 30 },
    labels: [],
    traces: [trace],
    toolKey: TOOL_KEY,
    tool: V_TOOL,
    shapes: [],
    ...over,
  };
}

const pathLength = (points: readonly [number, number][], closed: boolean): number => {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  if (closed) total += Math.hypot(points[0]![0] - points[points.length - 1]![0], points[0]![1] - points[points.length - 1]![1]);
  return total;
};

describe('fluteNumbers — one reading, the ramp labelled', () => {
  it('defaults the ramp to three times the depth, and says so', () => {
    const n = fluteNumbers({}, 2);
    expect(n.rampMm).toBe(DEFAULT_FLUTE_RAMP_FACTOR * 2);
    expect(n.rampSource).toBe('three times the depth');
    expect(n.depthMm).toBe(2);
  });

  it('keeps a typed ramp; falls back from a number the profile cannot run', () => {
    expect(fluteNumbers({ rampMm: 1.5 }, 2)).toMatchObject({ rampMm: 1.5, rampSource: 'typed' });
    const bad = fluteNumbers({ rampMm: 0 }, 2);
    expect(bad.rampMm).toBe(DEFAULT_FLUTE_RAMP_FACTOR * 2);
    expect(bad.rampSource).toBe('three times the depth');
  });

  it('names the operation as a Flute, not a Trace', () => {
    expect(fluteOperationName(line())).toBe('Flute line "grip" (2 points)');
  });
});

describe('the profile — ramps in and out, stepped by the plan itself', () => {
  it('starts and ends at the surface, holds the depth in the middle, and never exceeds it', () => {
    const p = fluteProfile([[-15, 0], [15, 0]], false, 2, 6);
    expect(p.depths[0]).toBe(0);
    expect(p.depths[p.depths.length - 1]).toBeCloseTo(0, 9);
    expect(Math.max(...p.depths)).toBeCloseTo(2, 9);
    // The middle third is at the full depth.
    const mid = p.points.findIndex(([x]) => x >= -1 && x <= 1);
    expect(mid).toBeGreaterThan(0);
    for (let i = 0; i < p.depths.length; i++) {
      const [x] = p.points[i]!;
      if (Math.abs(x) < 2) expect(p.depths[i]).toBeCloseTo(2, 6);
      expect(p.depths[i]!).toBeGreaterThanOrEqual(0);
      expect(p.depths[i]!).toBeLessThanOrEqual(2 + 1e-12);
    }
  });

  it('subdivides a two-point line until the staircase is depth/16', () => {
    const p = fluteProfile([[-15, 0], [15, 0]], false, 2, 6);
    // 30 mm at 6 mm ramps: two 6 mm ramps need at least 16 pieces each, so well over 32 points.
    expect(p.points.length).toBeGreaterThan(32);
    const step = 2 / FLUTE_RAMP_STEPS;
    for (let i = 1; i < p.depths.length; i++) {
      expect(Math.abs(p.depths[i]! - p.depths[i - 1]!)).toBeLessThanOrEqual(step + 1e-9);
    }
  });

  it('springs a closed ring open at the seam, so the closing ramp is sampled too', () => {
    const square: [number, number][] = [
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
    ];
    const p = fluteProfile(square, true, 1, 5);
    expect(p.depths[0]).toBe(0);
    // The ring's closing leg is explicit: the last point IS the first, at depth 0.
    expect(p.points[p.points.length - 1]).toEqual(p.points[0]);
    expect(p.depths[p.depths.length - 1]).toBeCloseTo(0, 9);
    expect(p.closed).toBe(false);
    expect(Math.max(...p.depths)).toBeCloseTo(1, 9);
  });

  it('peaks short when the path is shorter than its two ramps', () => {
    const p = fluteProfile([[0, 0], [4, 0]], false, 2, 6);
    expect(Math.max(...p.depths)).toBeCloseTo((2 * 4) / (2 * 6), 6);
  });

  it('is deterministic', () => {
    const a = fluteProfile([[-15, 0], [15, 0]], false, 2, 6);
    const b = fluteProfile([[-15, 0], [15, 0]], false, 2, 6);
    expect(b).toEqual(a);
  });
});

describe('the plan — the flute’s profile rides the trace entry', () => {
  it('carries one depth per (densified) point and names the operation a Flute', () => {
    const plan = toPartPlan(fluteJob());
    expect(plan.traces).toHaveLength(1);
    const trace = plan.traces[0]!;
    expect(trace.name).toBe('Flute line "grip" (2 points)');
    expect(trace.depth).toBe(2);
    expect(trace.depths).toHaveLength(1);
    expect(trace.paths[0]!.length).toBe(trace.depths![0]!.length);
    expect(trace.paths[0]!.length).toBeGreaterThan(2);
    expect(trace.depths![0]![0]).toBe(0);
  });

  it('leaves an unmarked line flat: no depths at all', () => {
    const plain = line({ flute: undefined });
    const plan = toPartPlan(fluteJob(plain));
    expect(plan.traces[0]!.depths).toBeUndefined();
    expect(plan.traces[0]!.name).toBe('Trace line "grip" (2 points)');
  });
});

describe('findings — the cutter and the short path', () => {
  const find = (job: EngraveJob, code: string) => validateJob(job).find((f) => f.code === code);

  it('refuses a cutter the trace path cannot take', () => {
    const ball = flatEndMill(3.175, { id: null, name: 'Ball 3.175', typeText: 'Ball End', shape: 'ball' });
    const f = find(fluteJob(line(), { tool: ball }), 'flute-tool');
    expect(f).toBeDefined();
    expect(f!.message).toContain('Ball 3.175');
  });

  it('warns when the ramps overlap, with both numbers', () => {
    const short = line({ points: [[-2, 0], [2, 0]] });
    const f = find(fluteJob(short), 'flute-short');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.message).toContain('4 mm long');
    expect(f!.message).toContain('0.667 mm');
    // The path is 4 mm and its two 6 mm ramps reach 0.667 mm at most.
    expect(f!.message).toContain('instead of the stated 2 mm');
  });

  it('raises nothing for a flute that fits its path', () => {
    expect(validateJob(fluteJob()).filter((f) => f.code.startsWith('flute-'))).toEqual([]);
  });
});

describe('the program and the oracle', () => {
  it('walks one continuous ramped feed: no plunge to depth, no retract from it', () => {
    const job = fluteJob();
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    expect(g.nc).not.toBeNull();
    const nc = g.nc as string;
    expect(nc).toContain('Flute line');
    const work = nc.split('\n').filter((l) => !l.includes('G53'));
    const zs = work.flatMap((l) => [...l.matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])));
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-2 - 1e-6);
    // The ramps are in the file: some cut is between the surface and the floor.
    expect(zs.some((z) => z < -0.5 && z > -1.9)).toBe(true);
    // Determinism: the same document posts the same program.
    const again = generate(tl, job);
    expect(again.nc).toBe(nc);
  }, 60_000);

  it('predicts one groove per segment at the segment’s end depth, and passes the oracle', () => {
    const job = fluteJob();
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const entries = g.predicted.filter((p) => p.itemId === 'flute');
    expect(entries.length).toBeGreaterThan(10);
    // Per segment: every entry carries a two-point path, and the depths are a RAMP, not one value.
    for (const entry of entries) {
      expect(entry.groove).toBeDefined();
      expect(entry.groove!.paths).toHaveLength(1);
      expect(entry.groove!.paths[0]).toHaveLength(2);
      expect(entry.polygons).toEqual([]);
    }
    const depths = [...new Set(entries.map((e) => e.depth))].sort((a, b) => a - b);
    expect(depths.length).toBeGreaterThan(5);
    expect(depths[0]).toBeGreaterThan(0);
    expect(depths[depths.length - 1]).toBeCloseTo(2, 6);

    const tool = jobTool(job);
    if (tool === null) throw new Error(`${TOOL_KEY} is not in the library`);
    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc as string, toSetup(job, Z1), tool, Z1.id);
      if (!load.ok) throw new Error(`simulation refused: ${JSON.stringify(load.diagnostics)}`);
      expect(session.oracle(g.predicted).ok).toBe(true);
    } finally {
      session.dispose();
    }
  }, 120_000);

  it('removes less than the same line cut flat — the ramps take nothing at the ends', () => {
    // A FLAT cutter, so both loads report a removal solid (a cone's removal is a column grid, not
    // a solid). The ramps are what the volumes differ by.
    const flat = flatEndMill(1, { id: null, name: '1 mm flat end', typeText: 'Flat End' });
    const fluted = fluteJob(line(), { toolKey: 'flat-1.0', tool: flat });
    const plain = fluteJob(line({ flute: undefined }), { toolKey: 'flat-1.0', tool: flat });
    const gf = generate(tl, fluted);
    const gp = generate(tl, plain);
    expect(gf.ok).toBe(true);
    expect(gp.ok).toBe(true);
    const tool = jobTool(fluted);
    if (tool === null) throw new Error('the flat cutter is not in the library');
    const volumeOf = (g: typeof gf): number => {
      const session = createSimSession(tl);
      try {
        const load = session.load(g.nc as string, toSetup(fluted, Z1), tool, Z1.id);
        if (!load.ok) throw new Error(`simulation refused: ${JSON.stringify(load.diagnostics)}`);
        const removal = load.meshes.removal as NodeMeshOutput;
        const body = new tl.Manifold(new tl.Mesh({ numProp: 3, vertProperties: removal.positions, triVerts: removal.indices }));
        const v = body.volume();
        body.delete();
        return v;
      } finally {
        session.dispose();
      }
    };
    const vf = volumeOf(gf);
    const vp = volumeOf(gp);
    expect(vf).toBeGreaterThan(0);
    // Two 6 mm ramps on a 30 mm path: the flute cannot remove more than the flat trace, and the
    // ramps leave real material at the ends.
    expect(vf).toBeLessThan(vp * 0.9);
  }, 180_000);

  it('states the ramp, the step and the peak on the run sheet', () => {
    const job = fluteJob();
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const texts = buildRunSheet(job, g, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    const step = texts.find((t) => t.includes('Flute line'));
    expect(step).toBeDefined();
    expect(step).toContain('6 mm at each end');
    expect(step).toContain('three times the depth');
    expect(step).toContain('steps of 0.125 mm');
    expect(step).toContain('no plunge dimple');
  }, 60_000);
});

describe('the picture — the ramps are drawn, not a constant-depth groove', () => {
  it('cuts the drawn stock at the ramp’s own depths', () => {
    const previewer = createEngravePreviewer(tl);
    const job = fluteJob();
    const p = preview(previewer, job, 1);
    expect(p).not.toBeNull();
    const volume = (mesh: NodeMeshOutput): number => {
      const body = new tl.Manifold(new tl.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
      const v = body.volume();
      body.delete();
      return v;
    };
    const uncut = job.stock.length * job.stock.width * job.stock.thickness;
    expect(uncut - volume(p!.stock)).toBeGreaterThan(0);
  }, 120_000);
});

describe('the document — the marker round-trips', () => {
  it('saves and parses the ramp unchanged, and keeps a stroke label flute-free', () => {
    const job = fluteJob(line({ flute: { rampMm: 1.5 } }));
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const trace = parsed.job.traces![0]!;
    expect(trace.kind).toBe('line');
    expect(trace.kind === 'line' ? trace.flute : undefined).toEqual({ rampMm: 1.5 });
  });

  it('refuses an unknown key in the marker, and a pre-#674 line has none', () => {
    const dto = JSON.parse(JSON.stringify(fluteJob())) as { traces: { flute: Record<string, unknown> }[] };
    dto.traces[0]!.flute = { rampMm: 1, gamma: 2 };
    expect(parseEngraveJob(dto).ok).toBe(false);
    const plain = parseEngraveJob(JSON.parse(JSON.stringify(fluteJob(line({ flute: undefined })))));
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    const kept = plain.job.traces![0]!;
    expect(kept.kind === 'line' ? kept.flute : null).toBeUndefined();
  });

  it('exposes the path length the finding and the sheet share', () => {
    expect(pathLength(line().points, false)).toBe(30);
  });
});
