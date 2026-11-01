// #241 slice 2 — THE 'ON A FACE' OPERATIONS, end to end: the job's face list → the indexed CAM's
// faces and holes → the post → the verifier → the exact sweeper → the per-face oracle.
//
// The face is a POCKET at Z = R − d whose passes step over in Y while A is held. Two things are
// pinned here that the design rests on: a program whose A never changes inside a cut may move Y
// (the narrowed post and verifier contract), and the swept face is the analytic chord segment, so
// the oracle agrees with the design rather than with the tool's own facets.

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';
import { feedsFor } from '@/engine/cnc/feeds';
import { generateIndexed } from '@/engine/cnc/cam/indexed';
import { postZ1 } from '@/engine/cnc/post/z1';
import { verifyProgram } from '@/engine/cnc/verify';
import { buildTimeline, parseGcode } from '@/engine/cnc';
import {
  defaultFaceOperation,
  faceChordMm,
  faceJobRefusal,
  planFaceCuts,
} from '@/engine/cnc/rotary/faceOps';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { createSimSession } from '@/workers/sim/session';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { engraveJobSchema } from '@/store/engraveJobSchema';
import type { EngraveFaceOp, EngraveJob } from '@/types/engraveJob';

const TOOL = flatEndMill(3.175, { name: '3.175 mm flat end', handleDiameter: 3.175 });

/** A rod in the chuck: the axis frame L × D × D, an 85 mm stick-out and no tailstock. */
function rod(faces: EngraveFaceOp[], over: Partial<EngraveJob> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'faces on a rod',
    stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' },
    },
    labels: [],
    shapes: [],
    toolKey: 'flat-3.175x12-metal',
    faces,
    ...over,
  };
}

const flat = (id: string, a: number, depth: number): EngraveFaceOp => ({ id, kind: 'flat', a, depth });

