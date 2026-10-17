// #415 — a cutter's condition per copy, the rules tool choice reads, and the runtime warning that
// only warns. The shared fixture's inventory item carries one described copy.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  conditionForKey,
  conditionRank,
  inventoryConditions,
  itemConditionSummary,
  resetInventoryConditions,
  runtimeWarning,
  setInventoryConditions,
  type ItemWithCopies,
  type ToolCopy,
} from '@/engine/cnc/toolCondition';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { TOOL_LIBRARY, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { InventoryItemSchema, InventorySchema } from '@/platform/houseClient';
import { readDefault, ShopDefaultsSchema } from '@/platform/defaultsClient';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
  inventory: unknown[];
  defaults: Record<string, unknown>;
};

const copy = (id: string, condition: ToolCopy['condition']): ToolCopy => ({
  id,
  condition,
  whereabouts: { kind: 'box' },
  runtimeWarnMinutes: null,
  notes: null,
  runtimeMinutes: null,
});

afterEach(resetInventoryConditions);

describe('#415 the copies on an inventory item', () => {
  it('parses the fixture’s described copy and collet fits, and an item from before them', () => {
    const items = InventorySchema.parse(DOC.inventory);
    expect(items[0]!.copies[0]).toMatchObject({ condition: 'worn', whereabouts: { kind: 'machine', machineId: 'machine-1a2b3c' } });
    expect(items[0]!.colletFits).toEqual(['machine-1a2b3c']);
    const { copies: _c, colletFits: _f, ...older } = DOC.inventory[0] as Record<string, unknown>;
    const parsed = InventoryItemSchema.parse(older);
    expect([parsed.copies, parsed.colletFits]).toEqual([[], null]);
  });

  it('refuses what `tool_copy.rs` refuses', () => {
    const base = DOC.inventory[0] as Record<string, unknown>;
    for (const bad of [
      { ...base, quantity: 1, copies: [copy('a', 'new'), copy('b', 'new')] },
      { ...base, copies: [copy('a', 'new'), copy('a', 'used')] },
      {
        ...base,
        copies: [
          { ...copy('a', 'new'), whereabouts: { kind: 'machine', machineId: 'm-1' } },
          { ...copy('b', 'new'), whereabouts: { kind: 'machine', machineId: 'm-1' } },
        ],
      },
      { ...base, copies: [{ ...copy('a', 'new'), condition: 'retired' }] },
      { ...base, copies: [{ ...copy('a', 'new'), runtime: 5 }] },
      { ...base, colletFits: ['m-1', 'm-1'] },
      // #415 review: where Rust and Zod used to disagree.
      { ...base, copies: [{ ...copy('a', 'new'), whereabouts: { kind: 'box', x: 1 } }] },
      { ...base, colletFits: [' '] },
      { ...base, copies: [{ ...copy('a\u0007', 'new') }] },
      { ...base, copies: [{ ...copy('a', 'new'), runtimeWarnMinutes: 100_001 }] },
      { ...base, quantity: 600, copies: Array.from({ length: 501 }, (_, i) => copy(`c${i}`, 'new')) },
    ]) {
      expect(InventoryItemSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('#415 review — one cutter per spindle across the inventory', () => {
  it('refuses two items with a copy in the same machine', () => {
    const base = DOC.inventory[0] as Record<string, unknown>;
    const inM1 = (id: string, code: string) => ({
      ...base,
      id,
      codes: [{ symbology: 'qr', value: code }],
      copies: [{ ...copy(`${id}-c`, 'used'), whereabouts: { kind: 'machine', machineId: 'm-1' } }],
    });
    expect(InventorySchema.safeParse([inM1('a', 'A')]).success).toBe(true);
    const both = InventorySchema.safeParse([inM1('a', 'A'), inM1('b', 'B')]);
    expect(both.success).toBe(false);
    expect(JSON.stringify(both.error?.issues)).toContain('a spindle holds one cutter');
  });
});

describe('#415 condition for tool choice', () => {
  it('ranks new and used first, unset next, worn last, broken never', () => {
    expect(conditionRank('new')).toBe(conditionRank('used'));
    expect(conditionRank('used')).toBeLessThan(conditionRank(null));
    expect(conditionRank(null)).toBeLessThan(conditionRank('worn'));
    expect(conditionRank('broken')).toBe(Number.POSITIVE_INFINITY);
  });

  it('summarises an item: the best usable copy, and a note only when that is a worn one or none', () => {
    expect(itemConditionSummary({ id: 'i', quantity: 2, copies: [copy('a', 'worn')] })).toEqual({ best: null, usable: 2, note: null });
    expect(itemConditionSummary({ id: 'i', quantity: 2, copies: [copy('a', 'worn'), copy('b', 'broken')] })).toMatchObject({
      best: 'worn',
      usable: 1,
      note: expect.stringContaining('marked worn'),
    });
    expect(itemConditionSummary({ id: 'i', quantity: 1, copies: [copy('a', 'broken')] })).toMatchObject({ best: 'broken', usable: 0 });
    // Two worn copies are not "the only" one.
    expect(itemConditionSummary({ id: 'i', quantity: 2, copies: [copy('a', 'worn'), copy('b', 'worn')] }).note).toContain('every usable copy of this cutter (2)');
  });

  it('answers by registry key, filled from the inventory', () => {
    setInventoryConditions([{ id: 'x', quantity: 1, copies: [copy('a', 'broken')] }], (id) => `inv:${id}`);
    expect(conditionForKey('inv:x')?.usable).toBe(0);
    expect(conditionForKey('cat:1')).toBeNull();
  });

  // #442 — the same table as PLAIN DATA, for the sim worker: the tool choice runs over there, where
  // this module's map is empty, so the recommendation has to be handed the bench's conditions. If the
  // snapshot ever diverged from `conditionForKey`, the worker would skip a different set of cutters
  // than the panel's own picker names.
  it('hands the whole table across the worker boundary, as a copy the caller cannot write back into', () => {
    setInventoryConditions(
      [
        { id: 'x', quantity: 1, copies: [copy('a', 'broken')] },
        { id: 'y', quantity: 2, copies: [copy('a', 'worn')] },
      ],
      (id) => `inv:${id}`,
    );
    const snapshot = inventoryConditions();
    expect([...snapshot.keys()].sort()).toEqual(['inv:x', 'inv:y']);
    expect(snapshot.get('inv:x')).toEqual(conditionForKey('inv:x'));
    expect(snapshot.get('inv:y')).toEqual(conditionForKey('inv:y'));
    expect(snapshot.get('cat:1')).toBeUndefined();
    // A copy, not the module's own map: a worker that mutated what it was sent cannot reach back in.
    (snapshot as Map<string, unknown>).set('inv:x', 'clobbered');
    expect(conditionForKey('inv:x')?.usable).toBe(0);
  });
});

describe('#415 runtime only warns', () => {
  it('past the threshold — the copy’s own, else the shop’s — and never changes the condition', () => {
    const shop = readDefault(ShopDefaultsSchema.parse(DOC.defaults), 'tools.runtimeWarnMinutes');
    expect(shop).toEqual({ value: 600, source: 'seeded' });
    expect(runtimeWarning(599, null, shop.value)).toBeNull();
    expect(runtimeWarning(601, null, shop.value)).toContain('check this bit');
    expect(runtimeWarning(130, 120, shop.value)).toContain('set for it');
    expect(runtimeWarning(null, null, shop.value)).toBeNull();
  });
});

// #454 — a built-in or catalogue row adopts the condition of the physical copies that are the same
// cutter, so a broken owned bit cannot leave its identical twin looking fresh and a worn one cannot
// lose a tie in silence. The correspondence is diameter, shape and line, and the adopted note says
// whose copies it is about.
describe('#454 a definition adopts the condition of the copies that are the same cutter', () => {
  const BUILTIN_1MM = TOOL_LIBRARY.find((e) => e.key === 'flat-1.0')!;
  const BUILTIN_31 = TOOL_LIBRARY.find((e) => e.key === 'flat-3.175x12-metal')!;

  const ONE_MM = flatEndMill(1, { name: '1 mm flat end' });
  const WIDE_METAL = flatEndMill(3.175, { name: '3.175 mm flat end (Metal)', shoulderLength: 12 });

  /** An item with a definition, which is what lets it correspond to an entry at all. */
  function owned(id: string, tool: Tool, copies: ToolCopy[], quantity = Math.max(1, copies.length)): ItemWithCopies {
    return { id, quantity, copies, tool };
  }

  it('answers the built-in with a broken owned 1 mm cutter, and says whose copies it is', () => {
    setInventoryConditions([owned('only', ONE_MM, [copy('only-1', 'broken')])], (id) => `inv:${id}`, TOOL_LIBRARY);

    // The possession’s own summary is untouched …
    expect(conditionForKey('inv:only')).toMatchObject({ best: 'broken', usable: 0 });
    // … and the built-in that would otherwise have looked fresh is out for the same reason.
    const adopted = conditionForKey('flat-1.0')!;
    expect(adopted).toMatchObject({ best: 'broken', usable: 0 });
    expect(adopted.note).toContain('every copy of this cutter is marked broken');
    // The attribution: no operator described the shipped assumption.
    expect(adopted.note).toContain('shop’s own copies');
    // The worker reads this same table, not a second copy of the rule (#442).
    expect(inventoryConditions().get('flat-1.0')).toEqual(adopted);
  });

  it('carries a worn owned 3.175 mm cutter to the built-in on the same line', () => {
    setInventoryConditions([owned('worn', WIDE_METAL, [copy('worn-1', 'worn')])], (id) => `inv:${id}`, TOOL_LIBRARY);
    const adopted = conditionForKey(BUILTIN_31.key)!;
    expect(adopted).toMatchObject({ best: 'worn', usable: 1 });
    expect(adopted.note).toContain('marked worn');
    expect(adopted.note).toContain('check it before the cut');
    expect(adopted.note).toContain('shop’s own copies');
  });

  it('links on diameter, shape and line only', () => {
    // Each of these differs from `flat-1.0` in exactly one of the three, and must not adopt it.
    setInventoryConditions(
      [
        owned('wider', flatEndMill(1.5, { name: '1.5 mm flat end' }), [copy('a', 'broken')]),
        owned('round', flatEndMill(1, { name: '1 mm ball end', shape: 'ball' }), [copy('b', 'broken')]),
        owned('metal', flatEndMill(1, { name: '1 mm flat end (Metal)' }), [copy('c', 'broken')]),
      ],
      (id) => `inv:${id}`,
      TOOL_LIBRARY,
    );
    expect(conditionForKey('flat-1.0')).toBeNull();
    // And the 3.175 mm built-in has no correspondence either.
    expect(conditionForKey(BUILTIN_31.key)).toBeNull();
    // The possessions themselves still answer.
    expect(conditionForKey('inv:metal')!.usable).toBe(0);
  });

  it('pools every possession that corresponds to one entry, so one broken box cannot hide a usable copy', () => {
    // The same physical cutter registered twice: once from a broken box, once with an unstated
    // spare. Which row the service lists first must not decide whether the built-in is usable.
    const items = [
      owned('boxed', ONE_MM, [copy('boxed-1', 'broken')]),
      owned('spare', ONE_MM, []),
    ];
    setInventoryConditions(items, (id) => `inv:${id}`, [BUILTIN_1MM]);
    expect(conditionForKey('flat-1.0')).toMatchObject({ best: null, usable: 1, note: null });

    // With every pooled copy broken there is nothing left to choose — the entry is out, and the
    // note still says whose copies said so.
    setInventoryConditions(
      [owned('boxed', ONE_MM, [copy('boxed-1', 'broken')]), owned('spare', ONE_MM, [copy('spare-1', 'broken')])],
      (id) => `inv:${id}`,
      [BUILTIN_1MM],
    );
    expect(conditionForKey('flat-1.0')).toMatchObject({ best: 'broken', usable: 0 });
    expect(conditionForKey('flat-1.0')!.note).toContain('shop’s own copies');
  });

  it('reads a catalogue row’s vendor metalDuty 0 as the plain line, and a 1 by the name', () => {
    const cat = (key: string, name: string, metalDuty: number): ToolLibraryEntry => ({
      key,
      tool: flatEndMill(1, { name }),
      provenance: 'synthetic catalogue row',
      metalDuty,
    });
    const plain = cat('cat:plain', '1 mm flat end(Metal)', 0);
    const metal = cat('cat:metal', '1 mm flat end(Metal)', 1);
    setInventoryConditions([owned('metalowned', flatEndMill(1, { name: '1 mm flat end for Metal' }), [])], (id) => `inv:${id}`, [
      plain,
      metal,
    ]);
    // The vendor’s 0 wins over the `(Metal)` suffix, exactly as `registerCutter.isMetalRow` reads it;
    // a 1 is only “rated for metal”, so the name decides.
    expect(conditionForKey(plain.key)).toBeNull();
    expect(conditionForKey(metal.key)).not.toBeNull();
  });
});
