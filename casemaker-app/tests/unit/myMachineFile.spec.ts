// The "my machine" export/import file (#247). Pure parse/serialize plus the store round trip:
// export, clear site data, import, and every measured value comes back with its provenance.
//
// The settings store reads localStorage (with a `window` guard) at module load, so both are
// faked BEFORE the store is dynamically imported — the same harness `cncFixture.spec.ts` uses.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const backing = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
} as Storage;

import { DEFAULT_VISE } from '@/engine/cnc/fixture';
import type { Sacrificial, ViseParams } from '@/types/engraveJob';
import {
  MY_MACHINE_FILENAME,
  MY_MACHINE_KIND,
  MY_MACHINE_SCHEMA_VERSION,
  buildMyMachineFile,
  parseMyMachineFile,
  parseMyMachineRecord,
  serializeMyMachineFile,
  type MyMachineFile,
} from '@/store/myMachineFile';

const MEASURED_VISE: ViseParams = {
  ...DEFAULT_VISE,
  stockProud: 4.5,
  jawLength: 100,
  source: 'measured',
  uncertainty: 0.2,
  measuredAt: '2026-09-20',
};

const MEASURED_SACRIFICIAL: Sacrificial = {
  under: { thickness: 6, overhang: { left: 2, right: 2, front: 3, back: 3 }, attach: 'tape' },
  sides: {
    left: { thickness: 3, height: 'flush' },
    right: { thickness: 3, height: 'flush' },
    front: null,
    back: null,
  },
  source: 'measured',
};

/** Modules can be reset, but a whole generation shares one settingsStore instance. */
async function generation() {
  vi.resetModules();
  const settings = await import('@/store/settingsStore');
  const file = await import('@/store/myMachineFile');
  return { ...settings, ...file };
}

/** A record as the exporter writes it, before serialization. */
function fileWith(fixtures: MyMachineFile['fixtures']): MyMachineFile {
  return {
    kind: MY_MACHINE_KIND,
    schemaVersion: MY_MACHINE_SCHEMA_VERSION,
    exportedAt: '2026-10-05T00:00:00.000Z',
    fixtures,
  };
}

