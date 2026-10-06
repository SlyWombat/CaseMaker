// Issue #158 — the parametric tool-insert holder archetype.
//
// The layout assertions are pure (no wasm): where a pocket lands is a function
// of the parameters, and a divider-printing mistake here is a plate whose
// pockets run off an edge. The geometry assertions run the production
// evaluator, because "one plate, this big, with metal removed" is a claim
// about a mesh — an op-tree assertion passes on a plate with no pockets cut.

import { describe, it, expect } from 'vitest';

import {
  buildInsertOp,
  buildInsertNodes,
  defaultInsert,
  insertGrid,
  insertLayout,
  insertProblem,
  pocketRadius,
} from '@/engine/compiler/insert';
import { cube, intersection, translate, type BuildOp } from '@/engine/compiler/buildPlan';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { PRINT_FLIP_NODE_IDS, partForId, printMetaForId } from '@/engine/exporters/parts';
import { createDefaultProject } from '@/store/projectStore';
import { serializeProject, parseProject } from '@/store/persistence';
import { exec } from './helpers/manifoldExec';

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

const HALF_D = 5.125; // (10 + 0.25 clearance) / 2 — the default pocket's radius

describe('#158 — insert layout (pure)', () => {
  it('lays the one default pocket at the plate centre', () => {
    const layout = insertLayout(defaultInsert());
    expect(layout).toHaveLength(1);
    // 120 × 80 plate → centre (60, 40).
    expect(layout[0]!.cx).toBeCloseTo(60, 6);
    expect(layout[0]!.cy).toBeCloseTo(40, 6);
  });

  it('fits an 8 × 5 grid of Ø10 pockets on the default plate', () => {
    // pitch = 10.25 + 3 = 13.25; margin = 4 + 5.125 + 3 = 12.125.
    // usableW = 120 − 24.25 = 95.75 → ⌊95.75 / 13.25⌋ + 1 = 8.
    // usableD =  80 − 24.25 = 55.75 → ⌊55.75 / 13.25⌋ + 1 = 5.
    const g = insertGrid(defaultInsert());
    expect(g.cols).toBe(8);
    expect(g.rows).toBe(5);
    expect(g.pitch).toBeCloseTo(13.25, 6);
  });

  it('centres the used grid, so a part-full row stays symmetric', () => {
    const insert = {
      ...defaultInsert(),
      items: [0, 1, 2, 3].map((k) => ({ id: `i${k}`, shape: 'round' as const, size: 10, depth: 5 })),
    };
    const layout = insertLayout(insert);
    expect(layout).toHaveLength(4);
    // One row of four, centred: the middle of the run is the plate centre.
    expect((layout[0]!.cx + layout[3]!.cx) / 2).toBeCloseTo(60, 6);
    expect(layout.every((p) => p.cy === layout[0]!.cy)).toBe(true);
    expect(layout[0]!.cy).toBeCloseTo(40, 6);
  });

  it('spaces a hex pocket by its circumradius, not its half across-flats', () => {
    // Across-flats 6.35 → circumradius 6.35 / √3 = 3.666, wider than 3.175.
    const r = pocketRadius({ id: 'h', shape: 'hex', size: 6.35, depth: 4 }, 0);
    expect(r).toBeCloseTo(6.35 / Math.sqrt(3), 6);
    expect(r).toBeGreaterThan(6.35 / 2);
  });

  it('refuses a plate that cannot hold one pocket', () => {
    expect(insertProblem({ ...defaultInsert(), width: 20 })).toMatch(/too narrow/);
    expect(insertProblem({ ...defaultInsert(), items: [] })).toMatch(/at least one pocket/);
    expect(insertProblem({ ...defaultInsert(), width: 0 })).toMatch(/width/);
  });

  it('refuses a pocket deeper than the plate leaves floor', () => {
    const insert = {
      ...defaultInsert(),
      thickness: 6,
      floor: 1.5,
      items: [{ id: 'deep', shape: 'round' as const, size: 5, depth: 5 }],
    };
    // 5 > 6 − 1.5 = 4.5 → no floor.
    expect(insertProblem(insert)).toMatch(/no floor/);
    expect(insertProblem({ ...insert, items: [{ ...insert.items[0]!, depth: 4 }] })).toBeNull();
  });

  it('refuses more pockets than the plate holds', () => {
    const items = Array.from({ length: 41 }, (_, k) => ({
      id: `i${k}`,
      shape: 'round' as const,
      size: 10,
      depth: 4.5,
    }));
    // Capacity is 8 × 5 = 40.
    expect(insertProblem({ ...defaultInsert(), items })).toMatch(/holds 40/);
  });

  it('has a default its own validator accepts', () => {
    // The enable button ships this straight into the panel; a default that
    // trips `insertProblem` greets the user with an error on first click.
    expect(insertProblem(defaultInsert())).toBeNull();
  });
});

