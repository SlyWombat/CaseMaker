// #1133 part 2 — THE EDGE-FIND BAND, against a FAKE machine. Nothing here reaches a controller.
//
// The maintainer (2026-11-09): "if it was looking for the edge, it should not have been near the
// holes." An edge find stays inside a narrow band around the EXPECTED edge — the stock's own size
// error, the mount's repeat (0.05 mm) and fit (0.1 mm), plus margin (`registration.edgeBandMm`,
// 4 mm) — approaches from OUTSIDE the stock and stops at the first touch. It never walks inward
// over the stock, where bores, pockets and clamps are.
//
// The acceptance pair, as the issue states it: a stock with a bore near the edge measures its edge
// (the bore is not the edge) with every probe path inside the band; and a seek that misses inside
// the band refuses BY NAME and writes no origin.
//
// MOUNT: the issue's words name a BRACKET job, but after #1133 part 1 a bracket hold plans ONE top
// touch and no edge scans at all (the bracket fixes X, Y and rotation from its anchor) — there is
// no edge find left to test there. The acceptance therefore runs on TAPE, where every edge is still
// found, with the bore inside the stock near its front edge — the bench story the rule answers.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import type { ConsoleSendResult, ConsoleTiming } from '@/platform/machineConsole';
import {
  applyCorrection,
  planRegistration,
  registrationSettings,
  runRegistration,
  summarizePlan,
  type ExpectedStock,
  type MountDatum,
  type PlanInput,
  type RegistrationPlan,
} from '@/engine/cnc/registration';
import type { ProbeSpec } from '@/engine/cnc/registration/plan';
import { sideTouchSelected } from '@/engine/cnc/registration/probe3d';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown };
const { settings: S } = registrationSettings(ShopDefaultsSchema.parse(DOC.defaults));

/** The badge blank, origin at its front-left corner. */
const BLANK: ExpectedStock = { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 };
const SURFACE = -56.172;
const G54 = { x: -181.55, y: -184.8 };
const SHIFTED: ExpectedStock = { ...BLANK, xMin: 1.2, xMax: 39.3, yMin: 0.8, yMax: 77 };
const JAW: MountDatum = { jawTopZ: SURFACE - 0.72, measuredAt: '2026-10-23T00:00:00.000Z', by: 'wired-probe' };

function input(mount: 'vise' | 'tape', over: Partial<PlanInput> = {}): PlanInput {
  return {
    stock: BLANK,
    mount,
    expectedSurface: { machineZ: SURFACE, from: 'test' },
    seekFromMachineZ: -3,
    fixtureBelowSurfaceMm: mount === 'vise' ? 0.72 : undefined,
    ...over,
  };
}

function plan(mount: 'vise' | 'tape', over: Partial<PlanInput> = {}): RegistrationPlan {
  const r = planRegistration(input(mount, over), S);
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
}

