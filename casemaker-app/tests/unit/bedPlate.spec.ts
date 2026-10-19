// #557 — the machine's bed plate in the WORK frame: the 200 × 200 envelope, placed so the vise —
// already drawn by `viseBody` at its work-frame position — sits on it at its real machine position
// (the locating pins, `bedScene.ts`'s `PIN_PAIR`).
//
// The assertions are golden numbers worked out by hand from the mapping in `bedPlate.ts`'s header:
//
//   machineX = workX + sacrificialShift.left + pinX        (pinX = −100)
//   machineY = workY − (jawStartY + jawLength / 2) + pinYMid (pinYMid = −100)
//
// With the shipped vise (jawStartY = −10, jawLength = 100 → jaw centre work Y = 40) the machine
// envelope X/Y in [−200, 0] becomes work X in [−100, 100] and work Y in [−60, 140]. The Z is the
// vise's own base level, one `VISE_BED_THICKNESS` below its rails.

import { describe, it, expect } from 'vitest';

import { Z1 } from '@/engine/cnc/machine';
import {
  DEFAULT_VISE,
  VISE_BAR_HEIGHT,
  VISE_BODY_DEPTH,
  VISE_BED_THICKNESS,
} from '@/engine/cnc/fixture';
import { BED_PLATE_THICKNESS } from '@/engine/cnc/bedScene';
import { noneSacrificial } from '@/engine/cnc/sacrificial';
import {
  machineBedPlate,
  VISE_FIXED_FACE_MACHINE_X,
  VISE_JAW_CENTER_MACHINE_Y,
} from '@/engine/cnc/bedPlate';
import type { Sacrificial } from '@/types/engraveJob';

describe('#557 machineBedPlate', () => {
  it('is the 200 × 200 envelope, with the fixed jaw face on the pins\' X and the jaw centred', () => {
    const box = machineBedPlate(DEFAULT_VISE, noneSacrificial(), Z1);

    expect(VISE_FIXED_FACE_MACHINE_X).toBe(-100);
    expect(VISE_JAW_CENTER_MACHINE_Y).toBe(-100);

    // The plate's X span is the envelope's, shifted so work X = 0 (the fixed face) lands at −100.
    expect(box.min[0]).toBe(-100);
    expect(box.max[0]).toBe(100);
    expect(box.max[0] - box.min[0]).toBe(200);

    // The plate's Y span is the envelope's, centred on the jaw centre (work Y = 40).
    expect(box.min[1]).toBe(-60);
    expect(box.max[1]).toBe(140);
    expect(box.max[1] - box.min[1]).toBe(200);

    // The vise's base: `−stockProud − VISE_BAR_HEIGHT − VISE_BODY_DEPTH − VISE_BED_THICKNESS`,
    // with the shipped placeholder proud value of 4 mm.
    expect(box.max[2]).toBe(-4 - VISE_BAR_HEIGHT - VISE_BODY_DEPTH - VISE_BED_THICKNESS);
    expect(box.min[2]).toBe(box.max[2] - BED_PLATE_THICKNESS);
  });

  it('shifts with a sacrificial side strip: the fixed face moves off the part\'s edge, so the plate follows', () => {
    const strip: Sacrificial = {
      ...noneSacrificial(),
      sides: { ...noneSacrificial().sides, left: { thickness: 5, height: 'flush' } },
    };
    const box = machineBedPlate(DEFAULT_VISE, strip, Z1);
    // `viseJawShift` puts the fixed jaw face at work X = −5; the plate must shift by the same 5 mm.
    expect(box.min[0]).toBe(-105);
    expect(box.max[0]).toBe(95);
    expect(box.max[0] - box.min[0]).toBe(200);
  });
});