describe('#158 — insert geometry (evaluated)', () => {
  it('builds one plate of the stated size', () => {
    const op = buildInsertOp(defaultInsert())!;
    expect(shells(op)).toBe(1);
    const b = bbox(op);
    expect(b.min[0]).toBeCloseTo(0, 6);
    expect(b.min[1]).toBeCloseTo(0, 6);
    expect(b.min[2]).toBeCloseTo(0, 6);
    expect(b.max[0]).toBeCloseTo(120, 6);
    expect(b.max[1]).toBeCloseTo(80, 6);
    expect(b.max[2]).toBeCloseTo(6, 6);
  });

  it('removes a straight bore, and the chamfer widens its mouth', () => {
    const insert = defaultInsert();
    const depth = insert.items[0]!.depth;
    const blank = volume(buildInsertOp({ ...insert, items: [] })!);
    const flat = volume(buildInsertOp({ ...insert, chamfer: 0 })!);
    const flared = volume(buildInsertOp(insert)!);

    // The straight Ø10.25 × depth bore against πr²h.
    const bore = Math.PI * HALF_D * HALF_D * depth;
    expect((blank - flat) / bore).toBeCloseTo(1, 2);
    // The flare removes a little more, and only at the mouth.
    expect(flared).toBeLessThan(flat);

    // Prove the extra cut is at the MOUTH: a 0.3 mm slab inside the flare
    // (thickness − 0.5) is thinner with the chamfer than without, while a slab
    // down in the straight bore below it is identical either way.
    const slab = (z: number) => translate([-1, -1, z], cube([122, 82, 0.3]));
    const flatOp = buildInsertOp({ ...insert, chamfer: 0 })!;
    const flaredOp = buildInsertOp(insert)!;
    const inFlare = (op: BuildOp) => volume(intersection([op, slab(insert.thickness - 0.5)]));
    const inBore = (op: BuildOp) => volume(intersection([op, slab(2)]));
    expect(inFlare(flaredOp)).toBeLessThan(inFlare(flatOp));
    expect(inBore(flaredOp)).toBeCloseTo(inBore(flatOp), 0);
  });

  it('emits exactly one insert-plate node', () => {
    const nodes = buildInsertNodes(defaultInsert());
    expect(nodes?.map((n) => n.id)).toEqual(['insert-plate']);
    expect(buildInsertNodes({ ...defaultInsert(), width: 0 })).toBeNull();
  });

  it('is a first-class part to the export path', () => {
    const part = partForId('insert-plate', 0);
    expect(part.displayName).toBe('Tool insert plate');
    expect(part.category).toBe('case');
    expect(printMetaForId('insert-plate').rotation).toEqual([0, 0, 0]);
    expect(PRINT_FLIP_NODE_IDS).not.toContain('insert-plate');
  });
});

describe('#158 — case.insert through the schema and the compiler', () => {
  it('round-trips — the Zod schema must not strip it', () => {
    const original = createDefaultProject('rpi-4b');
    original.case.insert = defaultInsert();
    const parsed = parseProject(serializeProject(original));
    expect(parsed.schemaVersion).toBe(12);
    expect(parsed.case.insert).toEqual(original.case.insert);
  });

  it('leaves the field undefined when a project has no insert', () => {
    const parsed = parseProject(serializeProject(createDefaultProject('rpi-4b')));
    expect(parsed.schemaVersion).toBe(12);
    expect(parsed.case.insert).toBeUndefined();
  });

  it('an insert project compiles to just the insert-plate node', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.insert = defaultInsert();
    const plan = compileProject(project);
    expect(plan.nodes.map((n) => n.id)).toEqual(['insert-plate']);
  });
});
