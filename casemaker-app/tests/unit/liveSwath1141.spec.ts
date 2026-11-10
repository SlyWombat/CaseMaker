// #1141 phase 2a — THE CUT-SWATH OVERLAY's core: the posted program compiled to line-labelled
// moves, the cursor advanced by the controller's reported `P:` line, and the WPos cap.
//
// THE RULING (2026-11-09): draw the cutting moves up to the reported line; the WPos cap is ALWAYS
// on — never past the segment holding the live tip; a line drop resets; nothing clears on a
// mid-job Idle or a missing `P:`. `P:` field 1 is the physical source line of the playing file
// (proved on the bench: a 34-line air program's `P:34` at 100 %, and its six `G1`s at their lines).
import { describe, expect, it } from 'vitest';
import {
  buildSwathIndex,
  swathQuads,
  swathStep,
  SWATH_TIP_TOLERANCE_MM,
  type SwathIndex,
} from '@/engine/cnc/engrave/liveSwath';

/**
 * A posted program with known physical lines. The first move's `from` is unstated (the parser
 * knows no position yet), so it is skipped; every later move is placed.
 *
 *   6  G0 X0 Y0 Z5      (skipped: from is unknown)
 *   7  G1 Z-0.5         plunge at (0,0)
 *   8  G1 X10           cut to (10,0,-0.5)
 *   9  G1 Y10           cut to (10,10,-0.5)
 *   10 G0 Z5            rapid
 *   11 G0 X20 Y0        rapid
 *   12 G1 Z-1           plunge at (20,0)
 *   13 G1 X30           cut to (30,0,-1)
 *   14 G0 Z5            rapid
 */
const NC = `;@MKR|BEGIN
;@MKR|END
G90 G21
T1 M6
S12000 M3
G0 X0 Y0 Z5
G1 Z-0.5 F200
G1 X10 F500
G1 Y10
G0 Z5
G0 X20 Y0
G1 Z-1 F200
G1 X30 F500
G0 Z5
M05
M02
`;

describe('#1141 — the swath index from a posted program', () => {
  it('builds one line-labelled segment per placed move, cut or rapid', () => {
    const index = buildSwathIndex(NC);
    const lines = index.segments.map((s) => s.line);
    expect(lines).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);
    const cut8 = index.segments.find((s) => s.line === 8)!;
    expect(cut8.cut).toBe(true);
    expect(cut8.from).toEqual({ x: 0, y: 0, z: -0.5 });
    expect(cut8.to).toEqual({ x: 10, y: 0, z: -0.5 });
    expect(index.segments.find((s) => s.line === 10)!.cut).toBe(false);
    expect(index.segments.find((s) => s.line === 13)!.to).toEqual({ x: 30, y: 0, z: -1 });
  });

  it('reads the file the controller plays: arcs keep their own line, and unplaced moves are skipped', () => {
    const nc = `G90 G21
G0 X0 Y0 Z5
G2 X10 Y0 I5 J0 F400
G0 Z5
`;
    const index = buildSwathIndex(nc);
    const arc = index.segments.filter((s) => s.line === 3);
    expect(arc.length).toBeGreaterThan(1); // tessellated, every piece on the arc's line
    expect(arc.every((s) => s.cut)).toBe(true);
  });
});

describe('#1141 — the cursor advances between two P: lines', () => {
  const index = buildSwathIndex(NC);
  // The tip is on the cut at line 8 (its segment runs from (0,0) to (10,0) at z −0.5).
  const tipOn8 = { x: 5, y: 0, z: -0.5 };
  // The tip is on line 13's cut ((20,0) → (30,0) at z −1).
  const tipOn13 = { x: 25, y: 0, z: -1 };

  it('draws only the cutting moves between the last line and the reported one', () => {
    const step = swathStep(9, 13, tipOn13, index);
    expect(step).toEqual({ kind: 'draw', reset: false, throughLine: 13 });
    // (9, 13] holds line 10 (rapid, not drawn), 12 (plunge: no XY length), 13 (cut).
    const quads = swathQuads(index, 9, 13, 1);
    expect(quads.length).toBe(6 * 3); // exactly one cutting segment's two triangles
  });

  it('states nothing before the first P: block and when the line has not moved', () => {
    expect(swathStep(null, 0, tipOn8, index)).toEqual({ kind: 'hold' });
    expect(swathStep(null, null, tipOn8, index)).toEqual({ kind: 'hold' });
    expect(swathStep(13, 13, tipOn8, index)).toEqual({ kind: 'hold' });
  });
});

