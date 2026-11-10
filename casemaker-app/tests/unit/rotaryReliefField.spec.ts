/**
 * #723 R-1 — THE RADIAL HEIGHTFIELD, pinned.
 *
 * The field is the rotary analogue of the flat goal's top-Z: a radius per (x, φ) on the map. The
 * fixtures are meshes whose radius is known in closed form — a cylinder, a cone, a half shell —
 * so the sampler is judged against the shape, not against itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sampleGoalRadialField } from '@/engine/cnc/cam/rotaryRelief';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import type { EngraveTargetObject } from '@/types/engraveJob';
import { stl } from './helpers/meshes';

type V = [number, number, number];
type Tri = [V, V, V];

let serial = 0;
function goal(tris: Tri[], size: { x: number; y: number; z: number }, over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: 'part',
    name: 'part.stl',
    format: 'stl',
    sha256: (serial++).toString(16).padStart(64, 'a'),
    data: stl(tris),
    size,
    position: { x: 50, y: 0, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

const TAU = Math.PI * 2;

/** A solid of revolution's SIDE surface: r(x) over x ∈ [−L/2, L/2], angles 0…span. */
function sideTris(
  radiusAt: (x: number) => number,
  length: number,
  span = TAU,
  seg = 180,
): Tri[] {
  const tris: Tri[] = [];
  const at = (x: number, a: number): V => [x, radiusAt(x) * Math.sin(a), radiusAt(x) * Math.cos(a)];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * span;
    const a1 = ((i + 1) / seg) * span;
    const x0 = -length / 2;
    const x1 = length / 2;
    tris.push([at(x0, a0), at(x1, a0), at(x1, a1)], [at(x0, a0), at(x1, a1), at(x0, a1)]);
  }
  return tris;
}

/** The field's cell for a map (x, arc). */
function cell(f: ReturnType<typeof sampleGoalRadialField>, x: number, arc: number): number {
  const i = Math.round((x - f.x0) / f.pitch);
  const j = ((Math.round((arc - f.y0) / f.pitch) % f.ny) + f.ny) % f.ny;
  return j * f.nx + i;
}

/**
 * #1096 — A TRIANGLE THAT SPANS THE SEAM IS CAST AT ITS OWN ROW'S ANGLE.
 *
 * The footprint raster casts row `jj` (the UNWRAPPED index, negative when the triangle's first
 * vertex has a negative φ) at `(jj · pitch) / radius − seam`, but RECORDS the hit in the WRAPPED
 * row `j = jj mod ny`. The grid does not close — `ny = ceil(2πR / pitch)`, so `ny · pitch` is up to
 * one cell MORE than the circumference — and a negative `jj` is therefore cast that fraction of a
 * cell (δ = ny − 2πR/pitch cells) away from the row it is written to. A triangle that straddles
 * the seam from the negative side is sampled δ cells off its row; at a cliff (the panther's
 * near-axis facets at θ 178–182°) the row reads the wrong radius entirely — the 36 pinholes.
 *
 * The fixture: a ⌀26 stock (R 13.005, chosen so 2πR/pitch = 817.13 → ny 818 and δ ≈ 0.87 cells)
 * around a radius-10 body, with a narrow radius-12 ridge whose two facets lie exactly across
 * φ = ±180°. The first facet's first vertex is just past π (atan2 gives it a negative angle), so
 * the base build casts its rows δ off — the seam row then reads the body (10) instead of the ridge
 * (12). The same mesh with the seam turned half a turn (position.y = πR) puts the ridge at the
 * map's start with positive unwrapped rows, and reads the ridge correctly — which is the
 * acceptance's invariance: one mesh, two placements, the same radius at its ridge row.
 */
