// #708 — the per-face oracle for INDEXED rotary jobs (follow-up to #241).
//
// #241 made an indexed job sweep on the exact engine, one stock-frame solid per face. The app's
// volumetric oracle refused that shape by name, so an indexed job could never reach "matches the
// design". This spec drives #241's own fixtures through the SESSION: generate → post → load →
// per-face oracle, and proves each face is judged in its own frame (the removal turned back by
// +a, the face's top face at the stock's radius) with the face named when one disagrees.

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generateIndexed, type IndexedSpec } from '@/engine/cnc/cam/indexed';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { buildTimeline, parseGcode, stubSetup, Z1 } from '@/engine/cnc';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { capsuleContours, circlePolygon } from '@/workers/geometry/sweep';
import { createSimSession, type SimLoadOk } from '@/workers/sim/session';
import { oracleSentence } from '@/store/engraveRunGate';
import type { OraclePoint } from '@/engine/cnc/engrave/oracle';
import type { CutParams } from '@/engine/cnc/feeds';

const RADIUS = 10;
const LENGTH = 30;
const setup = () => stubSetup({ kind: 'cylinder', diameter: 2 * RADIUS, length: LENGTH }, { kind: 'rotary-chuck', jawDiameter: 25, stickout: 30 });
const PARAMS: CutParams = { rpm: 12000, feed: 800, plungeFeed: 200, stepDown: 100, stepOver: 1, peck: 1, air: true };
const WIDE: Tool = flatEndMill(10, { shoulderLength: 20, fluteLength: 15 });
const THIN: Tool = flatEndMill(3, { shoulderLength: 30, fluteLength: 25 });
const CTX: PostContext = {
  jobName: 'indexed oracle fixture',
  stock: { length: LENGTH, width: 2 * RADIUS, thickness: 2 * RADIUS },
  materialName: 'softwood',
  zDatum: 'rotary-axis',
  origin: 'topFrontLeft',
  camVersion: '1.0.0',
  toolKey: 'fixture',
};

/** One face's pass, as the tool really sweeps it: the capsule along the axis, in the face frame. */
function faceCapsule(radius: number): OraclePoint[][] {
  const polys: OraclePoint[][] = [];
  capsuleContours(-5, 0, LENGTH + 5, 0, radius, segmentsForRadius(radius), polys);
  return polys;
}

/** Generate → post → load into a session, exactly as the app does (the indexed job routes exact). */
function load(spec: IndexedSpec) {
  const ir = generateIndexed(spec);
  const posted = postZ1(ir, CTX, Z1);
  if (!posted.ok) throw new Error(`the post refused: ${posted.errors.join('; ')}`);
  // The posted text is what the machine runs; the timeline is the verifier's own route.
  const timeline = buildTimeline(parseGcode(posted.text), setup());
  expect(timeline.summary.rotaryClass).toBe('indexed');
  const s = createSimSession(tl);
  const r = s.load(posted.text, setup(), spec.tool, null);
  if (!r.ok) throw new Error(`the session refused the indexed program: ${JSON.stringify(r.diagnostics)}`);
  return { session: s, load: r as SimLoadOk };
}

const flats = (depth180 = 1): IndexedSpec => ({
  radius: RADIUS,
  faces: [
    { a: 0, fromX: -5, toX: LENGTH + 5, depth: 1 },
    { a: 180, fromX: -5, toX: LENGTH + 5, depth: depth180 },
  ],
  tool: WIDE,
  params: PARAMS,
  rapid: Z1.rapidEstimate,
});

