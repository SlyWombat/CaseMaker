/**
 * #1111 R2 — THE DEDUPE'S ORDER IS CANONICAL, NOT THE ORDER THE LIST ARRIVED IN.
 *
 * The app's registry is built-ins + the catalogue's `cat:` rows + the inventory's `inv:` rows; the
 * CLI's is built-ins + the location's own rows + (after #1111) the same `cat:` rows. `dedupeCutterEntries`
 * collapses a physical cutter's `cat:`/`inv:` twins keeping the owned entry — but it kept the FIRST
 * occurrence's Map slot, so the surviving `inv:` entry took its `cat:` twin's POSITION: the app's
 * owned list came out in catalogue order and the CLI's in inventory order. A pick that ties on
 * geometry then takes the first candidate, and the two doors write different programs (the M1
 * tray's ⌀3.175 finish: metal 10 mm flute on the app, 22 mm on the CLI — #1111).
 *
 * The rule now: the collapsed list is ordered by TIER (`inv:` → `user:` → `cat:` → built-in) and
 * then by key, lexical — never by arrival. RED at the #1093 tip: the list followed arrival order,
 * so catalogue-first and inventory-first inputs returned different sequences (and the `inv:` entry
 * stood in the `cat:` twin's slot).
 */
import { describe, expect, it } from 'vitest';

import { flatEndMill } from '@/engine/cnc/tool';
import { dedupeCutterEntries, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';

const entry = (key: string, id: string, name: string, fluteLength: number | null): ToolLibraryEntry => ({
  key,
  provenance: 'the #1111 spec',
  tool: flatEndMill(3.175, { id, name, fluteLength }),
});

const INV_22 = entry('inv:kz-ball-nose-3-175-22', '131012313822', 'plain ball 22', 22);
const INV_10 = entry('inv:kz-ball-nose-m-3-175-10', '132112313810', 'metal ball 10', 10);
const CAT_22 = entry('cat:019c049a-816a-721a', '131012313822', 'catalogue twin 22', 22);
const CAT_10 = entry('cat:019c049a-816a-728d', '132112313810', 'catalogue twin 10', 10);
const BUILT_IN = entry('flat-1.0', 'built-in-1', 'built-in flat', null);

describe('#1111 R2 — dedupeCutterEntries returns one canonical order', () => {
  it('the same set in catalogue-first and inventory-first order returns identical lists', () => {
    const catalogueFirst = dedupeCutterEntries([CAT_10, CAT_22, INV_10, INV_22, BUILT_IN]);
    const inventoryFirst = dedupeCutterEntries([INV_22, INV_10, CAT_10, CAT_22, BUILT_IN]);
    expect(catalogueFirst.map((e) => e.key)).toEqual(inventoryFirst.map((e) => e.key));
    // Tier first (the two owned cutters, key-ordered), then the built-in — never arrival order.
    expect(catalogueFirst.map((e) => e.key)).toEqual([INV_22.key, INV_10.key, BUILT_IN.key]);
  });

  it('a cat:/inv: pair with one id yields the inv: entry, at the canonical position', () => {
    const out = dedupeCutterEntries([CAT_22, INV_22]);
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe(INV_22.key);
    // The surviving entry is the inventory's own record, not the catalogue's definition in the
    // inventory's slot: the name and flute prove which object came through.
    expect(out[0]!.tool.name).toBe('plain ball 22');
    expect(out[0]!.tool.fluteLength).toBe(22);
    // Same pair the other way round: one entry, the same one.
    expect(dedupeCutterEntries([INV_22, CAT_22]).map((e) => e.key)).toEqual([INV_22.key]);
  });

  it('a user: entry sorts between the owned cutters and the catalogue', () => {
    const user = entry('user:mine', 'user-id', 'my own ball', 30);
    const catOnly = entry('cat:019c049a-0000', 'cat-only-id', 'catalogue only', 12);
    const out = dedupeCutterEntries([catOnly, BUILT_IN, user, INV_10]);
    expect(out.map((e) => e.key)).toEqual([INV_10.key, user.key, catOnly.key, BUILT_IN.key]);
  });

  it('an id-less entry is identified by its key and never collapses; order is still canonical', () => {
    const noIdB = entry('user:bbb', '', 'B', 4);
    const noIdA = entry('user:aaa', '', 'A', 4);
    const out = dedupeCutterEntries([noIdB, noIdA]);
    expect(out.map((e) => e.key)).toEqual(['user:aaa', 'user:bbb']);
  });
});
