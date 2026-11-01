// Issue #150 — the case-floor host: a blind socket grid in a board case's
// floor, and drop-in dividers that plug into it.
//
// What these guard:
//   • the grid's sockets sit inside the cavity (rounded corners included) and
//     clear of the board, its overhanging parts, the standoffs and any boss
//   • a divider is sized to the cavity: its length is the peg rule, its height
//     the inside height less the stated top clearance, and the built part stays
//     under the lid
//   • the peg-in-socket fit at every rung of the #153 ladder, as numbers and as
//     meshes (the tenon sits inside the socket, touching nothing)
//   • each divider exports as its own part and lies flat on the bed
//   • the schema round-trips the new fields
//   • a project without dividers compiles to the same plan and the same meshes

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

import {
  DIVIDER_THICKNESS,
  DIVIDER_TOP_CLEARANCE,
  GRID_FLOOR_UNDER,
  GRID_KEEPOUT_GAP,
  GRID_WALL_MARGIN,
  boardFootprint,
  buildCaseDividerOps,
  caseDividerFacts,
  caseDividerNodeId,
  suggestCaseDivider,
} from '@/engine/compiler/caseDividers';
import { PEG_TENON_BOTTOM_GAP, PEG_TENON_FIT, pegWidth } from '@/engine/compiler/dividerPegs';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { computeLidDims } from '@/engine/compiler/lid';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { aabbOfOp, type BuildOp } from '@/engine/compiler/buildPlan';
import { computePartTransforms, applyPartTransform } from '@/engine/exportLayout';
import { partForId } from '@/engine/exporters/parts';
import { createDefaultProject } from '@/store/projectStore';
import { serializeProject, parseProject } from '@/store/projectFile';
import { FIT_RELIEF_MM, FIT_VARIANTS, type CaseDivider, type MeshNode, type Project } from '@/types';
import { Manifold, exec } from './helpers/manifoldExec';

/** A Pi 4B case with a 36 mm bay on its back (+Y) side — the side with no
 *  ports — and the grid on, with the floor thick enough for full sockets. */
function bayProject(extra: Partial<Project['case']> = {}): Project {
  const p = createDefaultProject('rpi-4b');
  return {
    ...p,
    case: {
      ...p.case,
      floorThickness: 3.2,
      clearanceTweaks: { xMin: 0, xMax: 0, yMin: 0, yMax: 36 },
      floorGrid: { enabled: true, pitch: 12, socket: 5, depth: 2 },
      ...extra,
    },
  };
}

const div = (id: string, axis: 'x' | 'y', line: number, start: number, holes: number): CaseDivider => ({
  id,
  axis,
  line,
  start,
  holes,
  thickness: DIVIDER_THICKNESS,
  enabled: true,
});

