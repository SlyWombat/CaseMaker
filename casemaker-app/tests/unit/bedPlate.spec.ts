// #557 — the machine's bed plate in the WORK frame: the 200 × 200 envelope, placed so the vise —
// already drawn by `viseBody` at its work-frame position — sits on it at its real machine position
// (a measured placement's frame when the record has one, #779; the locating pins otherwise).
//
// The assertions are worked out by hand from the mapping in `bedPlate.ts`'s header:
//
//   machineX = workX + sacrificialShift.left + fixedJawFaceX
//   machineY = workY − vise.jawStartY + jawStartY
//
// With nothing measured the left pin (−195, −165) plus the drawn base's constants puts the fixed
// face at −180 and the bar's start at −165 (the bar's centre at −115). The shipped vise
// (jawStartY = −10) then maps the machine envelope X/Y in [−200, 0] to work X in [−20, 180] and
// work Y in [−45, 155]. The Z is the drawn base's bottom: `−stockProud − VISE_FLOOR_DEPTH −
// VISE_BASE_THICKNESS`.

import { describe, it, expect } from 'vitest';

import { Z1 } from '@/engine/cnc/machine';
import { DEFAULT_VISE, VISE_FLOOR_DEPTH } from '@/engine/cnc/fixture';
import { VISE_BASE_THICKNESS } from '@/engine/cnc/drawnVise';
import { BED_PLATE_THICKNESS } from '@/engine/cnc/bedScene';
import { noneSacrificial } from '@/engine/cnc/sacrificial';
import {
  machineBedPlate,
  VISE_FIXED_FACE_MACHINE_X,
  VISE_JAW_CENTER_MACHINE_Y,
} from '@/engine/cnc/bedPlate';
import type { Sacrificial } from '@/types/engraveJob';

describe('#557 machineBedPlate', () => {
  it('is the 200 × 200 envelope, placed from the left pin and the drawn base', () => {
    const box = machineBedPlate(DEFAULT_VISE, noneSacrificial(), Z1);

    expect(VISE_FIXED_FACE_MACHINE_X).toBe(-180);
    expect(VISE_JAW_CENTER_MACHINE_Y).toBe(-115);

    // The plate's X span is the envelope's, shifted so work X = 0 (the fixed face) lands at −180.
    expect(box.min[0]).toBe(-20);
    expect(box.max[0]).toBe(180);
    expect(box.max[0] - box.min[0]).toBe(200);

    // The plate's Y span is the envelope's, with the bar's start at machine −165 (work −10).
    expect(box.min[1]).toBe(-45);
    expect(box.max[1]).toBe(155);
    expect(box.max[1] - box.min[1]).toBe(200);

    // The drawn base's bottom, with the shipped placeholder proud value of 4 mm.
    expect(box.max[2]).toBe(-4 - VISE_FLOOR_DEPTH - VISE_BASE_THICKNESS);
    expect(box.min[2]).toBe(box.max[2] - BED_PLATE_THICKNESS);
  });

  it('uses a measured placement frame when the record has one (#779)', () => {
    const box = machineBedPlate(DEFAULT_VISE, noneSacrificial(), Z1, {
      fixedJawFaceX: -180.375,
      jawStartY: -202.75,
    });
    // Work X = 0 is the measured fixed face; the plate is placed from it, not from the pins.
    expect(box.min[0]).toBeCloseTo(-200 + 180.375, 9);
    expect(box.max[0]).toBeCloseTo(180.375, 9);
    // Work Y = 0 is the stock's front edge; the bar starts at work −10.
    expect(box.min[1]).toBeCloseTo(-200 + 202.75 - 10, 9);
    expect(box.max[1]).toBeCloseTo(202.75 - 10, 9);
  });

  it('shifts with a sacrificial side strip: the fixed face moves off the part\'s edge, so the plate follows', () => {
    const strip: Sacrificial = {
      ...noneSacrificial(),
      sides: { ...noneSacrificial().sides, left: { thickness: 5, height: 'flush' } },
    };
    const box = machineBedPlate(DEFAULT_VISE, strip, Z1);
    // `viseJawShift` puts the fixed jaw face at work X = −5; the plate must shift by the same 5 mm.
    expect(box.min[0]).toBe(-25);
    expect(box.max[0]).toBe(175);
    expect(box.max[0] - box.min[0]).toBe(200);
  });
});
