// @vitest-environment jsdom
// #451 — the probe planner's four residuals move into the location database: what one touch leaves
// (`registration.probeResidualMm`), the wired probe's Z figure the depth budget is built on
// (`registration.wiredProbeZResidualMm`), and what each fixture already holds (the chuck, the vise
// jaws and the anchor bracket). The maintainer's rule (2026-10-16) is that a number somebody chose
// for this bench lives in `location.json`'s `defaults` section, and code keeps only a LABELLED
// fallback for the no-service build.
//
// Three things are pinned here, because each is a copy that could drift:
//   1. the registry's fallbacks equal `probePlan.ts`'s compiled constants;
//   2. the location fixture carries every seed with its provenance in words;
//   3. the use sites actually read the location — `planProbing`'s datums and residual, and
//      `recommendMargins`' probe term.

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_DEFAULTS, ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import { resetShopDefaultsStore, useShopDefaultsStore } from '@/store/shopDefaultsStore';
import {
  ANCHOR_BRACKET_RESIDUAL_MM,
  CHUCK_AXIS_RESIDUAL_MM,
  PROBE_RESIDUAL_MM,
  VISE_JAW_RESIDUAL_MM,
  WIRED_PROBE_Z_RESIDUAL_MM,
  planProbing,
  probeResiduals,
} from '@/engine/cnc/probePlan';
import { MARGIN_DEFAULTS, recommendMargins } from '@/engine/cnc/engrave/depthBounds';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { rectProfile } from '@/engine/compiler/profile';
import type { Workholding } from '@/engine/cnc/setup';

const KEYS = [
  'registration.probeResidualMm',
  'registration.wiredProbeZResidualMm',
  'registration.chuckAxisResidualMm',
  'registration.viseJawResidualMm',
  'bracket.repeatMm',
] as const;

/** The four PROVISIONAL / assumed seeds. The wired probe's Z figure is MEASURED and is its own case. */
const UNMEASURED_KEYS = KEYS.filter((key) => key !== 'registration.wiredProbeZResidualMm');

const HERE = dirname(fileURLToPath(import.meta.url));
const SEEDED: ShopDefaults = ShopDefaultsSchema.parse(
  (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults,
);

/** A location that chose these two residuals, parsed through the section's own schema. */
function choose(values: Record<string, number>): void {
  const section = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      { value, source: 'chosen' as const, setAt: '2026-10-17T00:00:00.000Z', unit: 'mm', note: null },
    ]),
  );
  useShopDefaultsStore.setState({ status: 'present', defaults: ShopDefaultsSchema.parse(section) });
}

afterEach(() => resetShopDefaultsStore());

const chuck: Workholding = { kind: 'rotary-chuck', jawDiameter: 80, stickout: 10 };
const bracket: Workholding = { kind: 'anchor-bracket', anchor: 1, offset: [0, 0] };
const plate = { outline: rectProfile(60, 30) };

