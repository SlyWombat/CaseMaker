// The two-tool split's DECISIONS (#410, the issue's scope comment), tested without wasm.
//
// `restPass.ts` is pure on purpose: it is handed the reachability table and decides which cutter
// takes the first bite, which items the first program leaves off, and how the second program's job
// document is built. Every case here injects the measurement and checks the rule and the wording
// around it — so a change to the fixture cannot make these pass by moving the goalposts, and the
// shape the injected rows must respect is the one `measureLabels` really returns.

import { describe, it, expect } from 'vitest';

import { reachabilityFor, type Reachability } from '@/engine/cnc/engrave/reachability';
import {
  restJobFor,
  restToolPick,
  roughPick,
  unroughedItems,
  vBitRestRefusal,
} from '@/engine/cnc/engrave/restPass';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { LabelEngravability } from '@/workers/sim/engraveGeometry';
import type { EngraveJob } from '@/types/engraveJob';

/** A library entry built around `flatEndMill`, the way `reachability.spec.ts` builds one. */
function tool(key: string, diameter: number, opts: Partial<Tool> = {}): ToolLibraryEntry {
  return { key, tool: flatEndMill(diameter, opts), provenance: 'restPass test' };
}

/** Two items whose areas are the fixture's own facts, held here once. */
const AREA: Record<string, number> = { big: 900, small: 100 };

/**
 * A job with one label per id given. The rule under test reads the id, the depth and the enabled
 * flag; the geometry is `measure`'s business.
 *
 * The material is PLA because the FEED TABLE is: the finest flat row in it covers 0.5–0.8 mm in PLA
 * and the wood rows start at 0.8 mm, so a 0.6 mm cutter in softwood is excluded as `no-feeds` before
 * the rule ever sees it — and the second cutter of a two-tool pair is a fine one by definition.
 */
function jobWith(...ids: string[]): EngraveJob {
  const job = defaultEngraveJob();
  job.stock.material = 'pla';
  job.labels = ids.map((id, i) => ({
    id,
    text: `T${i}`,
    font: 'sans-default',
    weight: 'bold' as const,
    size: 8,
    position: { x: 20 + i * 20, y: 30 },
    rotation: 0,
    depth: 1,
    enabled: true,
  }));
  return job;
}

/** `measureLabels`'s shape with the fixture's area and the case's opened area. */
function row(id: string, opened: number): LabelEngravability {
  const area = AREA[id] ?? 1;
  return {
    labelId: id,
    glyphArea: area,
    openedArea: opened,
    ratio: area === 0 ? 1 : opened / area,
    emptyChars: [],
    outsideArea: 0,
    polygons: [],
  };
}

/** A `measure` from a table: per cutter key, the opened area of each item; absent = not reached. */
function measuring(table: Record<string, Record<string, number>>) {
  return (key: string): LabelEngravability[] => {
    const opened = table[key] ?? {};
    return Object.keys(AREA).map((id) => row(id, opened[id] ?? 0));
  };
}

/** The badge's own shape: the wide bits miss, the mid one clears most, the fine one nearly all. */
const BADGE = {
  wide: { big: 0, small: 0 },
  mid: { big: 660, small: 0 },
  fine: { big: 870, small: 90 },
};
const TOOLS = [tool('wide', 3.175, { shoulderLength: 12 }), tool('mid', 2), tool('fine', 0.6)];

/**
 * A `Reachability` built by hand, for the cases a real table cannot hold — see the zero-diameter
 * case below. Only the five things `roughPick` reads are filled in; everything else is inert.
 */
function tableOf(rows: { key: string; diameter: number; share: number }[]): Reachability {
  return {
    cutters: rows.map((r) => ({
      key: r.key,
      name: `${r.key} cutter`,
      diameter: r.diameter,
      shape: 'flat',
      vTrace: false,
      vCarve: false,
      excluded: null,
      excludedNote: null,
      rows: [],
      bestRatio: r.share,
      worstRatio: r.share,
      qualifies: true,
    })),
    items: [],
    recommendation: {
      key: null,
      compromise: false,
      reason: 'built by hand',
      conditionNote: null,
      catalogueNote: null,
      selectedNote: null,
      candidates: [],
    },
    totalShare: new Map(rows.map((r) => [r.key, r.share])),
  };
}