describe('#1096 — the seam rows are cast at their own angle', () => {
  const PITCH = 0.1;
  const R = 13.005; // stock radius (⌀26.01): the row grid does not close over the circumference
  const BODY = 10;
  const RIDGE = 12;

  /** The body (a full-circle radius-10 solid) plus a radius-12 ridge across the seam. */
  function seamTris(): { tris: Tri[]; peak: { theta: number; j0: number } } {
    // The first row at or past the far side of the seam (φ = π); the ridge is centred on it.
    const j0 = Math.ceil((Math.PI * R) / PITCH);
    const theta = (j0 * PITCH) / R; // its map angle, just past π
    const h = 0.6 * (PITCH / R); // half a ridge: only this row's grid point falls inside
    const tris = sideTris(() => BODY, 10, TAU, 360);
    const x0 = -5;
    const x1 = 5;
    const at = (x: number, a: number): V => [x, RIDGE * Math.sin(a), RIDGE * Math.cos(a)];
    // a0 is just PAST π, so atan2 gives it a NEGATIVE angle — the unwrapped footprint starts
    // negative, which is the whole mechanism.
    const a0 = theta + h;
    const a1 = theta - h;
    tris.push([at(x0, a0), at(x1, a0), at(x1, a1)]);
    tris.push([at(x0, a0), at(x1, a1), at(x0, a1)]);
    return { tris, peak: { theta, j0 } };
  }

  const size = { x: 10, y: 2 * RIDGE, z: 2 * RIDGE };

  it('reads the ridge at the seam row, and at the row the half-turn placement puts it on', () => {
    const { tris, peak } = seamTris();
    const placed = goal(tris, size); // seam 0: the ridge straddles φ = ±180°
    const turned = { ...placed, position: { ...placed.position, y: Math.PI * R } }; // seam half a turn

    const f0 = sampleGoalRadialField(placed, R, { pitchMm: PITCH });
    const f1 = sampleGoalRadialField(turned, R, { pitchMm: PITCH });
    // The half-turn placement's rows are POSITIVE at the same physical ridge, so the base build
    // samples it correctly — the control that isolates the bug to the negative-φ rows.
    const peakRow1 = cell(f1, 50, 0);
    expect(f1.z[peakRow1]).toBeCloseTo(RIDGE - R, 3);
    // The seam placement must read the same ridge radius at its own row. At the base it reads the
    // body (10) instead of the ridge (12): the row was cast δ ≈ 0.87 cells off.
    const ridgeRow0 = cell(f0, 50, peak.j0 * PITCH);
    expect(f0.z[ridgeRow0]).toBeCloseTo(RIDGE - R, 3);
    // The two placements' rows are a fraction of a cell apart, so the chord hit differs by 1e-4 mm.
    expect(f0.z[ridgeRow0]).toBeCloseTo(f1.z[peakRow1] as number, 3);
    // The rows either side are the body: the ridge is one row wide, not a smear.
    expect(f0.z[cell(f0, 50, (peak.j0 - 1) * PITCH)]).toBeCloseTo(BODY - R, 3);
    expect(f0.z[cell(f0, 50, (peak.j0 + 1) * PITCH)]).toBeCloseTo(BODY - R, 3);
  });
});

