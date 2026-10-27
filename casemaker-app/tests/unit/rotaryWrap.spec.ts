/**
 * The rotary map (#240 slice 2): `/Rotary.md` R6, R9, R10, R12 and the design's §3.7–§3.9.
 *
 * Pure data — no wasm, no worker, no machine — so this file pins the numbers the rest of the
 * slice is judged by: the arc conversion (15.708 mm = 90° at R = 10), the anisotropic opening
 * (0.526 mm around the ⌀20 dowel), the facet term (0.013 mm), the step-over's floor-arc metric,
 * the map → frame conversion, and the refusal sentences in the operator's words.
 *
 * THE OPENING IS THE TOOL'S FOOTPRINT, EXACTLY. Design §3.7's `r_t·R/(R − d)` and `/Rotary.md`
 * §4.5's "subtends atan(r_t/(R − d)) of arc" agree only to first order. The exact form is
 * `R·atan(r_t/(R − d))`; the linear form over-claims by 0.08 % on the dowel's 1 mm cutter
 * (0.52632 vs 0.52583 — the same 0.526) and by 12 % on the ⌀6 rod's 3.175 mm cutter, where the
 * oracle's facet sentence is only true for the exact form. `aroundScale` is built from the atan,
 * and the small-angle goldens below are asserted as such.
 */

import { describe, expect, it } from 'vitest';

import {
  ROTARY_CLEARANCE_MM,
  ROTARY_JAW_KEEP_OUT_MM,
  ROTARY_MAX_DIAMETER_MM,
  ROTARY_MAX_LENGTH_MM,
  ROTARY_TAILSTOCK_BAND_MM,
  angleToArc,
  arcToAngle,
  aroundOpeningRadius,
  aroundScale,
  envelopeSentence,
  facetTerm,
  hasFloor,
  isRotaryJob,
  jawsSentence,
  offAxisSentence,
  rotaryMapOf,
  scalePolygonsAround,
  tailstockSentence,
  throughCentreSentence,
  toRotaryIR,
  turningInCutSentence,
  type RotaryMap,
} from '@/engine/cnc/rotary/wrap';
import { SAFE_Z, type CamOperation, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { flatEndMill } from '@/engine/cnc/tool';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob, RotaryChuck } from '@/types/engraveJob';

const CHUCK: RotaryChuck = {
  stickout: 85,
  gripDiameter: null,
  jawMode: 'reverse-inner',
  tailstock: true,
  source: 'test',
};

/** The design's starter: a PLA rod ⌀20 × 100, reverse jaws, 15 mm grip, tailstock in. */
function dowelJob(over: Partial<EngraveJob> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'Zoomba on a dowel',
    stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
    workholding: { kind: 'rotary-chuck', rotary: { ...CHUCK } },
    labels: [],
    shapes: [],
    toolKey: 'flat-1.0',
    ...over,
  };
}

describe('the map a rotary job is authored on (R6)', () => {
  it('reads the stock, its circumference and its two bands off the job', () => {
    const map = rotaryMapOf(dowelJob()) as RotaryMap;
    expect(map).not.toBeNull();
    expect(map.radius).toBe(10);
    expect(map.circumference).toBeCloseTo(2 * Math.PI * 10, 12); // 62.83185307179586
    expect(map.stickout).toBe(85);
    expect(map.grip).toBe(15); // 100 mm of rod, 85 mm out of the jaws
    expect(map.length).toBe(100);
    expect(map.tailstock).toBe(true);
    expect(isRotaryJob(dowelJob())).toBe(true);
  });

  it('never says a stick-out past the stock leaves a negative grip', () => {
    const job = dowelJob();
    job.workholding = { kind: 'rotary-chuck', rotary: { ...CHUCK, stickout: 120 } };
    expect(rotaryMapOf(job)?.grip).toBe(0);
  });

  it('is null for a flat job — a rod in the VISE is engraved flat, and a prism cannot turn', () => {
    const flat = defaultEngraveJob();
    expect(rotaryMapOf(flat)).toBeNull();
    expect(isRotaryJob(flat)).toBe(false);

    const rodInVise = dowelJob();
    rodInVise.workholding = flat.workholding;
    expect(rotaryMapOf(rodInVise)).toBeNull();

    const prismInChuck = dowelJob();
    prismInChuck.stock = { ...dowelJob().stock, shape: undefined, diameter: undefined };
    expect(rotaryMapOf(prismInChuck)).toBeNull();
  });
});

