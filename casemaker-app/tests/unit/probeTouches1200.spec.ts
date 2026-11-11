// #1200 — A PROBE UNIT THE OPERATOR RESTRICTED TO TOP TOUCHES PLANS NO SIDEWAYS SEEK.
//
// The maintainer at the bench, 2026-11-10, with the repaired Makera 3D probe in the spindle: "Use
// it as a touch probe, not 3d with side touches, the ball tip may not be 100% straight down." The
// restriction is the unit's own field (`touches: 'z-only' | 'all'`); the 3D instrument is
// unchanged (its stylus is still released before any rapid, its M491 reference still applies).
//
// Red first: every assertion here fails before the field exists — the dispatch ignores it and the
// fake console sees sideways `G38.3 X/Y` lines on a unit the operator restricted.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import type { ConsoleSendResult, ConsoleTiming } from '@/platform/machineConsole';
import {
  planRegistration,
  registrationSettings,
  runRegistration,
  type ExpectedStock,
  type MountDatum,
  type PlanInput,
  type RegistrationPlan,
} from '@/engine/cnc/registration';
import type { ProbeSpec } from '@/engine/cnc/registration/plan';
import { sideTouchSelected } from '@/engine/cnc/registration/probe3d';
import { probeFor } from '@/engine/cnc/registration/mountContext';
import { useLocationStore } from '@/store/locationStore';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown };

const BLANK: ExpectedStock = { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 };
const SURFACE = -56.172;
const G54 = { x: -181.55, y: -184.8 };
const JAW: MountDatum = { jawTopZ: SURFACE - 0.72, measuredAt: '2026-10-23T00:00:00.000Z', by: 'fx-probe-3d' };

/** The repaired 3D unit, as the house records it: a 3 mm ball. */
const PROBE_3D: ProbeSpec = {
  id: 'fx-probe-3d',
  variant: '3d',
  instrument: 'xyz',
  tip: { diameterMm: 3, rimOffsetMm: 1.5, rimOffsetUncertaintyMm: 0.05 },
};

const RESTRICTED: ProbeSpec = { ...PROBE_3D, touches: 'z-only', tipLateralUncertaintyMm: 1 };
const UNRESTRICTED: ProbeSpec = { ...PROBE_3D, touches: 'all' };

function settingsFor(probe: ProbeSpec) {
  return registrationSettings(ShopDefaultsSchema.parse(DOC.defaults), probe).settings;
}

function input(mount: 'vise' | 'tape' | 'bracket', over: Partial<PlanInput> = {}): PlanInput {
  return {
    stock: BLANK,
    mount,
    expectedSurface: { machineZ: SURFACE, from: 'test' },
    seekFromMachineZ: -3,
    fixtureBelowSurfaceMm: mount === 'vise' ? 0.72 : undefined,
    ...(mount === 'bracket'
      ? { bracketOrigin: { x: G54.x, y: G54.y, from: 'the test anchor', offsetMeasured: true }, mountObstacles: [] }
      : {}),
    ...over,
  };
}

function plan(mount: 'vise' | 'tape' | 'bracket', probe: ProbeSpec, over: Partial<PlanInput> = {}): RegistrationPlan {
  const r = planRegistration({ ...input(mount, over), probe }, settingsFor(probe));
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
}