describe('the "my machine" file (#247)', () => {
  beforeEach(() => {
    backing.clear();
  });

  it('has a stable kind, version and download name', () => {
    expect(MY_MACHINE_KIND).toBe('casemaker-my-machine');
    expect(MY_MACHINE_SCHEMA_VERSION).toBe(1);
    expect(MY_MACHINE_FILENAME).toBe('casemaker-my-machine.json');
  });

  it('serializes a versioned record and does not alias the caller object', () => {
    const fixtures = { vise: MEASURED_VISE, sacrificial: MEASURED_SACRIFICIAL };
    const file = buildMyMachineFile(fixtures, new Date('2026-10-05T12:00:00Z'));
    expect(file.kind).toBe(MY_MACHINE_KIND);
    expect(file.schemaVersion).toBe(1);
    expect(file.exportedAt).toBe('2026-10-05T12:00:00.000Z');
    expect(file.fixtures).toEqual(fixtures);
    expect(file.fixtures.vise).not.toBe(MEASURED_VISE);
  });

  it('round-trips a measured vise and sacrificial stack with provenance intact', () => {
    const text = serializeMyMachineFile(
      { vise: MEASURED_VISE, sacrificial: MEASURED_SACRIFICIAL },
      new Date('2026-10-05T00:00:00Z'),
    );
    const result = parseMyMachineFile(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fixtures.vise).toEqual(MEASURED_VISE);
    expect(result.fixtures.vise!.source).toBe('measured');
    expect(result.fixtures.vise!.measuredAt).toBe('2026-09-20');
    expect(result.fixtures.sacrificial).toEqual(MEASURED_SACRIFICIAL);
  });

  it('accepts an empty machine (nothing measured yet)', () => {
    const result = parseMyMachineFile(serializeMyMachineFile({}));
    expect(result).toEqual({ ok: true, fixtures: {} });
  });

  it('refuses a file that is not valid JSON', () => {
    const result = parseMyMachineFile('{"kind": "casemaker-my-machine", "fixtures"');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not valid JSON/i);
  });

  it('refuses a truncated file', () => {
    const full = serializeMyMachineFile({ vise: MEASURED_VISE });
    const result = parseMyMachineFile(full.slice(0, Math.floor(full.length / 2)));
    expect(result.ok).toBe(false);
  });

  it('refuses a JSON file that is not a "my machine" record', () => {
    const result = parseMyMachineFile(JSON.stringify({ hello: 'world' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not a Case Maker machine file/i);
  });

  it('refuses an unknown schema version, naming it', () => {
    const result = parseMyMachineRecord({ ...fileWith({}), schemaVersion: 99 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/version 99/);
    expect(result.reason).toMatch(/reads version 1/);
  });

  it('refuses a file carrying no fixtures field', () => {
    const result = parseMyMachineRecord({ kind: MY_MACHINE_KIND, schemaVersion: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no machine setup/i);
  });

  it('refuses a WHOLE record when the vise is a partial object, applying nothing', () => {
    // A valid sacrificial stack must NOT sneak in beside a broken vise.
    const result = parseMyMachineRecord(
      fileWith({ vise: { stockProud: 4 } as unknown as ViseParams, sacrificial: MEASURED_SACRIFICIAL }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/vise/i);
  });

  it('refuses a whole record when a source has been edited to an unknown value', () => {
    const edited = { ...MEASURED_VISE, source: 'guessed' as unknown as ViseParams['source'] };
    const result = parseMyMachineRecord(fileWith({ vise: edited }));
    expect(result.ok).toBe(false);
  });

  it('refuses a whole record when the sacrificial stack is malformed', () => {
    const broken = {
      ...MEASURED_SACRIFICIAL,
      sides: { ...MEASURED_SACRIFICIAL.sides, left: { thickness: -1, height: 'flush' } },
    } as unknown as Sacrificial;
    const result = parseMyMachineRecord(fileWith({ vise: MEASURED_VISE, sacrificial: broken }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/sacrificial/i);
  });

  it('refuses a record whose fixtures is not an object', () => {
    const result = parseMyMachineRecord(fileWith([] as unknown as MyMachineFile['fixtures']));
    expect(result.ok).toBe(false);
  });
});

describe('the "my machine" round trip through the store (#247)', () => {
  beforeEach(() => {
    backing.clear();
  });

  it('export, clear site data, import: every measured value returns, persisted', async () => {
    const first = await generation();
    first.useSettingsStore.getState().setVise(MEASURED_VISE);
    first.useSettingsStore.getState().setSacrificial(MEASURED_SACRIFICIAL);
    const text = first.serializeMyMachineFile(first.useSettingsStore.getState().fixtures);

    // "Clear site data": nothing left in the browser.
    backing.clear();
    const second = await generation();
    expect(second.useSettingsStore.getState().fixtures).toEqual({});

    const result = second.parseMyMachineFile(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    second.useSettingsStore.getState().replaceFixtures(result.fixtures);

    const restored = second.useSettingsStore.getState().fixtures;
    expect(restored.vise).toEqual(MEASURED_VISE);
    expect(restored.sacrificial).toEqual(MEASURED_SACRIFICIAL);
    expect(restored.vise!.source).toBe('measured');
    expect(restored.vise!.measuredAt).toBe('2026-09-20');

    // ...and it is written through, so a later reload keeps it.
    const persisted = JSON.parse(backing.get('casemaker.settings.v1') ?? '{}') as {
      fixtures?: { vise?: ViseParams };
    };
    expect(persisted.fixtures?.vise).toEqual(MEASURED_VISE);
  });

  it('a refused import leaves the current machine untouched', async () => {
    const gen = await generation();
    gen.useSettingsStore.getState().replaceFixtures({ vise: MEASURED_VISE });
    const result = gen.parseMyMachineFile('{"kind":"casemaker-my-machine","schemaVersion":1,"fixtures":{"vise":{"stockProud":1}}}');
    expect(result.ok).toBe(false);
    // The caller only applies on ok; the store still holds the original.
    expect(gen.useSettingsStore.getState().fixtures.vise).toEqual(MEASURED_VISE);
  });

  it('replaceFixtures({}) clears both saved sections', async () => {
    const gen = await generation();
    gen.useSettingsStore.getState().setVise(MEASURED_VISE);
    gen.useSettingsStore.getState().setSacrificial(MEASURED_SACRIFICIAL);
    gen.useSettingsStore.getState().replaceFixtures({});
    expect(gen.useSettingsStore.getState().fixtures).toEqual({});
  });
});
