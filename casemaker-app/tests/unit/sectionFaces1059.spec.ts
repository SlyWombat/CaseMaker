/**
 * #1059 — THE FACE CAM READS THE SECTION, NOT THE TURNED ENVELOPE.
 *
 * An indexed face is a plane at `surface − depth`. On a ROUND rod the surface is the same radius
 * at every index, so `map.radius` (the envelope) doubles as the surface and `faceChordMm(R, d)`
 * is the face's width. A BLOCK has neither: at A 0 the surface is the section's half-height
 * (22.25 on a 44.5 mm square, NOT the 31.47 envelope), and the face there is the flat's own side
 * (44.5 mm), not the envelope circle's chord (22.07 mm); at A 45 the surface is the corner
 * (31.47) and the face is the SECTION's chord there (2 mm at 1 mm below the corner, against the
 * circle's 15.34 mm). The panther's stock is this block and its first rotary op is the corner
 * removal, so every number here is one the run posts.
 *
 * RED at 1059-cylinder-stock 5f7867d0f: `planFaceCuts` states the envelope chord and no surface
 * radius (the A 0 face would cut 7.2 mm of air at Z 29.47), `faces-all-round` cuts the block's
 * four flats down with the corner depth, and the oracle judges every face at the envelope.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';
import type { CutParams } from '@/engine/cnc/feeds';
import { generateIndexed } from '@/engine/cnc/cam/indexed';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { buildTimeline, parseGcode, stubSetup, type Setup } from '@/engine/cnc';
import { faceChordMm, faceCutIntoNeck, faceJobRefusal, planFaceCuts, type FaceNeckSpan } from '@/engine/cnc/rotary/faceOps';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { createSimSession } from '@/workers/sim/session';
import { sweepTimeline, type SweepResult } from '@/workers/geometry/sweep';
import { oracleSentence } from '@/store/engraveRunGate';
import type { EngraveFaceOp, EngraveJob } from '@/types/engraveJob';

const SIDE = 44.5;
const LENGTH = 100;
const HALF = SIDE / 2;
const ENVELOPE_R = Math.hypot(SIDE, SIDE) / 2;
const SECTION = { kind: 'rect' as const, width: SIDE, height: SIDE };
/** The corner depth: from the square's corner down to the flats' own plane. */
const CORNER_DEPTH = ENVELOPE_R - HALF;

const TOOL = flatEndMill(10, { shoulderLength: 20, fluteLength: 15 });
const HOLD = { kind: 'rotary-chuck' as const, jawDiameter: SIDE, stickout: 85 };
const setup = (): Setup =>
  stubSetup({ kind: 'cylinder', diameter: 2 * ENVELOPE_R, length: LENGTH, section: SECTION }, HOLD);

/** A bar in the chuck: a shape-less box with no rod form, so the chuck reads its section. */
function block(faces: EngraveFaceOp[], dims: { width: number; thickness: number } = { width: SIDE, thickness: SIDE }): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'faces on a block',
    stock: { length: LENGTH, width: dims.width, thickness: dims.thickness, material: 'hardwood' },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' },
    },
    labels: [],
    shapes: [],
    faces,
  };
}

const flat = (id: string, a: number, depth: number): EngraveFaceOp => ({ id, kind: 'flat', a, depth });

describe('#1059 a block in the chuck is a face job', () => {
  it('faceJobRefusal accepts it — the refusal is for a job not in the chuck, or a disc', () => {
    const job = block([flat('f0', 0, 1)]);
    expect(faceJobRefusal(job)).toBeNull();
    // Still refused where the chuck cannot hold it: the same job in the vise.
    const vise = { ...job, workholding: defaultEngraveJob().workholding };
    expect(faceJobRefusal(vise)?.code).toBe('face-needs-chuck');
  });
});
/** The feeds row is not this slice's subject: the geometry is, so the passes are stated. */
const PARAMS: CutParams = { rpm: 12000, feed: 800, plungeFeed: 200, stepDown: 2, stepOver: 5, peck: 1, air: true };
const ctx = (): PostContext => ({
  jobName: 'block faces',
  stock: { length: LENGTH, width: SIDE, thickness: SIDE },
  materialName: 'hardwood',
  zDatum: 'rotary-axis',
  origin: 'topFrontLeft',
  camVersion: '1.0.0',
  toolKey: 'fixture',
});