describe('the probe residuals as shop defaults (#451)', () => {
  it('every registry fallback equals the compiled no-service constant', () => {
    expect(KNOWN_DEFAULTS['registration.probeResidualMm']!.fallback).toBe(PROBE_RESIDUAL_MM);
    expect(KNOWN_DEFAULTS['registration.wiredProbeZResidualMm']!.fallback).toBe(WIRED_PROBE_Z_RESIDUAL_MM);
    expect(KNOWN_DEFAULTS['registration.chuckAxisResidualMm']!.fallback).toBe(CHUCK_AXIS_RESIDUAL_MM);
    expect(KNOWN_DEFAULTS['registration.viseJawResidualMm']!.fallback).toBe(VISE_JAW_RESIDUAL_MM);
    expect(KNOWN_DEFAULTS['bracket.repeatMm']!.fallback).toBe(ANCHOR_BRACKET_RESIDUAL_MM);
    for (const key of KEYS) {
      const known = KNOWN_DEFAULTS[key]!;
      expect(known.rule.safeParse(known.fallback).success, key).toBe(true);
    }
  });

  it('the location fixture carries every seed, at the fallback, with its provenance in words', () => {
    for (const key of KEYS) expect(SEEDED[key], key).toBeDefined();
    for (const key of UNMEASURED_KEYS) {
      const d = SEEDED[key]!;
      expect(d.source, key).toBe('seeded');
      expect(d.value, key).toBe(KNOWN_DEFAULTS[key]!.fallback);
    }
    expect(SEEDED['registration.probeResidualMm']!.note).toMatch(/assumed, not measured/);
    expect(SEEDED['registration.chuckAxisResidualMm']!.note).toMatch(/provisional, not measured/);
    expect(SEEDED['registration.viseJawResidualMm']!.note).toMatch(/provisional, not measured/);
    expect(SEEDED['bracket.repeatMm']!.note).toMatch(/provisional, not measured/);
  });

  it('the wired probe’s Z figure is MEASURED, dated, and says how it was taken', () => {
    const d = SEEDED['registration.wiredProbeZResidualMm']!;
    expect(d.source).toBe('measured');
    expect(d.value).toBe(WIRED_PROBE_Z_RESIDUAL_MM);
    expect(d.setAt).not.toBeNull();
    expect(d.note).toMatch(/2026-10-08/);
    expect(d.note).toMatch(/five slow \(F100\) touches/);
  });

  it('each rule refuses a figure no residual could be', () => {
    expect(KNOWN_DEFAULTS['registration.probeResidualMm']!.rule.safeParse(-0.1).success).toBe(false);
    expect(KNOWN_DEFAULTS['registration.probeResidualMm']!.rule.safeParse(2).success).toBe(false);
    expect(KNOWN_DEFAULTS['registration.wiredProbeZResidualMm']!.rule.safeParse(1).success).toBe(false);
    expect(KNOWN_DEFAULTS['bracket.repeatMm']!.rule.safeParse(3).success).toBe(false);
  });

  it('with no located numbers, every residual is the labelled fallback', () => {
    expect(probeResiduals(null)).toEqual({
      probe: PROBE_RESIDUAL_MM,
      wiredProbeZ: WIRED_PROBE_Z_RESIDUAL_MM,
      chuckAxis: CHUCK_AXIS_RESIDUAL_MM,
      anchorBracket: ANCHOR_BRACKET_RESIDUAL_MM,
      viseJaw: VISE_JAW_RESIDUAL_MM,
    });
  });

  it('planProbing reads the location’s residuals at the plan, for both a datum and a touch', () => {
    choose({ 'registration.chuckAxisResidualMm': 0.2, 'registration.probeResidualMm': 0.07 });
    // A cylinder's outline as the planner sees it: an XY section, with rotation immaterial. The job
    // tolerates 0.3 mm, and the chuck's datum holds both axes within the located 0.2 — so no touch
    // is planned and the datum's own residual is what is left.
    const r = planProbing({ outline: rectProfile(30, 15), axisymmetric: true }, chuck, { tipDiameter: 3, toleranceMm: 0.3 });
    if ('refuse' in r) throw new Error('refused');
    expect(r.datums[0]!.uncertainty).toBe(0.2);
    expect(r.touches).toEqual([]);
    expect(r.residual).toBeCloseTo(0.2, 12);

    // A taped plate needs two touches, so what is left is the probe's own 0.07, not the seed.
    const taped = planProbing(plate, { kind: 'tape-down', contact: rectProfile(60, 30) }, { tipDiameter: 3, toleranceMm: 0.05 });
    if ('refuse' in taped) throw new Error('refused');
    expect(taped.residual).toBeCloseTo(0.07, 12);
  });

  it('the anchor bracket’s datum reads bracket.repeatMm', () => {
    choose({ 'bracket.repeatMm': 0.12 });
    const r = planProbing(plate, bracket, { tipDiameter: 3, toleranceMm: 0.5 });
    if ('refuse' in r) throw new Error('refused');
    expect(r.datums[0]!.uncertainty).toBe(0.12);
  });

  it('recommendMargins builds its probe term from registration.wiredProbeZResidualMm', () => {
    choose({ 'registration.wiredProbeZResidualMm': 0.01 });
    const rec = recommendMargins(defaultEngraveJob(), MARGIN_DEFAULTS);
    expect(rec.zTolerance).toBeCloseTo(0.01, 12);
    expect(rec.basis.join(' ')).toContain('the wired probe adds 0.01 mm');
  });
});
