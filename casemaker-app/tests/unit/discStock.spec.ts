// #743 D-1/D-3 — the round blank (disc) milled flat, end to end: the stock shape and its one
// migration, the circle a border and the setup seed follow, the off-the-disc refusal for a job
// with NO stock entry, the cylinder the sweep starts from, facing over the rim, and a circular
// prism read from a file as a disc.
//
// The job is the design's own fixture (`docs/bench/2026-10-28-z1-real-jobs/jobs/j04-coin-disc-pla.json`):
// the j04 coin proxy's items on a ⌀30 × 3 mm PLA disc. Areas are asserted against closed forms,
// not against a second run of the same code.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import ManifoldModule from 'manifold-3d';

import { Z1 } from '@/engine/cnc/machine';
import {
  rodDimsOf,
  shelfItemFromMade,
  stockFromFile,
  stockFromMade,
  stockFromShelf,
  stockSizeWords,
  stockStillNamed,
} from '@/engine/cnc/stockStart';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatStockOutline, toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { toSetup, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { generateFacing } from '@/engine/cnc/cam/facing';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { circleProfile, pTranslate } from '@/engine/compiler/profile';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import { meshAsStock } from '@/engine/import/meshStock';
import { parseStl } from '@/engine/import/stlParser';
import { flatEndMill } from '@/engine/cnc/tool';
import { runSheetStockLine } from '@/engine/cnc/engrave/runSheet';
import { BUNDLED_FONT_KEYS, registerBundledFontBytes } from '@/engine/fonts/registry';
import type { EngraveJob } from '@/types/engraveJob';
import type { CutParams } from '@/engine/cnc/feeds';

const HERE = dirname(fileURLToPath(import.meta.url));
const JOBS = join(HERE, '..', '..', '..', 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');

type TL = Awaited<ReturnType<typeof ManifoldModule>>;
let tl: TL;

const area = (profile: Parameters<typeof executeProfile>[1]): number => {
  const cs = executeProfile(tl, profile);
  const a = cs.area();
  cs.delete();
  return a;
};

function loadCoin(): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(join(JOBS, 'j04-coin-disc-pla.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.job;
}

const DISC = { length: 30, width: 30, thickness: 3, shape: 'disc' as const, diameter: 30 };

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
  tl.setup();
  // Typeset labels need the bundled faces, exactly as the vitest setup file seeds them.
  const filesDir = join(HERE, '..', '..', 'src', 'engine', 'fonts', 'files');
  for (const key of BUNDLED_FONT_KEYS) {
    const buf = readFileSync(join(filesDir, `${key}.ttf`));
    registerBundledFontBytes(key, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
});

describe('#743 a disc is a stock shape, not a form label', () => {
  it('writes shape "disc" and its diameter beside the D × D × T box', () => {
    const made = { length: 30, width: 30, thickness: 3, form: 'disc' as const, material: 'pla' as const, finish: 'rough' as const };
    const r = stockFromMade(made, Z1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.choice.stock).toMatchObject({ length: 30, width: 30, thickness: 3, material: 'pla', shape: 'disc', diameter: 30 });
    expect(r.choice.entry.form).toBe('disc');
    // A disc is never a rod: the chuck's own reading answers null, so no rotary path can take it.
    expect(rodDimsOf(r.choice.stock)).toBeNull();
    expect(stockSizeWords(r.choice.stock)).toBe('⌀30 × 3 mm');
  });

  it('writes the same facts from a shelf entry', () => {
    const made = { length: 30, width: 30, thickness: 3, form: 'disc' as const, material: 'pla' as const, finish: 'rough' as const };
    const item = shelfItemFromMade(made, 'stock-disc-30', '2026-10-29T00:00:00.000Z');
    const r = stockFromShelf(item, Z1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.choice.stock.shape).toBe('disc');
    expect(r.choice.stock.diameter).toBe(30);
    expect(r.choice.entry.form).toBe('disc');
  });

  it('keeps the entry while the piece is the same disc, and drops it for a plate of the same box', () => {
    const disc = { length: 30, width: 30, thickness: 3, material: 'pla' as const, shape: 'disc' as const, diameter: 30 };
    expect(stockStillNamed(disc, { ...disc })).toBe(true);
    expect(stockStillNamed(disc, { ...disc, diameter: 31, length: 31, width: 31 })).toBe(false);
    const plate = { length: 30, width: 30, thickness: 3, material: 'pla' as const };
    expect(stockStillNamed(disc, plate)).toBe(false);
  });
});

describe('#743 the disc in the job schema', () => {
  it('parses a disc and round-trips it with its shape and diameter', () => {
    const base = defaultEngraveJob();
    const job = { ...base, stock: { ...base.stock, ...DISC }, stockEntry: { kind: 'made', shelfId: null, file: null, form: 'disc', finish: 'rough', conductive: false } };
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.stock.shape).toBe('disc');
    expect(parsed.job.stock.diameter).toBe(30);
  });

  it('refuses a disc whose box is not D × D, a wall, and a diameter without a shape', () => {
    const base = defaultEngraveJob();
    const parse = (stock: Partial<EngraveJob['stock']>) =>
      parseEngraveJob(JSON.parse(JSON.stringify({ ...base, stock: { ...base.stock, ...stock } })));

    const skew = parse({ length: 30, width: 32, thickness: 3, shape: 'disc', diameter: 30 });
    expect(skew.ok).toBe(false);
    if (!skew.ok) expect(skew.errors.join('\n')).toContain('D × D × T');

    const wall = parse({ ...DISC, wall: 2 });
    expect(wall.ok).toBe(false);
    if (!wall.ok) expect(wall.errors.join('\n')).toContain('no bore');

    const loose = parse({ length: 30, width: 30, thickness: 3, diameter: 30 });
    expect(loose.ok).toBe(false);
    if (!loose.ok) expect(loose.errors.join('\n')).toContain('needs the cylinder shape');
  });

  it('migrates a pre-change disc job from its form label, and leaves the square proxy untouched', () => {
    const base = defaultEngraveJob();
    const legacy = {
      ...base,
      stock: { length: 30, width: 30, thickness: 3, material: 'pla' as const },
      stockEntry: { kind: 'made', shelfId: null, file: null, form: 'disc', finish: 'rough', conductive: false },
    };
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(legacy)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.job.stock.shape).toBe('disc');
      expect(parsed.job.stock.diameter).toBe(30);
    }

    const proxy = JSON.parse(readFileSync(join(JOBS, 'j04-coin-pla-proxy.json'), 'utf8')) as { stock: Record<string, unknown> };
    const proxyParsed = parseEngraveJob(proxy);
    expect(proxyParsed.ok).toBe(true);
    // The old 32 × 32 proxy still states a rectangle: no shape, no diameter.
    expect(proxyParsed.ok && proxyParsed.job.stock).toEqual(proxy.stock);
  });
});

