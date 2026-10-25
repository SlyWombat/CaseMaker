// #430 phase 1 — the registration planner, its outcome maths and its executor, against a FAKE machine
// that answers like the 2026-10-15 bench did, and a REPLAY of that bench's own answers. Nothing here
// reaches a real controller.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { consoleProblem } from '@/engine/cnc/consoleGate';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import { viseTapPoint } from '@/engine/cnc/mounts/vise';
import type { ConsoleSendResult } from '@/platform/machineConsole';
import {
  applyCorrection,
  classifyTouch,
  computeOutcome,
  correctionLine,
  cutterZ0,
  edgeFrom,
  lastPrb,
  parsePrbs,
  planRegistration,
  registrationSettings,
  retouchAndCorrectAfterFacing,
  retouchSurface,
  runRegistration,
  runMountTap,
  summarizeOutcome,
  summarizePlan,
  type ExpectedStock,
  type MountDatum,
  type PlanInput,
  type RegistrationPlan,
} from '@/engine/cnc/registration';
import type { LiveTouch } from '@/engine/cnc/registration/liveTouch';
import type { ProbeSpec } from '@/engine/cnc/registration/plan';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown };
const { settings: S, fallbacks } = registrationSettings(ShopDefaultsSchema.parse(DOC.defaults));

/** The badge blank of Appendix C, origin at its front-left corner. */
const BLANK: ExpectedStock = { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 };
const SURFACE = -56.172;
const G54 = { x: -181.55, y: -184.8 };

function input(mount: 'vise' | 'tape' | 'bracket' = 'vise', over: Partial<PlanInput> = {}): PlanInput {
  return {
    stock: BLANK,
    mount,
    expectedSurface: { machineZ: SURFACE, from: 'the vise top and the blank’s proud height' },
    // The Z1's own travel height (`MACHINES.Z1.toolChange.clearanceZ`) — required, never defaulted (#448).
    seekFromMachineZ: -3,
    fixtureBelowSurfaceMm: mount === 'vise' ? 0.72 : undefined,
    bracketOrigin: mount === 'bracket' ? { x: G54.x, y: G54.y, from: 'anchor1 + (0, 0)', offsetMeasured: true } : undefined,
    mountObstacles: mount === 'bracket' ? [] : undefined,
    ...over,
  };
}

function plan(mount: 'vise' | 'tape' | 'bracket' = 'vise', over: Partial<PlanInput> = {}): RegistrationPlan {
  const r = planRegistration(input(mount, over), S);
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
}

describe('#430 the settings come from the shop defaults', () => {
  it('reads every registration.* key from the location; the rim offset is the MEASURED one', () => {
    expect(fallbacks).toEqual([]);
    expect(S.tipRadiusMm).toBe(0.7);
    const d = ShopDefaultsSchema.parse(DOC.defaults)['registration.tipRadiusMm']!;
    expect(d.source).toBe('measured');
    expect(d.note).toContain('39.5 mm wide');
  });

  it('refuses a band as deep as the cap, and a tolerance that reaches the park height', () => {
    expect(planRegistration(input(), { ...S, surfaceBandMm: S.capBelowSurfaceMm })).toMatchObject({ ok: false });
    expect(planRegistration(input(), { ...S, surfaceToleranceMm: S.parkAboveSurfaceMm - 0.5 })).toMatchObject({ ok: false });
    // The seeded values satisfy both, with the bench's jaw 0.47 below the stock.
    expect(S.surfaceToleranceMm).toBeLessThan(0.47);
    expect(S.surfaceToleranceMm).toBeLessThan(S.parkAboveSurfaceMm - 0.5);
  });

  it('#598 a checked-out probe resolves the tip/rim values over the shop fallback', () => {
    const probe = { id: 'fx-probe-1', variant: 'wired-touch', tip: { diameterMm: 3.0, rimOffsetMm: 0.9, rimOffsetUncertaintyMm: 0.2 } };
    const withProbe = registrationSettings(ShopDefaultsSchema.parse(DOC.defaults), probe);
    expect(withProbe.settings.tipDiameterMm).toBe(3.0);
    expect(withProbe.settings.tipRadiusMm).toBe(0.9);
    expect(withProbe.settings.tipRadiusUncertaintyMm).toBe(0.2);
    // The shop keys stay the no-probe fallback.
    expect(registrationSettings(ShopDefaultsSchema.parse(DOC.defaults)).settings.tipRadiusMm).toBe(0.7);
  });
});

describe('#430 the plan', () => {
  it('vise: the left edge and the front edge; the surface at the cut area’s centre', () => {
    const p = plan('vise', { cutCentre: { x: 19, y: 40 } });
    expect(p.scans.map((s) => [s.edge, s.along])).toEqual([
      ['left', 38.1],
      ['front', 19.05],
    ]);
    expect(p.surfacePoint).toEqual({ x: 19, y: 40 });
  });

  it('bounds the surface seek to the expected surface ± tolerance', () => {
    const p = plan('vise');
    expect(p.seek).toEqual({ fromMachineZ: -3, travelMm: 53.572, band: { min: -56.572, max: -55.772 } });
    expect(planRegistration(input('vise', { expectedSurface: { machineZ: -99, from: 'x' } }), S)).toMatchObject({ ok: false });
  });

  it('refuses a vise whose jaws sit within the surface band of the stock — either way — or a mount with no origin', () => {
    expect(planRegistration(input('vise', { fixtureBelowSurfaceMm: 0.1 }), S)).toMatchObject({ ok: false });
    const within = planRegistration(input('vise', { fixtureBelowSurfaceMm: -0.2 }), S);
    expect(within.ok).toBe(false);
    if (!within.ok) expect(within.reason).toContain('0.2 mm above');
    // The tolerance must not reach the jaw tops: a seek onto a jaw would read as the surface.
    const reach = planRegistration(input('vise', { fixtureBelowSurfaceMm: 0.3 }), S);
    expect(reach.ok).toBe(false);
    if (!reach.ok) expect(reach.reason).toContain('reaches the jaw tops');
    expect(planRegistration(input('bracket', { bracketOrigin: undefined }), S)).toMatchObject({ ok: false });
  });

  it('#517 a stock BELOW the jaw tops is planned: the jaw reads high past the gripped edge, and that reading is the edge', () => {
    // The 2026-10-18 laminate: 1.5 mm on the 3.1 mm ledges, 1.6 mm below the jaw tops, band 0.25.
    const r = planRegistration(input('vise', { fixtureBelowSurfaceMm: -1.6 }), S);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.scans[0]).toMatchObject({ edge: 'left', aboveIsEdge: true });
    expect(r.plan.scans[1]!.aboveIsEdge).toBeUndefined();
    expect(r.plan.notes.join(' ')).toContain('1.6 mm below the jaw tops');
    // The jaws must stay under the park height: every sideways move is made there.
    const tall = planRegistration(input('vise', { fixtureBelowSurfaceMm: -(S.parkAboveSurfaceMm - 0.5) }), S);
    expect(tall.ok).toBe(false);
    if (!tall.ok) expect(tall.reason).toContain('park height');
  });

  it('tape: two left points kept clear of the rounded corners', () => {
    expect(plan('tape').scans.filter((s) => s.edge === 'left').map((s) => s.along)).toEqual([5, 71.2]);
  });

  it('says what it will do', () => {
    expect(summarizePlan(plan())).toContain('stopping at the first touch off the stock');
  });
});

describe('#598 the datum and the checked-out probe', () => {
  const DATUM: MountDatum = { jawTopZ: SURFACE - 1.84, measuredAt: '2026-10-23T00:00:00.000Z', by: 'wired-probe' };

  it('a plan with a datum needs no seat input, and its seek floor is jawTopZ − tolerance', () => {
    const r = planRegistration(input('vise', { mountDatum: DATUM, fixtureBelowSurfaceMm: undefined }), S);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.mountDatum).toEqual(DATUM);
    expect(r.plan.seek.band.min).toBeCloseTo(DATUM.jawTopZ - S.surfaceToleranceMm, 3);
    expect(r.plan.seek.band.max).toBeCloseTo(SURFACE + S.surfaceToleranceMm, 3);
    expect(r.plan.notes.join(' ')).toContain('the measured jaw top');
  });

  it('a tolerance that reaches the jaw tops is a WARNING, not a stop, with a datum', () => {
    // proud 0.72 with a 1.0 tolerance: the legacy seat path refuses ("reaches the jaw tops"); the datum path must not.
    const datum = { ...DATUM, jawTopZ: SURFACE - 0.72 };
    const r = planRegistration(input('vise', { mountDatum: datum, fixtureBelowSurfaceMm: undefined }), { ...S, surfaceToleranceMm: 1.0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.notes.join(' ')).toContain('reaches the jaw tops');
  });

  it('a tolerance 1.0 and a datum 1.84 below the stock is NOT refused (the 2026-10-23 refusal case)', () => {
    const r = planRegistration(input('vise', { mountDatum: DATUM, fixtureBelowSurfaceMm: undefined }), { ...S, surfaceToleranceMm: 1.0 });
    expect(r.ok).toBe(true);
  });

  it('a datum wins over the seat estimate: the seat path remains only behind the expert override', () => {
    // A conflicting seat estimate (0.1 mm proud — within the surface band) is ignored when a datum is present.
    const r = planRegistration(input('vise', { mountDatum: DATUM, fixtureBelowSurfaceMm: 0.1 }), S);
    expect(r.ok).toBe(true);
  });

  it('without a datum the legacy seat path still refuses a tolerance that reaches the jaw tops', () => {
    expect(planRegistration(input('vise', { fixtureBelowSurfaceMm: 0.72 }), { ...S, surfaceToleranceMm: 1.0 })).toMatchObject({ ok: false });
  });
});