interface Box {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/**
 * A fake Z1 that answers like the bench, with THREE things modelled that the band rule is about:
 *  - an optional BORE — a rectangular opening through the stock near its edge: the top reads a
 *    miss inside it, and a sideways ball never contacts through it;
 *  - a SIDEWAYS `G38.3 X/Y`: the ball's centre stops one radius outside the stock's edge it
 *    reaches (or misses);
 *  - the probe's rim offset: a Z touch reads the stock until its centre is `rim` past its edge.
 */
function fakeZ1(opts: { actual: ExpectedStock; surface?: number; bore?: Box; ballR?: number; rim?: number }) {
  const a = opts.actual;
  const surface = opts.surface ?? SURFACE;
  // The Z read's rim: the wired probe's measured 0.7 by default; the 3D probe's ball 1.5 where a
  // test plans with it.
  const RIM = opts.rim ?? 0.7;
  const ballR = opts.ballR ?? RIM;
  const bore = opts.bore;
  let mode: 'G90' | 'G91' = 'G90';
  const pos = { x: G54.x, y: G54.y, z: -3 };
  const lines: string[] = [];
  const reply = (text: string): ConsoleSendResult => ({ kind: 'sent', line: '', text, frames: 1, elapsedMs: 1 });
  const inBox = (x: number, y: number, b: Box, margin: number) =>
    x >= b.xMin - margin && x <= b.xMax + margin && y >= b.yMin - margin && y <= b.yMax + margin;
  /** The stock's top at this WORK XY, or null: the bore is a through opening near the edge. */
  const zAt = (wx: number, wy: number): number | null => {
    // A point strictly inside the bore (by the rim) is a miss: the probe would find the floor far
    // below the cap.
    if (bore !== undefined && inBox(wx, wy, bore, -RIM)) return null;
    return inBox(wx, wy, a, RIM) ? surface : null;
  };
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
      // #525 — a SIDEWAYS touch: the ball's centre stops one ball radius outside the edge it reaches.
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
        // The ball meets the WALL at the equator when its centre is a radius below the top, and
        // the top CORNER when it is shallower — the horizontal centre-to-edge distance is then
        // sqrt(R² − depth²), exactly what the executor's ballOffsetMm corrects by.
        const depth = surface - pos.z;
        const off = depth >= ballR ? ballR : Math.sqrt(Math.max(0, ballR * ballR - depth * depth));
        const overStock = pos.z < surface && across >= acrossLo - ballR && across <= acrossHi + ballR;
        const low = lo - off;
        const high = hi + off;
        const hits = overStock && (travel > 0 ? workStart < low && workStart + travel >= low : workStart > high && workStart + travel <= high);
        pos[axis] = hits ? (travel > 0 ? low : high) + (axis === 'x' ? G54.x : G54.y) : start + travel;
        return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}:${hits ? 1 : 0}]\nok`);
      }
      m = /^G38\.5 [XYZ]-?[\d.]+ F[\d.]+$/.exec(line);
      if (m) return reply('ok');
      return reply(`ok`);
    },
  };
  return { console, lines };
}

const yes = async () => true;

describe('#1133 the edge-find band', () => {
  it('seeds 4 mm and states its provenance', () => {
    expect(S.edgeBandMm).toBe(4);
  });

  it('every stock-edge scan spans the expected edge ± the band, on both mounts', () => {
    for (const p of [plan('tape'), plan('vise'), plan('vise', { mountDatum: JAW, fixtureBelowSurfaceMm: undefined })]) {
      expect(p.scans.length).toBeGreaterThan(0);
      for (const scan of p.scans) {
        expect(scan.start).toBeCloseTo(scan.expectedAt - scan.outward * S.edgeBandMm, 6);
        expect(scan.limit).toBeCloseTo(scan.expectedAt + scan.outward * S.edgeBandMm, 6);
      }
      expect(p.notes.join(' ')).toContain(`±${S.edgeBandMm} mm of where the edge is expected`);
      // The operator's narration states the band too — one number in every sentence that names it.
      expect(summarizePlan(p)).toContain(`±${S.edgeBandMm} mm of where its edge is expected`);
    }
  });

  it('a tape job with a bore inside the stock near its front edge finds the EDGE, never the bore', async () => {
    // The bore's near wall is 2.5 mm inside the front edge — inside the old 3 mm-inward start, so the
    // Z-only scan began in the hole and read its far wall as the edge (the maintainer's bench story).
    const bore: Box = { xMin: 10, yMin: 2.5, xMax: 28, yMax: 9 };
    const z1 = fakeZ1({ actual: BLANK, bore });
    const p = plan('tape');
    const r = await runRegistration(p, { liveClearanceZ: -3, console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);

    // The front edge is the stock's own edge — the offset is zero, not the bore's far wall at 9 mm.
    expect(r.outcome.problems).toEqual([]);
    expect(r.outcome.usable).toBe(true);
    expect(Math.abs(r.outcome.offset.y)).toBeLessThanOrEqual(S.fineStepMm / 2);

    // EVERY edge-find probe path stays inside expected ± band on its own axis.
    for (const rec of r.data.scans) {
      const scan = p.scans.find((s) => s.edge === rec.scan.edge && s.along === rec.scan.along)!;
      for (const t of rec.touches) {
        expect(t.at, `${scan.edge} at ${scan.along}`).toBeGreaterThanOrEqual(scan.expectedAt - S.edgeBandMm);
        expect(t.at, `${scan.edge} at ${scan.along}`).toBeLessThanOrEqual(scan.expectedAt + S.edgeBandMm);
      }
    }
    // The wired probe seeks each edge SIDEWAYS now (a side contact, not a bisection over the stock).
    for (const rec of r.data.scans) {
      expect(rec.touches.some((t) => t.sideContact === true)).toBe(true);
    }
    // Each sideways line travels the band's own width: 2 × band, inward.
    const sideLines = z1.lines.filter((l) => /^G38\.3 [XY]-?[\d.]+ F/.test(l));
    expect(sideLines).toHaveLength(p.scans.length);
    for (const line of sideLines) expect(line).toMatch(new RegExp(`F${S.touchFeed}$`));
    for (const line of sideLines) expect(Number(/^G38\.3 [XY](-?[\d.]+) F/.exec(line)![1])).toBeCloseTo(2 * S.edgeBandMm, 6);
  });

  it('a sideways miss inside the band refuses BY NAME and writes no origin', async () => {
    // The real front edge sits 6 mm INSIDE where the job expects it: the seek travels band-out to
    // band-in and touches nothing. A miss is a reading, never a measurement.
    const inward: ExpectedStock = { ...BLANK, yMin: 6, yMax: 82.2 };
    const z1 = fakeZ1({ actual: inward, ballR: 0.7 });
    const p = plan('vise', { mountDatum: JAW, fixtureBelowSurfaceMm: undefined });
    const r = await runRegistration(p, { liveClearanceZ: -3, console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    const front = r.outcome.edges.find((e) => e.edge === 'front')!;
    expect(front.foundAt).toBeNull();
    expect(front.problem).toContain('no edge where the stock is expected');
    expect(front.problem).toContain('Y');
    expect(front.problem).toContain(`${-S.edgeBandMm}`);
    expect(front.problem).toContain(`${S.edgeBandMm}`);
    expect(r.outcome.problems.length).toBeGreaterThan(0);
    expect(r.outcome.usable).toBe(false);
    // No origin from a measurement that is not whole: the correction is refused before any write.
    const before = z1.lines.length;
    const applied = await applyCorrection(r.outcome, { liveClearanceZ: -3, console: z1.console, operator: yes }, { confirmed: true });
    expect(applied.ok).toBe(false);
    expect(z1.lines.length).toBe(before);
    expect(z1.lines.some((l) => l.startsWith('G10 L2'))).toBe(false);
  });

  it('a vise with no measured jaw top keeps the Z-only scan — banded, and said in the plan', async () => {
    const p = plan('vise');
    expect(p.mountDatum).toBeNull();
    expect(p.notes.join(' ')).toContain('keeps the Z-only scan');
    expect(p.notes.join(' ')).toContain('no measured jaw top');
    expect(p.notes.join(' ')).toContain(`±${S.edgeBandMm} mm`);

    const z1 = fakeZ1({ actual: SHIFTED, ballR: 0.7 });
    const r = await runRegistration(p, { liveClearanceZ: -3, console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    // No sideways move at all: every edge keeps the Z-only bracket-and-bisect.
    expect(z1.lines.filter((l) => /^G38\.3 [XY]/.test(l))).toHaveLength(0);
    // Every touch of both scans is inside the band around its expected edge.
    for (const rec of r.data.scans) {
      const scan = p.scans.find((s) => s.edge === rec.scan.edge)!;
      for (const t of rec.touches) {
        expect(t.at).toBeGreaterThanOrEqual(scan.expectedAt - S.edgeBandMm);
        expect(t.at).toBeLessThanOrEqual(scan.expectedAt + S.edgeBandMm);
      }
    }
    expect(r.outcome.usable).toBe(true);
    expect(Math.abs(r.outcome.offset.x - 1.2)).toBeLessThanOrEqual(S.fineStepMm / 2);
    expect(Math.abs(r.outcome.offset.y - 0.8)).toBeLessThanOrEqual(S.fineStepMm / 2);
  });

  it('a vise WITH the measured jaw top seeks the free front edge sideways, at the wired probe’s rim', async () => {
    const p = plan('vise', { mountDatum: JAW, fixtureBelowSurfaceMm: undefined });
    const z1 = fakeZ1({ actual: SHIFTED, ballR: 0.7 });
    const r = await runRegistration(p, { liveClearanceZ: -3, console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    const side = z1.lines.filter((l) => /^G38\.3 [XY]-?[\d.]+ F/.test(l));
    // The front edge only: a vise's X edges are the jaws' own faces and stay Z-only.
    expect(side).toHaveLength(1);
    expect(side[0]).toMatch(/^G38\.3 Y/);
    // One exact side reading, corrected by the wired probe's 0.7 mm rim — not a bisection.
    const front = r.data.scans.find((sc) => sc.scan.edge === 'front')!;
    expect(front.touches).toHaveLength(1);
    expect(front.touches[0]!.sideContact).toBe(true);
    expect(r.outcome.offset.y).toBe(0.8);
    expect(r.outcome.usable).toBe(true);
  });
});

// #827 — THE VISE CORNER'S OWN X FACE. The press's corner routine touches the stock's X face
// above the jaw when it stands proud enough (a measured jaw top says so); a stock that does not
// gets the fixed jaw's face and the plan says so. The Manager's review of #1133 part 2: the
// sideways dispatch must keep this — banded like every other scan.
describe('#827 the vise corner keeps its stock-own-X-face side touch', () => {
  const PROBE_3D: ProbeSpec = {
    id: 'fx-probe-3d',
    variant: '3d',
    instrument: 'xyz',
    tip: { diameterMm: 3, rimOffsetMm: 1.5, rimOffsetUncertaintyMm: 0.05 },
  };
  const S3 = registrationSettings(ShopDefaultsSchema.parse(DOC.defaults), PROBE_3D).settings;
  /** A front-left corner plan on the vise, the stock `proud` mm above the measured jaw top. */
  const cornerPlan = (proud: number): RegistrationPlan => {
    const r = planRegistration(
      {
        stock: BLANK,
        mount: 'vise',
        expectedSurface: { machineZ: SURFACE, from: 'test' },
        seekFromMachineZ: -3,
        mountDatum: { jawTopZ: SURFACE - proud, measuredAt: '2026-10-23T00:00:00.000Z', by: 'test' },
        probe: PROBE_3D,
        stockThicknessMm: 12,
        corner: 'front-left',
        fixtureBelowSurfaceMm: undefined,
      },
      S3,
    );
    if (!r.ok) throw new Error(r.reason);
    return r.plan;
  };

  it('a stock proud enough: the corner’s X lines seek the stock’s own face sideways, banded', async () => {
    // Proud 3 mm: the ball's 1.5 + 1 mm margin + 0.3 depth pass above the jaw — the planner leaves
    // `cornerXFrom` unset, which is its statement that the stock's own X face can be touched.
    const p = cornerPlan(3);
    expect(p.cornerXFrom).toBeUndefined();
    for (const sc of p.scans) {
      expect(sc.start).toBeCloseTo(sc.expectedAt - sc.outward * S3.edgeBandMm, 6);
      expect(sc.limit).toBeCloseTo(sc.expectedAt + sc.outward * S3.edgeBandMm, 6);
    }

    const z1 = fakeZ1({ actual: BLANK, ballR: 1.5, rim: 1.5 });
    const r = await runRegistration(p, { liveClearanceZ: -3, console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    // BOTH axes now seek sideways — the X lines are #827's, restored and banded.
    const sideX = z1.lines.filter((l) => /^G38\.3 X-?[\d.]+ F/.test(l));
    const sideY = z1.lines.filter((l) => /^G38\.3 Y-?[\d.]+ F/.test(l));
    expect(sideX).toHaveLength(2);
    expect(sideY).toHaveLength(2);
    for (const line of [...sideX, ...sideY]) {
      // The band's own travel: 2 × band, inward.
      expect(Number(/^G38\.3 [XY](-?[\d.]+) F/.exec(line)![1])).toBeCloseTo(2 * S3.edgeBandMm, 6);
    }
    // Every edge is one exact side reading, and the corner is on the stock.
    for (const rec of r.data.scans) expect(rec.touches.some((t) => t.sideContact === true)).toBe(true);
    expect(r.outcome.problems).toEqual([]);
    expect(r.outcome.usable).toBe(true);
    expect(r.outcome.corner).toBeDefined();
    expect(r.outcome.corner!.outOfSquareDeg).toBeLessThanOrEqual(0.5);
    expect(Math.abs(r.outcome.offset.x)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(r.outcome.offset.y)).toBeLessThanOrEqual(0.001);
  });

  it('a stock not proud enough: X keeps the Z-only scan from the fixed jaw’s face, and the plan says so', async () => {
    // Proud 2 mm, under the 1.5 + 1 + 0.3 the ball needs: `cornerXFrom` = 'jaw'.
    const p = cornerPlan(2);
    expect(p.cornerXFrom).toBe('jaw');
    expect(p.notes.join(' ')).toContain("X is taken from the fixed jaw's face");

    const z1 = fakeZ1({ actual: BLANK, ballR: 1.5, rim: 1.5 });
    const r = await runRegistration(p, { liveClearanceZ: -3, console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    // The X lines are Z-only (no sideways move); the free front edge still seeks sideways.
    expect(z1.lines.filter((l) => /^G38\.3 X-?[\d.]+ F/.test(l))).toHaveLength(0);
    expect(z1.lines.filter((l) => /^G38\.3 Y-?[\d.]+ F/.test(l))).toHaveLength(2);
    const xRecs = r.data.scans.filter((rec) => rec.scan.edge === 'left' || rec.scan.edge === 'right');
    for (const rec of xRecs) expect(rec.touches.some((t) => t.sideContact === true)).toBe(false);
    expect(r.outcome.problems).toEqual([]);
    expect(r.outcome.usable).toBe(true);
    expect(r.outcome.corner).toBeDefined();
    // The Z-only bisection's own resolution — the fine step's quarter.
    expect(Math.abs(r.outcome.offset.x)).toBeLessThanOrEqual(S3.fineStepMm / 2);
    expect(Math.abs(r.outcome.offset.y)).toBeLessThanOrEqual(0.001);
  });
});

// #1143 — THE ESTIMATE'S PREDICATE IS THE EXECUTOR'S DISPATCH. The run plan's touch count reads
// `sideTouchSelected`; these runs pin that the records it counts actually come out that way, so
// the estimator and the machine cannot drift (the Manager's condition for #1143).
describe('#1143 the touch estimate’s predicate is the executor’s dispatch', () => {
  it('every side record is a scan the predicate names — tape, and a datum’d vise', async () => {
    const tape = plan('tape');
    const z1 = fakeZ1({ actual: BLANK });
    const r = await runRegistration(tape, { liveClearanceZ: -3, console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    for (const rec of r.data.scans) {
      expect(rec.touches.some((t) => t.sideContact === true), rec.scan.edge).toBe(sideTouchSelected(tape, rec.scan.edge));
    }

    const vise = plan('vise', { mountDatum: JAW, fixtureBelowSurfaceMm: undefined });
    const z2 = fakeZ1({ actual: BLANK });
    const r2 = await runRegistration(vise, { liveClearanceZ: -3, console: z2.console, operator: yes });
    if (!r2.ok) throw new Error(r2.reason);
    const byEdge = r2.data.scans.map((rec) => [rec.scan.edge, rec.touches.some((t) => t.sideContact === true)]);
    expect(byEdge).toEqual([
      ['left', false],
      ['front', true],
    ]);
    expect(sideTouchSelected(vise, 'left')).toBe(false);
    expect(sideTouchSelected(vise, 'front')).toBe(true);
  });
});
