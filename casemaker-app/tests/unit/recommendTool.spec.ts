// The cutter recommendation (#211). The pure rule is exercised with injected measurements, so
// every case but the last needs no wasm; the last one measures the DEFAULT job with the real
// library and asserts the 1.0 mm cutter wins over the 3.175 mm one, exactly as the issue asks.

import { describe, it, expect, vi } from 'vitest';

import { tl } from './helpers/manifoldExec';
import {
  recommendTool,
  type ToolCandidate,
  type ToolRecommendation,
} from '@/engine/cnc/engrave/recommendTool';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { labelProfile, toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { flatEndMill, cuttingRadiusForSweep, type Tool } from '@/engine/cnc/tool';
import { TOOL_LIBRARY, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { measureLabels, type LabelEngravability } from '@/workers/sim/engraveGeometry';
import {
  itemConditionSummary,
  type Condition,
  type ConditionSummary,
  type ItemWithCopies,
  type ToolCopy,
} from '@/engine/cnc/toolCondition';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import type { EngraveJob } from '@/types/engraveJob';

/** A library entry built around `flatEndMill`, with lengths/ratios supplied per case. */
function tool(key: string, diameter: number, opts: Partial<Tool> = {}): ToolLibraryEntry {
  return { key, tool: flatEndMill(diameter, opts), provenance: 'recommendTool test' };
}

/** One measured label. `emptyChars` is a COUNT; the rows carry the char list. */
function row(labelId: string, ratio: number, emptyChars = 0): LabelEngravability {
  return {
    labelId,
    glyphArea: 1,
    openedArea: ratio,
    ratio,
    emptyChars: Array.from({ length: emptyChars }, (_, index) => ({ index, char: 'x' })),
    outsideArea: 0,
    polygons: [],
  };
}

/** A one-label job centred in the default stock; the rule only reads text, size, depth, enabled. */
function jobWithLabel(id: string, text: string, depth: number, size = 8): EngraveJob {
  const job = defaultEngraveJob();
  job.labels = [
    {
      id,
      text,
      font: 'sans-default',
      weight: 'bold',
      size,
      position: { x: 50, y: 30 },
      rotation: 0,
      depth,
      enabled: true,
    },
  ];
  return job;
}

/** A `measure` that answers every candidate with the same single row. */
function allRows(ratio: number, emptyChars = 0) {
  return (_toolKey: string): LabelEngravability[] => [row('l1', ratio, emptyChars)];
}

function candidate(rec: ToolRecommendation, key: string): ToolCandidate {
  const c = rec.candidates.find((x) => x.key === key);
  expect(c, `candidate ${key} present`).toBeDefined();
  return c!;
}

describe('recommendTool (#211)', () => {
  it('picks the largest of the qualifying cutters', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const tools = [
      tool('t1.0', 1.0, { shoulderLength: 12 }),
      tool('t2.0', 2.0, { shoulderLength: 12 }),
      tool('t3.175', 3.175, { shoulderLength: 12 }),
    ];
    const measure = (key: string) => (key === 't3.175' ? [row('l1', 0.5)] : [row('l1', 1)]);
    const rec = recommendTool(job, tools, [], measure);
    expect(rec.key).toBe('t2.0');
    expect(rec.compromise).toBe(false);
    expect(rec.reason).toBe('Largest cutter that keeps every item intact.');
    expect(candidate(rec, 't2.0').qualifies).toBe(true);
    expect(candidate(rec, 't3.175').qualifies).toBe(false);
  });

  // #309 — the cutters the user OWNS reach the recommender through the same list as every other
  // tier (#319), keyed `inv:`. Two boxes of one bit are two rows of ONE definition, so the
  // inventory key is the only thing telling them apart — a ranking that keyed on the definition
  // would see one candidate where the user owns two, and could not offer the third at all.
  it('ranks the user’s own cutters by their inventory keys (#309)', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const tools = [tool('inv:aaa', 2.0), tool('inv:bbb', 2.0), tool('inv:wide', 3.175)];
    const rec = recommendTool(job, tools, [], allRows(1));
    expect(rec.key).toBe('inv:wide');
    expect(rec.compromise).toBe(false);
    expect(candidate(rec, 'inv:aaa').qualifies).toBe(true);
    expect(candidate(rec, 'inv:bbb').qualifies).toBe(true);
  });

  it('picks the only qualifying cutter when the others lose detail', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const tools = [tool('t1.0', 1.0), tool('t2.0', 2.0)];
    const measure = (key: string) => [row('l1', key === 't1.0' ? 1 : 0.4)];
    const rec = recommendTool(job, tools, [], measure);
    expect(rec.key).toBe('t1.0');
    expect(rec.compromise).toBe(false);
  });

  it('falls back to the smallest cutter, flagged compromise, naming the worst label', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const tools = [tool('t1.0', 1.0), tool('t2.0', 2.0), tool('t3.175', 3.175)];
    // Every cutter loses detail; the smaller the cutter the less it loses.
    const measure = (key: string) => [row('l1', key === 't1.0' ? 0.4 : key === 't2.0' ? 0.2 : 0.05)];
    const rec = recommendTool(job, tools, [], measure);
    expect(rec.key).toBe('t1.0');
    expect(rec.compromise).toBe(true);
    expect(rec.reason).toContain('CASE');
    expect(rec.reason).toContain('1.0 mm');
    expect(rec.reason).toContain('60 %');
    expect(candidate(rec, 't1.0').worst).toEqual({ labelId: 'l1', ratio: 0.4, emptyChars: 0 });
  });

  it('does not recommend a cutter whose reach is shorter than the deepest label, even at ratio 1', () => {
    const job = jobWithLabel('l1', 'CASE', 2.0);
    const tools = [tool('short', 2.0, { shoulderLength: 1 }), tool('ok', 1.0, { fluteLength: 12 })];
    const rec = recommendTool(job, tools, [], allRows(1));
    expect(rec.key).toBe('ok');
    const short = candidate(rec, 'short');
    expect(short.reachKnown).toBe(true);
    expect(short.reachOk).toBe(false);
    expect(short.qualifies).toBe(false);
  });

  it('excludes a ball nose as not-flat and never measures it', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const ball = tool('ball', 1.0, { shape: 'ball', typeText: 'Ball End' });
    const flat = tool('flat', 1.0);
    const measure = vi.fn((_key: string) => [row('l1', 1)]);
    const rec = recommendTool(job, [ball, flat], [], measure);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledWith('flat');
    expect(candidate(rec, 'ball').excluded).toBe('not-flat');
    expect(candidate(rec, 'flat').excluded).toBeUndefined();
  });

  it('excludes a cutter with no feeds row and never measures it', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const measure = vi.fn((_key: string) => [row('l1', 1)]);
    const rec = recommendTool(job, [tool('big', 5.0), tool('flat', 1.0)], [], measure);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledWith('flat');
    expect(candidate(rec, 'big').excluded).toBe('no-feeds');
  });

  // #325 — and a handed row the machine cannot run does NOT take the cutter out of the list. This
  // is #324's example, inverted: the absurd spindle speed used to make `feedsFor` refuse, and
  // refusing a job the starting table would have cut is exactly what a tier ABOVE the starting
  // table may not do. The row falls through, the cutter stays, and the two calls AGREE — which is
  // the guarantee #324 was written for.
  it('keeps a cutter whose handed row states a number the machine refuses (#325)', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    // The built-in metal cutter's id, with a spindle speed far past the Z1's ceiling: the number is
    // passed over field by field (`feedsFor`), so this candidate is NOT excluded.
    const cutter = tool('t', 1.0, { id: '112111313812' });
    const absurd: FeedCatalogueRow = {
      cutterId: '112111313812',
      material: 'Softwood',
      rpm: 24000,
      feed: 500,
      plungeFeed: 200,
      stepDown: 0.5,
    };
    const measure = vi.fn((_key: string) => [row('l1', 1)]);
    const withRows = recommendTool(job, [cutter], [absurd], measure);
    expect(candidate(withRows, 't').excluded).toBeUndefined();
    expect(withRows.key).toBe('t');

    // The same cutter with no rows to read is the same recommendation. After #325 no catalogue row
    // can decide this pre-filter, so what a row still decides for a picker is nothing — the
    // hand-over is observable where it matters, in the NUMBERS `engraveGenerate.spec.ts` reads out
    // of the `.nc` (the feed catalogue reaches the worker, #324).
    expect(recommendTool(job, [cutter], [], allRows(1)).key).toBe('t');
  });

  it('still qualifies a cutter with unknown reach, and says so in the note', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const rec = recommendTool(job, [tool('unknown-reach', 1.0)], [], allRows(1));
    expect(rec.key).toBe('unknown-reach');
    expect(rec.compromise).toBe(false);
    expect(candidate(rec, 'unknown-reach').reachKnown).toBe(false);
    expect(rec.reason).toContain('reach not recorded');
  });

  it('is deterministic on ties: known reach wins, then the lower key', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const tied = [tool('z-unknown', 2.0), tool('a-unknown', 2.0)];
    expect(recommendTool(job, tied, [], allRows(1)).key).toBe('a-unknown');

    const reachTie = [tool('z-unknown', 2.0), tool('y-known', 2.0, { shoulderLength: 12 })];
    expect(recommendTool(job, reachTie, [], allRows(1)).key).toBe('y-known');
  });

  it('returns key null only when no eligible cutter exists', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const rec = recommendTool(job, [tool('ball', 1.0, { shape: 'ball', typeText: 'Ball End' })], [], allRows(1));
    expect(rec.key).toBeNull();
    expect(rec.reason).toContain('flat end mill');

    const empty = recommendTool(job, [], [], allRows(1));
    expect(empty.key).toBeNull();
    expect(empty.candidates).toEqual([]);
  });
});

