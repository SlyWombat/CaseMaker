// Which cutter reaches what, in numbers (#410).
//
// The module is pure: it is handed `measure` and never touches Manifold, so every case here injects
// the measurement it wants and checks the arithmetic and the wording around it. The one thing the
// injected rows must respect is the shape `measureLabels` really returns — that is what makes these
// cases evidence about the shipped rule rather than about a fixture.

import { describe, it, expect, vi } from 'vitest';

import {
  finerThan,
  reachabilityFor,
  reachTable,
  shareOf,
  untouchedBy,
  untouchedByAll,
} from '@/engine/cnc/engrave/reachability';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { LabelEngravability } from '@/workers/sim/engraveGeometry';
import type { EngraveJob } from '@/types/engraveJob';

/** A library entry built around `flatEndMill`, the way `recommendTool.spec.ts` builds one. */
function tool(key: string, diameter: number, opts: Partial<Tool> = {}): ToolLibraryEntry {
  return { key, tool: flatEndMill(diameter, opts), provenance: 'reachability test' };
}

/**
 * A one-item job per id given, sized so the ITEMS' areas are the test's own numbers. The rule under
 * test reads the id, the depth and the enabled flag; the geometry is `measure`'s business.
 */
function jobWith(...ids: string[]): EngraveJob {
  const job = defaultEngraveJob();
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

/** The area each item's profile holds, mm² — the fixture's own facts, held here once. */
const AREA: Record<string, number> = { big: 900, small: 100 };

/** A measured row: `measureLabels`'s shape with the fixture's area and the case's opened area. */
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

/**
 * A `measure` from a table: per cutter key, the opened area of each item. An item left out of a
 * cutter's entry is measured as NOT reached (opened 0) — the case that matters most here.
 */
function measuring(table: Record<string, Record<string, number>>) {
  return (key: string): LabelEngravability[] => {
    const opened = table[key] ?? {};
    return Object.keys(AREA).map((id) => row(id, opened[id] ?? 0));
  };
}

describe('reachabilityFor (#410)', () => {
  const tools = [tool('wide', 3.175, { shoulderLength: 12 }), tool('mid', 2.0, { shoulderLength: 12 }), tool('fine', 1.0, { shoulderLength: 12 })];
  // The shape #410 exists for: the wide bits reach nothing, the fine one reaches almost all of it,
  // and one item is beyond every bit on the bench.
  const table = {
    wide: { big: 0, small: 0 },
    mid: { big: 300, small: 0 },
    fine: { big: 880, small: 80 },
  };

  it('measures each candidate ONCE and answers the picker from the same rows', () => {
    const measure = vi.fn(measuring(table));
    const job = jobWith('big', 'small');
    const reach = reachabilityFor(job, tools, [], measure);
    // Three eligible cutters, one pass each — the table costs no more wasm than the picker did.
    expect(measure).toHaveBeenCalledTimes(3);
    expect(reach.recommendation.key).toBe('fine');
    // The table's own columns are the job's enabled items, in its own order.
    expect(reach.items.map((i) => i.id)).toEqual(['big', 'small']);
    expect(reach.cutters.map((c) => c.key)).toEqual(['wide', 'mid', 'fine']);
  });

  it('reports each cutter per item, and the total as an AREA share rather than the mean of ratios', () => {
    const reach = reachabilityFor(jobWith('big', 'small'), tools, [], measuring(table));
    const fine = reach.cutters.find((c) => c.key === 'fine')!;
    expect(fine.rows.map((r) => r.ratio)).toEqual([880 / 900, 0.8]);
    expect(fine.bestRatio).toBe(880 / 900);
    expect(fine.worstRatio).toBe(0.8);
    // 960 mm² of 1000 mm². The mean of the ratios would be 0.94 — a 100 mm² full stop would carry
    // the same weight as a 900 mm² title, which is exactly what this number must not do.
    expect(shareOf(reach, 'fine')).toBeCloseTo(0.96, 10);
    expect(shareOf(reach, 'mid')).toBeCloseTo(0.3, 10);
    expect(shareOf(reach, 'wide')).toBe(0);
  });

  it('marks the items a cutter reaches NONE of as empty, and nothing is empty at ratio 0 of area 0', () => {
    const reach = reachabilityFor(jobWith('big', 'small'), tools, [], measuring(table));
    expect(untouchedBy(reach, 'wide').map((r) => r.itemId)).toEqual(['big', 'small']);
    expect(untouchedBy(reach, 'mid').map((r) => r.itemId)).toEqual(['small']);
    expect(untouchedBy(reach, 'fine')).toEqual([]);
    // A row with no area is not a failure of reach: `measureLabels` answers it ratio 1, and the
    // table must not read that as "the cutter opened nothing".
    const zeroArea: LabelEngravability = {
      labelId: 'zero',
      glyphArea: 0,
      openedArea: 0,
      ratio: 1,
      emptyChars: [],
      outsideArea: 0,
      polygons: [],
    };
    const empty = reachabilityFor(jobWith('zero'), tools, [], () => [zeroArea]);
    expect(empty.cutters.find((c) => c.key === 'fine')!.rows[0]!.empty).toBe(false);
    expect(empty.cutters.find((c) => c.key === 'fine')!.rows[0]!.ratio).toBe(1);
  });

  it('names the items NO measured cutter reaches, and only on measured cutters', () => {
    const job = jobWith('big', 'small');
    const tools = [tool('wide', 3.175, { shoulderLength: 12 }), tool('fine', 1.0, { shoulderLength: 12 })];
    const nothing = { wide: { big: 0, small: 0 }, fine: { big: 800, small: 0 } };
    const reach = reachabilityFor(job, tools, [], measuring(nothing));
    // `small` is reached by nothing; `big` is missed by `wide` alone, which is a cutter choice and
    // a different sentence. Both facts come out of one table and must not be confused.
    const all = untouchedByAll(reach);
    expect(all.map((u) => u.row.itemId)).toEqual(['small']);
    expect(all[0]!.cutters).toBe(2);
    expect(untouchedBy(reach, 'wide').map((r) => r.itemId)).toEqual(['big', 'small']);

    // An excluded cutter is NOT evidence: a ball nose may well reach `small`, and nobody measured
    // it, so "nothing reaches this" cannot be said on the strength of its absence.
    const withBall = [tool('ball', 1.0, { shape: 'ball', typeText: 'Ball End' }), ...tools];
    const reach2 = reachabilityFor(job, withBall, [], measuring(nothing));
    expect(reach2.cutters.find((c) => c.key === 'ball')!.excluded).toBe('not-flat');
    expect(untouchedByAll(reach2)[0]!.cutters).toBe(2);
  });

  it('reads the design’s total area off a MEASURED cutter, never off an excluded one that sorts first', () => {
    const job = jobWith('big', 'small');
    // A ball nose is never measured, but it still gets a cell per item — zeroed. Reading the total
    // from the first cutter that merely HAS rows would take its 0 mm² and report every cutter's
    // share of the design as 0 %, so the position of the ball in the list must not matter.
    const ball = tool('ball', 1.0, { shape: 'ball', typeText: 'Ball End' });
    const flat = tool('flat', 1.0, { shoulderLength: 12 });
    const reach = reachabilityFor(job, [ball, flat], [], measuring({ flat: { big: 900, small: 50 } }));
    expect(reach.cutters[0]!.key).toBe('ball');
    expect(reach.cutters[0]!.rows.every((r) => r.openedArea === 0)).toBe(true);
    expect(shareOf(reach, 'flat')).toBeCloseTo(950 / 1000, 10);
  });

  it('offers the SMALLEST cutter that reaches strictly more, and nothing when none does', () => {
    const job = jobWith('big', 'small');
    const reach = reachabilityFor(job, tools, [], measuring(table));
    // `wide` reaches nothing, and BOTH finer bits reach more — the rule takes the smallest of them,
    // because a second program wants the most reach a bit can buy, not the nearest improvement.
    expect(finerThan(reach, 'wide')!.key).toBe('fine');
    expect(finerThan(reach, 'mid')!.key).toBe('fine');
    // Nothing reaches more than `fine`, so the pair ends here.
    expect(finerThan(reach, 'fine')).toBeNull();
    // An unknown key is not a cutter.
    expect(finerThan(reach, 'nope')).toBeNull();
  });

  it('says why a cutter was not measured instead of leaving it out of the table', () => {
    const job = jobWith('big');
    const tools = [tool('ball', 1.0, { shape: 'ball', typeText: 'Ball End' }), tool('wide', 3.175, { shoulderLength: 12 })];
    const reach = reachabilityFor(job, tools, [], measuring({ wide: { big: 0 } }));
    const rows = reachTable(reach);
    expect(rows.map((r) => r.key)).toEqual(['ball', 'wide']);
    expect(rows[0]!.excluded).toBe('not a flat end mill (or a V-bit on a job with regions)');
    // Not measured means no per-item numbers at all — `null`, which is not the same as 0 %.
    expect(rows[0]!.shares).toEqual([null]);
    expect(rows[1]!.excluded).toBeNull();
    expect(rows[1]!.shares).toEqual([0]);
  });

  it('never offers a cutter the catalogue lists for other materials as a rest-pair second tool (#455)', () => {
    const job = jobWith('big', 'small');
    job.stock = { ...job.stock, material: 'pla' };
    // Synthetic rows in the incident's shape: the corn bit is listed for PCB and carbon fibre only.
    const catalogue: FeedCatalogueRow[] = ['PCB', 'Carbon Fiber'].map((material) => ({
      cutterId: '900000000001',
      material,
      rpm: 12000,
      feed: 500,
      plungeFeed: 200,
      stepDown: 0.4,
    }));
    const corn = tool('inv:corn', 0.6, { id: '900000000001', name: 'TiN Coating Corn Bit' });
    const wide = tool('wide', 3.175, { shoulderLength: 12 });
    const fine = tool('fine', 1.0, { shoulderLength: 12 });
    const reach = reachabilityFor(
      job,
      [wide, fine, corn],
      catalogue,
      measuring({ wide: { big: 300, small: 0 }, fine: { big: 880, small: 80 } }),
    );

    const cornReach = reach.cutters.find((c) => c.key === 'inv:corn')!;
    expect(cornReach.excluded).toBe('no-catalogue-row');
    expect(cornReach.excludedNote).toContain('PCB');
    expect(cornReach.excludedNote).toContain('not PLA');
    // The second tool of the pair is chosen from the SAME survivors, so the rule needs no second
    // copy for rest machining: the smaller corn bit is not offered, `fine` is.
    expect(finerThan(reach, 'wide')!.key).toBe('fine');
    // And the table a run sheet or the CLI prints carries the catalogue's own words.
    const row = reachTable(reach).find((r) => r.key === 'inv:corn')!;
    expect(row.excluded).toContain('PCB');
    expect(row.excluded).toContain('not PLA');
    expect(row.shares).toEqual([null, null]);
  });

  it('carries the cutters’ own names, and falls back to the key when the library has no entry', () => {
    const job = jobWith('big');
    const named: ToolLibraryEntry = {
      key: 'inv:owned',
      provenance: 'reachability test',
      tool: { ...flatEndMill(1.0, { shoulderLength: 12 }), name: 'TiN Coating Corn Bit 1.0mm' },
    };
    const reach = reachabilityFor(job, [named], [], measuring({ 'inv:owned': { big: 900 } }));
    expect(reach.cutters[0]!.name).toBe('TiN Coating Corn Bit 1.0mm');
    expect(reach.cutters[0]!.diameter).toBe(1.0);
    expect(reach.cutters[0]!.shape).toBe('flat');
  });
});
