import { describe, it, expect } from 'vitest';
import { serializeProject, parseProject } from '@/store/persistence';
import { createDefaultProject } from '@/store/projectStore';

describe('project persistence', () => {
  it('round-trips a default project through JSON', () => {
    const original = createDefaultProject('rpi-4b');
    const text = serializeProject(original);
    const parsed = parseProject(text);
    expect(parsed.id).toBe(original.id);
    expect(parsed.board.id).toBe(original.board.id);
    expect(parsed.case).toEqual(original.case);
    expect(parsed.ports.length).toBe(original.ports.length);
    expect(parsed.schemaVersion).toBe(7);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseProject('{"not": "a project"}')).toThrow();
  });

  it('rejects projects with unknown schemaVersion', () => {
    const original = createDefaultProject('rpi-4b');
    const tampered = JSON.stringify({ ...original, schemaVersion: 99 });
    expect(() => parseProject(tampered)).toThrow();
  });

  it('migrates schemaVersion=1 projects forward to current', () => {
    const v5 = createDefaultProject('rpi-4b');
    const raw: Record<string, unknown> = { ...v5 };
    delete raw.hats;
    delete raw.customHats;
    delete raw.mountingFeatures;
    delete raw.display;
    delete raw.customDisplays;
    delete raw.fanMounts;
    delete raw.textLabels;
    delete raw.antennas;
    const v1 = { ...raw, schemaVersion: 1 };
    const text = JSON.stringify(v1);
    const parsed = parseProject(text);
    expect(parsed.schemaVersion).toBe(7);
    expect(parsed.hats).toEqual([]);
    expect(parsed.customHats).toEqual([]);
    expect(parsed.mountingFeatures).toEqual([]);
    expect(parsed.display).toBeNull();
    expect(parsed.customDisplays).toEqual([]);
  });

  it('migrates schemaVersion=2 projects forward to current', () => {
    const v5 = createDefaultProject('rpi-4b');
    const raw: Record<string, unknown> = { ...v5 };
    delete raw.mountingFeatures;
    delete raw.display;
    delete raw.customDisplays;
    delete raw.fanMounts;
    delete raw.textLabels;
    delete raw.antennas;
    const v2 = { ...raw, schemaVersion: 2 };
    const text = JSON.stringify(v2);
    const parsed = parseProject(text);
    expect(parsed.schemaVersion).toBe(7);
    expect(parsed.mountingFeatures).toEqual([]);
    expect(parsed.display).toBeNull();
  });
});

describe('issue #144 — File System Access pickers keep window as their receiver', () => {
  // The bug: fsAccess() handed back bare `w.showSaveFilePicker` references, and
  // the callers invoked them as `api.save(...)`, so `this` was the returned
  // object literal. Chrome's WebIDL binding checks the receiver and throws
  // "Failed to execute 'showSaveFilePicker' on 'Window': Illegal invocation",
  // which broke Save as... and Load in production. Export was unaffected
  // because exportTrigger calls the picker on `window` itself.
  //
  // A plain vi.fn() stub CANNOT catch this — it is callable with any receiver.
  // These stubs assert their own `this`, the way the real binding does.
  const withFakeWindow = async (
    body: () => Promise<void>,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    const fake: Record<string, unknown> = {};
    const guard = (name: string, impl: (...a: unknown[]) => unknown) =>
      function (this: unknown, ...args: unknown[]): unknown {
        if (this !== fake) {
          throw new TypeError(
            `Failed to execute '${name}' on 'Window': Illegal invocation`,
          );
        }
        return impl(...args);
      };
    fake.showSaveFilePicker = guard('showSaveFilePicker', extra.save as never);
    fake.showOpenFilePicker = guard('showOpenFilePicker', extra.open as never);
    const g = globalThis as unknown as { window?: unknown };
    const had = 'window' in g;
    const prev = g.window;
    g.window = fake;
    try {
      await body();
    } finally {
      if (had) g.window = prev;
      else delete g.window;
    }
  };

  it('saves through the picker without an Illegal invocation', async () => {
    const { saveProjectViaPicker } = await import('@/store/persistence');
    const written: string[] = [];
    await withFakeWindow(
      async () => {
        const handle = await saveProjectViaPicker(createDefaultProject('rpi-4b'));
        expect(handle, 'a real handle came back, not the download fallback').not.toBeNull();
        expect(written.length).toBe(1);
        expect(JSON.parse(written[0]!).board.id).toContain('rpi-4b');
      },
      {
        save: () => ({
          createWritable: async () => ({
            write: async (t: string) => {
              written.push(t);
            },
            close: async () => {},
          }),
        }),
        open: () => [],
      },
    );
  });

  it('opens through the picker without an Illegal invocation', async () => {
    const { openProjectViaPicker, serializeProject } = await import('@/store/persistence');
    const project = createDefaultProject('rpi-4b');
    const text = serializeProject(project);
    await withFakeWindow(
      async () => {
        const got = await openProjectViaPicker();
        expect(got.project.board.id).toContain('rpi-4b');
      },
      {
        save: () => ({}),
        open: () => [{ getFile: async () => ({ text: async () => text }) }],
      },
    );
  });
});