function dispose(s: SweepResult): void {
  s.stock.delete();
  s.result.delete();
  s.removal?.delete();
  for (const cp of s.perCheckpoint) cp?.delete();
  for (const g of s.gouges) g.solid.delete();
}

describe('#1059 the face CAM reads the block’s own section', () => {
  it('a flat at A 0 is the section’s own side, cut from the block’s surface — not the envelope’s chord in air', () => {
    const job = block([flat('f0', 0, 2)]);
    const map = rotaryMapOf(job)!;
    expect(map.section).toEqual(SECTION);
    expect(map.radius).toBeCloseTo(ENVELOPE_R, 9);
    const plan = planFaceCuts(job, map, TOOL, PARAMS);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const face = plan.plan.faces[0]!;
    // The flat at 2 mm below 22.25 is still the whole top face: 44.5 mm across.
    expect(face.width).toBeCloseTo(SIDE, 9);
    // The surface THIS index cuts from — the CAM states it, so the program can be written at
    // Z = 22.25 − 2 and the oracle can judge the cut against the right plane.
    expect(face.surfaceRadius).toBeCloseTo(HALF, 9);
    // At the base this was the envelope circle's chord at depth 2 — 22.07 mm of a face whose
    // plane sat 7.22 mm above the block.
    expect(face.width).not.toBeCloseTo(faceChordMm(ENVELOPE_R, 2), 3);
  });

  it('a face at A 45 is the SECTION’s corner chord: 2 mm one millimetre below the corner', () => {
    const job = block([flat('c45', 45, 1)]);
    const plan = planFaceCuts(job, rotaryMapOf(job)!, TOOL, PARAMS);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const face = plan.plan.faces[0]!;
    // The corner's surface is the envelope radius (the square's diagonal half)…
    expect(face.surfaceRadius).toBeCloseTo(ENVELOPE_R, 9);
    // …but one millimetre below it the section is only 2 mm wide (the removed triangle's
    // hypotenuse), where the circle there would be 15.34 mm.
    expect(face.width).toBeCloseTo(2, 6);
    expect(faceChordMm(ENVELOPE_R, 1)).toBeGreaterThan(15);
  });

  it('Faces all round on a block cuts ONLY the corners: the flats are already at the plane', () => {
    // The panther's square → octagon: 8 faces, 44.5 across flats. The four flats are at 22.25
    // already (depth 0); only the four corners cut, each 9.217 mm down to the same plane.
    const op: EngraveFaceOp = { id: 'oct', kind: 'faces-all-round', a: 0, count: 8, acrossFlats: SIDE };
    const job = block([op]);
    const plan = planFaceCuts(job, rotaryMapOf(job)!, TOOL, PARAMS);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.plan.faces.map((f) => f.a)).toEqual([45, 135, 225, 315]);
    for (const face of plan.plan.faces) {
      expect(face.depth).toBeCloseTo(CORNER_DEPTH, 6);
      expect(face.surfaceRadius).toBeCloseTo(ENVELOPE_R, 6);
      // The octagon's side at that depth: 2 × the corner depth.
      expect(face.width).toBeCloseTo(2 * CORNER_DEPTH, 6);
    }
    expect(plan.plan.predicted.map((p) => p.a)).toEqual([45, 135, 225, 315]);
  });

  it('a cut declared on a ring face the stock is already at is refused, never silently dropped', () => {
    // The pocket repeats on the ring's faces; the four flats have no face to cut into, so the job
    // is refused by name rather than posting a program that quietly omits the cut.
    const op: EngraveFaceOp = {
      id: 'oct',
      kind: 'faces-all-round',
      a: 0,
      count: 8,
      acrossFlats: SIDE,
      items: [{ id: 'pkt', kind: 'pocket', x: 20, y: 0, depth: 1, width: 4, height: 3 }],
    };
    const job = block([op]);
    const plan = planFaceCuts(job, rotaryMapOf(job)!, TOOL, PARAMS);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.findings.map((f) => f.code)).toContain('face-item-no-face');
      expect(plan.findings.find((f) => f.code === 'face-item-no-face')?.message).toContain('there is no face to cut it into');
    }
  });

  it('the posted program cuts at 22.25 − depth and sweeps the whole side', () => {
    const job = block([flat('f0', 0, 2)]);
    const map = rotaryMapOf(job)!;
    const params = PARAMS;
    const plan = planFaceCuts(job, map, TOOL, params);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const face = plan.plan.faces[0]!;
    const ir = generateIndexed({ radius: map.radius, faces: plan.plan.faces, tool: TOOL, params, rapid: Z1.rapidEstimate });
    const posted = postZ1(ir, ctx(), Z1);
    if (!posted.ok) throw new Error(`the post refused: ${posted.errors.join('; ')}`);
    const timeline = buildTimeline(parseGcode(posted.text), setup());
    expect(timeline.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const out = sweepTimeline(tl, timeline, TOOL, setup());
    if (!out.ok) throw new Error(`the sweep refused: ${JSON.stringify(out.diagnostics)}`);
    const s = out.value;
    const span = face.toX - face.fromX;
    if (TOOL.diameter === null) throw new Error('the fixture cutter states no diameter');
    const cutterRadius = TOOL.diameter / 2;
    // The cut is the whole flat, 2 mm deep. The plan's span is the CUTTER CENTRE's travel, so the
    // removal reaches one cutter radius past each end (rounded by the pass discs): the slab
    // 44.5 × span × 2 is cut in full, and nothing beyond the tool's own reach is. At the base the
    // cutter ran at Z 29.47, 7.22 mm above the block, and removed nothing at all.
    expect(s.stats.stockVolume).toBeCloseTo(SIDE * SIDE * LENGTH, 3);
    expect(s.stats.removedVolume).toBeGreaterThan(SIDE * 2 * span - 1e-6);
    expect(s.stats.removedVolume).toBeLessThanOrEqual(SIDE * 2 * (span + 2 * cutterRadius) + 1e-6);
    dispose(s);
  }, 240_000);

  it('the oracle judges the face at the block’s surface, not at the envelope', () => {
    const job = block([flat('f0', 0, 2)]);
    const map = rotaryMapOf(job)!;
    const params = { ...PARAMS, stepDown: 2, stepOver: 5 };
    const plan = planFaceCuts(job, map, TOOL, params);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const ir = generateIndexed({ radius: map.radius, faces: plan.plan.faces, tool: TOOL, params, rapid: Z1.rapidEstimate });
    const posted = postZ1(ir, ctx(), Z1);
    if (!posted.ok) throw new Error(`the post refused: ${posted.errors.join('; ')}`);
    const session = createSimSession(tl);
    const loaded = session.load(posted.text, setup(), TOOL, null);
    if (!loaded.ok) throw new Error(`the session refused: ${JSON.stringify(loaded.diagnostics)}`);
    const report = session.oracle(plan.plan.predicted);
    expect(report.ok, oracleSentence({ oracle: report })).toBe(true);
    expect(report.levels.map((l) => l.a)).toEqual([0]);
    for (const level of report.levels) {
      expect(level.underCut).toBe(0);
      expect(level.overCut).toBe(0);
    }
    session.dispose();
  }, 240_000);
});