describe('#723 R-1 — a solid of revolution reads back as its own radius', () => {
  const R = 10; // ⌀20 stock

  it('a ⌀16 cylinder over 30 mm is radius 8 everywhere covered', () => {
    const f = sampleGoalRadialField(goal(sideTris(() => 8, 30), { x: 30, y: 16, z: 16 }), R, { pitchMm: 0.5 });
    expect(f.coveredCount).toBeGreaterThan(0);
    expect(f.minRadius).toBeCloseTo(8, 1);
    expect(f.maxRadius).toBeCloseTo(8, 1);
    expect(f.x0).toBeCloseTo(35, 5);
    expect(f.nx * f.pitch).toBeGreaterThanOrEqual(30 - f.pitch);
    // Every covered cell's height is the same: the part is 2 mm inside the stock.
    for (let k = 0; k < f.z.length; k++) {
      if (f.covered[k] !== 1) continue;
      expect(f.z[k]!).toBeCloseTo(8 - R, 1);
    }
    expect(f.resolutionNote).toContain('⌀20 mm rod');
  });

  it('a cone follows its own radius along the rod', () => {
    // r = 4 at x = −15, 9 at x = +15.
    const f = sampleGoalRadialField(goal(sideTris((x) => 4 + ((x + 15) / 30) * 5, 30), { x: 30, y: 18, z: 18 }), R, {
      pitchMm: 0.5,
    });
    const left = f.z[cell(f, 37, 0)]! + R;
    const right = f.z[cell(f, 63, 0)]! + R;
    expect(left).toBeCloseTo(4 + (2 / 30) * 5, 1);
    expect(right).toBeCloseTo(4 + (28 / 30) * 5, 1);
    expect(f.minRadius).toBeCloseTo(4, 1);
    expect(f.maxRadius).toBeCloseTo(9, 1);
  });

  it('a cell no triangle covers keeps the stock’s surface (the sentinel)', () => {
    // A half shell: angles 0…π. The other half has no surface, so those rays hit nothing.
    const f = sampleGoalRadialField(goal(sideTris(() => 8, 30, Math.PI), { x: 30, y: 16, z: 16 }), R, { pitchMm: 0.5 });
    const covered = f.z[cell(f, 50, Math.PI / 2)]!;
    expect(covered).toBeCloseTo(8 - R, 1);
    const k = cell(f, 50, (3 * Math.PI) / 2 * R);
    expect(f.covered[k]).toBe(0);
    expect(f.z[k]).toBe(0);
  });

  it('position.y turns the part about the rod: the half shell’s band moves with the seam', () => {
    const seamShift = Math.PI * R; // half a turn in map millimetres
    const f = sampleGoalRadialField(
      goal(sideTris(() => 8, 30, Math.PI), { x: 30, y: 16, z: 16 }, { position: { x: 50, y: seamShift, z: 0 } }),
      R,
      { pitchMm: 0.5 },
    );
    // The shell now covers the second half of the circumference.
    expect(f.z[cell(f, 50, (3 * Math.PI) / 2 * R)]!).toBeCloseTo(8 - R, 1);
    const k = cell(f, 50, Math.PI / 2);
    expect(f.covered[k]).toBe(0);
  });

  it('a mesh larger than the stock still samples: maxRadius says it does not fit', () => {
    const f = sampleGoalRadialField(goal(sideTris(() => 12, 20), { x: 20, y: 24, z: 24 }), R, { pitchMm: 0.5 });
    expect(f.maxRadius).toBeCloseTo(12, 1);
    expect(f.minRadius).toBeCloseTo(12, 1);
  });

  it('the cap coarsens the pitch and says so rather than refusing', () => {
    const f = sampleGoalRadialField(goal(sideTris(() => 8, 30), { x: 30, y: 16, z: 16 }), R, {
      pitchMm: 0.1,
      maxCells: 2000,
    });
    expect(f.pitch).toBeGreaterThan(0.1);
    expect(f.resolutionNote).toContain('coarsened');
    // The cell counts are derived from the coarsened pitch with a ceil, so a few cells over the
    // cap is expected; the pitch itself was raised, which is the contract.
    expect(f.nx * f.ny).toBeLessThanOrEqual(2200);
  });

  it('a picture is refused by name — a rotary relief needs a mesh', () => {
    expect(() =>
      sampleGoalRadialField(
        { sha256: 'x', format: 'png', data: undefined, position: { x: 0, y: 0, z: 0 }, scale: undefined },
        R,
      ),
    ).toThrow(/picture relief is a flat heightfield/);
  });

  it('a non-positive stock radius is refused before any geometry', () => {
    expect(() => sampleGoalRadialField(goal(sideTris(() => 8, 30), { x: 30, y: 16, z: 16 }), 0)).toThrow(
      /positive stock radius/,
    );
  });
});

