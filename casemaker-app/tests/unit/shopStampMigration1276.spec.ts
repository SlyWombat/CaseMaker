// #1276 — AN UPDATE MUST NOT MAKE EVERY STORED RUN STALE OVER THE STAMP'S FORMAT.
//
// A `shop` stamp stored before the settings' state was recorded has no state part ("none" or a hash).
// It is compared on the part it has: stale only if those values moved. (#1191: a job part-way through
// a cut must not be told to regenerate over bookkeeping.) A stamp with a state part compares whole.
import { describe, expect, it } from 'vitest';

import { stampMoved } from '@/engine/cnc/engrave/runInputs';
import { movedRunInputs, useEngraveRunStore, currentRunInputStamps } from '@/store/engraveRunStore';
import { settleShopSettings } from '../tools/settledShop';

describe('#1276 the old-format shop stamp is compared on the parts it has', () => {
  it('old stamp, shop unchanged → not moved (absent and present alike)', () => {
    expect(stampMoved('shop', 'none', 'absent:none')).toBe(false);
    expect(stampMoved('shop', 'ab12cd34', 'present:ab12cd34')).toBe(false);
  });
  it('old stamp, shop genuinely changed → moved', () => {
    expect(stampMoved('shop', 'ab12cd34', 'present:ffffffff')).toBe(true);
    expect(stampMoved('shop', 'none', 'present:ab12cd34')).toBe(true);
    expect(stampMoved('shop', 'ab12cd34', 'absent:none')).toBe(true);
  });
  it('new-format stamp compares whole: a state change is a move even with the same values', () => {
    expect(stampMoved('shop', 'absent:none', 'absent:none')).toBe(false);
    expect(stampMoved('shop', 'absent:none', 'error:none')).toBe(true);
    expect(stampMoved('shop', 'present:ab12cd34', 'present:ab12cd34')).toBe(false);
    expect(stampMoved('shop', 'absent:none', 'present:ab12cd34')).toBe(true);
  });
  it('other inputs still compare by equality', () => {
    expect(stampMoved('feeds', 'a', 'a')).toBe(false);
    expect(stampMoved('feeds', 'a', 'b')).toBe(true);
  });
  it('through the store: a stored run with an old-format stamp is not stale after the update', async () => {
    await settleShopSettings();
    const now = currentRunInputStamps();
    const tail = now.shop.slice(now.shop.indexOf(':') + 1);
    useEngraveRunStore.setState({ inputs: { ...now, shop: tail } });
    expect(movedRunInputs()).toEqual([]);
    useEngraveRunStore.setState({ inputs: { ...now, shop: 'deadbeef' } });
    expect(movedRunInputs()).toEqual(['shop']);
  });
});
