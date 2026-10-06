// Issue #150 — the interior divider system: the floor hole-grid and the
// drop-in peg family that lands in it.
//
// The grid assertions are pure profile math (no wasm). The peg assertions run
// the production evaluator through the shared helper, because "one connected
// shell, reaching exactly this far into the socket" is a claim about a mesh,
// not about an op tree — an op-tree assertion passes on a part whose tenons
// hang in the air.

import { describe, it, expect } from 'vitest';

import {
  holeGridCentres,
  holeGridPocket,
  holeGridProblem,
  type HoleGridOptions,
} from '@/engine/compiler/holeGrid';
import {
  buildDividerPegOp,
  buildDividerPegOps,
  dividerPegProblem,
  pegWidth,
  PEG_TENON_BOTTOM_GAP,
  PEG_TENON_FIT,
  PEG_WIDTH_EAR,
  type DividerPegContext,
  type DividerPegSpec,
} from '@/engine/compiler/dividerPegs';
import { circleProfile, pTranslate, rectProfile } from '@/engine/compiler/profile';
import { cube, extrude, intersection, translate, type BuildOp } from '@/engine/compiler/buildPlan';
import { PRINT_FLIP_NODE_IDS, partForId, printMetaForId } from '@/engine/exporters/parts';
import { exec } from './helpers/manifoldExec';

// ToolStack's own measured numbers (/Toolbox.md, "Interface 3 of 3").
const GRID: HoleGridOptions = { pitch: 12, socket: 5, margin: 6 };
const OUTLINE = rectProfile(100, 60);

function volume(op: BuildOp): number {
  const m = exec(op);
  try {
    return m.volume();
  } finally {
    m.delete();
  }
}

function bbox(op: BuildOp): { min: [number, number, number]; max: [number, number, number] } {
  const m = exec(op);
  try {
    const b = m.boundingBox();
    return { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] };
  } finally {
    m.delete();
  }
}

function shells(op: BuildOp): number {
  const m = exec(op);
  try {
    const parts = m.decompose();
    const n = parts.length;
    parts.forEach((p) => p.delete());
    return n;
  } finally {
    m.delete();
  }
}

const PEG: DividerPegSpec = { id: 'p3', spans: 3, height: 20, thickness: 3, enabled: true };
const CTX: DividerPegContext = { grid: { pitch: 12, socket: 5 }, socketDepth: 5 };

