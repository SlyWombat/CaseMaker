// #827 — the centre-find session against a fake machine: the 2026-10-31 bench counterbore pinned
// in machine coordinates, and a round part (boss) for the other half. The fake models the feature
// the way the bench measured it: the PRB is the BALL'S CENTRE, one effective radius from the wall.

import { describe, expect, it } from 'vitest';
import type { ConsoleSendResult } from '@/platform/machineConsole';
import { PROBE_OPEN_REPLY, PROBE_TRIGGERED_REPLY, sentReply as reply } from './helpers/registrationFixtures';
import { runCentreFind, type CentreFindOptions } from '@/engine/cnc/registration/execute';
import { planCentreFind } from '@/engine/cnc/registration/centreFind';

// The bench, in MACHINE coordinates: the vise's counterbore at X −203.498, Y −181.329, calipered
// ⌀8.88, the probe's measured effective radius 0.875. G54 is chosen so WORK (10, 20) is that
// centre — what the operator's estimate would read under the job's frame.
const G54 = { x: -213.498, y: -201.329 };
const CENTRE = { x: -203.498, y: -181.329 };
// Machine Z: the travel clearance is −3, so the face is BELOW it and negative.
const TOP_Z = -5;
const R = 0.875;

interface Feature {
  kind: 'bore' | 'boss';
  radiusMm: number;
}