describe('#1141 — the WPos cap is ALWAYS on', () => {
  const index = buildSwathIndex(NC);

  it('never draws past the segment holding the live tip, even when the reported line runs ahead', () => {
    // The controller reports line 30 (the file has 16), but the tip is still on line 9's cut.
    const step = swathStep(8, 30, { x: 10, y: 5, z: -0.5 }, index);
    expect(step).toEqual({ kind: 'draw', reset: false, throughLine: 9 });
    const quads = swathQuads(index, 8, 9, 1);
    expect(quads.length).toBe(6 * 3); // line 9 only; line 13 is never drawn
  });

  it('holds when the tip cannot be located on the path', () => {
    expect(swathStep(8, 30, { x: 500, y: 500, z: 5 }, index)).toEqual({ kind: 'hold' });
  });

  it('holds when the tip is unknown', () => {
    expect(swathStep(8, 30, null, index)).toEqual({ kind: 'hold' });
  });

  it('the tolerance is a millimetre-scale band, not a guess of the cutter', () => {
    expect(SWATH_TIP_TOLERANCE_MM).toBe(2);
    // 1.5 mm off the line-8 cut is still that segment; 3 mm off is nowhere.
    expect(swathStep(7, 30, { x: 5, y: 1.5, z: -0.5 }, index)).toEqual({ kind: 'draw', reset: false, throughLine: 8 });
    expect(swathStep(7, 30, { x: 5, y: 3, z: -0.5 }, index)).toEqual({ kind: 'hold' });
  });
});

describe('#1141 — a line drop resets, and a mid-job Idle or a missing P: never clears', () => {
  const index = buildSwathIndex(NC);

  it('resets on a line drop and redraws from the program’s start up to the tip', () => {
    const step = swathStep(13, 9, { x: 5, y: 0, z: -0.5 }, index);
    expect(step).toEqual({ kind: 'draw', reset: true, throughLine: 8 });
    // The caller clears what it drew and repaints (from the start) only the lines up to the tip.
    const quads = swathQuads(index, null, 8, 1);
    expect(quads.length).toBe(6 * 3); // line 8 alone
  });

  it('a missing P: holds — never a reset', () => {
    expect(swathStep(9, null, { x: 5, y: 0, z: -0.5 }, index)).toEqual({ kind: 'hold' });
  });

  it('a line that reads 0 mid-run holds — 0 is "no block yet", never a drop', () => {
    // The bench saw field 1 read 0 for a whole G53-only pass (2026-11-10): a drop-to-0 must not
    // clear the swath, so 0 is excluded before the drop test.
    expect(swathStep(13, 0, { x: 5, y: 0, z: -0.5 }, index)).toEqual({ kind: 'hold' });
    expect(swathStep(13, 0, null, index)).toEqual({ kind: 'hold' });
  });

  it('a state word that reads Idle changes nothing: the step depends on the line, not the state', () => {
    // The mid-job Idle at `M05` keeps the reported line; the same call twice is a hold, no clear.
    expect(swathStep(9, 9, { x: 5, y: 0, z: -0.5 }, index)).toEqual({ kind: 'hold' });
  });
});

describe('#1141 — the ribbon geometry', () => {
  const index: SwathIndex = buildSwathIndex(NC);

  it('widens each cutting segment by the cutter radius, on the work frame’s z', () => {
    const quads = swathQuads(index, null, 8, 1);
    // Line 8 runs (0,0) → (10,0) at z −0.5: the ribbon is y ∈ [−1, 1], z −0.5.
    const ys = new Set<number>();
    const zs = new Set<number>();
    for (let i = 0; i < quads.length; i += 3) {
      ys.add(quads[i + 1]!);
      zs.add(quads[i + 2]!);
    }
    expect([...ys].sort((a, b) => a - b)).toEqual([-1, 1]);
    expect([...zs]).toEqual([-0.5]);
  });

  it('lifts the whole ribbon to one plane when asked (the blank’s top face)', () => {
    const quads = swathQuads(index, null, 13, 1, 0.05);
    for (let i = 0; i < quads.length; i += 3) expect(quads[i + 2]).toBeCloseTo(0.05, 6);
  });

  it('draws nothing for a plunge (no XY length) and nothing for rapids', () => {
    expect(swathQuads(index, null, 7, 1).length).toBe(0); // line 7 is a plunge
    expect(swathQuads(index, 9, 11, 1).length).toBe(0); // lines 10 and 11 are rapids
  });
});
