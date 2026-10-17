// Issue #418 — the material-first start: what a picked piece of stock does to a new job, the mesh
// read as stock, the facing default (Q6), and the job field that names where the stock came from.

import { describe, it, expect } from 'vitest';
import locationDoc from './fixtures/location-doc.json';
import { Z1 } from '@/engine/cnc/machine';
import {
  boxProblem,
  facingDefault,
  facingSeed,
  facingShopFrom,
  finishOf,
  formProblem,
  shelfFor,
  shelfItemFromMade,
  shelfPickProblem,
  stockFromFile,
  stockFromMade,
  stockFromShelf,
  jobItemCount,
  stockStillNamed,
} from '@/engine/cnc/stockStart';
import { meshAsStock, plain3mfProblem, readStockFile, sha256Hex } from '@/engine/import/meshStock';
import { strToU8, zipSync } from 'fflate';
import type { ParsedMesh } from '@/engine/import/stlParser';
import { StockItemSchema, stockProblem, type StockItem } from '@/platform/stockClient';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { JobStockEntry } from '@/types/engraveJob';

const SHELF: StockItem[] = (locationDoc as { stock: unknown[] }).stock.map((s) => StockItemSchema.parse(s));
const PLATE = SHELF.find((s) => s.id === 'stock-plate1')!;
const BLANK = SHELF.find((s) => s.id === 'stock-blank1')!;

describe('a shelf entry as the stock (#418)', () => {
  it('a plate with one free maps straight onto the job, named and not reserved', () => {
    const r = stockFromShelf(PLATE, Z1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.choice.stock).toEqual({ length: 100, width: 100, thickness: 5, material: 'aluminium-6061' });
    expect(r.choice.entry).toEqual({
      kind: 'shelf',
      shelfId: 'stock-plate1',
      file: null,
      form: 'plate',
      finish: 'rough',
      conductive: true,
    });
    expect(r.choice.notes[0]).toContain('Cut mode reserves it');
  });

  it('a used-up entry is refused with the job that used it', () => {
    expect(shelfPickProblem(BLANK, Z1)).toBe('none left — consumed by job-12');
    expect(stockFromShelf(BLANK, Z1)).toEqual({ ok: false, reason: 'none left — consumed by job-12' });
  });

  it('an entry whose every piece is held for another job is refused', () => {
    const held = { ...PLATE, quantity: 1 };
    expect(shelfPickProblem(held, Z1)).toBe('all 1 held for other jobs');
  });

  it('layers and a dome are not invented onto the job — they are named instead', () => {
    const blank = { ...BLANK, quantity: 1, consumed: [] };
    const r = stockFromShelf(blank, Z1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.choice.stock).not.toHaveProperty('print');
    expect(r.choice.stock).not.toHaveProperty('flatness');
    expect(r.choice.notes.join(' ')).toMatch(/2 layers \(white, black\) are not carried/);
    expect(r.choice.notes.join(' ')).toMatch(/domed 0.2 mm/);
    expect(r.choice.entry.form).toBe('printed-blank');
  });

  it('round stock is refused by name, with where it belongs; a sphere is not a form', () => {
    for (const form of ['rod', 'tube', 'disc']) {
      expect(formProblem(form)).toMatch(new RegExp(`a ${form} is round stock .* rotary`));
    }
    expect(formProblem('sphere')).toMatch(/sphere stock is not offered/);
    const rod = StockItemSchema.parse({
      ...PLATE,
      id: 'rod-1',
      form: 'rod',
      size: { diameter: 10, length: 100 },
      reservations: [],
    });
    expect(shelfPickProblem(rod, Z1)).toMatch(/round stock/);
  });

  it('stock larger than the machine is refused, naming the axis', () => {
    expect(boxProblem({ length: 250, width: 50, thickness: 5 }, Z1)).toMatch(/250 mm long .* X travel/);
    expect(boxProblem({ length: 50, width: 250, thickness: 5 }, Z1)).toMatch(/250 mm wide .* Y travel/);
    expect(boxProblem({ length: 50, width: 50, thickness: 500 }, Z1)).toMatch(/500 mm thick .* Z travel/);
    expect(boxProblem({ length: Number.NaN, width: 50, thickness: 5 }, Z1)).toMatch(/length needs a number/);
    expect(boxProblem({ length: 100, width: 100, thickness: 5 }, Z1)).toBeNull();
  });

  it('the shelf door lists only the chosen material', () => {
    expect(shelfFor(SHELF, 'pla').map((s) => s.id)).toEqual(['stock-blank1']);
    expect(shelfFor(SHELF, 'brass')).toEqual([]);
  });
});

