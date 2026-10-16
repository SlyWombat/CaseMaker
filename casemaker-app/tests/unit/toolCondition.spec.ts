// #415 — a cutter's condition per copy, the rules tool choice reads, and the runtime warning that
// only warns. The shared fixture's inventory item carries one described copy.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  conditionForKey,
  conditionRank,
  itemConditionSummary,
  resetInventoryConditions,
  runtimeWarning,
  setInventoryConditions,
  type ToolCopy,
} from '@/engine/cnc/toolCondition';
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
