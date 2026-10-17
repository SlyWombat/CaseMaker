// The vendor's stock sizes (#446): the row schema the client reads, and the list fetch against a fake
// service. The rows here are SYNTHETIC — no vendor row is committed (#347 Route A).

import { afterEach, describe, expect, it } from 'vitest';
import { setHouseClientLoader, type HouseClient } from '@/platform/houseClient';
import { houseMaterialSpecs, MaterialSpecSchema } from '@/platform/materialSpecsClient';

/** A rectangular blank, as `catalogue.rs` serves it. */
const RECT = {
  id: 'spec-r-1',
  material: 'Hardwood',
  name: 'Hardwood / 100mm * 200mm * 5mm',
  shape: 'R',
  length: 200,
  width: 100,
  height: 5,
  diameter: null,
  stockCode: '9990000000000001',
};

/** A round bar, same shape of row with the other dims. */
const ROUND = {
  id: 'spec-c-1',
  material: 'Hardwood',
  name: 'Hardwood Dowel / 12mm * 300mm',
  shape: 'C',
  length: 300,
  width: null,
  height: null,
  diameter: 12,
  stockCode: '',
};

function serve(body: unknown, etag = '"specs-1"') {
  const client = {
    call: async (method: string, path: string) => {
      if (method !== 'GET' || path !== '/material-specs') return { kind: 'refused', status: 404, message: 'no' };
      return { kind: 'ok', text: typeof body === 'string' ? body : JSON.stringify(body), etag };
    },
  } as unknown as HouseClient;
  setHouseClientLoader(async () => client);
}

afterEach(() => setHouseClientLoader(null));

describe("the vendor's stock size row (#446)", () => {
  it('reads a rectangular size and a round size, each with its own dims', () => {
    const r = MaterialSpecSchema.parse(RECT);
    expect(r).toMatchObject({ shape: 'R', width: 100, height: 5, diameter: null });
    const c = MaterialSpecSchema.parse(ROUND);
    expect(c).toMatchObject({ shape: 'C', diameter: 12, width: null, height: null });
    // An empty `g_ID` is the vendor not stating a code, not a bad row.
    expect(c.stockCode).toBe('');
  });

  it('refuses a dim the shape does not use, and a dim its shape needs but lacks', () => {
    // The rules `catalogue.rs` drops rows by, stated row by row on this side too.
    expect(MaterialSpecSchema.safeParse({ ...ROUND, width: 10 }).success).toBe(false);
    expect(MaterialSpecSchema.safeParse({ ...ROUND, height: 10 }).success).toBe(false);
    expect(MaterialSpecSchema.safeParse({ ...RECT, diameter: 10 }).success).toBe(false);
    expect(MaterialSpecSchema.safeParse({ ...RECT, width: null }).success).toBe(false);
    expect(MaterialSpecSchema.safeParse({ ...RECT, height: null }).success).toBe(false);
    expect(MaterialSpecSchema.safeParse({ ...ROUND, diameter: null }).success).toBe(false);
  });

  it('refuses a shape this build does not know, a zero dim, and an unknown key', () => {
    expect(MaterialSpecSchema.safeParse({ ...RECT, shape: 'S' }).success).toBe(false);
    expect(MaterialSpecSchema.safeParse({ ...RECT, length: 0 }).success).toBe(false);
    expect(MaterialSpecSchema.safeParse({ ...RECT, width: -1 }).success).toBe(false);
    expect(MaterialSpecSchema.safeParse({ ...RECT, name: '  ' }).success).toBe(false);
    // Strict, as the service's serde is: a key neither side knows is a refusal, not a silent drop.
    expect(MaterialSpecSchema.safeParse({ ...RECT, colour: 'brown' }).success).toBe(false);
  });
});

describe('reading the vendor sizes (#446)', () => {
  it('loads the rows it understands and sets the rest aside with a reason', async () => {
    serve([RECT, ROUND, { ...RECT, id: 'spec-bad', width: null }]);
    const read = await houseMaterialSpecs();
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.specs.map((s) => s.id)).toEqual(['spec-r-1', 'spec-c-1']);
    expect(read.etag).toBe('"specs-1"');
    expect(read.unreadable).toHaveLength(1);
    expect(read.unreadable[0]).toMatchObject({ id: 'spec-bad' });
    expect(read.unreadable[0]?.reason).toContain('width');
  });

  it('treats an empty list as a normal answer', async () => {
    serve([]);
    expect(await houseMaterialSpecs()).toEqual({ kind: 'ok', etag: '"specs-1"', specs: [], unreadable: [] });
  });

  it('treats a 404 as a service from before #446, and a non-list as an error', async () => {
    serve('[]');
    const client = {
      call: async () => ({ kind: 'refused', status: 404, message: 'not here' }),
    } as unknown as HouseClient;
    setHouseClientLoader(async () => client);
    expect((await houseMaterialSpecs()).kind).toBe('absent');

    serve({ not: 'a list' });
    const notList = await houseMaterialSpecs();
    expect(notList.kind).toBe('error');

    serve('not json');
    expect((await houseMaterialSpecs()).kind).toBe('error');
  });
});
