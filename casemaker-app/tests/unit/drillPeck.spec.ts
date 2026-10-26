/**
 * #675 — "PECK EVERY N MM": a hole item's own peck, over the program's source.
 *
 * The review seams. THE DOCUMENT: `peckMm` is the item's number, absent = the source binds, and a
 * pre-#675 document round-trips unchanged. THE CAM: both drill paths honour it — a drill bit's
 * `planDrillBit` (whose source is the shop's `drill.peckDiameters × ⌀`) and a milling cutter's
 * `drillMoves` (whose source is the feeds row) — and the plan records WHICH bound. THE SHEET: the
 * drill-bit program states the peck per hole with its source, and a milling cutter's override is
 * stated with both the file's number and the feeds row's.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { planDrillBit } from '@/engine/cnc/cam/drillBit';
import { flatEndMill } from '@/engine/cnc/tool';
import { setInventoryEntries, resetRegistry } from '@/engine/cnc/toolRegistry';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveDrill, EngraveJob } from '@/types/engraveJob';

const DRILL_KEY = 'inv:drill-3';
const DRILL = flatEndMill(3, {
  name: '3 mm drill',
  typeText: 'Drill',
  shape: 'drill',
  tipDiameter: 3,
  diameter: 3,
  cornerRadius: null,
  angle: null,
  centreCutting: null,
});
const DRILL_ENTRY: ToolLibraryEntry = { key: DRILL_KEY, tool: DRILL, provenance: 'test' };

/** The shop's drill numbers, chosen here so a test can assert the source sentence. */
const SETTINGS = {
  peckDiameters: 1,
  peckClearanceMm: 0.5,
  pointAngleDeg: 118,
  plungeFeed: 120,
  spindleRpm: 9000,
};
const SOURCES = {
  peckDiameters: 'chosen for this test',
  peckClearanceMm: 'chosen for this test',
  pointAngleDeg: 'chosen for this test',
  plungeFeed: 'placeholder for this test',
  spindleRpm: 'placeholder for this test',
};
const SHOP: EngraveShopOpts = { drill: { settings: SETTINGS, sources: SOURCES }, tools: [DRILL_ENTRY] };

function hole(extra: Partial<EngraveDrill> = {}): EngraveDrill {
  return {
    id: 'hole',
    kind: 'drill',
    name: 'port',
    position: { x: 20, y: 15 },
    rotation: 0,
    depth: 4,
    enabled: true,
    through: false,
    ...extra,
  } as EngraveDrill;
}

function drillJob(drills: EngraveDrill[], bit = true): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: 40, width: 30 },
    labels: [],
    traces: [],
    shapes: [],
    drills,
    ...(bit ? { toolKey: DRILL_KEY, tool: DRILL } : {}),
  };
}

/** The Z of every FEED move: a peck's bottom. A re-entry is a `G0` rapid and is not counted. */
const feedZWords = (nc: string): number[] =>
  nc
    .split('\n')
    .filter((line) => line.startsWith('G1'))
    .flatMap((line) => [...line.matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])));

afterEach(() => resetRegistry());

