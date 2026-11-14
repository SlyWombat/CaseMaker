/**
 * #1262 — THE CORNER MARGIN'S TWO NUMBERS ARE THE SHOP'S.
 *
 * A holding tab's span stands at least `max(tabWidths × width, edgeFraction × edge)` from a corner.
 * The two numbers were literals (2 and 0.1) in the placement code; they are registry keys now
 * (`tabs.cornerMarginTabWidths`, `tabs.cornerMarginEdgeFraction`) that reach the placement as
 * arguments. On the recommendations nothing moves; a changed key moves the placed tabs.
 */

import { describe, expect, it } from 'vitest';

import { planModelCam, type ModelPlanInput } from '../../src/engine/cnc/cam/model/plan';
import { placeTabs } from '../../src/engine/cnc/cam/profile';
import { KNOWN_DEFAULTS } from '../../src/platform/defaultsClient';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

/** A 60 × 40 outline, one ring (the centre path of a part with room for several tabs a side). */
const RING: [number, number][] = [[0, 0], [60, 0], [60, 40], [0, 40]];

describe('#1262 the two keys', () => {
  it('are registered with the recommendations the code used to hold', () => {
    expect(KNOWN_DEFAULTS['tabs.cornerMarginTabWidths']!.fallback).toBe(2);
    expect(KNOWN_DEFAULTS['tabs.cornerMarginEdgeFraction']!.fallback).toBe(0.1);
  });
});

describe('#1262 placement reads them as arguments', () => {
  it('on the recommendations the placement is the pre-#1262 one (stated or absent)', () => {
    const absent = placeTabs(RING, 12, 6, 3, { maxSpanMm: 80 });
    const stated = placeTabs(RING, 12, 6, 3, { maxSpanMm: 80, cornerMarginTabWidths: 2, cornerMarginEdgeFraction: 0.1 });
    expect(stated.spans).toEqual(absent.spans);
    // The margin is 12 mm (2 × 6): three tabs fit a 60 mm edge, one a 40 mm edge.
    expect(absent.spans.length).toBe(8);
  });

  it('a wider tab-width margin takes tabs off the edges', () => {
    const wide = placeTabs(RING, 12, 6, 3, { maxSpanMm: 80, cornerMarginTabWidths: 4 });
    expect(wide.spans.length).toBeLessThan(8);
  });

  it('a margin of nothing lets more tabs on', () => {
    const none = placeTabs(RING, 12, 6, 3, { maxSpanMm: 80, cornerMarginTabWidths: 0, cornerMarginEdgeFraction: 0 });
    expect(none.spans.length).toBeGreaterThan(8);
  });

  it('the margin a stretch candidate states is the shop\'s, per edge', () => {
    const teeth: [number, number][] = [[0, 0], [27, 0], [27, 15]];
    for (let k = 1; k <= 18; k++) teeth.push([27 - 2 * k, k % 2 === 1 ? 21.7 : 15]);
    teeth.push([-3, 12], [0, 9], [-3, 6], [0, 3], [0, 0]);
    const at = (w: number, f: number) =>
      placeTabs(teeth, 4, 6, 3, { maxSpanMm: 80, tabChoice: 'ask', cornerMarginTabWidths: w, cornerMarginEdgeFraction: f }).stretches![0]!.candidate!.marginMm;
    expect(at(2, 0.1)).toBeCloseTo(12, 9); // 2 × 6 mm: the rule, uncapped, on an edge shorter than a span
    expect(at(3, 0.1)).toBeCloseTo(18, 9);
  });
});

/** The 27 × 10 block of #1258's spec: four edges, one tab each, stretches that stay long at a 10 mm limit. */
function box(): ModelPlanInput['geometry'] {
  const [w, d, h] = [27, 10, 10];
  const v: [number, number, number][] = [
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
    [0, 0, -h], [w, 0, -h], [w, d, -h], [0, d, -h],
  ];
  const faces: [number, number, number][] = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  const positions: number[] = [];
  for (const f of faces) for (const idx of f) positions.push(...v[idx]!);
  const arr = Float32Array.from(positions);
  return {
    triangles: {
      positions: arr,
      indices: Uint32Array.from({ length: arr.length / 3 }, (_, i) => i),
      triangleCount: faces.length,
      bbox: { min: [0, 0, -h], max: [w, d, 0] },
    },
  };
}
const flat6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });
function planInput(defaults: Record<string, { value: number; source: string }>): ModelPlanInput {
  return {
    geometry: box(),
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -10 }, underside: 'flatOnStockBottom' }],
    stock: { length: 60, width: 40, thickness: 10, material: 'hardwood' },
    fixture: { mount: 'vise', envelope: null },
    cutters: { house: [flat6], catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
    freeingTabs: { count: 4, widthMm: 6, heightMm: 1 },
    defaults: { 'tabs.maxSpanMm': { value: 10, source: 'test' }, ...defaults } as unknown as ModelPlanInput['defaults'],
  };
}

describe('#1262 the plan carries them on its input, beside tabs.maxSpanMm', () => {
  it('the same job asks the same question on the recommendations, and a different one when a key changes', async () => {
    const base = await planModelCam(planInput({}));
    const explicit = await planModelCam(
      planInput({ 'tabs.cornerMarginTabWidths': { value: 2, source: 'test' }, 'tabs.cornerMarginEdgeFraction': { value: 0.1, source: 'test' } }),
    );
    expect(explicit.tabChoiceNeeded!.fingerprint).toBe(base.tabChoiceNeeded!.fingerprint);
    expect(explicit.tabChoiceNeeded!.stretches).toEqual(base.tabChoiceNeeded!.stretches);
    const changed = await planModelCam(planInput({ 'tabs.cornerMarginTabWidths': { value: 1, source: 'test' } }));
    // A different margin is a different question: its answer is not the old one's.
    expect(changed.tabChoiceNeeded?.fingerprint).not.toBe(base.tabChoiceNeeded!.fingerprint);
  }, 240_000);
});
