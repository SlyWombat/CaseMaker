/**
 * #1123 items 32/33 — the strip's Continue decision, pure.
 *
 * The bench: the program stopped in the firmware's `Tool` state; the strip said "Waiting for the
 * cutter" with no Continue. When our run watcher owns the machine it sends `M490.2` at its next
 * poll (one writer, its timing); when the program was started by hand there is no watcher, so the
 * press sends the line itself. A stopping run gets nothing.
 */
import { describe, expect, it } from 'vitest';

import { toolContinuePlan } from '@/components/viewport/machineStripActions';

describe('#1123 item 32 — how a Continue press reaches the machine', () => {
  it('asks the run watcher when it flagged the wait', () => {
    expect(toolContinuePlan({ running: true, toolWaiting: { awaited: null }, stopAsked: false })).toBe('request');
    expect(toolContinuePlan({ running: true, toolWaiting: { awaited: 1 } })).toBe('request');
  });

  it('sends the line itself when no run of ours owns the machine — or the watcher missed the wait', () => {
    expect(toolContinuePlan(null)).toBe('send');
    expect(toolContinuePlan(undefined)).toBe('send');
    expect(toolContinuePlan({ running: false, toolWaiting: null })).toBe('send');
    expect(toolContinuePlan({ running: true, toolWaiting: null })).toBe('send');
  });

  it('sends nothing while the program is stopping', () => {
    expect(toolContinuePlan({ running: true, toolWaiting: { awaited: 1 }, stopAsked: true })).toBe('none');
  });
});
