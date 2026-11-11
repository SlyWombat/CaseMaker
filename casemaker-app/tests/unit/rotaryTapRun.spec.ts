// #607 — the rotary reference tap against a fake bench chuck. The fake models the app's own
// sideways-boss convention: at a chord's height the ball's centre triggers one probe radius
// outside the face (the same rule #827's centre find uses), and the crown is the cylinder's top
// above the axis. Machine coordinates throughout — the tap runs beside the chuck, in G53.

import { describe, expect, it } from 'vitest';
import type { ConsoleSendResult } from '@/platform/machineConsole';
import { PROBE_OPEN_REPLY, PROBE_TRIGGERED_REPLY, sentReply as reply } from './helpers/registrationFixtures';
import { runRotaryTap, type RotaryTapOptions } from '@/engine/cnc/registration/execute';
import { planRotaryTrial } from '@/engine/cnc/registration/rotaryTap';

const AXIS = { y: -180, z: -50 };
const NOMINAL_R = 40;
const PROBE_R = 0.875;
const BED_CLEARANCE_Z = -56;

function fakeChuck(radius = NOMINAL_R) {
  let mode: 'G90' | 'G91' = 'G90';
  const pos = { x: -1, y: -1, z: -3 };
  const lines: string[] = [];
  /** The crown's machine Z above the axis at this Y, or null beside the body. */
  const crownAt = (y: number): number | null => {
    const dy = y - AXIS.y;
    if (Math.abs(dy) >= radius) return null;
    return AXIS.z + Math.sqrt(radius * radius - dy * dy);
  };
  const console = {
    async send(line: string): Promise<ConsoleSendResult> {
      lines.push(line);
      if (line === '?') return reply('<Idle|MPos:0,0,0|WPos:0,0,0>');
      if (line === '$H') return (pos.x = -1), (pos.y = -1), (pos.z = -3), reply('ok');
      if (line === 'M119') return reply(PROBE_OPEN_REPLY);
      if (line === 'M491') return reply(PROBE_TRIGGERED_REPLY);
      if (line === 'M831' || line === 'M832') return reply('ok');
      if (line === 'G90' || line === 'G91') return (mode = line), reply('ok');
      let m = /^G53 G0 Z(-?[\d.]+)$/.exec(line);
      if (m) return (pos.z = Number(m[1])), reply('ok');
      m = /^G53 G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(line);
      if (m) return (pos.x = Number(m[1])), (pos.y = Number(m[2])), reply('ok');
      m = /^G38\.3 Z-([\d.]+) F[\d.]+$/.exec(line);
      if (m) {
        if (mode !== 'G91') throw new Error('a probe in absolute mode');
        const target = pos.z - Number(m[1]);
        const crown = crownAt(pos.y);
        if (crown !== null && crown >= target && crown <= pos.z) {
          pos.z = crown;
          return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${crown.toFixed(3)}:1]\nok`);
        }
        pos.z = target;
        return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${target.toFixed(3)}:0]\nok`);
      }
      m = /^G38\.3 Y(-?[\d.]+) F[\d.]+$/.exec(line);
      if (m) {
        if (mode !== 'G91') throw new Error('a sideways probe in absolute mode');
        const travel = Number(m[1]);
        // The app's sideways-boss convention: at any chord height the ball's centre triggers one
        // probe radius outside the face (the drill/edge rule every sideways touch uses).
        const dz = pos.z - AXIS.z;
        let hit: number | undefined;
        if (Math.abs(dz) <= radius) {
          // The face width at this height, plus one probe radius for the ball's centre.
          const h = Math.sqrt(radius * radius - dz * dz) + PROBE_R;
          const candidates = [AXIS.y - h, AXIS.y + h].sort((a, b) => (travel < 0 ? b - a : a - b));
          hit = candidates.find((c) => (travel < 0 ? c <= pos.y && c >= pos.y + travel : c >= pos.y && c <= pos.y + travel));
        }
        if (hit === undefined) {
          pos.y += travel;
          return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}:0]\nok`);
        }
        pos.y = hit;
        return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}:1]\nok`);
      }
      if (line.startsWith('G38.5 ')) {
        if (mode !== 'G91') throw new Error('a release in absolute mode');
        const r = /^G38\.5 ([XYZ])(-?[\d.]+)/.exec(line);
        if (r !== null) {
          const axis = r[1]!.toLowerCase() as 'x' | 'y' | 'z';
          pos[axis] += Number(r[2]!);
        }
        return reply('ok');
      }
      return reply(`error:unexpected line ${line}`);
    },
  };
  return { console, lines };
}

function options(radius = NOMINAL_R): RotaryTapOptions {
  const trial = planRotaryTrial({ axisZ: AXIS.z, radiusMm: NOMINAL_R }, BED_CLEARANCE_Z);
  if (!trial.ok) throw new Error(trial.reason);
  return {
    at: { x: -150, y: AXIS.y },
    trial: { z1: trial.z1, z2: trial.z2 },
    crownEstimateZ: trial.crownEstimateZ,
    crownBandMm: { min: AXIS.z - 5, max: AXIS.z + radius + 10 },
    probeRadiusMm: PROBE_R,
    searchMm: radius + 10,
    seekFromMachineZ: -3,
    touchFeed: 150,
    surfaceFeed: 150,
    parkAboveSurfaceMm: 2,
    // #1211 — the tap is bed setup, and this fixture's unit may touch sideways.
    mode: 'bed-setup' as const,
    probeTouches: 'all' as const,
  };
}

const yes = async () => true;

