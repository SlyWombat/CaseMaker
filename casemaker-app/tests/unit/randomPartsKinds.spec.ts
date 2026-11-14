/**
 * #964 — THE WIDENED GENERATOR'S OWN CHECKS (#959/#960).
 *
 * `randomParts.ts` grew four curved kinds for the model pipeline: a sloped-floor pocket, a
 * floor-filleted pocket, a spherical scoop and an undercut-free figure. Before a property test
 * plans them, each part must be proven to be what the test claims:
 *
 *   - the part reaches the stock bottom and its top, so "stock = the part's blank" holds;
 *   - the curved surfaces land in `FeatureTree.remainder` — not folded into a flat floor or a
 *     wall — with the slopes the geometry implies;
 *   - nothing is flagged as an undercut (`tree.unreachable` is empty): these parts are machinable
 *     from one top setup, which is the point of the figures' stand-in;
 *   - the goal heightfield samples the design at the part centre, so the measurement the property
 *     tests read is the geometry the planner saw.
 *
 * The plate kinds are included so the widened file is pinned to its first-wave behaviour: three
 * pockets, no remainder, no undercut.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart, type PartKind, type RandomPart } from '../tools/randomParts';
import { sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { NO_SHOP } from '../tools/noShop';

const SEEDS = [1, 2, 3] as const;
const KINDS: PartKind[] = ['rectilinear', 'filleted', 'sloped', 'filletedFloor', 'scooped', 'figure'];

/** The steepest slope among the remainder regions, degrees (0 = horizontal, 90 = vertical). */
function steepestSlope(part: RandomPart): number {
  return Math.max(0, ...part.tree.remainder.map((r) => r.slopeDeg[1]));
}

function nearestCell(field: ReturnType<typeof sampleGoalHeightfield>, x: number, y: number): { z: number; covered: boolean } {
  const i = Math.round((x - field.x0) / field.pitch);
  const j = Math.round((y - field.y0) / field.pitch);
  if (i < 0 || j < 0 || i >= field.nx || j >= field.ny) return { z: NaN, covered: false };
  return { z: field.z[j * field.nx + i]!, covered: field.covered[j * field.nx + i] === 1 };
}

describe('#964 the widened seeded parts', () => {
  for (const kind of KINDS) {
    for (const seed of SEEDS) {
      it(`${kind} seed ${seed}: design and recognition agree`, () => {
        const part = buildRandomPart(seed, kind, tl);

        // The blank: the part spans the stock's full thickness, top at 0, bottom at -10.
        expect(part.mesh.bbox.min[2], `${kind} seed ${seed}: part bottom`).toBeCloseTo(-part.stock.thickness, 2);
        expect(part.mesh.bbox.max[2], `${kind} seed ${seed}: part top`).toBeCloseTo(0, 2);
        expect(Math.abs(part.tree.frame.partTop), `${kind} seed ${seed}: tree partTop ${part.tree.frame.partTop}`).toBeLessThanOrEqual(0.01);
        expect(part.tree.frame.partBottom, `${kind} seed ${seed}: tree partBottom`).toBeCloseTo(-part.stock.thickness, 2);
        expect(part.tree.contour.outline.length, `${kind} seed ${seed}: no silhouette`).toBeGreaterThan(0);

        // Every kind is machinable from one top setup: nothing may be flagged unreachable. The
        // plate kinds' island used to leave a zero-height entry (its underside, floating 1 mm
        // above the pocket floor); #969 fixed the fixture, so the rule is the same for all kinds.
        expect(
          part.tree.unreachable.map((u) => u.reason),
          `${kind} seed ${seed}: flagged as unreachable`,
        ).toEqual([]);

        if (kind === 'rectilinear' || kind === 'filleted') {
          expect(part.tree.pockets.length, `${kind} seed ${seed}: pockets`).toBeGreaterThanOrEqual(3);
          expect(part.tree.remainder.length, `${kind} seed ${seed}: a flat plate has no remainder`).toBe(0);
        } else {
          const area = part.tree.remainder.reduce((s, r) => s + r.area, 0);
          expect(part.tree.remainder.length, `${kind} seed ${seed}: no remainder region`).toBeGreaterThanOrEqual(1);
          expect(area, `${kind} seed ${seed}: remainder area`).toBeGreaterThan(50);
        }

        if (kind === 'sloped') {
          const slope = steepestSlope(part);
          expect(slope, `${kind} seed ${seed}: steepest remainder slope ${slope.toFixed(1)}°`).toBeGreaterThan(3);
          expect(slope, `${kind} seed ${seed}: steepest remainder slope ${slope.toFixed(1)}°`).toBeLessThan(30);
        }
        if (kind === 'filletedFloor') {
          const slope = steepestSlope(part);
          expect(slope, `${kind} seed ${seed}: the fillet reaches steep: ${slope.toFixed(1)}°`).toBeGreaterThan(45);
        }
        if (kind === 'scooped') {
          const slope = steepestSlope(part);
          expect(slope, `${kind} seed ${seed}: scoop rim slope ${slope.toFixed(1)}°`).toBeGreaterThan(20);
          expect(slope, `${kind} seed ${seed}: scoop rim slope ${slope.toFixed(1)}°`).toBeLessThan(60);
        }

        // The goal heightfield samples the design at the centre: the pocket floor, the bowl's
        // bottom, or the figure's apex.
        const expects = part.expects;
        expect(expects?.centreZ, `${kind} seed ${seed}: no centre expectation`).toBeDefined();
        const field = sampleGoalHeightfield(part.target, { maxCells: NO_SHOP.goalMaxCells, pitchMm: 0.1, stockTopZ: 0 });
        const centre = nearestCell(field, 0, 0);
        expect(centre.covered, `${kind} seed ${seed}: the goal does not cover the centre`).toBe(true);
        expect(
          Math.abs(centre.z - expects!.centreZ!),
          `${kind} seed ${seed}: goal centre ${centre.z.toFixed(3)} mm, design says ${expects!.centreZ!.toFixed(3)} mm`,
        ).toBeLessThanOrEqual(0.05);
      }, 60_000);
    }
  }
});
