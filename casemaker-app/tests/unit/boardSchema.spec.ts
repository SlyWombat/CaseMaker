import { describe, it, expect } from 'vitest';
import { builtinBoards } from '@/library';
import { boardProfileSchema, builtinBoardProfileSchema } from '@/library/schema';

describe('board library', () => {
  it('contains at least one built-in board', () => {
    expect(builtinBoards.length).toBeGreaterThan(0);
  });

  it('every built-in board passes the strict schema (requires source URL)', () => {
    for (const b of builtinBoards) {
      expect(() => builtinBoardProfileSchema.parse(b)).not.toThrow();
    }
  });

  it('every built-in board has a mountingHoles array (may be empty)', () => {
    // Most boards have 4; micro:bit V2 has 2; the Arduino Nano ESP32 has 0
    // (it's a breadboard module — the user retains it via headers, snap-fit,
    // or friction posts, not PCB mount holes). The schema accepts an empty
    // array (#112 — generic-empty boards) and computeBossPlacements returns
    // [] when there are no holes, so the case build still works.
    for (const b of builtinBoards) {
      expect(Array.isArray(b.mountingHoles)).toBe(true);
    }
  });

  it('rejects a board missing a source URL when strict-validated', () => {
    const partial = {
      id: 'foo',
      name: 'Foo',
      manufacturer: 'Test',
      pcb: { size: { x: 50, y: 50, z: 1.6 } },
      mountingHoles: [{ id: 'h1', x: 5, y: 5, diameter: 2.5 }],
      components: [],
      defaultStandoffHeight: 3,
      recommendedZClearance: 5,
      builtin: true,
    };
    expect(() => boardProfileSchema.parse(partial)).not.toThrow();
    expect(() => builtinBoardProfileSchema.parse(partial)).toThrow();
  });
});

describe('board notes (#622)', () => {
  const base = {
    id: 'foo',
    name: 'Foo',
    manufacturer: 'Test',
    pcb: { size: { x: 50, y: 50, z: 1.6 } },
    mountingHoles: [],
    components: [],
    defaultStandoffHeight: 3,
    recommendedZClearance: 5,
    source: 'https://example.com/foo.pdf',
    builtin: true,
  };

  it('is optional', () => {
    const parsed = builtinBoardProfileSchema.parse(base);
    expect(parsed.notes).toBeUndefined();
  });

  it('round-trips through the schema and JSON', () => {
    const notes = 'Heatsink envelope assumed.\nCaliper the fan before printing.';
    const parsed = builtinBoardProfileSchema.parse({ ...base, notes });
    expect(parsed.notes).toBe(notes);
    const again = builtinBoardProfileSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(again).toEqual(parsed);
  });

  it('rejects a non-string', () => {
    expect(() => boardProfileSchema.parse({ ...base, notes: 3 })).toThrow();
  });

  it('the back-filled built-ins carry their assumptions in notes, not in datasheetRevision', () => {
    const byId = new Map(builtinBoards.map((b) => [b.id, b]));
    for (const id of ['radxa-dragon-q8b', 'ubiquiti-u7-pro-outdoor']) {
      const b = byId.get(id);
      expect(b, id).toBeDefined();
      expect(() => builtinBoardProfileSchema.parse(b)).not.toThrow();
      expect(b!.notes, id).toBeTruthy();
    }
    expect(byId.get('ubiquiti-u7-pro-outdoor')!.datasheetRevision).toBe('techspecs.ui.com 2026-08');
    expect(byId.get('ubiquiti-u7-pro-outdoor')!.notes).toMatch(/sliderChannel/);
    expect(byId.get('radxa-dragon-q8b')!.notes).toMatch(/heatsink/i);
    // No built-in hides assumption text in its revision string.
    for (const b of builtinBoards) {
      expect(b.datasheetRevision ?? '', b.id).not.toMatch(/unverified|estimate|assum|caliper/i);
    }
  });
});
