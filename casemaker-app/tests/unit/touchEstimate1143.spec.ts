// #1143 — THE REGISTRATION TOUCH ESTIMATE COUNTS WHAT THE EXECUTOR WILL DO.
//
// `registrationTouches` fed the run plan's registration phase (`touches × plan.touchSeconds`) with
// the Z-only bracket-and-bisect shape for every scan (#594). Since #1133 the executor seeks most
// edges SIDEWAYS — one horizontal G38.3 under a guarded descent — so those scans were over-counted,
// and the phase estimate with them. The count now reads `sideTouchSelected`, the SAME predicate the
// executor dispatches on, so the two cannot drift.
//
// The plan's own scan list is the estimator's input, so these cases state the method each scan
// takes and the touches it costs: 2 for a sideways scan (its guarded descent + one horizontal
// touch), 2 + log₂(span / fine step) for the Z-only bracket-and-bisect.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import { planRegistration, registrationSettings, type ExpectedStock, type PlanInput, type RegistrationPlan } from '@/engine/cnc/registration';
import { sideTouchSelected } from '@/engine/cnc/registration/probe3d';
import type { ProbeSpec } from '@/engine/cnc/registration/plan';
import { registrationTouches } from '@/engine/cnc/plan';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown };
const { settings: S } = registrationSettings(ShopDefaultsSchema.parse(DOC.defaults));
const PROBE_3D: ProbeSpec = { id: 'fx-probe-3d', variant: '3d', instrument: 'xyz', tip: { diameterMm: 3, rimOffsetMm: 1.5, rimOffsetUncertaintyMm: 0.05 } };
const S3 = registrationSettings(ShopDefaultsSchema.parse(DOC.defaults), PROBE_3D).settings;

/** The badge blank, origin at its front-left corner. */
const BLANK: ExpectedStock = { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 };
const SURFACE = -56.172;
const JAW = { jawTopZ: SURFACE - 0.72, measuredAt: '2026-10-23T00:00:00.000Z', by: 'wired-probe' };

function plan(over: Partial<PlanInput>, settings = S): RegistrationPlan {
  const r = planRegistration(
    { stock: BLANK, mount: 'vise', expectedSurface: { machineZ: SURFACE, from: 'test' }, seekFromMachineZ: -3, fixtureBelowSurfaceMm: 0.72, ...over },
    settings,
  );
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
}
const touchesOf = (p: RegistrationPlan) => registrationTouches({ ok: true, plan: p });

/** The Z-only cost of one scan at the shop's fine step and the band's span (the old #594 shape). */
const zOnlyTouches = (p: RegistrationPlan, edge: string): number => {
  const scan = p.scans.find((s) => s.edge === edge)!;
  return 2 + Math.ceil(Math.log2(Math.max(2, Math.abs(scan.start - scan.limit) / scan.fineStep)));
};