// #1164 slice (b) — THE FIELD IS THE DESIGN ∩ THE ROD (#1155's corrected ruling, design note §6).
// A ray whose outermost hit is beyond the rod must not be read as a full-radius shelf: if the rod
// surface point is outside the design, the goal there is the outermost design surface INSIDE the
// rod. The fixtures are surface rings whose crossings are known: a sleeve outside the rod is two
// crossings (even → outside at R), a part through the rod is one (odd → inside at R).
describe('#1164 — the field is the design ∩ the rod', () => {
  const R = 10; // ⌀20 rod
  const PITCH = 0.5;
  const SPAN = { x: 20, y: 26, z: 26 };
  /** A full-circle surface at this radius over the span; two of them are a sleeve. */
  const ring = (r: number): Tri[] => sideTris(() => r, 20);

  it('an oversize sleeve over a groove samples the groove, not the rod surface', () => {
    // Inside the rod: the radius-5 groove. Outside it: a radius-11 and radius-13 sleeve, so every
    // ray crosses the mesh twice beyond R — the rod surface point is air, and the design there is
    // the groove.
    const f = sampleGoalRadialField(goal([...ring(5), ...ring(11), ...ring(13)], SPAN), R, { pitchMm: PITCH });
    const k = cell(f, 50, 0);
    expect(f.covered[k]).toBe(1);
    expect(f.z[k]).toBeCloseTo(5 - R, 2);
    // The warning keeps the TRUE reach: the sleeve is still stated as oversize.
    expect(f.maxRadius).toBeGreaterThanOrEqual(13 - 0.01);
    // #1164 review — the reach bound follows the rewritten values: the groove floor is the nearest
    // thing to the axis, nearer than any outermost hit the raster recorded.
    expect(f.minRadius).toBeCloseTo(5, 2);
    // The second pass's work is a field, not an operator sentence.
    expect(f.recastCells).toBeGreaterThan(0);
  });

  it('a degenerate ray at a low-poly vertex is decided by its quarter-cell neighbours', () => {
    // Four-segment rings put a vertex at every quadrant, so the seam cell's ray (angle 0) runs
    // exactly along the shared edge of two faces on every ring: det ≈ 0 and coincident hits, where
    // a naive parity reads one crossing instead of two (or none). The quarter-cell offsets see
    // ordinary faces; both agree the design inside the rod is the groove.
    const low = (r: number): Tri[] => sideTris(() => r, 20, TAU, 4);
    const f = sampleGoalRadialField(goal([...low(5), ...low(11), ...low(13)], SPAN), R, { pitchMm: PITCH });
    const k = cell(f, 50, 0);
    expect(f.covered[k]).toBe(1);
    // The quarter-cell rays land on the 4-gon's flat, so they read the chord slightly inside the
    // ideal radius — the groove, not the rod surface (0) and not an uncovered cell.
    expect(f.z[k]!).toBeGreaterThan(5 - R - 0.1);
    expect(f.z[k]!).toBeLessThanOrEqual(5 - R + 1e-6);
    // And the offsets were actually taken: the centre ray's coincident shared-edge hits merged.
    expect(f.degenerateCells).toBeGreaterThan(0);
  });

  it('a face square to the axis is only parallel, not degenerate', () => {
    // An end cap normal to X lies parallel to EVERY radial ray. Flagging that as degenerate would
    // send every beyond-rod cell down the quarter-cell path (3x the work, a quarter-cell bias
    // everywhere). The ray must also lie IN the face's plane; at mid-span it does not.
    const fine = (r: number): Tri[] => sideTris(() => r, 20, TAU, 360);
    const cap = (r: number, x: number, seg = 32): Tri[] => {
      const tris: Tri[] = [];
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * TAU;
        const a1 = ((i + 1) / seg) * TAU;
        tris.push([
          [x, 0, 0],
          [x, r * Math.sin(a0), r * Math.cos(a0)],
          [x, r * Math.sin(a1), r * Math.cos(a1)],
        ]);
      }
      return tris;
    };
    // The seam is shifted half a cell so no sampled row sits exactly on a ring vertex; without
    // that every row-0 cell would merge its shared-edge hits and be degenerate for that reason.
    const placed = goal([...fine(5), ...fine(11), ...fine(13), ...cap(13, -10)], SPAN, {
      position: { x: 50, y: PITCH / 2, z: 0 },
    });
    const f = sampleGoalRadialField(placed, R, { pitchMm: PITCH });
    expect(f.recastCells).toBeGreaterThan(0);
    // ONLY the cap's own plane is degenerate — the one x column at x = −10, where the ray really
    // does lie in the cap. Every other beyond-rod cell classifies from its centre ray. Under the
    // wide flag this would be every recast cell (3x the work, a quarter-cell bias everywhere).
    expect(f.degenerateCells).toBe(f.ny);
    expect(f.degenerateCells).toBeLessThan(f.recastCells);
    expect(f.z[cell(f, 50, 0)]).toBeCloseTo(5 - R, 2);
    // The control without the cap: no cell is degenerate at all, so the one column above is the
    // cap's and not the seam-shift's.
    const plain = sampleGoalRadialField(goal([...fine(5), ...fine(11), ...fine(13)], SPAN, {
      position: { x: 50, y: PITCH / 2, z: 0 },
    }), R, { pitchMm: PITCH });
    expect(plain.degenerateCells).toBe(0);
  });

  it('a mesh whose material fills the rod samples R, not a surface below it', () => {
    // One crossing beyond R: the ray is inside the solid at R (a part through the rod), so the
    // goal is the rod itself — the clip the sampler already makes.
    const f = sampleGoalRadialField(goal(ring(12), SPAN), R, { pitchMm: PITCH });
    const k = cell(f, 50, 0);
    expect(f.covered[k]).toBe(1);
    expect(f.z[k]).toBeCloseTo(0, 6);
  });

  it('a sleeve with nothing inside the rod leaves the stock standing', () => {
    // Two crossings beyond R, none below: the design has no material inside the rod on this ray,
    // so the goal says nothing there — the cell is uncovered and the stock's surface stands.
    const f = sampleGoalRadialField(goal([...ring(11), ...ring(13)], SPAN), R, { pitchMm: PITCH });
    const k = cell(f, 50, 0);
    expect(f.covered[k]).toBe(0);
    expect(f.z[k]).toBe(0);
    expect(f.maxRadius).toBeGreaterThanOrEqual(13 - 0.01);
  });
});

afterEach(() => clearTargetObjectMeshCache());
