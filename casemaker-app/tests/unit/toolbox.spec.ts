import { describe, it, expect } from 'vitest';
import {
  defaultToolboxParams,
  defaultToolboxPeg,
  toolboxParamsProblem,
  TOOLBOX_FIT_CLEAR,
  TOOLBOX_FLOOR_T,
  TOOLBOX_FOOT_CAVITY_INSET,
  TOOLBOX_FOOT_H,
  TOOLBOX_FOOT_INSET,
  TOOLBOX_GRID_DEPTH,
  TOOLBOX_GRID_MARGIN,
  TOOLBOX_LID_H,
  TOOLBOX_MIN_HEIGHT,
  TOOLBOX_MIN_PLAN,
  type ToolboxParams,
} from '@/types';
import {
  buildToolboxModule,
  buildToolboxNodes,
  seatingLedge,
  toolboxGridHoles,
  toolboxPegHeadroom,
  toolboxPegProblem,
  toolboxPegSpanLimit,
  TOOLBOX_BIN_NODE_ID,
  TOOLBOX_LID_NODE_ID,
} from '@/engine/compiler/toolbox';
import { HOLE_GRID_PITCH, HOLE_GRID_SOCKET } from '@/engine/compiler/holeGrid';
import { PEG_WIDTH_EAR } from '@/engine/compiler/dividerPegs';
import { derivedKind } from '@/engine/compiler/archetype';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { parseProject, serializeProject } from '@/store/persistence';
import { createDefaultProject } from '@/store/projectStore';
import { findTemplate } from '@/library/templates';
import { exec } from './helpers/manifoldExec';
import { cube, translate, intersection, union, type BuildOp } from '@/engine/compiler/buildPlan';

/**
 * Issue #155 — the stacking toolbox's geometric contract.
 *
 * These assert PHYSICAL claims rather than restating the builder's constants:
 * that a module is one piece, that a stack actually lands on the ledge, that
 * the foot has sliding clearance against the receiving wall, and that the grid
 * does not cut into the wall. Each is measured through Manifold, so a change
 * to the builder that quietly breaks the mechanism fails here.
 *
 * The face-contact control is not decoration — it is what makes the stack
 * assertion mean anything. `decompose()` reports two solids meeting on a face
 * as one component and two missing each other by 0.001 mm as two, so component
 * count is a genuine contact test rather than a coincidence.
 */

const P = defaultToolboxParams();
/** The smallest height the builder accepts: foot plus the flare above it. */
const MIN_BUILDABLE_H = TOOLBOX_FOOT_H + TOOLBOX_FOOT_INSET;

const bin = (p: ToolboxParams = P) => buildToolboxModule(p, p.height, { grid: p.grid })!;
const lid = (p: ToolboxParams = P) => buildToolboxModule(p, TOOLBOX_LID_H, { grid: false })!;

const solid = (op: BuildOp) => exec(op);
const volume = (op: BuildOp) => exec(op).volume();
/**
 * How many PRINTED PIECES a solid is — i.e. connected components that enclose
 * positive volume.
 *
 * The void filter is load-bearing and was not obvious. `decompose()` reports an
 * ENCLOSED CAVITY as a component with NEGATIVE volume, and closing a bin with
 * its lid makes exactly that: a sealed hollow body. So `bin ∪ lid` decomposes
 * to `[+6.13e6, −5.33e6]` — one piece of material and one pocket of air — and a
 * naive count says two pieces.
 *
 * It only surfaced with #150, because the floor grid used to be THROUGH-holes:
 * a hole through the floor vented the cavity, so the lidded bin was not a
 * closed hollow and the count came out right by accident. Blind sockets seal
 * it, which is the point of them, and the accident stopped holding.
 */
const components = (op: BuildOp) =>
  exec(op)
    .decompose()
    .filter((m) => m.volume() > 0).length;
/** How much of the two solids' volume is shared. */
const overlap = (a: BuildOp, b: BuildOp) => exec(intersection([a, b])).volume();

