import { describe, it, expect } from 'vitest';
import { buildVentilationCutouts } from '@/engine/compiler/ventilation';
import { createDefaultProject } from '@/store/projectStore';

describe('hex ventilation pattern', () => {
  it('produces no ops when disabled', () => {
    const p = createDefaultProject('rpi-4b');
    p.case.ventilation = { enabled: false, pattern: 'hex', coverage: 0.5 };
    expect(buildVentilationCutouts(p.board, p.case)).toEqual({ shellCuts: [], lidCuts: [] });
  });

  it('produces no ops when coverage is 0', () => {
    const p = createDefaultProject('rpi-4b');
    p.case.ventilation = { enabled: true, pattern: 'hex', coverage: 0 };
    expect(buildVentilationCutouts(p.board, p.case)).toEqual({ shellCuts: [], lidCuts: [] });
  });

  it('produces multiple hex ops at 0.7 coverage on a Pi 4B', () => {
    const p = createDefaultProject('rpi-4b');
    p.case.ventilation = { enabled: true, pattern: 'hex', coverage: 0.7 };
    p.case.zClearance = 30; // give vertical room for multiple hex rows
    const cuts = buildVentilationCutouts(p.board, p.case);
    expect(cuts.shellCuts.length + cuts.lidCuts.length).toBeGreaterThan(5);
  });

  it('hex pattern uses cylinder primitives; slot pattern uses cube primitives', () => {
    const slots = createDefaultProject('rpi-4b');
    slots.case.zClearance = 20;
    slots.case.ventilation = { enabled: true, pattern: 'slots', coverage: 0.6 };
    const hex = createDefaultProject('rpi-4b');
    hex.case.zClearance = 20;
    hex.case.ventilation = { enabled: true, pattern: 'hex', coverage: 0.6 };
    const slotOps = [
      ...buildVentilationCutouts(slots.board, slots.case).shellCuts,
      ...buildVentilationCutouts(slots.board, slots.case).lidCuts,
    ];
    const hexOps = [
      ...buildVentilationCutouts(hex.board, hex.case).shellCuts,
      ...buildVentilationCutouts(hex.board, hex.case).lidCuts,
    ];
    const innermost = (op: (typeof slotOps)[number]): string => {
      let cur = op;
      while (cur.kind === 'translate' || cur.kind === 'rotate') cur = cur.child;
      return cur.kind;
    };
    expect(slotOps.every((o) => innermost(o) === 'cube')).toBe(true);
    expect(hexOps.every((o) => innermost(o) === 'cylinder')).toBe(true);
  });
});
