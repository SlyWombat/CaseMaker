/**
 * #1207/#1248 — THE GOAL CHECK READS THE SHOP'S BANDS THE SAME WAY IN EVERY CALLER.
 *
 * The check's callers (the run store, the plan evaluator, the CLI) each used to assemble the check's
 * options by hand, and the CLI never passed the shop's three leftover bands: a shop that changed a
 * band got one verdict in the app and another from `casemaker cut` (the class #1237 closed for the
 * planner's settings). They now all take `{ passCoverage, leftoverBandsMm }` from
 * `goalCheckShopOptions`. This spec pins:
 *
 *  1. the function: the registry's recommendations when the shop states nothing, the shop's own
 *     numbers when it does (the LAST band is also #1248's tall band);
 *  2. the CLI door: `casemaker cut` on a small committed goal job (#1258's block) with a location
 *     whose bands were changed hands the check exactly those bands — and the recommendations when
 *     the location is untouched;
 *  3. no caller reads the band keys by hand any more (the one place is `defaultsClient.ts`).
 *
 * What this does NOT do: drive the run store's own check (it sits inside the store's `afterLoad`);
 * the store and the plan evaluator are held to the same function by (3).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it, vi } from 'vitest';

const seen: Array<{ passCoverage?: number; leftoverBandsMm?: readonly number[]; smallestCutterRadiusMm?: number }> = [];
vi.mock('@/engine/cnc/engrave/goalCheckInput', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/engine/cnc/engrave/goalCheckInput')>();
  return {
    ...real,
    goalCheckForProgram: (...args: Parameters<typeof real.goalCheckForProgram>) => {
      if (args[2] !== undefined) seen.push({ passCoverage: args[2].passCoverage, leftoverBandsMm: args[2].leftoverBandsMm, smallestCutterRadiusMm: args[2].smallestCutterRadiusMm });
      return real.goalCheckForProgram(...args);
    },
  };
});

import { goalCheckShopOptions, KNOWN_DEFAULTS, ShopDefaultsSchema, resetLiveShopDefaults } from '@/platform/defaultsClient';
import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import { HUMAN, type CommandOptions } from '../../scripts/lib/casemaker/output';
import { blockJob, blockLocation, SETB } from './helpers/tabChoiceBlock1258';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-goal-bands-1248-'));
afterAll(() => {
  resetLiveShopDefaults();
  rmSync(SCRATCH, { recursive: true, force: true });
});

const CHANGED: [number, number, number] = [0.5, 0.7, 2];
const entry = (value: number) => ({ value, source: 'chosen' as const, setAt: '2026-11-13T12:00:00.000Z', unit: 'mm', note: 'chosen for this spec' });
const recommended = (): [number, number, number] => [
  KNOWN_DEFAULTS['acceptance.leftoverBand1Mm']!.fallback as number,
  KNOWN_DEFAULTS['acceptance.leftoverBand2Mm']!.fallback as number,
  KNOWN_DEFAULTS['acceptance.leftoverBand3Mm']!.fallback as number,
];

describe('#1248 the one function the check\'s callers read the shop\'s bands from', () => {
  it('no location: the registry\'s recommendations; a location that states bands: those numbers', () => {
    expect(goalCheckShopOptions(null).leftoverBandsMm).toEqual(recommended());
    const map = ShopDefaultsSchema.parse({
      'acceptance.leftoverBand1Mm': entry(CHANGED[0]),
      'acceptance.leftoverBand2Mm': entry(CHANGED[1]),
      'acceptance.leftoverBand3Mm': entry(CHANGED[2]),
    });
    const options = goalCheckShopOptions(map);
    expect(options.leftoverBandsMm).toEqual(CHANGED);
    expect(Number.isFinite(options.passCoverage)).toBe(true);
  });
});

describe('#1248 the CLI hands the check the shop\'s own bands', () => {
  it('a location with changed bands: the check is called with exactly them', async () => {
    const dir = join(SCRATCH, 'changed');
    const path = blockLocation(dir);
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { defaults: Record<string, unknown> };
    doc.defaults['acceptance.leftoverBand1Mm'] = entry(CHANGED[0]);
    doc.defaults['acceptance.leftoverBand2Mm'] = entry(CHANGED[1]);
    doc.defaults['acceptance.leftoverBand3Mm'] = entry(CHANGED[2]);
    writeFileSync(path, JSON.stringify(doc, null, 2));
    await cutBlockAsync(path);
    expect(seen.length, 'the goal check was asked for').toBeGreaterThan(0);
    for (const call of seen) expect(call.leftoverBandsMm).toEqual(CHANGED);
  }, 600_000);

  it('an untouched location: the recommendations', async () => {
    const path = blockLocation(join(SCRATCH, 'plain'));
    await cutBlockAsync(path);
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) expect(call.leftoverBandsMm).toEqual(recommended());
    // #1248 (review) — the CLI states the smallest cutter's radius, so the tall split classifies.
    for (const call of seen) expect(call.smallestCutterRadiusMm, 'the CLI passes the radius').toBeGreaterThan(0);
  }, 600_000);
});

async function cutBlockAsync(locationPath: string): Promise<void> {
  const jobPath = join(SCRATCH, 'block.job.json');
  writeFileSync(jobPath, JSON.stringify(blockJob()));
  const options: CommandOptions = { ...HUMAN, json: true, now: new Date('2026-11-13T12:00:00.000Z'), sink: { progress: () => {}, receipt: () => {} } };
  seen.length = 0;
  // `--tab-choice` answers the block's tab question (#1258) so the run goes on to the goal check.
  await engraveJobMain(
    [jobPath, '--out', join(SCRATCH, `out-${Date.now()}`), '--location', locationPath, '--catalogue', join(SETB, 'catalogue.json'), '--tab-choice', 'inside-margin'],
    options,
  );
}

describe('#1248 no caller reads the band keys by hand', () => {
  const read = (rel: string): string => readFileSync(join(APP, rel), 'utf8');
  const CALLERS = ['src/store/engraveRunStore.ts', 'src/workers/sim/planEvaluate.ts', 'scripts/lib/casemaker/engrave.ts'];

  it('each caller takes the options from goalCheckShopOptions and none names a band key', () => {
    for (const file of CALLERS) {
      const text = read(file);
      expect(text, `${file} calls goalCheckShopOptions`).toMatch(/goalCheckShopOptions\(/);
      expect(text, `${file} names no leftover band key`).not.toMatch(/acceptance\.leftoverBand[123]Mm/);
    }
  });

  it('each production caller of the check passes the cutter radius through goalEdgeBreakOptions (run store, CLI, planEvaluate)', () => {
    for (const file of CALLERS) {
      const text = read(file);
      expect(text, `${file} derives the radius with goalEdgeBreakOptions`).toMatch(/goalEdgeBreakOptions\(/);
    }
    // planEvaluate takes ONLY the radius from it (no edge-break allowance: no verdict moves).
    expect(read('src/workers/sim/planEvaluate.ts')).toMatch(/smallestCutterRadiusMm/);
  });
});
