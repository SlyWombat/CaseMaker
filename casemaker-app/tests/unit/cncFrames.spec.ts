// The frames (#182, /Simulation.md §2): GOLDEN numbers, worked out by hand.
//
// Why this is its own spec and not a round trip. `sweep(ir) == sweep(parse(post(ir)))` cannot
// catch a frame error, because post and simulator share the transform and a wrong sign
// cancels on both sides. So the frame is tested against numbers derived on paper from the
// badge's dimensions, never against another call to the same function.
//
// And never with a symmetric part or a centred label. A centred badge is unchanged by exactly
// the mirrors and axis swaps most likely to be wrong (the same family as the KiCad Y-down
// board-layout bug), so every case below uses a label near one corner, at (10, 30) on a
// 76.2 x 38.1 badge: X and Y are different, so a swap or a flip changes the answer.
//
// Frames: model z = 0 is the BACK face, the engraved face is z = 3.81, front = -Y so the
// model's y = 0 edge is the front, and x = 0 is the left.

import { describe, it, expect } from 'vitest';
import {
  cosSinDeg,
  engravedFaceWorkZ,
  machinePosToWork,
  machineToPart,
  machineToWork,
  partToMachine,
  partToWork,
  workPosToMachine,
  workToMachine,
  workToPart,
} from '@/engine/cnc/frames';
import { stubSetup, type Setup } from '@/engine/cnc/setup';
import { roundedRect } from '@/engine/compiler/profile';
import type { Vec3 } from '@/types/units';

const T = 3.81;
const badge = { kind: 'prism' as const, outline: roundedRect(76.2, 38.1, 3.175), thickness: T };
const LABEL: Vec3 = [10, 30, T - 0.6]; // 10 mm from the left, 30 from the front, 0.6 deep

/**
 * A badge whose model origin sits at machine (ox, oy, oz), rotated, with the work origin on
 * its engraved FRONT-LEFT corner, exactly as Studio's `topFrontLeft` does.
 */
function mounted(rot: number, ox: number, oy: number, oz: number): Setup {
  const s = stubSetup(badge, { kind: 'vise', jawFaces: [{ origin: [0, 0, 0], normal: [1, 0, 0] }, { origin: [1, 0, 0], normal: [-1, 0, 0] }], jawHeight: 8 }, {
    placement: { origin: [ox, oy, oz], rotationZ: rot, source: 'stub' },
  });
  // The machine position of the model's top-front-left corner (0, 0, T) is the work origin.
  s.wcs = { ...s.wcs, origin: partToMachine(s, [0, 0, T]) };
  return s;
}

describe('cosSinDeg is exact at the quadrants (so golden numbers carry no 1e-16 noise)', () => {
  it.each([
    [0, [1, 0]], [90, [0, 1]], [180, [-1, 0]], [270, [0, -1]],
    [360, [1, 0]], [450, [0, 1]], [-90, [0, -1]], [-270, [0, 1]],
  ])('%d degrees', (deg, want) => {
    expect(cosSinDeg(deg as number)).toEqual(want);
  });
  it('is the ordinary cos/sin elsewhere', () => {
    const [c, s] = cosSinDeg(30);
    expect(c).toBeCloseTo(Math.sqrt(3) / 2, 12);
    expect(s).toBeCloseTo(0.5, 12);
  });
});

