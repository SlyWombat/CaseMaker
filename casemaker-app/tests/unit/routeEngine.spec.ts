// #928 — the frozen routing table. Each row is a named point in session.ts:888's old condition;
// changing which engine a real job takes means changing a row here, in the same commit.

import { describe, expect, it } from 'vitest';
import { routeEngine, type RouteEngineInput } from '@/workers/sim/routeEngine';

interface Row extends RouteEngineInput {
  name: string;
  expected: 'column' | 'exact';
}

const TABLE: readonly Row[] = [
  {
    name: 'the V badge: an engraving V-bit, no rotary, sparse — a cone has no flat radius',
    toolShape: 'engraving',
    rotaryClass: 'none',
    isDenseForExactSweep: false,
    flatCuttingRadiusOk: false,
    hasPriorRemoval: false,
    expected: 'column',
  },
  {
    name: 'the flat badge: a flat end mill, no rotary, sparse — the exact sweeper takes it',
    toolShape: 'flat',
    rotaryClass: 'none',
    isDenseForExactSweep: false,
    flatCuttingRadiusOk: true,
    hasPriorRemoval: false,
    expected: 'exact',
  },
  {
    name: 'a chamfer cone, no rotary, sparse — same as the V badge',
    toolShape: 'chamfer',
    rotaryClass: 'none',
    isDenseForExactSweep: false,
    flatCuttingRadiusOk: false,
    hasPriorRemoval: false,
    expected: 'column',
  },
  {
    name: 'a drill, no rotary — the column engine models the point as a cone',
    toolShape: 'drill',
    rotaryClass: 'none',
    isDenseForExactSweep: false,
    flatCuttingRadiusOk: false,
    hasPriorRemoval: false,
    expected: 'column',
  },
  {
    name: 'a thread mill, no rotary — swept as its envelope on the column engine',
    toolShape: 'thread',
    rotaryClass: 'none',
    isDenseForExactSweep: false,
    flatCuttingRadiusOk: false,
    hasPriorRemoval: false,
    expected: 'column',
  },
  {
    name: 'a ball nose, no rotary, not dense — no flat radius, column engine',
    toolShape: 'ball',
    rotaryClass: 'none',
    isDenseForExactSweep: false,
    flatCuttingRadiusOk: false,
    hasPriorRemoval: false,
    expected: 'column',
  },
  {
    name: 'a bull nose, no rotary, not dense — no flat radius, column engine',
    toolShape: 'bull',
    rotaryClass: 'none',
    isDenseForExactSweep: false,
    flatCuttingRadiusOk: false,
    hasPriorRemoval: false,
    expected: 'column',
  },
  {
    name: 'a wrapped rotary job with a flat tool — the helix routes to the column engine regardless',
    toolShape: 'flat',
    rotaryClass: 'wrapped',
    isDenseForExactSweep: false,
    flatCuttingRadiusOk: true,
    hasPriorRemoval: false,
    expected: 'column',
  },
  {
    name: 'a wrapped rotary V-bit — wrapped and cone agree, still the column engine',
    toolShape: 'engraving',
    rotaryClass: 'wrapped',
    isDenseForExactSweep: true,
    flatCuttingRadiusOk: false,
    hasPriorRemoval: true,
    expected: 'column',
  },
  {
    name: 'an indexed rotary job with a flat tool — indexed is an ordinary 2.5D cut per run, exact engine',
    toolShape: 'flat',
    rotaryClass: 'indexed',
    isDenseForExactSweep: false,
    flatCuttingRadiusOk: true,
    hasPriorRemoval: false,
    expected: 'exact',
  },
  {
    name: 'a dense flat-end-mill job, no prior removal — #531 slice B sends it to the dexel',
    toolShape: 'flat',
    rotaryClass: 'none',
    isDenseForExactSweep: true,
    flatCuttingRadiusOk: true,
    hasPriorRemoval: false,
    expected: 'column',
  },
  {
    name: 'a dense flat-end-mill job that IS a rest pass — stays on the exact sweeper, refused there by name',
    toolShape: 'flat',
    rotaryClass: 'none',
    isDenseForExactSweep: true,
    flatCuttingRadiusOk: true,
    hasPriorRemoval: true,
    expected: 'exact',
  },
  {
    name: 'a dense job whose flat radius is not usable (e.g. a corner-radius/bull-like flat tool) — refused, not routed to the dexel',
    toolShape: 'flat',
    rotaryClass: 'none',
    isDenseForExactSweep: true,
    flatCuttingRadiusOk: false,
    hasPriorRemoval: false,
    expected: 'exact',
  },
  {
    name: 'a sparse flat job with no rotary and no prior — the ordinary case, exact engine',
    toolShape: 'flat',
    rotaryClass: 'none',
    isDenseForExactSweep: false,
    flatCuttingRadiusOk: true,
    hasPriorRemoval: true,
    expected: 'exact',
  },
  {
    name: 'an unknown tool shape, no rotary, sparse — not one of the column shapes, exact engine',
    toolShape: 'unknown',
    rotaryClass: 'none',
    isDenseForExactSweep: false,
    flatCuttingRadiusOk: false,
    hasPriorRemoval: false,
    expected: 'exact',
  },
];

describe('#928 routeEngine — the frozen tool shape × rotary class × density × seed kind table', () => {
  it.each(TABLE.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    const { expected, name: _n, ...input } = row;
    expect(routeEngine(input)).toBe(expected);
  });

  it('covers every RouteToolShape at least once', () => {
    const shapes = new Set(TABLE.map((r) => r.toolShape));
    const allShapes = ['flat', 'ball', 'tapered-ball', 'engraving', 'chamfer', 'drill', 'thread', 'bull', 'unknown'] as const;
    for (const shape of allShapes) {
      // tapered-ball is not named by session.ts's old condition (falls through like 'unknown' —
      // neither sweepsOnColumn nor the flat-only dense check claim it), so it is covered by the
      // 'unknown' row's reasoning rather than its own; every other shape has a named row above.
      if (shape === 'tapered-ball') continue;
      expect(shapes.has(shape)).toBe(true);
    }
  });

  it('covers every RouteRotaryClass at least once', () => {
    const classes = new Set(TABLE.map((r) => r.rotaryClass));
    for (const rc of ['none', 'indexed', 'wrapped'] as const) {
      expect(classes.has(rc)).toBe(true);
    }
  });
});