describe('toolbox module geometry', () => {
  it('is one connected piece, in the frame the header documents', () => {
    for (const [name, op, h] of [
      ['bin', bin(), P.height],
      ['lid', lid(), TOOLBOX_LID_H],
    ] as const) {
      const m = solid(op);
      expect(m.isEmpty(), `${name} is empty`).toBe(false);
      expect(m.status(), `${name} is not a valid solid`).toBe('NoError');
      expect(components(op), `${name} is not one piece`).toBe(1);
      expect(m.volume()).toBeGreaterThan(0);
      const bb = m.boundingBox();
      expect(bb.min[0]).toBeCloseTo(-P.width / 2, 6);
      expect(bb.min[1]).toBeCloseTo(-P.depth / 2, 6);
      // z = 0 is the seating plane AND the print-bed face.
      expect(bb.min[2]).toBeCloseTo(0, 6);
      expect(bb.max[0]).toBeCloseTo(P.width / 2, 6);
      expect(bb.max[1]).toBeCloseTo(P.depth / 2, 6);
      expect(bb.max[2]).toBeCloseTo(h, 6);
    }
  });

  it('keeps the module inside its declared footprint at every ladder height', () => {
    for (const h of [MIN_BUILDABLE_H, 60, 110, 210]) {
      const bb = solid(buildToolboxModule(P, h, { grid: false })!).boundingBox();
      expect(bb.max[0] - bb.min[0]).toBeLessThan(P.width + 1e-6);
      expect(bb.max[1] - bb.min[1]).toBeLessThan(P.depth + 1e-6);
      expect(bb.max[2]).toBeCloseTo(h, 6);
    }
  });

  it('prints as modelled — nothing hangs below the seating plane', () => {
    // The whole reason the registration is a foot rather than a skirt: a
    // feature below z = 0 is a feature on the far side of the bed.
    expect(solid(bin()).boundingBox().min[2]).toBeGreaterThan(-1e-9);
  });

  it('leaves no ledge ring in a module only just taller than its foot', () => {
    // The lid is that case: its floor's top face IS the seating surface.
    expect(seatingLedge(TOOLBOX_LID_H).ring).toBe(false);
    expect(seatingLedge(TOOLBOX_LID_H).z).toBeCloseTo(TOOLBOX_FLOOR_T, 9);
    expect(seatingLedge(P.height).ring).toBe(true);
  });
});

describe('toolbox stack registration', () => {
  it('control: face contact and a 0.001 mm gap are distinguishable', () => {
    const a = cube([10, 10, 10]);
    expect(components(union([a, translate([0, 0, 10], cube([10, 10, 10]))]))).toBe(1);
    expect(components(union([a, translate([0, 0, 10.001], cube([10, 10, 10]))]))).toBe(2);
  });

  it('welds the module above onto the ledge, with no gap', () => {
    const lower = bin();
    const upper = lid();
    const { z } = seatingLedge(P.height);
    expect(z).toBeCloseTo(P.height - TOOLBOX_FOOT_H, 9);

    // Touching, not interpenetrating: the union is one piece and adds no volume.
    const stacked = exec(union([lower, translate([0, 0, z], upper)]));
    // Voids filtered — see `components`. A lidded bin is a sealed hollow, and
    // a sealed hollow is one piece of material.
    expect(stacked.decompose().filter((m) => m.volume() > 0).length).toBe(1);
    expect(stacked.volume()).toBeCloseTo(volume(lower) + volume(upper), 6);

    // The contact is a band, not a knife edge: sinking a thousandth of a
    // millimetre must swallow a measurable area.
    const sunk = overlap(lower, translate([0, 0, z - 0.001], upper));
    const contactArea = sunk / 0.001; // mm²
    expect(contactArea).toBeGreaterThan(2000);
    expect(contactArea).toBeLessThan(20000);

    // ...and lifting by the same thousandth breaks the joint, which is what
    // makes the component count above meaningful.
    expect(components(union([lower, translate([0, 0, z + 0.001], upper)]))).toBe(2);
  });

  it('gives the foot TOOLBOX_FIT_CLEAR of sliding clearance on every side', () => {
    const lower = bin();
    const { z } = seatingLedge(P.height);
    const seatedAt = (dx: number, dy = 0) => translate([dx, dy, z], lid());

    // At exactly the clearance it still drops in, in both directions...
    expect(overlap(lower, seatedAt(TOOLBOX_FIT_CLEAR))).toBeLessThan(1e-4);
    expect(overlap(lower, seatedAt(0, TOOLBOX_FIT_CLEAR))).toBeLessThan(1e-4);
    // ...and one hundredth past it, it hits the receiving wall.
    expect(overlap(lower, seatedAt(TOOLBOX_FIT_CLEAR + 0.01))).toBeGreaterThan(0);
  });
});

