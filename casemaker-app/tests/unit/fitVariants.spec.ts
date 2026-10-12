// Issue #153 — exposed tolerance variants (the fit ladder) on the snap
// interfaces. What these tests guard:
//   • the ladder only ever LOOSENS; an absent fit is 0 relief so legacy
//     projects compile byte-identically to pre-#153
//   • the relief reaches the GEOMETRY, in the right direction: the snap CUT
//     grows on the lateral + protrusion axes and the retention (Z) axis is
//     untouched so the click lands at the same height
//   • the lid tab is NOT relieved (relief on both printed halves cancels)
//   • the fields survive the Zod schema (which strips unknown keys) and a v9
//     project still loads, stamped v10

import { describe, it, expect } from 'vitest';
import { fitRelief, FIT_RELIEF_MM, FIT_VARIANTS } from '@/types/snap';
import { buildSnapCatch, defaultSnapCatchesForCase } from '@/engine/compiler/snapCatches';
import { buildBoardSnapOps } from '@/engine/compiler/boardSnap';
import { buildRackNodes, FOOT_H, plateTabYs, SIDE_T, TAB_T, TAB_Z_OPEN, TAB_Z_SHAVE } from '@/engine/compiler/rack';
import { aabbOfOp, union, type BuildOp } from '@/engine/compiler/buildPlan';
import { cavityOriginXY } from '@/engine/coords';
import { createDefaultProject } from '@/store/projectStore';
import { serializeProject, parseProject } from '@/store/persistence';
import type { BoardProfile, CaseParameters, RackParams } from '@/types';
import { Manifold, exec, type ManifoldInstance } from './helpers/manifoldExec';

function makeBoard(x: number, y: number): BoardProfile {
  return {
    id: `t-${x}x${y}`,
    name: 'T',
    manufacturer: 'T',
    pcb: { size: { x, y, z: 1.6 } },
    mountingHoles: [{ id: 'h1', x: 5, y: 5, diameter: 2.5 }],
    components: [],
    defaultStandoffHeight: 3,
    recommendedZClearance: 10,
    source: 'https://example.com',
    builtin: false,
  };
}

const baseCase: CaseParameters = {
  wallThickness: 2,
  floorThickness: 2,
  lidThickness: 2,
  cornerRadius: 0,
  internalClearance: 0.5,
  zClearance: 10,
  joint: 'snap-fit',
  ventilation: { enabled: false, pattern: 'none', coverage: 0 },
  bosses: { enabled: true, insertType: 'none', outerDiameter: 5, holeDiameter: 2.5 },
};

/** Probe side, mm for a face walk. Small enough that the smeared solid/void
 *  boundary of a cube straddling a face lands within a few hundredths. */
const PROBE = 0.04;

/** Is the op's material present at this point? */
function solidAt(m: ManifoldInstance, p: [number, number, number], s = 0.12): boolean {
  const c = Manifold.cube([s, s, s], true).translate(p);
  const i = Manifold.intersection([m, c]);
  const v = i.volume();
  i.delete();
  c.delete();
  return v > (s * s * s) / 2;
}

describe('Issue #153 — the fit ladder', () => {
  it('names three variants, tightest first', () => {
    expect(FIT_VARIANTS).toEqual(['tight', 'standard', 'loose']);
  });

  it('only ever loosens: an absent fit is 0, exactly like tight (legacy)', () => {
    expect(fitRelief(undefined)).toBe(0);
    expect(fitRelief('tight')).toBe(0);
    expect(fitRelief('standard')).toBe(0.1);
    expect(fitRelief('loose')).toBe(0.25);
    expect(FIT_RELIEF_MM.loose).toBeGreaterThan(FIT_RELIEF_MM.standard);
    expect(FIT_RELIEF_MM.standard).toBeGreaterThan(FIT_RELIEF_MM.tight);
  });
});

