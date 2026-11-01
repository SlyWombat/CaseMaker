// #863 — a ball's diameter is its ball, not its shank, and every house cutter kind is audited.
//
// Found while fixing #859: the house's ball-nose records (`kz-ball-nose-2-12`, `-m-2-6`, `-m-1-3`,
// `-1-4`) carried the 3.175 mm SHANK in `diameter`, while Makera's catalogue states the same g_IDs
// with the ball's own diameter there. `catalogueCoverageFor` compared shank with ball, called them
// "a different cutter" and dropped them, so a 3D finish saw fewer balls than the shop owns. The
// house's ⌀3 drill (`kz-drill-3-12`) had the same mistake. The fixture is the demo library's 29
// house records, as served, and the catalogue's tools and feed rows for the same g_IDs
// (`fixtures/ball863`).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planCutters, materialRefusal } from '@/engine/cnc/engrave/cutterPlan';
import { candidatePlans } from '@/engine/cnc/engrave/smartPick';
import {
  catalogueCoverageFor,
  catalogueMaterialFor,
  LABEL_TOLERANCE_MM,
  withCatalogueGeometry,
  type FeedCatalogueRow,
} from '@/engine/cnc/feeds';
import { buildHouseInventory, type LabelRecord } from '@/engine/cnc/houseDocument';
import {
  cuttingDiameter,
  namedCuttingDiameter,
  statedCuttingSize,
  unambiguousCuttingDiameter,
  vendorId,
  type Tool,
} from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob, StockMaterial } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(resolve(HERE, 'fixtures/ball863/house-cutters.json'), 'utf8')) as {
  catalogue: ToolLibraryEntry[];
  feeds: FeedCatalogueRow[];
  inventory: ToolLibraryEntry[];
};
const ROWS = withCatalogueGeometry(fx.feeds, fx.catalogue.map((e) => e.tool));
const house = (id: string): ToolLibraryEntry => fx.inventory.find((e) => e.key === `inv:${id}`)!;
const twinOf = (tool: Tool): Tool | null => fx.catalogue.find((e) => e.tool.id === vendorId(tool))?.tool ?? null;
/** A material Makera's catalogue lists the cutter for, in this app's words. */
function listedMaterial(tool: Tool): StockMaterial {
  for (const row of ROWS) {
    if (row.cutterId !== vendorId(tool)) continue;
    const m = catalogueMaterialFor(row.material);
    if (m !== null) return m;
  }
  throw new Error(`no app material for ${tool.name}`);
}

const BALLS = ['kz-ball-nose-2-12', 'kz-ball-nose-m-2-6', 'kz-ball-nose-m-1-3', 'kz-ball-nose-1-4'];

const JOBS = join(HERE, '..', '..', '..', 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');
function wolf(): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(join(JOBS, 'j06-wolf-2mm-ball.json'), 'utf8')));
  if (!parsed.ok) throw new Error(`j06-wolf-2mm-ball no longer parses: ${parsed.errors.join('; ')}`);
  return parsed.job;
}

describe('#863 — the house balls are covered by the catalogue', () => {
  it('the house records state the shank in `diameter` (the defect’s precondition)', () => {
    for (const id of BALLS) expect(house(id).tool.diameter).toBe(3.175);
  });

  it.each(BALLS)('%s is covered on a material its catalogue twin lists', (id) => {
    const tool = house(id).tool;
    const cov = catalogueCoverageFor(ROWS, listedMaterial(tool), tool);
    expect(cov.kind).toBe('covered');
  });

  it('no house record with a catalogue twin is "a different cutter" on any app material', () => {
    const materials = [...new Set(ROWS.map((r) => catalogueMaterialFor(r.material)).filter((m) => m !== null))];
    for (const e of fx.inventory) {
      for (const m of materials) {
        expect(catalogueCoverageFor(ROWS, m!, e.tool).kind, `${e.key} on ${m}`).not.toBe('mismatched');
      }
    }
  });

  it('a ball whose cutting diameter really differs from the id’s is still a different cutter', () => {
    const wrong: Tool = { ...house('kz-ball-nose-2-12').tool, name: 'my ball', tipDiameter: 2.5 };
    expect(catalogueCoverageFor(ROWS, 'pla', wrong)).toMatchObject({ kind: 'mismatched', field: 'diameter', owned: 2.5, catalogue: 2 });
  });

  it('a V-bit whose tip moved is still a different cutter', () => {
    const wrong: Tool = { ...house('kz-engrave-m-30-0-2').tool, tipDiameter: 0.3 };
    expect(catalogueCoverageFor(ROWS, 'aluminium-6061', wrong)).toMatchObject({ kind: 'mismatched', field: 'tip', owned: 0.3, catalogue: 0.2 });
  });
});

