// The shared interior-feature clash check (interiorClash.ts) and the three
// features routed through it: magnet bosses and pockets, the floor grid's
// dividers, and the stacking connector's sockets. Each pair has a real
// overlap, and where the old bounding-box checks over-reached, a near miss
// that the boxes flagged and the real solids clear.

import { describe, it, expect } from 'vitest';
import {
  aabbOfOp,
  cube,
  cylinder,
  difference,
  revolve,
  roundedRectPrism,
  rotate,
  translate,
  type Aabb,
  type BuildOp,
} from '@/engine/compiler/buildPlan';
import { rectProfile } from '@/engine/compiler/profile';
import {
  clashStats,
  featureOfOps,
  interiorClash,
  rectFootprint,
  resetClashCache,
  feature,
} from '@/engine/compiler/interiorClash';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { computeBossPlacements, buildBossesUnion } from '@/engine/compiler/bosses';
import { buildLatchOps } from '@/engine/compiler/latches';
import { buildPortCutoutOp } from '@/engine/compiler/ports';
import { caseDividerFacts, suggestCaseDivider } from '@/engine/compiler/caseDividers';
import { magnetFactsForProject, pocketBossOp, pocketCutter } from '@/engine/compiler/magnets';
import { STACK_PAD_W } from '@/types/stackConnector';
import { createDefaultProject } from '@/store/projectStore';
import { findTemplate } from '@/library/templates';
import { resetSeed } from '@/utils/id';
import type { CaseDivider, MagnetPocket, Project, StackConnectorParams } from '@/types';
import { Manifold, exec } from './helpers/manifoldExec';

const boxesOverlap = (a: Aabb, b: Aabb) => [0, 1, 2].every((k) => a.min[k]! < b.max[k]! && b.min[k]! < a.max[k]!);

const f = (id: string, ...ops: BuildOp[]) => featureOfOps(id, 'other', id, ops);

function stock(): Project {
  resetSeed();
  return createDefaultProject('rpi-4b');
}

function protectiveCase(): Project {
  resetSeed();
  return findTemplate('protective-case')!.build();
}

const withCase = (p: Project, patch: Partial<Project['case']>): Project => ({ ...p, case: { ...p.case, ...patch } });

const pocket = (patch: Partial<MagnetPocket>): MagnetPocket => ({
  id: 'm',
  face: '-z',
  u: 10,
  v: 10,
  size: '6x2',
  enabled: true,
  ...patch,
});

const statements = (p: Project) => compileProject(p).clashes?.statements ?? [];

/** Real Manifold overlap volume of two ops, mm³ — the ground truth for the kernel. */
function overlapVolume(a: BuildOp, b: BuildOp): number {
  const ma = exec(a);
  const mb = exec(b);
  const i = Manifold.intersection([ma, mb]);
  const v = i.volume();
  ma.delete();
  mb.delete();
  i.delete();
  return v;
}