describe('Issue #153 — snap-catch relief grows the CUT, not the tab', () => {
  const board = makeBoard(60, 50);
  const catchX = defaultSnapCatchesForCase(board, baseCase).find((c) => c.wall === '-x')!;
  const tight = buildSnapCatch({ ...catchX, fit: 'tight' }, board, baseCase)!;
  const loose = buildSnapCatch({ ...catchX, fit: 'loose' }, board, baseCase)!;
  const relief = fitRelief('loose');

  it('widens the hole laterally (tangent) by the relief', () => {
    const t = aabbOfOp(tight.wallPocket!)!;
    const l = aabbOfOp(loose.wallPocket!)!;
    const tangentY = (a: { min: number[]; max: number[] }) => a.max[1]! - a.min[1]!;
    expect(tangentY(l) - tangentY(t)).toBeCloseTo(relief, 5);
  });

  it('deepens the hole into the wall (protrusion) by the relief', () => {
    const t = aabbOfOp(tight.wallPocket!)!;
    const l = aabbOfOp(loose.wallPocket!)!;
    // -x wall: the barb reaches toward -X, so deepening lowers the min X.
    expect(t.min[0]! - l.min[0]!).toBeCloseTo(relief, 5);
  });

  it('leaves the retention (Z) extents — and the click height — untouched', () => {
    const t = aabbOfOp(tight.wallPocket!)!;
    const l = aabbOfOp(loose.wallPocket!)!;
    expect(l.min[2]).toBeCloseTo(t.min[2]!, 5);
    expect(l.max[2]).toBeCloseTo(t.max[2]!, 5);
  });

  it('does NOT relieve the lid tab itself (relief on both halves cancels)', () => {
    expect(aabbOfOp(loose.armBarb)).toEqual(aabbOfOp(tight.armBarb));
  });

  it('per-catch fit overrides the case-level fit', () => {
    const caseLoose: CaseParameters = { ...baseCase, fit: 'loose' };
    const inherited = buildSnapCatch({ ...catchX }, board, caseLoose)!;
    const overridden = buildSnapCatch({ ...catchX, fit: 'tight' }, board, caseLoose)!;
    expect(aabbOfOp(overridden.wallPocket!)).toEqual(aabbOfOp(tight.wallPocket!));
    expect(aabbOfOp(inherited.wallPocket!)).toEqual(aabbOfOp(loose.wallPocket!));
  });
});

describe('Issue #153 — board-snap clip relief widens the lateral gap', () => {
  // COUPON-style board: bare snap-retention shell.
  const board = makeBoard(60, 40);
  const params: CaseParameters = {
    ...baseCase,
    joint: 'flat-lid',
    boardRetention: 'snap',
    bosses: { enabled: false, insertType: 'self-tap', outerDiameter: 5, holeDiameter: 2.5 },
  };

  it('releases the spine from the PCB edge by the relief', () => {
    const tightOps = buildBoardSnapOps(board, { ...params, fit: 'tight' }).caseAdditive;
    const looseOps = buildBoardSnapOps(board, { ...params, fit: 'loose' }).caseAdditive;
    const tight = exec(union(tightOps));
    const loose = exec(union(looseOps));
    try {
      const origin = cavityOriginXY(params);
      const xCenter = origin.x + board.pcb.size.x / 2;
      // Shipped CLIP_FIT is 0.15 mm. A point 0.20 mm outboard of the -y PCB
      // edge is inside the tight spine (spans to edge-0.15) and beyond the
      // loose spine (spans to edge-0.40): the gap grew by the relief. Probe
      // below the bottom-jaw shelf so only the spine is in the cube.
      const probe: [number, number, number] = [xCenter, origin.y - 0.2, 2.5];
      expect(solidAt(tight, probe), 'tight: PCB edge still backed by the spine').toBe(true);
      expect(solidAt(loose, probe), 'loose: the spine has moved off the edge').toBe(false);
    } finally {
      tight.delete();
      loose.delete();
    }
  });
});

