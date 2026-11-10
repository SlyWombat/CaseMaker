/**
 * #1088 — SIDE 2'S HOLE REGISTRATION, against a fake machine: the plan's steps in order, a missed
 * bore wall stopping by name, an alarm mid-run stopping with nothing more sent, the origin read in
 * the WORK frame whatever G54 is in force, and the carried Z0 checked on the corner touches.
 *
 * The fake models side 2's blank as the planner expects it: the front edge at Y = 0, the part on
 * its top at machine Z −5, and two ⌀5 bores at (12, 30) and (32, 30) whose walls a ⌀2 ball meets
 * with its centre 1.5 mm from the bore's centre. Its touches land on the model's own rule — the
 * probe reads the stock until its centre is the tip's rim past the edge — so the executor's edge
 * correction is exercised, not assumed.
 */
import { describe, expect, it } from 'vitest';
import type { ConsoleSendResult } from '@/platform/machineConsole';
import { PROBE_OPEN_REPLY, PROBE_TRIGGERED_REPLY, sentReply as reply } from './helpers/registrationFixtures';
import { runFlipRegistration } from '@/engine/cnc/registration/execute';
import { planFlipRegistration } from '@/engine/cnc/registration/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { flipZ0 } from '@/engine/cnc/engrave/flipChoice';
import type { RegistrationPlan } from '@/engine/cnc/registration/plan';

const SURFACE_Z = -5;
const R_BALL = 1; // ⌀2 tip
const BORE_R = 2.5; // ⌀5
const RIM = registrationSettings(null).settings.tipRadiusMm;
const BORES = [
  { x: 12, y: 30 },
  { x: 32, y: 30 },
] as const;

function flipPlan() {
  const { settings } = registrationSettings(null);
  const r = planFlipRegistration({
    method: 'tabs-in-blank',
    stock: { xMin: 0, yMin: 0, xMax: 44.5, yMax: 60, cornerRadius: 0 },
    holes: BORES.map((b) => ({ ...b })),
    boreDiameterMm: BORE_R * 2,
    probeTipDiameterMm: R_BALL * 2,
    settings,
  });
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
}

/** The frame the touches run in: the seek, mount, settings and surface point — no scans run. */
function ctx(): RegistrationPlan {
  const { settings } = registrationSettings(null);
  return {
    mount: 'vise',
    stock: { xMin: 0, yMin: 0, xMax: 44.5, yMax: 60, cornerRadius: 0 },
    surfacePoint: { x: 22, y: 30 },
    seek: { fromMachineZ: -3, travelMm: 60, band: { min: -60, max: -4 } },
    mountDatum: null,
    probe: null,
    mountTap: null,
    scans: [],
    bracketOrigin: null,
    mountObstacles: [],
    settings,
    notes: [],
  } as unknown as RegistrationPlan;
}

interface FakeOpts {
  /** A bore whose +X wall is missing (its radius is enlarged), mm — the miss case. */
  missingPlusXBore?: 1 | 2;
  /** ALARM the Nth sideways touch (1-based over the whole run). */
  alarmAtTouch?: number;
  /** The G54 in force when the run starts — the touches' PRBs are machine XY, this much off work. */
  g54?: { x: number; y: number };
}