describe('the clash kernel', () => {
  it('measures a real overlap: its size and where it is', () => {
    const hit = interiorClash(f('a', cube([10, 10, 10])), f('b', translate([6, 7, 8], cube([10, 10, 10]))))!;
    expect(hit.method).toBe('solid');
    expect(hit.size[0]).toBeCloseTo(4, 6);
    expect(hit.size[1]).toBeCloseTo(3, 6);
    expect(hit.size[2]).toBeCloseTo(2, 6);
    expect(hit.centre).toEqual([8, 8.5, 9]);
  });

  it('clears a cylinder off a box corner that the bounding boxes say overlaps', () => {
    const block = cube([10, 10, 10]);
    const post = translate([12.5, 12.5, 0], cylinder(10, 3.2, 48));
    expect(boxesOverlap(aabbOfOp(block)!, aabbOfOp(post)!)).toBe(true);
    expect(interiorClash(f('a', block), f('b', post))).toBeNull();
    expect(overlapVolume(block, post)).toBeLessThan(1e-9);
  });

  it('reads a ring as a ring: a block in its hole clears, a block across its wall does not', () => {
    const ring = difference([roundedRectPrism(50, 50, 5, 6), translate([5, 5, -1], roundedRectPrism(40, 40, 7, 3))]);
    const inHole = translate([20, 20, 0], cube([5, 5, 5]));
    const across = translate([2, 20, 1], cube([5, 5, 2]));
    expect(interiorClash(f('r', ring), f('h', inHole))).toBeNull();
    const hit = interiorClash(f('r', ring), f('x', across))!;
    expect(hit.size[0]).toBeCloseTo(3, 6);
    expect(hit.size[2]).toBeCloseTo(2, 6);
    expect(overlapVolume(ring, across)).toBeCloseTo(3 * 5 * 2, 3);
  });

  it('follows rotations: a cylinder turned onto X', () => {
    const rod = translate([0, 5, 5], rotate([0, 90, 0], cylinder(20, 2, 32)));
    const hit = interiorClash(f('rod', rod), f('b', translate([8, 0, 0], cube([4, 10, 10]))))!;
    expect(hit.size[0]).toBeCloseTo(4, 6);
    expect(hit.centre[1]).toBeCloseTo(5, 6);
    expect(hit.centre[2]).toBeCloseTo(5, 6);
  });

  it('agrees with Manifold on a real case pair: the protective brim against a socket pad', async () => {
    const { buildAlignmentFlange } = await import('@/engine/compiler/alignmentFlange');
    const { socketClashOps } = await import('@/engine/compiler/stackConnector');
    const p = protectiveCase();
    const dims = computeShellDims(p.board, p.case, [], () => undefined);
    const brim = buildAlignmentFlange(p.board, p.case).caseAdditive!;
    const [pad] = socketClashOps('-y', 0, dims.outerZ, p.case.wallThickness, dims.outerX, dims.outerY);
    const hit = interiorClash(f('brim', brim), f('pad', pad!))!;
    const ma = exec(brim);
    const mb = exec(pad!);
    const i = Manifold.intersection([ma, mb]);
    const bb = i.boundingBox();
    for (let k = 0; k < 3; k++) {
      expect(hit.min[k]!).toBeCloseTo(bb.min[k]!, 2);
      expect(hit.max[k]!).toBeCloseTo(bb.max[k]!, 2);
    }
    ma.delete();
    mb.delete();
    i.delete();
  });

  it('says which method answered: footprints, real solids, or a stand-in box', () => {
    const a = feature('a', 'divider', 'a', [rectFootprint(0, 0, 10, 2, 0, 20)]);
    const b = feature('b', 'hat', 'b', [rectFootprint(5, -5, 15, 5, 10, 12)]);
    expect(interiorClash(a, b)!.method).toBe('footprint');
    expect(interiorClash(a, f('c', cube([3, 3, 3])))!.method).toBe('solid');
    const turned = revolve(rectProfile(3, 5), 360);
    expect(interiorClash(f('rev', turned), f('d', cube([2, 2, 2])))!.method).toBe('bounds');
  });

  it('a footprint pair needs both the outlines and the Z bands to meet', () => {
    const a = feature('a', 'divider', 'a', [rectFootprint(0, 0, 10, 2, 0, 20)]);
    expect(interiorClash(a, feature('b', 'hat', 'b', [rectFootprint(5, 0, 15, 2, 21, 30)]))).toBeNull();
    expect(interiorClash(a, feature('c', 'hat', 'c', [rectFootprint(10, 0, 15, 2, 0, 20)]))).toBeNull();
  });

  it('caches each shape and each pair, so an unchanged pair is not intersected again', () => {
    resetClashCache();
    const a = f('a', cube([10, 10, 10]));
    const b = f('b', translate([5, 5, 5], cube([10, 10, 10])));
    interiorClash(a, b);
    expect(clashStats.pairsTested).toBe(1);
    interiorClash(f('a', cube([10, 10, 10])), f('b', translate([5, 5, 5], cube([10, 10, 10]))));
    expect(clashStats.pairsTested).toBe(1);
    expect(clashStats.pairsCached).toBe(1);
    expect(clashStats.shapesBuilt).toBe(2);
  });
});

