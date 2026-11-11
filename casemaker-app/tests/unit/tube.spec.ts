// #1104 item 7 — ROUND MEANS ROD OR TUBE: one predicate (`isRoundStock`) in the footer, the rotary's
// first arrival, the picture and the profile's stock classes.
import { describe, expect, it } from 'vitest';
import { isRoundStock } from '@/engine/cnc/stockStart';
import { preferredBedMount } from '@/components/welcome/holdingMounts';
import type { BedProfile } from '@/platform/locationClient';

describe('#1104 a tube is round stock', () => {
  it('rod and tube are round; plate, block, disc and sheet are not', () => {
    expect(isRoundStock('rod')).toBe(true);
    expect(isRoundStock('tube')).toBe(true);
    for (const f of ['plate', 'block', 'disc', 'sheet', 'printed-blank'] as const) {
      expect(isRoundStock(f as never), f).toBe(false);
    }
  });

  it('a profile stock class "tube" matches a tube and not a rod; "rod" matches a rod and not a tube; "rod|tube" both', () => {
    const profile = (stock: string): BedProfile =>
      ({ id: 'p', preferredMounting: [{ stock, mount: { manner: 'tape' } }], placements: [] }) as unknown as BedProfile;
    const pick = (stock: string, form: 'rod' | 'tube') => preferredBedMount(profile(stock), { thickness: 12 }, form);
    expect(pick('tube', 'tube')).toBe('bed-tape');
    expect(pick('tube', 'rod')).toBeNull();
    expect(pick('rod', 'rod')).toBe('bed-tape');
    expect(pick('rod', 'tube')).toBeNull();
    expect(pick('rod|tube', 'rod')).toBe('bed-tape');
    expect(pick('rod|tube', 'tube')).toBe('bed-tape');
  });
});
