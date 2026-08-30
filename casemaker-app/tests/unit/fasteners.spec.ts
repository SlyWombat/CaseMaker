// Issue #140 — the shared fastener table and the one screw-hole mechanism.
//
// What these tests are actually guarding:
//   • the table agrees with the standards it cites, so a typo in a diameter is
//     caught here rather than in a printed part
//   • the numbers the rack already shipped are REPRODUCED, not redefined — the
//     migration has to be geometry-neutral, and that starts with 5.2/9.8/3.0
//     coming back out of the table unchanged
//   • the modelled thread is a right-hand thread, is one body, and actually
//     cuts a thread rather than a smooth bore
//   • pre-threading falls back where it cannot print, because a thread that
//     fails to print is a bore at the MAJOR diameter and holds nothing

import { describe, it, expect } from 'vitest';
import {
  FASTENERS,
  ASSUMED_NOZZLE,
  THREAD_FIT,
  clearanceDiameter,
  headDiameter,
  headHeight,
  headRecessDiameter,
  minEngagement,
  pilotDiameter,
  preThreadPrintable,
  resolveReceiver,
  screwHole,
  screwStarter,
  threadTool,
  type FastenerSize,
} from '@/engine/compiler/fasteners';
import { cube, difference, translate, type BuildOp } from '@/engine/compiler/buildPlan';
import type { Facing } from '@/types';
import { Manifold, exec, type ManifoldInstance } from './helpers/manifoldExec';

const SIZES: FastenerSize[] = ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6'];

/** Is the op's material present at this point? */
function solidAt(m: ManifoldInstance, p: [number, number, number], s = 0.12): boolean {
  const c = Manifold.cube([s, s, s], true).translate(p);
  const i = Manifold.intersection([m, c]);
  const v = i.volume();
  i.delete();
  c.delete();
  return v > (s * s * s) / 2;
}

/**
 * How much of the ring at (r, z) is material, 0..1.
 *
 * This is the measurement that tells a thread from a hole. A plain bore jumps
 * from 0 to 1 at one radius; a thread spends the whole minor-to-major band at
 * an intermediate fraction, because the female crest is there at some angles
 * and the groove at the others.
 */
function solidFraction(m: ManifoldInstance, r: number, z: number, steps = 72): number {
  let hits = 0;
  for (let i = 0; i < steps; i++) {
    const a = (2 * Math.PI * i) / steps;
    if (solidAt(m, [r * Math.cos(a), r * Math.sin(a), z], 0.08)) hits++;
  }
  return hits / steps;
}

/** Radius of the void in a block, measured outward from the axis at height z. */
function boreRadius(m: ManifoldInstance, z: number, from = 0.4, to = 8): number {
  for (let r = from; r < to; r += 0.02) {
    let allSolid = true;
    for (let deg = 0; deg < 360; deg += 15) {
      const a = (deg * Math.PI) / 180;
      if (!solidAt(m, [r * Math.cos(a), r * Math.sin(a), z], 0.08)) {
        allSolid = false;
        break;
      }
    }
    if (allSolid) return r;
  }
  return to;
}

