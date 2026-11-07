/**
 * #1066 — EPOXY TOOLING BOARD IS A STOCK MATERIAL.
 *
 * The maintainer's M1 blank is Makera's Epoxy Tooling Board (100 × 100 × 10). The app had no word
 * for it: `StockMaterial` lacked the material and `CATALOGUE_MATERIALS` deliberately refused the
 * vendor's exact name (`Epoxy Tooling` was in the "no material, no row, no gate" list, #310/#347),
 * so a job could not say what its blank is and a `hardwood` stand-in would be a false material on
 * the receipt, the run sheet and the feeds.
 *
 * RED at the pre-change tree: the schema refuses `material: 'epoxy-tooling'`, the exact-name map
 * answers null, and there is no label or machine material for it. GREEN here: it parses, it is
 * neither a plastic (no antistatic) nor a wood (no facing), Makera's own `Epoxy Tooling` rows feed
 * the owned Makera cutters, and a third-party cutter is stated unfeedable.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  MATERIAL_LABELS,
  STOCK_MATERIALS,
  isMetalMaterial,
  isPlasticMaterial,
  isWoodMaterial,
} from '@/engine/cnc/materials';
import {
  clearFeedCatalogue,
  catalogueMaterialFor,
  type FeedCatalogueRow,
} from '@/engine/cnc/feeds';
import { engraveFeedsFor } from '@/engine/cnc/engrave/feeds';
import { materialOptionsFor } from '@/engine/cnc/engrave/setupFlow';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { TOOL_LIBRARY } from '@/engine/cnc/toolLibrary';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { parseEngraveJob } from '@/store/engraveJobSchema';

/** The vendor's id for the 3.175 × 12 mm flat end (the owned Makera cutter this issue names). */
const VENDOR_ID = '112111313812';

/** A tool that IS that Makera cutter: the built-in entry, which carries the vendor id. */
function makeraCutter() {
  const entry = TOOL_LIBRARY.find((e) => e.key === 'flat-3.175x12-metal');
  if (!entry) throw new Error('the built-in metal flat end is gone');
  return entry.tool;
}

/** A hand-built row in the service's shape — placeholder numbers, not vendor data. */
const EPOXY_ROW: FeedCatalogueRow = {
  cutterId: VENDOR_ID,
  material: 'Epoxy Tooling',
  rpm: 11000,
  feed: 800,
  plungeFeed: 260,
  stepDown: 1.0,
};

afterEach(() => clearFeedCatalogue());

describe('#1066 epoxy tooling board', () => {
  it('is in the vocabulary, with the operator’s own word for it', () => {
    expect(STOCK_MATERIALS).toContain('epoxy-tooling');
    expect(MATERIAL_LABELS['epoxy-tooling']).toBe('Epoxy tooling board');
  });

  it('is neither a plastic (no antistatic), a wood (no facing) nor a metal', () => {
    expect(isPlasticMaterial('epoxy-tooling')).toBe(false);
    expect(isWoodMaterial('epoxy-tooling')).toBe(false);
    expect(isMetalMaterial('epoxy-tooling')).toBe(false);
  });

  it('maps Makera’s exact material name and nothing looser', () => {
    expect(catalogueMaterialFor('Epoxy Tooling')).toBe('epoxy-tooling');
    // The map is by EXACT name, by design: a different spelling is still refused.
    expect(catalogueMaterialFor('epoxy tooling')).toBeNull();
    expect(catalogueMaterialFor('Epoxy Tooling Board')).toBeNull();
  });

  it('the job schema loads a job whose stock is epoxy tooling', () => {
    const job = defaultEngraveJob();
    job.stock = { ...job.stock, material: 'epoxy-tooling' };
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed)).toBe(true);
    if (parsed.ok) expect(parsed.job.stock.material).toBe('epoxy-tooling');
  });

  it('the stock wizard offers it on the Makera mills', () => {
    expect(materialOptionsFor(Z1).some((o) => o.value === 'epoxy-tooling')).toBe(true);
  });

  it('resolves the owned Makera ⌀3.175 × 12 flat to its Epoxy Tooling row, with the row stated', () => {
    const r = engraveFeedsFor({}, [EPOXY_ROW], 'epoxy-tooling', makeraCutter(), Z1);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.params.rpm).toBe(11000);
    expect(r.params.feed).toBe(800);
    expect(r.params.plungeFeed).toBe(260);
    expect(r.params.stepDown).toBe(1.0);
    expect(r.catalogue?.cutterId).toBe(VENDOR_ID);
    expect(r.catalogue?.material).toBe('Epoxy Tooling');
    // The sentence names the material the operator's job states, not Makera's raw word.
    expect(r.provenance).toContain('Epoxy tooling board');
  });

  it('states a third-party cutter unfeedable in it — there is no starting row to answer', () => {
    const thirdParty = flatEndMill(2, { id: 'third-party-2mm' });
    const r = engraveFeedsFor({}, [EPOXY_ROW], 'epoxy-tooling', thirdParty, Z1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('Epoxy tooling board');
  });
});