describe('#1059 the cross-hole and the neck read the section too', () => {
  it('a cross-hole at A 0 is 2 × the section’s surface deep and plunges to the block’s far side', () => {
    const job = block([{ id: 'h', kind: 'cross-hole', a: 0, diameter: 3.175 }]);
    const map = rotaryMapOf(job)!;
    const plan = planFaceCuts(job, map, TOOL, PARAMS);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const hole = plan.plan.holes[0]!;
    // Through the 44.5 mm block: from the 22.25 surface to the far side at −22.25. At the base
    // this stated the envelope's 62.93 mm, plunging 9.22 mm of air past the block's underside.
    expect(hole.surfaceRadius).toBeCloseTo(HALF, 9);
    expect(hole.depth).toBeCloseTo(SIDE + job.breakthrough, 6);
    expect(plan.plan.predicted[0]!.surfaceRadius).toBeCloseTo(HALF, 9);

    const ir = generateIndexed({ radius: map.radius, holes: plan.plan.holes, tool: TOOL, params: PARAMS, rapid: Z1.rapidEstimate });
    const plunge = ir.operations[0]!.moves.find((m) => m.kind === 'feed')!;
    // …and the breakthrough past the far surface, never short of it.
    expect(plunge.z).toBeCloseTo(-HALF - job.breakthrough, 6);
  });

  it('a cross-hole at A 90 reads the section’s OTHER face: 60 × 30 bar, 30 mm from the axis', () => {
    // The section is 60 wide × 30 high. At A 0 the hole enters the 30 mm face (15 above the
    // axis); at A 90 it turns to the 60 mm one (30). The depth follows the index, not the stock.
    const job = block([{ id: 'h', kind: 'cross-hole', a: 90, diameter: 3.175 }], { width: 60, thickness: 30 });
    const map = rotaryMapOf(job)!;
    expect(map.section).toEqual({ kind: 'rect', width: 60, height: 30 });
    const plan = planFaceCuts(job, map, TOOL, PARAMS);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const hole = plan.plan.holes[0]!;
    expect(hole.surfaceRadius).toBeCloseTo(30, 9);
    expect(hole.depth).toBeCloseTo(60 + job.breakthrough, 6);

    const zero = planFaceCuts(block([{ id: 'h', kind: 'cross-hole', a: 0, diameter: 3.175 }], { width: 60, thickness: 30 }), map, TOOL, PARAMS);
    expect(zero.ok).toBe(true);
    if (zero.ok) {
      expect(zero.plan.holes[0]!.surfaceRadius).toBeCloseTo(15, 9);
      expect(zero.plan.holes[0]!.depth).toBeCloseTo(30 + job.breakthrough, 6);
    }
  });

  it('the neck check compares FLOORS: a 13 mm flat at A 0 eats a ⌀20 neck in the bar', () => {
    // ⌀20 leaves a floor 10 mm above the axis. A flat 13 mm deep at A 0 bottoms out at
    // 22.25 − 13 = 9.25 mm — through the neck — although it is nowhere near the 21.47 mm the
    // envelope-based check compared against. One millimetre shallower is clear.
    const eating = block([flat('deep', 0, 13)]);
    const eatingMap = rotaryMapOf(eating)!;
    const neck: FaceNeckSpan = { fromMm: 3, toMm: 9, depthMm: eatingMap.radius - 10, diameterMm: 20 };
    const f = faceCutIntoNeck(eating, eatingMap, neck, 5);
    expect(f?.code).toBe('face-cuts-neck');
    expect(f?.labelId).toBe('deep');
    expect(f?.message).toContain('13 mm below the surface between X 3 and X 9 mm');
    expect(f?.message).toContain('⌀20 mm');
    expect(f?.message).toContain('shallower than 12.25 mm');

    const clear = block([flat('shallow', 0, 12)]);
    expect(faceCutIntoNeck(clear, rotaryMapOf(clear)!, neck, 5)).toBeNull();
  });

  it('a cross-hole in the neck’s span states the block’s through depth, not the envelope’s', () => {
    const job = block([{ id: 'x', kind: 'cross-hole', a: 0, diameter: 3.175, atX: 6 }]);
    const map = rotaryMapOf(job)!;
    const neck: FaceNeckSpan = { fromMm: 3, toMm: 9, depthMm: map.radius - 10, diameterMm: 20 };
    const f = faceCutIntoNeck(job, map, neck, 5);
    expect(f?.code).toBe('face-cuts-neck');
    expect(f?.message).toContain('44.5 mm below the surface');
  });
});
