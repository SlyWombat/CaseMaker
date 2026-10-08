import { describe, it, expect } from 'vitest';
import {
  defaultToolboxParams,
  toolboxParamsProblem,
  TOOLBOX_FIT_CLEAR,
  TOOLBOX_FLOOR_T,
  TOOLBOX_FOOT_CAVITY_INSET,
  TOOLBOX_FOOT_H,
  TOOLBOX_FOOT_INSET,
  TOOLBOX_GRID_HOLE,
  TOOLBOX_GRID_MARGIN,
  TOOLBOX_GRID_PITCH,
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
  TOOLBOX_BIN_NODE_ID,
  TOOLBOX_LID_NODE_ID,
} from '@/engine/compiler/toolbox';
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
const components = (op: BuildOp) => exec(op).decompose().length;
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
      expect(m.decompose().length, `${name} is not one piece`).toBe(1);
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
    expect(stacked.decompose().length).toBe(1);
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
      expect(Math.abs(h.x / TOOLBOX_GRID_PITCH - Math.round(h.x / TOOLBOX_GRID_PITCH))).toBeLessThan(1e-9);
      expect(Math.abs(h.y / TOOLBOX_GRID_PITCH - Math.round(h.y / TOOLBOX_GRID_PITCH))).toBeLessThan(1e-9);
    }
    const xs = holes.map((h) => h.x);
    const ys = holes.map((h) => h.y);
    expect(Math.min(...xs)).toBeCloseTo(-Math.max(...xs), 9);
    expect(Math.min(...ys)).toBeCloseTo(-Math.max(...ys), 9);
  });

  it('keeps every hole clear of the foot wall', () => {
    // A hole under the wall would leave the wall sitting on a notch.
    const holes = toolboxGridHoles(P.width, P.depth);
    for (const h of holes) {
      expect(Math.abs(h.x) + TOOLBOX_GRID_HOLE / 2).toBeLessThan(P.width / 2 - TOOLBOX_FOOT_CAVITY_INSET);
      expect(Math.abs(h.y) + TOOLBOX_GRID_HOLE / 2).toBeLessThan(P.depth / 2 - TOOLBOX_FOOT_CAVITY_INSET);
    }
    expect(TOOLBOX_GRID_MARGIN).toBeGreaterThan(TOOLBOX_FOOT_CAVITY_INSET);
  });

  it('drops holes entirely when the plan is too small to hold one', () => {
    expect(toolboxGridHoles(2 * TOOLBOX_GRID_MARGIN - 1, 200)).toEqual([]);
    expect(toolboxGridHoles(200, 2 * TOOLBOX_GRID_MARGIN - 1)).toEqual([]);
  });

  it('removes exactly the holes it claims to, through the full floor', () => {
    const withGrid = buildToolboxModule(P, P.height, { grid: true })!;
    const without = buildToolboxModule(P, P.height, { grid: false })!;
    const holes = toolboxGridHoles(P.width, P.depth);
    expect(holes.length).toBeGreaterThan(0);

    // Measure the FLOOR slab alone, so the difference is the holes and nothing
    // else in the module.
    const floorSlab = translate([-400, -400, 0], cube([800, 800, TOOLBOX_FLOOR_T]));
    const solidFloor = overlap(without, floorSlab);
    const holedFloor = overlap(withGrid, floorSlab);
    const removed = solidFloor - holedFloor;
    const nominal = holes.length * Math.PI * (TOOLBOX_GRID_HOLE / 2) ** 2 * TOOLBOX_FLOOR_T;
    // A polygon approximation of a circle is slightly small, never large.
    expect(removed).toBeLessThan(nominal);
    expect(removed).toBeGreaterThan(nominal * 0.9);
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
    expect(assembled.decompose().length).toBe(1);
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