describe('the surface arc and the unwound A (R9)', () => {
  it('pins the design’s golden: 15.708 mm of arc is 90° on a ⌀20 rod', () => {
    expect(angleToArc(90, 10)).toBeCloseTo(15.708, 3); // π·R/2
    expect(arcToAngle(15.708, 10)).toBeCloseTo(90, 3);
    expect(angleToArc(90, 10)).toBeCloseTo((Math.PI * 10) / 2, 12);
  });

  it('maps the label’s centre — π·R mm around — to A 180°', () => {
    expect(arcToAngle(Math.PI * 10, 10)).toBeCloseTo(180, 12);
    expect(angleToArc(180, 10)).toBeCloseTo(Math.PI * 10, 12);
  });

  it('never wraps: a full turn is 360, two turns are 720, and the seam is a negative arc', () => {
    expect(arcToAngle(angleToArc(360, 10), 10)).toBeCloseTo(360, 12);
    expect(arcToAngle(angleToArc(720, 10), 10)).toBeCloseTo(720, 12);
    expect(arcToAngle(-Math.PI * 10, 10)).toBeCloseTo(-180, 12);
  });
});

describe('the opening is the tool’s own footprint (R10, §4.2)', () => {
  // The three numbers the design's acceptance fixture names: r_t 0.5, R 10, d 0.5.
  const R = 10;
  const d = 0.5;
  const rt = 0.5;

  it('opens 0.526 mm around against 0.5 mm along X — the design’s anisotropic radius', () => {
    const around = aroundOpeningRadius(rt, R, d);
    expect(around).toBeCloseTo(0.52583, 5);
    expect(around).toBeCloseTo(0.526, 3);
    // Against the tool's own 0.5 mm along X: 5 % wider at engraving depth.
    expect(around / rt).toBeCloseTo(1.0517, 4);
    // The design's linearised form, `r_t·R/(R − d)`: the same 0.526 to three places.
    expect(rt * R / (R - d)).toBeCloseTo(0.52632, 5);
    expect(Math.abs(around - (rt * R) / (R - d)) / around).toBeLessThan(0.001);
  });

  it('is exactly R·atan(r_t/(R − d)) — the angle at which the tip’s edge touches the wall', () => {
    expect(arcToAngle(aroundOpeningRadius(rt, R, d), R)).toBeCloseTo((Math.atan(rt / (R - d)) * 180) / Math.PI, 10);
  });

  it('scales the map so an isotropic offset by r_t IS that footprint', () => {
    const sy = aroundScale(R, d, rt);
    expect(sy).toBeCloseTo(0.950877, 6);
    expect(sy * aroundOpeningRadius(rt, R, d)).toBeCloseTo(rt, 12);
    // It is not the small-angle floor ratio, though it is close to it here.
    expect(sy).not.toBeCloseTo((R - d) / R, 4);
  });

  it('falls back to the floor’s own frame for a tool with no flat footprint', () => {
    expect(aroundScale(R, d, 0)).toBeCloseTo((R - d) / R, 12);
    expect(aroundOpeningRadius(0, R, d)).toBe(0);
  });

  it('has no floor to cut at or past the axis, and says so instead of returning a scale', () => {
    expect(hasFloor(R, d)).toBe(true);
    expect(hasFloor(R, R)).toBe(false);
    expect(hasFloor(R, R + 2)).toBe(false);
    expect(() => aroundScale(R, R, rt)).toThrow(/reaches the axis/);
    expect(() => aroundScale(R, R + 2, rt)).toThrow(/reaches the axis/);
  });

  it('the thin rod’s 3.175 mm cutter: the exact arc, and the 12 % the linear form over-claims', () => {
    const thin = aroundOpeningRadius(1.5875, 3, 0.5);
    expect(thin).toBeCloseTo(1.697274, 6);
    expect(arcToAngle(thin, 3)).toBeCloseTo((Math.atan(1.5875 / 2.5) * 180) / Math.PI, 10); // ≈ 32.4°
    const linear = (1.5875 * 3) / 2.5; // 1.905
    expect((linear - thin) / thin).toBeGreaterThan(0.12);
  });

  it('scales polygons in and back out without a loss', () => {
    const ring: [number, number][] = [
      [1, 2],
      [3, 4],
      [5, 6],
    ];
    const sy = aroundScale(R, d, rt);
    const scaled = scalePolygonsAround([ring], sy);
    const back = scalePolygonsAround(scaled, 1 / sy);
    expect(back[0]![0]![0]).toBeCloseTo(1, 12);
    expect(back[0]![1]![1]).toBeCloseTo(4, 12);
    expect(back[0]![2]![1]).toBeCloseTo(6, 12);
  });
});

