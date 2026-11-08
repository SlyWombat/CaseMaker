// @vitest-environment jsdom
/**
 * #1073(b) — THE SETUPS ROW SHOWS THE VENDOR METHOD UNAVAILABLE, WITH THE REASON, when the
 * part's outline cannot be posed against two arms (6b's answer 2), the frame method staying
 * pre-selected. The availability is the registration planner's verdict, passed in; nothing here
 * re-derives a threshold.
 *
 * RED at m1-land9: the row has no availability line and the vendor option is offered to every
 * outline.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { FlipChoice } from '@/components/panels/FlipChoice';
import { flipOrientation } from '@/engine/cnc/engrave/flipChoice';
import type { JobSetup } from '@/types/engraveJob';

afterEach(() => cleanup());

const SETUP: JobSetup = {
  id: 'setup-2',
  orientation: flipOrientation('left-right'),
  mount: { kind: 'bracket' },
  itemIds: [],
  tools: ['inv:x'],
};

const DISC_REASON =
  'the part’s front edge is straight for 2.00 mm — too short for two touches kept 2.00 mm clear of its corners; keep it in the blank on tabs';

describe('#1073(b) the vendor method’s availability in the row', () => {
  it('a disc: the vendor option is disabled, the reason is stated, and the frame method is pre-selected', () => {
    render(
      <FlipChoice
        n={2}
        setup={SETUP}
        editable
        stock={{ length: 100, width: 60, squareCorners: ['FL'] }}
        vendorOffer={{ available: false, reason: DISC_REASON }}
        onReplace={() => {}}
      />,
    );
    const method = screen.getByTestId('engrave-setup-flip-method-2') as HTMLSelectElement;
    // The proposal is the frame method (tabs-in-blank), pre-selected.
    expect(method.value).toBe('tabs-in-blank');
    const vendor = Array.from(method.querySelectorAll('option')).find((o) => o.value === 'free-then-flip') as HTMLOptionElement;
    expect(vendor.disabled).toBe(true);
    const line = screen.getByTestId('engrave-setup-flip-vendor-unavailable-2');
    expect(line.textContent).toContain('The vendor method is unavailable');
    expect(line.textContent).toContain('keep it in the blank on tabs');
  });

  it('an available part: both methods offered, no line', () => {
    render(
      <FlipChoice
        n={2}
        setup={SETUP}
        editable
        stock={{ length: 100, width: 60 }}
        vendorOffer={{ available: true, reason: null }}
        onReplace={() => {}}
      />,
    );
    const method = screen.getByTestId('engrave-setup-flip-method-2') as HTMLSelectElement;
    const vendor = Array.from(method.querySelectorAll('option')).find((o) => o.value === 'free-then-flip') as HTMLOptionElement;
    expect(vendor.disabled).toBe(false);
    expect(screen.queryByTestId('engrave-setup-flip-vendor-unavailable-2')).toBeNull();
  });
});