describe('toolbox floor grid', () => {
  it('lands on the pitch, symmetric about the module centre', () => {
    const holes = toolboxGridHoles(P.width, P.depth);
    expect(holes.length).toBeGreaterThan(0);
    for (const h of holes) {
      expect(Math.abs(h.x / HOLE_GRID_PITCH - Math.round(h.x / HOLE_GRID_PITCH))).toBeLessThan(1e-9);
      expect(Math.abs(h.y / HOLE_GRID_PITCH - Math.round(h.y / HOLE_GRID_PITCH))).toBeLessThan(1e-9);
    }
    const xs = holes.map((h) => h.x);
    const ys = holes.map((h) => h.y);
    expect(Math.min(...xs)).toBeCloseTo(-Math.max(...xs), 9);
    expect(Math.min(...ys)).toBeCloseTo(-Math.max(...ys), 9);
  });

  it('is ODD in both axes, so the module carries a socket on its centre line', () => {
    // The reason the count is forced odd: two modules of different sizes only
    // share a socket line if both lattices are anchored on their own centres,
    // and an even count has no socket at the centre at all — every socket would
    // sit half a pitch off. `toolboxGridHoles`' doc has the long version.
    // `as const`, not a bare array literal: with `noUncheckedIndexedAccess` the
    // destructured `w`/`d` would be `number | undefined` and the tests project
    // would not typecheck even though vitest, which does not typecheck, is green.
    for (const [w, d] of [
      [300, 200],
      [180, 180],
      [420, 300],
      [140, 260],
    ] as const) {
      const holes = toolboxGridHoles(w, d);
      const xs = [...new Set(holes.map((h) => h.x))];
      const ys = [...new Set(holes.map((h) => h.y))];
      expect(xs.length % 2, `${w} wide gives an even column count`).toBe(1);
      expect(ys.length % 2, `${d} deep gives an even row count`).toBe(1);
      // A socket ON the centre line, at the origin.
      expect(xs.some((x) => Math.abs(x) < 1e-9)).toBe(true);
      expect(ys.some((y) => Math.abs(y) < 1e-9)).toBe(true);
    }
  });

  it('keeps every socket clear of the foot wall', () => {
    // A socket under the wall would leave the wall sitting on a notch.
    const holes = toolboxGridHoles(P.width, P.depth);
    for (const h of holes) {
      expect(Math.abs(h.x) + HOLE_GRID_SOCKET / 2).toBeLessThan(P.width / 2 - TOOLBOX_FOOT_CAVITY_INSET);
      expect(Math.abs(h.y) + HOLE_GRID_SOCKET / 2).toBeLessThan(P.depth / 2 - TOOLBOX_FOOT_CAVITY_INSET);
    }
    expect(TOOLBOX_GRID_MARGIN).toBeGreaterThan(0);
    expect(TOOLBOX_GRID_MARGIN).toBeLessThan(P.width / 2 - TOOLBOX_FOOT_CAVITY_INSET);
  });

  it('drops sockets entirely when the plan is too small to hold one', () => {
    // A centred lattice always finds room for one socket once its half-span is
    // non-negative, so the threshold is the whole inset — margin plus half a
    // socket at each side — not the margin alone.
    const tooNarrow = 2 * TOOLBOX_GRID_MARGIN + HOLE_GRID_SOCKET - 0.01;
    expect(toolboxGridHoles(tooNarrow, 200)).toEqual([]);
    expect(toolboxGridHoles(200, tooNarrow)).toEqual([]);
    // ...and one hair wider, it holds exactly the centre column.
    const justFits = 2 * TOOLBOX_GRID_MARGIN + HOLE_GRID_SOCKET + 0.01;
    expect(new Set(toolboxGridHoles(justFits, 200).map((h) => h.x)).size).toBe(1);
  });

  it('cuts the sockets BLIND — a floor is left under every one of them', () => {
    const withGrid = buildToolboxModule(P, P.height, { grid: true })!;
    const without = buildToolboxModule(P, P.height, { grid: false })!;
    const holes = toolboxGridHoles(P.width, P.depth);
    expect(holes.length).toBeGreaterThan(0);

    // Measure the FLOOR slab alone, so the difference is the sockets and
    // nothing else in the module.
    const floorSlab = translate([-400, -400, 0], cube([800, 800, TOOLBOX_FLOOR_T]));
    const solidFloor = overlap(without, floorSlab);
    const holedFloor = overlap(withGrid, floorSlab);
    const removed = solidFloor - holedFloor;

    // Square sockets, so the arithmetic is exact — no polygon approximation.
    const nominal = holes.length * HOLE_GRID_SOCKET ** 2 * TOOLBOX_GRID_DEPTH;
    expect(removed).toBeGreaterThan(nominal * 0.995);
    expect(removed).toBeLessThan(nominal * 1.005);

    // ...and it is genuinely blind. A through-cut would remove the socket's
    // full footprint to the floor's underside, TOOLBOX_FLOOR_T deep; this is
    // TOOLBOX_GRID_DEPTH of it, and the difference is material a tenon seats
    // on. This is the assertion that would have caught the through-holes the
    // grid shipped as before #150.
    const throughCut = holes.length * HOLE_GRID_SOCKET ** 2 * TOOLBOX_FLOOR_T;
    expect(removed).toBeLessThan(throughCut * 0.9);
    expect(TOOLBOX_GRID_DEPTH).toBeLessThan(TOOLBOX_FLOOR_T);
  });
});