describe('#743 the plan follows the rim', () => {
  it('makes the stock outline the disc’s circle, centred in the box', () => {
    const job = loadCoin();
    const plan = toPartPlan(job);
    expect(plan.stock.outline).toEqual(
      pTranslate([15, 15], circleProfile(15, segmentsForRadius(15))),
    );
    expect(flatStockOutline(job.stock)).toEqual(plan.stock.outline);
  });

  it('makes a Border at inset 0 an annulus of the rim', () => {
    const job = loadCoin();
    const withBorder: EngraveJob = {
      ...job,
      combined: [
        ...(job.combined ?? []),
        { id: 'rim', kind: 'border', position: { x: 0, y: 0 }, rotation: 0, depth: 0.4, enabled: true, inset: 0, width: 1 },
      ],
    };
    const plan = toPartPlan(withBorder);
    const rim = plan.engraves.find((e) => e.id === 'rim');
    expect(rim).toBeDefined();
    if (rim === undefined) return;
    const expected = Math.PI * (15 * 15 - 14 * 14);
    expect(Math.abs(area(rim.profile) - expected) / expected).toBeLessThan(0.005);
  });

  it('seeds the sweep from a cylinder: a prism with the rim outline', () => {
    const job = loadCoin();
    const setup = toSetup(job, Z1);
    expect(setup.part.kind).toBe('prism');
    if (setup.part.kind !== 'prism') return;
    const circle = Math.PI * 15 * 15;
    expect(Math.abs(area(setup.part.outline) - circle) / circle).toBeLessThan(0.005);
    expect(setup.part.thickness).toBe(3);
  });

  it('names a disc’s stock on the run sheet, not its box', () => {
    const job = loadCoin();
    expect(runSheetStockLine(job)).toBe('disc ⌀30 × 3 mm PLA');
  });
});

