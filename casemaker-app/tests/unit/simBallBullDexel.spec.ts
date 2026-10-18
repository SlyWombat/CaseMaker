/**
 * #532 (slice A) — a BALL nose and a BULL nose are admitted as dexel tool profiles and route to
 * the FLAT column engine instead of being refused in sim. Pure and isolated: no wasm, no timeline,
 * so the whole file runs in a few ms.
 *
 * The profile each leaves is checked against its ANALYTIC form, not the engine's own output:
 *   - a BALL of radius R is a hemisphere, so at radial distance ρ its floor is `tipZ + R − √(R²−ρ²)`
 *     — deepest under the axis (ρ=0) and rising to the equator at ρ=R. A plunge leaves a
 *     round-bottomed column floor.
 *   - a BULL of outer radius R with corner radius rc is flat out to `R − rc`, then a quarter-round
 *     of rc out to R, so a plunge leaves a flat floor with a FILLETED corner.
 * And a FLAT end mill and a V-bit are checked to read exactly as before — the new branch must not
 * disturb them.
 */
import { describe, expect, it } from 'vitest';
import { FLAT, columnCutterFor, cutterReach, surfaceAboveTip, type ColumnCutter, type ColumnGrid, type CutMove } from '@/workers/geometry/columnEngine';
import { sweepsOnColumn } from '@/workers/sim/session';
import { stubSetup, type Setup } from '@/engine/cnc/setup';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { rectProfile } from '@/engine/compiler/profile';

/** ⌀4 ball nose: `cuttingDiameter` 4 → ball radius 2. */
const BALL: Tool = { ...flatEndMill(4), name: '4 mm ball nose', typeText: 'Ball Nose', shape: 'ball', tipDiameter: 4, diameter: 4, cornerRadius: null };
/** ⌀6 bull nose, 1 mm corner: flat floor to radius 2, a quarter-round of 1 out to radius 3. */
const BULL: Tool = { ...flatEndMill(6), name: '6 mm bull nose r1', typeText: 'Bull Nose', shape: 'bull', tipDiameter: 6, diameter: 6, cornerRadius: 1 };
/** The catalogue's 90° chamfer as `catalogue.rs` maps it (a V-bit): tip 0.1, INCLUDED angle 90. */
const CHAMFER: Tool = { ...flatEndMill(3.175), name: '3.175mm*90º Chamfer', typeText: 'Chamfer', shape: 'chamfer', tipDiameter: 0.1, diameter: 3.175, angle: 90, halfAngle: null, cornerRadius: null };

function prism(w: number, d: number, t: number): Setup {
  return stubSetup({ kind: 'prism', outline: rectProfile(w, d), thickness: t }, { kind: 'tape-down', contact: rectProfile(w, d) });
}
const plunge = (x: number, y: number, z: number): CutMove => ({ step: 0, line: 1, u0: x, u1: x, v0: y, v1: y, z });
const floorAt = (grid: ColumnGrid, x: number, y: number): number => {
  const i = Math.round((x - grid.u0) / grid.du);
  const j = Math.round((y - grid.v0) / grid.dv);
  return grid.h[j * grid.nu + i] as number;
};

describe('#532 columnCutterFor admits ball / bull nose', () => {
  it('reads a ball as a hemisphere: flat part 0, corner = outer = tool radius', () => {
    const r = columnCutterFor(BALL);
    expect(r.ok && r.kind).toBe('ball');
    expect(r.ok && r.cutter).toEqual({ radius: 0, tanHalf: null, cornerRadius: 2, outerRadius: 2 });
  });

  it('reads a bull as a flat floor of (R − rc) with a quarter-round of rc out to R', () => {
    const r = columnCutterFor(BULL);
    expect(r.ok && r.kind).toBe('bull');
    expect(r.ok && r.cutter).toEqual({ radius: 2, tanHalf: null, cornerRadius: 1, outerRadius: 3 });
  });

  it('clamps a corner radius wider than the tool radius so the flat part cannot go negative', () => {
    const wide: Tool = { ...BULL, tipDiameter: 4, diameter: 4, cornerRadius: 5 }; // R = 2, rc 5 → ball
    const r = columnCutterFor(wide);
    expect(r.ok && r.cutter).toEqual({ radius: 0, tanHalf: null, cornerRadius: 2, outerRadius: 2 });
  });

  it('refuses a bull nose that states no corner radius (the rounded corner is the shape)', () => {
    const r = columnCutterFor({ ...BULL, cornerRadius: null });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/corner radius/);
  });

  it('refuses a ball / bull with no cutting diameter', () => {
    expect(columnCutterFor({ ...BALL, tipDiameter: null, diameter: null }).ok).toBe(false);
    expect(columnCutterFor({ ...BULL, tipDiameter: null, diameter: null }).ok).toBe(false);
  });
});

