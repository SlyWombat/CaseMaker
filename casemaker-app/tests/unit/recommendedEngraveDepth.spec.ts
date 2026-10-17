// #492 J19 — the maintainer's 2026-10-17 rule: ENGRAVE (flat or V) is available on ANY stock, and
// the depth is always the operator's choice. The stock kind only changes the recommendation the
// depth field arrives filled with, and the sentence beside it:
//
//   - laminate → through the cap plus the margin (0.1 mm on the 0.075 mm fixture);
//   - printed two-colour → through the colour line plus the margin (the #285 model);
//   - plain stock → the shop's engraving-depth default, with provenance.
//
// One function answers all three (`recommendedEngraveDepth`), and the panel, the run sheet and the
// store's seeded depth read it. These tests pin the three branches and the no-cap V-carve case: a
// blank with no colour line has no film, so `vCarvePlane` puts the plane AT the floor and the
// recommendation says so rather than requiring `stock.colour`.

import { describe, expect, it } from 'vitest';

import {
  LAMINATE_CAP_MARGIN_MM,
  recommendLabelDepth,
  recommendedEngraveDepth,
} from '@/engine/cnc/engrave/depthBounds';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { vCarvePlane } from '@/engine/cnc/vCarveGeometry';
import { vCone, type VCone } from '@/engine/cnc/vProfile';
import { flatEndMill } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';

const base = (): EngraveJob => defaultEngraveJob();

/** The 30° × 0.3 mm engraver the text job uses. */
function bit30(): VCone {
  const cone = vCone(
    flatEndMill(0.3, {
      shape: 'engraving',
      tipDiameter: 0.3,
      diameter: 3.175,
      halfAngle: 15,
      angle: 30,
    }),
  );
  if (cone === null) throw new Error('the 30° bit must have a cone');
  return cone;
}

describe('the depth a stock kind recommends (#492 J19)', () => {
  it('plain stock: the shop’s engraving-depth default, with provenance', () => {
    const stock = base().stock;
    expect(stock.colour).toBeUndefined();

    const rec = recommendedEngraveDepth(stock, {
      shopDepth: { value: 1.2, source: 'chosen' },
    });
    expect(rec.depth).toBe(1.2);
    expect(rec.source).toBe('shop-default');
    expect(rec.plane).toBeNull();
    expect(rec.reason).toContain('1.2 mm');
    expect(rec.reason).toContain('chosen');
    expect(rec.reason).toContain('not measured');
    expect(rec.reason).toContain("depth stays the operator's choice");

    // No location at all — the hosted build — still starts somewhere, and says the number is the
    // labelled fallback rather than pretending a shop chose it.
    const fallback = recommendedEngraveDepth(stock);
    expect(fallback.depth).toBe(0.5);
    expect(fallback.source).toBe('shop-default');
    expect(fallback.reason).toContain('built-in 0.5 mm fallback');
    expect(fallback.reason).toContain('no location states an engraving depth');
  });

  it('printed two-colour: through the colour line plus the margin, on the layer grid', () => {
    const job = base();
    // 12 mm blank, 1.4 mm top colour, 0.2 mm layers: the boundary is 1.4 mm down, and the #285
    // model keeps one 0.2 mm layer clear of it.
    const stock: EngraveJob['stock'] = {
      ...job.stock,
      colour: { kind: 'printed', capMm: 1.4, layerHeight: 0.2, firstLayerHeight: 0.2 },
    };
    const rec = recommendedEngraveDepth(stock, { boundaryMargin: 0.2 });
    expect(rec.depth).toBe(1.6);
    expect(rec.plane).toBeCloseTo(1.4, 9);
    expect(rec.source).toBe('printed-colour-line');
    expect(rec.reason).toContain('the colour split is 1.4 mm under the face');
    expect(rec.reason).toContain('reaching the bottom colour needs 1.6 mm');
    expect(rec.reason).toContain('one 0.2 mm printed layer');

    // The job's own margin wins over the layer height, exactly as `effectiveMargins` resolves it.
    expect(recommendedEngraveDepth(stock, { boundaryMargin: 0.28 }).depth).toBe(1.68);
  });

  it('laminate: through the cap plus the laminate margin — 0.1 mm on the fixture', () => {
    const job = base();
    const stock: EngraveJob['stock'] = {
      ...job.stock,
      material: 'plastic',
      thickness: 1.5,
      colour: { kind: 'laminate', capMm: 0.075 },
    };
    const rec = recommendedEngraveDepth(stock);
    expect(rec.source).toBe('laminate-cap');
    expect(rec.plane).toBe(0.075);
    expect(rec.depth).toBe(0.1);
    expect(LAMINATE_CAP_MARGIN_MM).toBe(0.025);
    expect(rec.reason).toContain('cap is 0.075 mm under the face');
    expect(rec.reason).toContain('going through the top colour needs 0.1 mm');
    expect(rec.reason).toContain('0.025 mm clear of the cap');
    // The printed margin is NOT applied: a laminate has no printed layer grid.
    expect(recommendedEngraveDepth(stock, { boundaryMargin: 0.2 }).depth).toBe(0.1);
  });

  it('the per-item recommendation uses the same laminate sentence the panel and sheet print', () => {
    const job = base();
    const laminate: EngraveJob = {
      ...job,
      stock: {
        ...job.stock,
        material: 'plastic',
        thickness: 1.5,
        colour: { kind: 'laminate', capMm: 0.075 },
      },
    };
    const rec = recommendLabelDepth(laminate, laminate.labels[0]!, {
      voidLimit: null,
      jawReach: { jaw: 'fixed', gap: 20, reaches: false, overJaw: false },
      boundaryMargin: 0.2,
    })!;
    expect(rec.depth).toBe(0.1);
    // `basis[0]` is the sentence the panel's row and the run sheet's `depthSourceWords` both print.
    expect(rec.basis[0]).toBe(recommendedEngraveDepth(laminate.stock).reason);
    // The colour intent is a printed-layer statement; a laminate has no grid to stamp one against.
    expect(rec.depthIntent).toBeUndefined();
  });

  it('V-carve with no cap: the plane is the floor, and the recommendation says so', () => {
    const rec = recommendedEngraveDepth(base().stock, {
      shopDepth: { value: 0.5, source: 'chosen' },
    });
    expect(rec.plane).toBeNull();
    expect(rec.reason).toContain('V-carve’s plane is the floor');

    // End to end with #221's geometry: `film` null means no colour plane, so `belowPlane` is zero
    // and the plane radius is the tip's own radius — the design is cut at the floor.
    const plane = vCarvePlane(bit30(), rec.depth, rec.plane);
    expect(plane.film).toBe(0);
    expect(plane.belowPlane).toBe(0);
    expect(plane.floorInset).toBe(0);
    expect(plane.planeRadius).toBeCloseTo(0.15, 12);

    // …and no refusal is keyed to the stock kind: the only V gate is the groove's width against the
    // machine step (`vCarveGrooveRefusal`), which this plane passes on a 0.01 mm step.
    expect(plane.grooveWidth).toBeGreaterThan(0.01);
  });
});
