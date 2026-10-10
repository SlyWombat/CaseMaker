// ONE document, TWO implementations (#319/#320).
//
// The service stores `house.json`, validates a document before it adopts it, and serves two bodies
// from it — `GET /api/v1/tools` and `GET /api/v1/inventory`. The client parses both with schemas it
// also WRITES with. Nothing but those two schemas stands between a stored document and the panel,
// so the defect this guards is a document the service accepts and the client refuses: the house
// then reads `absent` — catalogue tier and all — while `/health` still says ok, and nothing names
// the import that caused it.
//
// The specimen is `fixtures/house-doc.json`, read by `house.rs`'s test of the same name, which
// imports it, serves it and round-trips it. This side asserts the two things that make the pairing
// worth having: the document is one the client's schemas accept, and a document broken in any of
// the ways the service now refuses is one BOTH sides refuse.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ToolLibrarySchema, isToolKey } from '@/engine/cnc/toolLibrary';
import { InventorySchema } from '@/platform/houseClient';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'house-doc.json');

/** The document as stored. It is the service's `HouseDoc`, so it carries the keys the wire drops. */
function doc(): { tools: unknown[]; inventory: unknown[] } {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as { tools: unknown[]; inventory: unknown[] };
}

/** One row's `Tool`, as stored: what a `ToolLibraryEntry` carries under its own `tool`. */
function aTool(): unknown {
  return (doc().tools[0] as { tool: unknown }).tool;
}

/** One field of one row, replaced — the same mutations `house.rs` refuses, in the same order. */
function broken(mutate: (d: ReturnType<typeof doc>) => void): ReturnType<typeof doc> {
  const d = doc();
  mutate(d);
  return d;
}

describe('the house contract (#320)', () => {
  it('parses the document the service accepts, on both of its served bodies', () => {
    const d = doc();
    // `GET /tools` serves `ToolLibraryEntry` — the same objects without `origin`, which is the
    // house's own bookkeeping. Zod strips it, so parsing the stored rows is parsing the body.
    const tools = ToolLibrarySchema.safeParse(d.tools);
    expect(tools.success, JSON.stringify(tools.error?.issues)).toBe(true);
    expect(tools.data?.map((e) => e.key)).toEqual(['user:1a2b3c4d5e', 'user:6f7a8b9c0d']);

    const inventory = InventorySchema.safeParse(d.inventory);
    expect(inventory.success, JSON.stringify(inventory.error?.issues)).toBe(true);
    expect(inventory.data?.[0]?.codes[0]?.value).toBe('C1-BIT-BALL-NOSE-1-4');
  });

  // Each of these is a document `house.rs::import` refuses with 400 and `validate_key`/`validate`
  // names. They are asserted here so the two contracts are checked against ONE list: if the client
  // ever loosens, this test fails next to the Rust one that tightened.
  it.each([
    [
      'a duplicate tool key',
      (d: ReturnType<typeof doc>) => {
        d.tools[1] = { ...(d.tools[1] as object), key: 'user:1a2b3c4d5e' };
      },
    ],
    [
      'a tool with no provenance',
      (d: ReturnType<typeof doc>) => {
        d.tools[0] = { ...(d.tools[0] as object), provenance: '' };
      },
    ],
    [
      'a duplicate inventory id',
      (d: ReturnType<typeof doc>) => {
        d.inventory.push(d.inventory[0]);
      },
    ],
    [
      'one code on two cutters',
      (d: ReturnType<typeof doc>) => {
        const second = JSON.parse(JSON.stringify(d.inventory[0])) as { id: string };
        second.id = 'inv-9z8y7x';
        d.inventory.push(second);
      },
    ],
    [
      'an item that does not say when it was registered',
      (d: ReturnType<typeof doc>) => {
        d.inventory[0] = { ...(d.inventory[0] as object), addedAt: '' };
      },
    ],
  ])('refuses %s, as the service does', (_why, mutate) => {
    const d = broken(mutate);
    expect(ToolLibrarySchema.safeParse(d.tools).success && InventorySchema.safeParse(d.inventory).success).toBe(
      false,
    );
  });
});

// #319 — the key rule, from the client's side. The service stores exactly `user:<something>`; the
// client reads four namespaces, so its rule is the service's applied to the vocabulary it carries.
describe('the key rule (#319)', () => {
  it('accepts the four namespaces the app carries', () => {
    for (const key of ['flat-1.0', 'cat:112111313812', 'user:1a2b3c4d5e', 'inv:1a2b3c']) {
      expect(isToolKey(key), key).toBe(true);
      expect(
        ToolLibrarySchema.safeParse([{ key, tool: aTool(), provenance: 'x' }]).success,
        key,
      ).toBe(true);
    }
  });

  it.each([
    ['cat:112111313812'.toUpperCase(), 'the catalogue namespace, by case'],
    ['cat:', 'the namespace with no name after it'],
    ['user:', 'the namespace with no name after it'],
    [':', 'a namespace with nothing on either side'],
    ['flat:1.0', 'a colon in a namespace nobody owns'],
    [' user:x ', 'whitespace at both ends'],
    ['user:x ', 'whitespace at the end'],
    ['user:a\nG0 Z-50', 'a newline, which ends the .nc header’s comment line'],
    ['user:a\tb', 'a tab'],
    ['user:a|b', 'a pipe cannot survive the .nc header'],
    ['', 'an empty key'],
  ])('refuses %j — %s', (key) => {
    expect(isToolKey(key)).toBe(false);
    // And the schema is where it bites: a body carrying one is a refusal of the whole list, the
    // same way a duplicate key already was.
    const parsed = ToolLibrarySchema.safeParse([{ key, tool: aTool(), provenance: 'typed in' }]);
    expect(parsed.success).toBe(false);
  });
});