describe('recommendTool integration (#211)', () => {
  it('recommends the 1.0 mm cutter over the 3.175 mm one for the default job (#200)', () => {
    const job = defaultEngraveJob();
    const plan = toPartPlan(job);

    const perChar = (labelId: string) => {
      const label = job.labels.find((l) => l.id === labelId);
      if (!label) throw new Error(`no label ${labelId}`);
      return [...label.text].map((char) => ({
        char,
        profile: labelProfile({ ...label, text: char }, job.customFonts),
      }));
    };

    const measure = (toolKey: string): LabelEngravability[] => {
      const entry = TOOL_LIBRARY.find((e) => e.key === toolKey);
      if (!entry) throw new Error(`no tool ${toolKey}`);
      const radius = cuttingRadiusForSweep(entry.tool);
      if (!radius.ok) throw new Error(radius.reason);
      return measureLabels(tl, plan, radius.radius, job.edgeMargin, perChar);
    };

    const rec = recommendTool(job, TOOL_LIBRARY, [], measure);
    expect(rec.key).toBe('flat-1.0');
    // The wide cutter is the one that loses the thin strokes of the smaller labels.
    expect(candidate(rec, 'flat-3.175x12-metal').qualifies).toBe(false);
  });
});

// #405 — a TRACE-ONLY job may take a V-bit, and a job with a region may not. The two rules the
// issue states are what these cases hold: a V-bit is never a stand-in for a flat end mill where a
// glyph has to be OPENED (one cutting width is needed, and a cone's width changes with depth), and
// a trace follows the line, so a cone is exactly the cutter for it.
describe('recommendTool and V-bits (#405)', () => {
  /** The text job's default cutter: the 30° engraving bit, 0.3 mm tip, 3.175 mm shank. */
  const vBit = (key = 'inv:v30', over: Partial<Tool> = {}): ToolLibraryEntry => ({
    key,
    tool: flatEndMill(0.3, {
      name: 'Single Flute Engraving Bit 30 x 0.3',
      typeText: 'Engraving',
      shape: 'engraving',
      tipDiameter: 0.3,
      diameter: 3.175,
      angle: 30,
      halfAngle: 15,
      shoulderLength: 12,
      ...over,
    }),
    provenance: 'recommendTool test',
  });

  /**
   * A PLA job whose only enabled items are traces: every region list is empty, which is the state
   * that may take a cone. `material` is a parameter because the V row is PLA's alone.
   */
  const traceJob = (material: EngraveJob['stock']['material'] = 'pla'): EngraveJob => {
    const base = defaultEngraveJob();
    return {
      ...base,
      stock: { ...base.stock, material },
      labels: [],
      shapes: [],
      combined: [],
      vectors: [],
      traces: [
        {
          id: 'tr1',
          kind: 'stroke-label',
          text: 'Single Barrel',
          font: 'hershey-simplex',
          size: 8,
          position: { x: 50, y: 30 },
          rotation: 0,
          depth: 1,
          enabled: true,
        },
      ],
    };
  };

  it('excludes a V-bit from a job that holds a region item, and never measures it', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const measure = vi.fn((_key: string) => [row('l1', 1)]);
    const rec = recommendTool(job, [vBit(), tool('flat', 1.0)], [], measure);
    // One candidate measured — the flat one. A cone is not measured against a glyph at all, because
    // a cone has no single width for the glyph's opening to be measured against.
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledWith('flat');
    expect(candidate(rec, 'inv:v30').excluded).toBe('not-flat');
    expect(candidate(rec, 'flat').excluded).toBeUndefined();
    expect(rec.key).toBe('flat');
  });

  it('qualifies a V-bit for a trace-only job and measures it', () => {
    const job = traceJob();
    const measure = vi.fn((_key: string) => [row('tr1', 1)]);
    const rec = recommendTool(job, [vBit()], [], measure);
    expect(measure).toHaveBeenCalledWith('inv:v30');
    expect(candidate(rec, 'inv:v30').excluded).toBeUndefined();
    expect(candidate(rec, 'inv:v30').qualifies).toBe(true);
    // The cone's own cutting diameter is its TIP (0.3), not the 3.175 shank — the tip is what cuts.
    expect(compromiseOf(rec).diameter).toBe(0.3);
    expect(rec.key).toBe('inv:v30');
    expect(rec.compromise).toBe(false);
  });

  it('still excludes a V-bit with no V row for the material', () => {
    // The V row is PLA's alone (#405): a softwood trace job has no numbers for a cone, and Makera's
    // own rows state a flat end mill's numbers, never a cone's — so there is nothing to fall back on.
    const rec = recommendTool(traceJob('softwood'), [vBit()], [], allRows(1));
    expect(candidate(rec, 'inv:v30').excluded).toBe('no-feeds');
    expect(rec.key).toBeNull();
  });

  it('names the V-bit option when a job with a region has nothing else to recommend', () => {
    const rec = recommendTool(jobWithLabel('l1', 'CASE', 1), [vBit()], [], allRows(1));
    expect(rec.key).toBeNull();
    expect(rec.reason).toContain('V-bit');
  });
});