describe('#863 — a 3D finish on a demo goal can pick the ⌀2 ball', () => {
  const twos = fx.inventory.filter((e) => e.key === 'inv:kz-ball-nose-2-12' || e.key === 'inv:kz-ball-nose-m-2-6');

  it('the house ⌀2 ball passes the material gate without an owner’s vouch', () => {
    expect(materialRefusal(wolf(), house('kz-ball-nose-2-12'), ROWS)).toBeNull();
  });

  it('j06 wolf (2 mm ball, PLA) surfaces with the house ⌀2 ball', () => {
    const plan = planCutters(wolf(), null, twos, ROWS);
    expect(plan.unassigned).toEqual([]);
    expect(plan.cutters.map((c) => [c.key, c.diameter])).toEqual([['inv:kz-ball-nose-2-12', 2]]);
  });

  it('the measured search offers the ⌀2 ball from the whole house', () => {
    const keys = candidatePlans(wolf(), fx.inventory, ROWS).flatMap((p) => p.cutters.map((c) => c.key));
    expect(keys).toContain('inv:kz-ball-nose-2-12');
  });
});

/**
 * THE AUDIT — every house cutter kind: the cutting diameter each record states (tip first, then the
 * size in its name, then a `diameter` that is not the shank) against its catalogue twin's.
 */
const AUDIT: [id: string, kind: Tool['shape'], cut: number][] = [
  ['kz-corn-2-0-10-5', 'flat', 2],
  ['kz-corn-3-0-12', 'flat', 3],
  ['kz-o-flute-3-175-25', 'flat', 3.175],
  ['kz-ball-nose-2-12', 'ball', 2],
  ['kz-ball-nose-m-2-6', 'ball', 2],
  ['kz-ball-nose-m-1-3', 'ball', 1],
  ['kz-ball-nose-1-4', 'ball', 1],
  ['kz-ball-nose-3-175-22', 'ball', 3.175],
  ['kz-ball-nose-m-3-175-10', 'ball', 3.175],
  ['kz-drill-1-10', 'drill', 1],
  ['kz-drill-2-5-12', 'drill', 2.5],
  ['kz-drill-3-12', 'drill', 3],
  ['kz-engrave-30-0-3', 'engraving', 0.3],
  ['kz-engrave-m-60-0-1', 'engraving', 0.1],
  ['kz-chamfer-90', 'chamfer', 0.1],
  ['kz-thread-m3-9', 'thread', 2.4],
  ['kz-thread-m5-15', 'thread', 4],
];

describe('#863 — every house kind states its cutting diameter, never the shank', () => {
  it.each(AUDIT)('%s (%s) cuts at ⌀%s', (id, kind, cut) => {
    const tool = house(id).tool;
    expect(tool.shape).toBe(kind);
    expect(cuttingDiameter(tool)).toBe(cut);
    expect(statedCuttingSize(tool)).toBe(cut);
    expect(unambiguousCuttingDiameter(tool)).toBe(cut);
    const twin = twinOf(tool);
    if (twin !== null) expect(Math.abs(cuttingDiameter(twin)! - cut)).toBeLessThanOrEqual(LABEL_TOLERANCE_MM);
  });

  it('the audit covers every kind the house holds', () => {
    expect(new Set(fx.inventory.map((e) => e.tool.shape))).toEqual(new Set(AUDIT.map(([, k]) => k)));
  });

  it('a record with only the shank in `diameter` cuts at the size its name prints', () => {
    for (const id of ['kz-ball-nose-2-12', 'kz-drill-3-12', 'kz-thread-m3-9']) {
      const t: Tool = { ...house(id).tool, tipDiameter: null };
      expect(cuttingDiameter(t), id).toBe(cuttingDiameter(house(id).tool));
    }
  });

  it('reads the cut a name prints, and nothing from a name that prints none', () => {
    expect(namedCuttingDiameter('Two Flute Ball Nose Bit - 1/8" Shank 2mm * 12mm')).toBe(2);
    expect(namedCuttingDiameter('TiN Coating Drill Bit - 1/8" Shank 2.5mm * 12mm')).toBe(2.5);
    expect(namedCuttingDiameter('3.175*2*12mm Ball Nose')).toBe(2);
    expect(namedCuttingDiameter('6*0.5*30.5mm Ball Nose Engraving')).toBe(0.5);
    expect(namedCuttingDiameter('Thread Milling Bit - 1/8" Shank M3(d2.4mm) * 9mm')).toBe(2.4);
    expect(namedCuttingDiameter('3.175*22mm Ball Nose')).toBeNull();
    expect(namedCuttingDiameter('3.175*M3*9mm Thread')).toBeNull();
    expect(namedCuttingDiameter('Chamfering Bit - 1/8" Shank 90°')).toBeNull();
  });

  it('a tapered ball and a bull nose with the shank in `diameter` cut at their tip', () => {
    const tapered = fx.catalogue.find((e) => e.tool.id === '161032205031')!.tool; // 6*2*30.5mm Ball Nose Engraving
    expect(tapered.diameter).toBe(6);
    expect(cuttingDiameter(tapered)).toBe(2);
    expect(cuttingDiameter({ ...tapered, shape: 'tapered-ball', tipDiameter: null })).toBe(2);
    const bull: Tool = { ...tapered, id: null, shape: 'bull', name: '6*4*20mm Bull Nose', tipDiameter: 4, cornerRadius: 0.5 };
    expect(cuttingDiameter(bull)).toBe(4);
    expect(unambiguousCuttingDiameter({ ...bull, tipDiameter: null })).toBe(4);
    // A full-shank ball's `diameter` IS its cut, but alone it proves nothing beyond doubt.
    const full: Tool = { ...bull, shape: 'ball', name: 'ball', tipDiameter: null, diameter: 6 };
    expect(cuttingDiameter(full)).toBe(6);
    expect(unambiguousCuttingDiameter(full)).toBeNull();
  });
});