describe('Issue #153 — rack plate-tab ledges loosen with rack.fit', () => {
  const rack: RackParams = { enabled: true, width: 160, depth: 120, slots: 3 };

  function sideVolume(fit: RackParams['fit']): number {
    const node = buildRackNodes({ ...rack, fit }).find((n) => n.id === 'rack-side-left')!;
    const m: ManifoldInstance = exec(node.op as BuildOp);
    try {
      return m.volume();
    } finally {
      m.delete();
    }
  }

  it('a looser fit removes more material from the tab ledges', () => {
    const tight = sideVolume('tight');
    const loose = sideVolume('loose');
    // A 0.25 mm relief widens each ledge's reach and its along-plate opening.
    // Deterministic, so an exact inequality is enough.
    expect(loose).toBeLessThan(tight);
  });

  // #356 — the same ladder, on the THICKNESS axis. The ledge used to be exactly
  // TAB_T tall for every rung, so it could never relieve a thickness bind; now
  // the base opening plus the rung's relief lifts the ceiling, and the tab gives
  // up the fixed shave — one whole layer — on its inner face.
  it('loosens the ledge’s z opening by the same ladder, over a tab thinned by a FIXED shave', () => {
    const tabY = plateTabYs(rack.depth)[0]!;
    const ceilingOf = (fit: RackParams['fit']): number => {
      const m = exec(
        buildRackNodes({ ...rack, fit }).find((n) => n.id === 'rack-side-left')!.op as BuildOp,
      );
      try {
        // Walk up the ledge's centre line from inside the notch; the first solid
        // overhead is the ceiling the plate tab's inner face has to clear.
        const zMid = FOOT_H + TAB_T / 2;
        for (let d = 0; d <= 4; d += 0.01) {
          if (solidAt(m, [SIDE_T / 2, tabY, zMid + d], PROBE)) return zMid + d;
        }
        return NaN;
      } finally {
        m.delete();
      }
    };

    for (const fit of FIT_VARIANTS) {
      const ceil = ceilingOf(fit);
      expect(Number.isFinite(ceil), `${fit}: found the ledge ceiling`).toBe(true);
      expect(
        Math.abs(ceil - (FOOT_H + TAB_T + TAB_Z_OPEN + fitRelief(fit))),
        `${fit}: the ledge ceiling sits at ${ceil.toFixed(2)}, not the laddered opening`,
      ).toBeLessThan(0.04);
    }

    // The tab carries the FIXED shave only, so the plate's own volume does not
    // move with the rung — which is what lets the coupon grade every rung with
    // one printed tab.
    const plateVolume = (fit: RackParams['fit']): number => {
      const m = exec(
        buildRackNodes({ ...rack, fit }).find((n) => n.id === 'rack-bottom')!.op as BuildOp,
      );
      try {
        return m.volume();
      } finally {
        m.delete();
      }
    };
    expect(Math.abs(plateVolume('loose') - plateVolume('tight'))).toBeLessThan(1e-6);

    // ...and the shave is real: the tab is TAB_Z_SHAVE thinner, and its OUTER
    // face — the counterbore face that must stay flush with the plate — is at z=0.
    const m = exec(
      buildRackNodes({ ...rack, fit: 'tight' }).find((n) => n.id === 'rack-bottom')!.op as BuildOp,
    );
    try {
      const xProbe = SIDE_T - 10; // inside the tab, outboard of the screw bore
      const zMid = FOOT_H + TAB_T / 2; // buildRackNodes seats the plate at FOOT_H
      let lo = NaN;
      let hi = NaN;
      for (let d = 0; d <= 4 && (Number.isNaN(lo) || Number.isNaN(hi)); d += 0.01) {
        if (Number.isNaN(hi) && !solidAt(m, [xProbe, tabY, zMid + d], PROBE)) hi = zMid + d;
        if (Number.isNaN(lo) && !solidAt(m, [xProbe, tabY, zMid - d], PROBE)) lo = zMid - d;
      }
      expect(Math.abs(lo - FOOT_H), 'the tab’s outer face is flush at the plate’s underside').toBeLessThan(0.04);
      expect(
        Math.abs(hi - (FOOT_H + TAB_T - TAB_Z_SHAVE)),
        `the tab is ${(hi - lo).toFixed(2)} mm thick, not TAB_T less the shave`,
      ).toBeLessThan(0.04);
    } finally {
      m.delete();
    }
  });
});

describe('Issue #153 — the fit fields survive the schema (v10)', () => {
  const miniRack: RackParams = { enabled: true, width: 200, depth: 150, slots: 3, fit: 'standard' };

  it('round-trips case.fit, a per-catch fit, and rack.fit', () => {
    const original = createDefaultProject('rpi-4b');
    original.case.fit = 'loose';
    original.case.snapCatches = [
      { id: 'c1', wall: '-x', uPosition: 5, enabled: true, barbType: 'hook', fit: 'tight' },
    ];
    original.case.rack = miniRack;
    const parsed = parseProject(serializeProject(original));
    expect(parsed.schemaVersion).toBe(16);
    expect(parsed.case.fit).toBe('loose');
    expect(parsed.case.snapCatches![0]!.fit).toBe('tight');
    expect(parsed.case.rack!.fit).toBe('standard');
  });

  it('leaves fit undefined when a project never chose one', () => {
    const parsed = parseProject(serializeProject(createDefaultProject('rpi-4b')));
    expect(parsed.schemaVersion).toBe(16);
    expect(parsed.case.fit).toBeUndefined();
    expect(parsed.case.rack?.fit).toBeUndefined();
  });

  it('loads a v9 project, stamps it v10, and has no fit', () => {
    const v9 = { ...createDefaultProject('rpi-4b'), schemaVersion: 9 };
    const parsed = parseProject(JSON.stringify(v9));
    expect(parsed.schemaVersion).toBe(16);
    expect(parsed.case.fit).toBeUndefined();
  });
});
