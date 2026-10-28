/**
 * #741 — THE SIMULATED CONE ENDS AT THE BIT'S BODY.
 *
 * A V-bit's flank is a cone only up to the height where it meets the cutter's cylindrical body —
 * `(diameter − tip) / (2·tan(halfAngle))`, 1.5375 mm for the bench's 3.175 mm 90° chamfer (0.1 mm
 * tip). Above that height the bit cuts a VERTICAL wall at its stated diameter, not a wider V. The
 * simulation used to keep widening the flank at `tanHalf` however deep the tip went: a 5.1 mm cut
 * with that chamfer was swept as a 10.3 mm-wide V and removed 1431 mm³ of the star pocket where
 * the cutter's real cone takes ~971 (the issue's measurement; 956.9 mm³ here, see
 * `docs/bench/2026-10-28-z1-real-jobs/` for the independent sweep it came from).
 *
 * The two halves pinned here are the ENGINE'S and the PROGRAM'S:
 *
 *   - `columnCutterFor` hands the engine the cone's own end (`VCone.outerRadius`, owned by
 *     `vProfile.ts`), so `surfaceAboveTip` says "no cutter" past it and `cutterReach` stops there;
 *   - a real posted program — a 30 mm V trace cut 5.1 mm deep with that chamfer, generated,
 *     posted, loaded and swept through the same sequence the panel runs — removes the closed-form
 *     volume of a cone that STOPS at the body, not the unbounded cone's.
 *
 * The unbounded form is computed too, and is what the old engine removed (938.6 mm³ measured
 * before this change, 938.5 mm³ from the formula): the regression is the difference between the
 * two, not a tolerance.
 *
 * A TRACE is the vehicle because #741's refusal covers V-CARVE and INLAY items, not engraving
 * traces: a trace deeper than the cone is still planned (the planned part is the user's design),
 * but the simulation must draw the cut the bit can actually make. The j11 fixtures themselves are
 * refused by the depth rule (`vCarveConeDepth.spec.ts`), so no program of theirs exists to sweep.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { createSimSession } from '@/workers/sim/session';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { columnCutterFor, cutterReach, surfaceAboveTip } from '@/workers/geometry/columnEngine';
import { coneHeight, vCone } from '@/engine/cnc/vProfile';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTraceItem } from '@/types/engraveJob';

/** The bench's chamfer: 90° included, 0.1 mm tip, 3.175 mm shank, 1.6 mm stated flute (#741). */
const CHAMFER: Tool = flatEndMill(3.175, {
  id: null,
  name: 'C1-BIT-CHAMFER-90',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: 0.1,
  diameter: 3.175,
  angle: 90,
  halfAngle: 45,
  fluteLength: 1.6,
  cornerRadius: null,
});

const DEPTH = 5.1;
const LENGTH = 30;

function traceJob(): EngraveJob {
  const base = defaultEngraveJob();
  const line: EngraveTraceItem = {
    kind: 'line',
    id: 'tr',
    position: { x: 0, y: 0 },
    rotation: 0,
    points: [
      [10, 20],
      [40, 20],
    ],
    closed: false,
    depth: DEPTH,
    enabled: true,
  } as EngraveTraceItem;
  return {
    ...base,
    name: 'deep V trace',
    stock: { length: 60, width: 60, thickness: 12, material: 'pla' },
    labels: [],
    shapes: [],
    toolKey: 'inv:kz-chamfer-90',
    tool: CHAMFER,
    traces: [line],
    // No location in a unit run: tape keeps the jaw reach out of the picture, as the bench jobs
    // that were cut taped down did.
    workholding: {
      kind: 'tape',
      tape: { width: 20, thickness: 0.2, inset: 2, where: null, squareTo: 'front', source: 'default' },
    },
  };
}

/**
 * The closed-form volume of a V stroke `length` long, swept `depth` deep, whose flank runs from
 * `tipRadius` at `tanHalf` up to `bodyRadius` and then stops: the integral of the capsule's area
 * `2·L·r + A·r²` over height, split at `flank = (bodyRadius − tipRadius)/tanHalf`. `A` is the
 * polygonized disc's area factor, the same n-gon the sweep and the preview use.
 *
 * With `bodyRadius` above the depth's own mouth this reduces to the plain cone (`flank = depth`);
 * with it below, the upper term is the body's constant cross-section.
 */
