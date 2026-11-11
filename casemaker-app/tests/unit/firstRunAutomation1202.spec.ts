/**
 * #1202 field 4 — a first-run routine is refused under automation against a real controller.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { appUnderTest, firstRunAutomationRefusal, underAutomation } from '@/platform/automation';

function setWebdriver(value: boolean): void {
  Object.defineProperty(navigator, 'webdriver', { configurable: true, value });
}

afterEach(() => {
  setWebdriver(false);
  delete (globalThis as { __caseMaker?: unknown }).__caseMaker;
});

describe('#1202 — the first run is not a remote act', () => {
  it('an automated instance with a real controller refuses a FIRST run, in words', () => {
    setWebdriver(true);
    expect(underAutomation()).toBe(true);
    expect(appUnderTest()).toBe(false);
    const refusal = firstRunAutomationRefusal({ firstRun: true });
    expect(refusal).toContain('driven automatically');
    expect(refusal).toContain('a person at the machine');
  });

  it('a routine that has run here is not refused — the record is the permission', () => {
    setWebdriver(true);
    expect(firstRunAutomationRefusal({ firstRun: false })).toBeNull();
  });

  it('the test harness with the fake console is allowed, so the e2e can press a first run', () => {
    setWebdriver(true);
    (globalThis as { __caseMaker?: unknown }).__caseMaker = { isTestMode: () => true };
    expect(appUnderTest()).toBe(true);
    expect(firstRunAutomationRefusal({ firstRun: true })).toBeNull();
    // ... and the explicit form agrees.
    expect(firstRunAutomationRefusal({ firstRun: true, testMode: true })).toBeNull();
  });

  it('a person at the machine is never refused', () => {
    setWebdriver(false);
    expect(underAutomation()).toBe(false);
    expect(firstRunAutomationRefusal({ firstRun: true })).toBeNull();
  });
});
