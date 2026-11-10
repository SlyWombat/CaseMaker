/**
 * #1117 — THE FREEING CONTOUR AGAINST THE VISE'S JAWS, AT PLAN STAGE. The check is pure and cheap:
 * the contour's moves (the plan's own), the vise's jaw bars, and the cutter's widest radial reach
 * below the jaw top. One sentence when the shank enters a jaw; silence otherwise. The verifier and
 * the sweep stay the backstop for every OTHER op near a jaw.
 */
import { describe, expect, it } from 'vitest';

import { contourJawClearanceFinding, type JawClearanceInput } from '@/engine/cnc/mounts/jawClearance';
import type { CamMove } from '@/engine/cnc/cam/ir';

/** ref-tray70's shape: a 106 mm part on a 110 × 140 stock, the shipped Z1 vise, a 6 mm shank. */
const VISE = { fixedJawThickness: 10, movingJawThickness: 10, jawLength: 100, jawStartY: -10, stockProud: 4 };

const move = (x: number, y: number, z: number): CamMove => ({ kind: 'feed', x, y, z, f: 600 } as CamMove);

function input(over: Partial<JawClearanceInput> = {}): JawClearanceInput {
  return {
    stock: { length: 110, width: 140 },
    vise: VISE,
    // The contour down the stock's right edge, 2 mm in, at depth (the jaw top sits 4 mm below the
    // stock top: any cut below -4 is beside the jaws).
    contour: [move(108, 10, -24), move(108, 120, -24), move(2, 120, -24)],
    shankRadiusMm: 3,
    clearanceMm: 0,
    ...over,
  };
}

describe('#1117 the freeing contour against the vise jaws', () => {
  it('states ONE finding with the shank, the rim and the jaw when the shank reaches the moving jaw', () => {
    const finding = contourJawClearanceFinding(input());
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe('error');
    expect(finding!.code).toBe('clamp-in-path');
    expect(finding!.message).toContain('moving jaw (right)');
    expect(finding!.message).toContain('6 mm shank');
    expect(finding!.message).toContain('2 mm from the stock’s edge');
    expect(finding!.message).toContain('1 mm past it');
    // The sentence says where it was found: at plan stage, nothing posted.
    expect(finding!.message).toContain('plan stage');
    expect(finding!.message).toContain('shank is no wider than'); // the ways out are named
  });

  it('is silent when the shank clears the jaw (rim wider than the shank radius)', () => {
    expect(contourJawClearanceFinding(input({ contour: [move(105, 10, -24), move(105, 120, -24)] }))).toBeNull();
  });

  it('is silent when the contour never goes below the jaw tops', () => {
    // The jaw top is stockProud (4 mm) below the stock top: a cut at -2 is above it.
    expect(contourJawClearanceFinding(input({ contour: [move(108, 10, -2), move(108, 120, -2)] }))).toBeNull();
  });

  it('is silent when the contour passes the stock edge outside the jaw bar’s own Y span', () => {
    // jawStartY -10 + jawLength 100 = 90: a contour at y 120 runs past the bar's end.
    expect(contourJawClearanceFinding(input({ contour: [move(108, 100, -24), move(108, 130, -24)] }))).toBeNull();
  });

  it('names the fixed jaw when the contour runs the other edge', () => {
    const finding = contourJawClearanceFinding(input({ contour: [move(2, 10, -24), move(2, 80, -24)] }));
    expect(finding!.message).toContain('fixed jaw (left)');
  });
});