describe('#599 the vise tap point', () => {
  it('with the house fixture the tap is within 1 mm of the bench X −186.2, and mid-bar in Y', () => {
    const full = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
      machines: Array<{
        bedProfiles: Array<{ placements: Array<{ where: { kind: string; pins: string | null }; frame: { fixedJawFaceX: number | null; jawStartY: number | null } }> }>;
      }>;
      accessories: Array<{ kind: string; constants: Record<string, unknown> }>;
    };
    const placement = full.machines[0]!.bedProfiles[0]!.placements.find((p) => p.where.kind === 'pins' && p.where.pins === 'vise')!;
    const vise = full.accessories.find((a) => a.kind === 'vise')!;
    const frame = { fixedJawFaceX: placement.frame.fixedJawFaceX!, jawStartY: placement.frame.jawStartY! };
    const jawLength = vise.constants.jawLength as number;
    const point = viseTapPoint(frame, { jawBarWidth: vise.constants.jawBarWidth as number, jawLength });

    // The bench tap (2026-10-23) was at machine X −186.2, on the bar mid-way along its length.
    expect(Math.abs(point.x - -186.2)).toBeLessThanOrEqual(1);
    const lo = frame.jawStartY + 5;
    const hi = frame.jawStartY + jawLength - 5;
    expect(point.y).toBeGreaterThanOrEqual(lo);
    expect(point.y).toBeLessThanOrEqual(hi);
    // The bench's mid-BLANK tap Y −180 is also inside the bar's span, so mid-bar is the safe choice.
    expect(-180).toBeGreaterThanOrEqual(lo);
    expect(-180).toBeLessThanOrEqual(hi);
  });
});

describe('#430 readings', () => {
  it('reads the bench’s answers and classifies above, on, below and a miss', () => {
    const m491 = 'M491\nok\n[PRB:-9.890,-12.830,-76.074:1]\nok\n[PRB:-9.890,-12.830,-76.063:1]\nDone ATC';
    expect(parsePrbs(m491)).toHaveLength(2);
    expect(lastPrb(m491)?.z).toBe(-76.063);
    const p = { x: 0, y: 0, z: 0, touched: true };
    expect(classifyTouch({ ...p, touched: false }, SURFACE, 0.25)).toBe('miss');
    expect(classifyTouch({ ...p, z: -56.642 }, SURFACE, 0.25)).toBe('below');
    expect(classifyTouch({ ...p, z: -56.03 }, SURFACE, 0.25)).toBe('stock');
    expect(classifyTouch({ ...p, z: -54 }, SURFACE, 0.25)).toBe('above');
  });
});

describe('#430 the outcome', () => {
  it('puts the edge one measured rim offset inside where the reading changed', () => {
    const scan = plan('vise').scans[1]!;
    const t = (at: number, kind: 'stock' | 'miss') => ({ at, kind, prb: { x: 0, y: 0, z: 0, touched: kind === 'stock' } });
    expect(edgeFrom({ scan, touches: [t(3, 'stock'), t(-3, 'stock'), t(-3.5, 'miss')] }, 0.7).foundAt).toBe(-2.55);
  });

  it('Z0 = surface + (cutter PRB − probe PRB): the bench’s own −59.213', () => {
    expect(cutterZ0({ surfaceZ: -56.116, probeRefZ: -76.061 }, -79.158)).toBe(-59.213);
  });
});

/**
 * A fake Z1, honouring G90/G91. The stock is `actual` (work XY under G54) with its top at `surface`;
 * the probe reads it while its centre is within the rim offset (0.7) of it; a jaw top 0.47 below the
 * surface for 10 mm left of the stock; an optional clamp 2 mm ABOVE the surface. `polls` makes `?`
 * read Run that many times before each Idle. Every XY move records the Z it happened at.
 */