describe('GOLDEN: the badge label at model (10, 30), 0.6 mm below the engraved face', () => {
  it('no rotation: machine = model + origin; work = (10, 30, -0.6)', () => {
    const s = mounted(0, 50, 40, 10);
    // Machine: (50+10, 40+30, 10 + 3.21). By hand.
    const m = partToMachine(s, LABEL);
    expect(m[0]).toBeCloseTo(60, 12);
    expect(m[1]).toBeCloseTo(70, 12);
    expect(m[2]).toBeCloseTo(13.21, 12);
    // The work origin is the engraved front-left corner (50, 40, 13.81), so:
    const w = partToWork(s, LABEL);
    expect(w[0]).toBeCloseTo(10, 12);
    expect(w[1]).toBeCloseTo(30, 12);
    // A cut to depth d is at work Z = -d: the whole point of anchoring on the engraved face.
    expect(w[2]).toBeCloseTo(-0.6, 12);
  });

  it('rotated 90 degrees: (10, 30) -> (-30, 10) in work', () => {
    // Rz(90): (x, y) -> (-y, x). Origin (100, 20, 10): machine = (-30+100, 10+20) = (70, 30).
    const s = mounted(90, 100, 20, 10);
    const m = partToMachine(s, LABEL);
    expect(m[0]).toBeCloseTo(70, 12);
    expect(m[1]).toBeCloseTo(30, 12);
    // The corner (0,0,T) maps to the origin (100, 20), so work = machine - (100, 20, 13.81).
    const w = partToWork(s, LABEL);
    expect(w[0]).toBeCloseTo(-30, 12);
    expect(w[1]).toBeCloseTo(10, 12);
    expect(w[2]).toBeCloseTo(-0.6, 12);
  });

  it('rotated 180 degrees: (10, 30) -> (-10, -30)', () => {
    const w = partToWork(mounted(180, 100, 100, 5), LABEL);
    expect(w[0]).toBeCloseTo(-10, 12);
    expect(w[1]).toBeCloseTo(-30, 12);
  });

  it('rotated 270 degrees: (10, 30) -> (30, -10)', () => {
    const w = partToWork(mounted(270, 0, 0, 0), LABEL);
    expect(w[0]).toBeCloseTo(30, 12);
    expect(w[1]).toBeCloseTo(-10, 12);
  });

  it('rotated 30 degrees: a non-quadrant angle, by the rotation matrix', () => {
    // Rz(30) applied to (10, 0): (10 cos30, 10 sin30) = (8.660254, 5).
    const s = mounted(30, 0, 0, 0);
    const m = partToMachine(s, [10, 0, 0]);
    expect(m[0]).toBeCloseTo(8.660254037844386, 12);
    expect(m[1]).toBeCloseTo(5, 12);
  });

  it('REJECTS the errors a symmetric test would miss: swapped axes, a flipped axis, a wrong sign', () => {
    const w = partToWork(mounted(0, 50, 40, 10), LABEL);
    // If X and Y were swapped:
    expect([w[0], w[1]]).not.toEqual([30, 10]);
    // If Y were mirrored (Y-down, as the KiCad board was):
    expect(w[1]).not.toBeCloseTo(-30, 6);
    // If Z were measured from the BACK face instead of the engraved face:
    expect(w[2]).not.toBeCloseTo(T - 0.6, 6);
  });
});

describe('inverses', () => {
  const angles = [0, 90, 180, 270, 37.5, -12, 359];
  it.each(angles)('machine -> part -> machine at %d degrees', (rot) => {
    const s = mounted(rot, 12.3, -4.5, 7.7);
    for (const p of [LABEL, [0, 0, 0], [76.2, 38.1, T], [-5, 99, -1]] as Vec3[]) {
      const back = machineToPart(s, partToMachine(s, p));
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(p[i] as number, 9);
    }
  });
  it.each(angles)('work -> part -> work at %d degrees', (rot) => {
    const s = mounted(rot, 12.3, -4.5, 7.7);
    const back = partToWork(s, workToPart(s, [3, 4, -0.5]));
    expect(back[0]).toBeCloseTo(3, 9);
    expect(back[1]).toBeCloseTo(4, 9);
    expect(back[2]).toBeCloseTo(-0.5, 9);
  });
  it('work <-> machine is a pure translation by the WCS origin', () => {
    const s = stubSetup(badge, { kind: 'vise', jawFaces: [{ origin: [0, 0, 0], normal: [1, 0, 0] }, { origin: [1, 0, 0], normal: [-1, 0, 0] }], jawHeight: 8 }, {
      wcs: { origin: [-300, -210, -50], source: 'stub', uncertainty: 0.05 },
    });
    expect(workToMachine(s, [1, 2, 3])).toEqual([-299, -208, -47]);
    expect(machineToWork(s, [-299, -208, -47])).toEqual([1, 2, 3]);
  });
});

