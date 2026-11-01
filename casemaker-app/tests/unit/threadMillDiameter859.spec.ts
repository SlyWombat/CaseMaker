// #859 — a thread mill's diameter is its CUTTING diameter, never its shank.
//
// The 2026-11-01 demo re-run (j18-thread-b-mill-alu, an M3×0.5 thread in 6061) picked
// "3.175*M2.5*7.5mm Thread" and warned that its tooth would not cut the M3 flank. Makera's own M3
// mill, `kz-thread-m3-9`, was in the library, but its house record carried the 3.175 mm SHANK in
// `diameter` (and the label's d2.4 in `tipDiameter`), while the catalogue states the same g_ID with
// its 2.42 mm cutting diameter. The coverage rule compared the shank with the cutting column, called
// the two "a different cutter", and refused the M3 mill. The fixture is the run's own job and the
// thread mills of its location and catalogue, trimmed (`fixtures/thread859`).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withCatalogueValues, catalogueValueSentence } from '@/engine/cnc/engrave/catalogueTool';
import { planCutters } from '@/engine/cnc/engrave/cutterPlan';
import { threadMillFit } from '@/engine/cnc/engrave/threadFit';
import { catalogueCoverageFor, withCatalogueGeometry, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { buildHouseInventory } from '@/engine/cnc/houseDocument';
import {
  cuttingDiameter,
  statedCuttingSize,
  namedCuttingDiameter,
  type Tool,
} from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(HERE, 'fixtures/thread859');

interface Fixture {
  catalogue: ToolLibraryEntry[];
  feeds: FeedCatalogueRow[];
  inventory: ToolLibraryEntry[];
}
const fx = JSON.parse(readFileSync(resolve(FIX, 'thread-mills.json'), 'utf8')) as Fixture;
const ROWS = withCatalogueGeometry(fx.feeds, fx.catalogue.map((e) => e.tool));
const M3_KIT = fx.inventory.find((e) => e.key === 'inv:kz-thread-m3-9')!;
const M5_KIT = fx.inventory.find((e) => e.key === 'inv:kz-thread-m5-15')!;

function j18(): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(resolve(FIX, 'j18-thread-b-mill-alu.json'), 'utf8')));
  if (!parsed.ok) throw new Error(`the j18 fixture no longer parses: ${JSON.stringify(parsed.errors)}`);
  return parsed.job;
}

describe('#859 — the M3 job picks Makera’s M3 thread mill', () => {
  it('the house record states the shank in `diameter` (the defect’s precondition)', () => {
    expect(M3_KIT.tool.diameter).toBe(3.175);
    expect(M3_KIT.tool.tipDiameter).toBe(2.4);
  });

  it('j18 (M3×0.5, 6061) picks inv:kz-thread-m3-9 from the run’s thread mills', () => {
    const job = j18();
    const plan = planCutters(job, null, fx.inventory, ROWS);
    expect(plan.unassigned).toEqual([]);
    expect(plan.cutters.map((c) => c.key)).toEqual(['inv:kz-thread-m3-9']);
    expect(plan.cutters[0]!.diameter).toBe(2.4);
  });

  it('its fit check passes on every thread of the job, pitch included', () => {
    for (const t of j18().threads ?? []) {
      const fit = threadMillFit(M3_KIT.tool, t);
      expect(fit.refusal).toBeNull();
      expect(fit.pitchMatches).toBe(true);
    }
  });

  it('the catalogue covers the M3 and M5 house records (cutting vs cutting, within the label’s 0.1 mm)', () => {
    expect(catalogueCoverageFor(ROWS, 'aluminium-6061', M3_KIT.tool).kind).toBe('covered');
    expect(catalogueCoverageFor(ROWS, 'aluminium-6061', M5_KIT.tool).kind).toBe('covered');
  });

  it('a record whose cutting diameter really differs from the id’s is still a different cutter', () => {
    const wrong: Tool = { ...M3_KIT.tool, name: 'Thread mill M3 (d1.96mm)', tipDiameter: 1.96 };
    const cov = catalogueCoverageFor(ROWS, 'aluminium-6061', wrong);
    expect(cov).toMatchObject({ kind: 'mismatched', field: 'diameter', owned: 1.96, catalogue: 2.42 });
  });
});

describe('#859 — a thread mill’s cutting diameter is never its shank', () => {
  it('reads the size its name prints', () => {
    expect(namedCuttingDiameter('Thread Milling Bit - 1/8" Shank M3(d2.4mm) * 9mm')).toBe(2.4);
    expect(namedCuttingDiameter('Thread Milling Bit - 1/8" Shank M5(d4) * 15mm')).toBe(4);
    expect(namedCuttingDiameter('Thread mill 1/4-20 UNC (d4.0mm)')).toBe(4);
    expect(namedCuttingDiameter('3.175*M3*9mm Thread')).toBeNull();
  });

  it('a record with only the shank in `diameter` and the size in its name cuts at the name’s size', () => {
    const t: Tool = { ...M3_KIT.tool, tipDiameter: null };
    expect(cuttingDiameter(t)).toBe(2.4);
    expect(statedCuttingSize(t)).toBe(2.4);
  });

  it('a catalogue row cuts at its cutting column', () => {
    const cat = fx.catalogue.find((e) => e.tool.id === '152111243809')!.tool;
    expect(cuttingDiameter(cat)).toBe(2.42);
  });

  it('the catalogue twin’s cutting diameter replaces the shank and the label’s rounding', () => {
    const entries = [...fx.catalogue, M3_KIT];
    const { tool, filled } = withCatalogueValues(M3_KIT.tool, entries);
    expect(tool.diameter).toBe(2.42);
    expect(tool.tipDiameter).toBe(2.42);
    expect(filled).toEqual([{ field: 'diameter', mm: 2.42, cutterName: '3.175*M3*9mm Thread', replaced: 2.4 }]);
    expect(catalogueValueSentence(tool, filled)).toBe(
      'The cutter "Thread Milling Bit - 1/8" Shank M3(d2.4mm) * 9mm" states its cutting diameter as 2.4 mm; ' +
        'this run uses 2.42 mm, the size Makera\'s catalogue record for "3.175*M3*9mm Thread" states.',
    );
  });

  it('a record that disagrees with its twin is left alone', () => {
    const wrong: Tool = { ...M3_KIT.tool, name: 'Thread mill M3 (d1.96mm)', tipDiameter: 1.96 };
    expect(withCatalogueValues(wrong, [...fx.catalogue]).filled).toEqual([]);
  });

  it('the house build writes a thread mill’s cutting diameter into `diameter`', () => {
    const build = buildHouseInventory({
      records: [
        {
          code: 'C1-BIT-THREAD-M3-9',
          label: 'Thread Milling Bit - 1/8" Shank M3(d2.4mm) * 9mm',
          chinese: '螺纹铣刀',
          makeraSku: 'C1-BIT-THREAD-M3-9',
          quantity: 1,
          codes: [],
          caseColours: ['blue'],
          reading: { shape: 'thread', threadSpec: 'M3', fluteLength: 9, cutterDiameter: 2.4 },
        },
      ],
    });
    const tool = build.inventory[0]!.tool;
    expect(tool.diameter).toBe(2.4);
    expect(tool.tipDiameter).toBe(2.4);
    expect(tool.handleDiameter).toBe(3.175);
  });
});