describe('magnet bosses and pockets (the shared check)', () => {
  it('a floor boss on a board standoff is stated with a move that clears it', () => {
    const p = withCase(stock(), { magnetPockets: [pocket({ u: 7.5, v: 7.5 })] });
    const s = statements(p);
    const hit = s.find((c) => c.against === 'standoff')!;
    expect(hit.message).toMatch(/The boss behind a magnet pocket on the bottom face runs into a board standoff \(they overlap [\d.]+ × [\d.]+ × [\d.]+ mm around X 7.5, Y 7.5, Z [\d.]+ mm\)/);
    expect(hit.method).toBe('solid');
    expect(hit.offer?.kind).toBe('move-magnet');
    const o = hit.offer as Extract<typeof hit.offer, { kind: 'move-magnet' }>;
    expect(hit.message).toContain(`Moving the pocket to u ${o.u} mm, v ${o.v} mm clears it.`);
    expect(statements(withCase(stock(), { magnetPockets: [pocket({ u: o.u, v: o.v })] }))).toEqual([]);
  });

  it('a floor boss diagonal to a standoff: the boxes overlap, the solids clear', () => {
    const base = stock();
    const p = withCase(base, { magnetPockets: [pocket({ u: 13, v: 13 })] });
    const facts = magnetFactsForProject(p);
    const boss = pocketBossOp(facts.pockets[0]!)!;
    const standoff = buildBossesUnion(computeBossPlacements(base.board, base.case))[0]!;
    expect(boxesOverlap(aabbOfOp(boss)!, aabbOfOp(standoff)!)).toBe(true);
    expect(statements(p)).toEqual([]);
  });

  it('a side boss on the board, and one rising into the lid', () => {
    const p = stock();
    const dims = computeShellDims(p.board, p.case, [], () => undefined);
    const board = statements(withCase(p, { magnetPockets: [pocket({ face: '-y', u: 6, v: 6, size: '8x3' })] }));
    expect(board.some((c) => c.against === 'board')).toBe(true);
    const lid = statements(withCase(p, { magnetPockets: [pocket({ face: '-x', u: 40, v: dims.outerZ - 3, size: '8x3' })] }));
    const l = lid.find((c) => c.against === 'lid')!;
    expect(l.message).toMatch(/runs into the lid/);
    expect(l.offer?.kind).toBe('move-magnet');
  });

  it('a pocket under a latch block, and a near miss off its corner', () => {
    const p = protectiveCase();
    const latch = buildLatchOps(p.case.latches, p.board, p.case).caseAdditive[0]!;
    const lb = aabbOfOp(latch)!;
    const on = statements(withCase(p, { magnetPockets: [pocket({ face: '-y', u: (lb.min[0] + lb.max[0]) / 2, v: (lb.min[2] + lb.max[2]) / 2 })] }));
    expect(on.some((c) => c.against === 'latch')).toBe(true);
    // Diagonally off the block's upper corner: 0.8 r along each axis, so the
    // pocket's box overlaps the block's and its circle stays clear.
    const r = 6.5 / 2;
    const near = withCase(p, { magnetPockets: [pocket({ face: '-y', u: lb.max[0] + 0.8 * r, v: lb.max[2] + 0.8 * r })] });
    const cut = pocketCutter(magnetFactsForProject(near).pockets[0]!);
    expect(boxesOverlap(aabbOfOp(cut)!, lb)).toBe(true);
    expect(statements(near).filter((c) => c.against === 'latch')).toEqual([]);
  });

  it('a pocket in the hinge on the back wall', () => {
    const p = protectiveCase();
    const dims = computeShellDims(p.board, p.case, [], () => undefined);
    const s = statements(withCase(p, { magnetPockets: [pocket({ face: '+y', u: dims.outerX / 2, v: dims.outerZ - 4, size: '8x3' })] }));
    expect(s.some((c) => c.against === 'hinge' && /runs into the hinge/.test(c.message))).toBe(true);
  });

  it('a pocket and a port, by the real cut shape: a hit, and a near miss off the cutter corner', () => {
    const p = stock();
    const hit = statements(withCase(p, { magnetPockets: [pocket({ face: '+x', u: 21, v: 15 })] }));
    expect(hit.some((c) => c.against === 'port' && /cutout, which is cut through it/.test(c.message))).toBe(true);
    // Every enabled -y port corner, until one leaves room diagonally.
    const r = 6.5 / 2;
    let found = false;
    for (const port of p.ports.filter((x) => x.enabled && x.facing === '-y')) {
      const op = buildPortCutoutOp(port, p.board, p.case);
      if (!op) continue;
      const b = aabbOfOp(op)!;
      for (const [cu, cv, su, sv] of [
        [b.max[0], b.max[2], 1, 1],
        [b.min[0], b.max[2], -1, 1],
      ] as const) {
        const near = withCase(p, { magnetPockets: [pocket({ face: '-y', u: cu + su * 0.8 * r, v: cv + sv * 0.8 * r })] });
        const cut = pocketCutter(magnetFactsForProject(near).pockets[0]!);
        if (!boxesOverlap(aabbOfOp(cut)!, b)) continue;
        if (statements(near).length === 0) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    expect(found, 'a pocket whose box overlaps a port box, cleared by the real shapes').toBe(true);
  });
});

/** A Pi 4B case with a 36 mm bay on its back (+Y) side and the grid on. */
function bay(extra: Partial<Project['case']> = {}): Project {
  return withCase(stock(), {
    floorThickness: 3.2,
    clearanceTweaks: { xMin: 0, xMax: 0, yMin: 0, yMax: 36 },
    floorGrid: { enabled: true, pitch: 12, socket: 5, depth: 2 },
    ...extra,
  });
}

const withDividers = (p: Project, ...ds: Omit<CaseDivider, 'id' | 'enabled'>[]): Project =>
  withCase(p, { dividers: ds.map((d, i) => ({ id: `d${i + 1}`, enabled: true, ...d })) });

describe('dividers (the shared check)', () => {
  it('an end against a snap-fit lid lip is stated, with an offer to shorten that clears it', () => {
    const p = bay({ joint: 'snap-fit', snapType: 'full-lid' });
    const p1 = withDividers(p, suggestCaseDivider(p, 'x'));
    const s = statements(p1);
    const lip = s.find((c) => c.against === 'lid-lip')!;
    expect(lip.message).toMatch(/^Divider 1: it runs into the lid's friction lip \(they overlap .* mm\)\. Shortening it to \d+ sockets, from socket \d+, clears it\.$/);
    expect(lip.offer?.kind).toBe('shorten-divider');
    const o = lip.offer as Extract<typeof lip.offer, { kind: 'shorten-divider' }>;
    const d = p1.case.dividers![0]!;
    expect(statements(withDividers(p, { ...d, start: o.start, holes: o.holes }))).toEqual([]);
    // A flat lid has no lip: the same divider says nothing.
    expect(statements(withDividers(bay(), d))).toEqual([]);
  });

  it('a divider over a bottom vent', () => {
    const p = bay({ ventilation: { enabled: true, pattern: 'slots', coverage: 0.9, surfaces: ['bottom'] } });
    const s = statements(withDividers(p, suggestCaseDivider(p, 'x')));
    const v = s.find((c) => c.against === 'vent')!;
    expect(v.message).toMatch(/runs into a bottom vent/);
    expect(v.method).toBe('solid');
  });

  it('a HAT board beyond the host, by footprint; a divider clear of it says nothing', () => {
    const p = bay({});
    const hatted: Project = {
      ...p,
      hats: [{ id: 'h', hatId: 'rpi-sense-hat', stackIndex: 0, ports: [], enabled: true, offsetOverride: { x: 0, y: 30 } }],
    };
    const facts = caseDividerFacts(hatted);
    const rows = [...new Set(facts.sockets.map((k) => k.row))].sort((a, b) => a - b);
    const cols = [...new Set(facts.sockets.map((k) => k.col))].sort((a, b) => a - b);
    const under = statements(withDividers(hatted, { axis: 'x', line: rows[0]!, start: cols[0]!, holes: 2 }));
    const h = under.find((c) => c.against === 'hat')!;
    expect(h.message).toMatch(/runs into the Raspberry Pi Sense HAT board/);
    expect(h.method).toBe('footprint');
    // The far end of the bay is past the HAT's edge.
    const clear = statements(withDividers(hatted, { axis: 'y', line: cols[cols.length - 1]!, start: rows[0]!, holes: 2 }));
    expect(clear.filter((c) => c.against === 'hat')).toEqual([]);
  });

  it('a divider across the split-for-print seam, with a shorter span that clears it', () => {
    const p: Project = {
      ...bay({ clearanceTweaks: { xMin: 0, xMax: 80, yMin: 0, yMax: 36 }, splitForPrint: true }),
      printer: { x: 130, y: 130, z: 200 },
    };
    const s = statements(withDividers(p, suggestCaseDivider(p, 'x')));
    const seam = s.find((c) => c.against === 'seam')!;
    expect(seam.message).toMatch(/runs into the split-for-print seam at X [\d.]+ mm/);
    expect(seam.offer?.kind).toBe('shorten-divider');
    // Not asked to split: no seam, nothing to say.
    expect(statements(withDividers({ ...p, case: { ...p.case, splitForPrint: false } }, suggestCaseDivider(p, 'x')))).toEqual([]);
  });

  it('placement order does not decide whether two dividers fit (two-row bay)', () => {
    const p = bay();
    const f0 = caseDividerFacts(p);
    expect(new Set(f0.sockets.map((k) => k.row)).size).toBe(2);
    for (const [first, second] of [
      ['x', 'y'],
      ['y', 'x'],
    ] as const) {
      const a = suggestCaseDivider(p, first);
      const pa = withDividers(p, a);
      const b = suggestCaseDivider(pa, second);
      const both = caseDividerFacts(withDividers(p, a, b));
      expect(both.dividers.flatMap((d) => d.clashes), `${first} then ${second}`).toEqual([]);
    }
  });

  it('a full-length divider already standing: the new one is offered room by shortening the first', () => {
    const p = bay();
    const f0 = caseDividerFacts(p);
    const rows = [...new Set(f0.sockets.map((k) => k.row))].sort((a, b) => a - b);
    const cols = [...new Set(f0.sockets.map((k) => k.col))].sort((a, b) => a - b);
    const full = { axis: 'x' as const, line: rows[0]!, start: cols[0]!, holes: cols.length };
    const pa = withDividers(p, full);
    const b = suggestCaseDivider(pa, 'y');
    const f = caseDividerFacts(withDividers(p, full, b));
    const later = f.dividers[1]!;
    expect(later.clashes.join(' ')).toMatch(/crosses Divider 1/);
    expect(later.makeRoom).not.toBeNull();
    const room = later.makeRoom!;
    expect(room.id).toBe('d1');
    const after = caseDividerFacts(withDividers(p, { ...full, start: room.start, holes: room.holes }, b));
    expect(after.dividers.flatMap((d) => d.clashes)).toEqual([]);
  });
});

const connector = (sockets: StackConnectorParams['sockets']): StackConnectorParams => ({ sockets, key: 'short', keys: 0 });

describe('connector sockets (the shared check)', () => {
  it('a socket over a magnet pocket in the wall is stated', () => {
    const p = stock();
    const dims = computeShellDims(p.board, p.case, [], () => undefined);
    const plan = compileProject(
      withCase(p, {
        stackConnector: connector([{ face: '+y', offset: 0 }]),
        magnetPockets: [pocket({ face: '+y', u: dims.outerX / 2, v: 10 })],
      }),
    );
    const clash = plan.connector!.notes.find((n) => n.kind === 'clash')!;
    expect(clash.message).toMatch(/back socket at 0 mm runs into a magnet pocket/);
    expect(clash.suggestedOffset).toBeDefined();
  });

  it('a floor pocket by the wall: the old box (to the inner wall face) flagged it, the real pad clears it', () => {
    const p = stock();
    const dims = computeShellDims(p.board, { ...p.case, floorThickness: 4 }, [], () => undefined);
    // Pocket edge 0.5 mm inside the wall's footprint, outside the pad's embed (half the wall).
    const r = 6.5 / 2;
    const v = dims.outerY - p.case.wallThickness - r + 0.5;
    // A 4 mm floor holds the pocket without a boss (a boss this close to the
    // wall would poke out through it, which is a real clash).
    const q = withCase(p, {
      floorThickness: 4,
      stackConnector: connector([{ face: '+y', offset: 0 }]),
      magnetPockets: [pocket({ face: '-z', u: dims.outerX / 2, v })],
    });
    const plan = compileProject(q);
    const facts = magnetFactsForProject(q);
    const cut = aabbOfOp(pocketCutter(facts.pockets[0]!))!;
    expect(cut.max[1]).toBeGreaterThan(dims.outerY - p.case.wallThickness);
    expect(cut.max[1]).toBeLessThan(dims.outerY - p.case.wallThickness / 2);
    expect(plan.connector!.notes.filter((n) => n.kind === 'clash')).toEqual([]);
  });

  it('a socket under the nameplate is stated', () => {
    const p = stock();
    const dims = computeShellDims(p.board, p.case, [], () => undefined);
    const plan = compileProject(
      withCase(p, {
        stackConnector: connector([{ face: '-y', offset: 0 }]),
        nameplate: {
          enabled: true,
          face: '-y',
          u: dims.outerX / 2,
          v: dims.outerZ / 2,
          width: 40,
          height: 14,
          thickness: 3,
          text: '',
          textSize: 6,
          textDepth: 0.6,
          textMode: 'emboss',
          magnetSize: '6x2',
          magnetCount: 2,
        },
      }),
    );
    expect(plan.connector!.notes.find((n) => n.kind === 'clash')!.message).toMatch(/runs into .*the nameplate/);
  });

  it('never meets the floor grid: the grid keeps 3 mm off the wall and the pad stops half-way into it', () => {
    const plan = compileProject(
      bay({ stackConnector: connector([{ face: '+y', offset: 0 }, { face: '-x', offset: 0 }]) }),
    );
    expect(plan.connector!.notes.filter((n) => /floor grid/.test(n.message))).toEqual([]);
  });

  it('a socket on a port by the real cut shape, with a move that clears it', () => {
    const plan = compileProject(withCase(stock(), { stackConnector: connector([{ face: '-x', offset: 0 }]) }));
    const clash = plan.connector!.notes.find((n) => n.kind === 'clash')!;
    expect(clash.message).toMatch(/runs into a port cutout/);
    expect(clash.method).toBe('solid');
    const moved = compileProject(
      withCase(stock(), { stackConnector: connector([{ face: '-x', offset: clash.suggestedOffset! }]) }),
    );
    expect(moved.connector!.notes.filter((n) => n.kind === 'clash')).toEqual([]);
  });
});

describe('the protective case: a pad cut-out through the brim and ribbing', () => {
  const sockets = connector([
    { face: '-x', offset: 0 },
    { face: '-y', offset: 0 },
  ]);

  it('offers a pad cut-out where the brim or ribbing blocks every position, not "no position"', () => {
    const plan = compileProject(withCase(protectiveCase(), { stackConnector: sockets }));
    for (const face of ['-x', '-y'] as const) {
      const n = plan.connector!.notes.find((x) => x.kind === 'clash' && x.face === face)!;
      expect(n.padCutout, face).toBe(true);
      expect(n.suggestedOffset, face).toBe(0);
      expect(n.message).toMatch(/Every position along this wall runs into the alignment brim/);
      expect(n.message).toContain(`pad cut-out through`);
      expect(n.message).toContain(`${STACK_PAD_W + 1} mm wide, makes room for the socket.`);
      expect(n.message).not.toMatch(/No position/);
    }
  });

  it('taking the offer notches the brim and ribbing only, and the clash is gone', () => {
    const base = withCase(protectiveCase(), { stackConnector: sockets });
    const before = compileProject(base);
    const cut = withCase(base, {
      stackConnector: { ...sockets, sockets: sockets.sockets.map((s) => ({ ...s, cutThrough: true })) },
    });
    const plan = compileProject(cut);
    expect(plan.connector!.notes.filter((n) => n.kind === 'clash')).toEqual([]);
    expect(plan.connector!.notes.filter((n) => n.kind === 'pad-cutout')).toHaveLength(2);
    // Same parts, and the shell is still one body.
    expect(plan.nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
    const shell = exec(plan.nodes.find((n) => n.id === 'shell')!.op);
    const parts = shell.decompose().filter((m) => m.volume() > 0);
    expect(parts).toHaveLength(1);
    shell.delete();
  }, 120_000);

  it('a socket that asks for no cut-out leaves the brim alone', () => {
    const a = compileProject(withCase(protectiveCase(), { stackConnector: sockets }));
    const b = compileProject(
      withCase(protectiveCase(), {
        stackConnector: { ...sockets, sockets: sockets.sockets.map((s) => ({ ...s, cutThrough: false })) },
      }),
    );
    expect(JSON.stringify(a.nodes)).toBe(JSON.stringify(b.nodes));
  });
});

describe('speed', () => {
  // The compile runs on every slider move; the clash pass must leave it room.
  // Stated budget, on the feature-heaviest template with every feature on:
  //   - cold (empty caches, first compile):   under 100 ms of clash work
  //   - warm (a socket slider moved 0.5 mm):  under 25 ms of clash work
  const COLD_MS = 100;
  const WARM_MS = 25;

  function busy(offset: number): Project {
    const p = protectiveCase();
    const dims = computeShellDims(p.board, p.case, [], () => undefined);
    return withCase(p, {
      stackConnector: connector([
        { face: '-x', offset },
        { face: '+x', offset: 0 },
        { face: '-y', offset: 0 },
        { face: '+y', offset: 0 },
      ]),
      magnetPockets: [pocket({ face: '-z', u: dims.outerX / 2, v: dims.outerY / 2, count: 3 })],
      floorGrid: { enabled: true, pitch: 12, socket: 5, depth: 2 },
      dividers: [
        { id: 'a', axis: 'x', line: 2, start: 0, holes: 4, enabled: true },
        { id: 'b', axis: 'y', line: 6, start: 0, holes: 3, enabled: true },
      ],
    });
  }

  /** Clash work = the compile with the features, less the same compile without the checks' features. */
  function time(p: Project, n = 1): number {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      compileProject(p);
      best = Math.min(best, performance.now() - t);
    }
    return best;
  }

  it(`the clash pass on the protective case stays under ${COLD_MS} ms cold and ${WARM_MS} ms warm`, () => {
    // Warm the JIT on an unrelated case first, so the cold number is the
    // caches', not the engine's.
    time(withCase(stock(), { magnetPockets: [pocket({})] }), 3);
    const bare = time(protectiveCase(), 5);
    resetClashCache();
    const cold = time(busy(0)) - bare;
    const warm = time(busy(0.5), 1) - bare;
    console.info(`clash pass on the protective case: cold ${cold.toFixed(1)} ms, warm ${warm.toFixed(1)} ms`);
    expect(cold, `cold ${cold.toFixed(1)} ms`).toBeLessThan(COLD_MS);
    expect(warm, `warm ${warm.toFixed(1)} ms`).toBeLessThan(WARM_MS);
  });
});