describe('the step-over is measured along the arc at the floor (R10, #191)', () => {
  /** Map ring spacing `step / sy`, read as the arc the cut sees at the floor radius R − d. */
  const floorArcStepOver = (R: number, d: number, rt: number, step: number): number =>
    (step / aroundScale(R, d, rt)) * ((R - d) / R);

  it('is the requested step-over on the dowel, to 0.1 %', () => {
    const step = floorArcStepOver(10, 0.5, 0.5, 0.4);
    expect(step).toBeCloseTo(0.399631, 6);
    expect(step).toBeGreaterThan(0.4 * 0.999);
    expect(step).toBeLessThanOrEqual(0.4);
  });

  it('is never WIDER than the requested step-over — at 32° the exact footprint makes it 11 % finer', () => {
    const step = floorArcStepOver(3, 0.5, 1.5875, 0.4);
    expect(step).toBeCloseTo(0.356383, 6);
    expect(step / 0.4).toBeCloseTo(0.890958, 6);
    expect(step).toBeLessThanOrEqual(0.4); // one-sided: finer is safe, wider is the #191 gap
  });
});

describe('the facet term (§4.2, §4.5)', () => {
  it('is 0.013 mm on the dowel — the design’s oracle allowance', () => {
    expect(facetTerm(9.5, 0.5)).toBeCloseTo(0.0131487952, 9);
    expect(facetTerm(9.5, 0.5)).toBeCloseTo(0.013, 3);
  });

  it('is 0.461 mm on the ⌀6 rod under the 3.175 mm flat', () => {
    expect(facetTerm(2.5, 1.5875)).toBeCloseTo(0.4614449598, 9);
  });

  it('is √(Z_t² + r_t²) − Z_t, and zero when either is zero', () => {
    expect(facetTerm(5, 1.5875)).toBeCloseTo(Math.hypot(5, 1.5875) - 5, 12);
    expect(facetTerm(0, 1.5875)).toBe(0);
    expect(facetTerm(5, 0)).toBe(0);
  });
});

describe('toRotaryIR — the map becomes the machine’s frame (R6, R9, R12)', () => {
  const op = (): CamOperation => ({
    number: 1,
    name: '[T1]Engrave "Zoomba"',
    labelId: 'lbl-1',
    depth: 0.5,
    moves: [
      { kind: 'rapid', x: 30, y: 0, z: 5 }, // a flat safeZ retract
      { kind: 'rapid', x: 30, y: Math.PI * 10, z: 1 }, // a flat HOP: below the rotary clearance
      { kind: 'feed', x: 30, y: Math.PI * 10, z: -0.5, f: 500 },
      { kind: 'feed', x: 31, y: Math.PI * 10 + 2 * Math.PI * 10, z: -0.5, f: 500 }, // 1.5 turns on: unwound
    ],
    estimatedSeconds: 0,
  });
  const flatIr = (): ToolpathIR => ({
    frame: 'flat',
    tool: flatEndMill(1),
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    safeZ: 5,
    hopZ: 1,
    operations: [op()],
  });
  const RAPID = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test' };

  it('turns every y into an unwound A, zeroes Y, and raises z to a radius above the axis', () => {
    const out = toRotaryIR(flatIr(), 10, RAPID);
    expect(out.frame).toBe('rotary');
    expect(out.rotary).toEqual({ radius: 10 });
    const moves = out.operations[0]!.moves;
    expect(moves[0]).toMatchObject({ kind: 'rapid', x: 30, y: 0, z: 15, a: 0 });
    expect(moves[1]!.a).toBeCloseTo(180, 12); // π·R mm around = A 180°
    expect(moves[2]!.a).toBeCloseTo(180, 12);
    expect(moves[2]!.z).toBeCloseTo(9.5, 12); // R − d: the surface is R, the floor R − d
    expect(moves[3]!.a).toBeCloseTo(540, 12); // π·R further: unwound, never 180 again
    expect(moves.every((m) => m.y === 0)).toBe(true);
  });

  it('lifts a flat HOP to the rotary clearance, and leaves a high rapid where it was', () => {
    const moves = toRotaryIR(flatIr(), 10, RAPID).operations[0]!.moves;
    expect(moves[1]!.z).toBe(10 + SAFE_Z); // 15, not the flat hop's 11
    expect(moves[0]!.z).toBe(10 + SAFE_Z); // Math.max keeps the flat safeZ's 15
  });

  it('posts the feed F unchanged (R12) and keeps the operation’s own facts', () => {
    const source = flatIr();
    const out = toRotaryIR(source, 10, RAPID);
    const f = (m: { kind: string }): number | undefined => ('f' in m ? (m.f as number) : undefined);
    expect(out.operations[0]!.moves.map(f)).toEqual(source.operations[0]!.moves.map(f));
    expect(out.operations[0]!.name).toBe(source.operations[0]!.name);
    expect(out.operations[0]!.depth).toBe(0.5);
    expect(out.operations[0]!.labelId).toBe('lbl-1');
  });

  it('re-times the cycle with the arc added — a full turn is travel, not standing still', () => {
    const out = toRotaryIR(flatIr(), 10, RAPID);
    expect(out.operations[0]!.estimatedSeconds).toBeGreaterThan(0);
  });
});