describe('#743 the off-the-disc refusal reads stock.shape', () => {
  it('passes the coin as drawn — its cleared field is a circle, not the box’s corners', () => {
    const job = loadCoin();
    expect(validateJob(job).some((f) => f.code === 'item-off-round-stock')).toBe(false);
  });

  it('refuses “Software” moved 2 mm out, on a job with NO stock entry', () => {
    const job = loadCoin();
    expect(job.stockEntry).toBeUndefined();
    const moved: EngraveJob = {
      ...job,
      labels: job.labels.map((l) => (l.id === 'software' ? { ...l, position: { x: l.position.x, y: l.position.y - 2 } } : l)),
    };
    const off = validateJob(moved).find((f) => f.code === 'item-off-round-stock');
    expect(off).toBeDefined();
    expect(off!.severity).toBe('error');
    expect(off!.labelId).toBe('software');
    expect(off!.message).toContain('⌀30 mm');
    expect(off!.message).toContain('the disc');
  });
});

describe('#743 facing follows the rim', () => {
  const TOOL = flatEndMill(3.175);
  const R = 1.5875;
  const PARAMS: CutParams = { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.4, stepOver: 1.0, peck: 1, air: true };

  it('keeps the cutter’s edge inside the rim and spends less time than the box plan', () => {
    const box = generateFacing({ length: 30, width: 30 }, TOOL, PARAMS, Z1.rapidEstimate, 0.4);
    const disc = generateFacing({ length: 30, width: 30, shape: 'disc', diameter: 30 }, TOOL, PARAMS, Z1.rapidEstimate, 0.4);
    expect(disc.operations[0]!.estimatedSeconds).toBeLessThanOrEqual(0.85 * box.operations[0]!.estimatedSeconds);

    const centre = [15, 15] as const;
    const feeds = disc.operations[0]!.moves.filter((m) => m.kind === 'feed');
    expect(feeds.length).toBeGreaterThan(0);
    for (const move of feeds) {
      expect(Math.hypot(move.x - centre[0], move.y - centre[1]) + R).toBeLessThanOrEqual(15 + 0.002);
    }
  });
});

describe('#743 a circular prism loaded as stock is a disc', () => {
  it('reads disc-30x3.stl as ⌀30 × 3 with shape "disc"', () => {
    const buf = readFileSync(join(HERE, 'fixtures', 'disc', 'disc-30x3.stl'));
    const mesh = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const read = meshAsStock(mesh);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.shape).toBe('disc');
    expect(read.length).toBeCloseTo(30, 2);
    expect(read.width).toBeCloseTo(30, 2);
    expect(read.thickness).toBeCloseTo(3, 2);
  });

  it('writes the file’s disc onto the job, with the disc form', () => {
    const r = stockFromFile(
      { name: 'disc-30x3.stl', sha256: 'x', length: 30, width: 30, thickness: 3, material: 'pla', finish: 'rough', shape: 'disc' },
      Z1,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.choice.stock).toMatchObject({ shape: 'disc', diameter: 30, length: 30, width: 30, thickness: 3 });
    expect(r.choice.entry.form).toBe('disc');
    expect(r.choice.notes.join(' ')).toContain('rim is a circle');
  });
});
