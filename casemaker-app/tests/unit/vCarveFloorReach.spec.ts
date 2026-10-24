// #584 — a V region's FLOOR is what the toolpath can actually reach.
//
// The badge job's "br" outline carries a Ø0.61 mm dot. At 0.998 mm deep in a 0.81 mm film the 30°
// V-bit's groove is 0.6007 mm wide at the colour plane, so `pocketLoops` — which erodes the design
// by the PLANE radius (0.3004 per side) before its first ring — erodes the dot away, while the
// prediction took the floor as `design − floorInset` (a 0.509 disc) and promised it. The oracle
// read the difference as 0.0815 mm² of under-cut. The same class appears at every convex corner,
// where the two constructions differ by more than the chord error, and wherever a component is
// too small to survive the first erosion.
//
// The prediction is the side that is wrong: the floor the CAM promises is the plane ring swept by
// the TIP disc, `(design − planeRadius) ⊕ tipRadius`. On a straight wall that is `design −
// floorInset`; at a convex corner it lies strictly INSIDE that erosion (no ring reaches the
// point); and a component the erosion annihilates leaves nothing at all. `vCarvePlane`'s
// `floorInset` stays the plane-to-floor distance the run sheet states; the OUTLINE is the
// reachable one.
//
// The pin is the identity: the prediction's floor must equal the CAM's own two offsets of the
// same design, or a regression to any approximation is caught here. The integration test then
// runs the whole job through the column engine and the oracle on the same job.

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { createSimSession } from '@/workers/sim/session';
import { engraveRegions } from '@/workers/sim/engraveGenerate';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import { vCone } from '@/engine/cnc/vProfile';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { ORACLE_AREA_FLOOR } from '@/engine/cnc/engrave/oracle';
import { Z1 } from '@/engine/cnc/machine';
import type { Tool } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';

/** The badge's cutter: 30° engraver, 0.5 mm flat. */
const bit = (): Tool => ({
  number: 1,
  id: 'C1-BIT-ENGRAVE-30-0.5',
  name: 'Single Flute Engraving Bit 30 x 0.5',
  typeText: 'Engraving',
  shape: 'engraving',
  handleDiameter: 3.175,
  tipDiameter: 0.5,
  diameter: 3.175,
  cornerRadius: 0,
  angle: 30,
  halfAngle: 15,
  fluteLength: null,
  shoulderLength: null,
  stickout: null,
  centreCutting: null,
});

/**
 * A PLUS — four convex arm tips. Eroding by the PLANE radius and dilating by the tip radius rounds
 * a convex corner with the larger construction, so the reachable floor pulls back from the point
 * further than `design − floorInset` did: the two constructions differ here, which is what makes
 * the identity test bite. The four reflex corners are the mirror case — there the two agree, and
 * the assertion covers them too.
 */
function plusJob(): EngraveJob {
  const base = defaultEngraveJob();
  const arm = 3;
  const half = 10;
  const contour: [number, number][] = [
    [-arm, -half],
    [arm, -half],
    [arm, -arm],
    [half, -arm],
    [half, arm],
    [arm, arm],
    [arm, half],
    [-arm, half],
    [-arm, arm],
    [-half, arm],
    [-half, -arm],
    [-arm, -arm],
  ];
  const vector = {
    kind: 'vector' as const,
    id: 'plus',
    sourceName: 'spec',
    contours: [contour],
    fillRule: 'NonZero' as const,
    width: 2 * half,
    height: 2 * half,
    position: { x: 16, y: 16 },
    rotation: 0,
    depth: 0.998,
    enabled: true,
  };
  return {
    ...base,
    name: 'v-carve plus',
    stock: {
      length: 32,
      width: 32,
      thickness: 3.81,
      material: 'pla',
      colour: { kind: 'printed', capMm: 0.81, layerHeight: 0.2 },
    },
    workholding: {
      kind: 'vise',
      vise: {
        stockProud: 0.71,
        seat: 'ledge',
        fixedJawThickness: 10,
        movingJawThickness: 10,
        jawLength: 100,
        jawStartY: -10,
        source: 'default',
        uncertainty: 0.5,
      },
    },
    labels: [],
    shapes: [],
    traces: [],
    vectors: [vector],
    toolKey: 'inv:kz-engrave-30-0-5',
    tool: bit(),
    minFloor: 0.2,
    edgeMargin: 0.5,
  };
}

describe('#584 a V region’s floor is only what the toolpath reaches', () => {
  it('is derived from the ring arithmetic the CAM uses — not the floorInset approximation', () => {
    const job = plusJob();
    const tool = jobTool(job)!;
    const regions = engraveRegions(tl, job, tool);
    const cone = vCone(tool)!;
    const offset = makeClipperOffset(tl);
    const carved = regions.regions.filter((r) => r.vCarve !== undefined);
    expect(carved.length).toBeGreaterThan(0);
    for (const region of carved) {
      // The CAM's own construction: the first ring (design − planeRadius) swept by the tip disc.
      const reachable = offset(offset(region.polygons, -region.vCarve!.planeRadius), cone.tipRadius);
      expect(region.vCarve!.floor).toEqual(reachable);
    }
  });

  it('hands the same job to the column engine and the oracle without an under-cut', () => {
    const job = plusJob();
    const tool = jobTool(job)!;
    const g = generate(tl, job);
    expect(g.ok, JSON.stringify({ errors: g.errors })).toBe(true);
    if (g.nc === null) throw new Error(g.errors.map((e) => e.message).join('; '));

    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc, toSetup(job, Z1), tool, Z1.id);
      if (!load.ok) throw new Error(JSON.stringify(load.diagnostics));
      expect(load.stats.engine).toBe('column');

      const report = session.oracle(g.predicted);
      expect(report.ok, JSON.stringify(report.worst)).toBe(true);
      expect(report.worst.underCut).toBeLessThanOrEqual(report.areaFloor ?? ORACLE_AREA_FLOOR);
    } finally {
      session.dispose();
    }
  });
});
