// #666 — THE ADAPTIVE-CLEARING ROUTE, END TO END. #433 built `cam/adaptive.ts` (engagement-capped
// clearing with a helix or ramp entry); it was an engine module with no job route until this. These
// tests are the route: a METAL job's SHAPE pocket is planned by it, as the ROUGH half of #250's
// split when the shop's allowance splits the pocket (which `engraveRunStore` always asks for), and
// the plan's cut numbers are the program's resolved feeds row — not the shop's `adaptive.*`
// placeholders.
//
// They also pin what must NOT change: a wood job, a text label and a V-bit keep the contour-parallel
// rings (and the straight plunge), and a planner REFUSAL is an info-level report on the run — the
// pocket falls back to those same rings and the job still cuts. `inform, don't refuse`.
//
// Real Manifold through the shared harness, like `engraveGenerate.spec.ts`; the metal feed rows are
// hand-built fixtures (the compiled starting table has no aluminium row — #347).

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate, regions } from './helpers/engravePipeline';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { generateEngrave } from '@/engine/cnc/cam/engraveJob';
import { adaptiveSettings } from '@/engine/cnc/cam/adaptive';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';
import type { CutParams, FeedCatalogueRow } from '@/engine/cnc/feeds';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type { EngraveJob } from '@/types/engraveJob';

/** The vendor's id for the 3.175 × 12 mm flat end (the catalogue row is keyed on it). */
const VENDOR_ID = '112111313812';

/**
 * Makera's row for that cutter in 6061 aluminium, hand-built (§3, #186 — never vendor data). The
 * numbers are deliberately distinct from the `adaptive.*` placeholders (600/200 mm/min, 12 000 rpm),
 * so a plan carrying them proves the feeds row reached the planner.
 */
const CUT_ROW: FeedCatalogueRow = {
  cutterId: VENDOR_ID,
  material: '6061 Aluminum',
  rpm: 10_000,
  feed: 400,
  plungeFeed: 100,
  stepDown: 0.4,
};

/** One 10 × 10 mm rect pocket, 1.0 mm deep, in 6061 aluminium with that flat end mill. */
function metalJob(over: Partial<EngraveJob> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    toolKey: 'flat-3.175x12-metal',
    tool: flatEndMill(3.175, {
      id: VENDOR_ID,
      name: '3.175*12mm Flat End',
      fluteLength: 12,
      shoulderLength: 12,
    }),
    stock: { ...base.stock, material: 'aluminium-6061' },
    labels: [],
    shapes: [
      {
        id: 'pocket',
        name: 'Pocket rect 10×10',
        kind: 'rect',
        position: { x: 50, y: 30 },
        rotation: 0,
        depth: 1.0,
        enabled: true,
        width: 10,
        height: 10,
        cornerRadius: 0,
      },
    ],
    ...over,
  };
}

/** The shop's defaults as the run hands them over: only the keys a case overrides. */
function defaults(map: ShopDefaults): ShopDefaults {
  return map;
}

