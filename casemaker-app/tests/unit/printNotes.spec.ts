// Issue #154 — the PRINT-NOTES sidecar text. The one thing that must not be
// wrong is the layout mode: print-ready flips the parts, assembled does not.

import { describe, it, expect } from 'vitest';
import { printNotesText } from '@/engine/exporters/printNotes';
import { partForId } from '@/engine/exporters/parts';

const parts = (...ids: string[]) => ids.map((id) => partForId(id));

describe('print notes (#154)', () => {
  it('names the layout mode', () => {
    const ready = printNotesText(parts('shell'), 'print-ready');
    expect(ready).toContain('PRINT-READY');
    const asm = printNotesText(parts('shell'), 'assembled');
    expect(asm).toContain('ASSEMBLED');
  });

  it('print-ready says a flipped part is already turned over', () => {
    const text = printNotesText(parts('rack-bottom'), 'print-ready');
    expect(text).toContain('FLIP FOR PRINT');
    expect(text).toContain('already turned over');
    expect(text).not.toContain('NOT flipped');
    // The counterbore rationale travels with it.
    expect(text).toContain('COUNTERBORES UP');
  });

  it('assembled says a flipped part must be turned over by the user', () => {
    const text = printNotesText(parts('rack-bottom'), 'assembled');
    expect(text).toContain('FLIP FOR PRINT');
    expect(text).toContain('NOT flipped (assembled layout)');
    // Crucially, it must NOT claim the file is already flipped.
    expect(text).not.toContain('already turned over');
    expect(text).not.toContain('already comes this way up');
  });

  it('leaves a non-flipped part free of flip instructions in either layout', () => {
    for (const mode of ['print-ready', 'assembled'] as const) {
      const text = printNotesText(parts('shell'), mode);
      expect(text).not.toContain('FLIP FOR PRINT');
    }
  });

  it('states the structured support level and why', () => {
    const normal = printNotesText(parts('shell'), 'print-ready');
    expect(normal).toContain('Supports:    none');

    const frame = printNotesText(parts('rack-assembled-frame'), 'print-ready');
    expect(frame).toContain('buildplate-only');
    expect(frame).toContain('support-on-support');

    const whole = printNotesText(parts('rack-assembled-all'), 'print-ready');
    expect(whole).toContain('Supports:    full');
    expect(whole).toContain('sealed cavity');
  });

  it('shows walls/infill only for structural parts', () => {
    const shelf = printNotesText(parts('rack-shelf-0'), 'print-ready');
    expect(shelf).toContain('Walls/infill: 4 walls, 25% infill');
    const faceplate = printNotesText(parts('rack-blank-0'), 'print-ready');
    expect(faceplate).not.toContain('Walls/infill:');
  });

  it('handles an empty list without throwing', () => {
    expect(() => printNotesText([], 'print-ready')).not.toThrow();
    expect(printNotesText([], 'print-ready')).toContain('no parts listed');
  });
});