describe('a typed piece, and putting it on the shelf', () => {
  const made = { form: 'block' as const, material: 'brass' as const, finish: 'finished' as const, length: 40, width: 30, thickness: 20 };

  it('maps onto the job and, when kept, names the new shelf entry', () => {
    const r = stockFromMade(made, Z1, 'stock-new');
    expect(r.ok && r.choice.entry).toEqual({
      kind: 'made',
      shelfId: 'stock-new',
      file: null,
      form: 'block',
      finish: 'finished',
      conductive: true,
    });
  });

  it('the entry it becomes passes the shelf’s own rules', () => {
    const item = shelfItemFromMade(made, 'stock-new', '2026-10-16T10:00:00.000Z');
    expect(stockProblem(item)).toBeNull();
    expect(item).toMatchObject({ quantity: 1, flatness: 'unknown', conductive: true, source: 'purchased' });
  });

  it('a half-typed size is a refusal, not a job', () => {
    expect(stockFromMade({ ...made, thickness: Number.NaN }, Z1)).toEqual({
      ok: false,
      reason: 'the thickness needs a number in mm, above 0',
    });
  });
});

describe('the facing default comes from the finish (decision Q6)', () => {
  it('rough or unknown → on; finished or printed → off', () => {
    expect(facingDefault('rough').on).toBe(true);
    expect(facingDefault('unknown').on).toBe(true);
    expect(facingDefault('finished').on).toBe(false);
    expect(facingDefault('printed').on).toBe(false);
  });
});

// #432 slice 4 — the finish the panel and the sheet read, and the choice a new job starts with.
// Seeded rather than interpreted at Generate: a job with no `facing` key must plan as it did before
// #432, so the default has to be WRITTEN when the job is made.
describe('the facing choice a new job starts with (#432 slice 4)', () => {
  const entry = (finish: JobStockEntry['finish']): JobStockEntry => ({
    kind: 'made',
    shelfId: null,
    file: null,
    form: 'plate',
    finish,
    conductive: false,
  });

  it('reads the named entry’s finish', () => {
    expect(finishOf({ stockEntry: entry('rough'), stock: defaultEngraveJob().stock })).toBe('rough');
    expect(finishOf({ stockEntry: entry('finished'), stock: defaultEngraveJob().stock })).toBe('finished');
  });

  it('reads a printed blank’s implied finish when no entry names one', () => {
    const job = defaultEngraveJob();
    const printed = { ...job, stock: { ...job.stock, print: { split: 3, layerHeight: 0.2, firstLayerHeight: 0.2 } } };
    expect(finishOf(printed)).toBe('printed');
  });

  it('says nothing when neither the entry nor the print knows', () => {
    expect(finishOf(defaultEngraveJob())).toBeNull();
  });

  it('seeds on exactly for rough and unknown, and off for finished and printed', () => {
    expect(facingSeed('rough')).toEqual({ enabled: true, depth: 0.5 });
    expect(facingSeed('unknown')).toEqual({ enabled: true, depth: 0.2 });
    expect(facingSeed('finished')).toEqual({ enabled: false, depth: 0.2 });
    expect(facingSeed('printed')).toEqual({ enabled: false, depth: 0.2 });
    // No finish at all is the unknown default, not an invented one.
    expect(facingSeed(null)).toEqual({ enabled: true, depth: 0.2 });
  });

  it('fills the depth from the shop’s own figures, and falls back to the labelled seeds', () => {
    expect(facingSeed('rough', { rough: 0.8 })).toEqual({ enabled: true, depth: 0.8 });
    expect(facingShopFrom(null)).toEqual({ rough: 0.5, unknown: 0.2, margin: 0.1 });
  });

  it('seeds a job that still passes the schema — the key is optional, the seed is complete', () => {
    const job = { ...defaultEngraveJob(), facing: facingSeed('rough') };
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.job.facing).toEqual({ enabled: true, depth: 0.5 });
  });
});

/** A mesh from a list of triangles, each three [x, y, z] corners, unindexed as an STL is. */
function meshOf(tris: number[][][]): ParsedMesh {
  const positions = new Float32Array(tris.flat(2));
  const indices = new Uint32Array(positions.length / 3).map((_, i) => i);
  return {
    positions,
    indices,
    triangleCount: tris.length,
    bbox: { min: [0, 0, 0], max: [0, 0, 0] }, // not read by meshAsStock
  };
}