interface Box {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** The bench Z1 fake of #1133's spec: Z touches and sideways ball contacts, modelled. */
function fakeZ1(opts: { actual: ExpectedStock; surface?: number; ballR?: number; rim?: number }) {
  const a = opts.actual;
  const surface = opts.surface ?? SURFACE;
  const RIM = opts.rim ?? 1.5;
  const ballR = opts.ballR ?? RIM;
  let mode: 'G90' | 'G91' = 'G90';
  const pos = { x: G54.x, y: G54.y, z: -3 };
  const lines: string[] = [];
  const reply = (text: string): ConsoleSendResult => ({ kind: 'sent', line: '', text, frames: 1, elapsedMs: 1 });
  const inBox = (x: number, y: number, b: Box, margin: number) =>
    x >= b.xMin - margin && x <= b.xMax + margin && y >= b.yMin - margin && y <= b.yMax + margin;
  const zAt = (wx: number, wy: number): number | null => (inBox(wx, wy, a, RIM) ? surface : null);
  const console = {
    async send(line: string, _timing?: Partial<ConsoleTiming>): Promise<ConsoleSendResult> {
      lines.push(line);
      if (line === '?') return reply('<Idle|MPos:0,0,0>');
      if (line === '$X') return reply('ok');
      if (['$H', 'G54', 'G92.1'].includes(line) || /^G10 L2 P1 /.test(line)) return reply('ok');
      if (line === 'M831' || line === 'M832') return reply('ok');
      if (line === 'M119') return reply('X_max:0 Y_max:0 Z_max:0 Probe: 0');
      if (line === 'M491') return reply('[PRB:-9.890,-12.830,-76.063:1]\nok\n[PRB:-9.890,-12.830,-76.063:1]\nDone ATC');
      if (line === 'G90' || line === 'G91') return (mode = line), reply('ok');
      let m = /^G53 G0 Z(-?[\d.]+)$/.exec(line);
      if (m) return (pos.z = Number(m[1])), reply('ok');
      m = /^G53 G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(line);
      if (m) return (pos.x = Number(m[1])), (pos.y = Number(m[2])), reply('ok');
      m = /^G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(line);
      if (m) {
        if (mode === 'G90') {
          pos.x = Number(m[1]) + G54.x;
          pos.y = Number(m[2]) + G54.y;
        } else {
          pos.x += Number(m[1]);
          pos.y += Number(m[2]);
        }
        return reply('ok');
      }
      m = /^G0 Z(-?[\d.]+)$/.exec(line);
      if (m) return (pos.z += Number(m[1])), reply('ok');
      m = /^G38\.3 Z-([\d.]+) F[\d.]+$/.exec(line);
      if (m) {
        const target = pos.z - Number(m[1]);
        const hit = zAt(pos.x - G54.x, pos.y - G54.y);
        if (hit !== null && hit >= target && hit <= pos.z) {
          pos.z = hit;
          return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${hit.toFixed(3)}:1]\nok`);
        }
        pos.z = target;
        return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${target.toFixed(3)}:0]\nok`);
      }
      m = /^G38\.3 ([XY])(-?[\d.]+) F[\d.]+$/.exec(line);
      if (m) {
        const axis = m[1] === 'X' ? ('x' as const) : ('y' as const);
        const travel = Number(m[2]);
        const start = pos[axis];
        const workStart = start - (axis === 'x' ? G54.x : G54.y);
        const lo = axis === 'x' ? a.xMin : a.yMin;
        const hi = axis === 'x' ? a.xMax : a.yMax;
        const across = axis === 'x' ? pos.y - G54.y : pos.x - G54.x;
        const acrossLo = axis === 'x' ? a.yMin : a.xMin;
        const acrossHi = axis === 'x' ? a.yMax : a.xMax;
        const depth = surface - pos.z;
        const off = depth >= ballR ? ballR : Math.sqrt(Math.max(0, ballR * ballR - depth * depth));
        const overStock = pos.z < surface && across >= acrossLo - ballR && across <= acrossHi + ballR;
        const low = lo - off;
        const high = hi + off;
        const hits = overStock && (travel > 0 ? workStart < low && workStart + travel >= low : workStart > high && workStart + travel <= high);
        pos[axis] = hits ? (travel > 0 ? low : high) + (axis === 'x' ? G54.x : G54.y) : start + travel;
        return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}:${hits ? 1 : 0}]\nok`);
      }
      if (/^G38\.5 [XYZ]-?[\d.]+ F[\d.]+$/.test(line)) return reply('ok');
      return reply('ok');
    },
  };
  return { console, lines };
}

const yes = async () => true;

describe('#1200 the unit’s default and the stored decision', () => {
  const machine = {
    id: 'm-1200',
    profileId: 'Z1',
    address: { host: '192.0.2.10', port: 2222 },
    bedProfiles: [],
    activeBedProfileId: null,
    history: [],
    notes: [],
    observedAt: '2026-11-10T00:00:00.000Z',
  };
  const probe = (over: Record<string, unknown>) => ({
    id: 'fx-probe-3d',
    kind: 'probe',
    product: 'Makera 3D Wired Probe',
    variant: '3d',
    unit: { tipDiameterMm: 3, rimOffsetMm: 1.5, rimOffsetUncertaintyMm: 0.05, tipLateralUncertaintyMm: 1 },
    provenance: {},
    history: [],
    whereabouts: { kind: 'machine', machineId: 'm-1200', since: '2026-11-10T00:00:00.000Z' },
    ...over,
  });
  const seed = (accessory: Record<string, unknown>): void => {
    useLocationStore.setState({
      location: { machines: [machine], accessories: [accessory] } as unknown as NonNullable<
        ReturnType<typeof useLocationStore.getState>['location']
      >,
    });
  };

  it('a 3D variant defaults to all; the wired V2 defaults to z-only; a stored value wins', () => {
    seed(probe({}));
    expect(probeFor(machine as never)?.touches).toBe('all');
    expect(probeFor(machine as never)?.tipLateralUncertaintyMm).toBe(1);
    // #1203 — the fitted shank rides the same read; an unrecorded one is null (the prompts say
    // to check the collet).
    seed(probe({ unit: { tipDiameterMm: 3, rimOffsetMm: 1.5, rimOffsetUncertaintyMm: 0.05, shankMm: 6 } }));
    expect(probeFor(machine as never)?.shankMm).toBe(6);
    seed(probe({}));
    expect(probeFor(machine as never)?.shankMm).toBeNull();

    seed(probe({ variant: 'wired-touch' }));
    expect(probeFor(machine as never)?.touches).toBe('z-only');

    seed(probe({ touches: 'z-only' }));
    expect(probeFor(machine as never)?.touches).toBe('z-only');

    // An explicit 'all' is the operator's own decision and wins over the variant's default: the
    // wired probe CAN side-touch (#1133, bench-tested), it is the default that keeps it off.
    seed(probe({ touches: 'all', variant: 'wired-touch' }));
    expect(probeFor(machine as never)?.touches).toBe('all');
  });
});

describe('#1200 a probe restricted to top touches plans no sideways seek', () => {
  it('tape: every edge keeps the Z-only scan, the plan carries the restriction, and the note says why', () => {
    const p = plan('tape', RESTRICTED);
    expect(p.probe?.touches).toBe('z-only');
    expect(p.scans.length).toBeGreaterThan(0);
    for (const scan of p.scans) expect(sideTouchSelected(p, scan.edge)).toBe(false);
    // What was planned INSTEAD is stated, naming the edges the free mount would have side-touched.
    expect(p.notes.join(' ')).toContain('restricted to top touches');
    expect(p.notes.join(' ')).toContain('found by stepping Z over');
    // The manager's note: a restricted 3D unit is a first-run path, and the plan says so.
    expect(p.notes.join(' ')).toContain('first run and stays under the first-run guard');
  });

  it('a datum’d vise: the free front edge is not side-touched on a restricted unit', () => {
    const p = plan('vise', RESTRICTED, { mountDatum: JAW, fixtureBelowSurfaceMm: undefined });
    expect(p.probe?.touches).toBe('z-only');
    expect(p.scans.some((sc) => sc.edge === 'front')).toBe(true);
    expect(sideTouchSelected(p, 'front')).toBe(false);
    expect(p.notes.join(' ')).toContain('the front edge is found by stepping Z over it');
  });

  it('bracket: a top-only plan keeps its single surface touch and states the restriction', () => {
    const p = plan('bracket', RESTRICTED);
    expect(p.probe?.touches).toBe('z-only');
    for (const scan of p.scans) expect(sideTouchSelected(p, scan.edge)).toBe(false);
  });

  it('THE EMITTED LINES: a restricted tape run has no sideways G38.3 at all, and still touches top-down', async () => {
    const p = plan('tape', RESTRICTED);
    const z1 = fakeZ1({ actual: BLANK, ballR: 1.5, rim: 1.5 });
    const r = await runRegistration(p, { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    const side = z1.lines.filter((l) => /^G38\.3 [XY]/.test(l));
    expect(side, 'no sideways G38.3 on a top-touches-only unit').toEqual([]);
    expect(z1.lines.some((l) => /^G38\.3 Z-/.test(l))).toBe(true);
    expect(r.outcome.problems).toEqual([]);
    expect(r.outcome.usable).toBe(true);
  });

  it('lifting the restriction restores the sideways plan (today’s, byte for byte)', async () => {
    const p = plan('tape', UNRESTRICTED);
    expect(p.probe?.touches).toBe('all');
    expect(p.scans.every((sc) => sideTouchSelected(p, sc.edge))).toBe(true);
    expect(p.notes.join(' ')).not.toContain('restricted to top touches');
    expect(p.notes.join(' ')).not.toContain('first-run guard');
    const z1 = fakeZ1({ actual: BLANK, ballR: 1.5, rim: 1.5 });
    const r = await runRegistration(p, { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    expect(z1.lines.filter((l) => /^G38\.3 [XY]-?[\d.]+ F/.test(l))).toHaveLength(p.scans.length);
  });

  // #1203 — the runtime prompt names the collet the fitted post needs; the same fake captures it.
  it('#1203 — the fit-probe prompt names the collet from the unit’s shank', async () => {
    const wired = { ...PROBE_3D, variant: 'wired-touch', instrument: 'z-only' as const, touches: 'z-only' as const, shankMm: 6 };
    const p = plan('tape', wired);
    const z1 = fakeZ1({ actual: BLANK, ballR: 1.5, rim: 1.5 });
    const prompts: string[] = [];
    const r = await runRegistration(p, {
      console: z1.console,
      operator: async (step) => {
        prompts.push(step.text);
        return true;
      },
    });
    if (!r.ok) throw new Error(r.reason);
    expect(prompts.some((text) => text.includes('Fit the wired probe in the spindle — 6 mm collet'))).toBe(true);
  });

  it('a top touch keeps the unit’s lateral uncertainty plus the tip radius clear of every edge', () => {
    // A 20 × 20 blank: a cut centre 2 mm from its left edge. The ball (1.5) + the stated 1 mm
    // uncertainty demands 2.5 mm clear — the plan refuses, naming the number.
    const stock: ExpectedStock = { xMin: 0, yMin: 0, xMax: 20, yMax: 20, cornerRadius: 0 };
    const r = planRegistration(
      {
        ...input('tape'),
        stock,
        cutCentre: { x: 2, y: 10 },
        probe: RESTRICTED,
      },
      settingsFor(RESTRICTED),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('2.5 mm');
      expect(r.reason).toContain('lateral uncertainty');
    }
    // The stock's own centre is clear of the floor, so the ordinary plan still succeeds.
    const centred = planRegistration({ ...input('tape'), stock, probe: RESTRICTED }, settingsFor(RESTRICTED));
    expect(centred.ok).toBe(true);
  });
});
