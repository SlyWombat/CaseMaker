// #241 slice 4 (#729 item 1) — the tailstock as an obstacle, when the setup says it is in.
// The figures are provisional; the tests pin the CONSERVATIVE radius and the segment test, so a
// refitting session can replace the numbers in one block without touching the rule.

import { describe, expect, it } from 'vitest';
import {
  ROTARY_TAILSTOCK_BODY_MM,
  ROTARY_TAILSTOCK_CENTRE_MM,
  ROTARY_TAILSTOCK_HOUSING_RADIUS_MM,
  segmentEntersTailstock,
  tailstockSpan,
} from '@/engine/cnc/rotary/tailstock';

describe('#241 slice 4 the tailstock obstacle', () => {
  it('sits behind the live centre, from the stock free end onward', () => {
    const span = tailstockSpan(30, 25, 10);
    expect(span.x0).toBe(30 + ROTARY_TAILSTOCK_CENTRE_MM);
    expect(span.x1).toBe(span.x0 + ROTARY_TAILSTOCK_BODY_MM);
  });

  it('is never narrower than the housing, the jaws or the stock', () => {
    expect(tailstockSpan(30, 25, 10).radius).toBe(ROTARY_TAILSTOCK_HOUSING_RADIUS_MM);
    // A rod wider than the provisional housing makes the obstacle wider, not narrower.
    expect(tailstockSpan(30, 25, 60).radius).toBe(60);
    // A four-jaw chuck wider than both does too.
    expect(tailstockSpan(30, 120, 10).radius).toBe(60);
  });

  it('catches a cutter that enters the body, and clears one that stays outside it', () => {
    const span = tailstockSpan(30, 25, 10);
    const r = span.x0 + 10;
    // Straight into the body, near the axis.
    expect(segmentEntersTailstock([r, 0, 5], [r + 10, 0, 5], 2, span)).toBe(true);
    // Above the body: clear.
    expect(segmentEntersTailstock([r, 0, span.radius + 5], [r + 10, 0, span.radius + 5], 2, span)).toBe(false);
    // Before the free end: clear.
    expect(segmentEntersTailstock([5, 0, 5], [20, 0, 5], 2, span)).toBe(false);
    // A rapid that crosses the body between two clear ends is still caught (whole-segment test).
    expect(segmentEntersTailstock([span.x0 - 20, 0, 5], [span.x1 + 20, 0, 5], 2, span)).toBe(true);
    // A cutter whose edge only grazes the housing radius is caught by the cutter's own radius.
    expect(segmentEntersTailstock([r, 0, span.radius + 1], [r, 0, span.radius + 1], 2, span)).toBe(true);
  });
});
