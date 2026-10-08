/**
 * #213 §3 inside the engrave pipeline: BOTH ends of "where cutting is allowed" read the
 * sacrificial material — `jobDepthLimit` (the depth table the verifier is handed) and the
 * engravability check's supported footprint (whether an item may run over a part edge at all).
 *
 * Real Manifold, plain Node, the same harness `engraveGenerate.spec.ts` uses. With no
 * sacrificial material both are byte-for-byte what they were before #213, so these specs are all
 * about the strip/board cases that used to be refused.
 */

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate, regions } from './helpers/engravePipeline';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobDepthLimit } from '@/engine/cnc/engrave/partPlan';
import { noneSacrificial, presetJawStrips } from '@/engine/cnc/sacrificial';
import type { EngraveJob, EngraveKeepOut } from '@/types/engraveJob';

/** The default blank: 100 × 60 × 12, minFloor 1 → the stock limit is 11 over the part. */
const job = (over: Partial<EngraveJob> = {}): EngraveJob => ({ ...defaultEngraveJob(), ...over });

describe('jobDepthLimit composes the sacrificial table (#213 §3)', () => {
  it('with no sacrificial material is the plain stock limit, 0 off the blank', () => {
    const limit = jobDepthLimit(job());
    expect(limit(50, 30)).toBe(11); // 12 − minFloor
    expect(limit(101, 30)).toBe(0);
    expect(limit(-1, 30)).toBe(0);
  });

  it('over a flush side strip is the strip height, and 0 beyond the strip', () => {
    const limit = jobDepthLimit(job({ sacrificial: presetJawStrips() })); // 6 mm left+right, flush
    expect(limit(50, 30)).toBe(11); // still the part
    expect(limit(103, 30)).toBe(12); // 3 mm past the right edge, on the strip: height = T
    expect(limit(-3, 30)).toBe(12); // the left strip
    expect(limit(107, 30)).toBe(0); // past the strip's outer face
    expect(limit(50, 61)).toBe(0); // strips span the part's Y only
  });

  it('takes the shallower of the strip and an under-surface void when both cover a point', () => {
    // A void whose footprint reaches 3 mm past the right edge; over the strip the base limit is
    // the strip height (12) and the void leaves a 1 mm membrane, so 1 wins.
    const pocket: EngraveKeepOut = {
      id: 'pocket',
      kind: 'rect',
      position: { x: 105, y: 30 },
      rotation: 0,
      enabled: true,
      zCeiling: 10,
      width: 6,
      height: 10,
      cornerRadius: 0,
    };
    const limit = jobDepthLimit(job({ sacrificial: presetJawStrips(), keepOuts: [pocket] }));
    expect(limit(105, 30)).toBeCloseTo(1.0, 9); // 12 − 10 − 1
    expect(limit(101, 30)).toBe(12); // on the strip, clear of the void (void spans 102…108 in X)
  });
});

describe('an item may run over an edge onto sacrificial material (#213 §3)', () => {
  /**
   * 'H' at a 10 mm cap height on the RIGHT edge of the 100 mm blank, cut by the default 1.0 mm
   * mill. Its opened (tool-swept) region crosses x = 100 by a few mm — a cut the pipeline must
   * refuse on bare stock, and must allow once there is strip beside it.
   */
  const overEdge = (over: Partial<EngraveJob> = {}): EngraveJob => {
    const base = defaultEngraveJob();
    return {
      ...base,
      labels: [
        {
          id: 'edge',
          text: 'H',
          font: base.labels[0]!.font,
          weight: 'bold',
          size: 10,
          position: { x: 100, y: 30 },
          rotation: 0,
          depth: 1.0,
          enabled: true,
        },
      ],
      sacrificial: noneSacrificial(),
      ...over,
    };
  };

  it('refuses it on bare stock: item-outside-stock, stopped at findings', () => {
    const g = generate(tl, overEdge());
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.findings.some((f) => f.code === 'item-outside-stock' && f.severity === 'error')).toBe(true);
  });

  it('generates and verifies it cleanly with 6 mm strips between the jaws', () => {
    const g = generate(tl, overEdge({ sacrificial: presetJawStrips() }));
    expect(g.errors).toEqual([]);
    expect(g.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.nc).not.toBeNull();
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    // And the placement finding is gone, not merely downgraded.
    expect(g.findings.some((f) => f.code === 'item-outside-stock')).toBe(false);
  });

  it('still refuses it when it runs past the strip too', () => {
    const g = generate(tl, overEdge({ sacrificial: presetJawStrips(), labels: [
      { ...overEdge().labels[0]!, position: { x: 110, y: 30 } },
    ] }));
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.findings.some((f) => f.code === 'item-outside-stock' && f.severity === 'error')).toBe(true);
  });

  it('the supported footprint the geometry check reads is the part outline with no material', () => {
    const plan = regions(tl, overEdge()).plan;
    // With no sacrificial material, `supported` IS the part outline: same area, same bounds.
    const bare = regions(tl, job()).plan.stock;
    expect(bare.supported).toEqual(bare.outline);
    expect(plan.stock.supported.kind).toBe('p-rect');
  });
});
