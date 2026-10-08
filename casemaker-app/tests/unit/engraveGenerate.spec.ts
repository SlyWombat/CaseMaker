// The generate → verify headless pipeline (#206). Real Manifold, plain Node — the same harness
// `engravePreview.spec.ts` uses. This is the half that must be byte-identical run to run: the
// `.nc` a user saves is the text this function returns, never a re-derivation.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate, regions } from './helpers/engravePipeline';
import { frameCorners } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { CAM_ID, CAM_NAME } from '@/engine/cnc/post/z1';
import { version as APP_VERSION } from '../../package.json';
import { presetPartOnBoard } from '@/engine/cnc/sacrificial';
import { calibrationFromReplies } from '@/engine/cnc/calibration';
import { Z1_FRAME_REPLIES } from './fixtures/z1Frame';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import type { Tool } from '@/engine/cnc/tool';
import type { EngraveDrill, EngraveJob, EngraveKeepOut, EngraveLineItem, EngraveTraceItem } from '@/types/engraveJob';

describe('engraveGenerate with a saved machine frame (#297)', () => {
  const read = calibrationFromReplies(new Map(Object.entries(Z1_FRAME_REPLIES)), {
    machineId: 'Z1',
    measuredAt: '2026-10-06T13:01:11.000Z',
    host: '192.168.10.43',
  });
  if (!read.ok) throw new Error('the fixture should read');

  it('still produces a clean program, and the same .nc, under the saved frame', () => {
    // The frame moves where M6, G28 and the probe go IN MACHINE COORDINATES. It must not move a
    // single work-coordinate cut, so the text a user saves is the same bytes either way.
    const without = generate(tl, defaultEngraveJob());
    const withFrame = generate(tl, defaultEngraveJob(), read.calibration);
    expect(withFrame.ok).toBe(true);
    expect(withFrame.nc).toBe(without.nc);
    expect(withFrame.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('ignores a frame saved for a different machine, exactly as the simulation does', () => {
    const other = { ...read.calibration, machineId: 'Z1-other' };
    const g = generate(tl, defaultEngraveJob(), other);
    expect(g.ok).toBe(true);
    expect(g.nc).toBe(generate(tl, defaultEngraveJob()).nc);
  });
});

describe('engraveGenerate (#206)', () => {
  it('takes the default job all the way to a clean .nc', () => {
    const g = generate(tl, defaultEngraveJob());
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.nc).not.toBeNull();
    expect(g.nc!.length).toBeGreaterThan(0);
    expect(g.nc!.startsWith(';@MKR|BEGIN')).toBe(true);
    expect(g.nc!.trimEnd().endsWith('M02')).toBe(true);
    expect(g.verify).not.toBeNull();
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.cam).not.toBeNull();
    expect(g.cam!.operations).toBe(3); // three enabled labels
    expect(g.cam!.cuttingMoves).toBeGreaterThan(0);
  });

  it('stamps the real package version into the CAM header, never dev (#231 item 4)', () => {
    const g = generate(tl, defaultEngraveJob());
    expect(g.nc).not.toBeNull();
    // The exact header line the app writes; a headless run must match it byte for byte.
    expect(g.nc).toContain(`;@MKR|CAM|id=${CAM_ID}|name=${CAM_NAME}|v=${APP_VERSION}`);
    expect(g.nc).not.toContain('v=dev');
  });

  it('is pure: the same job produces byte-identical nc', () => {
    const job = defaultEngraveJob();
    const a = generate(tl, job);
    const b = generate(tl, structuredClone(job) as EngraveJob);
    expect(a.nc).not.toBeNull();
    expect(a.nc).toBe(b.nc);
  });

  it('stops at findings for a cut deeper than the stock allows', () => {
    const job = defaultEngraveJob();
    const deep: EngraveJob = {
      ...job,
      labels: job.labels.map((l, i) => (i === 0 ? { ...l, depth: 11.5 } : l)),
    };
    const g = generate(tl, deep);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.nc).toBeNull();
    expect(g.findings.some((f) => f.code === 'depth-exceeds-stock' && f.severity === 'error')).toBe(true);
  });

  it('stops at feeds for a step-over past the cutter radius (#191)', () => {
    const job: EngraveJob = { ...defaultEngraveJob(), cutOverride: { stepOver: 0.6 } }; // radius is 0.5
    const g = generate(tl, job);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('feeds');
    expect(g.nc).toBeNull();
    expect(g.feeds?.ok).toBe(false);
    expect(g.errors.some((e) => e.stage === 'feeds')).toBe(true);
  });

  it('stops at findings when the cutter is too large for the text', () => {
    const job: EngraveJob = { ...defaultEngraveJob(), toolKey: 'flat-3.175x12-metal' };
    const g = generate(tl, job);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.nc).toBeNull();
    const codes = g.findings.filter((f) => f.severity === 'error').map((f) => f.code);
    expect(codes).toContain('item-chars-lost');
  });

  // #213 — `validateVise` has accepted the sacrificial stack since `454110a`, but this call never
  // passed it, so the generate path's `vise-grip-shallow` still judged the raw stock.
  it('judges vise-grip-shallow on what the jaws actually grip (#213)', () => {
    const base = defaultEngraveJob();
    // 10 mm proud on a 12 mm blank leaves 2 mm of raw stock in the jaws — under GRIP_MIN (3).
    const shallow: EngraveJob = {
      ...base,
      workholding: { ...base.workholding, vise: { ...base.workholding.vise, stockProud: 10 } },
    };
    const without = regions(tl, shallow).findings.map((f) => f.code);
    expect(without).toContain('vise-grip-shallow');

    // A 12 mm under-board with 10 mm overhang is what the jaws bear on, so the grip is the
    // board's thickness and the warning clears — only if the argument is threaded.
    const withBoard: EngraveJob = { ...shallow, sacrificial: presetPartOnBoard() };
    const withCodes = regions(tl, withBoard).findings.map((f) => f.code);
    expect(withCodes).not.toContain('vise-grip-shallow');
  });
});

