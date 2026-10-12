import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore, parseMargins, parseToolPicks } from '@/store/settingsStore';
import { MARGIN_DEFAULTS } from '@/engine/cnc/engrave/depthBounds';

describe('app settings', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetSettings();
  });

  // #372 — the port and the LAN bind are NOT here any more, and this is the assertion that keeps
  // them out. They belong to the host process, which reads them from `config.json` (`config.rs`),
  // and a second copy in an origin-keyed store is exactly what made the old field unable to do
  // anything: nothing on the Rust side could see it. The settings dialog reads and writes that file
  // through `platform/houseClient` instead.
  it('keeps nothing about the server in the webview’s own storage', () => {
    // The store's own shape, not a sample of it: `persist` writes `{...get()}`, so a key that is not
    // here cannot reach `localStorage` either.
    const keys = Object.keys(useSettingsStore.getState());
    expect(keys).not.toContain('port');
    expect(keys).not.toContain('bindToAll');
    expect(keys).not.toContain('setPort');
    expect(keys).not.toContain('setBindToAll');
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

// #316 — the cutter each header signature was settled on by hand. Persisted so a reload does not
// re-ask, and validated per ENTRY rather than whole-or-nothing.
describe('the remembered tool picks (#316)', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetSettings();
  });

  it('remembers a pick under its signature, and resetSettings forgets every one', () => {
    useSettingsStore.getState().setToolPick('id=112111313812', 'cat:112111313812');
    useSettingsStore.getState().setToolPick('shape=flat@3.175', 'inv:box-1');
    expect(useSettingsStore.getState().toolPicks).toEqual({
      'id=112111313812': 'cat:112111313812',
      'shape=flat@3.175': 'inv:box-1',
    });
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().toolPicks).toEqual({});
  });

  it('drops a junk entry and keeps the rest, rather than refusing the whole map', () => {
    // Per-entry, deliberately unlike the vise and the margins: a bad entry can only ever be a pick
    // that does not come back (the reader re-checks it against the fresh candidates), so there is
    // nothing dangerous to guard whole. The allow-list of signature prefixes is what stops a foreign
    // payload from landing `__proto__` as a candidate key in a plain object.
    const raw = JSON.parse(
      '{"id=112111313812":"cat:112111313812","__proto__":"inv:box-1","shape=flat@3.175":"","nonsense":"cat:x","id=":"cat:y","shape=ball@6.35":42}',
    );
    expect(parseToolPicks(raw)).toEqual({ 'id=112111313812': 'cat:112111313812' });
    // Absent, or the wrong shape entirely, is not a map.
    expect(parseToolPicks(undefined)).toEqual({});
    expect(parseToolPicks(['id=x'])).toEqual({});
  });
});
