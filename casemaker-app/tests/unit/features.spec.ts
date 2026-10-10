import { describe, it, expect } from 'vitest';
import { betaRequested, featureSim } from '@/platform/features';

// #343 — the URL switch that shows the CNC UI on the public site.
describe('betaRequested', () => {
  it('is on for BETA=yes, whatever the case of the key or the value', () => {
    expect(betaRequested('?BETA=yes')).toBe(true);
    expect(betaRequested('?beta=YES')).toBe(true);
    expect(betaRequested('?x=1&Beta=yes&y=2')).toBe(true);
  });

  it('is off without the key, with another value, or with an empty search', () => {
    expect(betaRequested('')).toBe(false);
    expect(betaRequested('?x=1')).toBe(false);
    expect(betaRequested('?BETA=no')).toBe(false);
    expect(betaRequested('?BETA=')).toBe(false);
    expect(betaRequested('?BETA')).toBe(false);
    expect(betaRequested('?BETAX=yes')).toBe(false);
  });

  it('the test build has the CNC UI on without the switch (the build flag is true in vitest)', () => {
    expect(featureSim).toBe(true);
  });
});