function fakeZ1(opts: {
  actual: ExpectedStock;
  surface?: number;
  jaw?: boolean;
  /** #517 — a jaw top this far ABOVE the surface for 10 mm left of the stock (a recessed sheet). */
  jawAbove?: number;
  clamp?: { xMin: number; xMax: number };
  idle?: boolean;
  polls?: number;
  landShift?: number;
  /** The G54 in force for plain `G0` moves, when it is not where the stock is (a stale origin). */
  g54?: { x: number; y: number };
  /** #599 — `M119` reads the probe touched (`Probe: 1`) at rest, as a bad plug would. */
  probeTouched?: boolean;
  /** #599 — a jaw top to answer at this machine XY (the mount tap). */
  tap?: { x: number; y: number; z: number };
  /** #525 — the probe rim the Z touches read (default the wired probe's 0.7 mm). */
  rim?: number;
  /**
   * #525 — the 3D probe's stylus ball radius, mm. A horizontal `G38.3` then answers a contact one
   * radius outside the stock's edge it reaches (the ball's centre at the trigger), or a miss.
   */
  ballR?: number;
}) {
  const inForce = opts.g54 ?? G54;
  const surface = opts.surface ?? SURFACE;
  const a = opts.actual;
  let mode: 'G90' | 'G91' = 'G90';
  const pos = { x: 0, y: 0, z: -3 };
  let tool: 'probe' | 'cutter' = 'probe';
  let alarmed = false;
  let lowest = Infinity;
  let pending = 0;
  const lines: string[] = [];
  const xyMovesAtZ: number[] = [];
  const reply = (text: string): ConsoleSendResult => ({ kind: 'sent', line: '', text, frames: 1, elapsedMs: 1 });
  const RIM = opts.rim ?? 0.7;
  const zAt = (wx: number, wy: number): number | null => {
    if (opts.clamp && wx >= opts.clamp.xMin && wx <= opts.clamp.xMax) return surface + 2;
    if (wx >= a.xMin - RIM && wx <= a.xMax + RIM && wy >= a.yMin - RIM && wy <= a.yMax + RIM) return surface;
    if (opts.jaw && wx < a.xMin && wx > a.xMin - 10) return surface - 0.47;
    if (opts.jawAbove !== undefined && wx < a.xMin && wx > a.xMin - 10) return surface + opts.jawAbove;
    if (opts.tap && Math.abs(wx - (opts.tap.x - inForce.x)) < 0.5 && Math.abs(wy - (opts.tap.y - inForce.y)) < 0.5) return opts.tap.z;
    return null;
  };
  const console = {
    async send(line: string): Promise<ConsoleSendResult> {
      lines.push(line);
      if (line === '?') {
        if (opts.idle === false) return reply('<Run|MPos:0,0,0>');
        if (pending > 0) return (pending--, reply('<Run|MPos:0,0,0>'));
        pending = opts.polls ?? 0;
        return reply(alarmed ? '<Alarm|MPos:0,0,0>' : '<Idle|MPos:0,0,0>');
      }
      if (line === '$X') return (alarmed = false), reply('ok');
      // The Z1 refuses everything but `$X` (and `?`) in alarm — `G90` included (Z1-Firmware-Dialect.md).
      if (alarmed) return reply('error:Alarm lock');
      if (line === '$H') return (pos.x = -1), (pos.y = -1), (pos.z = -1), reply('ok');
      if (line === 'G54' || line === 'G92.1') return reply('ok');
      if (line === 'M119') return reply(opts.probeTouched ? 'X_max:0 Y_max:0 Z_max:0 A_min:1 Probe: 1' : 'X_max:0 Y_max:0 Z_max:0 A_min:1 Probe: 0');
      if (line === 'M491') {
        const z = tool === 'probe' ? -76.063 : -79.163;
        return reply(`[PRB:-9.890,-12.830,${z - 0.011}:1]\nok\n[PRB:-9.890,-12.830,${z}:1]\nDone ATC`);
      }
      if (line === 'G90' || line === 'G91') return (mode = line), reply('ok');
      let m = /^G53 G0 Z(-?[\d.]+)$/.exec(line);
      if (m) return (pos.z = Number(m[1])), reply('ok');
      // #427 — the bracket's moves are sent in machine coordinates.
      m = /^G53 G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(line);
      if (m) {
        xyMovesAtZ.push(pos.z);
        pos.x = Number(m[1]) + (xyMovesAtZ.length > 1 ? (opts.landShift ?? 0) : 0);
        pos.y = Number(m[2]);
        return reply('ok');
      }
      m = /^G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(line);
      if (m) {
        xyMovesAtZ.push(pos.z);
        if (mode === 'G90') {
          // `landShift` moves every XY move AFTER the surface one: a scan that lands somewhere else.
          pos.x = Number(m[1]) + inForce.x + (xyMovesAtZ.length > 1 ? (opts.landShift ?? 0) : 0);
          pos.y = Number(m[2]) + inForce.y;
        } else {
          pos.x += Number(m[1]);
          pos.y += Number(m[2]);
        }
        return reply('ok');
      }
      m = /^G0 Z(-?[\d.]+)$/.exec(line);
      if (m) {
        if (mode !== 'G91') throw new Error('a Z move in absolute work coordinates');
        return (pos.z += Number(m[1])), reply('ok');
      }
      // #518 — the executor probes with G38.3: a miss is `[PRB:…:0]` and `ok`, never an alarm. A G38.2
      // from the executor is a regression and is answered as the controller would: an alarm.
      m = /^G38\.2 Z-([\d.]+) F[\d.]+$/.exec(line);
      if (m) return (alarmed = true), reply('ALARM: Probe fail');
      m = /^G38\.3 Z-([\d.]+) F[\d.]+$/.exec(line);
      if (m) {
        if (mode !== 'G91') throw new Error('the executor probed in absolute mode');
        const target = pos.z - Number(m[1]);
        const hit = zAt(pos.x - G54.x, pos.y - G54.y);
        if (hit !== null && hit >= target && hit <= pos.z) {
          pos.z = hit;
          lowest = Math.min(lowest, pos.z);
          return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${hit.toFixed(3)}:1]\nok`);
        }
        pos.z = target;
        lowest = Math.min(lowest, pos.z);
        return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${target.toFixed(3)}:0]\nok`);
      }
      // #525 — a SIDEWAYS probe: the 3D probe's ball contacts the stock's edge it can reach with its
      // centre one radius outside it, and reports that centre; no contact over the travel is a miss.
      m = /^G38\.3 ([XY])(-?[\d.]+) F[\d.]+$/.exec(line);
      if (m) {
        if (mode !== 'G91') throw new Error('the executor probed in absolute mode');
        const axis = m[1] === 'X' ? ('x' as const) : ('y' as const);
        const travel = Number(m[2]);
        const r = opts.ballR ?? 1.5;
        const startMachine = pos[axis];
        const endMachine = startMachine + travel;
        const lo = (axis === 'x' ? a.xMin : a.yMin) + (axis === 'x' ? inForce.x : inForce.y);
        const hi = (axis === 'x' ? a.xMax : a.yMax) + (axis === 'x' ? inForce.x : inForce.y);
        const contactLow = lo - r; // moving + toward the low edge, the centre stops one radius outside
        const contactHigh = hi + r;
        const hits =
          travel > 0 ? startMachine < contactLow && endMachine >= contactLow : startMachine > contactHigh && endMachine <= contactHigh;
        pos[axis] = hits ? (travel > 0 ? contactLow : contactHigh) : endMachine;
        return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}:${hits ? 1 : 0}]\nok`);
      }
      if (/^G10 L2 P1 /.test(line)) return reply('ok');
      return reply(`error:unexpected line ${line}`);
    },
  };
  return {
    console,
    lines,
    xyMovesAtZ,
    lowest: () => lowest,
    fitCutter: () => (tool = 'cutter'),
    mode: () => mode,
    alarmed: () => alarmed,
    /** Put the controller in Alarm so the next `?` answers `<Alarm|…>`. */
    alarm: () => {
      alarmed = true;
    },
  };
}

const SHIFTED = { ...BLANK, xMin: 1.2, xMax: 39.3, yMin: 0.8, yMax: 77 };
const yes = async () => true;

describe('#599 the mount tap', () => {
  const TAP = { x: -186.2, y: -180, fromMachineZ: -3, label: 'the vise fixed-jaw top' };
  const JAW: MountDatum = { jawTopZ: -56.82, measuredAt: '2026-10-23T00:00:00.000Z', by: 'wired-probe' };

  // #640 — the narration names the tap the plan will actually make: the vise's jaw top, or the
  // #607 bracket's seat (which has no mountDatum, so keying the sentence on the datum narrated no
  // tap at all), and the probe the plan uses.
  it('narrates the mount tap: the jaw top for a vise, the seat for a bracket, and the plan’s probe', () => {
    const vise = plan('vise', { mountDatum: JAW, mountTap: TAP, fixtureBelowSurfaceMm: undefined });
    expect(summarizePlan(vise)).toContain('the fixed-jaw top is tapped first and checked against the stored datum (-56.82)');
    expect(summarizePlan(vise)).toContain('fit the wired probe');

    const bracketTap = { ...TAP, reference: 'bracket-seat' as const, label: 'the bracket’s front arm' };
    const bracket = plan('bracket', { mountTap: bracketTap });
    expect(summarizePlan(bracket)).toContain("the bracket's seat beside the arm is tapped first and checked against the stored seat");

    // An xyz plan is narrated with the 3D probe, not the wired one.
    const threeDProbe: ProbeSpec = {
      id: 'p-3d',
      variant: '3d-touch',
      instrument: 'xyz',
      tip: { diameterMm: 3, rimOffsetMm: 1.5, rimOffsetUncertaintyMm: 0.05 },
    };
    const threeD = planRegistration(
      input('vise', { probe: threeDProbe, mountDatum: JAW, mountTap: TAP, fixtureBelowSurfaceMm: undefined }),
      registrationSettings(null, threeDProbe).settings,
    );
    if (!threeD.ok) throw new Error(threeD.reason);
    expect(summarizePlan(threeD.plan)).toContain('fit the 3D probe');
  });

  it('the tap precedes the surface seek and its reading is on the result', async () => {
    const z1 = fakeZ1({ actual: SHIFTED, tap: { x: TAP.x, y: TAP.y, z: JAW.jawTopZ } });
    const p = plan('vise', { mountDatum: JAW, mountTap: TAP, fixtureBelowSurfaceMm: undefined });
    const r = await runRegistration(p, { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);

    const tapIdx = z1.lines.indexOf('G53 G0 X-186.2 Y-180');
    const surfaceIdx = z1.lines.findIndex((l) => /^G0 X/.test(l));
    expect(tapIdx).toBeGreaterThan(-1);
    expect(tapIdx).toBeLessThan(surfaceIdx);
    expect(r.mountTap).toEqual({ z: -56.82, at: { x: TAP.x, y: TAP.y } });
    // The post-tap probe must read open again before the surface seek.
    expect(z1.lines.slice(tapIdx, surfaceIdx)).toContain('M119');
  });

  it('a tap miss stops with the mount named', async () => {
    const z1 = fakeZ1({ actual: SHIFTED });
    const p = plan('vise', { mountDatum: JAW, mountTap: TAP, fixtureBelowSurfaceMm: undefined });
    const r = await runRegistration(p, { console: z1.console, operator: yes });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('no jaw top');
  });

  // #519 item 1 — `ExecDeps.onTouch` is fed each reading AS IT LANDS, in landing order, so the
  // viewport's dots and the dock's table can fill during the run. The seq is the table's row number.
  it('emits every reading as it lands — the tap, the surface, then each scan touch', async () => {
    const z1 = fakeZ1({ actual: SHIFTED, tap: { x: TAP.x, y: TAP.y, z: JAW.jawTopZ } });
    const p = plan('vise', { mountDatum: JAW, mountTap: TAP, fixtureBelowSurfaceMm: undefined });
    const seen: LiveTouch[] = [];
    const r = await runRegistration(p, {
      console: z1.console,
      operator: yes,
      onTouch: (t) => seen.push(t),
    });
    if (!r.ok) throw new Error(r.reason);

    expect(seen.length).toBeGreaterThan(2);
    expect(seen[0]).toMatchObject({
      seq: 1,
      source: 'mount-tap',
      label: TAP.label,
      x: TAP.x,
      y: TAP.y,
      z: JAW.jawTopZ,
      touched: true,
      kind: null,
    });
    expect(seen[1]).toMatchObject({
      seq: 2,
      source: 'surface',
      x: p.surfacePoint.x,
      y: p.surfacePoint.y,
      kind: null,
    });
    expect(seen.slice(2).every((t) => t.source === 'edge')).toBe(true);
    // Numbering is the landing order, with no gaps and no repeats.
    expect(seen.map((t) => t.seq)).toEqual(seen.map((_, i) => i + 1));
  });

  // #615 — with the jaw top known from the datum, the tap descends in two stages: a fast seek to
  // 3 mm above the expected top, then the touch feed for the last 5 mm down to the jawTopZ − 2 floor.
  it('a tap with an expected Z seeks fast, then touches at the touch feed', async () => {
    const z1 = fakeZ1({ actual: SHIFTED, tap: { x: TAP.x, y: TAP.y, z: JAW.jawTopZ } });
    const p = plan('vise', { mountDatum: JAW, mountTap: TAP, fixtureBelowSurfaceMm: undefined });
    const r = await runRegistration(p, { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    const taps = z1.lines.filter((l) => l.startsWith('G38.3 Z-')).slice(0, 2);
    expect(taps).toEqual(['G38.3 Z-50.82 F300', 'G38.3 Z-5 F150']);
  });
});

describe('#525 the 3D probe’s sideways scan, against the fake Z1', () => {
  const PROBE_3D: ProbeSpec = {
    id: 'fx-probe-3d',
    variant: '3d',
    instrument: 'xyz',
    tip: { diameterMm: 3, rimOffsetMm: 1.5, rimOffsetUncertaintyMm: 0.05 },
  };
  const TAP3 = { x: -186.2, y: -180, fromMachineZ: -3, label: 'the vise fixed-jaw top' };
  const JAW3: MountDatum = { jawTopZ: -56.82, measuredAt: '2026-10-23T00:00:00.000Z', by: 'wired-probe' };

  const sidePlan = (): RegistrationPlan => {
    // The plan's settings come from the INSTRUMENT (the 3D probe's ball radius), exactly as the
    // Setups section resolves them (`registrationSettings(defaults, probe)`).
    const instrumentSettings = registrationSettings(null, PROBE_3D).settings;
    const r = planRegistration(
      input('vise', { probe: PROBE_3D, mountDatum: JAW3, mountTap: TAP3, fixtureBelowSurfaceMm: undefined }),
      instrumentSettings,
    );
    if (!r.ok) throw new Error(r.reason);
    return r.plan;
  };

  it('finds the FREE front edge in ONE horizontal touch, and leaves the fixed-jaw edge to the Z scan', async () => {
    const z1 = fakeZ1({ actual: SHIFTED, tap: { x: TAP3.x, y: TAP3.y, z: JAW3.jawTopZ }, ballR: 1.5, rim: 1.5 });
    const p = sidePlan();
    const seen: LiveTouch[] = [];
    const r = await runRegistration(p, { console: z1.console, operator: yes, onTouch: (t) => seen.push(t) });
    if (!r.ok) throw new Error(r.reason);

    // Exactly one sideways line, and it is on Y: a vise's X edges are the jaws' own faces.
    const sideLines = z1.lines.filter((l) => /^G38\.3 [XY]-?[\d.]+ F/.test(l));
    expect(sideLines).toHaveLength(1);
    expect(sideLines[0]).toMatch(/^G38\.3 Y/);

    // The front scan is ONE side reading at the ball's centre; the outcome corrects it to the wall.
    const front = r.data.scans.find((s) => s.scan.edge === 'front')!;
    expect(front.touches).toHaveLength(1);
    expect(front.touches[0]!.sideContact).toBe(true);
    expect(front.touches[0]!.kind).toBe('stock');
    // The left edge still comes from the Z-only scan, so both axes are measured. Its bisection
    // resolves to the plan's fine step (the no-location fallback is 0.5 mm), so the X offset is
    // exact only to ±fineStep/2 — the sideways Y edge is a single exact reading.
    expect(Math.abs(r.outcome.offset.x - 1.2)).toBeLessThanOrEqual(0.13);
    expect(r.outcome.offset.y).toBe(0.8);
    // The live reading (#519) is the sideways one, at the centre the probe reported.
    const live = seen.find((t) => t.source === 'edge' && (t.label ?? '').includes('front'));
    expect(live).toMatchObject({ kind: 'stock', touched: true });
  });
});

describe('#599 the standalone mount tap', () => {
  it('taps the jaw without a datum and returns the reading', async () => {
    const z1 = fakeZ1({ actual: SHIFTED, tap: { x: -186.2, y: -180, z: -56.82 } });
    const r = await runMountTap({ x: -186.2, y: -180 }, -3, S, { console: z1.console, operator: yes }, -100);
    if (!r.ok) throw new Error(r.reason);
    expect(r.z).toBe(-56.82);
    expect(r.at).toEqual({ x: -186.2, y: -180 });
    expect(z1.lines.slice(0, 4)).toEqual(['?', '$H', 'M119', 'M491']);
    expect(z1.lines.at(-1)).toBe('$H');
    // #615 — the standalone tap has no expected Z, so the whole descent stays ONE touch-feed pass.
    expect(z1.lines.filter((l) => l.startsWith('G38.3 Z-'))).toEqual(['G38.3 Z-97 F150']);
  });

  it('a miss stops with the mount named', async () => {
    const z1 = fakeZ1({ actual: SHIFTED });
    const r = await runMountTap({ x: -186.2, y: -180 }, -3, S, { console: z1.console, operator: yes }, -100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('no jaw top');
  });

  it('stops before any move when the probe is not fitted', async () => {
    const z1 = fakeZ1({ actual: SHIFTED, tap: { x: -186.2, y: -180, z: -56.82 } });
    const r = await runMountTap({ x: -186.2, y: -180 }, -3, S, { console: z1.console, operator: async () => false }, -100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('probe was not fitted');
    // #588 — the stop reads the State back (`?`) before deciding nothing more to send.
    expect(z1.lines).toEqual(['?', '$H', '?']);
  });
});

describe('#430 the executor, on a fake machine', () => {
  it('runs the bench’s sequence safely: one command per line, Idle before every probe, XY only at park, never below the cap', async () => {
    const z1 = fakeZ1({ actual: SHIFTED, jaw: true, polls: 2 });
    const r = await runRegistration(plan('vise'), { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);

    expect(z1.lines.slice(0, 6)).toEqual(['?', '$H', 'G54', 'G92.1', 'M119', 'M491']);
    expect(z1.lines.slice(-2)).toEqual(['G53 G0 Z-3', '$H']);
    for (const line of z1.lines) expect(consoleProblem(line), line).toBeNull();
    // `?` reads Idle right before every G38.3.
    z1.lines.forEach((l, i) => {
      if (l.startsWith('G38.3')) expect(z1.lines.slice(0, i).filter((x) => x !== 'G91').at(-1)).toBe('?');
    });
    // Every XY move after the surface happens at the park height (surface + 3), the first at Z −3.
    const park = SURFACE + S.parkAboveSurfaceMm;
    expect(z1.xyMovesAtZ[0]).toBe(-3);
    for (const z of z1.xyMovesAtZ.slice(1)) expect(z).toBeCloseTo(park, 6);
    expect(z1.lowest()).toBeGreaterThanOrEqual(SURFACE - S.capBelowSurfaceMm - 1e-9);

    // #594 — each scan brackets the edge and bisects: it holds both an on and an off touch, and the
    // edge is the closest pair (read by edgeFrom, not a fixed last-two-midpoint shape).
    for (const sc of r.data.scans) {
      expect(sc.touches.some((t) => t.kind === 'stock')).toBe(true);
      expect(sc.touches.some((t) => t.kind !== 'stock')).toBe(true);
    }
    expect(r.data.scans[0]!.touches.some((t) => t.kind === 'below')).toBe(true); // the jaw top
    // #518 — a miss is a reading: nothing is cleared, and the machine was never in alarm.
    expect(z1.lines).not.toContain('$X');
    expect(z1.lines.some((l) => l.startsWith('G38.2'))).toBe(false);
    expect(z1.alarmed()).toBe(false);

    expect(r.outcome.usable).toBe(true);
    expect(Math.abs(r.outcome.offset.x - 1.2)).toBeLessThanOrEqual(S.fineStepMm / 2);
    expect(Math.abs(r.outcome.offset.y - 0.8)).toBeLessThanOrEqual(S.fineStepMm / 2);
    expect(r.outcome.currentG54).toEqual(G54);
    expect(r.outcome.withinMargin).toBe(false);
  });

  it('writes the corrected origin only after confirmation, in #387’s order', async () => {
    const z1 = fakeZ1({ actual: SHIFTED });
    const r = await runRegistration(plan('vise'), { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    expect((await applyCorrection(r.outcome, { console: z1.console, operator: yes }, { confirmed: false })).ok).toBe(false);
    const before = z1.lines.length;
    const applied = await applyCorrection(
      r.outcome,
      { console: z1.console, operator: async (s) => (s.kind === 'fit-cutter' && z1.fitCutter(), true) },
      { confirmed: true },
    );
    if (!applied.ok) throw new Error(applied.reason);
    expect(z1.lines.slice(before)).toEqual(['$H', 'M491', applied.line, '$H']);
    expect(applied.line.endsWith('Z-59.272')).toBe(true);
  });

  it('refuses to write an origin from a measurement that is not whole', async () => {
    // Moved 6 mm left: the left scan starts off the stock; X is not measured.
    const z1 = fakeZ1({ actual: { ...BLANK, xMin: -6, xMax: 32.1 } });
    const r = await runRegistration(plan('vise'), { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    expect(r.outcome.usable).toBe(false);
    expect(summarizeOutcome(r.outcome)).toContain('not usable');
    const n = z1.lines.length;
    const applied = await applyCorrection(r.outcome, { console: z1.console, operator: yes }, { confirmed: true });
    expect(applied.ok).toBe(false);
    expect(z1.lines.length).toBe(n);
  });

  it('a touch that landed somewhere else makes the measurement unusable', async () => {
    const z1 = fakeZ1({ actual: SHIFTED, landShift: 0.3 });
    const r = await runRegistration(plan('vise'), { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    expect(r.outcome.usable).toBe(false);
    expect(r.outcome.problems.join(' ')).toContain('not where it was sent');
    const n = z1.lines.length;
    expect((await applyCorrection(r.outcome, { console: z1.console, operator: yes }, { confirmed: true })).ok).toBe(false);
    expect(z1.lines.length).toBe(n);
  });

  it('#517 a stock below the jaw tops: the jaw reads high, the edge is found there, nothing alarms', async () => {
    const z1 = fakeZ1({ actual: SHIFTED, jawAbove: 1.6 });
    const r = await runRegistration(plan('vise', { fixtureBelowSurfaceMm: -1.6 }), { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    const left = r.data.scans[0]!;
    expect(left.scan.aboveIsEdge).toBe(true);
    expect(left.touches.some((t) => t.kind === 'above')).toBe(true);
    // #594 — the scan brackets and bisects to the jaw's high reading (the edge), like a miss.
    expect(r.outcome.usable).toBe(true);
    expect(r.outcome.problems).toEqual([]);
    expect(Math.abs(r.outcome.offset.x - 1.2)).toBeLessThanOrEqual(S.fineStepMm / 2);
    expect(z1.lines).not.toContain('$X');
    expect(z1.alarmed()).toBe(false);
  });

  it('a clamp above the surface stops its scan and is named', async () => {
    const z1 = fakeZ1({ actual: SHIFTED, clamp: { xMin: 0.4, xMax: 0.6 } });
    const r = await runRegistration(plan('vise'), { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    expect(r.outcome.usable).toBe(false);
    expect(r.outcome.problems.join(' ')).toContain('higher than the stock');
  });

  it('refuses a surface outside the expected band', async () => {
    const z1 = fakeZ1({ actual: SHIFTED, surface: SURFACE + 4 });
    const r = await runRegistration(plan('vise'), { console: z1.console, operator: yes });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('outside the expected');
  });

  it('a rotation beyond the margin is not within it', async () => {
    const z1 = fakeZ1({ actual: SHIFTED });
    const r = await runRegistration(plan('tape'), { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    const turned = computeOutcome(plan('tape'), {
      ...r.data,
      scans: r.data.scans.map((sc, i) => (i === 1 ? { ...sc, touches: sc.touches.map((t) => ({ ...t, at: t.at + 1 })) } : sc)),
    });
    expect(turned.rotationShiftMm).toBeGreaterThan(S.edgeMarginMm);
    expect(turned.withinMargin).toBe(false);
  });

  it('moves nothing on a machine that is not Idle', async () => {
    const z1 = fakeZ1({ actual: BLANK, idle: false });
    const r = await runRegistration(plan('vise'), { console: z1.console, operator: yes });
    expect(r.ok).toBe(false);
    // #588 — nothing moves: only the initial `?` and the stop's own State read back.
    expect(z1.lines).toEqual(['?', '?']);
  });

  it('#599 the probe reading touched at rest stops before any Z move', async () => {
    const z1 = fakeZ1({ actual: SHIFTED, probeTouched: true });
    const r = await runRegistration(plan('vise'), { console: z1.console, operator: yes });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('touched at rest');
    expect(z1.lines).toEqual(['?', '$H', 'G54', 'G92.1', 'M119', '?']);
  });

  it('#448: the recovery sentence names the travel height it was given, not −3', async () => {
    // A machine that reads Alarm from the first `?`: the stop's recovery sentence names the height.
    const alarmed = {
      async send(line: string): Promise<ConsoleSendResult> {
        return { kind: 'sent', line, text: '<Alarm|MPos:0,0,0>', frames: 1, elapsedMs: 1 };
      },
    };
    const r = await runRegistration(plan('vise', { seekFromMachineZ: -10 }), { console: alarmed, operator: yes });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('lift with G53 G0 Z-10 before any XY move');
  });

  it('stops at a failure at ANY step, sends nothing more than a State read and G90', async () => {
    const clean = fakeZ1({ actual: SHIFTED });
    const full = await runRegistration(plan('vise'), { console: clean.console, operator: yes });
    if (!full.ok) throw new Error(full.reason);
    const count = clean.lines.length;
    for (let k = 1; k < count; k++) {
      const z1 = fakeZ1({ actual: SHIFTED });
      let n = 0;
      const flaky = {
        async send(line: string): Promise<ConsoleSendResult> {
          if (n++ === k) return { kind: 'timeout', line, detail: 'no answer', text: '' };
          return z1.console.send(line);
        },
      };
      const r = await runRegistration(plan('vise'), { console: flaky, operator: yes });
      expect(r.ok, `step ${k}`).toBe(false);
      // #588 — a timeout is an unknown state, not an alarm: the stop reads the machine's State, and
      // an Idle answer sends no `$X` and no recovery advice.
      if (!r.ok) expect(r.reason).not.toContain('To recover');
      // After the failing line the only lines are the State read, and in relative mode `G90` — in that order.
      const after = z1.lines.slice(k);
      expect(['?', '?,G90']).toContain(after.join(','));
      // And the machine is never left relative.
      expect(z1.mode(), `step ${k}`).toBe('G90');
    }
  });

  it('a stop on a real alarm during a scan touch unlocks BEFORE G90 — the Z1 refuses G90 in alarm', async () => {
    const z1 = fakeZ1({ actual: SHIFTED });
    let probes = 0;
    const faulty = {
      async send(line: string): Promise<ConsoleSendResult> {
        // The first scan touch — the third probe, after the fast and slow surface seeks — answers a
        // hard-limit alarm, not a miss (#518: a miss is a reading under G38.3 and never alarms); the
        // machine is then alarmed and relative.
        if (line.startsWith('G38.3') && ++probes === 3) {
          z1.lines.push(line);
          z1.alarm(); // the hard limit really does put the controller in Alarm
          return { kind: 'sent', line, text: 'ALARM: Hard limit [Z]\nok', frames: 1, elapsedMs: 1 };
        }
        return z1.console.send(line);
      },
    };
    const r = await runRegistration(plan('vise'), { console: faulty, operator: yes });
    expect(r.ok).toBe(false);
    expect(z1.lines.slice(-2)).toEqual(['$X', 'G90']);
    expect(z1.mode()).toBe('G90');
    expect(z1.alarmed()).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`${S.capBelowSurfaceMm} mm below the surface (a scan touch)`);
  });

  it('#587 narrates each step through onStep', async () => {
    const z1 = fakeZ1({ actual: SHIFTED });
    const steps: string[] = [];
    const r = await runRegistration(plan('vise'), {
      console: z1.console,
      operator: yes,
      onStep: (sentence) => steps.push(sentence),
    });
    expect(r.ok).toBe(true);
    expect(steps.some((s) => s.includes('the surface seek'))).toBe(true);
    expect(steps.some((s) => s.includes('park height'))).toBe(true);
  });

  it('#619 a datum-path surface prouder than the ledge is accepted, and the proud is noted', async () => {
    const DATUM: MountDatum = { jawTopZ: SURFACE - 1.84, measuredAt: '2026-10-23T00:00:00.000Z', by: 'wired-probe' };
    const p = plan('vise', { mountDatum: DATUM, stockThicknessMm: 3.81 });
    // 1.06 mm above the band's ceiling — a blank standing prouder than the ledge estimate, not a miss.
    const z1 = fakeZ1({ actual: SHIFTED, surface: SURFACE + S.surfaceToleranceMm + 1.06 });
    const r = await runRegistration(p, { console: z1.console, operator: yes });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.outcome.notes.some((n) => n.includes('proud'))).toBe(true);
    expect(r.outcome.usable).toBe(true);
  });

  it('#619 a datum-path surface below the jaw top still stops as a miss', async () => {
    const DATUM: MountDatum = { jawTopZ: SURFACE - 1.84, measuredAt: '2026-10-23T00:00:00.000Z', by: 'wired-probe' };
    const p = plan('vise', { mountDatum: DATUM, stockThicknessMm: 3.81 });
    const z1 = fakeZ1({ actual: SHIFTED, surface: DATUM.jawTopZ - S.surfaceToleranceMm - 1 });
    const r = await runRegistration(p, { console: z1.console, operator: yes });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('found nothing down to machine Z');
  });

  it('#518 a scan miss is a reading: no $X follows it; a stop after a TIMEOUT reads the State and sends G90 alone', async () => {
    const z1 = fakeZ1({ actual: SHIFTED });
    const flaky = {
      async send(line: string): Promise<ConsoleSendResult> {
        // The `G90` right after the first scan touch times out: the machine is NOT alarmed, only relative.
        if (line === 'G90' && z1.lines.filter((l) => l.startsWith('G38.3')).length >= 3 && !z1.lines.includes('STOPPED')) {
          z1.lines.push('STOPPED');
          return { kind: 'timeout', line, detail: 'no answer', text: '' };
        }
        return z1.console.send(line);
      },
    };
    const r = await runRegistration(plan('vise'), { console: flaky, operator: yes });
    expect(r.ok).toBe(false);
    // Three probes and their misses went by with no `$X`. The stop's State read answers Idle (the
    // machine is only relative, never alarmed), so it sends `G90` alone — no `$X` on suspicion.
    const stoppedAt = z1.lines.indexOf('STOPPED');
    expect(z1.lines.slice(0, stoppedAt)).not.toContain('$X');
    expect(z1.lines.slice(stoppedAt + 1)).toEqual(['?', 'G90']);
    expect(z1.mode()).toBe('G90');
    expect(z1.alarmed()).toBe(false);
  });

  it('a surface seek that finds nothing says how low the probe may be: the bottom of the band', async () => {
    const z1 = fakeZ1({ actual: { ...BLANK, xMin: 200, xMax: 238 } });
    const r = await runRegistration(plan('vise'), { console: z1.console, operator: yes });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('as low as machine Z -56.572, 0.4 mm below the expected surface');
    // #518 — the seek's miss did not alarm the machine, so the stop sends G90 alone.
    expect(z1.lines.slice(-1)).toEqual(['G90']);
    expect(z1.lines).not.toContain('$X');
    expect(z1.mode()).toBe('G90');
  });

  // #449 review item 4 — a location's settings that cannot make a capped touch send NOTHING: not even
  // the `?`. The refusal is in `runRegistration` itself, not only in the planner.
  it('settings that cannot make a capped slow touch send nothing at all (#449)', async () => {
    for (const bad of [{ surfaceSlowSeekMm: 1 }, { surfaceSlowSeekMm: 2.5 }, { idlePollLimit: 0 }]) {
      const z1 = fakeZ1({ actual: SHIFTED });
      const p = { ...plan('vise'), settings: { ...S, ...bad } };
      const r = await runRegistration(p, { console: z1.console, operator: yes });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) {
        expect(r.reason).toMatch(/^nothing was sent: /);
        expect(r.transcript).toEqual([]);
      }
      expect(z1.lines, JSON.stringify(bad)).toEqual([]);
    }
  });

  // #449 review item 3 — the slow touch says how low it may go, so a stop during it names the depth.
  it('a stop during the slow surface touch says how far below the fast reading the probe may be (#449)', async () => {
    const z1 = fakeZ1({ actual: SHIFTED });
    const cut = {
      async send(line: string): Promise<ConsoleSendResult> {
        if (line.startsWith(`G38.3 Z-${S.surfaceSlowSeekMm} `)) {
          z1.lines.push(line);
          return { kind: 'timeout', line, detail: 'no reply', text: '' };
        }
        return z1.console.send(line);
      },
    };
    const r = await runRegistration(plan('vise'), { console: cut, operator: yes });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`as low as ${S.surfaceSlowSeekMm - 1} mm below the fast touch's reading (the slow surface touch)`);
    // Relative mode at the stop, but the State read answers Idle: `G90` alone, no `$X` on suspicion.
    expect(z1.lines.slice(-2)).toEqual(['?', 'G90']);
    expect(z1.mode()).toBe('G90');
  });

  it('an alarm in the output between lines stops the run', async () => {
    const z1 = fakeZ1({ actual: SHIFTED });
    const noisy = {
      async send(line: string): Promise<ConsoleSendResult> {
        const r = await z1.console.send(line);
        if (line === 'G92.1' && r.kind === 'sent') {
          z1.alarm(); // the hard limit between lines really does put the controller in Alarm
          return { ...r, carried: { text: 'ALARM: Hard limit', frames: 1 } };
        }
        return r;
      },
    };
    const r = await runRegistration(plan('vise'), { console: noisy, operator: yes });
    expect(r.ok).toBe(false);
    expect(z1.lines.slice(-2)).toEqual(['G92.1', '?']);
  });
});

