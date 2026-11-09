/**
 * #1123 item 17 — THE BENCH HARNESS'S PROBE REPLY WINDOW.
 *
 * At the bench (2026-11-09) `tools/z1/z1.mjs send`'s default window (first reply 3 s, quiet 0.8 s)
 * closed the reader before M491/G38's `[PRB]` replies landed; `--first-reply 15000 --quiet 3000
 * --max 30000` caught them. The fix is a CLASSIFIER in the harness's plain-JS module: a probe line
 * gets a probe-length default, the operator's flags still override. The quiet window is held to the
 * APP's own `PROBE_TIMING` — the same number its M491 calls use — so the two cannot drift.
 *
 * This spec tests the classifier only. It sends NO machine command: the bench is live, and only
 * the maintainer's assistant touches the Z1.
 */
import { describe, expect, it } from 'vitest';

import {
  isProbeLine,
  PROBE_REPLY_TIMING,
  replyTimingFor,
  STANDARD_REPLY_TIMING,
} from '../../tools/z1/probeTiming.mjs';
import { PROBE_TIMING } from '@/engine/cnc/registration/execute';

describe('#1123 item 17 — probe commands get a probe-length reply window', () => {
  it('classifies the two-touch macro and the G38 family as probes', () => {
    for (const line of ['M491', 'M491 ; two touch', 'm491', 'G38', 'G38.2', 'G38.3 Z-10 F100', 'g38.4', ' G38.2 ']) {
      expect(isProbeLine(line), line).toBe(true);
    }
  });

  it('leaves ordinary lines — and near-miss words — on the standard window', () => {
    for (const line of ['', '  ', 'G1 X10 F100', 'M3 S10000', 'M4910', 'G381', 'M491.1', '?', 'M332', 'G0 Z10']) {
      expect(isProbeLine(line), line).toBe(false);
    }
  });

  it('probe lines get the probe window, everything else the historical defaults', () => {
    expect(replyTimingFor('M491')).toEqual(PROBE_REPLY_TIMING);
    expect(replyTimingFor('G38.3 Z-5 F100')).toEqual(PROBE_REPLY_TIMING);
    expect(replyTimingFor('G1 X10')).toEqual(STANDARD_REPLY_TIMING);
    expect(STANDARD_REPLY_TIMING).toEqual({ firstReplyMs: 3_000, quietMs: 800, maxMs: 15_000 });
    expect(PROBE_REPLY_TIMING).toEqual({ firstReplyMs: 15_000, quietMs: 20_000, maxMs: 30_000 });
  });

  it('the probe quiet window is the app’s own PROBE_TIMING — the restatement cannot drift', () => {
    // `PROBE_TIMING` is what the app's M491 calls pass (`registration/execute.ts`): the reader
    // stays open 20 s of silence, because the fast probe gap is ~13 s.
    expect(PROBE_REPLY_TIMING.quietMs).toBe(PROBE_TIMING.quietMs);
    expect(PROBE_TIMING.quietMs).toBe(20_000);
  });
});