function strokeVolume(
  length: number,
  tipRadius: number,
  tanHalf: number,
  bodyRadius: number,
  flank: number,
  depth: number,
): number {
  const n = segmentsForRadius(bodyRadius);
  const disc = (n / 2) * Math.sin((2 * Math.PI) / n);
  const cone =
    2 * length * (tipRadius * flank + (tanHalf * flank * flank) / 2) +
    disc * (tipRadius * tipRadius * flank + tipRadius * tanHalf * flank * flank + (tanHalf * tanHalf * flank ** 3) / 3);
  const body = (depth - flank) * (2 * length * bodyRadius + disc * bodyRadius * bodyRadius);
  return cone + body;
}

describe('the engine is handed the cone’s body (#741)', () => {
  it('carries the stated diameter as the cone’s outer radius, and says “no cutter” past it', () => {
    const cut = columnCutterFor(CHAMFER);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.kind).toBe('v');
    expect(cut.cutter.outerRadius).toBeCloseTo(3.175 / 2, 9);

    // The flank is the cone's own height where it meets the body, and untouched beyond it. Before
    // this change the engine was given no outer radius at all, so it grew the flank for ever.
    const flank = coneHeight(vCone(CHAMFER)!)!;
    expect(flank).toBeCloseTo(1.5375, 9);
    // At the body's radius the flank stands exactly its own height above the tip; one micron out
    // there is no cutter at all.
    expect(surfaceAboveTip(cut.cutter, 3.175 / 2)).toBeCloseTo(flank, 9);
    expect(surfaceAboveTip(cut.cutter, 3.175 / 2 + 1e-9)).toBe(Infinity);
    expect(surfaceAboveTip(cut.cutter, 3)).toBe(Infinity);
  });

  it('stops the sweep’s footprint at the body, however deep the tip is', () => {
    const cut = columnCutterFor(CHAMFER);
    if (!cut.ok) throw new Error(cut.reason);
    // The unbounded flank would reach 0.05 + 5.1·tan 45° = 5.15 mm; the bit's body is 1.5875.
    expect(cutterReach(cut.cutter, DEPTH)).toBeCloseTo(1.5875, 9);
    expect(cutterReach(cut.cutter, 100)).toBeCloseTo(1.5875, 9);
  });

  it('leaves a record that states no wider diameter open, as it was before #741', () => {
    // The degenerate-record rule: a stated diameter not wider than the tip states no body, so the
    // engine must not invent a 0 mm cone. `flatEndMill(tip, { tipDiameter: tip })` is the tests'
    // shorthand and reads this way.
    const noBody: Tool = { ...CHAMFER, diameter: null };
    const cut = columnCutterFor(noBody);
    if (!cut.ok) throw new Error(cut.reason);
    expect(cut.cutter.outerRadius).toBeUndefined();
    expect(surfaceAboveTip(cut.cutter, 5)).toBeCloseTo((5 - 0.05) / 1, 9);
    expect(cutterReach(cut.cutter, DEPTH)).toBeCloseTo(0.05 + DEPTH, 9);
  });
});

describe('a posted deep V trace sweeps the capped cone (#741)', () => {
  it('removes the body-capped stroke, not the unbounded flank', () => {
    const job = traceJob();
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    expect(g.nc).not.toBeNull();
    if (g.nc === null) return;

    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc, toSetup(job, Z1), CHAMFER, Z1.id);
      expect(load.ok).toBe(true);
      if (!load.ok) return;
      expect(load.stats.engine).toBe('column');

      const cone = vCone(CHAMFER)!;
      const flank = coneHeight(cone)!;
      const bodyRadius = cone.outerRadius!;
      // What the bit can cut: the flank to 1.5375 mm, then the 3.175 mm body's vertical wall.
      const capped = strokeVolume(LENGTH, cone.tipRadius, cone.tanHalf, bodyRadius, flank, DEPTH);
      // What the old model cut: the same flank continued to the top face, 0.05 + 5.1 mm out.
      const mouthRadius = cone.tipRadius + cone.tanHalf * DEPTH;
      const unbounded = strokeVolume(LENGTH, cone.tipRadius, cone.tanHalf, mouthRadius, DEPTH, DEPTH);

      // The sweep's own grid answers to about a percent of the closed form.
      expect(load.stats.removedVolume).toBeGreaterThan(capped * 0.97);
      expect(load.stats.removedVolume).toBeLessThan(capped * 1.03);

      // The defect, as a number: the unbounded cone removes more than twice as much. The old
      // engine measured 938.6 mm³ on this program, the unbounded form's own answer (938.5).
      expect(unbounded).toBeGreaterThan(capped * 2);
      expect(load.stats.removedVolume).toBeLessThan(unbounded * 0.5);
    } finally {
      session.dispose();
    }
  }, 120_000);
});
