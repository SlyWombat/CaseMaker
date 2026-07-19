import { describe, it, expect } from 'vitest';
import { TEMPLATES, findTemplate } from '@/library/templates';
import { templateSpecSchema } from '@/library/templates/templateSchema';
import { buildProjectFromSpec } from '@/library/templates/buildFromSpec';

/**
 * #126 — declarative template specs + interpreter. The point of the
 * refactor: a spec CANNOT bypass patchCase-equivalent auto-population.
 */
describe('template spec interpreter (#126)', () => {
  it('every snap-fit template has seeded snap catches (the #29/#35 bug class)', () => {
    for (const tpl of TEMPLATES) {
      const p = tpl.build();
      if (p.case.joint === 'snap-fit') {
        expect(p.case.snapCatches, `${tpl.id} must seed snapCatches`).toBeDefined();
        expect(p.case.snapCatches!.length, `${tpl.id} must seed snapCatches`).toBeGreaterThan(0);
      }
    }
  });

  it('pi-zero-tablet (snap-fit via spec) seeds catches the old build() forgot', () => {
    const p = findTemplate('pi-zero-tablet')!.build();
    expect(p.case.joint).toBe('snap-fit');
    expect(p.case.snapCatches!.length).toBeGreaterThan(0);
  });

  it('HAT templates carry factory-derived ports and stable placement ids', () => {
    const poe = findTemplate('pi-poe-stack')!.build();
    expect(poe.hats).toHaveLength(1);
    expect(poe.hats[0]!.id).toBe('tpl-hat-poe');
    expect(poe.hats[0]!.enabled).toBe(true);
    const giga = findTemplate('giga-dmx-controller')!.build();
    expect(giga.hats[0]!.id).toBe('tpl-hat-giga-dmx');
    expect(giga.hats[0]!.ports.length).toBeGreaterThanOrEqual(2); // XLRs
  });

  it('emptyBoard template synthesizes the interior and clears ports', () => {
    const p = findTemplate('large-box-200')!.build();
    expect(p.board.id).toBe('generic-200-cavity');
    expect(p.board.pcb.size.x).toBe(192);
    expect(p.board.components).toHaveLength(0);
    expect(p.ports).toHaveLength(0);
    expect(p.case.zClearance).toBe(93);
  });

  it('ports:"none" clears auto ports (stand templates)', () => {
    const p = findTemplate('guition-desk-stand')!.build();
    expect(p.ports).toHaveLength(0);
    expect(p.case.stand?.enabled).toBe(true);
    expect(p.case.bosses.enabled).toBe(false);
  });

  it('rejects specs with an invalid casePatch (schema-validated at load)', () => {
    const bad = {
      id: 'x', name: 'x', description: 'x', estPrintMinutes: 10, order: 1,
      boardId: 'rpi-4b',
      casePatch: { joint: 'does-not-exist' },
    };
    expect(templateSpecSchema.safeParse(bad).success).toBe(false);
  });

  it('interpreter defaults projectName to the template name', () => {
    const spec = templateSpecSchema.parse({
      id: 'tmp-test', name: 'Temp Test', description: 'd', estPrintMinutes: 10, order: 999,
      boardId: 'rpi-4b',
    });
    const p = buildProjectFromSpec(spec);
    expect(p.name).toBe('Temp Test');
    // Board defaults preserved: ports auto-derived, board cloned editable.
    expect(p.ports.length).toBeGreaterThan(0);
    expect(p.board.clonedFrom).toBe('rpi-4b');
  });
});