describe('#241 slice 2 — the face model', () => {
  it('a face at depth d is as wide as the chord there', () => {
    // ⌀20 at 1 mm deep: 2√(100 − 81) = 8.718 mm; at 5 mm it is half the rod (10 mm); at the axis 0.
    expect(faceChordMm(10, 1)).toBeCloseTo(8.717797887, 6);
    expect(faceChordMm(10, 5)).toBeCloseTo(17.3205080757, 6);
    expect(faceChordMm(10, 0)).toBe(0);
  });

  it('the shipped defaults are §5’s: 0°/1 mm flat, a hex at 17.321 across on ⌀20, the cutter’s hole', () => {
    expect(defaultFaceOperation('flat', 10, 3.175)).toEqual({ kind: 'flat', a: 0, depth: 1 });
    expect(defaultFaceOperation('faces-all-round', 10, 3.175)).toEqual({
      kind: 'faces-all-round',
      a: 0,
      count: 6,
      acrossFlats: 17.321,
    });
    expect(defaultFaceOperation('cross-hole', 10, 3.175)).toEqual({ kind: 'cross-hole', a: 0, diameter: 3.175 });
  });

  it('a Flat becomes one face pocket, cut by several Y passes when the cutter is narrower than the chord', () => {
    const job = rod([flat('f1', 0, 1)]);
    const map = rotaryMapOf(job)!;
    const feeds = feedsFor([], job.stock.material, TOOL, Z1);
    expect(feeds.ok).toBe(true);
    if (!feeds.ok) return;
    const plan = planFaceCuts(job, map, TOOL, feeds.params);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.plan.faces).toHaveLength(1);
    const face = plan.plan.faces[0]!;
    expect(face.a).toBe(0);
    expect(face.depth).toBe(1);
    expect(face.width).toBeCloseTo(faceChordMm(10, 1), 9);
    // Between the jaws' keep-out and the free end, a cutter radius clear at each end.
    expect(face.fromX).toBeCloseTo(3 + 1.5875, 9);
    expect(face.toX).toBeCloseTo(85 - 1.5875, 9);
    // The prediction is the swept region, one capsule per pass — more than one pass over 8.718 mm
    // with a 3.175 mm cutter.
    expect(plan.plan.predicted).toHaveLength(1);
    expect(plan.plan.predicted[0]!.a).toBe(0);
    expect(plan.plan.predicted[0]!.polygons.length).toBeGreaterThan(3);
  });

  it('Faces all round is n faces at a + k·360/n, each the chord at the across-flats depth', () => {
    const op: EngraveFaceOp = { id: 'hex', kind: 'faces-all-round', a: 10, count: 6, acrossFlats: 17.321 };
    const job = rod([op]);
    const map = rotaryMapOf(job)!;
    const feeds = feedsFor([], job.stock.material, TOOL, Z1);
    if (!feeds.ok) throw new Error(feeds.reason);
    const plan = planFaceCuts(job, map, TOOL, feeds.params);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.plan.faces.map((f) => f.a)).toEqual([10, 70, 130, 190, 250, 310]);
    // depth = R − acrossFlats/2 = 10 − 8.6605 = 1.3395, whose chord is the hexagon's side, 10 mm.
    for (const face of plan.plan.faces) {
      expect(face.depth).toBeCloseTo(1.3395, 4);
      expect(face.width).toBeCloseTo(10, 2);
    }
  });

  it('a cross-hole is one through plunge at the free span’s middle, and its prediction is the cutter’s disc', () => {
    const op: EngraveFaceOp = { id: 'h', kind: 'cross-hole', a: 90, diameter: 3.175 };
    const job = rod([op]);
    const map = rotaryMapOf(job)!;
    const feeds = feedsFor([], job.stock.material, TOOL, Z1);
    if (!feeds.ok) throw new Error(feeds.reason);
    const plan = planFaceCuts(job, map, TOOL, feeds.params);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.plan.holes).toHaveLength(1);
    expect(plan.plan.holes[0]!.a).toBe(90);
    expect(plan.plan.holes[0]!.x).toBeCloseTo((3 + 85) / 2, 9);
    expect(plan.plan.holes[0]!.depth).toBeCloseTo(20 + job.breakthrough, 9);
    expect(plan.plan.predicted[0]!.depth).toBeCloseTo(20 + job.breakthrough, 9);
  });

  it('refuses a depth at the axis, a non-flat cutter, and a job that also carries map items', () => {
    const feeds = feedsFor([], 'pla', TOOL, Z1);
    if (!feeds.ok) throw new Error(feeds.reason);
    const tooDeep = rod([flat('f', 0, 10)]);
    const d = planFaceCuts(tooDeep, rotaryMapOf(tooDeep)!, TOOL, feeds.params);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.findings.map((f) => f.code)).toContain('face-too-deep');

    const cylinder = rod([flat('f', 0, 1)]);
    const ball = { ...flatEndMill(3.175, { name: '3.175 mm ball', handleDiameter: 3.175 }), shape: 'ball' as const };
    const b = planFaceCuts(cylinder, rotaryMapOf(cylinder)!, ball, feeds.params);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.findings.map((f) => f.code)).toContain('face-needs-flat-tool');

    const mixed = rod([flat('f', 0, 1)], {
      labels: [{ ...defaultEngraveJob().labels[0]!, text: 'X', id: 'l1' } as EngraveJob['labels'][number]],
    });
    expect(faceJobRefusal(mixed)?.code).toBe('face-items-mixed');

    const viseArm = defaultEngraveJob().workholding as Extract<EngraveJob['workholding'], { kind: 'vise' }>;
    const vise = rod([flat('f', 0, 1)], { workholding: viseArm });
    expect(faceJobRefusal(vise)?.code).toBe('face-needs-chuck');
  });

  it('a cross-hole whose diameter is not the cutter’s is a warning naming what comes out', () => {
    const op: EngraveFaceOp = { id: 'h', kind: 'cross-hole', a: 0, diameter: 5 };
    const job = rod([op]);
    const feeds = feedsFor([], job.stock.material, TOOL, Z1);
    if (!feeds.ok) throw new Error(feeds.reason);
    const plan = planFaceCuts(job, rotaryMapOf(job)!, TOOL, feeds.params);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const warning = plan.findings.find((f) => f.code === 'cross-hole-cutter');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('⌀3.17 mm');
  });

  it('round-trips through the schema, and refuses a flat with no depth', () => {
    const job = rod([flat('f1', 0, 1)]);
    const parsed = engraveJobSchema.safeParse(job);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.faces).toEqual(job.faces);

    const broken = rod([{ id: 'f', kind: 'flat', a: 0 } as EngraveFaceOp]);
    expect(engraveJobSchema.safeParse(broken).success).toBe(false);
  });
});

