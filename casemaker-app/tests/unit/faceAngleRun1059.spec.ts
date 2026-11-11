/**
 * #1059 — `runFaceAngle` against a fake bench square. The fake's top face is a plane tilted by
 * the A it has been turned to: `Z(y) = faceTop + (y − axisY)·tan(T)`, and an `A` word changes T by
 * the same number, so turning A by −θ (θ = atan(ΔZ/2d)) levels it — the maintainer's correction
 * direction, which the bench confirms on the first run.
 *
 * The SAFETY pins are here: an A word is never sent below the ENVELOPE clearance, a tilt past the
 * shop's limit is refused with no A word at all, and an alarm stops the run with no A word.
 */
import { describe, expect, it } from 'vitest';
import type { ConsoleSendResult } from '@/platform/machineConsole';
import { PROBE_OPEN_REPLY, PROBE_TRIGGERED_REPLY, sentReply as reply } from './helpers/registrationFixtures';
import { runFaceAngle } from '@/engine/cnc/registration/execute';
import { planFaceAngle, type FaceAngleInputs } from '@/engine/cnc/registration/faceAngle';

const AXIS = { axisY: -125.06, axisZ: -37.71 };
const SQUARE = { kind: 'rect' as const, width: 44.5, height: 44.5 };

const inputs = (over: Partial<FaceAngleInputs> = {}): FaceAngleInputs => ({
  axis: AXIS,
  section: SQUARE,
  jawFaceX: -150,
  freeEndMm: 85,
  probeRadiusMm: 0.875,
  clearanceAboveStockMm: 5,
  machineClearanceZ: -3,
  parkAboveSurfaceMm: 3,
  bandAllowanceMm: 1,
  softLimits: { xMin: -207, yMin: -206, zMin: -102 },
  maxDeg: 10,
  ...over,
});

function plan(over: Partial<FaceAngleInputs> = {}) {
  const p = planFaceAngle(inputs(over));
  if (!p.ok) throw new Error(p.reason);
  return p;
}

/** A bench square whose top face is tilted by `tiltDeg`; `A` words change the tilt. */
function fakeStock(initialTiltDeg: number, opts: { alarmOn?: string } = {}) {
  let mode: 'G90' | 'G91' = 'G90';
  let tiltDeg = initialTiltDeg;
  const pos = { x: -1, y: -1, z: -3 };
  const lines: string[] = [];
  const aWords: { deg: number; lastZ: number }[] = [];
  let lastZCommanded = pos.z;
  const planNow = plan();
  const faceZAt = (y: number): number => planNow.faceTopZ + (y - AXIS.axisY) * Math.tan((tiltDeg * Math.PI) / 180);
  const console = {
    async send(line: string): Promise<ConsoleSendResult> {
      lines.push(line);
      if (opts.alarmOn !== undefined && line.startsWith(opts.alarmOn)) return reply('ALARM:Hard limit');
      if (line === '?') return reply('<Idle|MPos:0,0,0|WPos:0,0,0>');
      if (line === '$H') return (pos.x = -1), (pos.y = -1), (pos.z = -3), reply('ok');
      if (line === '$X' || line === 'ok') return reply('ok');
      if (line === 'M119') return reply(PROBE_OPEN_REPLY);
      if (line === 'M491') return reply(PROBE_TRIGGERED_REPLY);
      if (line === 'M831' || line === 'M832' || line === 'G10 L20 P0 A0') return reply('ok');
      if (line === 'G90' || line === 'G91') return (mode = line), reply('ok');
      let m = /^G53 G0 Z(-?[\d.]+)$/.exec(line);
      if (m) {
        pos.z = Number(m[1]);
        lastZCommanded = pos.z;
        return reply('ok');
      }
      m = /^G53 G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(line);
      if (m) return (pos.x = Number(m[1])), (pos.y = Number(m[2])), reply('ok');
      m = /^G0 A(-?[\d.]+)$/.exec(line);
      if (m) {
        if (mode !== 'G91') throw new Error('an A turn in absolute mode');
        const deg = Number(m[1]);
        aWords.push({ deg, lastZ: lastZCommanded });
        tiltDeg += deg;
        return reply('ok');
      }
      m = /^G38\.3 Z-([\d.]+) F[\d.]+$/.exec(line);
      if (m) {
        if (mode !== 'G91') throw new Error('a probe in absolute mode');
        const target = pos.z - Number(m[1]);
        const face = faceZAt(pos.y);
        if (face <= pos.z && face >= target) {
          pos.z = face;
          return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${face.toFixed(3)}:1]\nok`);
        }
        pos.z = target;
        return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${target.toFixed(3)}:0]\nok`);
      }
      m = /^G38\.5 Z(-?[\d.]+)$/.exec(line);
      if (m) {
        if (mode !== 'G91') throw new Error('a release in absolute mode');
        pos.z += Number(m[1]);
        return reply('ok');
      }
      return reply('ok');
    },
  };
  return { console, lines, aWords };
}

const yes = async () => true;