describe('roughPick (#410)', () => {
  it('takes the cutter with the largest ⌀² × share, and says so with this design’s numbers', () => {
    const reach = reachabilityFor(jobWith('big', 'small'), TOOLS, [], measuring(BADGE));
    const pick = roughPick(reach);
    // ⌀2 mm × 66 % of the design = 2.64, against ⌀0.6 mm × 96 % = 0.35. The wide bit is not
    // "a slow cutter" here, it is an absent one, and a zero share is not a candidate at all.
    expect(pick.chosen?.key).toBe('mid');
    expect(pick.chosen?.score).toBeCloseTo(4 * 0.66, 10);
    expect(pick.ranked.map((c) => c.key)).toEqual(['mid', 'fine']);
    expect(pick.reason).toContain('mid cuts first');
    expect(pick.reason).toContain('2.64');
    expect(pick.reason).toContain('66 %');
    // The runners-up are in the sentence, so a person can check the rule against the table.
    expect(pick.reason).toContain('0.6 mm at 96 %');
  });

  it('never lets an EXCLUDED cutter win, however much of the design it would reach', () => {
    // A ball nose measures as well as anything in this fixture, and is still not a rougher: the
    // exclusion happens before the measurement, and a rule that ranked the table alone would pick
    // a cutter the generator refuses.
    const tools = [tool('ball', 3.175, { shape: 'ball' }), ...TOOLS.slice(1)];
    const reach = reachabilityFor(jobWith('big', 'small'), tools, [], measuring({ ...BADGE, ball: BADGE.fine }));
    const pick = roughPick(reach);
    expect(pick.ranked.map((c) => c.key)).not.toContain('ball');
    expect(pick.chosen?.key).toBe('mid');
  });

  it('drops a cutter with no stated diameter rather than ranking it last', () => {
    // A missing number is not a small one. `diameter²` would sort a zero to the bottom anyway — the
    // point is that it is not in the ranked list at all, because "unknown" is not "tiny".
    //
    // The table is built by hand because `reachabilityFor` cannot produce this case: it pre-filters
    // by FEEDS before the rule runs, and a feed table is keyed by diameter, so a cutter with no
    // stated diameter is excluded as `no-feeds` and never reaches `roughPick`. `roughPick` is pure
    // and reads exactly the key, name, diameter, exclusion and share, so a table built here is a
    // table the rule really sees.
    const table = tableOf([
      { key: 'unstated', diameter: 0, share: 0.9 },
      { key: 'mid', diameter: 2, share: 0.66 },
    ]);
    const pick = roughPick(table);
    expect(pick.ranked.map((c) => c.key)).toEqual(['mid']);
    expect(pick.chosen?.key).toBe('mid');
  });

  it('breaks a structural TIE by key, and says that it was the key', () => {
    // The share is a function of the diameter, so two bits of one diameter always tie. A rule whose
    // answer depended on the order a catalogue listed its rows in would not be a rule.
    const tied = [tool('b-mid', 2), tool('a-mid', 2)];
    const measured = { 'b-mid': BADGE.mid, 'a-mid': BADGE.mid };
    const pick = roughPick(reachabilityFor(jobWith('big', 'small'), tied, [], measuring(measured)));
    expect(pick.chosen?.key).toBe('a-mid');
    expect(pick.reason).toContain('2 cutters score that same number');
    expect(pick.reason).toContain('a-mid is the first of them by key');
    expect(pick.reason).toContain('--tool');
  });

  it('answers null — not a zero-diameter cutter — when nothing reaches anything', () => {
    const reach = reachabilityFor(jobWith('big'), [tool('wide', 3.175)], [], measuring({ wide: { big: 0 } }));
    const pick = roughPick(reach);
    expect(pick.chosen).toBeNull();
    expect(pick.ranked).toEqual([]);
    expect(pick.reason).toContain('no measured cutter reaches any part of this design');
  });
});

describe('unroughedItems (#410)', () => {
  it('names the items the first cutter cannot enter AT ALL, with the area it cannot cut', () => {
    const reach = reachabilityFor(jobWith('big', 'small'), TOOLS, [], measuring(BADGE));
    // `small` is reached by neither wide nor mid; `big` is missed by wide alone, which is a cutter
    // choice the rule already made and a different sentence.
    const items = unroughedItems(reach, 'mid');
    expect(items.map((i) => i.id)).toEqual(['small']);
    expect(items[0]!.area).toBe(100);
    expect(items[0]!.depth).toBe(1);
    expect(unroughedItems(reach, 'fine')).toEqual([]);
  });
});