describe('toolbox dividers', () => {
  const withPegs = (pegs: ToolboxParams['pegs'], width = 300, depth = 200) =>
    defaultToolboxParams({ width, depth, pegs });

  /** The peg's own solid, as `buildToolboxNodes` emits it. */
  const pegOp = (n: number, p: ToolboxParams = P) =>
    buildToolboxNodes(p)!.find((node) => node.id === `divider-peg-${n}`)!.op;

  const onePeg = (overrides: Partial<{ spans: number; height: number; axis: 'x' | 'y' }> = {}) => {
    const p = withPegs([
      defaultToolboxPeg('1', overrides.spans ?? 5, overrides.height ?? 40, {
        axis: overrides.axis ?? 'x',
      }),
    ]);
    return { p, op: pegOp(1, p) };
  };

  it('emits one free node per enabled divider, and none for a disabled one', () => {
    const p = defaultToolboxParams({
      pegs: [
        defaultToolboxPeg('1', 5, 40),
        defaultToolboxPeg('2', 3, 40, { axis: 'y', enabled: false }),
        defaultToolboxPeg('3', 7, 60),
      ],
    });
    const nodes = buildToolboxNodes(p)!;
    // The dividers are SEPARATE parts, not fused into the bin: they have to
    // print on their own, as something you drop in afterwards.
    expect(nodes.map((n) => n.id)).toEqual([
      TOOLBOX_BIN_NODE_ID,
      TOOLBOX_LID_NODE_ID,
      'divider-peg-1',
      'divider-peg-3',
    ]);
    for (const node of nodes) {
      const m = solid(node.op);
      expect(m.status(), `${node.id} is not a valid solid`).toBe('NoError');
      expect(m.decompose().length, `${node.id} is not one printed piece`).toBe(1);
      expect(m.volume()).toBeGreaterThan(0);
    }
  });

  it('is one piece when the grid is off, because there is no divider either', () => {
    const p = defaultToolboxParams({ grid: false, pegs: [defaultToolboxPeg('1', 5, 40)] });
    expect(buildToolboxNodes(p)!.map((n) => n.id)).toEqual([
      TOOLBOX_BIN_NODE_ID,
      TOOLBOX_LID_NODE_ID,
    ]);
    expect(toolboxPegProblem(p.pegs![0]!, p)).toMatch(/grid is off/i);
  });

  it('puts every tenon IN a socket — the peg does not stand on the floor', () => {
    // The physical claim the whole feature rests on. The tenons hang below the
    // peg's own z = 0, and the peg is placed at the floor's top face, so an
    // aligned tenon descends into cut-away material and an aligned peg shares
    // NO volume with the bin. A tenon that missed its socket would have to
    // occupy the floor's material, and the overlap would be tenonSide² × reach.
    for (const spans of [1, 2, 3, 5, 8, 11]) {
      for (const axis of ['x', 'y'] as const) {
        for (const [width, depth] of [
          [300, 200],
          [200, 300],
        ]) {
          const p = withPegs(
            [defaultToolboxPeg('1', spans, 40, { axis })],
            width,
            depth,
          );
          if (toolboxPegProblem(p.pegs![0]!, p) !== null) continue;
          const bin = buildToolboxModule(p, p.height, { grid: true })!;
          const feet = overlap(bin, pegOp(1, p));
          expect(feet, `spans ${spans} on ${axis}, ${width}×${depth}`).toBeLessThan(1e-4);
        }
      }
    }
  });

  it('keeps the whole divider inside the cavity, clear of the wall it stands beside', () => {
    // The end of a peg's plate runs `PEG_WIDTH_EAR` past its outer tenon. At
    // floor level the wall it must clear is the FOOT cavity face, not the
    // thinner wall above the flare, so this is the assertion behind the span
    // limit being narrower than the socket count.
    const p = withPegs([defaultToolboxPeg('1', 11, 40)]);
    const bb = solid(pegOp(1, p)).boundingBox();
    for (const [lo, hi, span] of [
      [bb.min[0], bb.max[0], P.width],
      [bb.min[1], bb.max[1], P.depth],
    ] as const) {
      expect(lo).toBeGreaterThan(-span / 2 + TOOLBOX_FOOT_CAVITY_INSET);
      expect(hi).toBeLessThan(span / 2 - TOOLBOX_FOOT_CAVITY_INSET);
    }
  });

  it('turns a depth-running divider a quarter turn, so its wall runs along Y', () => {
    const across = solid(onePeg({ axis: 'x', spans: 5 }).op).boundingBox();
    const along = solid(onePeg({ axis: 'y', spans: 5 }).op).boundingBox();
    // The same wall, measured the other way round.
    expect(across.max[0] - across.min[0]).toBeCloseTo(along.max[1] - along.min[1], 6);
    expect(across.max[1] - across.min[1]).toBeCloseTo(along.max[0] - along.min[0], 6);
    expect(across.max[0] - across.min[0]).toBeGreaterThan(across.max[1] - across.min[1]);
  });

  it('holds a peg of every span the floor allows, and refuses one past it', () => {
    const p = P;
    for (const axis of ['x', 'y'] as const) {
      const limit = toolboxPegSpanLimit(p, axis);
      expect(limit % 2).toBe(1);
      const widest = defaultToolboxPeg('1', limit, 40, { axis });
      expect(toolboxPegProblem(widest, p), `${limit} spans should fit`).toBeNull();
      const past = defaultToolboxPeg('1', limit + 2, 40, { axis });
      expect(toolboxPegProblem(past, p)).toMatch(/runs past/);
      // ...and the builder agrees, by not emitting it.
      const nodes = buildToolboxNodes(withPegs([past], p.width, p.depth))!;
      expect(nodes.map((n) => n.id)).not.toContain('divider-peg-1');
    }
  });

  it('refuses a span that is not a whole number of sockets', () => {
    // Reachable from the panel — the span input steps by one but `2.5` types
    // fine — and the failure is silent without this check: the geometry guard
    // rejects it, the builder drops the node, and nothing is drawn. The panel's
    // predicate has to be the one that says so.
    const half = defaultToolboxPeg('1', 2.5, 40);
    expect(toolboxPegProblem(half, P)).toMatch(/whole number/);
    const nodes = buildToolboxNodes(withPegs([half], P.width, P.depth))!;
    expect(nodes.map((n) => n.id)).not.toContain('divider-peg-1');
    // The neighbouring whole spans still build, so this is not a blanket ban.
    expect(toolboxPegProblem(defaultToolboxPeg('1', 2, 40), P)).toBeNull();
    expect(toolboxPegProblem(defaultToolboxPeg('1', 3, 40), P)).toBeNull();
  });

  it('refuses a divider taller than the bin holds under its ledge', () => {
    const headroom = toolboxPegHeadroom(P);
    expect(headroom).toBeGreaterThan(0);
    const ok = defaultToolboxPeg('1', 5, headroom);
    expect(toolboxPegProblem(ok, P)).toBeNull();
    const tooTall = defaultToolboxPeg('1', 5, headroom + 1);
    expect(toolboxPegProblem(tooTall, P)).toMatch(/seating ledge/);
  });

  it('spans from one socket to the next, and the ear is what makes the wall wider', () => {
    // `spans` is the tenon separation in pitches; the plate runs on by the ear
    // at each end, which is the measured rule `dividerPegs.ts` pins.
    for (const spans of [1, 2, 4, 6]) {
      const bb = solid(onePeg({ spans }).op).boundingBox();
      const length = bb.max[0] - bb.min[0];
      expect(length).toBeCloseTo((spans - 1) * HOLE_GRID_PITCH + 2 * PEG_WIDTH_EAR, 6);
    }
  });

  it('sits a peg of an EVEN span half a pitch off the centre, and no other way', () => {
    // An even span has no position where both tenons are on sockets AND the peg
    // is centred, because the sockets are on whole pitches. It is not a
    // misplacement; `pegPlacement` documents why.
    const odd = solid(onePeg({ spans: 5 }).op).boundingBox();
    const even = solid(onePeg({ spans: 6 }).op).boundingBox();
    expect((odd.min[0] + odd.max[0]) / 2).toBeCloseTo(0, 6);
    expect((even.min[0] + even.max[0]) / 2).toBeCloseTo(HOLE_GRID_PITCH / 2, 6);
  });

  it('carries the dividers through a round trip', () => {
    const project = findTemplate('toolbox')!.build();
    const withDivider = {
      ...project,
      case: {
        ...project.case,
        toolbox: {
          ...project.case.toolbox!,
          pegs: [defaultToolboxPeg('1', 5, 40), defaultToolboxPeg('2', 3, 60, { axis: 'y' })],
        },
      },
    };
    const parsed = parseProject(serializeProject(withDivider));
    // The same strip trap the toolbox itself has: `pegs` needs its own Zod
    // entry or every divider silently disappears on load.
    expect(parsed.case.toolbox!.pegs).toEqual(withDivider.case.toolbox.pegs);
  });
});

