import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore, clampPort, parseMargins } from '@/store/settingsStore';
import { MARGIN_DEFAULTS } from '@/engine/cnc/engrave/depthBounds';

describe('app settings', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetSettings();
  });

  it('default port is 8000', () => {
    expect(useSettingsStore.getState().port).toBe(8000);
  });

  it('setPort persists a valid value', () => {
    useSettingsStore.getState().setPort(9000);
    expect(useSettingsStore.getState().port).toBe(9000);
  });

  it('setPort rejects out-of-range and falls back to default', () => {
    useSettingsStore.getState().setPort(70000);
    expect(useSettingsStore.getState().port).toBe(8000);
    useSettingsStore.getState().setPort(0);
    expect(useSettingsStore.getState().port).toBe(8000);
  });

  it('clampPort floors decimals and rejects non-numbers', () => {
    expect(clampPort(8080.7)).toBe(8080);
    expect(clampPort(NaN)).toBe(8000);
    expect(clampPort('1234' as unknown)).toBe(8000);
  });

  it('bindToAll defaults to false', () => {
    expect(useSettingsStore.getState().bindToAll).toBe(false);
    useSettingsStore.getState().setBindToAll(true);
    expect(useSettingsStore.getState().bindToAll).toBe(true);
  });

  // #345 — the house depth margins. They are like every other setting: persisted, shipped with a
  // default, and left alone by nothing except a deliberate write.
  it('ships the house depth margins, and says they are the default', () => {
    expect(useSettingsStore.getState().margins).toEqual(MARGIN_DEFAULTS);
    expect(useSettingsStore.getState().margins.source).toBe('default');
  });

  it('keeps a margin the user typed, stamped as theirs', () => {
    useSettingsStore.getState().setMargins({ ...MARGIN_DEFAULTS, boundaryMargin: 0.35, source: 'user' });
    expect(useSettingsStore.getState().margins.boundaryMargin).toBe(0.35);
    expect(useSettingsStore.getState().margins.source).toBe('user');
  });

  it('resetSettings puts the margins back with everything else', () => {
    useSettingsStore.getState().setMargins({ ...MARGIN_DEFAULTS, boundaryMargin: 0.35, source: 'user' });
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().margins).toEqual(MARGIN_DEFAULTS);
  });

  it('falls back to the shipped set when the stored one is malformed', () => {
    // The same reading the store does at load: a sourceless record is not a record.
    expect(parseMargins({ boundaryMargin: 0.4 })).toEqual(MARGIN_DEFAULTS);
    expect(parseMargins({ ...MARGIN_DEFAULTS, boundaryMargin: -1 })).toEqual(MARGIN_DEFAULTS);
    // A good one survives, provenance included.
    expect(parseMargins({ ...MARGIN_DEFAULTS, boundaryMargin: 0.4, source: 'user' })).toMatchObject({
      boundaryMargin: 0.4,
      source: 'user',
    });
  });
});