describe('#241 slice 2 — a face program, generated and swept', () => {
  it('a flat on ⌀20: the post writes Y only while A is held, the verifier passes, and the face matches the chord', () => {
    const job = rod([flat('f1', 0, 1)], { stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 } });
    // A short stick-out keeps the exact sweep quick.
    job.workholding = { kind: 'rotary-chuck', rotary: { stickout: 40, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' } };
    const g = engraveGenerate(tl, job, TOOL, [], null);
    expect(g.errors, JSON.stringify({ findings: g.findings, verify: g.verify?.findings })).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.frame).toBe('rotary');
    expect(g.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);
    const nc = g.nc ?? '';
    // The Y rule: no line carries both an A word and a non-zero Y.
    for (const line of nc.split('\n')) {
      const m = /^G[01]\s/.exec(line);
      if (!m) continue;
      const a = /\bA(-?[\d.]+)/.exec(line);
      const y = /\bY(-?[\d.]+)/.exec(line);
      if (a !== null && y !== null) expect(Number(y[1])).toBe(0);
    }
    expect(nc).toMatch(/\bY-?[1-9]/); // some Y move did happen — the face pocket steps over
    const timeline = buildTimeline(parseGcode(nc), toSetup(job, Z1));
    expect(timeline.summary.rotaryClass).toBe('indexed');

    const session = createSimSession(tl);
    const loaded = session.load(nc, toSetup(job, Z1), TOOL, Z1.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.stats.engine).toBe('exact');
    const report = session.oracle(g.predicted);
    session.dispose();
    expect(report.ok, JSON.stringify(report.levels)).toBe(true);
    expect(report.levels.map((l) => l.a)).toEqual([0]);
    expect(report.levels[0]!.underCut).toBe(0);
    expect(report.levels[0]!.overCut).toBe(0);
  }, 240_000);

  it('a hex all round, generated from the wizard’s numbers: six faces, each judged at its own A', () => {
    const job = rod([{ id: 'hex', kind: 'faces-all-round', a: 0, count: 6, acrossFlats: 17.321 }]);
    job.workholding = { kind: 'rotary-chuck', rotary: { stickout: 40, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' } };
    const g = engraveGenerate(tl, job, TOOL, [], null);
    expect(g.ok, JSON.stringify(g.findings)).toBe(true);
    expect(g.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);
    const session = createSimSession(tl);
    const loaded = session.load(g.nc ?? '', toSetup(job, Z1), TOOL, Z1.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const report = session.oracle(g.predicted);
    session.dispose();
    expect(report.ok, JSON.stringify(report.levels)).toBe(true);
    expect(report.levels.map((l) => l.a)).toEqual([0, 60, 120, 180, 240, 300]);
  }, 300_000);

  it('the run sheet builds for a face job', () => {
    const job = rod([flat('f1', 0, 1)]);
    job.workholding = { kind: 'rotary-chuck', rotary: { stickout: 40, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' } };
    const g = engraveGenerate(tl, job, TOOL, [], null);
    expect(g.ok).toBe(true);
    const sheet = buildRunSheet(job, g, null);
    expect(sheet).toBeTruthy();
  }, 120_000);

  it('a cross-hole through at 90° is one plunge, judged on the face it was drilled from', () => {
    const job = rod([{ id: 'h', kind: 'cross-hole', a: 90, diameter: 3.175 }]);
    job.workholding = { kind: 'rotary-chuck', rotary: { stickout: 40, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' } };
    const g = engraveGenerate(tl, job, TOOL, [], null);
    expect(g.ok, JSON.stringify(g.findings)).toBe(true);
    expect(g.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);
    const session = createSimSession(tl);
    const loaded = session.load(g.nc ?? '', toSetup(job, Z1), TOOL, Z1.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const report = session.oracle(g.predicted);
    session.dispose();
    expect(report.ok, JSON.stringify(report.levels)).toBe(true);
    expect(report.levels.map((l) => l.a)).toEqual([90]);
  }, 240_000);
});

describe('#241 slice 2 — the narrowed Y contract', () => {
  it('the post refuses a Y move on a line that changes A, and writes Y on a line that does not', () => {
    const base = {
      radius: 10,
      tool: TOOL,
      params: { rpm: 12000, feed: 800, plungeFeed: 200, stepDown: 1, stepOver: 1, peck: 1, air: true },
      rapid: Z1.rapidEstimate,
    };
    const okIr = generateIndexed({ ...base, faces: [{ a: 0, fromX: 5, toX: 30, depth: 1, width: 8 }] });
    const okPost = postZ1(okIr, ctx(), Z1);
    expect(okPost.ok).toBe(true);
    if (okPost.ok) expect(okPost.text).toMatch(/\bY-?[1-9][\d.]*/);

    const badIr = {
      ...okIr,
      operations: okIr.operations.map((op, i) =>
        i === 0 ? { ...op, moves: op.moves.map((m, j) => (j === 0 ? { ...m, y: 4 } : m)) } : op,
      ),
    };
    const badPost = postZ1(badIr, ctx(), Z1);
    expect(badPost.ok).toBe(false);
    if (!badPost.ok) expect(badPost.errors.join(' ')).toContain('Y=4');
  });

  it('a wrapped file with a Y move is still refused, and an indexed file may move Y at a held A', () => {
    const setup = toSetup(rod([]), Z1);
    const wrapped = ['%', 'G17 G21 G54 G90', 'M5', 'T1M6', 'G01 Z15 F200', 'G01 Y0 Z15', 'M3 S12000', 'G1 X5 Y3 Z9 A0 F500', 'G1 X10 Y3 Z9 A0', 'G1 X10 Y3 Z9 A5', 'G92.4A0S0', 'M9', 'M5', 'M30'].join('\n');
    const w = verifyProgram(wrapped, {
      setup,
      machine: Z1,
      tool: TOOL,
      depthLimit: () => 20,
      minRapidZ: 1,
      rotary: { radius: 10, stickout: 40, tailstock: false },
    });
    expect(w.findings.some((f) => f.code === 'rotary-y-off-axis')).toBe(true);

    const indexed = ['%', 'G17 G21 G54 G90', 'M5', 'T1M6', 'G01 Z15 F200', 'G01 Y0 Z15', 'M3 S12000', 'G0 X5 Y0 Z15 A0', 'G1 X5 Y0 Z9 F500', 'G1 X5 Y3 Z9', 'G1 X10 Y3 Z9', 'G0 X10 Y0 Z15', 'G0 X10 Y0 Z15 A90', 'G92.4A0S0', 'M9', 'M5', 'M30'].join('\n');
    const x = verifyProgram(indexed, {
      setup,
      machine: Z1,
      tool: TOOL,
      depthLimit: () => 20,
      minRapidZ: 1,
      rotary: { radius: 10, stickout: 40, tailstock: false },
    });
    expect(x.findings.some((f) => f.code === 'rotary-y-off-axis'), JSON.stringify(x.findings)).toBe(false);
  });
});

/** A post context for the rotary frame. */
function ctx(): {
  jobName: string;
  stock: { length: number; width: number; thickness: number };
  materialName: string;
  zDatum: 'rotary-axis';
  origin: 'topFrontLeft';
  camVersion: string;
  toolKey: string;
} {
  return {
    jobName: 'face pocket',
    stock: { length: 30, width: 20, thickness: 20 },
    materialName: 'pla',
    zDatum: 'rotary-axis',
    origin: 'topFrontLeft',
    camVersion: '1.0.0',
    toolKey: 'flat-3.175x12-metal',
  };
}

// The store's own write path: the wizard's Create and the panel's add both land here.
describe('#241 slice 2 — the store', () => {
  it('adds, edits and removes a face operation, in cut order', () => {
    useEngraveJobStore.setState({ job: rod([]) });
    const store = useEngraveJobStore.getState();
    const id1 = store.addFaceOperation({ kind: 'flat', a: 0, depth: 1 });
    const id2 = useEngraveJobStore.getState().addFaceOperation({ kind: 'cross-hole', a: 90, diameter: 3.175 });
    expect(useEngraveJobStore.getState().job.faces?.map((f) => f.id)).toEqual([id1, id2]);
    useEngraveJobStore.getState().updateFaceOperation(id1, { depth: 2, a: 30 });
    expect(useEngraveJobStore.getState().job.faces?.[0]).toMatchObject({ id: id1, depth: 2, a: 30 });
    useEngraveJobStore.getState().removeFaceOperation(id1);
    expect(useEngraveJobStore.getState().job.faces?.map((f) => f.id)).toEqual([id2]);
  });
});
