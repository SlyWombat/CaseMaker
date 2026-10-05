// @vitest-environment jsdom
// Issue #197 §6 — `activeSceneBounds` is what the camera presets and AutoFrame both read, so
// Top / Front / Side can never centre on a case that is not being drawn. Pure over its input
// (a store snapshot), so every case is checked directly.

import { describe, it, expect } from 'vitest';
import { activeSceneBounds, shouldReframe, type SceneBoundsInput } from '@/components/viewport/viewportCamera';

type Node = SceneBoundsInput['nodes'] extends Map<string, infer N> ? N : never;

function nodes(entries: [string, [number[], number[]]][]): SceneBoundsInput['nodes'] {
  return new Map(
    entries.map(([id, [min, max]]): [string, Node] => [id, { stats: { bbox: { min, max } } }]),
  );
}

const EMPTY: SceneBoundsInput = { nodes: new Map(), simBoxes: null };

describe('activeSceneBounds', () => {
  it('is null when there is nothing to frame', () => {
    expect(activeSceneBounds(EMPTY)).toBeNull();
  });

  it('frames the case nodes when no simulation owns the viewport', () => {
    const bounds = activeSceneBounds({
      nodes: nodes([
        ['shell', [[0, 0, 0], [20, 40, 10]]],
        ['lid', [[0, 0, 10], [20, 40, 14]]],
      ]),
      simBoxes: null,
    });
    expect(bounds).not.toBeNull();
    expect(bounds!.center.toArray()).toEqual([10, 20, 7]);
    expect(bounds!.diag).toBeCloseTo(Math.hypot(20, 40, 14), 5);
  });

  it('skips the fused rack-assembled nodes, which are the same geometry as their parts', () => {
    const bounds = activeSceneBounds({
      nodes: nodes([
        ['rack-side-left', [[0, 0, 0], [10, 10, 10]]],
        // A far-away assembled export of the same thing must NOT widen the framing.
        ['rack-assembled-3', [[-100, -100, -100], [100, 100, 100]]],
      ]),
      simBoxes: null,
    });
    expect(bounds!.center.toArray()).toEqual([5, 5, 5]);
    expect(bounds!.diag).toBeCloseTo(Math.hypot(10, 10, 10), 5);
  });

  it('frames the simulation stock and fixture boxes, ignoring the case entirely', () => {
    const bounds = activeSceneBounds({
      // A case 100x bigger than the stock: if it leaked in, the centre would move.
      nodes: nodes([['shell', [[-1000, -1000, -1000], [1000, 1000, 1000]]]]),
      simBoxes: [
        { min: [0, 0, -5], max: [100, 60, 0] }, // the stock
        { min: [0, -20, -5], max: [100, 0, 0] }, // one vise jaw, outside the stock in -Y
      ],
    });
    expect(bounds!.center.toArray()).toEqual([50, 20, -2.5]);
    expect(bounds!.diag).toBeCloseTo(Math.hypot(100, 80, 5), 5);
  });

  it('a sim with no boxes at all frames nothing, not the case (#194 path-only with no moves)', () => {
    expect(
      activeSceneBounds({ nodes: nodes([['shell', [[0, 0, 0], [10, 10, 10]]]]), simBoxes: [] }),
    ).toBeNull();
  });

  // #205, and the bounds half of #229's acceptance — while the engrave section owns the viewport,
  // Top / Fit / zoom must frame the ENGRAVE PREVIEW (its stock and jaws), never the case, which
  // `SceneMeshes` is not drawing.
  it('frames the engrave preview stock and jaws, ignoring the case entirely', () => {
    const bounds = activeSceneBounds({
      nodes: nodes([['shell', [[-1000, -1000, -1000], [1000, 1000, 1000]]]]),
      simBoxes: null,
      engraveBoxes: [
        { min: [0, 0, -10], max: [80, 50, 0] }, // the stock
        { min: [0, -15, -10], max: [80, 0, 0] }, // a vise jaw, outside the stock in -Y
      ],
    });
    expect(bounds!.center.toArray()).toEqual([40, 17.5, -5]);
    expect(bounds!.diag).toBeCloseTo(Math.hypot(80, 65, 10), 5);
  });

  it('an open engrave section with no preview yet frames nothing, not the case', () => {
    // `!= null` (not truthiness): an empty list still takes the engrave branch.
    expect(
      activeSceneBounds({
        nodes: nodes([['shell', [[0, 0, 0], [10, 10, 10]]]]),
        simBoxes: null,
        engraveBoxes: [],
      }),
    ).toBeNull();
  });

  it('a simulation still up takes the sim bounds over the engrave preview', () => {
    const bounds = activeSceneBounds({
      nodes: nodes([['shell', [[-1000, -1000, -1000], [1000, 1000, 1000]]]]),
      simBoxes: [{ min: [0, 0, -5], max: [100, 60, 0] }],
      engraveBoxes: [{ min: [0, 0, -10], max: [10, 10, 0] }],
    });
    expect(bounds!.center.toArray()).toEqual([50, 30, -2.5]);
  });
});

// Issue #197 review, fix 3 — "closing a simulation can leave the camera looking at nothing".
// A stock the size of the case but centred elsewhere passes the 35% diagonal rule, so the
// transition out of the simulation has to FORCE a re-frame rather than fall back to the rule.
describe('shouldReframe', () => {
  it('reframes on a forced transition whatever the size — a load, or the end of a simulation', () => {
    // Same diagonal as the case (the size rule would skip), but identity changed: the camera
    // must still re-centre, on the stock when entering and on the case when closing.
    expect(shouldReframe(100, 100, true)).toBe(true);
  });

  it('skips a small size change when nothing changed identity — it never fights an orbit', () => {
    expect(shouldReframe(100, 120, false)).toBe(false);
    expect(shouldReframe(100, 90, false)).toBe(false);
  });

  it('reframes on a substantial size change, in either direction', () => {
    expect(shouldReframe(100, 140, false)).toBe(true);
    expect(shouldReframe(100, 70, false)).toBe(true);
  });

  it('reframes when there is no previous size to compare against', () => {
    expect(shouldReframe(0, 100, false)).toBe(true);
  });
});