describe('#708 the per-face oracle (design §6 fixtures through the session)', () => {
  it('the exact engine sweeps an indexed job, and the two flats match their own faces', () => {
    const { session, load: r } = load(flats());
    expect(r.stats.engine).toBe('exact');
    const report = session.oracle([
      { a: 0, depth: 1, polygons: faceCapsule(5) },
      { a: 180, depth: 1, polygons: faceCapsule(5) },
    ]);
    expect(report.ok, oracleSentence({ oracle: report })).toBe(true);
    expect(report.levels.map((l) => l.a)).toEqual([0, 180]);
    // Each level's area is the capsule's, and the simulated slice agrees within the band.
    for (const level of report.levels) {
      expect(level.simulatedArea).toBeGreaterThan(0);
      expect(level.underCut).toBe(0);
      expect(level.overCut).toBe(0);
    }
    expect(report.frame).toBe('work');
    session.dispose();
  });

  it('a face cut in 100 depth passes is one footprint, and still matches its prediction (#749)', () => {
    // The indexed shape of #749: one XY capsule at every step-down, 100 columns nested in Z.
    // The oracle used to union every column, rebuilding the same combinatorial pile the sweep
    // and playback now avoid; one per footprint is the exact union (nested prisms).
    const spec: IndexedSpec = {
      radius: RADIUS,
      faces: [{ a: 0, fromX: -5, toX: LENGTH + 5, depth: 1 }],
      tool: WIDE,
      params: { ...PARAMS, stepDown: 0.01 },
      rapid: Z1.rapidEstimate,
    };
    const { session, load: r } = load(spec);
    expect(r.stats.engine).toBe('exact');
    const report = session.oracle([{ a: 0, depth: 1, polygons: faceCapsule(5) }]);
    expect(report.ok, oracleSentence({ oracle: report })).toBe(true);
    expect(report.levels.map((l) => l.a)).toEqual([0]);
    for (const level of report.levels) {
      expect(level.underCut).toBe(0);
      expect(level.overCut).toBe(0);
    }
    session.dispose();
  }, 120_000);

  it('HEX ALL ROUND: six faces, each judged against its own prediction', () => {
    const apothem = RADIUS * Math.cos(Math.PI / 6);
    const depth = RADIUS - apothem;
    const spec: IndexedSpec = {
      radius: RADIUS,
      faces: [0, 60, 120, 180, 240, 300].map((a) => ({ a, fromX: -5, toX: LENGTH + 5, depth })),
      tool: WIDE,
      params: PARAMS,
      rapid: Z1.rapidEstimate,
    };
    const { session } = load(spec);
    const report = session.oracle([0, 60, 120, 180, 240, 300].map((a) => ({ a, depth, polygons: faceCapsule(5) })));
    expect(report.ok, oracleSentence({ oracle: report })).toBe(true);
    expect(report.levels.map((l) => l.a)).toEqual([0, 60, 120, 180, 240, 300]);
    session.dispose();
  });

  it('CROSS-HOLE through at 90°: the plunge is judged on the face it was drilled from', () => {
    const spec: IndexedSpec = {
      radius: RADIUS,
      holes: [{ a: 90, x: LENGTH / 2, depth: 2 * RADIUS + 2 }],
      tool: THIN,
      params: PARAMS,
      rapid: Z1.rapidEstimate,
    };
    const { session } = load(spec);
    const disc = circlePolygon(LENGTH / 2, 0, 1.5, segmentsForRadius(1.5)) as OraclePoint[];
    const report = session.oracle([{ a: 90, depth: 2 * RADIUS + 2, polygons: [disc] }]);
    expect(report.ok, oracleSentence({ oracle: report })).toBe(true);
    expect(report.levels.map((l) => l.a)).toEqual([90]);
    session.dispose();
  });

  it('a face cut 0.5 mm deep where 1 mm was planned is refused, and the sentence names the face', () => {
    const { session } = load(flats(0.5));
    const report = session.oracle([
      { a: 0, depth: 1, polygons: faceCapsule(5) },
      { a: 180, depth: 1, polygons: faceCapsule(5) },
    ]);
    expect(report.ok).toBe(false);
    // The shallow face is the one that left material: its level at depth 1 has no material cut.
    const shallow = report.levels.filter((l) => l.a === 180);
    expect(shallow.length).toBeGreaterThan(0);
    expect(Math.max(...shallow.map((l) => l.underCut))).toBeGreaterThan(0);
    expect(report.worst.underAt?.a).toBe(180);
    const sentence = oracleSentence({ oracle: report });
    expect(sentence).toContain('under-cut');
    expect(sentence).toContain('on the face at A 180°');
  });

  it('a predicted face the program never turned to is pure under-cut, named', () => {
    // The program cuts one face; the design names two.
    const oneFace: IndexedSpec = { ...flats(), faces: [{ a: 0, fromX: -5, toX: LENGTH + 5, depth: 1 }] };
    const { session } = load(oneFace);
    const report = session.oracle([
      { a: 0, depth: 1, polygons: faceCapsule(5) },
      { a: 180, depth: 1, polygons: faceCapsule(5) },
    ]);
    expect(report.ok).toBe(false);
    expect(report.worst.underAt?.a).toBe(180);
    session.dispose();
  });
});

describe('#729 — a face the plan never named is an over-cut, and no plan is no pass', () => {
  it('cutting face 180 when only face 0 is predicted fails, naming face 180', () => {
    const { session } = load(flats());
    const report = session.oracle([{ a: 0, depth: 1, polygons: faceCapsule(5) }]);
    expect(report.ok).toBe(false);
    const unplanned = report.levels.find((l) => l.a === 180);
    expect(unplanned?.overCut).toBeGreaterThan(1);
    expect(unplanned?.predictedArea).toBe(0);
    expect(report.worst.overAt?.a).toBe(180);
    session.dispose();
  });

  it('a prediction written as −180 or 540 names the same face as 180', () => {
    const { session } = load(flats());
    const report = session.oracle([
      { a: 360, depth: 1, polygons: faceCapsule(5) },
      { a: -180, depth: 1, polygons: faceCapsule(5) },
    ]);
    expect(report.ok, oracleSentence({ oracle: report })).toBe(true);
    session.dispose();
  });

  it('an indexed program judged against no prediction at all is refused, not passed', () => {
    const { session } = load(flats());
    expect(() => session.oracle([])).toThrow(/no predicted face/);
    session.dispose();
  });
});