describe('#1059 runFaceAngle on a bench square', () => {
  it('a level stock takes ONE pair, writes the A zero, and never turns', async () => {
    const fake = fakeStock(0);
    const r = await runFaceAngle({ plan: plan(), touchFeed: 60 }, { liveClearanceZ: -3, console: fake.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    expect(r.readings).toHaveLength(1);
    expect(r.residualMm).toBeCloseTo(0, 6);
    expect(r.thetaDeg).toBe(0);
    expect(fake.aWords).toHaveLength(0);
    // The session brackets the probe: supply on before the first touch, off at the end; the write
    // is the last thing that happens.
    expect(fake.lines.indexOf('M831')).toBeLessThan(fake.lines.findIndex((l) => l.startsWith('G38.3')));
    expect(fake.lines.at(-2)).toBe('G10 L20 P0 A0');
    expect(fake.lines.at(-1)).toBe('M832');
  });

  it('a tilted stock turns A by −θ FROM THE ENVELOPE CLEARANCE, then reads level', async () => {
    const fake = fakeStock(2);
    const r = await runFaceAngle({ plan: plan(), touchFeed: 60 }, { liveClearanceZ: -3, console: fake.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    expect(r.readings).toHaveLength(2);
    expect(r.readings[0]!.thetaDeg).toBeCloseTo(2, 2);
    expect(r.thetaDeg).toBeCloseTo(-2, 2);
    expect(r.residualMm).toBeCloseTo(0, 6);
    expect(fake.aWords).toHaveLength(1);
    expect(fake.aWords[0]!.deg).toBeCloseTo(-2, 2);
    // SAFETY 1 — the A word's last commanded Z is the ENVELOPE clearance, not the park.
    const planNow = plan();
    expect(fake.aWords[0]!.lastZ).toBeGreaterThanOrEqual(planNow.turnClearanceZ - 1e-9);
    expect(fake.aWords[0]!.lastZ).toBeGreaterThan(planNow.parkZ);
  });

  it('SAFETY 2 — a tilt past the limit is refused and NOTHING turns', async () => {
    // A band wide enough for both touches to land, so the reading is the thing under test — a
    // 12° tilt on this face would miss the narrow band first, and that refusal is tested below.
    const fake = fakeStock(12);
    const r = await runFaceAngle({ plan: plan({ parkAboveSurfaceMm: 8, bandAllowanceMm: 6 }), touchFeed: 60 }, { liveClearanceZ: -3, console: fake.console, operator: yes });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('wrong touch or a wrong mounting, not a turn');
    expect(fake.aWords).toHaveLength(0);
    expect(fake.lines.at(-1)).toBe('M832');
  });

  it('a miss is a reading, not an alarm — and it stops the step by name', async () => {
    // The plan expects the face 30 mm HIGHER than the stock really is: the capped descent finds
    // nothing, which is a reading (`:0`), not an alarm, and the step stops in words.
    const fake = fakeStock(0);
    const high = plan();
    const raised = { ...high, faceTopZ: high.faceTopZ + 30, bandFloorZ: high.bandFloorZ + 30, parkZ: high.parkZ + 30 };
    const r = await runFaceAngle({ plan: raised, touchFeed: 60 }, { liveClearanceZ: -3, console: fake.console, operator: yes });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('found no face');
    expect(fake.aWords).toHaveLength(0);
    expect(fake.lines.at(-1)).toBe('M832');
  });

  it('an alarm stops the run with no A word and the supply off', async () => {
    const fake = fakeStock(2, { alarmOn: 'G53 G0 X' });
    const r = await runFaceAngle({ plan: plan(), touchFeed: 60 }, { liveClearanceZ: -3, console: fake.console, operator: yes });
    expect(r.ok).toBe(false);
    expect(fake.aWords).toHaveLength(0);
    expect(fake.lines.at(-1)).toBe('M832');
  });

  // ── #1211 — THE ROTARY REGION AND THE CHUCK KEEP-OUT ON TRAVEL ─────────────────────────────
  it('#1211 — a touch X inside the chuck keep-out is refused at the TRAVERSE and nothing descends', async () => {
    const fake = fakeStock(0);
    const p = plan();
    // A doctored plan: X inside the jaws' keep-out (jaw face + anything under the band). The
    // traverse to it happens at the clearance, so #1199 alone would wave it through.
    const inside = { ...p, x: inputs().jawFaceX + 1 };
    const r = await runFaceAngle({ plan: inside, touchFeed: 60 }, { liveClearanceZ: -3, console: fake.console, operator: yes });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('keep-out');
    expect(fake.lines.some((l) => l.startsWith('G38.3'))).toBe(false);
  });

  it('#1211 — a touch beside the stock’s envelope is refused at the DESCENT, not probed', async () => {
    const fake = fakeStock(0);
    const p = plan();
    // The traverse to the point is legal (it is at the clearance); the descent below the
    // clearance there is not — the point is outside the rod's projection.
    const beside = {
      ...p,
      yPlus: AXIS.axisY + p.envelopeRadiusMm + 5,
      yMinus: AXIS.axisY - p.envelopeRadiusMm - 5,
    };
    const r = await runFaceAngle({ plan: beside, touchFeed: 60 }, { liveClearanceZ: -3, console: fake.console, operator: yes });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('footprint');
    expect(fake.lines.some((l) => l.startsWith('G38.3 Z'))).toBe(false);
  });
});