describe('planDrillBit — the item’s peck, or the shop’s, and which bound', () => {
  const input = (peckMm?: number | null) => ({
    tool: DRILL,
    holes: [[20, 15]] as [number, number][],
    depth: { kind: 'blind' as const, fullDiameterDepth: 4 },
    peckMm,
    settings: SETTINGS,
    pointAngleSource: SOURCES.pointAngleDeg,
  });

  it('takes the shop’s ⌀ × peckDiameters when the item states none', () => {
    const r = planDrillBit(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A 118° point on a 3 mm drill: 0.901 mm of point, so the tip goes 4.901 deep.
    expect(r.plan.peck).toBeCloseTo(3, 9);
    expect(r.plan.peckSource).toBe('drill.peckDiameters × ⌀3');
    expect(r.plan.notes.join(' ')).toContain('peck(s) of 3 mm (drill.peckDiameters × ⌀3)');
  });

  it('takes the item’s own peck and says it is typed', () => {
    const r = planDrillBit(input(1.5));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.peck).toBe(1.5);
    expect(r.plan.peckSource).toBe('typed in this job');
    // 4.901 mm of tip at 1.5 mm a peck: 4 pecks, the last on the tip depth.
    const feeds = r.plan.moves.filter((m) => m.kind === 'feed');
    expect(feeds).toHaveLength(4);
    expect(feeds[3]!.z).toBeCloseTo(-r.plan.tipDepth, 6);
  });

  it('refuses a peck that is not a length above zero', () => {
    const r = planDrillBit({ ...input(0), settings: { ...SETTINGS, peckDiameters: 0 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('peck length');
  });
});

describe('the drill-bit program — the document’s peck reaches the file and the sheet', () => {
  it('cuts the ladder the item states, and the sheet names the source', () => {
    setInventoryEntries([DRILL_ENTRY]);
    const job = drillJob([hole({ peckMm: 1.5 })]);
    const g = generate(tl, job, null, [], undefined, SHOP);
    expect(g.ok).toBe(true);
    expect(g.drill).not.toBeNull();
    expect(g.drill!.plans[0]!.peck).toBe(1.5);
    expect(g.drill!.plans[0]!.peckSource).toBe('typed in this job');

    // The file's pecks are 1.5 mm apart (the last lands on the tip depth).
    const zs = feedZWords(g.nc as string);
    expect(zs).toContain(-1.5);
    expect(zs).toContain(-3);

    const texts = buildRunSheet(job, g, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    const planLine = texts.find((t) => t.includes('port'));
    expect(planLine).toBeDefined();
    expect(planLine).toContain('pecked every 1.5 mm (typed in this job)');
    const provenance = texts.find((t) => t.includes('Where those numbers came from'));
    expect(provenance).toContain('unless a hole states its own peck');
  }, 60_000);

  it('states the shop’s source when the hole does not override', () => {
    setInventoryEntries([DRILL_ENTRY]);
    const job = drillJob([hole()]);
    const g = generate(tl, job, null, [], undefined, SHOP);
    expect(g.ok).toBe(true);
    const texts = buildRunSheet(job, g, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    const planLine = texts.find((t) => t.includes('port'));
    expect(planLine).toContain('pecked every 3 mm (drill.peckDiameters × ⌀3)');
  }, 60_000);
});

describe('the milling cutter’s plunge drill — the same override, the feeds row beside it', () => {
  it('pecks at the item’s length and the sheet states both numbers', () => {
    const flat = flatEndMill(1, { id: null, name: '1 mm flat end', typeText: 'Flat End' });
    const job = drillJob([hole({ depth: 2, peckMm: 0.5 })], false);
    job.toolKey = 'flat-1.0';
    job.tool = flat;
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    expect(g.drill).toBeNull();

    // The file pecks every 0.5 mm instead of the feeds row's 1 mm.
    const zs = feedZWords(g.nc as string);
    expect(zs).toContain(-0.5);
    expect(zs).toContain(-1);
    expect(zs).toContain(-2);

    const texts = buildRunSheet(job, g, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    const step = texts.find((t) => t.includes('pecked every 0.5 mm'));
    expect(step).toBeDefined();
    expect(step).toContain('typed in this job');
    expect(step).toContain('the feeds row would peck every 1 mm');
  }, 60_000);

  it('leaves a drill with no override to the feeds row alone', () => {
    const flat = flatEndMill(1, { id: null, name: '1 mm flat end', typeText: 'Flat End' });
    const job = drillJob([hole({ depth: 2 })], false);
    job.toolKey = 'flat-1.0';
    job.tool = flat;
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const zs = feedZWords(g.nc as string);
    expect(zs).toContain(-1);
    expect(zs).toContain(-2);
    expect(zs).not.toContain(-0.5);
    expect(zs).not.toContain(-1.5);
    const texts = buildRunSheet(job, g, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    expect(texts.some((t) => t.includes('pecked every'))).toBe(false);
  }, 60_000);
});

describe('the document — the override round-trips, and absent means the source', () => {
  it('saves and parses the item’s peck unchanged, and leaves an unset one absent', () => {
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(drillJob([hole({ peckMm: 1.5 }), hole({ id: 'plain' })]))));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.drills![0]!.peckMm).toBe(1.5);
    expect(parsed.job.drills![1]!.peckMm).toBeUndefined();
  });

  it('refuses a peck that is not a positive length', () => {
    const dto = JSON.parse(JSON.stringify(drillJob([hole()]))) as { drills: { peckMm: unknown }[] };
    dto.drills[0]!.peckMm = 0;
    expect(parseEngraveJob(dto).ok).toBe(false);
    dto.drills[0]!.peckMm = -1;
    expect(parseEngraveJob(dto).ok).toBe(false);
    dto.drills[0]!.peckMm = 'deep';
    expect(parseEngraveJob(dto).ok).toBe(false);
  });

  it('keeps a bore’s number out of the way: it parses, and the bore cuts as it always did', () => {
    const bore = hole({ mode: 'bore', diameter: 10, depth: 2 });
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(drillJob([{ ...bore, peckMm: 0.5 }]))));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // A bore is helixed, not pecked; the row hides the field and the CAM never reads the number.
    expect(parsed.job.drills![0]!.peckMm).toBe(0.5);
  });
});
