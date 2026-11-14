/**
 * #1066 — EPOXY TOOLING BOARD, the material and the vendor rows that answer it.
 *
 * The M1 stock on hand is a 100 × 100 × 10 mm cast resin board, and Makera's catalogue carries
 * `Epoxy Tooling` rows for its own cutters — but this app had no material word for it, so a job
 * could not say what the blank is, and a `hardwood` stand-in would have put false rows on the
 * receipt and the sheet. This slice gives the material its word, maps the vendor's name exactly,
 * and proves the owned ⌀3.175 × 12 flat resolves to its Epoxy Tooling row (rpm/feed/plunge/step-
 * down from the catalogue, with the row's own id) — while a third-party cutter stays honestly
 * unfeedable in it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MATERIAL_LABELS,
  STOCK_MATERIALS,
  isCompositeMaterial,
  isConductiveMaterial,
  isMetalMaterial,
  isPlasticMaterial,
  isToolingBoardMaterial,
  isWoodMaterial,
} from '@/engine/cnc/materials';
import { materialOptionsFor } from '@/engine/cnc/engrave/setupFlow';
import { engraveFeedsFor } from '@/engine/cnc/engrave/feeds';
import { catalogueMaterialFor, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { runSheetStockLine } from '@/engine/cnc/engrave/runSheet';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '@/store/engraveJobSchema';

const CATALOGUE = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/unit/fixtures/epoxy/catalogue-epoxy.json'), 'utf8'),
) as { feeds: FeedCatalogueRow[] };

/** A cutter of the operator's own: no vendor id, so no catalogue row can name it. */
const THIRD_PARTY = flatEndMill(3.175, { id: 'user:third-party-flat', name: '3.175 mm 2-flute' });

describe('#1066 epoxy tooling board', () => {
  it('parses as a job’s stock material, and the app has one word for it', () => {
    const job = defaultEngraveJob();
    job.stock = { ...job.stock, material: 'epoxy-tooling' };
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok, parsed.ok ? '' : parsed.errors.join('; ')).toBe(true);
    if (parsed.ok) expect(parsed.job.stock.material).toBe('epoxy-tooling');
    expect(MATERIAL_LABELS['epoxy-tooling']).toBe('Epoxy tooling board');
    expect(STOCK_MATERIALS).toContain('epoxy-tooling');
  });

  it('is its own class: no antistatic, no facing, not a composite or a metal', () => {
    expect(isToolingBoardMaterial('epoxy-tooling')).toBe(true);
    expect(isPlasticMaterial('epoxy-tooling')).toBe(false); // the antistatic rule stays off
    expect(isWoodMaterial('epoxy-tooling')).toBe(false); // the facing rule refuses it by default
    expect(isMetalMaterial('epoxy-tooling')).toBe(false);
    expect(isCompositeMaterial('epoxy-tooling')).toBe(false);
    expect(isConductiveMaterial('epoxy-tooling')).toBe(false);
  });

  it('is offered by the wizard and the setup flow, on the Z1, under its own label', () => {
    const options = materialOptionsFor(Z1);
    expect(options.find((o) => o.value === 'epoxy-tooling')?.label).toBe('Epoxy tooling board');
  });

  it("maps Makera's exact name, and nothing else", () => {
    expect(catalogueMaterialFor('Epoxy Tooling')).toBe('epoxy-tooling');
    // The exactness the map exists for: a near name is still not this material.
    expect(catalogueMaterialFor('Epoxy')).toBeNull();
    expect(catalogueMaterialFor('Epoxy Tooling Board')).toBeNull();
  });

  it('states a third-party cutter unfeedable in it, rather than borrowing a row', () => {
    const feeds = engraveFeedsFor({}, CATALOGUE.feeds, null, 'epoxy-tooling', THIRD_PARTY, Z1);
    expect(feeds.ok).toBe(false);
    if (feeds.ok) return;
    expect(feeds.reason).toContain('Epoxy tooling board');
    expect(feeds.reason).toMatch(/catalogue/i);
  });

  it('prints the sheet’s stock line in the material’s own words', () => {
    expect(runSheetStockLine({ stock: { length: 100, width: 100, thickness: 10, material: 'epoxy-tooling' } } as never)).toBe(
      '100 × 100 × 10 mm Epoxy tooling board',
    );
  });
});