describe('#1143 the touch estimate counts the executor’s method', () => {
  it('a tape plan seeks every edge sideways: the surface touch + 2 per scan', () => {
    const p = plan({ mount: 'tape', fixtureBelowSurfaceMm: undefined });
    expect(p.scans).toHaveLength(3);
    for (const scan of p.scans) expect(sideTouchSelected(p, scan.edge)).toBe(true);
    // 1 + 3 × (guarded descent + one horizontal touch). The old count was 19.
    expect(touchesOf(p)).toBe(7);
    expect(touchesOf(p) * 15).toBe(105); // the phase's seconds at the seeded 15 s/touch (was 285)
  });

  it('a datum’d vise: the free front edge sideways, the fixed-jaw X edge bisected', () => {
    const p = plan({ mountDatum: JAW, fixtureBelowSurfaceMm: undefined });
    expect(p.scans.map((s) => [s.edge, sideTouchSelected(p, s.edge)])).toEqual([
      ['left', false],
      ['front', true],
    ]);
    // 1 + the Z-only left edge + 2 for the front.
    expect(touchesOf(p)).toBe(1 + zOnlyTouches(p, 'left') + 2);
    expect(touchesOf(p)).toBe(9);
  });

  it('a vise with no measured jaw top bisects both edges (ruling B)', () => {
    const p = plan({});
    for (const scan of p.scans) expect(sideTouchSelected(p, scan.edge)).toBe(false);
    expect(touchesOf(p)).toBe(1 + zOnlyTouches(p, 'left') + zOnlyTouches(p, 'front'));
    expect(touchesOf(p)).toBe(13);
  });

  it('#827 a proud stock’s corner seeks both axes sideways; a stock under the ball’s margin bisects X', () => {
    const proud = plan({ mountDatum: { ...JAW, jawTopZ: SURFACE - 3 }, fixtureBelowSurfaceMm: undefined, probe: PROBE_3D, stockThicknessMm: 12, corner: 'front-left' }, S3);
    expect(proud.cornerXFrom).toBeUndefined();
    for (const scan of proud.scans) expect(sideTouchSelected(proud, scan.edge)).toBe(true);
    expect(touchesOf(proud)).toBe(1 + 4 * 2);

    const jaw = plan({ mountDatum: { ...JAW, jawTopZ: SURFACE - 2 }, fixtureBelowSurfaceMm: undefined, probe: PROBE_3D, stockThicknessMm: 12, corner: 'front-left' }, S3);
    expect(jaw.cornerXFrom).toBe('jaw');
    expect(jaw.scans.map((s) => [s.edge, sideTouchSelected(jaw, s.edge)])).toEqual([
      ['left', false],
      ['left', false],
      ['front', true],
      ['front', true],
    ]);
    expect(touchesOf(jaw)).toBe(1 + 2 * zOnlyTouches(jaw, 'left') + 2 * 2);
  });

  it('the M1 tape tray’s measurement: 7 touches (was 19) — the registration phase 105 s, was 285 s', () => {
    // The m1-tray-tape job: a 160 × 126 × 25 mm blank on tape, one setup — the tray job whose
    // phase total the issue asks to re-measure. Same shop settings; the stock is the job's.
    const p = plan({ stock: { xMin: 0, yMin: 0, xMax: 160, yMax: 126, cornerRadius: 0 }, mount: 'tape', fixtureBelowSurfaceMm: undefined });
    expect(p.scans).toHaveLength(3);
    expect(touchesOf(p)).toBe(7);
    // The old estimator, on the same scans: 2 + log₂(2 × band / fineStep) each.
    const before = 1 + p.scans.reduce((n, scan) => n + 2 + Math.ceil(Math.log2(Math.max(2, Math.abs(scan.start - scan.limit) / scan.fineStep))), 0);
    expect(before).toBe(19);
    expect(before * 15).toBe(285);
    expect(touchesOf(p) * 15).toBe(105);
    // The set B tray jobs are BRACKET holds: one top touch, no scans — the phase is unchanged
    // (1 touch) for them.
    const bracket = plan({ mount: 'bracket', mountObstacles: [], bracketOrigin: { x: -181.55, y: -184.8, from: 'anchor1', offsetMeasured: true }, fixtureBelowSurfaceMm: undefined });
    expect(bracket.scans).toEqual([]);
    expect(touchesOf(bracket)).toBe(1);
  });
});

describe('#1179 the cut-blank plan’s check points are touches', () => {
  // #1179 blank identity: a cut-blank plan carries `surfaceChecks` and the executor touches them
  // (three to start, up to five) instead of one surface touch. The header must count what the
  // machine will actually do — it read "1 touch" while the card measured three.
  const checks = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i + 1, y: i + 1, depthMm: 0 }));

  it('replaces the single surface touch with the plan’s checks, keeping each scan’s cost', () => {
    const base = plan({ mount: 'tape', fixtureBelowSurfaceMm: undefined });
    expect(base.scans).toHaveLength(3);
    expect(touchesOf(base)).toBe(7); // 1 surface touch + 3 sideways scans
    expect(touchesOf({ ...base, surfaceChecks: checks(3) })).toBe(9); // 3 checks + 6
    expect(touchesOf({ ...base, surfaceChecks: checks(5) })).toBe(11); // the cap: 5 checks + 6
    expect(touchesOf({ ...base, surfaceChecks: checks(2) })).toBe(8); // only two points exist: 2 + 6
    // No checks: the single touch, exactly as before.
    expect(touchesOf({ ...base, surfaceChecks: [] })).toBe(7);
    expect(touchesOf({ ...base, surfaceChecks: undefined })).toBe(7);
  });

  it('a bracket cut-blank plan (no scans) counts its checks alone — the bench’s “Register · 3 touches”', () => {
    const p = plan({ mount: 'tape', fixtureBelowSurfaceMm: undefined });
    const bracketLike = { ...p, scans: [], surfaceChecks: checks(3) };
    expect(touchesOf(bracketLike)).toBe(3);
  });
});
