/**
 * #1048 — THE LOAD'S TWO CLOCKS. The sim worker is shared with the background ideal plan, so a
 * load can queue behind it for minutes; the old single window armed at the call read that queue
 * as silence and terminated a healthy worker. Before the worker's first message the load is
 * WAITING (never a fault); after it, silence is the stall #895 means.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadStallPolicy } from '@/engine/jobs/simClient';

describe('#1048 — the load waits out the queue before it may call a stall', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('silence before the worker’s first message is WAITING, re-armed, never a stall', () => {
    let waiting = 0;
    let stalled = 0;
    const clocks = loadStallPolicy(180_000, 30_000, () => waiting++, () => stalled++);
    clocks.start();
    vi.advanceTimersByTime(180_000);
    expect(waiting, 'one waiting report per queue window').toBe(1);
    expect(stalled, 'a queued load is never a stall').toBe(0);
    vi.advanceTimersByTime(180_000);
    expect(waiting).toBe(2);
    expect(stalled).toBe(0);
    clocks.stop();
  });

  it('after the worker speaks, silence IS a stall; every message re-arms it', () => {
    let waiting = 0;
    let stalled = 0;
    const clocks = loadStallPolicy(180_000, 30_000, () => waiting++, () => stalled++);
    clocks.start();
    clocks.heard();
    vi.advanceTimersByTime(29_999);
    expect(stalled, 'one millisecond short is not a stall').toBe(0);
    clocks.heard();
    vi.advanceTimersByTime(29_999);
    expect(stalled, 'the second message re-armed the window').toBe(0);
    vi.advanceTimersByTime(1);
    expect(stalled).toBe(1);
    expect(waiting, 'the queue clock never fired once the worker spoke').toBe(0);
    clocks.stop();
  });

  it('stop closes both clocks', () => {
    let waiting = 0;
    let stalled = 0;
    const clocks = loadStallPolicy(180_000, 30_000, () => waiting++, () => stalled++);
    clocks.start();
    clocks.heard();
    clocks.stop();
    vi.advanceTimersByTime(1_000_000);
    expect(waiting + stalled).toBe(0);
  });
});