describe('toolbox parameters', () => {
  it('reports a reason instead of building when a dimension cannot work', () => {
    const cases: Array<[Partial<ToolboxParams>, RegExp]> = [
      [{ width: 0 }, /width/],
      [{ width: -5 }, /width/],
      [{ depth: 0 }, /depth/],
      [{ height: 0 }, /height/],
      [{ height: TOOLBOX_MIN_HEIGHT - 1 }, /height/],
      [{ width: TOOLBOX_MIN_PLAN - 1 }, /width/],
      [{ depth: TOOLBOX_MIN_PLAN - 1 }, /depth/],
    ];
    for (const [override, re] of cases) {
      const p = defaultToolboxParams(override);
      const problem = toolboxParamsProblem(p);
      expect(problem, `${JSON.stringify(override)} should be refused`).toMatch(re);
      // The predicate IS the guard: a size that reports a reason does not build.
      expect(buildToolboxModule(p, p.height, { grid: false })).toBeNull();
    }
    expect(toolboxParamsProblem(P)).toBeNull();
    expect(buildToolboxModule(P, P.height, { grid: false })).not.toBeNull();
  });

  it('refuses a height with no body left above the foot', () => {
    expect(buildToolboxModule(P, MIN_BUILDABLE_H - 0.1, { grid: false })).toBeNull();
    expect(buildToolboxModule(P, MIN_BUILDABLE_H + 0.1, { grid: false })).not.toBeNull();
  });
});