describe('#863 — the house build writes the cutting diameter', () => {
  const label = (code: string, text: string, reading: LabelRecord['reading']): LabelRecord => ({
    code,
    label: text,
    chinese: '',
    makeraSku: code,
    quantity: 1,
    codes: [],
    caseColours: ['blue'],
    reading,
  });
  const build = buildHouseInventory({
    records: [
      label('C1-BIT-BALL-NOSE-2-12', 'Two Flute Ball Nose Bit - 1/8" Shank 2mm * 12mm', { shape: 'ball', tipDiameter: 2, fluteLength: 12 }),
      label('C1-BIT-DRILL-3-12', 'TiN Coating Drill Bit - 1/8" Shank 3mm * 12mm', { shape: 'drill', tipDiameter: 3, fluteLength: 12 }),
      label('C1-BIT-CORN-2.0-10.5', 'TiN Coating Corn Bit - 1/8" Shank 2mm * 10.5mm', { shape: 'flat', tipDiameter: 2, fluteLength: 10.5 }),
      label('C1-BIT-THREAD-M3-9', 'Thread Milling Bit - 1/8" Shank M3(d2.4mm) * 9mm', { shape: 'thread', threadSpec: 'M3', fluteLength: 9, cutterDiameter: 2.4 }),
      label('C1-BIT-ENGRAVE-30-0.3', 'Single Flute Engraving Bit - 1/8" Shank 30° * 0.3mm', { shape: 'engraving', tipDiameter: 0.3, angleDeg: 30 }),
      label('C1-BIT-CHAMFER-90', 'Chamfering Bit - 1/8" Shank 90°', { shape: 'chamfer', angleDeg: 90 }),
    ],
  });

  it('builds every record cleanly', () => expect(build.problems).toEqual([]));

  it.each([
    ['kz-ball-nose-2-12', 2, 2],
    ['kz-drill-3-12', 3, 3],
    ['kz-corn-2-0-10-5', 2, 2],
    ['kz-thread-m3-9', 2.4, 2.4],
    // A V-bit's `diameter` is its BODY in both conventions (the catalogue's 3.175 too); the tip cuts.
    ['kz-engrave-30-0-3', 3.175, 0.3],
    ['kz-chamfer-90', 3.175, null],
  ])('%s: diameter %s, cutting ⌀ %s', (id, diameter, cut) => {
    const row = build.inventory.find((i) => i.id === id)!;
    expect(row.tool.diameter).toBe(diameter);
    expect(row.tool.handleDiameter).toBe(3.175);
    expect(statedCuttingSize(row.tool)).toBe(cut);
  });

  it('a rebuilt ball is covered with the catalogue’s own check', () => {
    const ball = build.inventory.find((i) => i.id === 'kz-ball-nose-2-12')!.tool;
    const withId: Tool = { ...ball, id: '131012203812' };
    expect(catalogueCoverageFor(ROWS, 'pla', withId).kind).toBe('covered');
  });
});
