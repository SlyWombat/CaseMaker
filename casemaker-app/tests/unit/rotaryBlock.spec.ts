/**
 * #777 — A SQUARED BLOCK IN THE CHUCK IS A ROTARY JOB (design `rotary-flow.md` Q2, built here).
 *
 * The stock's section about the axis is its own shape, not a circle: a square/rectangular block
 * turns on the envelope that circumscribes it, and every stage reads the section where it used to
 * read one radius — the map's words, the column engine's starting radius and volume, and the
 * relief's roughing (no layer sweeps the envelope in air over a flat). A rod is the round section
 * it always was; a disc is never offered the chuck.
 */
import { describe, expect, it } from 'vitest';

import { ROTARY, type ColumnCutter, type CutMove } from '@/workers/geometry/columnEngine';
import { rotaryMapOf, sectionEnvelopeRadius, sectionRadiusAt, type RotarySection } from '@/engine/cnc/rotary/wrap';
import { rotaryReadout } from '@/components/viewport/rotaryMapView';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { defaultRotaryChuck } from '@/engine/cnc/engrave/setupFlow';
import { stubSetup, type Setup } from '@/engine/cnc/setup';
import { flatEndMill } from '@/engine/cnc/tool';
import { generateRotaryReliefIR, type GoalRadialField } from '@/engine/cnc/cam/rotaryRelief';
import type { EngraveJob } from '@/types/engraveJob';

const SQUARE: RotarySection = { kind: 'rect', width: 20, height: 20 };
const CUT: ColumnCutter = { radius: 1.5875, tanHalf: null };

function rotarySetup(section: RotarySection, length: number): Setup {
  const radius = sectionEnvelopeRadius(section);
  return stubSetup(
    { kind: 'cylinder', diameter: radius * 2, length, section },
    { kind: 'rotary-chuck', jawDiameter: radius * 2, stickout: length },
  );
}

function move(partial: Partial<CutMove>): CutMove {
  return { step: 0, line: 1, u0: 0, u1: 0, v0: 0, v1: 0, z: 5, ...partial };
}

/** A block in the chuck, in the AXIS frame the holding write produces. */
function blockJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.stock = { ...job.stock, length: 100, width: 30, thickness: 20 };
  job.stockEntry = { kind: 'made', shelfId: null, file: null, form: 'block', finish: 'unknown', conductive: false };
  job.workholding = { kind: 'rotary-chuck', rotary: defaultRotaryChuck(job) };
  return job;
}

describe('#777 the stock’s section', () => {
  it('a square is its half-side at a face and half its diagonal at a corner', () => {
    expect(sectionRadiusAt(SQUARE, 0)).toBeCloseTo(10, 9);
    expect(sectionRadiusAt(SQUARE, Math.PI / 2)).toBeCloseTo(10, 9);
    expect(sectionRadiusAt(SQUARE, Math.PI / 4)).toBeCloseTo(Math.hypot(10, 10), 9);
    expect(sectionEnvelopeRadius(SQUARE)).toBeCloseTo(Math.hypot(20, 20) / 2, 9);
  });

  it('a 20 × 30 rectangle reads Y and Z half-extents separately', () => {
    const rect: RotarySection = { kind: 'rect', width: 20, height: 30 };
    expect(sectionRadiusAt(rect, 0)).toBeCloseTo(15, 9); // +Z: the 30 side
    expect(sectionRadiusAt(rect, Math.PI / 2)).toBeCloseTo(10, 9); // +Y: the 20 side
    expect(sectionEnvelopeRadius(rect)).toBeCloseTo(Math.hypot(20, 30) / 2, 9);
  });
});

describe('#777 the map reads a block in the chuck', () => {
  it('names the section and the turned envelope, not a fake diameter', () => {
    const map = rotaryMapOf(blockJob());
    expect(map).not.toBeNull();
    expect(map!.section).toEqual({ kind: 'rect', width: 30, height: 20 });
    expect(map!.radius).toBeCloseTo(Math.hypot(30, 20) / 2, 9);
    expect(rotaryReadout(map!)).toContain('30 × 20 mm section');
    expect(rotaryReadout(map!)).toContain('turned envelope');
  });

  it('a rod stays round, a disc is never the chuck, a block outside it is a vise job', () => {
    const job = defaultEngraveJob();
    job.stock = { ...job.stock, length: 100, width: 20, thickness: 20, shape: 'cylinder', diameter: 20 };
    job.workholding = { kind: 'rotary-chuck', rotary: defaultRotaryChuck(job) };
    expect(rotaryMapOf(job)!.section).toEqual({ kind: 'round', diameter: 20 });

    const disc = defaultEngraveJob();
    disc.stock = { ...disc.stock, length: 40, width: 40, thickness: 3, shape: 'disc', diameter: 40 };
    disc.workholding = { kind: 'rotary-chuck', rotary: defaultRotaryChuck(disc) };
    expect(rotaryMapOf(disc)).toBeNull();

    // A block in the vise is a flat job whichever way the box faces.
    const flat: EngraveJob = { ...blockJob(), workholding: defaultEngraveJob().workholding };
    expect(rotaryMapOf(flat)).toBeNull();
  });
});