describe('the floor grid', () => {
  it('places sockets only inside the cavity and clear of the board, its standoffs and bosses', () => {
    const p = bayProject();
    const f = caseDividerFacts(p);
    const dims = computeShellDims(p.board, p.case, [], () => undefined);
    const w = p.case.wallThickness;
    const foot = boardFootprint(p.board, p.case);
    expect(f.sockets.length).toBeGreaterThanOrEqual(4);
    expect(f.blocked, 'the lattice under the board is left out').toBeGreaterThan(0);
    const half = f.socketCut / 2;
    for (const s of f.sockets) {
      expect(s.x - half).toBeGreaterThanOrEqual(w + GRID_WALL_MARGIN - 1e-9);
      expect(s.x + half).toBeLessThanOrEqual(w + dims.cavityX - GRID_WALL_MARGIN + 1e-9);
      expect(s.y - half).toBeGreaterThanOrEqual(w + GRID_WALL_MARGIN - 1e-9);
      expect(s.y + half).toBeLessThanOrEqual(w + dims.cavityY - GRID_WALL_MARGIN + 1e-9);
      // Clear of the board footprint (PCB plus the RJ45 overhang) by the gap.
      expect(s.y - half, `socket ${s.col},${s.row} is in the bay`).toBeGreaterThanOrEqual(foot.y1 + GRID_KEEPOUT_GAP - 1e-9);
    }
    // The lattice is on pitch from the cavity corner.
    expect(f.columns[0]).toBeCloseTo(w + GRID_WALL_MARGIN + 2.5, 9);
    expect(f.columns[1]! - f.columns[0]!).toBeCloseTo(12, 9);
  });

  it('drops a socket that would touch a standoff, even outside the board', () => {
    const p = bayProject();
    const ref = caseDividerFacts(p);
    const target = ref.sockets[0]!;
    // A synthetic mounting hole out in the bay, right under a socket.
    const o = { x: p.case.wallThickness + p.case.internalClearance, y: p.case.wallThickness + p.case.internalClearance };
    const board = {
      ...p.board,
      mountingHoles: [...p.board.mountingHoles, { id: 'bay', x: target.x - o.x, y: target.y - o.y + 4, diameter: 2.7 }],
    };
    const f = caseDividerFacts({ ...p, board });
    expect(f.sockets.find((s) => s.col === target.col && s.row === target.row)).toBeUndefined();
    expect(f.sockets.length).toBe(ref.sockets.length - 1);
  });

  it('keeps corner sockets inside a rounded cavity', () => {
    const p = bayProject({ cornerRadius: 14 });
    const f = caseDividerFacts(p);
    const sharp = caseDividerFacts(bayProject({ cornerRadius: 0 }));
    expect(f.sockets.length, 'the rounded corners cost sockets').toBeLessThan(sharp.sockets.length);
  });

  it('says why a stock case has no sockets, and offers a port-free side to widen', () => {
    const p = createDefaultProject('rpi-4b');
    const f = caseDividerFacts({ ...p, case: { ...p.case, floorGrid: { enabled: true, pitch: 12, socket: 5, depth: 2 } } });
    expect(f.sockets).toEqual([]);
    expect(f.notes.join(' ')).toMatch(/No socket fits/);
    expect(f.notes.join(' ')).toMatch(/2 mm floor/);
    // The Pi 4B has ports on -X, +X and -Y: +Y is the only clear side.
    expect(f.widen?.side).toBe('yMax');
    expect(f.widen!.by).toBeGreaterThan(0);
    // Taking the offer gives a bay two sockets each way.
    const t = { xMin: 0, xMax: 0, yMin: 0, yMax: f.widen!.by };
    const g = caseDividerFacts({ ...p, case: { ...p.case, floorThickness: 3.2, clearanceTweaks: t, floorGrid: p.case.floorGrid ?? { enabled: true, pitch: 12, socket: 5, depth: 2 } } });
    expect(new Set(g.sockets.map((s) => s.row)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(g.sockets.map((s) => s.col)).size).toBeGreaterThanOrEqual(2);
  });

  it('caps the depth to leave 1.2 mm of floor, and says so', () => {
    const f = caseDividerFacts(bayProject({ floorThickness: 2.8 }));
    expect(f.depth).toBeCloseTo(2.8 - GRID_FLOOR_UNDER, 9);
    expect(f.floorNeeded).toBeCloseTo(3.2, 9);
    expect(f.notes.join(' ')).toMatch(/cut 1\.6 mm deep, not 2 mm/);
  });
});

describe('divider size against the cavity', () => {
  it('is the peg rule long and the inside height less the top clearance tall', () => {
    const p = bayProject({ dividers: [div('a', 'x', 7, 0, 4)] });
    const f = caseDividerFacts(p);
    const dims = computeShellDims(p.board, p.case, [], () => undefined);
    const d = f.dividers[0]!;
    expect(d.clashes).toEqual([]);
    expect(d.length).toBeCloseTo(pegWidth(4, 12), 9);
    expect(d.height).toBeCloseTo(dims.cavityZ - DIVIDER_TOP_CLEARANCE, 9);
    const node = compileProject(p).nodes.find((n) => n.id === caseDividerNodeId({ id: 'a', axis: 'x' }))!;
    const b = aabbOfOp(node.op)!;
    const lid = computeLidDims(p.board, p.case);
    expect(b.max[2]).toBeCloseTo(p.case.floorThickness + d.height, 6);
    expect(lid.zPosition - b.max[2], 'clear of the lid').toBeGreaterThanOrEqual(DIVIDER_TOP_CLEARANCE - 1e-6);
    expect(b.min[2]).toBeCloseTo(p.case.floorThickness - (2 - PEG_TENON_BOTTOM_GAP), 6);
    expect(b.max[0] - b.min[0]).toBeCloseTo(d.length, 6);
  });

  it('states a divider that runs into the board, and offers the nearest clear row', () => {
    const p = bayProject({ dividers: [div('a', 'x', 3, 0, 3)] });
    const d = caseDividerFacts(p).dividers[0]!;
    expect(d.clashes.join(' ')).toMatch(/Divider 1: it runs into the board from X \d/);
    expect(d.moveTo).not.toBeNull();
    const moved = caseDividerFacts(bayProject({ dividers: [div('a', 'x', d.moveTo!, 0, 3)] })).dividers[0]!;
    expect(moved.clashes).toEqual([]);
    // Inform, don't refuse: the clashing divider still exports.
    expect(compileProject(p).nodes.some((n) => n.id.startsWith('case-divider-'))).toBe(true);
  });

  it('states two dividers that cross', () => {
    const p = bayProject();
    const f0 = caseDividerFacts(p);
    const rows = [...new Set(f0.sockets.map((s) => s.row))].sort((a, b) => a - b);
    const cols = [...new Set(f0.sockets.map((s) => s.col))].sort((a, b) => a - b);
    const f = caseDividerFacts(
      bayProject({ dividers: [div('a', 'x', rows[0]!, cols[0]!, 3), div('b', 'y', cols[1]!, rows[0]!, 2)] }),
    );
    expect(f.dividers[1]!.clashes.join(' ')).toMatch(/crosses Divider 1/);
  });

  it('suggests a clean placement for a new divider each way', () => {
    for (const axis of ['x', 'y'] as const) {
      const at = suggestCaseDivider(bayProject(), axis);
      const f = caseDividerFacts(bayProject({ dividers: [{ id: 'n', enabled: true, ...at }] }));
      expect(f.dividers[0]!.clashes, axis).toEqual([]);
    }
  });
});

describe('peg and socket fit', () => {
  for (const fit of FIT_VARIANTS) {
    it(`${fit}: the socket takes the relief and the tenon seats without touching`, () => {
      const p = bayProject({ fit, dividers: [div('a', 'x', 7, 0, 2)] });
      const f = caseDividerFacts(p);
      expect(f.fit).toBe(fit);
      expect(f.dividers[0]!.clashes).toEqual([]);
      expect(f.socketCut).toBeCloseTo(5 + FIT_RELIEF_MM[fit], 9);
      expect(f.tenon).toBeCloseTo(5 - PEG_TENON_FIT, 9);
      expect(f.clearance).toBeCloseTo(PEG_TENON_FIT + FIT_RELIEF_MM[fit], 9);

      const plan = compileProject(p);
      const shell = exec(plan.nodes.find((n) => n.id === 'shell')!.op);
      const peg = exec(plan.nodes.find((n) => n.id.startsWith('case-divider-'))!.op);
      try {
        const both = Manifold.intersection([shell, peg]);
        expect(both.volume(), 'the divider interferes with nothing in the shell').toBeLessThan(1e-6);
        both.delete();
        // Each tenon sits in its socket: the tenon's volume below the floor top
        // equals two tenons' worth.
        const below = Manifold.cube([1000, 1000, 10]).translate([-500, -500, p.case.floorThickness - 10]);
        const tenons = Manifold.intersection([peg, below]);
        const reach = 2 - PEG_TENON_BOTTOM_GAP;
        expect(tenons.volume()).toBeCloseTo(2 * f.tenon * f.tenon * reach, 3);
        tenons.delete();
        below.delete();
      } finally {
        shell.delete();
        peg.delete();
      }
    });
  }

  it('the grid fit overrides the case fit', () => {
    const f = caseDividerFacts(bayProject({ fit: 'tight', floorGrid: { enabled: true, pitch: 12, socket: 5, depth: 2, fit: 'loose' } }));
    expect(f.fit).toBe('loose');
    expect(f.fitSource).toBe('grid');
    expect(f.clearance).toBeCloseTo(0.55, 9);
  });
});

describe('the exported parts', () => {
  it('each divider is its own accessory part and lies flat', () => {
    const p = bayProject({ dividers: [div('a', 'x', 7, 0, 3), div('b', 'y', 1, 6, 2)] });
    const plan = compileProject(p);
    const ids = plan.nodes.map((n) => n.id).filter((id) => id.startsWith('case-divider-'));
    expect(ids).toEqual(['case-divider-x-a', 'case-divider-y-b']);
    for (const id of ids) {
      expect(partForId(id).category).toBe('accessory');
      const m = exec(plan.nodes.find((n) => n.id === id)!.op);
      expect(m.decompose().length, `${id} is one body`).toBe(1);
      const mesh = m.getMesh();
      m.delete();
      const positions = new Float32Array(mesh.vertProperties);
      const node = { id, buffer: { positions, indices: mesh.triVerts } } as unknown as MeshNode;
      const t = computePartTransforms([node]).get(id)!;
      const laid = applyPartTransform(positions, t);
      let zMin = Infinity;
      let zMax = -Infinity;
      for (let i = 2; i < laid.length; i += 3) {
        zMin = Math.min(zMin, laid[i]!);
        zMax = Math.max(zMax, laid[i]!);
      }
      // On its side the part is as tall as the tenon (4.7 mm), centred on the
      // 2.4 mm wall; the wall's face is on the bed.
      expect(zMin, `${id} on the bed`).toBeCloseTo(0, 4);
      expect(zMax - zMin, `${id} lies on its side`).toBeCloseTo(5 - PEG_TENON_FIT, 3);
    }
  });

  it('the shell carries the blind sockets and stays one closed body', () => {
    const p = bayProject();
    const f = caseDividerFacts(p);
    const withGrid = exec(compileProject(p).nodes.find((n) => n.id === 'shell')!.op);
    const without = exec(
      compileProject({ ...p, case: { ...p.case, floorGrid: { ...p.case.floorGrid!, enabled: false } } }).nodes.find(
        (n) => n.id === 'shell',
      )!.op,
    );
    try {
      expect(withGrid.decompose().length).toBe(1);
      expect(without.volume() - withGrid.volume()).toBeCloseTo(f.sockets.length * f.socketCut ** 2 * f.depth, 1);
      expect(withGrid.genus(), 'blind sockets add no through-holes').toBe(without.genus());
    } finally {
      withGrid.delete();
      without.delete();
    }
  });
});

describe('schema', () => {
  it('round-trips the grid and the dividers', () => {
    const p = bayProject({
      floorGrid: { enabled: true, pitch: 12, socket: 5, depth: 2, fit: 'standard' },
      dividers: [div('a', 'x', 7, 0, 3), { ...div('b', 'y', 1, 6, 2), enabled: false }],
    });
    const back = parseProject(serializeProject(p));
    expect(back.case.floorGrid).toEqual(p.case.floorGrid);
    expect(back.case.dividers).toEqual(p.case.dividers);
  });

  it('a project saved without them reads back without them', () => {
    const p = createDefaultProject('rpi-4b');
    const back = parseProject(serializeProject(p));
    expect(back.case.floorGrid).toBeUndefined();
    expect(back.case.dividers).toBeUndefined();
  });
});

describe('a project without dividers is unchanged', () => {
  const BOARDS = ['rpi-4b', 'arduino-uno-r3', 'esp32-devkit-v1'];
  const json = (p: Project) => JSON.stringify(compileProject(p).nodes);
  const hashMesh = (op: BuildOp) => {
    const m = exec(op);
    try {
      const mesh = m.getMesh();
      return createHash('sha256')
        .update(Buffer.from(new Float32Array(mesh.vertProperties).buffer))
        .update(Buffer.from(new Uint32Array(mesh.triVerts).buffer))
        .digest('hex');
    } finally {
      m.delete();
    }
  };

  for (const id of BOARDS) {
    it(`${id}: the same plan whether the fields are absent, off or empty, and the same meshes`, () => {
      const base = createDefaultProject(id);
      const ref = json(base);
      const off = { ...base, case: { ...base.case, floorGrid: { enabled: false, pitch: 12, socket: 5, depth: 2 }, dividers: [div('a', 'x', 0, 0, 2)] } };
      expect(json({ ...base, case: { ...base.case, dividers: [] } })).toBe(ref);
      expect(json(off)).toBe(ref);
      expect(buildCaseDividerOps(base)).toEqual({ floorCut: [], nodes: [] });
      const a = compileProject(base).nodes;
      const b = compileProject(off).nodes;
      expect(b.map((n) => n.id)).toEqual(a.map((n) => n.id));
      for (const n of a.filter((x) => x.id === 'shell' || x.id === 'lid')) {
        expect(hashMesh(b.find((x) => x.id === n.id)!.op), `${id} ${n.id}`).toBe(hashMesh(n.op));
      }
    });
  }
});
