// The cutter recommendation (#211). The pure rule is exercised with injected measurements, so
// every case but the last needs no wasm; the last one measures the DEFAULT job with the real
// library and asserts the 1.0 mm cutter wins over the 3.175 mm one, exactly as the issue asks.

import { describe, it, expect, vi } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import {
  recommendTool,
  type ToolCandidate,
  type ToolRecommendation,
} from '@/engine/cnc/engrave/recommendTool';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { labelProfile, toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { flatEndMill, cuttingDiameter, cuttingRadiusForSweep, statedCuttingSize, type Tool } from '@/engine/cnc/tool';
import { TOOL_LIBRARY, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { measureLabels, type LabelEngravability } from '@/workers/sim/engraveGeometry';
import {
  itemConditionSummary,
  type Condition,
  type ConditionSummary,
  type ItemWithCopies,
  type ToolCopy,
} from '@/engine/cnc/toolCondition';
import { catalogueCoverageFor, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { viseForNewJob } from '@/engine/cnc/fixture';
import { defaultBadgeParams } from '@/types/badge';
import type { EngraveCutout, EngraveDrill, EngraveJob, EngraveLabel, EngraveShape } from '@/types/engraveJob';

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
    // The default job is softwood, and the row is a Softwood row — the catalogue LISTS this cutter
    // for the job's material (#455 asks that question before feeds). The absurd RPM is what this
    // case is about; the material only has to be one the catalogue-and-mapping rule accepts.
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
    // #726 W22 — the caveat is its own plain sentence, not a parenthetical.
    expect(rec.reason).toContain('Its reach is not recorded, so it was not checked against the holder.');
    expect(rec.reason).not.toContain('(reach not recorded)');
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

  it('offers a V-bit on a region job as the V-carve cutter, without measuring it as a flat disc', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    // The V row is PLA's; the default job is softwood, where a V-bit is honestly refused at feeds.
    job.stock = { ...job.stock, material: 'pla' };
    const measure = vi.fn((_key: string) => [row('l1', 1)]);
    const rec = recommendTool(job, [vBit(), tool('flat', 1.0)], [], measure);
    // One candidate measured — the flat one. A cone is not measured against a glyph at all, because
    // a cone has no single width for the glyph's opening to be measured against; its qualification
    // is the colour-plane model (#221).
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledWith('flat');
    expect(candidate(rec, 'inv:v30').excluded).toBeUndefined();
    expect(candidate(rec, 'inv:v30').vCarve).toBe(true);
    expect(candidate(rec, 'inv:v30').qualifies).toBe(true);
    // The flat keeps the pick while it qualifies: larger diameter, and a pocket is the simpler cut.
    expect(candidate(rec, 'flat').excluded).toBeUndefined();
    expect(candidate(rec, 'flat').vCarve).toBeUndefined();
    expect(rec.key).toBe('flat');
  });

  it('picks the V-carve when no flat keeps the detail', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    job.stock = { ...job.stock, material: 'pla' };
    const rec = recommendTool(job, [vBit(), tool('flat', 1.0)], [], (_key) => [row('l1', 0.1)]);
    expect(rec.key).toBe('inv:v30');
    expect(rec.compromise).toBe(false);
    // The reason is the strategy sentence, not "largest cutter that keeps every item intact": the
    // V-carve is correct at the colour plane, and the panel prints the same constant.
    expect(rec.reason).toBe(
      'V-carve — the design is cut at the colour plane, so the groove width there is the design.',
    );
  });

  it('does not mark a ball nose as the V-carve case', () => {
    // The flag is about the CUTTER KIND and the job, not about being non-flat: a ball nose keeps
    // the generic phrase, because no V-carve is what a ball nose would be.
    const job = jobWithLabel('l1', 'CASE', 1);
    const ball = tool('ball', 1.0, { shape: 'ball', typeText: 'Ball End' });
    const rec = recommendTool(job, [ball, tool('flat', 1.0)], [], vi.fn((_key: string) => [row('l1', 1)]));
    expect(candidate(rec, 'ball').excluded).toBe('not-flat');
    expect(candidate(rec, 'ball').vCarve).toBeUndefined();
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
    // The V row is PLA's alone (#405): a softwood trace job has no numbers for a cone, and this
    // V-bit carries no Makera id for a catalogue row to name it by (#732), so there is nothing to
    // fall back on. (The catalogue does state engraving rows — for cutters that carry an id.)
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

// #455 — the catalogue's MATERIAL LIST, not merely its numbers. A cutter must not be recommended
// for a material the catalogue does not list it for; picking one by hand warns by name. Rows here
// are SYNTHETIC — no vendor table is committed — and each case is a shape the real catalogue has.
describe('recommendTool and the catalogue’s material list (#455)', () => {
  const CORN = 'TiN Coating Corn Bit - 1/8" Shank 0.6mm * 3mm';
  /** The incident's cutter: a corn bit Makera lists for PCB and carbon fibre, never for plastic. */
  const corn = (key: string): ToolLibraryEntry => ({
    key,
    tool: flatEndMill(0.6, { id: '900000000001', name: CORN }),
    provenance: 'recommendTool test',
  });
  const catRow = (cutterId: string, material: string): FeedCatalogueRow => ({
    cutterId,
    material,
    rpm: 12000,
    feed: 500,
    plungeFeed: 200,
    stepDown: 0.4,
  });

  /** The default job is softwood; these cases are the printed-blank plastic the incident cut. */
  function plaJob(): EngraveJob {
    const job = jobWithLabel('l1', 'CASE', 1);
    job.stock = { ...job.stock, material: 'pla' };
    return job;
  }

  it('excludes a cutter the catalogue lists only for other materials, and says which', () => {
    const job = plaJob();
    const measure = vi.fn((_key: string) => [row('l1', 1)]);
    const rec = recommendTool(
      job,
      [corn('inv:corn')],
      [catRow('900000000001', 'PCB'), catRow('900000000001', 'Carbon Fiber')],
      measure,
    );

    // It is out before it is measured: a detail ratio for a bit the vendor says is for PCB is not a
    // number worth computing.
    expect(measure).not.toHaveBeenCalled();
    const c = candidate(rec, 'inv:corn');
    expect(c.excluded).toBe('no-catalogue-row');
    // The warning is BY NAME, with the vendor's own material words and the job's material named.
    expect(c.catalogueNote).toContain(CORN);
    expect(c.catalogueNote).toContain('PCB');
    expect(c.catalogueNote).toContain('Carbon Fiber');
    expect(c.catalogueNote).toContain('not PLA');

    expect(rec.key).toBeNull();
    expect(rec.reason).toContain('can be recommended for this material');
    expect(rec.reason).toContain('PCB');
  });

  it('takes the labelled plastic mapping when the catalogue has no PLA row', () => {
    const job = plaJob();
    // Acrylic listed FIRST on purpose: the map prefers ABS, so the choice must not follow the
    // catalogue's row order.
    const rec = recommendTool(
      job,
      [corn('inv:corn')],
      [catRow('900000000001', 'Acrylic'), catRow('900000000001', 'ABS')],
      allRows(1),
    );

    expect(rec.key).toBe('inv:corn');
    expect(candidate(rec, 'inv:corn').excluded).toBeUndefined();
    expect(rec.catalogueNote).toContain('ABS row standing in');
    expect(rec.catalogueNote).toContain('mapping this app makes');
    expect(rec.catalogueNote).toContain('not something Makera says about PLA');
  });

  it('keeps an owned cutter the catalogue cannot name, with an honest note instead of a refusal', () => {
    // PLA job, and a real catalogue IS loaded — with rows for somebody else's cutter. "No rows"
    // for this one means "no twin", the case the issue says must rest on the operator.
    const mine: ToolLibraryEntry = {
      key: 'user:mine',
      tool: flatEndMill(1.0),
      provenance: 'recommendTool test',
    };
    const rec = recommendTool(
      plaJob(),
      [mine],
      [catRow('900000000001', 'ABS')],
      allRows(1),
    );

    expect(rec.key).toBe('user:mine');
    expect(candidate(rec, 'user:mine').excluded).toBeUndefined();
    // #726 W22 — plain words. "It carries no Makera cutter id" described the record, not the
    // decision; the operator is told what it means for them.
    expect(rec.catalogueNote).toBe("Makera's catalogue does not list this cutter, so this pick is yours.");
    expect(rec.catalogueNote).not.toContain('cutter id');
  });

  it('warns by name when the job names a cutter the catalogue does not recommend', () => {
    const job = plaJob();
    job.toolKey = 'inv:corn';
    const rec = recommendTool(
      job,
      [corn('inv:corn'), tool('inv:ok', 1.0)],
      [catRow('900000000001', 'PCB'), catRow('900000000001', 'Carbon Fiber')],
      allRows(1),
    );

    // The recommendation picks another cutter, and the warning about the job's own choice still
    // travels — this is the "picked by hand" case, not the auto-pick.
    expect(rec.key).toBe('inv:ok');
    expect(rec.selectedNote).toContain(CORN);
    expect(rec.selectedNote).toContain('PCB');
    expect(rec.selectedNote).toContain('not PLA');
    expect(rec.selectedNote).toContain('still cuts');
    // A warning, not a block: the job's cutter is excluded from the PICK and still generated.
    expect(candidate(rec, 'inv:corn').excluded).toBe('no-catalogue-row');
  });

  it('does not promise a cut when the confirmed id’s cutter has changed geometry (#732)', () => {
    const job = plaJob();
    job.toolKey = 'inv:corn';
    // The catalogue's own tool list now says this id is a 6 mm cutter; the owned bit is 0.6 mm.
    const stale: FeedCatalogueRow = {
      ...catRow('900000000001', 'ABS'),
      cutter: { shape: 'flat', diameter: 6, tipDiameter: 6 },
    };
    const rec = recommendTool(job, [corn('inv:corn')], [stale], allRows(1));

    expect(rec.selectedNote).toContain('900000000001');
    expect(rec.selectedNote).toContain('6 mm');
    expect(rec.selectedNote).toContain('0.6 mm');
    expect(rec.selectedNote).toContain('Clear the match');
    // The feeds now refuse the job outright, so the hand-pick warning must not say it still cuts.
    expect(rec.selectedNote).not.toContain('still cuts');
  });

  it('adds no note when the catalogue row is the material’s own', () => {
    const job = jobWithLabel('l1', 'CASE', 1);
    job.stock = { ...job.stock, material: 'abs' };
    const rec = recommendTool(job, [corn('inv:corn')], [catRow('900000000001', 'ABS')], allRows(1));
    expect(rec.key).toBe('inv:corn');
    expect(rec.catalogueNote).toBeNull();
    expect(rec.selectedNote).toBeNull();
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


// #699 — THE K3 WALK. The house inventory holds a 90° chamfer whose record states no tip, and the
// badge's V-carve recommendation picked it: its SHANK (3.175 mm) was being read as a cutting
// diameter, and the catalogue could not veto an owned cutter without a vendor id. The fix has one
// rule — a computed pick must state its cutting size — and this is the fixture that holds it: the
// badge blank, PLA, the house's chamfer/engraver/flat, and a PLA row for each cutter that has a
// vendor id. The pick is the 1 mm flat end the mockup names.
describe('recommendTool — the computed pick states its size and its material row (#699)', () => {
  // Makera's catalogue has NO PLA row at all (#455: `t_MaterialList` lists no printed-blank
  // filament). A PLA job is answered by the ABS row through the app's labelled mapping — the
  // "PLA row" the issue means is the row this app can use for PLA.
  const PLA = 'ABS';
  const FLAT_PLA_ID = '900000000701';
  const ENGRAVER_PLA_ID = '900000000702';

  const flat = (): ToolLibraryEntry => ({
    key: 'inv:kz-flat-1',
    tool: flatEndMill(1.0, { id: FLAT_PLA_ID, name: '1mm Flat End', shoulderLength: 12 }),
    provenance: 'k3 house inventory',
  });
  const engraver = (): ToolLibraryEntry => ({
    key: 'inv:kz-engraver-03',
    tool: flatEndMill(0.3, {
      id: ENGRAVER_PLA_ID,
      name: 'Single Flute Engraving Bit 30 x 0.3',
      typeText: 'Engraving',
      shape: 'engraving',
      tipDiameter: 0.3,
      diameter: 3.175,
      angle: 30,
      halfAngle: 15,
      shoulderLength: 12,
    }),
    provenance: 'k3 house inventory',
  });
  /** The incident's cutter: a point chamfer. `diameter=` is the 3.175 mm SHANK, never its cut. */
  const chamfer = (): ToolLibraryEntry => ({
    key: 'inv:kz-chamfer-90',
    tool: flatEndMill(0.3, {
      name: 'C1-BIT-CHAMFER-90',
      typeText: 'Chamfer',
      shape: 'chamfer',
      tipDiameter: null,
      diameter: 3.175,
      angle: 90,
      halfAngle: 45,
      shoulderLength: 12,
    }),
    provenance: 'k3 house inventory',
  });
  const plasticRow = (cutterId: string): FeedCatalogueRow => ({
    cutterId,
    material: PLA,
    rpm: 12000,
    feed: 500,
    plungeFeed: 200,
    stepDown: 0.4,
  });
  const catalogue = [plasticRow(FLAT_PLA_ID), plasticRow(ENGRAVER_PLA_ID)];

  /**
   * The badge the wizard builds: its blank and its pocket, PLA, and the one line the operator typed
   * — placed where the fixed blank layout puts it (#700; that slice owns the placement, this one the
   * cutter). The line is 8 mm and reads along Y, the way the badge route lays a name out.
   */
  function badgeJob(): EngraveJob {
    const blank = badgeBlankFor(defaultBadgeParams());
    const base = defaultEngraveJob(viseForNewJob(undefined, blank.stock));
    return {
      ...base,
      stock: { ...blank.stock, material: 'pla' },
      keepOuts: blank.pocket ? [blank.pocket] : [],
      labels: [
        {
          ...(base.labels[0] as EngraveLabel),
          id: 'name',
          text: 'Zoomba',
          size: 8,
          position: { x: 19.05, y: 38.1 },
          rotation: 90,
          depth: 0.5,
        },
      ],
      shapes: [],
      toolKey: '',
      tool: null,
    };
  }

  it('never recommends the sizeless chamfer, and the pick has a stated size and a direct PLA row', () => {
    const job = badgeJob();
    const rec = recommendTool(job, [chamfer(), engraver(), flat()], catalogue, (_key) => [row('name', 1)]);

    // The old reading — `cuttingDiameter`'s `diameter=` fallback — calls the shank a size; the rule
    // this issue adds does not, and the candidate is out before it can be measured.
    expect(cuttingDiameter(chamfer().tool)).toBe(3.175);
    expect(statedCuttingSize(chamfer().tool)).toBeNull();
    expect(candidate(rec, 'inv:kz-chamfer-90').excluded).toBe('unknown-size');

    // The pick: the 1 mm flat end (the mockup's own recommendation), not the 0.3 mm engraver.
    expect(rec.key).toBe('inv:kz-flat-1');
    expect(rec.compromise).toBe(false);
    const pickEntry = [flat(), engraver()].find((e) => e.key === rec.key)!;
    expect(statedCuttingSize(pickEntry.tool)).toBe(1);
    const coverage = catalogueCoverageFor(catalogue, 'pla', pickEntry.tool);
    expect(coverage.kind).toBe('covered');
    // The row that answers PLA is the ABS one, and the pick's note says so in words: a mapping
    // this app makes, not a vendor statement about PLA (#455).
    if (coverage.kind === 'covered') expect(coverage.via).toBe('abs');
    const pick = candidate(rec, rec.key!);
    expect(pick.catalogueNote).toContain('ABS row standing in');
    expect(pick.catalogueNote).toContain('mapping this app makes');
  });

  it('leaves the k3 job with the recommended cutter generating with no blocking finding', () => {
    const job: EngraveJob = { ...badgeJob(), toolKey: 'inv:kz-flat-1', tool: flat().tool };
    const findings = validateJob(job);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('says the sizes are missing when every cutter is sizeless, rather than blaming the material', () => {
    const rec = recommendTool(badgeJob(), [chamfer()], catalogue, (_key) => [row('name', 1)]);
    expect(rec.key).toBeNull();
    expect(rec.reason).toBe('No cutter in the list states a cutting diameter.');
  });

  // #699b — THE HOUSE'S OTHER 1 mm FLAT IS THE PROBLEM. The k3 walk on 4674e81a picked the
  // 3.175*1*3mm Flat End(Metal): the two cutters tie on stated size, and the metal key sorts first,
  // so nothing but a gate keeps it out of the pick — and the job's own #572 check refuses it on
  // PLA. This is the fixture that holds both halves: the recommender names the plain flat, and the
  // badge + text job generates through the real pipeline with no blocking finding.
  describe('never picks a cutter the job’s own gates refuse (#699b)', () => {
    const METAL_PLA_ID = '900000000703';
    const PLAIN_PLA_ID = '900000000704';

    const plainFlat = (): ToolLibraryEntry => ({
      key: 'inv:kz-plain-flat-1',
      tool: flatEndMill(1.0, { id: PLAIN_PLA_ID, name: '1mm Flat End', shoulderLength: 12 }),
      provenance: 'k3 house inventory',
    });
    const metalFlat = (): ToolLibraryEntry => ({
      key: 'inv:kz-metal-flat-1',
      // Makera's own name for the bit; `(Metal)` is what carries the line (`isMetalTool` reads it).
      tool: flatEndMill(1.0, {
        id: METAL_PLA_ID,
        name: '3.175*1*3mm Flat End(Metal)',
        shoulderLength: 12,
      }),
      provenance: 'k3 house inventory',
    });
    // A plastic row for the PLAIN cutter, so #455 and the feeds pre-filter pass it. The metal
    // cutter deliberately has no PLA row: a catalogue row rating it for plastic is what WAIVES the
    // #572 gate now (#732 — a refusal Makera would not make is our gap), so the fixture keeps the
    // gate live by not claiming Makera rates this bit for PLA.
    const gateCatalogue = [plasticRow(PLAIN_PLA_ID)];

    it('picks the plain 1 mm flat, and the metal one carries its own refusal', () => {
      const rec = recommendTool(badgeJob(), [metalFlat(), plainFlat()], gateCatalogue, (_key) => [
        row('name', 1),
      ]);

      // The tie that used to send the metal cutter to the pick: one stated size, and the metal
      // key sorts first, so only the gate can separate them.
      const metal = candidate(rec, 'inv:kz-metal-flat-1');
      expect(metal.diameter).toBe(candidate(rec, 'inv:kz-plain-flat-1').diameter);
      expect(metal.excluded).toBe('metal-line');
      expect(metal.refusal).toContain('for Metal');
      expect(metal.refusal).toContain('PLA');
      expect(rec.key).toBe('inv:kz-plain-flat-1');
      expect(rec.compromise).toBe(false);
    });

    it('leaves the badge + text job generating with no blocking finding', () => {
      const rec = recommendTool(badgeJob(), [metalFlat(), plainFlat()], gateCatalogue, (_key) => [
        row('name', 1),
      ]);
      const job: EngraveJob = { ...badgeJob(), toolKey: rec.key!, tool: plainFlat().tool };
      const g = generate(tl, job, null, gateCatalogue);
      expect(g.ok).toBe(true);
      expect(g.stage).toBe('done');
      expect(g.findings.filter((f) => f.severity === 'error')).toEqual([]);
      expect(g.findings.filter((f) => f.code === 'tool-metal-line')).toEqual([]);
      expect(g.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);
    });

    it('the gate is the job’s own: Generate refuses the metal flat on the same job', () => {
      // The other half of the claim: the cutter the old rule picked is not merely a preference —
      // the program will not run it on PLA.
      const job: EngraveJob = { ...badgeJob(), toolKey: 'inv:kz-metal-flat-1', tool: metalFlat().tool };
      const g = generate(tl, job, null, gateCatalogue);
      expect(g.ok).toBe(false);
      expect(g.findings.some((f) => f.code === 'tool-metal-line')).toBe(true);
    });

    it('keeps the metal cutter when the operator has acknowledged the pair (#572)', () => {
      // The override is the operator's decision: the job's gate then allows the pair, so the
      // recommendation must not keep refusing it.
      const job: EngraveJob = { ...badgeJob(), metalLineOverride: true };
      const rec = recommendTool(job, [metalFlat(), plainFlat()], gateCatalogue, (_key) => [row('name', 1)]);
      expect(candidate(rec, 'inv:kz-metal-flat-1').excluded).toBeUndefined();
      expect(rec.key).toBe('inv:kz-metal-flat-1');
    });
  });

  // #702 — THE JOB'S OWN SHAPE GATES. One cutter serves the whole job, and some operations refuse a
  // cutter's SHAPE: a bore helixes down its wall and a cut-out profiles with the side, so both need
  // a flat end mill; a variable-depth V-carve and an inlay half are cut by a cone's flank. Each
  // fixture gives the refused shape the size tie it would otherwise win with, so only the gate can
  // keep it out of the pick — and the counter-case shows the gate is the program's own.
  describe('the job’s own shape gates (#702)', () => {
    const V_PLA_ID = '900000000705';
    const vBit = (tip: number): ToolLibraryEntry => ({
      key: 'inv:v-30',
      tool: flatEndMill(tip, {
        id: V_PLA_ID,
        name: '30° V-bit',
        typeText: 'Engraving',
        shape: 'engraving',
        tipDiameter: tip,
        diameter: 3.175,
        angle: 30,
        halfAngle: 15,
        shoulderLength: 12,
      }),
      provenance: 'k3 house inventory',
    });
    // The V's plastic row, so the feeds pre-filter lets it reach the shape gate on the PLA badge.
    const shapeCatalogue = [...catalogue, plasticRow(V_PLA_ID)];

    const rect = (over: Partial<EngraveShape> = {}): EngraveShape =>
      ({
        kind: 'rect',
        id: 'region-1',
        position: { x: 20, y: 30 },
        rotation: 0,
        depth: 0.5,
        enabled: true,
        width: 10,
        height: 8,
        cornerRadius: 0,
        ...over,
      }) as EngraveShape;

    const bore = (): EngraveDrill => ({
      kind: 'drill',
      id: 'bore-1',
      position: { x: 20, y: 5 },
      rotation: 0,
      depth: 1.5,
      enabled: true,
      through: false,
      mode: 'bore',
      diameter: 4,
    });

    it('a bore refuses the larger V-bit; the flat is picked and the job generates', () => {
      const job: EngraveJob = { ...jobWithLabel('l1', 'CASE', 1), drills: [bore()] };
      const rec = recommendTool(job, [vBit(2), flat()], [], (_key) => [row('l1', 1)]);
      const v = candidate(rec, 'inv:v-30');
      expect(v.diameter).toBeGreaterThan(candidate(rec, 'inv:kz-flat-1').diameter);
      expect(v.excluded).toBe('job-shape');
      expect(v.refusal).toContain('bore');
      expect(rec.key).toBe('inv:kz-flat-1');

      const withPick: EngraveJob = { ...job, toolKey: rec.key!, tool: flat().tool };
      const g = generate(tl, withPick, null, []);
      expect(g.ok).toBe(true);
      expect(g.stage).toBe('done');
      expect(g.findings.filter((f) => f.severity === 'error')).toEqual([]);

      // The gate is real: the V the size rule would have picked is refused by the job's own check.
      const withV: EngraveJob = { ...job, toolKey: 'inv:v-30', tool: vBit(2).tool };
      expect(validateJob(withV).some((f) => f.code === 'bore-needs-end-mill')).toBe(true);
    });

    it('a cut-out refuses the larger V-bit too', () => {
      const cutout = {
        kind: 'cutout',
        id: 'co-1',
        enabled: true,
        of: 'stock-inset',
        side: 'outside',
        inset: 1,
        tabs: { count: 0, width: 0, height: 0 },
      } as EngraveCutout;
      const job: EngraveJob = { ...jobWithLabel('l1', 'CASE', 1), cutouts: [cutout] };
      const rec = recommendTool(job, [vBit(2), flat()], [], (_key) => [row('l1', 1)]);
      expect(candidate(rec, 'inv:v-30').excluded).toBe('job-shape');
      expect(candidate(rec, 'inv:v-30').refusal).toContain('cut-out');
      expect(rec.key).toBe('inv:kz-flat-1');
    });

    it('a variable-depth V-carve refuses the larger flat; the V-bit is picked', () => {
      const job: EngraveJob = { ...badgeJob(), shapes: [rect({ vCarveDepth: 'variable' })] };
      const rec = recommendTool(job, [flat(), vBit(0.5)], shapeCatalogue, (_key) => [row('name', 1)]);
      const flatCandidate = candidate(rec, 'inv:kz-flat-1');
      expect(flatCandidate.diameter).toBeGreaterThan(candidate(rec, 'inv:v-30').diameter);
      expect(flatCandidate.excluded).toBe('job-shape');
      expect(flatCandidate.refusal).toContain('variable-depth');
      expect(rec.key).toBe('inv:v-30');
      // The gate is real: the flat the size rule would have picked is refused by the job's check.
      const withFlat: EngraveJob = { ...job, toolKey: 'inv:kz-flat-1', tool: flat().tool };
      expect(validateJob(withFlat).some((f) => f.code === 'vcarve-variable-needs-cone')).toBe(true);
    });

    it('an inlay half refuses the larger flat; the V-bit is picked', () => {
      const job: EngraveJob = {
        ...badgeJob(),
        shapes: [rect({ inlay: { role: 'female', glueGapMm: 0.2 } })],
      };
      const rec = recommendTool(job, [flat(), vBit(0.5)], shapeCatalogue, (_key) => [row('name', 1)]);
      expect(candidate(rec, 'inv:kz-flat-1').excluded).toBe('job-shape');
      expect(candidate(rec, 'inv:kz-flat-1').refusal).toContain('inlay');
      expect(rec.key).toBe('inv:v-30');
    });

    it('a job needing a flat AND a cone has no single-cutter answer, and says both gates', () => {
      const job: EngraveJob = {
        ...jobWithLabel('l1', 'CASE', 1),
        drills: [bore()],
        shapes: [rect({ inlay: { role: 'female', glueGapMm: 0.2 } })],
      };
      const rec = recommendTool(job, [flat(), vBit(2)], [], (_key) => [row('l1', 1)]);
      expect(rec.key).toBeNull();
      expect(rec.reason).toContain('refused by the job’s own operations');
      expect(rec.reason).toContain('bores a hole');
      expect(rec.reason).toContain('inlay half');
      // #728 — the base sentence says the job needs both, not "no flat end mill … or V-bit".
      expect(rec.reason).toMatch(/^No single cutter can cut this job: the job bores a hole/);
    });

    it('#728 — the both-shapes sentence holds when one cutter fell for another reason', () => {
      const job: EngraveJob = {
        ...jobWithLabel('l1', 'CASE', 1),
        drills: [bore()],
        shapes: [rect({ inlay: { role: 'female', glueGapMm: 0.2 } })],
      };
      const sizeless: ToolLibraryEntry = { ...flat(), key: 'inv:no-size', tool: { ...flat().tool, diameter: null } };
      const rec = recommendTool(job, [flat(), vBit(2), sizeless], [], (_key) => [row('l1', 1)]);
      expect(rec.key).toBeNull();
      expect(rec.reason).toMatch(/^No single cutter can cut this job/);
      expect(rec.reason).not.toContain('is a flat end mill — or');
    });

    it('#728 — a SWITCHED-OFF inlay half asks nothing of the cutter, in the pick and in the check', () => {
      const job: EngraveJob = {
        ...jobWithLabel('l1', 'CASE', 1),
        drills: [bore()],
        shapes: [rect({ enabled: false, inlay: { role: 'female', glueGapMm: 0.2 } })],
      };
      const rec = recommendTool(job, [flat(), vBit(2)], [], (_key) => [row('l1', 1)]);
      expect(rec.key).toBe('inv:kz-flat-1');
      const withPick: EngraveJob = { ...job, toolKey: rec.key!, tool: flat().tool };
      expect(validateJob(withPick).some((f) => f.code === 'inlay-needs-cone')).toBe(false);
    });

    it('#728 — a variable V-carve on a LABEL or VECTOR gates the pick, as the check does', () => {
      const base = jobWithLabel('l1', 'CASE', 1);
      const job: EngraveJob = {
        ...base,
        labels: base.labels.map((l) => ({ ...l, vCarveDepth: 'variable' as const })),
      };
      const rec = recommendTool(job, [flat(), vBit(0.5)], shapeCatalogue, (_key) => [row('l1', 1)]);
      expect(candidate(rec, 'inv:kz-flat-1').excluded).toBe('job-shape');
      const withFlat: EngraveJob = { ...job, toolKey: 'inv:kz-flat-1', tool: flat().tool };
      expect(validateJob(withFlat).some((f) => f.code === 'vcarve-variable-needs-cone')).toBe(true);
    });
  });
});