describe('#777 the column engine starts from the section', () => {
  it('a 30 × 20 bar’s stock volume is its section, and turning it to ⌀18 removes the closed form', () => {
    const setup = rotarySetup({ kind: 'rect', width: 30, height: 20 }, 100);
    // A raster of full A turns at stepped X and stepped RADII — the way a wrapped rough sweeps
    // around the stock, its tip's annulus walking down from the section to the ⌀18 finish radius.
    const grid = ROTARY.buildGrid(setup, CUT, [], { dx: 1, dThetaDeg: 1 });
    // The grid is padded by the cutter's own reach at each end, so the SHAPE is the check: the
    // stock's cross-section is the block's 30 × 20, not the ⌀36.06 envelope's πR².
    const before = ROTARY.volume(grid);
    expect(before.stock / (grid.du * grid.nu)).toBeCloseTo(30 * 20, 0);

    for (let r = 18; r > 9 - 1e-9; r -= 1.5) {
      for (let x = 0; x <= 100; x += 2) {
        ROTARY.applyMove(grid, move({ u0: x, u1: x, v0: 0, v1: 360, z: r }), CUT);
      }
    }
    const after = ROTARY.volume(grid);
    // The section becomes the ⌀18 disc: the removed share is near 1 − π·9² / (30·20) = 0.576,
    // not the envelope model's 1 − 81 / R² = 0.751. The band is the grid's padded ends and the
    // sampled corners, not the shape.
    const share = after.removed / before.stock;
    expect(share).toBeGreaterThan(0.54);
    expect(share).toBeLessThan(0.6);
  });
});

describe('#777 the Stock and Unroll views show the square', () => {
  it('the stock mesh turns on the section, and the unrolled map carries its profile', () => {
    const setup = rotarySetup({ kind: 'rect', width: 30, height: 20 }, 100);
    const grid = ROTARY.buildGrid(setup, CUT, [], { dx: 1, dThetaDeg: 1 });

    // Stock: at θ = 0 (under the tool) the radius is the 20 side's face, 10; at 90° it is the
    // 30 side's face, 15. The old envelope model drew ⌀36.06 everywhere.
    const stock = ROTARY.mesh(grid, { dx: 1, dThetaDeg: 1 });
    const atFace = (wantY: number, wantZ: number): boolean => {
      for (let v = 0; v < stock.vertexCount; v++) {
        const x = stock.positions[v * 3]!;
        if (Math.abs(x) > 50) continue;
        const y = stock.positions[v * 3 + 1]!;
        const z = stock.positions[v * 3 + 2]!;
        if (Math.abs(y - wantY) < 0.01 && Math.abs(z - wantZ) < 0.01) return true;
      }
      return false;
    };
    expect(atFace(0, 10)).toBe(true);
    expect(atFace(15, 0)).toBe(true);

    // Unroll: the uncut map's surface is the radius LOST below the envelope — the flat at θ=0
    // sits 8.03 mm down, the corner reaches 0.
    const map = ROTARY.meshMap!(grid, { dx: 1, dThetaDeg: 1 });
    const topCount = map.vertexCount / 2;
    let low = Infinity;
    let high = -Infinity;
    for (let v = 0; v < topCount; v++) {
      const z = map.positions[v * 3 + 2]!;
      if (z < low) low = z;
      if (z > high) high = z;
    }
    expect(low).toBeCloseTo(10 - Math.hypot(15, 10), 1);
    // The corner (atan(15/10) = 56.31°) falls between 1° samples, so the map's highest cell is
    // just under the envelope — still a square profile, not a flat cylinder at 0 everywhere.
    expect(high).toBeGreaterThan(-0.2);
    expect(high).toBeLessThan(0.001);
  });
});

describe('#777 the relief roughs from the section, not the envelope', () => {
  it('every roughing feed is below the stock’s own surface at its angle', () => {
    const radius = sectionEnvelopeRadius(SQUARE); // 14.142
    const nx = 9;
    const ny = 36;
    const pitch = (2 * Math.PI * radius) / ny;
    // A goal at radius 9 all over the map: below the faces (10) and the corners (14.142).
    const field: GoalRadialField = {
      nx,
      ny,
      x0: 0,
      y0: 0,
      pitch,
      radius,
      minRadius: 9,
      maxRadius: 9,
      z: new Float32Array(nx * ny).fill(9 - radius),
      covered: new Uint8Array(nx * ny).fill(1),
      coveredCount: nx * ny,
      resolutionNote: 'test',
    };
    const out = generateRotaryReliefIR({
      field,
      section: SQUARE,
      tool: flatEndMill(3.175, { shape: 'ball', name: '3.175 mm ball' }),
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      feeds: { feed: 500, plungeFeed: 200, stepDown: 1, roughStepOver: 1.2, finishStepOver: 0.3 },
      rapid: { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test' },
    });
    const feeds = out.roughing.moves.filter((m) => m.kind === 'feed');
    expect(feeds.length).toBeGreaterThan(0);
    let atFace = 0;
    for (const m of feeds) {
      const theta = ((m.a ?? 0) * Math.PI) / 180;
      const surface = sectionRadiusAt(SQUARE, theta);
      // The wrapped move's z is the RADIUS above the axis; below the surface is a real cut.
      expect(m.z).toBeLessThan(surface + 1e-6);
      if (Math.abs(Math.sin(theta)) < 0.1) atFace++;
    }
    // The flats ARE cut (the old envelope model swept them in air and cut nothing there).
    expect(atFace).toBeGreaterThan(0);
  });
});
