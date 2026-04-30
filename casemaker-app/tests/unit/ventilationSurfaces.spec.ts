// Issue #75 — multi-surface ventilation. Default (legacy) projects with no
// `surfaces` field render identically to today (back wall only). Selecting
// multiple surfaces produces strictly more cutouts.

import { describe, it, expect } from 'vitest';
import { buildVentilationCutouts } from '@/engine/compiler/ventilation';
import { createDefaultProject } from '@/store/projectStore';

// Followup to #75 — buildVentilationCutouts now returns split cuts:
//   { shellCuts, lidCuts }. shellCuts pierce the case shell; lidCuts
//   pierce the lid mesh (top-surface vents — previously silently
//   dropped because the shell has no material at lid Z).
function totalCount(c: { shellCuts: unknown[]; lidCuts: unknown[] }): number {
  return c.shellCuts.length + c.lidCuts.length;
}

describe('Multi-surface ventilation (#75)', () => {
  const baseProject = createDefaultProject('rpi-4b');
  baseProject.case.ventilation = {
    enabled: true,
    pattern: 'slots',
    coverage: 0.5,
  };

  it('legacy project (no surfaces field) defaults to back wall only', () => {
    const cuts = buildVentilationCutouts(baseProject.board, baseProject.case);
    expect(totalCount(cuts)).toBeGreaterThan(0);
  });

  it('explicit surfaces=["back"] matches legacy output count', () => {
    const legacy = buildVentilationCutouts(baseProject.board, baseProject.case);
    const explicit = buildVentilationCutouts(baseProject.board, {
      ...baseProject.case,
      ventilation: { ...baseProject.case.ventilation, surfaces: ['back'] },
    });
    expect(totalCount(explicit)).toBe(totalCount(legacy));
  });

  it('top + bottom + back produces strictly more cutouts than back alone', () => {
    const single = buildVentilationCutouts(baseProject.board, {
      ...baseProject.case,
      ventilation: { ...baseProject.case.ventilation, surfaces: ['back'] },
    });
    const multi = buildVentilationCutouts(baseProject.board, {
      ...baseProject.case,
      ventilation: {
        ...baseProject.case.ventilation,
        surfaces: ['back', 'top', 'bottom'],
      },
    });
    expect(totalCount(multi)).toBeGreaterThan(totalCount(single));
    // top vents are routed to lidCuts; back+bottom go to shellCuts.
    expect(multi.lidCuts.length).toBeGreaterThan(0);
    expect(multi.shellCuts.length).toBeGreaterThan(single.shellCuts.length);
  });

  it('all six surfaces selected produces ~6× the cutouts of one surface', () => {
    const single = buildVentilationCutouts(baseProject.board, {
      ...baseProject.case,
      ventilation: { ...baseProject.case.ventilation, surfaces: ['back'] },
    });
    const all = buildVentilationCutouts(baseProject.board, {
      ...baseProject.case,
      ventilation: {
        ...baseProject.case.ventilation,
        surfaces: ['top', 'bottom', 'front', 'back', 'left', 'right'],
      },
    });
    expect(totalCount(all)).toBeGreaterThanOrEqual(totalCount(single) * 4);
  });

  it('hex pattern multi-surface also produces more cutouts than single', () => {
    const baseCase = {
      ...baseProject.case,
      ventilation: {
        ...baseProject.case.ventilation,
        pattern: 'hex' as const,
      },
    };
    const single = buildVentilationCutouts(baseProject.board, {
      ...baseCase,
      ventilation: { ...baseCase.ventilation, surfaces: ['back'] },
    });
    const multi = buildVentilationCutouts(baseProject.board, {
      ...baseCase,
      ventilation: {
        ...baseCase.ventilation,
        surfaces: ['back', 'left', 'right'],
      },
    });
    expect(totalCount(multi)).toBeGreaterThan(totalCount(single));
  });

  it('empty surfaces array also defaults to back wall (defensive)', () => {
    const cuts = buildVentilationCutouts(baseProject.board, {
      ...baseProject.case,
      ventilation: { ...baseProject.case.ventilation, surfaces: [] },
    });
    expect(totalCount(cuts)).toBeGreaterThan(0);
  });

  it("'top' surface routes vents to lidCuts (#user-reported regression)", () => {
    const cuts = buildVentilationCutouts(baseProject.board, {
      ...baseProject.case,
      ventilation: { ...baseProject.case.ventilation, surfaces: ['top'] },
    });
    expect(cuts.shellCuts.length).toBe(0);
    expect(cuts.lidCuts.length).toBeGreaterThan(0);
  });
});