describe('the adaptive-clearing route a metal pocket takes (#666)', () => {
  it('cuts a metal SHAPE pocket with adaptive clearing, and the run says so (#666)', () => {
    // No finish block: the strategy IS the whole cut. The `.nc` must name the operation, and the
    // run must carry the plan's own sentence — the engagement, the entry and the feeds row it ran.
    const g = generate(tl, metalJob(), null, [CUT_ROW]);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    const clearing = g.findings.find((f) => f.code === 'adaptive-clearing');
    expect(clearing).toBeDefined();
    expect(clearing!.severity).toBe('info');
    expect(clearing!.labelId).toBe('pocket');
    expect(clearing!.message).toContain('engagement capped at');
    // A 10 × 10 pocket leaves room for the helix at 0.5 × the cutter, so the entry is the helix
    // rather than the ramp — the strategy's whole point in metal.
    expect(clearing!.message).toContain('helix entry at');
    // The cut numbers are THIS program's feeds row, not `adaptive.cutFeed` / `entryFeed` /
    // `spindleRpm` (600 / 200 / 12 000). The step-down is the shallower of the row's 0.4 mm and
    // `adaptive.stepDownMm`'s 1 mm, so the note credits the row too.
    expect(clearing!.message).toContain('feeds 400 / 100 mm/min and 10000 rpm are the feeds row');
    expect(clearing!.message).toContain("the feeds row's 0.4 mm step-down");
    // Not a fallback: the planner accepted the pocket.
    expect(g.findings.some((f) => f.code === 'adaptive-fallback')).toBe(false);
    expect(g.nc).not.toBeNull();
    expect(g.nc).toContain('(adaptive)');
  });

  it('takes the ROUGH half of #250’s split and leaves the finishing rings alone (#666)', () => {
    // What the app always asks for: `engraveRunStore` passes the finish allowance on every run, so
    // an adaptive route that only ran when nothing was split would never run at all. The roughing
    // pass is the plan (region eroded by the allowance, levels stopping above the floor); the
    // finishing pass stays the ideal outline in contour-parallel rings.
    const g = generate(tl, metalJob(), null, [CUT_ROW], undefined, {
      finish: { stockToLeaveMm: { value: 0.2, source: 'chosen' } },
    });
    expect(g.ok).toBe(true);
    expect(g.cam!.roughOperations).toBe(1);
    expect(g.cam!.finishOperations).toBe(1);
    expect(g.nc).toContain('(rough, adaptive)');
    expect(g.nc).toContain('(finish)');
    // 1.0 mm less the 0.2 mm allowance is 0.8 mm, at the row's 0.4 mm step-down: two levels.
    const clearing = g.findings.find((f) => f.code === 'adaptive-clearing')!;
    expect(clearing.message).toContain('2 level(s) of 0.4 mm (the feeds row');
    // #735 — the helix chords are not depth passes: the summary counts the planner's two levels
    // plus the finishing pass, not every 0.001 mm the helix descends.
    expect(g.cam!.passes).toBe(3);
  });

  it('falls back to contour-parallel rings when the planner declines, and the job still cuts (#666)', () => {
    // A grid cap of 1 000 cells cannot hold a 10 × 10 pocket at this engagement, so the planner
    // refuses `adaptive-region-too-large`. That is an engine limitation: the pocket keeps the rings
    // (and the straight plunge) it always had, and the run states why — a warning, never a refusal.
    const g = generate(tl, metalJob(), null, [CUT_ROW], undefined, {
      finish: { stockToLeaveMm: { value: 0.2, source: 'chosen' } },
      defaults: defaults({
        'adaptive.maxCells': { value: 1000, source: 'chosen', setAt: null, unit: null, note: null },
      }),
    });
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.nc).not.toBeNull();
    const fallback = g.findings.find((f) => f.code === 'adaptive-fallback');
    expect(fallback).toBeDefined();
    expect(fallback!.severity).toBe('warning');
    expect(fallback!.labelId).toBe('pocket');
    expect(fallback!.message).toContain('contour-parallel rings');
    expect(fallback!.message).toContain('material grid');
    expect(g.findings.some((f) => f.code === 'adaptive-clearing')).toBe(false);
    // The rings are the pre-#666 cut, so the split still names its two halves.
    expect(g.nc).toContain('(rough)');
    expect(g.nc).toContain('(finish)');
    expect(g.nc).not.toContain('adaptive');
  });

  it('offers only a METAL SHAPE pocket — not wood, not a text label (#666)', () => {
    // The region builder's mark is the whole gate; the engine decides from there whether a plan is
    // possible. A wood job keeps the plain rings (Q9: metal pockets only), and a text label is
    // engraving, which keeps its straight plunge.
    const metal = metalJob();
    expect(regions(tl, metal).regions.find((r) => r.id === 'pocket')!.adaptive).toBe(true);

    const wood = metalJob({ stock: { ...metal.stock, material: 'hardwood' } });
    expect(regions(tl, wood).regions.find((r) => r.id === 'pocket')!.adaptive).toBeUndefined();

    const label = metalJob({ shapes: [], labels: [defaultEngraveJob().labels[0]!] });
    const labelRegions = regions(tl, label).regions;
    expect(labelRegions.length).toBeGreaterThan(0);
    expect(labelRegions.every((region) => region.adaptive === undefined)).toBe(true);
  });

  it('plans nothing in a finish-only rest program — another tool cut the rough (#666)', () => {
    // The second program of a rest pair writes the finishing pass of a pocket the first program
    // roughed. There is no roughing to plan here, so the strategy is not offered at all.
    const job = metalJob();
    const params: CutParams = {
      rpm: CUT_ROW.rpm,
      feed: CUT_ROW.feed,
      plungeFeed: CUT_ROW.plungeFeed,
      stepDown: CUT_ROW.stepDown,
      stepOver: 1.5,
      peck: 0.4,
      air: true,
    };
    const ir = generateEngrave(
      tl,
      regions(tl, job).regions,
      jobTool(job)!,
      params,
      Z1.rapidEstimate,
      'nearest',
      null,
      { stockToLeaveMm: 0.2, mode: 'finish-only' },
      null,
      null,
      adaptiveSettings(null).settings,
    );
    expect(ir.adaptive).toBeUndefined();
    expect(ir.operations).toHaveLength(1);
    expect(ir.operations[0]!.name).toContain('(finish)');
    expect(ir.operations[0]!.name).not.toContain('adaptive');
  });
});
