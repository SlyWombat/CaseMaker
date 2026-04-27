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
    expect(parsed.schemaVersion).toBe(4);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseProject('{"not": "a project"}')).toThrow();
  });

  it('rejects projects with unknown schemaVersion', () => {
    const original = createDefaultProject('rpi-4b');
    const tampered = JSON.stringify({ ...original, schemaVersion: 99 });
    expect(() => parseProject(tampered)).toThrow();
  });

  it('migrates schemaVersion=1 projects forward to v4', () => {
    const v4 = createDefaultProject('rpi-4b');
    const raw: Record<string, unknown> = { ...v4 };
    delete raw.hats;
    delete raw.customHats;
    delete raw.mountingFeatures;
    delete raw.display;
    delete raw.customDisplays;
    delete raw.fanMounts;
    delete raw.textLabels;
    const v1 = { ...raw, schemaVersion: 1 };
    const text = JSON.stringify(v1);
    const parsed = parseProject(text);
    expect(parsed.schemaVersion).toBe(4);
    expect(parsed.hats).toEqual([]);
    expect(parsed.customHats).toEqual([]);
    expect(parsed.mountingFeatures).toEqual([]);
    expect(parsed.display).toBeNull();
    expect(parsed.customDisplays).toEqual([]);
  });

  it('migrates schemaVersion=2 projects forward to v4', () => {
    const v4 = createDefaultProject('rpi-4b');
    const raw: Record<string, unknown> = { ...v4 };
    delete raw.mountingFeatures;
    delete raw.display;
    delete raw.customDisplays;
    delete raw.fanMounts;
    delete raw.textLabels;
    const v2 = { ...raw, schemaVersion: 2 };
    const text = JSON.stringify(v2);
    const parsed = parseProject(text);
    expect(parsed.schemaVersion).toBe(4);
    expect(parsed.mountingFeatures).toEqual([]);
    expect(parsed.display).toBeNull();
  });
});