describe('restToolPick (#410)', () => {
  it('picks the SMALLEST cutter that reaches strictly more, and reports both shares', () => {
    const reach = reachabilityFor(jobWith('big', 'small'), TOOLS, [], measuring(BADGE));
    const pick = restToolPick(reach, 'mid');
    expect(pick.cutter?.key).toBe('fine');
    expect(pick.reason).toContain('66 % → 96 %');
  });

  it('separates “only one cutter was measured” from “the first already reaches everything”', () => {
    const one = reachabilityFor(jobWith('big'), [tool('line-1', 1)], [], measuring({ 'line-1': { big: 900 } }));
    expect(restToolPick(one, 'line-1').reason).toContain('no second cutter was measured');

    const all = reachabilityFor(
      jobWith('big'),
      [tool('mid', 2), tool('fine', 0.6)],
      [],
      measuring({ mid: { big: 900 }, fine: { big: 900 } }),
    );
    const pick = restToolPick(all, 'mid');
    expect(pick.cutter).toBeNull();
    expect(pick.reason).toContain('one program is the whole job');
  });
});

describe('vBitRestRefusal (#486)', () => {
  /** The bench's 30° × 0.3 V-bit — the cutter this issue was opened on. */
  const vbit = (): Tool =>
    flatEndMill(0.3, {
      name: 'Single Flute Engraving Bit — 30° × 0.3',
      shape: 'engraving',
      typeText: 'Engraving',
      tipDiameter: 0.3,
      diameter: 3.175,
      halfAngle: 15,
      angle: 30,
    });

  it('names the V-carve as the job itself instead of measuring a V-bit as a rest cutter', () => {
    const job = jobWith('big');
    expect(vBitRestRefusal(job, vbit())).toBe(
      'a V-bit is not a rest cutter here — on a region job it is the V-carve cutter itself, not a second program (#221)',
    );
    // The same cutter on a job with nothing left to rest-cut is not a refusal: a trace-only job
    // takes a V-bit as its ordinary cutter, and the route must not refuse it.
    expect(vBitRestRefusal(jobWith(), vbit())).toBeNull();
  });

  it('leaves a flat cutter alone, whatever the job holds', () => {
    expect(vBitRestRefusal(jobWith('big'), flatEndMill(0.6))).toBeNull();
  });

  it('adds no rest pass when the V-carve is the first cutter (#221)', () => {
    const vbit: ToolLibraryEntry = {
      key: 'inv:v30',
      tool: flatEndMill(0.3, {
        name: '30° engraving bit',
        shape: 'engraving',
        typeText: 'Engraving',
        tipDiameter: 0.3,
        diameter: 3.175,
        halfAngle: 15,
        angle: 30,
        shoulderLength: 12,
      }),
      provenance: 'restPass test',
    };
    // Every flat loses the detail, so the V-carve is the recommendation.
    const reach = reachabilityFor(jobWith('big'), [vbit, tool('flat', 1.0)], [], () => [row('big', 0)]);
    expect(reach.recommendation.key).toBe('inv:v30');
    const pick = restToolPick(reach, 'inv:v30');
    expect(pick.cutter).toBeNull();
    expect(pick.reason).toContain('the V-carve is the whole job at the colour plane');
    expect(pick.reason).toContain('no flat rest pass to add');
  });
});

