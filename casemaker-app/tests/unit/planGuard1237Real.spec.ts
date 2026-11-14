/**
 * #1237 — THE GUARD IS REACHABLE THROUGH THE REAL BUILDER.
 *
 * `planModelCam` refuses a location stated without its settings. The one production builder
 * (`buildModelPlanInputForGoal`) used to turn an absent map into `null` and the guard tested
 * `undefined`, so no built input could ever trip it: a request naming a location but carrying no map
 * planned on the recommendations in silence. Absent or null with a location stated now throws the
 * guard's own sentence. These cases go through the real builder, not a hand-made input.
 */
import { describe, expect, it } from 'vitest';

import { planModelCam } from '../../src/engine/cnc/cam/model/plan';
import { engraveShopOpts } from '../../src/engine/cnc/engrave/feeds';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { ShopDefaults } from '../../src/platform/defaultsClient';
import { buildModelPlanInputForGoal, type EngraveShopOpts } from '../../src/workers/sim/engraveGenerate';
import { blockJob, blockTarget } from './helpers/tabChoiceBlock1258';

const flat6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 }) as Tool;
const LOCATION = '/tmp/shop/location.json';
const entry = (value: number): ShopDefaults[string] => ({ value, source: 'chosen', setAt: null, unit: null, note: null });

async function planWith(shop: EngraveShopOpts) {
  const input = await buildModelPlanInputForGoal(blockJob(), blockTarget(), flat6, shop, undefined, undefined, []);
  return { input, run: () => planModelCam(input) };
}

describe('#1237 the guard through the real builder', () => {
  it('a location stated and NO map: the guard’s own sentence', async () => {
    const shop = { ...engraveShopOpts(null, LOCATION), defaults: undefined } as unknown as EngraveShopOpts;
    const { run } = await planWith(shop);
    await expect(run()).rejects.toThrow(/planModelCam was given the location \/tmp\/shop\/location\.json but no shop defaults/);
  }, 240_000);

  it('a location stated and a NULL map: refused the same way (what the CLI sent for a document it dropped)', async () => {
    const { run } = await planWith(engraveShopOpts(null, LOCATION));
    await expect(run()).rejects.toThrow(/no shop defaults/);
  }, 240_000);

  it('no location at all: null is the recommendations, as today', async () => {
    const { input, run } = await planWith(engraveShopOpts(null));
    expect(input.defaults).toBeNull();
    const out = await run();
    // The recommendations: the 80 mm span limit leaves nothing to ask, so the plan runs.
    expect(out.tabChoiceNeeded).toBeUndefined();
    expect(out.perSetup.length).toBeGreaterThan(0);
  }, 240_000);

  it('a location that states NO overrides passes `{}`: the recommendations, accepted', async () => {
    const { run } = await planWith(engraveShopOpts({}, LOCATION));
    const out = await run();
    expect(out.tabChoiceNeeded).toBeUndefined();
    expect(out.perSetup.length).toBeGreaterThan(0);
  }, 240_000);

  it('a location with its map: the shop’s values (tabs.maxSpanMm 10 → the plan asks, with that limit)', async () => {
    const { run } = await planWith(engraveShopOpts({ 'tabs.maxSpanMm': entry(10) }, LOCATION));
    const out = await run();
    expect(out.tabChoiceNeeded?.limitMm).toBe(10);
  }, 240_000);
});
