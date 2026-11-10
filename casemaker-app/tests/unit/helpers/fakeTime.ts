/**
 * The fake-time replacement for RTL's `waitFor` (#1180).
 *
 * RTL's `waitFor` polls with a real timer unless a global `jest` is present, so it cannot be used
 * once a spec calls `vi.useFakeTimers()`. `advanceUntil` is the same contract: try the check, and on
 * failure advance fake time by a step (which also flushes the promises its timers resolve) and try
 * again. The last failure is rethrown by the final `check()`, so an assertion message is kept.
 *
 * The default step is 50 ms: fine enough not to skip an intermediate phase a spec asserts, coarse
 * enough that a 15 s timeout costs 300 loops of pure computation, not 15 s of wall time.
 */

import { vi } from 'vitest';

export async function advanceUntil(
  check: () => void,
  { timeoutMs = 15_000, stepMs = 50 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  for (let elapsed = 0; elapsed <= timeoutMs; elapsed += stepMs) {
    try {
      check();
      return;
    } catch {
      // Not yet: let the timers the code is waiting on fire, and look again.
    }
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  // One last try outside the loop: this throws the real assertion, message and all.
  check();
}
