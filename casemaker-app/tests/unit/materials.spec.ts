// #1105 items 2-4 — THE MATERIAL VOCABULARY. The options are ordered in the way a woodworker reads
// them (Woods, cast boards, Plastics, Metals, the copper-clad board), the family is the single
// predicate behind the facing and antistatic rules, and the tooling board's vendor feeds are pinned
// where the vocabulary lives (moved from the #1066 spec).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STOCK_MATERIALS, isPlasticMaterial, materialFamilyOf, type MaterialFamily } from '@/engine/cnc/materials';
import { materialOptionsFor } from '@/engine/cnc/engrave/setupFlow';
import { facingRefusal } from '@/engine/cnc/stockStart';
import { engraveFeedsFor } from '@/engine/cnc/engrave/feeds';
import { catalogueMaterialFor, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import { TOOL_LIBRARY } from '@/engine/cnc/toolLibrary';

const CATALOGUE = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/unit/fixtures/epoxy/catalogue-epoxy.json'), 'utf8'),
) as { feeds: FeedCatalogueRow[] };

/** The owned ⌀3.175 × 12 flat, by Makera's own id — the cutter the catalogue's row names. */
const OWNED_FLAT = TOOL_LIBRARY.find((e) => e.key === 'flat-3.175x12-metal')!.tool;

const RANK: Record<MaterialFamily, number> = { wood: 0, board: 1, plastic: 2, metal: 3, pcb: 4 };

describe('#1105 the material vocabulary', () => {
  it('materialOptionsFor lists Woods first, then the cast boards, plastics, metals and the board', () => {
    const options = materialOptionsFor(Z1);
    expect(options.length).toBeGreaterThan(0);
    expect(materialFamilyOf(options[0]!.value)).toBe('wood');
    const ranks = options.map((o) => RANK[materialFamilyOf(o.value)]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // The machine names the tooling board; it reads before the plastics, not after them.
    const board = options.findIndex((o) => materialFamilyOf(o.value) === 'board');
    const plastic = options.findIndex((o) => materialFamilyOf(o.value) === 'plastic');
    expect(board).toBeGreaterThan(-1);
    expect(plastic).toBeGreaterThan(-1);
    expect(board).toBeLessThan(plastic);
  });

  it('the family decides facing and antistatic for every StockMaterial', () => {
    for (const material of STOCK_MATERIALS) {
      const family = materialFamilyOf(material);
      // Facing is for wood and metal only; the antistatic runs on plastics only (#474/#493, #564).
      expect(facingRefusal(material) === null, material).toBe(family === 'wood' || family === 'metal');
      expect(isPlasticMaterial(material), material).toBe(family === 'plastic');
    }
  });

  it("Epoxy Tooling Board resolves feeds for the house's ⌀3.175 flat and has family board", () => {
    expect(materialFamilyOf('epoxy-tooling')).toBe('board');
    expect(catalogueMaterialFor('Epoxy Tooling')).toBe('epoxy-tooling');
    const feeds = engraveFeedsFor({}, CATALOGUE.feeds, null, 'epoxy-tooling', OWNED_FLAT, Z1);
    expect(feeds.ok, feeds.ok ? '' : feeds.reason).toBe(true);
    if (!feeds.ok) return;
    expect(feeds.params.rpm).toBe(10_000);
    expect(feeds.params.feed).toBe(1_000);
    expect(feeds.params.plungeFeed).toBe(300);
    expect(feeds.params.stepDown).toBe(1.0);
    expect(feeds.catalogue?.cutterId).toBe('112111313812');
    expect(feeds.provenance).toContain('Epoxy tooling board');
  });
});
