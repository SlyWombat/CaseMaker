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
    expect(parsed.schemaVersion).toBe(2);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseProject('{"not": "a project"}')).toThrow();
  });

  it('rejects projects with unknown schemaVersion', () => {
    const original = createDefaultProject('rpi-4b');
    const tampered = JSON.stringify({ ...original, schemaVersion: 99 });
    expect(() => parseProject(tampered)).toThrow();
  });

  it('migrates schemaVersion=1 projects by adding empty hats and customHats arrays', () => {
    const v2 = createDefaultProject('rpi-4b');
    const v1Raw: Record<string, unknown> = { ...v2 };
    delete v1Raw.hats;
    delete v1Raw.customHats;
    const v1 = { ...v1Raw, schemaVersion: 1 };
    const text = JSON.stringify(v1);
    const parsed = parseProject(text);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.hats).toEqual([]);
    expect(parsed.customHats).toEqual([]);
  });
});