describe('the refusal sentences (§4, §6.4) — operator words, units, no codes', () => {
  const CODE =
    /axis-crossing|rotary-y-off-axis|wrap-into-clamp|rotary-rapid-engaged|stock-exceeds-module|rotary-unsupported/;
  const noCode = (text: string): void => {
    expect(text).not.toMatch(CODE);
  };

  it('“cuts through the centre” — the exact depth is its own sentence', () => {
    const exact = throughCentreSentence(0);
    expect(exact).toContain('cuts through the centre');
    expect(exact).toContain('reaches the axis exactly');
    expect(exact).toContain('use a shallower depth or a larger diameter');
    noCode(exact);

    const past = throughCentreSentence(-2);
    expect(past).toContain('cuts through the centre');
    expect(past).toContain('reaches 2 mm past the axis');
    expect(past).toContain('use a shallower depth or a larger diameter');
    noCode(past);
  });

  it('“leaves the line over the axis”', () => {
    const s = offAxisSentence(2.5);
    expect(s).toContain('leaves the line over the axis');
    expect(s).toContain('(Y 2.5 mm)');
    expect(s).toContain('every Y is 0');
    noCode(s);
  });

  it('“runs into the jaws” and “runs into the tailstock’s band”, with the band’s own numbers', () => {
    const jaws = jawsSentence(1.429);
    expect(jaws).toContain('runs into the jaws');
    expect(jaws).toContain(`X 1.429 mm`);
    expect(jaws).toContain(`first ${ROTARY_JAW_KEEP_OUT_MM} mm of the stick-out`);
    noCode(jaws);

    const tail = tailstockSentence(75.571, 85);
    expect(tail).toContain("runs into the tailstock's band");
    expect(tail).toContain('X 75.571 mm');
    expect(tail).toContain(`last ${ROTARY_TAILSTOCK_BAND_MM} mm`);
    expect(tail).toContain('X 75–85 mm');
    noCode(tail);
  });

  it('“turns the stock while the cutter is in it”, with the clearance it lacked', () => {
    const s = turningInCutSentence(9.5, 10);
    expect(s).toContain('turns the stock while the cutter is in it');
    expect(s).toContain('0.5 mm inside the stock');
    expect(s).toContain('Z 9.5 mm');
    expect(s).toContain(`${ROTARY_CLEARANCE_MM} mm of clearance`);
    expect(s).toContain('Z 13 mm');
    noCode(s);

    // Above the surface but short of the clearance, the tip is not "inside" — it is not clear.
    const shallow = turningInCutSentence(11, 10);
    expect(shallow).toContain('not clear of the stock');
    expect(shallow).toContain('Z 11 mm');
    noCode(shallow);
  });

  it('“does not fit the rotary’s ⌀80 × 150 mm”', () => {
    const s = envelopeSentence(90, 160);
    expect(s).toContain(`does not fit the rotary's ⌀${ROTARY_MAX_DIAMETER_MM} × ${ROTARY_MAX_LENGTH_MM} mm`);
    expect(s).toContain('this stock is ⌀90 × 160 mm');
    noCode(s);
  });
});