describe('#430 a Z-chain replay of the bench’s own answers (2026-10-15)', () => {
  // The 17:09–17:15 sequence, its real answers: the surface at work (5.95, 6.4) — machine (−174.55,
  // −175.80), fast −56.115, slow −56.116 — the probe's M491 −76.061 and the cutter's −79.158; the bench
  // then wrote G10 L2 P1 X-181.55 Y-184.8 Z-59.213 (a new XY origin, and the Z0 this chain computes).
  const REPLY: Record<string, string[]> = {
    '?': ['<Idle|MPos:-1.0000,-1.0000,-1.0000|WPos:179.5500,183.8000,55.0000>'],
    $H: ['ok'],
    G54: ['ok'],
    'G92.1': ['ok'],
    M119: ['X_max:0 Y_max:0 Z_max:0 A_min:1 Probe: 0'],
    M491: [
      'ok\nM497.3\nok\nG53 G0 Z-3.000\nok\nG53 G0 X-9.890 Y-12.830\nok\nG38.6 Z-108.000 F500.000\n[PRB:-9.890,-12.830,-76.074:1]\nok\nG91 G0 Z1.000\nok\nG38.6 Z-2.000 F100.000\n[PRB:-9.890,-12.830,-76.061:1]\nok\nM493.1\nok\nG53 G0 Z-20.000\nok\nDone ATC',
      'ok\nM497.3\nok\nG53 G0 Z-3.000\nok\nG53 G0 X-9.890 Y-12.830\nok\nG38.6 Z-108.000 F500.000\n[PRB:-9.890,-12.830,-79.168:1]\nok\nG91 G0 Z1.000\nok\nG38.6 Z-2.000 F100.000\n[PRB:-9.890,-12.830,-79.158:1]\nok\nM493.1\nok\nG53 G0 Z-20.000\nok\nDone ATC',
    ],
    FAST: ['[PRB:-174.550,-175.800,-56.115:1]\nok'],
    SLOW: ['[PRB:-174.550,-175.800,-56.116:1]\nok'],
  };
  function replay() {
    const lines: string[] = [];
    const counters: Record<string, number> = {};
    const console = {
      async send(line: string): Promise<ConsoleSendResult> {
        lines.push(line);
        const key = line.startsWith('G38.3 Z-2 ') ? 'SLOW' : line.startsWith('G38.3') ? 'FAST' : line in REPLY ? line : null;
        const list = key ? REPLY[key]! : ['ok'];
        const i = counters[key ?? line] ?? 0;
        counters[key ?? line] = i + 1;
        return { kind: 'sent', line, text: list[Math.min(i, list.length - 1)]!, frames: 1, elapsedMs: 1 };
      },
    };
    return { console, lines };
  }

  it('reproduces the bench’s own origin, byte for byte in value', async () => {
    // The bracket mount: X, Y from the anchor (the bench's own G54), the surface touched at the bench's point.
    // NOT WHAT THE BENCH SENT (#427): the bench moved there in work XY under the G54 then in force,
    // (-180.5, -182.2) + (5.95, 6.4). The bracket path now sends `G53 G0` from the bracket's origin, which
    // the bench never ran on this path, so the surface point is the one that lands on the same machine XY
    // (-174.55, -175.8) from the bracket's origin; the Z readings, and so the written line, are the bench's.
    const p = plan('bracket', {
      cutCentre: { x: 7, y: 9 },
      expectedSurface: { machineZ: -56.1, from: 'the bench' },
      bracketOrigin: { x: -181.55, y: -184.8, from: 'the bench’s G54', offsetMeasured: true },
    });
    const z1 = replay();
    const r = await runRegistration(p, { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    expect(r.outcome.surfaceZ).toBe(-56.116);
    expect(r.outcome.probeRefZ).toBe(-76.061);
    expect(z1.lines).toContain('G53 G0 X-174.55 Y-175.8');
    expect(r.outcome.usable).toBe(true);
    // Nothing was sent in the G54 in force, so none is reported; XY is the bracket's, not checked.
    expect(r.outcome.currentG54).toBeNull();
    expect(r.outcome.xyChecked).toBe(false);
    const applied = await applyCorrection(r.outcome, { console: z1.console, operator: yes }, { confirmed: true });
    if (!applied.ok) throw new Error(applied.reason);
    expect(applied.cutterRefZ).toBe(-79.158);
    expect(applied.line).toBe('G10 L2 P1 X-181.550 Y-184.800 Z-59.213');
    expect(applied.line).toBe(correctionLine(r.outcome, -79.158));
  });

  // #432 slice 4, decision 4: probe → face → re-touch → engrave. The re-touch is a MEASUREMENT of the
  // faced top, so the written Z0 is the measured surface, never the first reading minus the depth.
  /** A console that answers only a re-touch: idle, homes, and a surface reading at `surfaceZ`. */
  function retouchZ1(surfaceZ: number) {
    const lines: string[] = [];
    const console = {
      async send(line: string): Promise<ConsoleSendResult> {
        lines.push(line);
        let text = 'ok';
        if (line === '?') text = '<Idle|MPos:-1.0000,-1.0000,-1.0000|WPos:179.5500,183.8000,55.0000>';
        else if (line === 'M491') text = 'ok\nM497.3\nok\nG38.6 Z-108.000 F500.000\n[PRB:-9.890,-12.830,-79.158:1]\nok\nDone ATC';
        else if (line.startsWith('G38.3 Z-2 ')) text = `[PRB:-174.550,-175.800,${surfaceZ.toFixed(3)}:1]\nok`;
        else if (line.startsWith('G38.3')) text = `[PRB:-174.550,-175.800,${(surfaceZ + 0.001).toFixed(3)}:1]\nok`;
        return { kind: 'sent', line, text, frames: 1, elapsedMs: 1 };
      },
    };
    return { console, lines };
  }
  async function registered() {
    const p = plan('bracket', {
      cutCentre: { x: 7, y: 9 },
      expectedSurface: { machineZ: -56.1, from: 'the bench' },
      bracketOrigin: { x: -181.55, y: -184.8, from: 'the bench’s G54', offsetMeasured: true },
    });
    const r = await runRegistration(p, { console: replay().console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    return { p, outcome: r.outcome };
  }

  it('writes the MEASURED faced surface, 0.05 mm off the skim’s expectation', async () => {
    const { p, outcome } = await registered();
    // The first probe read −56.116; the skim was posted to take 0.5 mm, so the top is expected at
    // −56.616. It measured −56.666 — 0.05 mm deeper than asked, which is the whole reason for a touch.
    const z1 = retouchZ1(-56.666);
    const rt = await retouchSurface(p, outcome, { removedMm: 0.5, toleranceMm: 0.25 }, { console: z1.console, operator: yes });
    if (!rt.ok) throw new Error(rt.reason);
    expect(rt.surface.z).toBe(-56.666);
    // The seek's fast touch travels to the BAND's floor (expected − tolerance), not the first run's.
    // From the travel height −3 down to the band's floor −56.866, not the first run's −56.422.
    expect(z1.lines).toContain('G38.3 Z-53.866 F300');
    expect(rt.outcome.surfaceZ).toBe(-56.666);
    const applied = await applyCorrection(rt.outcome, { console: z1.console, operator: yes }, { confirmed: true });
    if (!applied.ok) throw new Error(applied.reason);
    // −56.666 + (−79.158 − −76.061) = −59.763: the measurement, not the nominal −56.616's −59.713.
    expect(applied.line).toBe('G10 L2 P1 X-181.550 Y-184.800 Z-59.763');
    expect(applied.line).toBe(correctionLine(rt.outcome, -79.158));
    expect(z1.lines).toContain('G10 L2 P1 X-181.550 Y-184.800 Z-59.763');
  });

  it('refuses a re-touch that lands outside the band the skim set', async () => {
    const { p, outcome } = await registered();
    // Expected −56.616 ± 0.25; a reading of −57.2 means the top is not where this skim could have
    // left it — the facing pass did not run, or did not remove what it was posted to.
    const z1 = retouchZ1(-57.2);
    const rt = await retouchSurface(p, outcome, { removedMm: 0.5, toleranceMm: 0.25 }, { console: z1.console, operator: yes });
    expect(rt.ok).toBe(false);
    if (rt.ok) return;
    expect(rt.reason).toContain('outside the expected -56.866 to -56.366');
    expect(z1.lines.some((l) => l.startsWith('G10 L2'))).toBe(false);
  });

  it('refuses a re-touch with no depth to expect, before it sends anything', async () => {
    const { p, outcome } = await registered();
    const z1 = retouchZ1(-56.666);
    const rt = await retouchSurface(p, outcome, { removedMm: 0, toleranceMm: 0.25 }, { console: z1.console, operator: yes });
    expect(rt.ok).toBe(false);
    expect(z1.lines).toEqual([]);
  });

  // #473 — THE RUN ORDER'S MIDDLE, as one executor: the face program has finished, so the top is
  // measured and the origin written for the ENGRAVING cutter before its program runs. The two steps
  // are not called side by side by a caller that could swap them: this is the order.
  const DEFAULTS = ShopDefaultsSchema.parse(DOC.defaults);

  it('re-touches the measured top, then writes the origin for the ENGRAVING cutter', async () => {
    const { p, outcome } = await registered();
    const z1 = retouchZ1(-56.666);
    const asked: string[] = [];
    const operator = async (step: { kind: string; text: string }) => (asked.push(`${step.kind}: ${step.text}`), true);

    const r = await retouchAndCorrectAfterFacing(
      p,
      outcome,
      { removedMm: 0.5, defaults: DEFAULTS, engravingCutter: 'flat-1.0' },
      { console: z1.console, operator },
      { confirmed: true },
    );
    if (!r.ok) throw new Error(r.reason);

    // The write is from the MEASUREMENT (−56.666), not the skim's nominal −56.616.
    expect(r.surface.z).toBe(-56.666);
    expect(r.outcome.surfaceZ).toBe(-56.666);
    expect(r.correction).toBe('G10 L2 P1 X-181.550 Y-184.800 Z-59.763');

    // Probe in first, engraving cutter second — and the fit sentence sends the facing cutter back out.
    expect(asked.map((s) => s.split(':')[0])).toEqual(['fit-probe', 'fit-cutter']);
    expect(asked[0]).toContain('faced top');
    expect(asked[1]).toContain('fit the ENGRAVING cutter — flat-1.0 — not the facing cutter');

    // The measurement happens before anything writes an origin, and the G10 write is last.
    const g10 = z1.lines.findIndex((l) => l.startsWith('G10 L2'));
    const touch = z1.lines.findIndex((l) => l.startsWith('G38.3 Z-2 '));
    expect(touch).toBeGreaterThan(-1);
    expect(g10).toBeGreaterThan(touch);
    expect(z1.lines.filter((l) => l.startsWith('G10 L2'))).toHaveLength(1);
    expect(z1.lines.slice(g10 + 1)).toEqual(['$H']);

    // The transcript is the two conversations' lines, in the order they were sent.
    expect(r.transcript.map((t) => t.line)).toEqual(z1.lines);
  });

  it('takes the re-touch band from the shop seed, not a constant', async () => {
    const { p, outcome } = await registered();
    // Expected −56.616. −56.75 is 0.134 mm deeper — outside the seeded ±0.1, inside ±0.25.
    const narrow = retouchZ1(-56.75);
    const denied = await retouchAndCorrectAfterFacing(
      p,
      outcome,
      { removedMm: 0.5, defaults: DEFAULTS, engravingCutter: 'flat-1.0' },
      { console: narrow.console, operator: yes },
      { confirmed: true },
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.step).toBe('re-touch');
    expect(denied.reason).toContain('outside the expected -56.716 to -56.516');
    expect(narrow.lines.some((l) => l.startsWith('G10 L2'))).toBe(false);

    // The same reading is accepted when the location's own key says the band is 0.25.
    const wider = structuredClone(DEFAULTS);
    wider['facing.retouchToleranceMm'] = { ...wider['facing.retouchToleranceMm']!, value: 0.25 };
    const wide = retouchZ1(-56.75);
    const accepted = await retouchAndCorrectAfterFacing(
      p,
      outcome,
      { removedMm: 0.5, defaults: wider, engravingCutter: 'flat-1.0' },
      { console: wide.console, operator: yes },
      { confirmed: true },
    );
    if (!accepted.ok) throw new Error(accepted.reason);
    expect(accepted.surface.z).toBe(-56.75);
    expect(accepted.correction).toBe('G10 L2 P1 X-181.550 Y-184.800 Z-59.847');
  });

  it('measures before asking for consent, and writes nothing when it is not given', async () => {
    const { p, outcome } = await registered();
    const z1 = retouchZ1(-56.666);
    const r = await retouchAndCorrectAfterFacing(
      p,
      outcome,
      { removedMm: 0.5, defaults: DEFAULTS, engravingCutter: 'flat-1.0' },
      { console: z1.console, operator: yes },
      { confirmed: false },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.step).toBe('correction');
    // The re-touch ran and measured; the origin was not written.
    expect(r.transcript.some((t) => t.line.startsWith('G38.3 Z-2 '))).toBe(true);
    expect(z1.lines.some((l) => l.startsWith('G10 L2'))).toBe(false);
  });
});

describe('#427 the bracket: XY from the datum, an optional confirming touch', () => {
  const SEATED = { ...BLANK };
  /** A clamp on the back edge, 15 mm in from the left-hand corner, 12 mm above the stock. */
  const CLAMP = { kind: 'clamp' as const, label: 'the clamp on the back edge, 15 mm in from the left-hand corner', min: [12, 68] as [number, number], max: [27, 98] as [number, number], topZ: 12 };
  const ARM = { kind: 'bracket' as const, label: 'the bracket’s left arm', min: [-10, -10] as [number, number], max: [0, 100] as [number, number], topZ: 5 };
  const confirm = (over: Partial<PlanInput> = {}) => plan('bracket', { bracketConfirm: true, mountObstacles: [CLAMP, ARM], ...over });
  const asked: string[] = [];
  const operator = async (step: { kind: string; text: string }) => (asked.push(`${step.kind}: ${step.text}`), true);

  it('without the confirm: no scan, the surface touch sent from the bracket’s origin — and XY reported as NOT checked', async () => {
    const p = plan('bracket');
    expect(p.scans).toEqual([]);
    const z1 = fakeZ1({ actual: SEATED });
    const r = await runRegistration(p, { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    expect(z1.lines).toContain('G53 G0 X-162.5 Y-146.7');
    expect(z1.lines.some((l) => /^G0 X/.test(l))).toBe(false);
    expect(r.outcome).toMatchObject({ correctedG54: G54, currentG54: null, xyChecked: false, withinMargin: false, usable: true });
    expect(r.outcome.bracketCheck).toBeUndefined();
    expect(summarizeOutcome(r.outcome)).toContain('NOT checked');
    expect(summarizeOutcome(r.outcome)).not.toContain('confirmed');
  });

  it('a stale G54 several mm off the bracket changes nothing: the touches land on the stock and the bracket’s origin is written', async () => {
    const p = confirm();
    const z1 = fakeZ1({ actual: SEATED, g54: { x: G54.x + 6, y: G54.y - 4 } });
    const r = await runRegistration(p, { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    expect(r.outcome.usable).toBe(true);
    const applied = await applyCorrection(r.outcome, { console: z1.console, operator: yes }, { confirmed: true });
    expect(applied.ok && applied.line).toMatch(/^G10 L2 P1 X-181\.550 Y-184\.800 /);
  });

  it('the bracket’s offset unmeasured: the confirming touch is required', () => {
    const unmeasured = { x: G54.x, y: G54.y, from: 'anchor 1 + a default offset', offsetMeasured: false };
    expect(planRegistration(input('bracket', { bracketOrigin: unmeasured }), S)).toMatchObject({ ok: false, reason: expect.stringContaining('confirming touch is required') });
    expect(planRegistration(input('bracket', { bracketOrigin: unmeasured, bracketConfirm: true }), S)).toMatchObject({ ok: true });
  });

  it('refuses without the mount’s obstacles, with a top at the travel height, or with the surface point under a clamp', () => {
    expect(planRegistration(input('bracket', { mountObstacles: undefined }), S)).toMatchObject({ ok: false });
    // The stock's top at −56.17: a clamp 53 mm above it reaches machine Z −3.
    expect(planRegistration(input('bracket', { mountObstacles: [{ ...CLAMP, topZ: 53 }] }), S)).toMatchObject({ ok: false, reason: expect.stringContaining('travel height') });
    const over = { ...CLAMP, min: [15, 30] as [number, number], max: [25, 45] as [number, number] };
    expect(planRegistration(input('bracket', { mountObstacles: [over] }), S)).toMatchObject({ ok: false, reason: expect.stringContaining('surface touch point') });
  });

  it('#448: the seek and the obstacle bound are the travel height the caller gave, not −3', () => {
    // The seek starts at the machine's travel height and the band is unchanged, so the travel follows it.
    expect(plan('vise', { seekFromMachineZ: -10 }).seek).toEqual({
      fromMachineZ: -10,
      travelMm: 46.572,
      band: { min: -56.572, max: -55.772 },
    });
    // A clamp standing to machine Z −8.17 clears −3, but from −10 the probe would be driven into it.
    const clamp = { ...CLAMP, topZ: 48 };
    expect(planRegistration(input('bracket', { mountObstacles: [clamp] }), S).ok).toBe(true);
    expect(planRegistration(input('bracket', { seekFromMachineZ: -10, mountObstacles: [clamp] }), S)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('machine Z -10'),
    });
    // A height that is not a number is refused before any of it.
    expect(planRegistration(input('vise', { seekFromMachineZ: Number.NaN }), S)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('travel height is not known'),
    });
  });

  it('the confirm scans the RIGHT and BACK edges — the arms are on the left and front — clear of the clamps', () => {
    const open = plan('bracket', { bracketConfirm: true });
    expect(open.scans.map((s) => [s.edge, s.along])).toEqual([
      ['right', 38.1],
      ['back', 19.05],
    ]);
    const p = confirm();
    const back = p.scans.find((s) => s.edge === 'back')!;
    const grow = S.tipRadiusMm + S.cornerClearanceMm;
    expect(back.along < CLAMP.min[0] - grow || back.along > CLAMP.max[0] + grow).toBe(true);
    expect(back.along).toBeGreaterThan(ARM.max[0] + grow);
    // The plan names the clamps it assumes.
    expect(summarizePlan(p)).toContain('It assumes the clamp on the back edge, 15 mm in from the left-hand corner');
    const wall = { ...CLAMP, min: [-5, 70] as [number, number], max: [45, 90] as [number, number] };
    expect(planRegistration(input('bracket', { bracketConfirm: true, mountObstacles: [wall] }), S)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('register without the confirming touch'),
    });
  });

  it('the operator confirms the clamps before anything moves sideways; a no stops it', async () => {
    asked.length = 0;
    const z1 = fakeZ1({ actual: SEATED });
    const r = await runRegistration(confirm(), { console: z1.console, operator });
    expect(r.ok).toBe(true);
    expect(asked[1]).toContain('confirm-mount: Check the clamps before the probe moves: the plan assumes the clamp on the back edge');
    const z2 = fakeZ1({ actual: SEATED });
    const no = await runRegistration(confirm(), { console: z2.console, operator: async (st) => st.kind !== 'confirm-mount' });
    expect(no).toMatchObject({ ok: false, reason: expect.stringContaining('clamps were not confirmed') });
    expect(z2.lines.some((l) => /^G53 G0 X/.test(l))).toBe(false);
  });

  it('every scan starts at the seek height and every other scan move is at the park height', async () => {
    const p = confirm();
    const z1 = fakeZ1({ actual: SEATED });
    const r = await runRegistration(p, { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    const parkZ = r.data.surface.z + S.parkAboveSurfaceMm;
    // XY moves: the surface point, then each scan's touches in order.
    let i = 1;
    for (const sc of r.data.scans) {
      sc.touches.forEach((_, k) => {
        if (k === 0) expect(z1.xyMovesAtZ[i]).toBe(-3);
        else expect(z1.xyMovesAtZ[i]).toBeCloseTo(parkZ, 3);
        i++;
      });
    }
    expect(i).toBe(z1.xyMovesAtZ.length);
    // A surface touch that did not land where it was sent is caught.
    const moved = computeOutcome(plan('bracket'), { ...r.data, scans: [], surface: { ...r.data.surface, x: r.data.surface.x + 1 } });
    expect(moved.problems.join(' ')).toContain('not at');
  });

  it('a seated stock confirms; the origin stays the bracket’s', async () => {
    const z1 = fakeZ1({ actual: SEATED });
    const r = await runRegistration(confirm(), { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    expect(r.outcome).toMatchObject({ usable: true, xyChecked: true, withinMargin: true, correctedG54: G54 });
    expect(Math.abs(r.outcome.bracketCheck!.x!)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(r.outcome.bracketCheck!.y!)).toBeLessThanOrEqual(0.3);
    expect(summarizeOutcome(r.outcome)).toContain('from the bracket');
  });

  it('a stock not pushed into the corner is caught, and no origin is written', async () => {
    const off = { ...SEATED, xMin: 1.5, xMax: 39.6 };
    const z1 = fakeZ1({ actual: off });
    const r = await runRegistration(confirm(), { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    expect(r.outcome.usable).toBe(false);
    expect(r.outcome.problems.join(' ')).toContain('push the stock into the bracket’s corner');
    const applied = await applyCorrection(r.outcome, { console: z1.console, operator: yes }, { confirmed: true });
    expect(applied.ok).toBe(false);
  });
});