describe('fastener table', () => {
  it('agrees with ISO 261 / ISO 68-1 on the minor diameter', () => {
    for (const s of SIZES) {
      const f = FASTENERS[s];
      // D1 = D - 1.0825 x P. A typo in any of the three shows up here.
      expect(f.minor, `${s} minor`).toBeCloseTo(f.major - 1.0825 * f.pitch, 2);
      expect(f.minor).toBeLessThan(f.major);
    }
  });

  it('lists ISO 273 clearances in order, all above the major diameter', () => {
    for (const s of SIZES) {
      const { clearance, major } = FASTENERS[s];
      expect(clearance.close, `${s} close`).toBeGreaterThan(major);
      expect(clearance.normal).toBeGreaterThan(clearance.close);
      expect(clearance.free).toBeGreaterThan(clearance.normal);
    }
  });

  it('carries every head style for every size, each wider than the shank', () => {
    for (const s of SIZES) {
      for (const style of ['socket-cap', 'button', 'countersunk', 'pan'] as const) {
        expect(FASTENERS[s].heads[style], `${s} ${style}`).toBeDefined();
        expect(headDiameter(s, style), `${s} ${style} dk`).toBeGreaterThan(FASTENERS[s].major);
        expect(headHeight(s, style), `${s} ${style} k`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the two pilot columns apart — they are for different screws', () => {
    for (const s of SIZES) {
      const machine = pilotDiameter(s, 'machine');
      const forming = pilotDiameter(s, 'thread-forming');
      // The whole point of the issue: ~0.8x major forms thread with a 30-degree
      // screw and splits the boss with a 60-degree one, so these must never
      // collapse into a single "pilot for M5 in PLA" number.
      expect(forming, `${s} forming vs machine`).toBeLessThan(machine);
      expect(forming).toBeCloseTo(0.8 * FASTENERS[s].major, 1);
      expect(machine).toBeLessThan(FASTENERS[s].major);
    }
  });

  it('marks M5 as the only coupon-tested pilot, at the printed 4.8', () => {
    expect(FASTENERS.M5.pilotMachine).toEqual({ d: 4.8, source: 'coupon' });
    for (const s of SIZES.filter((x) => x !== 'M5')) {
      expect(FASTENERS[s].pilotMachine.source, `${s} is extrapolated`).toBe('derived');
    }
  });

  it('reproduces the constants the rack already shipped', () => {
    // Geometry-neutral migration starts here. These three are what rack.ts
    // called SCREW_CLEAR_D / TAB_SCREW_CLEAR_D, TAB_SCREW_HEAD_D and
    // TAB_SCREW_HEAD_H, and the table has to hand them back unchanged.
    expect(clearanceDiameter('M5')).toBe(5.2);
    expect(headRecessDiameter('M5', 'button')).toBe(9.8);
    expect(headHeight('M5', 'button')).toBe(3.0);
    // ...from the MEASURED head, not the nominal one. 9.5 would give 10.1 and
    // eat the wall outboard of the bore.
    expect(headDiameter('M5', 'button')).toBe(9.2);
    expect(FASTENERS.M5.heads.button!.d).toBe(9.5);
  });

  it('quotes ISO clearance grades when asked for them by name', () => {
    expect(clearanceDiameter('M5', 'close')).toBe(5.3);
    expect(clearanceDiameter('M5', 'normal')).toBe(5.5);
    // The house fit is deliberately TIGHTER than ISO close, because these holes
    // locate as well as pass.
    expect(clearanceDiameter('M5', 'located')).toBeLessThan(clearanceDiameter('M5', 'close'));
  });

  it('recommends 2x major of engagement', () => {
    expect(minEngagement('M5')).toBe(10);
    expect(minEngagement('M3')).toBe(6);
  });
});

describe('pre-threading printability', () => {
  it('offers modelled threads only where the pitch clears two nozzle widths', () => {
    // Pitch, not diameter, is what governs: the female crest is a wedge about a
    // quarter-pitch wide, and below ~2 nozzle widths there is nothing to lay.
    expect(ASSUMED_NOZZLE).toBe(0.4);
    expect(preThreadPrintable('M5')).toBe(true);
    expect(preThreadPrintable('M6')).toBe(true);
    for (const s of ['M2', 'M2.5', 'M3', 'M4'] as FastenerSize[]) {
      expect(preThreadPrintable(s), `${s} must not pre-thread on a 0.4 nozzle`).toBe(false);
    }
    // A finer nozzle moves the line, which is the reason it is a parameter.
    expect(preThreadPrintable('M4', 0.25)).toBe(true);
  });

  it('falls back to self-tap rather than emitting a thread that cannot print', () => {
    expect(resolveReceiver('M5', 'pre-threaded')).toBe('pre-threaded');
    expect(resolveReceiver('M4', 'pre-threaded')).toBe('self-tap');
    expect(resolveReceiver('M5', 'self-tap')).toBe('self-tap');
  });
});

describe('threadTool', () => {
  it('is one body, at the major diameter, of the length asked for', () => {
    const m = exec(threadTool('M5', 8, { leadIn: false }));
    try {
      const parts = m.decompose();
      // A tooth that wraps onto itself splits the extrusion — a volume check
      // would never see it.
      expect(parts.length, 'thread tool is one body').toBe(1);
      parts.forEach((c) => c.delete());
      const bb = m.boundingBox();
      expect(Math.max(bb.max[0], bb.max[1]), 'outer radius').toBeCloseTo(2.5 + THREAD_FIT, 2);
      expect(bb.max[2] - bb.min[2], 'length').toBeCloseTo(8, 3);
      // Core plus ridge, so well under a solid cylinder of the same envelope.
      expect(m.volume()).toBeLessThan(Math.PI * (2.5 + THREAD_FIT) ** 2 * 8 * 0.9);
    } finally {
      m.delete();
    }
  });

  it('is a RIGHT-hand thread', () => {
    // The check that matters and the one nothing else catches: a left-hand
    // thread has the right volume, the right bounding box, one component, and
    // will not accept a screw.
    const m = exec(threadTool('M5', 4, { leadIn: false }));
    try {
      const angleOfTooth = (z: number): number => {
        let best = -1;
        let bestDeg = 0;
        for (let deg = 0; deg < 360; deg += 5) {
          const a = (deg * Math.PI) / 180;
          const c = Manifold.cube([0.3, 0.3, 0.06], true).translate([
            2.4 * Math.cos(a),
            2.4 * Math.sin(a),
            z,
          ]);
          const i = Manifold.intersection([m, c]);
          const v = i.volume();
          i.delete();
          c.delete();
          if (v > best) {
            best = v;
            bestDeg = deg;
          }
        }
        return bestDeg;
      };
      // A quarter of the 0.8 mm pitch. Right-hand means the tooth advances
      // COUNTER-clockwise (+90 degrees) as z rises.
      const a0 = angleOfTooth(0.05);
      const a1 = angleOfTooth(0.25);
      const advance = ((a1 - a0 + 540) % 360) - 180;
      expect(advance, `tooth advanced ${advance} deg over a quarter pitch`).toBeGreaterThan(45);
      expect(advance).toBeLessThan(135);
    } finally {
      m.delete();
    }
  });

  it('cuts a real thread into a block, not a smooth bore', () => {
    const block: BuildOp = cube([14, 14, 10], true);
    const m = exec(difference([block, translate([0, 0, -6], threadTool('M5', 12))]));
    try {
      expect(m.decompose().length).toBe(1);
      const rMaj = 2.5 + THREAD_FIT;
      const rMin = rMaj - 0.5413 * 0.8;
      // Fully open inside the minor, fully solid outside the major, and PART
      // solid in between — that band is the thread. A plain bore of any
      // diameter goes 0 -> 1 at a single radius and can never do this.
      expect(solidFraction(m, rMin - 0.12, 0), 'clear inside the minor').toBe(0);
      expect(solidFraction(m, rMaj + 0.12, 0), 'solid outside the major').toBe(1);
      const mid = solidFraction(m, (rMin + rMaj) / 2, 0);
      expect(mid, `thread band is part solid (got ${mid})`).toBeGreaterThan(0.2);
      expect(mid).toBeLessThan(0.8);
    } finally {
      m.delete();
    }
  });
});

describe('screwHole', () => {
  const BLOCK: BuildOp = translate([-10, -10, 0], cube([20, 20, 12]));

  it('cuts a plain clearance hole at the house fit', () => {
    const m = exec(difference([BLOCK, screwHole({ size: 'M5', at: [0, 0, 0], through: 12 })]));
    try {
      expect(boreRadius(m, 6, 1.5, 6)).toBeCloseTo(5.2 / 2, 1);
      expect(solidAt(m, [0, 0, 6])).toBe(false);
    } finally {
      m.delete();
    }
  });

  it('counterbores a button head flush, and leaves the shank hole below it', () => {
    const m = exec(
      difference([
        BLOCK,
        screwHole({ size: 'M5', at: [0, 0, 0], through: 12, head: 'button', recess: 'flush' }),
      ]),
    );
    try {
      // In the recess (0..3.0) the bore is the head recess; below it, the shank.
      expect(boreRadius(m, 1.5, 1.5, 8), 'head recess').toBeCloseTo(9.8 / 2, 1);
      expect(boreRadius(m, 6, 1.5, 8), 'shank below the recess').toBeCloseTo(5.2 / 2, 1);
      expect(solidAt(m, [4.5, 0, 1.5]), 'recess is open at r=4.5').toBe(false);
      expect(solidAt(m, [4.5, 0, 6]), 'shank is NOT open at r=4.5').toBe(true);
    } finally {
      m.delete();
    }
  });

  it('never lets a recess break out of the far face', () => {
    // 4 mm of material, a head that wants 3, and a 2 mm floor demanded: the
    // recess has to give, not the floor.
    const thin: BuildOp = translate([-10, -10, 0], cube([20, 20, 4]));
    const m = exec(
      difference([
        thin,
        screwHole({
          size: 'M5',
          at: [0, 0, 0],
          through: 4,
          head: 'button',
          recess: 'flush',
          material: 4,
          floor: 2,
        }),
      ]),
    );
    try {
      expect(solidAt(m, [4.5, 0, 1]), 'recess still cut').toBe(false);
      expect(solidAt(m, [4.5, 0, 3]), 'floor kept solid').toBe(true);
    } finally {
      m.delete();
    }
  });

  it('cuts a countersink as a 90-degree cone', () => {
    const m = exec(
      difference([
        BLOCK,
        screwHole({ size: 'M5', at: [0, 0, 0], through: 12, head: 'countersunk', recess: 'flush' }),
      ]),
    );
    try {
      // Mouth 10.6, shank 5.2, so the cone is 2.7 deep with a 1:1 flank. The
      // check that proves the ANGLE is that the radius loses exactly as many
      // millimetres as the depth gains.
      const rAt = (z: number) => boreRadius(m, z, 1.5, 8);
      const r05 = rAt(0.5);
      const r20 = rAt(2.0);
      expect(r05, 'radius 0.5 mm down').toBeCloseTo(10.6 / 2 - 0.5, 1);
      expect(r20, 'radius 2.0 mm down').toBeCloseTo(10.6 / 2 - 2.0, 1);
      expect(r05 - r20, '90-degree included angle: dr = dz').toBeCloseTo(1.5, 1);
      expect(rAt(4.0), 'plain shank below the cone').toBeCloseTo(5.2 / 2, 1);
    } finally {
      m.delete();
    }
  });

  it('honours an explicit diameter, for callers whose sizes are user data', () => {
    // stand.screwHoleDiameter and board.mountingHoles[].diameter are stored
    // state; the primitive must accept them rather than override them.
    const m = exec(
      difference([BLOCK, screwHole({ size: 'M3', at: [0, 0, 0], through: 12, clearanceD: 4.4 })]),
    );
    try {
      expect(boreRadius(m, 6, 1, 6)).toBeCloseTo(2.2, 1);
    } finally {
      m.delete();
    }
  });

  it('orients correctly on all six axes, head end first', () => {
    // Every branch of orient(), because a sign error is invisible until the
    // day someone migrates a module on the opposite face — and mountingFeatures
    // has already shipped a wrong rotation once (issue #45). The block is
    // centred on the origin, so for each axis the recess must land at the entry
    // face and the far end must have none.
    const blk: BuildOp = translate([-9, -9, -9], cube([18, 18, 18]));
    const AXES: [Facing, [number, number, number]][] = [
      ['+x', [1, 0, 0]],
      ['-x', [-1, 0, 0]],
      ['+y', [0, 1, 0]],
      ['-y', [0, -1, 0]],
      ['+z', [0, 0, 1]],
      ['-z', [0, 0, -1]],
    ];
    for (const [axis, d] of AXES) {
      // Entry face is the one the screw comes IN through, i.e. -d * 9.
      const at: [number, number, number] = [-d[0] * 9, -d[1] * 9, -d[2] * 9];
      const m = exec(
        difference([
          blk,
          screwHole({ size: 'M5', at, axis, through: 18, head: 'button', recess: 'flush' }),
        ]),
      );
      try {
        // A point 4.5 mm off the axis (inside the Ø9.8 recess, outside the
        // Ø5.2 shank), 1.5 mm in from each end.
        const off: [number, number, number] = d[0] !== 0 ? [0, 4.5, 0] : [4.5, 0, 0];
        const near: [number, number, number] = [
          at[0] + d[0] * 1.5 + off[0],
          at[1] + d[1] * 1.5 + off[1],
          at[2] + d[2] * 1.5 + off[2],
        ];
        const far: [number, number, number] = [
          -at[0] - d[0] * 1.5 + off[0],
          -at[1] - d[1] * 1.5 + off[1],
          -at[2] - d[2] * 1.5 + off[2],
        ];
        expect(solidAt(m, near), `${axis}: recess at the entry end`).toBe(false);
        expect(solidAt(m, far), `${axis}: no recess at the far end`).toBe(true);
        expect(solidAt(m, [0, 0, 0]), `${axis}: shank runs right through`).toBe(false);
      } finally {
        m.delete();
      }
    }
  });

  it('puts the hole on the axis it was given, head end first', () => {
    // The sign matters: axisCylinder ignores it, but a screw hole is
    // directional because the head is at one end.
    const bar: BuildOp = translate([-10, -6, -6], cube([20, 12, 12]));
    const m = exec(
      difference([
        bar,
        screwHole({
          size: 'M5',
          at: [-10, 0, 0],
          axis: '+x',
          through: 20,
          head: 'button',
          recess: 'flush',
        }),
      ]),
    );
    try {
      expect(solidAt(m, [-8.5, 4.5, 0]), 'recess at the entry end').toBe(false);
      expect(solidAt(m, [8.5, 4.5, 0]), 'no recess at the far end').toBe(true);
      expect(solidAt(m, [0, 0, 0]), 'shank runs right through').toBe(false);
    } finally {
      m.delete();
    }
  });
});

describe('screwStarter', () => {
  const BLOCK: BuildOp = translate([-10, -10, 0], cube([20, 20, 12]));

  it('cuts the machine-screw pilot by default', () => {
    const m = exec(difference([BLOCK, screwStarter({ size: 'M5', at: [0, 0, 0], depth: 10 })]));
    try {
      expect(boreRadius(m, 5, 1, 6)).toBeCloseTo(4.8 / 2, 1);
      expect(solidAt(m, [0, 0, 11.5]), 'blind — floor left below').toBe(true);
    } finally {
      m.delete();
    }
  });

  it('reads the thread-forming column when asked, which is a smaller hole', () => {
    const m = exec(
      difference([
        BLOCK,
        screwStarter({ size: 'M5', at: [0, 0, 0], depth: 10, profile: 'thread-forming' }),
      ]),
    );
    try {
      expect(boreRadius(m, 5, 1, 6)).toBeCloseTo(4.0 / 2, 1);
    } finally {
      m.delete();
    }
  });

  it('pre-threads an M5 and quietly self-taps an M4', () => {
    const threaded = exec(
      difference([
        BLOCK,
        screwStarter({ size: 'M5', at: [0, 0, 0], depth: 10, mode: 'pre-threaded' }),
      ]),
    );
    const fellBack = exec(
      difference([
        BLOCK,
        screwStarter({ size: 'M4', at: [0, 0, 0], depth: 10, mode: 'pre-threaded' }),
      ]),
    );
    try {
      // Threaded: part-solid through the minor-to-major band.
      const rMaj = 2.5 + THREAD_FIT;
      const rMin = rMaj - 0.5413 * 0.8;
      const band = solidFraction(threaded, (rMin + rMaj) / 2, 5);
      expect(band, `M5 bore is threaded (got ${band})`).toBeGreaterThan(0.2);
      expect(band).toBeLessThan(0.8);
      // Fell back: a plain 3.8 pilot, solid at every angle the moment it ends.
      expect(boreRadius(fellBack, 5, 1, 4), 'M4 fell back to a pilot').toBeCloseTo(3.8 / 2, 1);
      expect(solidFraction(fellBack, 1.9 + 0.12, 5), 'a pilot has no thread band').toBe(1);
      expect(threaded.decompose().length).toBe(1);
      expect(fellBack.decompose().length).toBe(1);
    } finally {
      threaded.delete();
      fellBack.delete();
    }
  });

  it('takes an explicit pilot for screws that are not in the table', () => {
    // The fan's own self-tappers: they ship with the fan and have no metric
    // size, so the rack has always just named the hole.
    const m = exec(
      difference([BLOCK, screwStarter({ size: 'M4', at: [0, 0, 0], depth: 10, pilotD: 3.6 })]),
    );
    try {
      expect(boreRadius(m, 5, 1, 4)).toBeCloseTo(1.8, 1);
    } finally {
      m.delete();
    }
  });
});