describe('#607 runRotaryTap on a bench-shaped chuck', () => {
  // ── #1211 — BED SETUP ONLY, AND TOP-TOUCH-ONLY UNITS REFUSE THE CHORDS ───────────────────────
  it('#1211 field 1 — a rotary tap called from a JOB session is refused with nothing sent', async () => {
    const fake = fakeChuck();
    const r = await runRotaryTap({ ...options(), mode: 'job' }, { liveClearanceZ: -3, console: fake.console, operator: yes });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('bed');
    expect(fake.lines).toHaveLength(0);
  });

  it('#1211 field 6 — a z-only unit refuses the sideways chords by name, with nothing sent', async () => {
    const fake = fakeChuck();
    const r = await runRotaryTap({ ...options(), probeTouches: 'z-only' }, { liveClearanceZ: -3, console: fake.console, operator: yes });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('side');
    expect(fake.lines).toHaveLength(0);
  });

  it('writes the axis Z, axis Y and radius from one chord and the crown, with a clean check chord', async () => {
    const fake = fakeChuck();
    const result = await runRotaryTap(options(), { liveClearanceZ: -3, console: fake.console, operator: yes });
    if (!result.ok) throw new Error(result.reason);
    expect(result.circle.axisY).toBeCloseTo(AXIS.y, 2);
    expect(result.circle.radiusMm).toBeCloseTo(NOMINAL_R, 1);
    expect(result.circle.axisZ).toBeCloseTo(AXIS.z, 1);
    expect(result.residualLine).toBeNull();
    // #1211 — THE BED-SETUP ORDER at the reachable points: lift to the clearance, traverse XY,
    // THEN descend (the park height) and probe. The guard would refuse anything else anyway.
    const at = (re: RegExp, from = 0): number =>
      fake.lines.findIndex((line, i) => i >= from && re.test(line));
    const lift = at(/^G53 G0 Z-3(?:\.0+)?$/);
    expect(lift).toBeGreaterThanOrEqual(0);
    const xy = at(/^G53 G0 X-150(?:\.0+)? Y/, lift + 1);
    expect(xy).toBeGreaterThan(lift);
    const lowerZ = at(/^G53 G0 Z-/, xy + 1);
    expect(lowerZ).toBeGreaterThan(xy);
    // Every side touch that triggered is released with G38.5 before the next G53/G0.
    const lines = fake.lines;
    for (let i = 0; i < lines.length; i++) {
      if (/^G38\.3 Y/.test(lines[i]!)) {
        let released = false;
        for (let j = i + 1; j < lines.length; j++) {
          if (/^G53 G0 /.test(lines[j]!)) break;
          if (/^G38\.5 /.test(lines[j]!)) released = true;
        }
        expect(released, `release after ${lines[i]}`).toBe(true);
      }
    }
  });

  it('#1190 — a probe refit shifts the trial chord and the crown’s band, and says so', async () => {
    // The axis datum is a RAW machine Z from the seating it was measured in. The M491 today reads
    // -80.000; the datum was taken at -82.000, so the probe sits 2 mm further out and every
    // expectation taken from the datum moves by that difference.
    const base = options();
    const fake = fakeChuck();
    const steps: string[] = [];
    const result = await runRotaryTap(
      { ...base, probeRefZ: -82 },
      { liveClearanceZ: -3, console: fake.console, operator: yes, onStep: (sentence) => steps.push(sentence) },
    );
    if (!result.ok) throw new Error(result.reason);
    const f3 = (n: number): string => (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';
    const shiftedTrial = { z1: base.trial.z1 + 2, z2: base.trial.z2 + 2 };
    // The chord and check chord are SENT at the corrected heights...
    expect(fake.lines).toContain(`G53 G0 Z${f3(shiftedTrial.z1 + base.parkAboveSurfaceMm)}`);
    expect(fake.lines).toContain(`G53 G0 Z${f3(shiftedTrial.z2 + base.parkAboveSurfaceMm)}`);
    // ...and the run says why, in the operator's words.
    expect(steps.join(' ')).toContain('the probe sits 2 mm further out');
    expect(steps.join(' ')).toContain(`corrected to machine Z ${f3(shiftedTrial.z1)}`);
    // The measured circle is the one the unshifted seating gives: the correction cancels the
    // seating difference, so the axis is the same physical wheel.
    const control = await runRotaryTap(base, { liveClearanceZ: -3, console: fakeChuck().console, operator: yes });
    if (!control.ok) throw new Error(control.reason);
    expect(result.circle.axisZ).toBeCloseTo(control.circle.axisZ, 2);
    expect(result.circle.radiusMm).toBeCloseTo(control.circle.radiusMm, 1);
  });

  it('with no stored reference the trial keeps its numbers — a legacy datum cannot be separated from its seating', async () => {
    const base = options();
    const fake = fakeChuck();
    const steps: string[] = [];
    const result = await runRotaryTap(base, { liveClearanceZ: -3, console: fake.console, operator: yes, onStep: (sentence) => steps.push(sentence) });
    if (!result.ok) throw new Error(result.reason);
    const f3 = (n: number): string => (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';
    expect(fake.lines).toContain(`G53 G0 Z${f3(base.trial.z1 + base.parkAboveSurfaceMm)}`);
    expect(steps.join(' ')).not.toContain('the probe sits');
  });

  it('measures an off-nominal chuck: R 41 is read, not the record’s 40', async () => {
    const fake = fakeChuck(41);
    const result = await runRotaryTap(options(), { liveClearanceZ: -3, console: fake.console, operator: yes });
    if (!result.ok) throw new Error(result.reason);
    expect(result.circle.radiusMm).toBeCloseTo(41, 1);
    expect(result.circle.axisZ).toBeCloseTo(AXIS.z, 1);
  });
});