describe('#532 surfaceAboveTip / cutterReach — the profile math', () => {
  const ball = (columnCutterFor(BALL) as { cutter: ColumnCutter }).cutter; // R = 2
  const bull = (columnCutterFor(BULL) as { cutter: ColumnCutter }).cutter; // R = 3, rc = 1

  it('a ball rises as R − √(R²−ρ²): 0 at the axis, R at the equator, ∞ past it', () => {
    expect(surfaceAboveTip(ball, 0)).toBeCloseTo(0, 6);
    expect(surfaceAboveTip(ball, 1)).toBeCloseTo(2 - Math.sqrt(3), 6); // 0.2679
    expect(surfaceAboveTip(ball, 2)).toBeCloseTo(2, 6);
    expect(surfaceAboveTip(ball, 2.0001)).toBe(Infinity);
    // Monotone increasing with ρ — the floor is deepest under the axis.
    expect(surfaceAboveTip(ball, 1.5)).toBeGreaterThan(surfaceAboveTip(ball, 0.5));
  });

  it('a bull is flat to (R − rc), then a quarter-round of rc out to R, ∞ past it', () => {
    expect(surfaceAboveTip(bull, 0)).toBeCloseTo(0, 6);
    expect(surfaceAboveTip(bull, 2)).toBeCloseTo(0, 6); // still the flat floor
    expect(surfaceAboveTip(bull, 2.5)).toBeCloseTo(1 - Math.sqrt(1 - 0.25), 6); // 0.1340
    expect(surfaceAboveTip(bull, 3)).toBeCloseTo(1, 6); // meets the body
    expect(surfaceAboveTip(bull, 3.0001)).toBe(Infinity);
  });

  it('the XY reach is the cylindrical-body radius at every depth', () => {
    expect(cutterReach(ball, 0)).toBe(2);
    expect(cutterReach(ball, 10)).toBe(2);
    expect(cutterReach(bull, 0)).toBe(3);
    expect(cutterReach(bull, 10)).toBe(3);
  });
});