describe('#150 — hole grid', () => {
  it('anchors the lattice at the outline bbox, inside the margin', () => {
    const c = holeGridCentres(OUTLINE, GRID);
    // loX = 0 + margin + socket/2 = 8.5; hiX = 100 - 8.5 = 91.5.
    // floor(83 / 12) + 1 = 7 columns; floor(43 / 12) + 1 = 4 rows.
    expect(c).toHaveLength(7 * 4);
    expect(c[0]).toEqual([8.5, 8.5]);
    expect(c[c.length - 1]).toEqual([8.5 + 6 * 12, 8.5 + 3 * 12]);
  });

  it('is stable under an outline change that is not a whole pitch', () => {
    // Bbox-anchoring means growing the outline by a few mm adds sockets at the
    // far edge and leaves every existing one exactly where it was. A centred
    // lattice would shift them all, and a divider printed yesterday would stop
    // fitting the cavity it was made for.
    const before = holeGridCentres(rectProfile(100, 60), GRID);
    const after = holeGridCentres(rectProfile(107, 60), GRID);
    for (const p of before) expect(after).toContainEqual(p);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('cuts real square sockets, one per lattice point', () => {
    const pocket = holeGridPocket(OUTLINE, GRID);
    // 28 sockets x 5 x 5 x 3 deep.
    expect(volume(extrude(pocket, 3))).toBeCloseTo(28 * 5 * 5 * 3, 0);
  });

  it('leaves the keep-out solid — a boss keeps its socket', () => {
    // A Ø8 disc (a boss) over the first socket removes exactly that one: it
    // covers the 5 mm square (half-diagonal 3.54 < 4) and reaches 6.5 mm from
    // the centre, well clear of the neighbours at 12 mm.
    const pocket = holeGridPocket(OUTLINE, {
      ...GRID,
      keepOut: [pTranslate([8.5, 8.5], circleProfile(4))],
    });
    expect(volume(extrude(pocket, 3))).toBeCloseTo(27 * 5 * 5 * 3, 0);
  });

  it('honours a wider margin by dropping sockets, not by shrinking them', () => {
    const pocket = holeGridPocket(OUTLINE, { ...GRID, margin: 20 });
    // loX = 22.5, hiX = 77.5 -> 5 columns; loY = 22.5, hiY = 37.5 -> 2 rows.
    expect(volume(extrude(pocket, 3))).toBeCloseTo(10 * 5 * 5 * 3, 0);
  });

  it('yields nothing at all when the outline is too small for one socket', () => {
    expect(holeGridCentres(rectProfile(8, 8), { ...GRID, margin: 2 })).toEqual([]);
    expect(volume(extrude(holeGridPocket(rectProfile(8, 8), { ...GRID, margin: 2 }), 1)))
      .toBeCloseTo(0, 6);
  });

  it('refuses a pitch that would merge the sockets into slots', () => {
    expect(holeGridProblem({ pitch: 4, socket: 5, margin: 6 })).toMatch(/smaller than/);
    expect(holeGridProblem(GRID)).toBeNull();
  });
});

describe('#150 — divider pegs', () => {
  it('reproduces ToolStack’s three measured peg widths', () => {
    // /Toolbox.md measures 2H = 21.6, 3H = 33.6, 5H = 56.6, all on a 12 mm pitch.
    expect(pegWidth(2, 12)).toBeCloseTo(21.6, 6);
    expect(pegWidth(3, 12)).toBeCloseTo(33.6, 6);
    // The 5H part is 1.0 mm adrift of the same rule on a 56.6 mm hand-
    // measurement — kept as a tolerance rather than averaged into the ear.
    expect(Math.abs(pegWidth(5, 12) - 56.6)).toBeLessThanOrEqual(1.1);
  });

  it('builds one connected shell, wall up and tenons down', () => {
    const op = buildDividerPegOp(PEG, CTX)!;
    expect(shells(op)).toBe(1);
    const b = bbox(op);
    const length = pegWidth(3, 12); // 33.6
    expect(b.min[0]).toBeCloseTo(-length / 2, 6);
    expect(b.max[0]).toBeCloseTo(length / 2, 6);
    // The tenon matches the SOCKET, so on a wall thinner than the socket it
    // stands proud on both faces. The part's Y extent is the wider of the two —
    // deliberately not clamped to the wall, or the peg would rattle.
    const side = CTX.grid.socket - PEG_TENON_FIT;
    expect(b.min[1]).toBeCloseTo(-side / 2, 6);
    expect(b.max[1]).toBeCloseTo(side / 2, 6);
    // Tenon reaches socketDepth - bottomGap below the floor plane, wall rises
    // to `height` above it.
    expect(b.min[2]).toBeCloseTo(-(CTX.socketDepth - PEG_TENON_BOTTOM_GAP), 6);
    expect(b.max[2]).toBeCloseTo(PEG.height, 6);

    // Above the floor plane it is the wall, and only the wall: `thickness` wide.
    const wallSlice = intersection([op, translate([-50, -50, 0.1], cube([100, 100, 0.9]))]);
    const wb = bbox(wallSlice);
    expect(wb.min[1]).toBeCloseTo(-PEG.thickness / 2, 6);
    expect(wb.max[1]).toBeCloseTo(PEG.thickness / 2, 6);
  });

  it('puts a tenon of the right size under each end of the wall', () => {
    const op = buildDividerPegOp(PEG, CTX)!;
    // Slice a 0.9 mm wafer of the tenons, clear of the wall's own bottom face.
    const wafer = intersection([op, translate([-50, -50, -1], cube([100, 100, 0.9]))]);
    const side = CTX.grid.socket - PEG_TENON_FIT;
    expect(volume(wafer)).toBeCloseTo(2 * side * side * 0.9, 1);
    const b = bbox(wafer);
    const halfSpan = (PEG.spans - 1) * CTX.grid.pitch / 2; // 12
    expect(b.min[0]).toBeCloseTo(-halfSpan - side / 2, 6);
    expect(b.max[0]).toBeCloseTo(halfSpan + side / 2, 6);
  });

  it('a one-hole peg is a single tenon under a short wall', () => {
    const one = buildDividerPegOp({ ...PEG, id: 'p1', spans: 1 }, CTX)!;
    expect(shells(one)).toBe(1);
    const b = bbox(one);
    expect(b.max[0] - b.min[0]).toBeCloseTo(2 * PEG_WIDTH_EAR, 6);
    const wafer = intersection([one, translate([-50, -50, -1], cube([100, 100, 0.9]))]);
    expect(shells(wafer)).toBe(1);
  });

  it('refuses specs that cannot make a peg', () => {
    expect(buildDividerPegOp({ ...PEG, spans: 0 }, CTX)).toBeNull();
    expect(buildDividerPegOp({ ...PEG, height: 0 }, CTX)).toBeNull();
    expect(dividerPegProblem({ ...PEG, thickness: 0 }, CTX)).toMatch(/thickness/);
    // A fit as wide as the socket leaves no tenon.
    expect(dividerPegProblem(PEG, { ...CTX, tenonFit: 5 })).toMatch(/no tenon/);
    // A socket shallower than the bottom gap leaves nothing engaging.
    expect(dividerPegProblem(PEG, { ...CTX, socketDepth: 0.3 })).toMatch(/engage/);
  });

  it('emits one node per enabled, buildable peg', () => {
    const nodes = buildDividerPegOps(
      [
        { id: 'a', spans: 2, height: 15, thickness: 3, enabled: true },
        { id: 'b', spans: 2, height: 15, thickness: 3, enabled: false },
        { id: 'bad', spans: 0, height: 15, thickness: 3, enabled: true },
      ],
      CTX,
    );
    expect(nodes.map((n) => n.id)).toEqual(['divider-peg-a']);
  });

  it('is a first-class part to the export path', () => {
    const part = partForId('divider-peg-a', 0);
    expect(part.displayName).toBe('Divider peg a');
    expect(part.category).toBe('accessory');
    // It prints on its side (see the table's entry), and it is NOT a flipped id
    // — the flip list is derived from `flipForPrint`, and a peg would land on
    // its wall face either way.
    expect(printMetaForId('divider-peg-a').rotation).toEqual([90, 0, 0]);
    expect(PRINT_FLIP_NODE_IDS).not.toContain('divider-peg-a');
  });
});
