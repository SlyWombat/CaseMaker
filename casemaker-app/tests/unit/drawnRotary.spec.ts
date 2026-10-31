// #782 — the drawn Z1 4th-axis module as ONE model: the T-slot extrusion base on both pins, the
// L-shaped headstock with its motor out front, the four-jaw self-centring chuck facing +X, and
// the tailstock on its rail with the dead-centre cone and its knob. The bed scene and the Holding
// step's front view read these parts, so this pins the model itself.

import { describe, expect, it } from 'vitest';
import {
  ROTARY_BASE_LEFT,
  ROTARY_BASE_RIGHT,
  ROTARY_CHUCK_FACE_FROM_LEFT_PIN_X,
  ROTARY_MOTOR_HALF_Y,
  ROTARY_TAILSTOCK_LENGTH,
  drawnRotary,
  rotaryPlacement,
  type DrawnRotaryPart,
} from '@/engine/cnc/drawnRotary';

const find = (parts: DrawnRotaryPart[], id: string): DrawnRotaryPart => parts.find((p) => p.id === id)!;

describe('#782 the drawn 4th-axis module', () => {
  it('puts the chuck face on X = 0 and draws a four-jaw self-centring chuck there', () => {
    const parts = drawnRotary({ stockDiameterMm: 20, stickoutMm: 85 });
    const chuck = find(parts, 'rotary-chuck');
    expect(chuck.min[0]).toBe(0);
    // A square, centred on the axis: the drawn stand-in for the round body.
    expect(chuck.max[1] - chuck.min[1]).toBe(chuck.max[2] - chuck.min[2]);
    expect(chuck.max[2] - chuck.min[2]).toBe(80);

    // FOUR jaws, one per cardinal side, each gripping ON the stock's radius (self-centring):
    // one bound of each jaw is exactly +r or −r, and the other axis straddles the centre.
    const jaws = parts.filter((p) => p.role === 'jaw');
    expect(jaws).toHaveLength(4);
    const r = 10;
    expect(find(parts, 'rotary-jaw-1').min[1]).toBe(r);
    expect(find(parts, 'rotary-jaw-2').max[1]).toBe(-r);
    expect(find(parts, 'rotary-jaw-3').min[2]).toBe(r);
    expect(find(parts, 'rotary-jaw-4').max[2]).toBe(-r);
    for (const jaw of jaws) {
      expect(jaw.max[0]).toBeGreaterThan(jaw.min[0]); // protrudes along X
      expect(jaw.max[2] - jaw.min[2]).toBeGreaterThan(0);
      expect(jaw.max[1] - jaw.min[1]).toBeGreaterThan(0);
    }
  });

  it('draws reverse jaws deeper outward than standard jaws, on the same grip diameter', () => {
    const standard = drawnRotary({ stockDiameterMm: 20, jawMode: 'standard' });
    const reverse = drawnRotary({ stockDiameterMm: 20, jawMode: 'reverse-outer' });
    const topStandard = find(standard, 'rotary-jaw-3').max[2];
    const topReverse = find(reverse, 'rotary-jaw-3').max[2];
    expect(topReverse).toBeGreaterThan(topStandard);
    // Both grip the same radius: the inner face does not move.
    expect(find(standard, 'rotary-jaw-3').min[2]).toBe(find(reverse, 'rotary-jaw-3').min[2]);
  });

  it('faces the headstock left with its motor out FRONT (−Y), beyond the base', () => {
    const parts = drawnRotary({});
    const headstock = find(parts, 'rotary-headstock');
    const motor = find(parts, 'rotary-motor');
    // The headstock is behind the chuck face, on the base's left end.
    expect(headstock.max[0]).toBeLessThan(0);
    expect(headstock.min[0]).toBe(-ROTARY_BASE_LEFT);
    // The motor hangs forward: its whole Y range is on the operator's side of the headstock.
    expect(motor.max[1]).toBe(-ROTARY_MOTOR_HALF_Y);
    expect(motor.max[1]).toBeLessThanOrEqual(headstock.min[1] + 1e-9);
    // …and it runs along X under the headstock.
    expect(motor.min[0]).toBe(headstock.min[0]);
  });

  it('spans both locating pins with the base, its T-slots running along X', () => {
    const parts = drawnRotary({});
    const base = find(parts, 'rotary-base');
    expect(base.min[0]).toBe(-ROTARY_BASE_LEFT);
    expect(base.max[0]).toBe(ROTARY_BASE_RIGHT);
    // The base is wide enough to cover the diagonal pins' Y offset (60 mm between the wires).
    expect(base.max[1] - base.min[1]).toBeGreaterThanOrEqual(60);
    const slots = parts.filter((p) => p.role === 'slot');
    expect(slots).toHaveLength(2);
    for (const slot of slots) {
      expect(slot.max[0] - slot.min[0]).toBeGreaterThan(150);
      expect(slot.max[1] - slot.min[1]).toBeLessThan(slot.max[0] - slot.min[0]!);
    }
  });

  it('meets the stock\'s free end with the tailstock cone when it is in', () => {
    const parts = drawnRotary({ stockDiameterMm: 20, stickoutMm: 85, tailstock: true });
    const cone = find(parts, 'rotary-tailstock-cone');
    // The cone's tip sits ON the stock's end; the body and knob run to the right of it.
    expect(cone.max[0]).toBe(85);
    expect(cone.min[0]).toBeLessThan(cone.max[0]);
    const body = find(parts, 'rotary-tailstock');
    expect(body.min[0]).toBe(85);
    const knob = find(parts, 'rotary-tailstock-knob');
    expect(knob.min[0]).toBe(85 + ROTARY_TAILSTOCK_LENGTH);
  });

  it('parks the tailstock at the rail\'s right end when it is out', () => {
    const parts = drawnRotary({ stockDiameterMm: 20, stickoutMm: 85, tailstock: false });
    const body = find(parts, 'rotary-tailstock');
    expect(body.max[0]).toBe(ROTARY_BASE_RIGHT);
    expect(find(parts, 'rotary-tailstock-cone').max[0]).toBe(ROTARY_BASE_RIGHT - ROTARY_TAILSTOCK_LENGTH);
  });

  it('places the axis line at the profile\'s measured height and the module at its datum XY', () => {
    // A measured axis: its machine Z is the reading, and a recorded XY is the module's place.
    const placement = rotaryPlacement({
      datum: { value: -40, at: [-155, -135] },
      pins: [
        [-195, -165],
        [-10, -105],
      ],
      surfaceTopZ: -80,
    });
    expect(placement.axisZ).toBe(-40);
    expect(placement.chuckFaceX).toBe(-155);
    expect(placement.axisY).toBe(-135);

    // Nothing measured: the left pin plus the base's own offset, the pins' Y midpoint, and the
    // provisionally-high axis.
    const provisional = rotaryPlacement({
      datum: null,
      pins: [
        [-195, -165],
        [-10, -105],
      ],
      surfaceTopZ: -80,
    });
    expect(provisional.chuckFaceX).toBe(-195 + ROTARY_CHUCK_FACE_FROM_LEFT_PIN_X);
    expect(provisional.axisY).toBe(-135);
    expect(provisional.axisZ).toBe(-80 + 40);
  });
});