/** A closed prism over a convex outline (CCW), from z0 to z1, its sides split at `mid` when given. */
function prism(outline: [number, number][], z0: number, z1: number, mid?: number): number[][][] {
  const tris: number[][][] = [];
  for (let i = 1; i + 1 < outline.length; i++) {
    const [a, b, c] = [outline[0]!, outline[i]!, outline[i + 1]!];
    tris.push([[a[0], a[1], z1], [b[0], b[1], z1], [c[0], c[1], z1]]);
    tris.push([[a[0], a[1], z0], [c[0], c[1], z0], [b[0], b[1], z0]]);
  }
  const levels = mid === undefined ? [z0, z1] : [z0, mid, z1];
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i]!;
    const q = outline[(i + 1) % outline.length]!;
    for (let k = 0; k + 1 < levels.length; k++) {
      const lo = levels[k]!;
      const hi = levels[k + 1]!;
      tris.push([[p[0], p[1], lo], [q[0], q[1], lo], [q[0], q[1], hi]]);
      tris.push([[p[0], p[1], lo], [q[0], q[1], hi], [p[0], p[1], hi]]);
    }
  }
  return tris;
}

const RECT: [number, number][] = [
  [10, 20],
  [110, 20],
  [110, 80],
  [10, 80],
];

describe('an STL/3MF used as the stock (#418, §5.1 Load)', () => {
  it('a closed box is its own size, wherever it sits on the bed', () => {
    expect(meshAsStock(meshOf(prism(RECT, 2, 14)))).toEqual({ ok: true, length: 100, width: 60, thickness: 12, triangles: 12 });
  });

  it('side faces split at mid-height are still a prism', () => {
    const r = meshAsStock(meshOf(prism(RECT, 0, 12, 6)));
    expect(r.ok).toBe(true);
  });

  it('an open mesh is refused with its open-edge count', () => {
    const tris = prism(RECT, 0, 12);
    tris.pop();
    const r = meshAsStock(meshOf(tris));
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/not closed — 3 edges are not shared by exactly two triangles/) });
  });

  it('a shaped (non-prismatic) mesh is 3D stock, refused until #222', () => {
    const tet = [
      [[0, 0, 0], [0, 10, 0], [10, 0, 0]],
      [[0, 0, 0], [10, 0, 0], [0, 0, 10]],
      [[0, 0, 0], [0, 0, 10], [0, 10, 0]],
      [[10, 0, 0], [0, 10, 0], [0, 0, 10]],
    ];
    const r = meshAsStock(meshOf(tet));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/3D stock .*\(#222\)/);
  });

  it('a prism whose outline is not a rectangle is refused with how much of its box it covers', () => {
    const r = meshAsStock(meshOf(prism([[0, 0], [50, 0], [0, 40]], 0, 5)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/covers 50 % of its 50 × 40 mm bounding box/);
  });

  it('reads an STL file end to end, hashing its bytes', async () => {
    const tris = prism(RECT, 0, 12);
    const buf = new ArrayBuffer(84 + tris.length * 50);
    const dv = new DataView(buf);
    dv.setUint32(80, tris.length, true);
    let off = 84;
    for (const t of tris) {
      off += 12;
      for (const v of t) {
        for (const c of v) {
          dv.setFloat32(off, c, true);
          off += 4;
        }
      }
      off += 2;
    }
    const file = new File([buf], 'plate.stl');
    const read = await readStockFile(file);
    expect(read).toEqual({ kind: 'mesh', name: 'plate.stl', sha256: await sha256Hex(buf), length: 100, width: 60, thickness: 12 });

    const r = stockFromFile({ ...(read as { length: number; width: number; thickness: number; name: string; sha256: string }), material: 'pla', finish: 'printed' }, Z1);
    expect(r.ok && r.choice.entry).toMatchObject({ kind: 'file', form: 'printed-blank', file: { name: 'plate.stl' } });
  });

  it('a file that is not a mesh is a sentence, never a throw', async () => {
    expect(await readStockFile(new File(['hello'], 'notes.txt'))).toMatchObject({ kind: 'refused' });
    expect(await readStockFile(new File(['hello'], 'broken.stl'))).toMatchObject({ kind: 'refused' });
  });
});