describe('toolbox archetype wiring', () => {
  /**
   * A project whose case declares exactly the archetype blocks given. The
   * values are the blocks themselves, not booleans: `derivedKind` only reads
   * `.enabled`, but the compiler needs real dimensions, and a test that hands
   * the builder an empty `{ enabled: true }` is testing the fall-through
   * rather than the archetype.
   */
  const declaring = (blocks: Record<string, unknown>) => {
    const p = createDefaultProject('rpi-4b');
    return { ...p, case: { ...p.case, ...blocks } } as typeof p;
  };
  const enabled = (name: string) => ({ [name]: { enabled: true } });

  it('wins over every weaker archetype and loses to rack and stand', () => {
    const on = { toolbox: defaultToolboxParams() };
    expect(derivedKind(declaring(on))).toBe('toolbox');
    expect(derivedKind(declaring({ ...on, ...enabled('badge') }))).toBe('toolbox');
    expect(derivedKind(declaring({ ...on, ...enabled('insert') }))).toBe('toolbox');
    expect(derivedKind(declaring({ ...on, ...enabled('blank') }))).toBe('toolbox');
    expect(derivedKind(declaring({ ...on, ...enabled('stand') }))).toBe('stand');
    expect(derivedKind(declaring({ ...on, ...enabled('rack') }))).toBe('rack');
    expect(derivedKind(declaring({ toolbox: { ...defaultToolboxParams(), enabled: false } }))).toBe(
      'shell',
    );
  });

  it('compiles to exactly the bin and the lid, one solid each', () => {
    const plan = compileProject(declaring({ toolbox: defaultToolboxParams() }));
    expect(plan.nodes.map((n) => n.id)).toEqual([TOOLBOX_BIN_NODE_ID, TOOLBOX_LID_NODE_ID]);
    for (const node of plan.nodes) {
      const m = solid(node.op);
      expect(m.status(), `${node.id} is not a valid solid`).toBe('NoError');
      expect(m.decompose().length, `${node.id} is not one piece`).toBe(1);
      expect(m.volume()).toBeGreaterThan(0);
    }
  });

  it('places the lid ON the bin, not at the origin beside it', () => {
    // The builder's frame is the print frame (`z = 0` is the module's own
    // seating plane), but the COMPILED parts are in assembly space: without
    // this, the lid is emitted at z = 0 and renders buried inside the bin's
    // foot, which is how a toolbox looked before this test existed.
    const plan = compileProject(declaring({ toolbox: defaultToolboxParams() }));
    const bin = plan.nodes.find((n) => n.id === TOOLBOX_BIN_NODE_ID)!.op;
    const lid = plan.nodes.find((n) => n.id === TOOLBOX_LID_NODE_ID)!.op;
    const seatZ = seatingLedge(P.height).z;

    expect(solid(lid).boundingBox().min[2]).toBeCloseTo(seatZ, 6);
    // The assembled pair is one object: the foot meets the ledge over a band,
    // and it must not interpenetrate — a seated lid adds its own volume and
    // nothing else.
    expect(overlap(bin, lid)).toBeLessThan(1e-4);
    const assembled = exec(union([bin, lid]));
    // Voids filtered — see `components`.
    expect(assembled.decompose().filter((m) => m.volume() > 0).length).toBe(1);
    expect(assembled.volume()).toBeCloseTo(volume(bin) + volume(lid), 6);
    // ...and the lid really is the top of the stack.
    expect(assembled.boundingBox().max[2]).toBeCloseTo(seatZ + TOOLBOX_LID_H, 6);
  });

  it('builds both parts from the template, and the template survives a round trip', () => {
    const project = findTemplate('toolbox')!.build();
    const nodes = buildToolboxNodes(project.case.toolbox!);
    expect(nodes?.map((n) => n.id)).toEqual([TOOLBOX_BIN_NODE_ID, TOOLBOX_LID_NODE_ID]);

    const parsed = parseProject(serializeProject(project));
    // The strip trap: a field with no Zod entry vanishes on load.
    expect(parsed.case.toolbox).toEqual(project.case.toolbox);
    expect(parsed.case.toolbox!.enabled).toBe(true);
    expect(derivedKind(parsed)).toBe('toolbox');
  });

  it('does not put a toolbox on a project that never asked for one', () => {
    const parsed = parseProject(serializeProject(createDefaultProject('rpi-4b')));
    expect(parsed.case.toolbox).toBeUndefined();
    expect(derivedKind(parsed)).toBe('shell');
  });
});
