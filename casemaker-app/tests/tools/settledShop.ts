/**
 * #1276 — THE SETTINGS STORE, SETTLED, for a spec that presses Generate. The page's Generate waits for
 * the shop's settings (`unknown`) and refuses without them (`error`), so a spec that is about
 * something else states the state it runs in: `present` with an empty map is the recommendations,
 * stated (what a null map used to mean), and `absent` is the hosted build with no house.
 */
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import type { ShopDefaults } from '@/platform/defaultsClient';

export function settleShopSettings(
  status: 'present' | 'absent' | 'error' | 'unknown' = 'present',
  defaults: ShopDefaults | null = status === 'present' ? {} : null,
  etag: string | null = status === 'present' ? '"test"' : null,
): void {
  useShopDefaultsStore.setState({ status, defaults, etag, reason: status === 'error' ? 'the house did not answer' : null });
}