describe('#532 FLAT.applyMove leaves the right floor', () => {
  it('a ball plunge leaves a ROUND-BOTTOMED floor — deeper at the centre than at the edge', () => {
    const cutter = (columnCutterFor(BALL) as { cutter: ColumnCutter }).cutter; // R = 2
    const res = { dx: 0.1, dThetaDeg: 0.1 };
    const setup = prism(40, 40, 10);
    const m = plunge(20, 20, 0); // placeholder z; replaced once we know `initial`
    const grid = FLAT.buildGrid(setup, cutter, [plunge(20, 20, 0)], res);
    const tipZ = grid.initial - 3; // plunge 3 mm below the top face (> R, so the hemisphere is buried)
    FLAT.applyMove(grid, { ...m, z: tipZ }, cutter);

    const centre = floorAt(grid, 20, 20);
    const nearEdge = floorAt(grid, 21, 20); // ρ ≈ 1, mid-slope — a reliable magnitude
    const outer = floorAt(grid, 21.8, 20); // ρ ≈ 1.8, still safely inside the tool radius (2)
    const beyond = floorAt(grid, 22.5, 20); // ρ > R

    // Magnitudes: the tip is the deepest point, and the mid-slope rise is the hemisphere's. The
    // tolerances are a 0.1 mm grid's — the sampled column centre is up to half a cell off-axis.
    expect(centre).toBeCloseTo(tipZ, 2); // the tip is the deepest point
    expect(nearEdge).toBeCloseTo(tipZ + (2 - Math.sqrt(3)), 1); // 0.268 mm up at ρ = 1
    // Round-bottomed: the floor rises monotonically off-axis, and the whole footprint is cut.
    expect(nearEdge).toBeGreaterThan(centre);
    expect(outer).toBeGreaterThan(nearEdge);
    expect(outer).toBeLessThan(grid.initial); // still cut near the equator
    expect(beyond).toBeCloseTo(grid.initial, 6); // untouched past the tool radius
  });

  it('a bull plunge leaves a FLAT floor with a filleted corner', () => {
    const cutter = (columnCutterFor(BULL) as { cutter: ColumnCutter }).cutter; // R = 3, rc = 1
    const res = { dx: 0.1, dThetaDeg: 0.1 };
    const setup = prism(40, 40, 10);
    const grid = FLAT.buildGrid(setup, cutter, [plunge(20, 20, 0)], res);
    const tipZ = grid.initial - 2;
    FLAT.applyMove(grid, plunge(20, 20, tipZ), cutter);

    const centre = floorAt(grid, 20, 20);
    const flatEdge = floorAt(grid, 21.5, 20); // ρ ≈ 1.5, still within the flat part (R − rc = 2)
    const fillet = floorAt(grid, 22.5, 20); // ρ ≈ 2.5, mid-way up the quarter-round
    const body = floorAt(grid, 22.8, 20); // ρ ≈ 2.8, still safely inside the tool radius (3)
    const beyond = floorAt(grid, 23.5, 20); // ρ > R

    // The floor is genuinely FLAT across the centre — the flat part gives surfaceAboveTip 0 exactly,
    // so these are exactly the tip plane — then the corner rises as a quarter-round of rc = 1.
    expect(centre).toBeCloseTo(tipZ, 6);
    expect(flatEdge).toBeCloseTo(tipZ, 6);
    expect(fillet).toBeCloseTo(tipZ + (1 - Math.sqrt(0.75)), 1); // 0.134 mm up at ρ = 2.5
    expect(fillet).toBeGreaterThan(flatEdge); // the filleted corner is above the flat floor
    expect(body).toBeGreaterThan(fillet); // and keeps rising toward the body
    expect(body).toBeLessThan(grid.initial); // the corner is still cut
    expect(beyond).toBeCloseTo(grid.initial, 6); // untouched past the tool radius
  });
});

describe('#532 regression — a flat and a V read exactly as before', () => {
  it('a flat end mill is still a level floor (no corner radius, no cone)', () => {
    const r = columnCutterFor(flatEndMill(4));
    expect(r.ok && r.kind).toBe('flat');
    expect(r.ok && r.cutter).toEqual({ radius: 2, tanHalf: null });
    const flat = (r as { cutter: ColumnCutter }).cutter;
    expect(flat.cornerRadius).toBeUndefined();
    expect(surfaceAboveTip(flat, 1)).toBe(0); // level inside the radius
    expect(surfaceAboveTip(flat, 2.5)).toBe(Infinity); // nothing beyond it
    expect(cutterReach(flat, 5)).toBe(2);
  });

  it('a V-bit is still a rising cone, untouched by the rounded-tip branch', () => {
    const r = columnCutterFor(CHAMFER);
    expect(r.ok && r.kind).toBe('v');
    const v = (r as { cutter: ColumnCutter }).cutter;
    expect(v.tanHalf).not.toBeNull();
    expect(v.cornerRadius).toBeUndefined();
    // The cone rises linearly: (ρ − r_t)/tanHalf, so twice the radial distance is twice the rise.
    const r0 = v.radius;
    const rise1 = surfaceAboveTip(v, r0 + 0.5);
    const rise2 = surfaceAboveTip(v, r0 + 1.0);
    expect(rise2).toBeCloseTo(2 * rise1, 6);
    expect(cutterReach(v, 1)).toBeGreaterThan(v.radius); // the cone widens with depth
  });
});

describe('#532 sweepsOnColumn routes ball / bull to the column engine', () => {
  it('ball and bull now route on the column engine', () => {
    expect(sweepsOnColumn(BALL)).toBe(true);
    expect(sweepsOnColumn(BULL)).toBe(true);
  });
  it('the existing column shapes still route, and a flat end mill still does NOT', () => {
    expect(sweepsOnColumn(CHAMFER)).toBe(true);
    expect(sweepsOnColumn({ ...BALL, shape: 'drill' })).toBe(true);
    expect(sweepsOnColumn({ ...BALL, shape: 'thread' })).toBe(true);
    expect(sweepsOnColumn(flatEndMill(4))).toBe(false);
  });
});