describe('the job names where its stock came from (#418) — and only when it does', () => {
  const entry: JobStockEntry = { kind: 'shelf', shelfId: 'stock-plate1', file: null, form: 'plate', finish: 'rough', conductive: true };

  it('a job written before #418 round-trips with no key', () => {
    const job = defaultEngraveJob();
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.job).not.toHaveProperty('stockEntry');
      expect(parsed.job).toEqual(job);
    }
  });

  it('the entry survives the schema (it is not stripped)', () => {
    const parsed = parseEngraveJob({ ...defaultEngraveJob(), stockEntry: entry });
    expect(parsed.ok && parsed.job.stockEntry).toEqual(entry);
  });

  it('a shelf pick with no entry id, or a file with no file, is refused', () => {
    expect(parseEngraveJob({ ...defaultEngraveJob(), stockEntry: { ...entry, shelfId: null } }).ok).toBe(false);
    expect(parseEngraveJob({ ...defaultEngraveJob(), stockEntry: { ...entry, kind: 'file' } }).ok).toBe(false);
    expect(parseEngraveJob({ ...defaultEngraveJob(), stockEntry: { ...entry, form: 'rod' } }).ok).toBe(false);
  });
});

describe('#418 review fixes', () => {
  it('a rectangle turned in plan is named as turned, not as "not a rectangle"', () => {
    const c = Math.cos(Math.PI / 6);
    const sn = Math.sin(Math.PI / 6);
    const turn = (x: number, y: number): [number, number] => [x * c - y * sn, x * sn + y * c];
    const r = meshAsStock(meshOf(prism([turn(0, 0), turn(80, 0), turn(80, 40), turn(0, 40)], 0, 5)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/rectangle turned 30 ° in plan/);
  });

  it('copies of a corner a hair apart, straddling a weld cell, are still one vertex', () => {
    // The corner at x = 0.0005 sits on the 1 µm grid's rounding boundary: 0.0004999 rounds one way and
    // 0.0005001 the other. A plain rounded key would split it and read the box as open.
    let flip = false;
    const tris = prism([[0.0005, 0], [100, 0], [100, 60], [0.0005, 60]], 0, 12).map((t) =>
      t.map((v) => {
        if (v[0] !== 0.0005) return v;
        flip = !flip;
        return [flip ? 0.0004999 : 0.0005001, v[1]!, v[2]!];
      }),
    );
    expect(meshAsStock(meshOf(tris)).ok).toBe(true);
  });

  const model = (attrs: string, body: string, build: string) =>
    zipSync({
      '3D/3dmodel.model': strToU8(
        `<?xml version="1.0"?><model ${attrs} xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${body}</resources><build>${build}</build></model>`,
      ),
    }).buffer as ArrayBuffer;
  const MESH = '<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/></vertices><triangles></triangles></mesh></object>';

  it('a plain 3MF in mm with a translated build item is plain', () => {
    expect(plain3mfProblem(model('unit="millimeter"', MESH, '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 50 60 0"/>'))).toBeNull();
    expect(plain3mfProblem(model('', MESH, '<item objectid="1"/>'))).toBeNull();
  });

  it('inches, components, a scaled or turned build, and several items are refused by name', () => {
    expect(plain3mfProblem(model('unit="inch"', MESH, '<item objectid="1"/>'))).toMatch(/in inchs?, and only millimetres/);
    expect(
      plain3mfProblem(model('', `${MESH}<object id="2"><components><component objectid="1"/></components></object>`, '<item objectid="2"/>')),
    ).toMatch(/components/);
    expect(plain3mfProblem(model('', MESH, '<item objectid="1" transform="2 0 0 0 2 0 0 0 2 0 0 0"/>'))).toMatch(/scales or turns/);
    expect(plain3mfProblem(model('', MESH, '<item objectid="1" transform="0 1 0 -1 0 0 0 0 1 0 0 0"/>'))).toMatch(/scales or turns/);
    expect(plain3mfProblem(model('', MESH, '<item objectid="1"/><item objectid="1"/>'))).toMatch(/2 items/);
    expect(plain3mfProblem(model('', `${MESH}${MESH.replace('id="1"', 'id="3"')}`, '<item objectid="1"/>'))).toMatch(/2 mesh objects/);
  });

  it('the shipped demo lines are not the person’s items; anything else is', () => {
    const job = defaultEngraveJob();
    expect(jobItemCount(job)).toBe(0);
    expect(jobItemCount({ ...job, labels: job.labels.slice(0, 1) })).toBe(1);
    expect(jobItemCount({ ...job, labels: [], drills: [{} as never] })).toBe(1);
  });

  it('the entry is still named only while the size and the material are the same', () => {
    const s = defaultEngraveJob().stock;
    expect(stockStillNamed(s, { ...s })).toBe(true);
    expect(stockStillNamed(s, { ...s, length: s.length + 1 })).toBe(false);
    expect(stockStillNamed(s, { ...s, material: 'brass' })).toBe(false);
  });
});