function fakeMachine(sent: string[], opts: FakeOpts = {}) {
  const g54 = opts.g54 ?? { x: 0, y: 0 };
  const prb = (z: number, touched: boolean): string =>
    `[PRB:${(pos.x + g54.x).toFixed(3)},${(pos.y + g54.y).toFixed(3)},${z.toFixed(3)}:${touched ? 1 : 0}]\nok`;
  const pos = { x: 0, y: 0, z: -3 };
  let sideways = 0;
  /** The ball's rim: the probe reads the stock until its centre is this far past the edge. */
  const materialAt = (x: number, y: number): boolean => {
    if (!(y > -RIM && x > -RIM)) return false;
    return !BORES.some((b) => Math.hypot(x - b.x, y - b.y) <= BORE_R);
  };
  const console = {
    async send(line: string): Promise<ConsoleSendResult> {
      sent.push(line);
      if (line === '?') return reply(`<Idle|MPos:${(pos.x + g54.x).toFixed(3)},${(pos.y + g54.y).toFixed(3)},${pos.z.toFixed(3)}|WPos:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}>`);
      if (line === '$H') return (pos.x = 0), (pos.y = 0), (pos.z = -3), reply('ok');
      if (line === 'G54' || line === 'G92.1' || line === 'M831' || line === 'M832') return reply('ok');
      if (line === 'M119') return reply(PROBE_OPEN_REPLY);
      if (line === 'M491') return reply(PROBE_TRIGGERED_REPLY);
      if (line === 'G90' || line === 'G91') return reply('ok');
      let m = /^G53 G0 Z(-?[\d.]+)$/.exec(line);
      if (m) return (pos.z = Number(m[1])), reply('ok');
      m = /^G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(line);
      if (m) return (pos.x = Number(m[1])), (pos.y = Number(m[2])), reply('ok');
      m = /^G38\.3 Z-([\d.]+) F[\d.]+$/.exec(line);
      if (m) {
        const target = pos.z - Number(m[1]);
        if (materialAt(pos.x, pos.y) && SURFACE_Z >= target && SURFACE_Z <= pos.z) {
          pos.z = SURFACE_Z;
          return reply(prb(SURFACE_Z, true));
        }
        pos.z = target;
        return reply(prb(target, false));
      }
      m = /^G38\.3 ([XY])(-?[\d.]+) F[\d.]+$/.exec(line);
      if (m) {
        sideways++;
        if (opts.alarmAtTouch !== undefined && sideways === opts.alarmAtTouch) {
          return { kind: 'sent', line, text: 'ALARM: unexpected probe trigger', frames: 1, elapsedMs: 1 } as ConsoleSendResult;
        }
        const axis = m[1] === 'X' ? 'x' : 'y';
        const travel = Number(m[2]);
        // The nearest bore whose wall the move could meet: the ball centre at 1.5 mm from its centre.
        const reach = BORE_R - R_BALL;
        const targets = BORES.map((b, i) => ({ b, i: (i + 1) as 1 | 2 }));
        for (const { b, i } of targets) {
          const otherAxis = axis === 'x' ? 'y' : 'x';
          const otherOffset = (axis === 'x' ? pos.y : pos.x) - b[otherAxis];
          const sq = reach * reach - otherOffset * otherOffset;
          if (sq < 0) continue;
          if (axis === 'x' && opts.missingPlusXBore === i && travel > 0) continue;
          const wall = axis === 'x' ? b.x + Math.sign(travel) * Math.sqrt(sq) : b.y + Math.sign(travel) * Math.sqrt(sq);
          const along = axis === 'x' ? pos.x : pos.y;
          const end = along + travel;
          const hit = travel > 0 ? wall <= end && wall >= along : wall >= end && wall <= along;
          if (hit) {
            if (axis === 'x') pos.x = wall;
            else pos.y = wall;
            return reply(prb(pos.z, true));
          }
        }
        if (axis === 'x') pos.x += travel;
        else pos.y += travel;
        return reply(prb(pos.z, false));
      }
      // The probe-away (a G38.5 back along the touched axis) and anything else: ok.
      if (line.startsWith('G38.5')) return reply('ok');
      return reply('ok');
    },
  };
  return console;
}

const deps = (console: ReturnType<typeof fakeMachine>) => ({
  console,
  operator: async () => true,
});

/** The carried Z0, as the job states it: side 2's top at the fake's surface, ± 0.3 mm. */
const Z0 = () => flipZ0({ seatMm: SURFACE_Z, thicknessMm: 0, toleranceMm: 0.3 });

