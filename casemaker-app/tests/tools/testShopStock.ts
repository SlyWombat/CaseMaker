/**
 * #1259 — THE STOCK A TEST SHOP STATES. The product holds no stick of its own: the blank the wizard
 * proposes comes from the shop's recorded stock. Specs that walk the first-job path state the shop
 * they run on, here: one hardwood stick, 36 × 100 × 36 mm, planed — the entry our own location
 * records.
 */
import { useStockStore } from '@/store/stockStore';
import type { StockItem } from '@/platform/stockClient';

export const TEST_SHOP_STICK = { form: 'block', length: 36, width: 100, thickness: 36, material: 'hardwood' } as const;

/** The stick as the stock record's own JSON. */
export function testShopStickRecord(): Record<string, unknown> {
  return {
    id: 'stock-test-shop-stick',
    form: TEST_SHOP_STICK.form,
    material: TEST_SHOP_STICK.material,
    size: { length: 36, width: 100, thickness: 36, diameter: null, wall: null },
    layers: [],
    quantity: 1,
    reservations: [],
    consumed: [],
    finish: 'finished',
    flatness: 'unknown',
    domeHeight: null,
    capMm: null,
    capSource: null,
    conductive: false,
    source: 'purchased',
    addedAt: '2026-11-01T00:00:00Z',
    notes: null,
  };
}

/** Put the stick on the stock store's shelf, as a shop that recorded it would have. */
export function seedTestShopShelf(): void {
  useStockStore.setState({ status: 'present', items: [testShopStickRecord() as unknown as StockItem] });
}