describe('partial positions: an unknown axis stays unknown', () => {
  const s = stubSetup(badge, { kind: 'vise', jawFaces: [{ origin: [0, 0, 0], normal: [1, 0, 0] }, { origin: [1, 0, 0], normal: [-1, 0, 0] }], jawHeight: 8 }, {
    wcs: { origin: [1, 2, 3], source: 'stub', uncertainty: 0.05 },
  });
  it('work -> machine carries nulls through, axis by axis', () => {
    expect(workPosToMachine(s, [null, 5, null])).toEqual([null, 7, null]);
    expect(workPosToMachine(s, [null, null, null])).toEqual([null, null, null]);
    expect(workPosToMachine(s, [10, 20, 30])).toEqual([11, 22, 33]);
  });
  it('machine -> work likewise', () => {
    expect(machinePosToWork(s, [11, null, 33])).toEqual([10, null, 30]);
  });
  it('NEVER invents a zero for a missing axis', () => {
    const r = workPosToMachine(s, [null, null, 5]);
    expect(r[0]).toBeNull();
    expect(r[1]).toBeNull();
  });
});

describe('the engraved face is the Z reference', () => {
  it('a part registered on its engraved face has that face at work Z = 0', () => {
    expect(engravedFaceWorkZ(stubSetup(badge, { kind: 'vise', jawFaces: [{ origin: [0, 0, 0], normal: [1, 0, 0] }, { origin: [1, 0, 0], normal: [-1, 0, 0] }], jawHeight: 8 }))).toBeCloseTo(0, 12);
    expect(engravedFaceWorkZ(mounted(33, 5, 6, 7))).toBeCloseTo(0, 12);
  });
  it('a misregistered Z shows up as a nonzero face height: the 1.5 mm lost to a wrong origin is visible', () => {
    const s = mounted(0, 0, 0, 0);
    s.wcs = { ...s.wcs, origin: [s.wcs.origin[0], s.wcs.origin[1], s.wcs.origin[2] - 1.5] };
    expect(engravedFaceWorkZ(s)).toBeCloseTo(1.5, 12);
  });
  it('thickness error on the BACK face cannot reach the cut depth (decision 24)', () => {
    // Two blanks with different measured thickness but the same engraved-face registration:
    // the work Z of "0.6 below the face" is identical. Thickness is not an input to depth.
    const thin = { ...badge, thickness: 3.7 };
    const thick = { ...badge, thickness: 3.9 };
    const make = (part: typeof badge): number => {
      const s = stubSetup(part, { kind: 'vise', jawFaces: [{ origin: [0, 0, 0], normal: [1, 0, 0] }, { origin: [1, 0, 0], normal: [-1, 0, 0] }], jawHeight: 8 }, {
        placement: { origin: [0, 0, 0], rotationZ: 0, source: 'stub' },
      });
      s.wcs = { ...s.wcs, origin: partToMachine(s, [0, 0, part.thickness]) }; // work origin ON the engraved face
      return partToWork(s, [10, 30, part.thickness - 0.6])[2] as number;
    };
    expect(make(thin)).toBeCloseTo(-0.6, 12);
    expect(make(thick)).toBeCloseTo(-0.6, 12);
  });
  it('is null for a part with no defined top face', () => {
    expect(engravedFaceWorkZ(stubSetup({ kind: 'cylinder', diameter: 30, length: 50 }, { kind: 'rotary-chuck', jawDiameter: 80, stickout: 10 }))).toBeNull();
  });
});