/** A fake machine holding one round feature; the PRB is the ball's centre at the trigger. */
function fakeMachine(feature: Feature) {
  let mode: 'G90' | 'G91' = 'G90';
  const pos = { x: -1, y: -1, z: -3 };
  const lines: string[] = [];
  const distFromCentre = (x: number, y: number): number => Math.hypot(x - CENTRE.x, y - CENTRE.y);
  /** Material under a point: the part's face for a boss; everything but the hole for a bore. */
  const materialAt = (x: number, y: number): boolean =>
    feature.kind === 'bore' ? distFromCentre(x, y) > feature.radiusMm : distFromCentre(x, y) <= feature.radiusMm;
  /** The ball touches a wall when its CENTRE is one radius off it (bore inward, boss outward). */
  const triggerRadius = feature.kind === 'bore' ? feature.radiusMm - R : feature.radiusMm + R;

  const console = {
    async send(line: string): Promise<ConsoleSendResult> {
      lines.push(line);
      if (line === '?') return reply('<Idle|MPos:0,0,0|WPos:0,0,0>');
      if (line === '$H') return (pos.x = -1), (pos.y = -1), (pos.z = -3), reply('ok');
      if (line === 'G54' || line === 'G92.1') return reply('ok');
      // #789 — the probe connector's supply, switched on by the session.
      if (line === 'M831' || line === 'M832') return reply('ok');
      if (line === 'M119') return reply(PROBE_OPEN_REPLY);
      if (line === 'M491') return reply(PROBE_TRIGGERED_REPLY);
      if (line === 'G90' || line === 'G91') return (mode = line), reply('ok');
      let m = /^G53 G0 Z(-?[\d.]+)$/.exec(line);
      if (m) return (pos.z = Number(m[1])), reply('ok');
      m = /^G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(line);
      if (m) {
        pos.x = Number(m[1]) + G54.x;
        pos.y = Number(m[2]) + G54.y;
        return reply('ok');
      }
      // A guarded Z descent: material under the point stops it at the top; otherwise it misses.
      m = /^G38\.3 Z-([\d.]+) F[\d.]+$/.exec(line);
      if (m) {
        if (mode !== 'G91') throw new Error('a probe in absolute mode');
        const target = pos.z - Number(m[1]);
        if (materialAt(pos.x, pos.y) && TOP_Z >= target && TOP_Z <= pos.z) {
          pos.z = TOP_Z;
          return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${TOP_Z.toFixed(3)}:1]\nok`);
        }
        pos.z = target;
        return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${target.toFixed(3)}:0]\nok`);
      }
      // A sideways touch: the first place along the move where the ball's centre is one radius
      // from the wall, in the travel's direction.
      m = /^G38\.3 ([XY])(-?[\d.]+) F[\d.]+$/.exec(line);
      if (m) {
        if (mode !== 'G91') throw new Error('a sideways probe in absolute mode');
        const axis = m[1] === 'X' ? 'x' : 'y';
        const travel = Number(m[2]);
        const along = axis === 'x' ? pos.x : pos.y;
        const other = axis === 'x' ? pos.y : pos.x;
        const otherOffset = other - (axis === 'x' ? CENTRE.y : CENTRE.x);
        const sq = triggerRadius * triggerRadius - otherOffset * otherOffset;
        if (sq < 0) {
          // The line passes beside the feature: the ball travels the whole way and misses.
          if (axis === 'x') pos.x += travel;
          else pos.y += travel;
          const at = axis === 'x' ? pos.x : pos.y;
          return reply(`[PRB:${(axis === 'x' ? at : pos.x).toFixed(3)},${(axis === 'x' ? pos.y : at).toFixed(3)},${pos.z.toFixed(3)}:0]\nok`);
        }
        const half = Math.sqrt(sq);
        const centreAlong = axis === 'x' ? CENTRE.x : CENTRE.y;
        const candidates = [centreAlong - half, centreAlong + half].sort((a, b) => (travel < 0 ? b - a : a - b));
        const hit = candidates.find((c) => (travel < 0 ? c <= along && c >= along + travel : c >= along && c <= along + travel));
        if (hit === undefined) {
          if (axis === 'x') pos.x += travel;
          else pos.y += travel;
          const at = axis === 'x' ? pos.x : pos.y;
          return reply(`[PRB:${(axis === 'x' ? at : pos.x).toFixed(3)},${(axis === 'x' ? pos.y : at).toFixed(3)},${pos.z.toFixed(3)}:0]\nok`);
        }
        if (axis === 'x') pos.x = hit;
        else pos.y = hit;
        return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}:1]\nok`);
      }
      // Probe-away releases: the ball backs off; no reading to report.
      m = /^G38\.5 ([XYZ])(-?[\d.]+) F[\d.]+$/.exec(line);
      if (m) {
        if (mode !== 'G91') throw new Error('a release in absolute mode');
        const axis = m[1]!.toLowerCase() as 'x' | 'y' | 'z';
        pos[axis] += Number(m[2]!);
        return reply('ok');
      }
      return reply(`error:unexpected line ${line}`);
    },
  };
  return { console, lines };
}

function options(feature: Feature, over: Partial<CentreFindOptions> = {}): CentreFindOptions {
  const made = planCentreFind({
    kind: feature.kind,
    at: { x: 10, y: 20 },
    searchMm: feature.kind === 'bore' ? 8 : 20,
    ballRadiusMm: R,
    stockThicknessMm: 10,
    touchFeed: 150,
  });
  if (!made.ok) throw new Error(made.reason);
  return {
    plan: made.plan,
    seekFromMachineZ: -3,
    bandMm: { min: TOP_Z - 1, max: TOP_Z + 1 },
    surfaceFeed: 150,
    parkAboveSurfaceMm: 2,
    // A bore's centre is a hole: the top is touched on the face beside it.
    ...(feature.kind === 'bore' ? { topTouchAt: { x: 24, y: 20 } } : {}),
    ...over,
  };
}

const yes = async () => true;

describe('#827 runCentreFind on the bench counterbore', () => {
  it('finds the centre and ⌀8.88 from the four walls, and releases every touch before any G0', async () => {
    const fake = fakeMachine({ kind: 'bore', radiusMm: 8.88 / 2 });
    const result = await runCentreFind(options({ kind: 'bore', radiusMm: 8.88 / 2 }), { console: fake.console, operator: yes });
    if (!result.ok) throw new Error(result.reason);
    // The centre, work and machine: the bench's own figure.
    expect(result.centreWork.x).toBeCloseTo(10, 2);
    expect(result.centreWork.y).toBeCloseTo(20, 2);
    expect(result.centreMachine.x).toBeCloseTo(CENTRE.x, 2);
    expect(result.centreMachine.y).toBeCloseTo(CENTRE.y, 2);
    const x = [...result.pairs].reverse().find((p) => p.axis === 'x')!;
    const y = [...result.pairs].reverse().find((p) => p.axis === 'y')!;
    expect(x.spanMm).toBeCloseTo(8.88 - 2 * R, 2); // 7.13 between ball centres
    expect(x.diameterMm).toBeCloseTo(8.88, 2);
    expect(y.diameterMm).toBeCloseTo(8.88, 2);
    // The origin the write would use is the measured centre; Z0's reference is the top touch.
    expect(result.outcome.correctedG54.x).toBeCloseTo(CENTRE.x, 2);
    expect(result.outcome.correctedG54.y).toBeCloseTo(CENTRE.y, 2);
    expect(result.surfaceZ).toBeCloseTo(TOP_Z, 3);
    expect(result.outcome.usable).toBe(true);

    // #790 — every side contact is released with G38.5 BEFORE the next G0. Walk the lines: after a
    // triggered G38.3 axis move there is a G38.5 before any G53 G0 Z / G0 X.
    const lines = fake.lines;
    let inRelative = false;
    let released = true;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === 'G91') inRelative = true;
      if (lines[i] === 'G90') inRelative = false;
      if (inRelative && /^G38\.3 [XY]/.test(lines[i]!)) {
        // The reply is not in `lines`; the release for a TOUCHED move is the next G38.5 before a G0.
        let sawRelease = false;
        for (let j = i + 1; j < lines.length; j++) {
          if (/^(G53 )?G0 /.test(lines[j]!)) break;
          if (/^G38\.5 /.test(lines[j]!)) sawRelease = true;
        }
        // A miss legitimately has no release; this run's touches all trigger.
        if (!sawRelease) released = false;
      }
    }
    expect(released).toBe(true);
  });

  it('recentres from an off estimate: the X pair lands on the middle, then Y, then X again', async () => {
    const fake = fakeMachine({ kind: 'bore', radiusMm: 8.88 / 2 });
    const made = planCentreFind({
      kind: 'bore',
      at: { x: 11, y: 19.5 },
      searchMm: 8,
      ballRadiusMm: R,
      stockThicknessMm: 10,
      touchFeed: 150,
    });
    if (!made.ok) throw new Error(made.reason);
    const result = await runCentreFind(
      { ...options({ kind: 'bore', radiusMm: 8.88 / 2 }), plan: made.plan, topTouchAt: { x: 24, y: 19.5 } },
      { console: fake.console, operator: yes },
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.centreWork.x).toBeCloseTo(10, 2);
    expect(result.centreWork.y).toBeCloseTo(20, 2);
    // Three pairs, in the bench's order.
    expect(result.pairs.map((p) => p.axis)).toEqual(['x', 'y', 'x']);
  });
});

describe('#827 runCentreFind on a round part', () => {
  it('measures a ⌀30 boss centre from outside, with the top at its own centre', async () => {
    const fake = fakeMachine({ kind: 'boss', radiusMm: 15 });
    const result = await runCentreFind(options({ kind: 'boss', radiusMm: 15 }), { console: fake.console, operator: yes });
    if (!result.ok) throw new Error(result.reason);
    expect(result.centreWork.x).toBeCloseTo(10, 2);
    expect(result.centreWork.y).toBeCloseTo(20, 2);
    const x = [...result.pairs].reverse().find((p) => p.axis === 'x')!;
    expect(x.spanMm).toBeCloseTo(2 * 15 + 2 * R, 2); // 31.75 between ball centres
    expect(x.diameterMm).toBeCloseTo(30, 2);
    expect(result.surfaceZ).toBeCloseTo(TOP_Z, 3);
  });

  it('refuses a search that starts under the part, naming the search radius', async () => {
    const fake = fakeMachine({ kind: 'boss', radiusMm: 15 });
    const made = planCentreFind({
      kind: 'boss',
      at: { x: 10, y: 20 },
      searchMm: 12, // inside the ⌀30 part: the start is under its top
      ballRadiusMm: R,
      stockThicknessMm: 10,
      touchFeed: 150,
    });
    if (!made.ok) throw new Error(made.reason);
    const result = await runCentreFind(
      { ...options({ kind: 'boss', radiusMm: 15 }), plan: made.plan },
      { console: fake.console, operator: yes },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/increase the search radius/);
  });
});

// #932 — the zero-travel refusal lives in the one probe-away builder every `G38.5` goes through.
// A release distance of 0 would put `G38.5 Z0` on the wire, which the controller refuses
// (`error:at least one of X Y or Z must be specified, and be > or < 0`, 10-31 bore :495) — and the
// contact then stays deflected for the next rapid, the alarm the release exists to prevent.
describe('#932 a zero release distance', () => {
  it('stops the run before a G38.5 is sent, naming the travel', async () => {
    const fake = fakeMachine({ kind: 'bore', radiusMm: 8.88 / 2 });
    const result = await runCentreFind(options({ kind: 'bore', radiusMm: 8.88 / 2 }, { releaseMm: 0 }), {
      console: fake.console,
      operator: yes,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('nothing to release');
    // The refused line never reaches the wire…
    expect(fake.lines.some((l) => /^G38\.5 Z0( |$)/.test(l))).toBe(false);
    // …and #933's stop path still backs the triggered stylus off, with the compiled distance: a
    // release setting of 0 must not leave the probe down for the epilogue's home.
    expect(fake.lines.filter((l) => l.startsWith('G38.5'))).toEqual(['G38.5 Z3 F100']);
  });
});