describe('an under-surface void limits the cut (#231 item 3)', () => {
  // A 12 mm blank with a 2 mm membrane over a pocket: the void's ceiling is at z 10 from the
  // bottom face, so minFloor 1 leaves a deepest cut of 1.0 mm over it. `toPartPlan` turns the
  // void into `stock.keepOuts`, and `jobDepthLimit` is what the verifier is handed.
  const pocket: EngraveKeepOut = {
    id: 'pocket',
    name: 'Magnet pocket',
    kind: 'rect',
    position: { x: 50, y: 30 },
    rotation: 0,
    enabled: true,
    zCeiling: 10,
    width: 30,
    height: 20,
    cornerRadius: 0,
  };
  const shapeA = (depth: number) => ({
    id: 'a',
    name: 'A',
    kind: 'rect' as const,
    position: { x: 50, y: 30 },
    rotation: 0,
    depth,
    enabled: true,
    width: 10,
    height: 10,
    cornerRadius: 0,
  });
  // Shape B is clear of the pocket (x 80…90 against the pocket's 35…65): the same depth over
  // solid stock. It is the control for every case below.
  const shapeB = (depth: number) => ({
    id: 'b',
    name: 'B',
    kind: 'rect' as const,
    position: { x: 85, y: 30 },
    rotation: 0,
    depth,
    enabled: true,
    width: 10,
    height: 10,
    cornerRadius: 0,
  });
  const job = (aDepth: number, keepOuts?: EngraveKeepOut[]): EngraveJob => ({
    ...defaultEngraveJob(),
    labels: [],
    shapes: [shapeA(aDepth), shapeB(2.0)],
    ...(keepOuts ? { keepOuts } : {}),
  });

  it('refuses a cut past the membrane, flagged at verify on the TEXT', () => {
    const g = generate(tl, job(1.5, [pocket]));
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('verify');
    // The text existed — it is the verifier, re-reading the posted bytes, that refused it.
    expect(g.nc).not.toBeNull();
    expect(g.verify!.findings.some((f) => f.code === 'cut-too-deep' && f.severity === 'error')).toBe(true);
    // #171: the breach is the verifier's one finding. The chatter warning is suppressed over it,
    // so the user reads the refusal and its advice once, not twice.
    expect(g.findings.some((f) => f.code === 'item-over-void')).toBe(false);
  });

  it('passes the same cut when it stays within the membrane', () => {
    const g = generate(tl, job(0.8, [pocket]));
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.verify!.findings.some((f) => f.code === 'cut-too-deep')).toBe(false);
  });

  it('passes the same cut when the job carries no void', () => {
    const g = generate(tl, job(1.5));
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.findings.some((f) => f.code === 'item-over-void')).toBe(false);
  });

  // #171: the warning is about OVERLAP, not depth, so a cut well within the membrane still gets
  // it — the blank is printed flipped, so there is nothing under that material at any depth.
  it('warns over the void at a safe depth, and names only the cut that covers it (#171)', () => {
    const g = generate(tl, job(0.8, [pocket]));
    expect(g.ok).toBe(true); // a warning is not a refusal
    const warnings = g.findings.filter((f) => f.code === 'item-over-void');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('warning');
    expect(warnings[0]!.labelId).toBe('a');
    expect(warnings[0]!.message).toContain('Magnet pocket');
    expect(warnings[0]!.message).toContain('2 mm membrane');
  });

  it('does not object to the same depth clear of the void (#171)', () => {
    // The acceptance pair: 1.5 mm over the membrane is refused, and the same 1.5 mm cut on solid
    // stock is not — the depth alone is never the problem.
    const clear: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [shapeB(1.5)],
      keepOuts: [pocket],
    };
    const g = generate(tl, clear);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.findings.some((f) => f.code === 'item-over-void')).toBe(false);
  });

  it('warns for a LABEL over the void too — the item kind makes no difference (#171)', () => {
    const jobWithLabel: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [
        {
          id: 'over',
          text: 'CASE',
          font: 'sans-default',
          weight: 'bold',
          size: 10,
          position: { x: 50, y: 30 },
          rotation: 0,
          depth: 0.8,
          enabled: true,
        },
      ],
      shapes: [],
      keepOuts: [pocket],
    };
    const g = generate(tl, jobWithLabel);
    const over = g.findings.find((f) => f.code === 'item-over-void');
    expect(over).toBeTruthy();
    expect(over!.labelId).toBe('over');
    expect(over!.message).toContain('CASE');
  });

  // #270 — a TRACE over a void warns, for the same reason a region does: the membrane has nothing
  // under it, so a pass across it chatters however shallow. The advice the sentence carries — move
  // the cut clear — is exactly what a one-line trace can do, which is why the drill exemption
  // below does not reach it.
  /** A two-point horizontal trace from `at`, 30 mm long, in the stock frame. */
  const traceLine = (at: { x: number; y: number }): EngraveTraceItem => ({
    kind: 'line',
    id: 'tr',
    position: at,
    rotation: 0,
    points: [
      [0, 0],
      [30, 0],
    ],
    closed: false,
    depth: 0.8,
    enabled: true,
  });
  /** The same depth, drilled straight into the void's centre. */
  const drillOver: EngraveDrill = {
    kind: 'drill',
    id: 'd',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 0.8,
    through: false,
    enabled: true,
  };

  it('warns for a TRACE crossing the void (#270)', () => {
    // x 35…65 across the pocket's 35…65, at its centreline.
    const g = generate(tl, {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      traces: [traceLine({ x: 35, y: 30 })],
      keepOuts: [pocket],
    });
    const over = g.findings.filter((f) => f.code === 'item-over-void');
    expect(over).toHaveLength(1);
    expect(over[0]!.severity).toBe('warning');
    expect(over[0]!.labelId).toBe('tr');
    expect(over[0]!.message).toContain('Magnet pocket');
    // Named the way the operations list names it, not as a bare id.
    expect(over[0]!.message).toContain('Trace line');
  });

  it('leaves the same trace unwarned when it is clear of the void (#270)', () => {
    // Moved to y 52, behind the pocket's 20…40 — the only difference is where the line sits.
    const g = generate(tl, {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      traces: [traceLine({ x: 35, y: 52 })],
      keepOuts: [pocket],
    });
    expect(g.findings.some((f) => f.code === 'item-over-void')).toBe(false);
  });

  it('does NOT warn for a drill over the void — the #220 exemption, pinned (#270)', () => {
    // A drill into the pocket is a breach the VERIFIER owns (`cut-too-deep`); this warning is about
    // the finish of a pocketed floor, and a drilled hole has none. #270 asked for this to stay.
    const g = generate(tl, {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      drills: [drillOver],
      keepOuts: [pocket],
    });
    expect(g.findings.some((f) => f.code === 'item-over-void')).toBe(false);
  });
});