describe('#1088 the flip registration executor', () => {
  it('runs the plan’s steps in order: guards, the front pair, the seed, then each bore’s four touches', async () => {
    const sent: string[] = [];
    const machine = fakeMachine(sent);
    const r = await runFlipRegistration(flipPlan(), { ctx: ctx(), z0: Z0() }, deps(machine) as never);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    // The measured bores: the fake's walls put the centres within a touch of the truth.
    expect(r.holes).toHaveLength(2);
    for (const [i, h] of r.holes.entries()) {
      expect(Math.abs(h.centre.x - BORES[i]!.x)).toBeLessThan(0.3);
      expect(Math.abs(h.centre.y - BORES[i]!.y)).toBeLessThan(0.3);
    }
    // The edge correction is exercised: the found front edge is the stock's own Y ≈ 0, not a raw
    // bracket midpoint that is one rim short of it.
    expect(Math.abs(r.frontPair[0]!.y)).toBeLessThan(0.3);
    // The outcome the press writes: the origin at the bores' midpoint, X and Y, and the run's own
    // gates passed (the entry seeks, the eight walls, the line, the carried Z0).
    expect(r.outcome.usable).toBe(true);
    expect(r.outcome.flip?.holes).toHaveLength(2);
    expect(r.correctedG54.x).toBeCloseTo(0, 2);
    // Y is the front pair's mean: as exact as the scan's own bisection (half a fine step).
    expect(Math.abs(r.correctedG54.y)).toBeLessThan(0.2);
    // THE ORDER, on the lines actually sent.
    const at = (re: RegExp): number => sent.findIndex((l) => re.test(l));
    const marks = [
      at(/^\?$/),
      at(/^\$H$/),
      at(/^G54$/),
      at(/^M831$/),
      at(/^M119$/),
      at(/^M491$/),
      // the front pair: two Z touches at the front scans, then the seed's,
      at(/^G38\.3 Z-/),
      // the bores: the entry seek at the seeded pins, then sideways X touches,
      at(/^G38\.3 X/),
      at(/^G38\.3 Y/),
    ];
    expect(marks.every((i) => i >= 0)).toBe(true);
    for (let i = 1; i < marks.length; i++) expect(marks[i]!).toBeGreaterThan(marks[i - 1]!);
    // The entry seeks were asked at the two seeded pins, in order.
    const pins = sent.filter((l) => /^G0 X12(\.000)? Y30(\.000)?$/.test(l)).length;
    expect(pins).toBeGreaterThanOrEqual(1);
    // Eight sideways touches and eight releases: four per bore.
    expect(sent.filter((l) => /^G38\.3 [XY]/.test(l))).toHaveLength(8);
    expect(sent.filter((l) => l.startsWith('G38.5')).length).toBeGreaterThanOrEqual(8);
  }, 60_000);

  it('reads the origin in the WORK frame whatever G54 was in force', async () => {
    const sent: string[] = [];
    // The machine holds a G54 10 mm right and 5 mm back of the work zero the moves are sent in.
    const machine = fakeMachine(sent, { g54: { x: 10, y: 5 } });
    const r = await runFlipRegistration(flipPlan(), { ctx: ctx(), z0: Z0() }, deps(machine) as never);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    // The bores' centres are WORK XY: the PRBs are machine, and the run subtracts the frame.
    for (const [i, h] of r.holes.entries()) {
      expect(Math.abs(h.centre.x - BORES[i]!.x)).toBeLessThan(0.3);
      expect(Math.abs(h.centre.y - BORES[i]!.y)).toBeLessThan(0.3);
    }
    // The G54 the press writes is the one that puts those bores on their pins' work positions.
    expect(r.correctedG54.x).toBeCloseTo(10, 2);
    expect(Math.abs(r.correctedG54.y - 5)).toBeLessThan(0.2);
    expect(r.outcome.correctedG54).toEqual(r.correctedG54);
    expect(r.outcome.currentG54).toEqual({ x: 10, y: 5 });
  }, 60_000);

  it('a corner Z reading outside the carried Z0’s band stops by name before any bore is entered', async () => {
    const sent: string[] = [];
    const machine = fakeMachine(sent);
    // The carried top says the blank sits 5 mm above where its corner touches read — a chip under
    // the blank (or the wrong seat) is what this finds.
    const carried = flipZ0({ seatMm: SURFACE_Z + 5, thicknessMm: 0, toleranceMm: 0.3 });
    const r = await runFlipRegistration(flipPlan(), { ctx: ctx(), z0: carried }, deps(machine) as never);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('corner Z touches');
    expect(r.reason).toContain('carried Z0');
    expect(r.reason).toContain('no origin is written');
    // NOTHING MORE MEASURED: no bore was entered and no wall was touched — the stop is at the corners.
    expect(sent.filter((l) => /^G38\.3 [XY]/.test(l))).toHaveLength(0);
    expect(sent.filter((l) => /^G0 X12/.test(l))).toHaveLength(0);
  }, 60_000);

  it('a missed bore wall stops the find by name, and nothing more is sent', async () => {
    const sent: string[] = [];
    const machine = fakeMachine(sent, { missingPlusXBore: 2 });
    const r = await runFlipRegistration(flipPlan(), { ctx: ctx(), z0: Z0() }, deps(machine) as never);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('bore 2');
    expect(r.reason).toContain('(32, 30)');
    expect(r.reason).toContain('found no +X wall');
    // Nothing more is sent after the miss: no further G38.3 went out.
    expect(sent.filter((l) => /^G38\.3 [XY]/.test(l)).length).toBe(5); // bore 1’s four, then bore 2’s +X missed
  }, 60_000);

  it('an alarm mid-run stops with nothing more sent beyond the epilogue', async () => {
    const sent: string[] = [];
    const machine = fakeMachine(sent, { alarmAtTouch: 6 });
    const r = await runFlipRegistration(flipPlan(), { ctx: ctx(), z0: Z0() }, deps(machine) as never);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('ALARM');
    // No probe move after the alarm line: the sideways count stops at the alarmed one.
    expect(sent.filter((l) => /^G38\.3 [XY]/.test(l))).toHaveLength(6); // the 6th was the alarm
    // The alarm is cleared only if `?` reads Alarm — this fake stays Idle, so no `$X` went out.
    expect(sent).not.toContain('$X');
  }, 60_000);
});
