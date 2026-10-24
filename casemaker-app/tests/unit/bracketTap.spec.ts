// #607 — the bracket reference tap (registration v2 step 2, row 2). The vise's landed in #599; the
// rotary's is a bench question of its own (the nose geometry decides whether a touch measures the
// axis at all), so this file pins the bracket only:
//
//   * the BRACKET's tap is its front arm's top face — free of the clamps (both sit on the back
//     edge) and in front of the stock, so no blank size moves it. The point is the AIM; the bench
//     records `bracket.armTopMm` (the arm's own top above the seat) at that point, having checked
//     the slots clear, because `bracket.heightMm` runs to the screw heads' tops instead;
//   * the reading measures the SEAT back: the top less the measured arm top;
//   * NO TAP is offered until both `bracket.seatMachineZ` and `bracket.armTopMm` exist — a tap
//     against the wrong surface would write a seat wrong by the difference;
//   * a plan CARRIES the tap it was given, with the reference and the expected top the executor
//     and the write-back read.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import {
  bracketArmTop,
  bracketSeat,
  bracketSeatFromTap,
  bracketSettings,
  bracketTapPoint,
  bracketTopMachineZ,
  clampObstacles,
  defaultClampPlacements,
} from '@/engine/cnc/mounts/bracket';
import { bracketTapFor } from '@/engine/cnc/registration/mountContext';
import { planRegistration, registrationSettings, runRegistration } from '@/engine/cnc/registration';
import type { ConsoleSendResult } from '@/platform/machineConsole';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS: ShopDefaults = ShopDefaultsSchema.parse(
  (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults,
);
const B = bracketSettings(DEFAULTS);
const { settings: S } = registrationSettings(DEFAULTS);

/** What the bench records: the seat beside the bracket, and the arm's own top above it. Neither is
 *  in the fixture (both keys are measured-only, with no seed). */
const MEASURED: ShopDefaults = {
  ...DEFAULTS,
  'bracket.seatMachineZ': {
    value: -57.4,
    source: 'measured',
    setAt: '2026-10-24T00:00:00.000Z',
    unit: 'mm',
    note: null,
  },
  'bracket.armTopMm': {
    value: 8.5,
    source: 'measured',
    setAt: '2026-10-24T00:00:00.000Z',
    unit: 'mm',
    note: 'front arm top, clear of the slots',
  },
};

/** The seat without the arm top — the state in which the tap must NOT be offered. */
const SEAT_ONLY: ShopDefaults = (() => {
  const { 'bracket.armTopMm': _omit, ...rest } = MEASURED;
  return rest;
})();

const CAL: MachineCalibration = {
  machineId: 'Z1',
  frame: { anchor1: [-190.89, -193.83], anchor2Offset: [88.5, 45], toolrackOffset: [48.8, 181], clearanceXY: [-5, -21], clearanceZ: -3, toolrackZ: -60 },
  softEndstop: {} as MachineCalibration['softEndstop'],
  source: 'config-get sd on 192.168.10.43',
  measuredAt: '2026-10-07T18:00:00.000Z',
};

/** The bracket datum the plan believes in: anchor 1 + the default offsets (0, 0). */
const CORNER = { x: CAL.frame.anchor1[0], y: CAL.frame.anchor1[1] };

const STOCK = { x: 100, y: 100, z: 5 };

describe('#607 the bracket tap point', () => {
  it('lands on the front arm’s top, in front of the stock and clear of both clamps', () => {
    const p = bracketTapPoint(CORNER, B.settings);
    // Work frame: the front arm is x ∈ [−armWidth, armLengthX], y ∈ [−armWidth, 0].
    const wx = p.x - CORNER.x;
    const wy = p.y - CORNER.y;
    expect(wx).toBeGreaterThan(0);
    expect(wx).toBeLessThan(B.settings.armLengthX);
    expect(wy).toBeGreaterThan(-B.settings.armWidth);
    expect(wy).toBeLessThan(0); // in FRONT of the stock's y = 0 edge — never under the blank
    for (const c of clampObstacles(STOCK, defaultClampPlacements(STOCK, B.settings), B.settings)) {
      const inside = wx >= c.min[0] && wx <= c.max[0] && wy >= c.min[1] && wy <= c.max[1];
      expect(inside, `${c.label} covers the tap`).toBe(false);
    }
  });

  it('is placed from the datum — its signature has no stock, so no blank size can move it', () => {
    const p = bracketTapPoint(CORNER, B.settings);
    const shifted = bracketTapPoint({ x: CORNER.x + 5, y: CORNER.y + 7 }, B.settings);
    expect(shifted.x - p.x).toBeCloseTo(5, 9);
    expect(shifted.y - p.y).toBeCloseTo(7, 9);
  });
});

describe('#607 the seat a tap on the bracket top measures back', () => {
  it('round-trips seat → expected top → seat, on the ARM TOP — not bracket.heightMm', () => {
    const seat = -57.4;
    const armTop = 8.5; // the measured face; `height` (10) runs to the screw heads' tops
    const top = bracketTopMachineZ(seat, armTop);
    expect(top).toBeCloseTo(seat + armTop, 9);
    expect(bracketSeatFromTap(top, armTop)).toBeCloseTo(seat, 9);
    // The two numbers are NOT interchangeable, which is why the default carries its own key.
    expect(bracketTopMachineZ(seat, B.settings.height)).not.toBeCloseTo(top, 1);
  });

  it('reads the seat and the arm top when the location has them, and nothing when it has none', () => {
    // Both keys are MEASURED-ONLY in the seed files — no shipped default carries them — so an
    // absent entry is the normal fresh state. `readMeasured` validates the VALUE's rule; a
    // hand-typed entry is still a value, and tightening that to `source === 'measured'` is a
    // defaults-layer question, not this slice's.
    expect(bracketSeat(DEFAULTS)).toBeNull();
    expect(bracketArmTop(DEFAULTS)).toBeNull();
    expect(bracketSeat(MEASURED)?.value).toBe(-57.4);
    expect(bracketArmTop(MEASURED)?.value).toBe(8.5);
  });
});

describe('#607 bracketTapFor', () => {
  it('aims at the plan’s corner with the arm-top expectation and the offset to subtract', () => {
    const tap = bracketTapFor({ calibration: CAL, machineId: 'Z1', seekFromMachineZ: -3, defaults: MEASURED });
    expect(tap).not.toBeNull();
    expect(tap!.x).toBeCloseTo(CORNER.x + B.settings.armLengthX / 2, 9);
    expect(tap!.y).toBeCloseTo(CORNER.y - B.settings.armWidth / 2, 9);
    expect(tap!.fromMachineZ).toBe(-3);
    expect(tap!.reference).toBe('bracket-seat');
    // The offset and the expectation come from the ARM TOP, never `bracket.heightMm`.
    expect(tap!.datumOffsetMm).toBe(8.5);
    expect(tap!.expectZ).toBeCloseTo(bracketTopMachineZ(-57.4, 8.5), 9);
    expect(tap!.label).toContain('bracket');
  });

  it('offers no point without this machine’s own anchor (a reader must not aim at a vendor frame)', () => {
    expect(bracketTapFor({ calibration: null, machineId: 'Z1', seekFromMachineZ: -3, defaults: MEASURED })).toBeNull();
    const other = { ...CAL, machineId: 'some-other-machine' };
    expect(bracketTapFor({ calibration: other, machineId: 'Z1', seekFromMachineZ: -3, defaults: MEASURED })).toBeNull();
  });

  it('offers NO tap until BOTH the seat and the arm top are measured — a slot could lie under the point', () => {
    // Nothing measured at all (a fresh machine, or the shipped fixture).
    expect(bracketTapFor({ calibration: CAL, machineId: 'Z1', seekFromMachineZ: -3, defaults: DEFAULTS })).toBeNull();
    // The seat without the arm top: aiming at a face whose height is unknown is how a seat gets
    // written wrong by the slot/head difference, so this is null, not a tap with a null expectation.
    expect(bracketTapFor({ calibration: CAL, machineId: 'Z1', seekFromMachineZ: -3, defaults: SEAT_ONLY })).toBeNull();
  });
});

describe('#607 a plan carries whichever tap it was given', () => {
  it('a bracket plan keeps the tap, its reference and its expected top', () => {
    const tap = bracketTapFor({ calibration: CAL, machineId: 'Z1', seekFromMachineZ: -3, defaults: MEASURED })!;
    const result = planRegistration(
      {
        stock: { xMin: 0, yMin: 0, xMax: STOCK.x, yMax: STOCK.y, cornerRadius: 3 },
        mount: 'bracket',
        expectedSurface: { machineZ: -57.4 + STOCK.z, from: 'the seat + the stock’s thickness' },
        seekFromMachineZ: -3,
        bracketOrigin: { x: CORNER.x, y: CORNER.y, from: 'anchor 1 + the default offsets', offsetMeasured: true },
        mountObstacles: [],
        mountTap: tap,
      },
      S,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.mountTap).toEqual(tap);
    expect(result.plan.mountTap?.reference).toBe('bracket-seat');
  });
});

describe('#599/#607 the vise tap runs the same code path it always did', () => {
  const JAW = { jawTopZ: -56.82, measuredAt: '2026-10-23T00:00:00.000Z', by: 'wired-probe' };

  /** Answers the questions before the tap and then MISSES it — no PRB line comes back. */
  function tapMissConsole(): { lines: string[]; send: (line: string) => Promise<ConsoleSendResult> } {
    const lines: string[] = [];
    const reply = (text: string): ConsoleSendResult => ({ kind: 'sent', line: '', text, frames: 1, elapsedMs: 1 });
    return {
      lines,
      async send(line: string) {
        lines.push(line);
        if (line === '?') return reply('<Idle|MPos:0,0,0>');
        if (line === 'M119') return reply('X_max:0 Y_max:0 Z_max:0 A_min:1 Probe: 0');
        if (line === 'M491') return reply('ok\n[PRB:-9.890,-12.830,-76.074:1]\nok');
        if (line.startsWith('G38.3')) return reply('ok'); // the touch finds nothing
        return reply('ok');
      },
    };
  }

  it('a PRE-#607 plan (no reference, no expectZ) keeps the bench-tested sentence and the jawTopZ − 2 floor', async () => {
    // The #599 fixture shape exactly: a datum and a tap point, and none of #607's fields.
    const tap = { x: -186.2, y: -180, fromMachineZ: -3, label: 'the vise fixed-jaw top' };
    const planned = planRegistration(
      {
        stock: { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 },
        mount: 'vise',
        expectedSurface: { machineZ: -56.172, from: 'the jaw top and the blank’s proud height' },
        seekFromMachineZ: -3,
        mountDatum: JAW,
        mountTap: tap,
      },
      S,
    );
    if (!planned.ok) throw new Error(planned.reason);

    const console = tapMissConsole();
    const r = await runRegistration(planned.plan, { console, operator: async () => true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The sentence the bench read on 2026-10-23, character for character.
      expect(r.reason).toContain('no jaw top at (-186.2, -180) down to machine Z -58.82');
      expect(r.reason).toContain('is the vise where the machine record says?');
    }
    // The tap's guarded move goes exactly 2 mm below the stored jaw top (−3 → −58.82).
    const searched = console.lines.filter((l) => l.startsWith('G38.3 Z-'));
    expect(searched).toHaveLength(1);
    expect(searched[0]!.startsWith('G38.3 Z-55.82 ')).toBe(true);
  });
});