describe('restJobFor (#410)', () => {
  /** A job with everything `restJobFor` has to account for: a void, a cutter, and a typed feed. */
  function fullJob(): EngraveJob {
    const job = jobWith('big');
    job.vectors = [
      {
        kind: 'vector',
        id: 'shp-1',
        name: 'Single Barrel',
        sourceName: 'Single Barrel',
        contours: [
          [
            [0, 0],
            [10, 0],
            [10, 4],
            [0, 4],
          ],
        ],
        fillRule: 'EvenOdd',
        width: 10,
        height: 4,
        position: { x: 0, y: 0 },
        rotation: 0,
        depth: 0.985,
        enabled: true,
      },
    ];
    job.keepOuts = [
      {
        kind: 'rect',
        id: 'ko-1',
        name: 'Magnet pocket',
        position: { x: 12.55, y: 10 },
        rotation: 0,
        enabled: true,
        width: 13,
        height: 45,
        cornerRadius: 0,
        // Measured from the blank's BOTTOM face, not the engraved one — the frame a void lives in.
        zCeiling: 2.3,
      },
    ];
    job.toolKey = 'mid';
    job.tool = flatEndMill(2);
    job.cutOverride = { rpm: 10000, feed: 400, plungeFeed: 100, stepDown: 0.5, stepOver: 0.9 };
    job.sources = { tool: 'user', stock: { length: 'user' } };
    return job;
  }

  const ring: [number, number][] = [
    [1, 1],
    [9, 1],
    [9, 3],
    [1, 3],
  ];

  it('turns measured regions into items of the SAME blank, named so the operator can tell them apart', () => {
    const job = fullJob();
    const rest = restJobFor(job, [{ id: 'shp-1', name: 'Single Barrel', depth: 0.985, polygons: [ring] }], 'fine');
    expect(rest.vectors).toHaveLength(1);
    const v = rest.vectors![0]!;
    // The name has to say where the region CAME FROM: a person reading the program back must be
    // able to tell a region the FILE asked for from one the first program left (#410).
    expect(v.sourceName).toBe('rest of Single Barrel');
    expect(v.name).toBe('rest of Single Barrel');
    expect(v.id).toBe('rest-1');
    // The measurement was made in the stock frame, so nothing is re-placed or re-turned here.
    expect(v.contours).toEqual([ring]);
    expect(v.position).toEqual({ x: 0, y: 0 });
    expect(v.rotation).toBe(0);
    expect(v.depth).toBe(0.985);
    expect(v.enabled).toBe(true);
    expect(v.fillRule).toBe('EvenOdd');
    // The panel's own width/height for an imported outline, from the ring's bounding box.
    expect(v.width).toBeCloseTo(8, 10);
    expect(v.height).toBeCloseTo(2, 10);
  });

  it('takes the item name out of the operation descriptor, and writes its sizes at the micron', () => {
    const job = fullJob();
    const descriptor = 'Pocket outline "(Like the Whiskey)" (2 contours, 41.593054×5.171349mm)';
    const rest = restJobFor(
      job,
      [
        {
          id: 'shp-1',
          name: descriptor,
          depth: 0.985,
          polygons: [
            [
              [1, 1],
              [9.1234567, 1],
              [9.1234567, 3.7654321],
              [1, 3.7654321],
            ],
          ],
        },
      ],
      'fine',
    );
    const v = rest.vectors![0]!;
    // The descriptor's quoted item name, not the descriptor itself: the header quotes the name
    // again, so carrying the whole sentence made nested quotes (#437).
    expect(v.name).toBe('rest of (Like the Whiskey)');
    expect(v.sourceName).toBe('rest of (Like the Whiskey)');
    // The ring is measured at float precision; the ITEM is written at the job's micron.
    expect(v.width).toBe(8.123);
    expect(v.height).toBe(2.765);

    // An unnamed item has no quoted part; the descriptor's trailing size clause is dropped instead.
    const unnamed = restJobFor(job, [{ id: 'shp-2', name: 'Pocket rect (1 contour, 8×2mm)', depth: 1, polygons: [ring] }], 'fine');
    expect(unnamed.vectors![0]!.name).toBe('rest of Pocket rect');
  });

  it('empties every design item list and keeps the BLANK’s own facts', () => {
    const job = fullJob();
    const rest = restJobFor(job, [{ id: 'shp-1', depth: 0.985, polygons: [ring] }], 'fine');
    // A design item left here would re-cut the whole design at the fine bit's pace — an hour of
    // air-cutting in the middle of the part.
    expect(rest.labels).toEqual([]);
    expect(rest.shapes).toEqual([]);
    expect(rest.combined).toEqual([]);
    expect(rest.traces).toEqual([]);
    expect(rest.drills).toEqual([]);
    // A void in the blank's underside is a property of the BLANK, which this program shares: a rest
    // pass that could cut into the magnet pocket would be a worse mistake than the one it fixed.
    expect(rest.keepOuts).toEqual(job.keepOuts);
    expect(rest.stock).toEqual(job.stock);
    expect(rest.name).toBe(`${job.name} rest`);
  });

  it('clears the first cutter’s identity — key, materialised tool AND its typed feed', () => {
    const job = fullJob();
    const rest = restJobFor(job, [{ id: 'shp-1', depth: 0.985, polygons: [ring] }], 'fine');
    expect(rest.toolKey).toBe('fine');
    // Left in place the first program's materialised cutter is read back AHEAD of `toolKey`
    // (`jobTool`), so the rest program would be generated, verified and simulated for the wrong bit.
    expect(rest.tool).toBeNull();
    // `cutOverride` is a hand-typed feed for ONE cutter; tool 2 has its own feed-row numbers, and
    // carrying the first bit's across would be a claim about a cutter nobody measured.
    expect(rest.cutOverride).toBeUndefined();
    // The route derived this key from the reachability numbers rather than a person choosing it.
    expect(rest.sources?.tool).toBe('computed');
    // The stamp is added, not swapped in: the blank's own provenance is the blank's.
    expect(rest.sources?.stock).toEqual({ length: 'user' });
  });

  it('leaves the design job alone — the second program is a COPY, not an edit', () => {
    const job = fullJob();
    const vectors = job.vectors;
    const toolKey = job.toolKey;
    restJobFor(job, [{ id: 'shp-1', depth: 0.985, polygons: [ring] }], 'fine');
    expect(job.vectors).toBe(vectors);
    expect(job.toolKey).toBe(toolKey);
    expect(job.tool).not.toBeNull();
  });
});