// #287 — a single-line trace (#219) used to reach every gate except the CAM, so a job with one
// generated a program that cut everything BUT the trace: no warning, no refusal, and a run sheet
// implying otherwise. These pin the wiring that fixes it.
describe('a trace item reaches the program (#287)', () => {
  /** A two-point horizontal trace 30 mm long starting at `x`, 0.8 mm deep. */
  const traceLine = (x: number): EngraveLineItem => ({
    kind: 'line',
    id: 'tr',
    position: { x, y: 30 },
    rotation: 0,
    points: [
      [0, 0],
      [30, 0],
    ],
    closed: false,
    depth: 0.8,
    enabled: true,
  });

  const jobWithTrace = (): EngraveJob => {
    const base = defaultEngraveJob();
    return { ...base, labels: [base.labels[0]!], shapes: [], traces: [traceLine(10)] };
  };

  it('emits an operation for the trace, appended after the region operations', () => {
    const g = generate(tl, jobWithTrace());
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    // One label region + one trace: the trace is not silently dropped.
    expect(g.cam!.operations).toBe(2);
    expect(g.cam!.cuttingMoves).toBeGreaterThan(0);
    expect(g.nc).toContain('Engrave "CASE"');
    // Named the way `traceOperationName` words it, with the depth `generateTrace` appends.
    expect(g.nc).toContain('Trace line (2 points) 0.8mm');
    expect(g.nc!.indexOf('Trace line')).toBeGreaterThan(g.nc!.indexOf('Engrave "CASE"'));
    // The verifier reads the posted text, so it sees the trace moves too.
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('predicts the trace cutter SWEEP, or the oracle would read its own groove as an over-cut', () => {
    const g = generate(tl, jobWithTrace());
    // A 30 mm capsule on a 1.0 mm cutter: 30 + π·0.5² ≈ 30.785 mm², minus the polygonisation of
    // the two round caps — so a band, not a closed form to the last digit.
    const trace = g.predicted.find((p) => Math.abs(p.depth - 0.8) < 1e-9);
    expect(trace).toBeDefined();
    const cs = tl.CrossSection.ofPolygons(trace!.polygons);
    const area = cs.area();
    cs.delete();
    expect(area).toBeGreaterThan(30);
    expect(area).toBeLessThan(31);
    // ...and the label's own region is predicted too, so the two depths both appear.
    expect(g.predicted.some((p) => Math.abs(p.depth - 2.0) < 1e-9)).toBe(true);
  });

  it('leaves a job with no traces alone', () => {
    // The identity the byte-identity of every pre-#287 program rests on: no trace, no extra
    // operation, no extra predicted level.
    const g = generate(tl, defaultEngraveJob());
    expect(g.cam!.operations).toBe(3);
    expect(g.predicted).toHaveLength(3);
    expect(g.nc).not.toContain('Trace');
  });

  // The tests above would all pass if the trace's moves went somewhere arbitrary. The verifier's
  // own parse of the posted text gives the program's depth and move count, so this pins WHERE the
  // cut lands: a trace-only job (no region items at all — which the post used to refuse outright)
  // must carry the trace's own endpoints at the item's depth, negative Z.
  it('cuts the trace where the item says, at the item depth', () => {
    const g = generate(tl, {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      // 15 mm long from x 80 to 95 at y 10, 0.8 mm deep: the whole job, so every coordinate in
      // the program belongs to the trace (the extent check below is why).
      traces: [{ ...traceLine(80), position: { x: 80, y: 10 }, points: [[0, 0], [15, 0]] }],
    });
    expect(g.ok).toBe(true);
    expect(g.nc).not.toBeNull();
    expect(g.cam!.operations).toBe(1);
    // The endpoints, as the machine reads them. The post trims trailing zeros, so `X95` is the
    // whole program's far end; the lookahead keeps `X950` out of the match.
    expect(g.nc).toMatch(/X80(?![.\d])/);
    expect(g.nc).toMatch(/X95(?![.\d])/);
    expect(g.nc).toMatch(/Y10(?![.\d])/);
    // Cut BELOW the top face (work Z is negative down) to the item's depth. The program's bbox is
    // not usable here: the post's own ending is `G28`, a machine home, which the verifier counts
    // as a move and which reaches far past the work.
    expect(g.verify!.stats.deepestZ).toBeCloseTo(-0.8, 6);
    expect(g.verify!.stats.cuttingMoves).toBeGreaterThan(0);
  });
});

describe('the frame file (#244)', () => {
  /** An IR with two positioned moves, for the pure geometry. Only `operations` is read. */
  function miniIr(moves: ToolpathIR['operations'][number]['moves']): ToolpathIR {
    return {
      frame: 'flat',
      tool: { id: 0, name: 't' } as unknown as Tool,
      toolNumber: 1,
      spindleRpm: 12000,
      air: false,
      safeZ: 5,
      hopZ: 1,
      operations: [{ number: 1, name: 'x', labelId: '', depth: 0, moves, estimatedSeconds: 0 }],
    };
  }

  it('traces a closed rectangle of rapids around the cut footprint, grown by the radius', () => {
    const ir = miniIr([
      { kind: 'rapid', x: 0, y: 0, z: 0 },
      { kind: 'feed', x: 10, y: 6, z: -1, f: 100 },
    ]);
    const corners = frameCorners(ir, 0.5, 20);
    expect(corners).not.toBeNull();
    expect(corners!.map((m) => [m.x, m.y] as [number, number])).toEqual([
      [-0.5, -0.5],
      [10.5, -0.5],
      [10.5, 6.5],
      [-0.5, 6.5],
      [-0.5, -0.5],
    ]);
    // Rapids only — the frame cuts nothing — and all at the frame height.
    expect(corners!.every((m) => m.kind === 'rapid' && m.z === 20)).toBe(true);
  });

  it('has no trace when the toolpath has no positioned move', () => {
    expect(frameCorners(miniIr([]), 0.5, 20)).toBeNull();
  });

  it('produces a verified frame program beside a clean job', () => {
    const g = generate(tl, defaultEngraveJob());
    expect(g.ok).toBe(true);
    expect(g.frameNc).not.toBeNull();
    expect(g.frameNc!.startsWith(';@MKR|BEGIN')).toBe(true);
    expect(g.frameNc!.trimEnd().endsWith('M02')).toBe(true);
    // Verified by the SAME verifier, and it cuts nothing.
    expect(g.frameVerify).not.toBeNull();
    expect(g.frameVerify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.frameVerify!.stats.cuttingMoves).toBe(0);
    // The trace sits at FRAME_Z (20) above the work; the program's own retract is lower but still
    // positive, so the whole body is clear of the stock.
    expect(g.frameVerify!.stats.bbox.max[2]).toBeCloseTo(20, 6);
    expect(g.frameVerify!.stats.bbox.min[2]).toBeGreaterThan(0);
  });

  it('offers no frame when the job is refused', () => {
    const deep: EngraveJob = {
      ...defaultEngraveJob(),
      labels: defaultEngraveJob().labels.map((l, i) => (i === 0 ? { ...l, depth: 11.5 } : l)),
    };
    const g = generate(tl, deep);
    expect(g.ok).toBe(false);
    expect(g.frameNc).toBeNull();
    expect(g.frameVerify).toBeNull();
  });
});