// #415/#442 — the cutter's CONDITION, as the operator set it. The summaries below are built by
// `toolCondition`'s own `itemConditionSummary` — the very function `toolRegistryStore` fills the
// lookup with — so a note asserted here is the note the panel will print, and `conditionsOf` is the
// plain table the main thread sends into the sim worker.
describe('recommendTool — the cutters’ condition (#442)', () => {
  /** One described copy of a cutter, in its box. */
  function copyOf(id: string, condition: Condition): ToolCopy {
    return {
      id,
      condition,
      whereabouts: { kind: 'box' },
      runtimeWarnMinutes: null,
      notes: null,
      runtimeMinutes: null,
    };
  }

  /** The summary the inventory would build for `quantity` copies of a cutter, the first described. */
  function summaryOf(id: string, condition: Condition, quantity = 1): ConditionSummary {
    const item: ItemWithCopies = { id, quantity, copies: [copyOf(`${id}-1`, condition)] };
    return itemConditionSummary(item);
  }

  /** A registry key and its condition, as the third argument's table holds them. */
  function held(id: string, condition: Condition): [string, ConditionSummary] {
    return [`inv:${id}`, summaryOf(id, condition)];
  }

  function conditionsOf(...rows: [string, ConditionSummary][]): ReadonlyMap<string, ConditionSummary> {
    return new Map(rows);
  }

  it('drops a cutter whose every copy is marked broken, by name, before measuring it', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const tools = [tool('inv:good', 1.0), tool('inv:dead', 3.175)];
    const measure = vi.fn((_key: string) => [row('l1', 1)]);
    const rec = recommendTool(job, tools, [], measure, conditionsOf(held('good', 'used'), held('dead', 'broken')));

    // 3.175 mm would win on size alone; the operator has said it cannot cut, so it never even gets
    // measured — a catalogue row or a detail ratio for a bit that cannot cut is not worth computing.
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledWith('inv:good');
    expect(candidate(rec, 'inv:dead').excluded).toBe('broken');
    expect(candidate(rec, 'inv:dead').condition?.usable).toBe(0);
    expect(rec.key).toBe('inv:good');
  });

  it('prefers a fresh copy to a worn one of the same diameter, and says nothing about it', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    // Same diameter, same unknown reach: the key order alone would recommend the worn one first.
    const tools = [tool('inv:aworn', 1.0), tool('inv:bfresh', 1.0)];
    const rec = recommendTool(job, tools, [], allRows(1), conditionsOf(held('aworn', 'worn'), held('bfresh', 'new')));
    expect(rec.key).toBe('inv:bfresh');
    expect(rec.conditionNote).toBeNull();
  });

  it('still picks a worn cutter when it is the only one, and carries the warning', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const rec = recommendTool(job, [tool('inv:only', 1.0)], [], allRows(1), conditionsOf(held('only', 'worn')));
    expect(rec.key).toBe('inv:only');
    // The warning is `toolCondition`'s own sentence, not a second spelling of it.
    expect(rec.conditionNote).toBe(summaryOf('only', 'worn').note);
    expect(rec.conditionNote).toContain('check it before the cut');
  });

  it('does not let a fresh small cutter outrank a worn large one', () => {
    // The decision this pins: condition breaks a TIE on diameter, it is not a priority over it. A
    // 2.0 mm cutter that keeps every item intact is still the right tool for the job even if the copy
    // on the bench has some hours on it — it clears more and it is stiffer than a fresh 1.0 mm.
    const job = jobWithLabel('l1', 'CASE', 1);
    const rec = recommendTool(
      job,
      [tool('inv:small', 1.0), tool('inv:big', 2.0)],
      [],
      allRows(1),
      conditionsOf(held('small', 'new'), held('big', 'worn')),
    );
    expect(rec.key).toBe('inv:big');
    // Both qualify (1.0 and 2.0 mm both have softwood rows), so the pick is a real ranking and not
    // an exclusion: the worn big one wins on diameter, and carries its caution into the panel.
    expect(candidate(rec, 'inv:small').qualifies).toBe(true);
    expect(candidate(rec, 'inv:big').qualifies).toBe(true);
    expect(rec.conditionNote).toContain('worn');
  });

  it('treats a cutter the table says nothing about as unstated, never as worn or broken', () => {
    // A catalogue row, a built-in, or a bench whose inventory has not loaded: `null` is "nobody has
    // said", which is a different answer from "worn", and it must not read as a caution.
    const job = jobWithLabel('l1', 'CASE', 1);
    const rec = recommendTool(job, [tool('cat:x', 1.0)], [], allRows(1), conditionsOf(held('other', 'broken')));
    expect(rec.key).toBe('cat:x');
    expect(candidate(rec, 'cat:x').condition).toBeNull();
    expect(rec.conditionNote).toBeNull();
  });

  it('says why nothing was picked when every cutter that could cut is marked broken', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    const rec = recommendTool(
      job,
      [tool('inv:one', 1.0), tool('inv:two', 2.0)],
      [],
      allRows(1),
      conditionsOf(held('one', 'broken'), held('two', 'broken')),
    );
    expect(rec.key).toBeNull();
    expect(rec.reason).toContain('2 other cutters are marked broken');
    // The base sentence is kept: a broken cutter is one reason among the others, and the list may
    // also hold cutters refused for their shape or their feeds.
    expect(rec.reason).toContain('flat end mill');
  });

  it('behaves exactly as before when no condition table is handed in', () => {
    // The web build with no service, and every caller that has no inventory: no cutter is excluded
    // and none is cautioned, because the app knows of no possession of any of them.
    const job = jobWithLabel('l1', 'CASE', 1);
    const rec = recommendTool(job, [tool('flat', 1.0)], [], allRows(1));
    expect(rec.key).toBe('flat');
    expect(rec.conditionNote).toBeNull();
    expect(candidate(rec, 'flat').condition).toBeNull();
  });
});

/** The recommended candidate itself, for the fields the pick's own assertions read. */
function compromiseOf(rec: ToolRecommendation): ToolCandidate {
  const c = rec.candidates.find((x) => x.key === rec.key);
  expect(c, `the recommended candidate ${rec.key}`).toBeDefined();
  return c!;
}
