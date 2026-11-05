/**
 * #966 — OPEN GOAL MESHES. The everyday import is a surface, not a solid: a relief sheet with a
 * boundary and nothing under it. `planModelCam`'s tree is built from a Manifold solid, so an open
 * goal used to die at the kernel as a bare "Not manifold". `closeOpenSheet` welds, finds the
 * boundary and — for ONE sheet whose loops are disjoint in projection — adds the skirt to the
 * stock bottom and the bottom cap; anything else is refused by name with its count and reason.
 *
 * Pins: the open sheet is CUT (here and through the goal path in `camModelSeam966.spec.ts`'s dome);
 * a mesh this rule cannot close is refused by name, never by a kernel stack trace.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { closeOpenSheet, UnclosableOpenMeshError } from '@/engine/cnc/engrave/closeSheet';
import { buildModelPlanInputForGoal } from '@/workers/sim/engraveGenerate';
import { planModelCam } from '@/engine/cnc/cam/model/plan';
import { recogniseFeatures } from '@/engine/cnc/cam/model/features';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { buildBinaryStl } from '@/workers/export/stlBinary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { ParsedMesh } from '@/engine/import/stlParser';

/** An open terrain sheet: an n × n grid, up-facing, z noisy so no facet is axis-aligned. */
function sheetMesh(n: number, sizeMm: number, seed = 0x9e3779b9, offsetX = 0): { positions: Float32Array; indices: Uint32Array } {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const positions = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = 3 * (j * n + i);
      positions[k] = (i / (n - 1)) * sizeMm + offsetX;
      positions[k + 1] = (j / (n - 1)) * sizeMm;
      positions[k + 2] = rnd() * 0.8;
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }
  return { positions, indices: Uint32Array.from(indices) };
}

function parsedOf(mesh: { positions: Float32Array; indices: Uint32Array }): ParsedMesh {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i]!, y = mesh.positions[i + 1]!, z = mesh.positions[i + 2]!;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  return { positions: mesh.positions, indices: mesh.indices, triangleCount: mesh.indices.length / 3, bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } };
}

/** The kernel's own check, the one `solidOf` runs — the closure must pass it. */
function manifoldAccepts(mesh: ParsedMesh): { ok: boolean; reason: string } {
  const mm = new tl.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices });
  mm.merge();
  try {
    const solid = new tl.Manifold(mm);
    solid.delete();
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

const BOTTOM_Z = -10;

describe('#966 an open goal mesh is closed with a skirt before the manifold check', () => {
  it('a single open sheet is closed down to the stock bottom and passes the kernel check', () => {
    const mesh = parsedOf(sheetMesh(12, 20));
    expect(manifoldAccepts(mesh).ok, 'the fixture really is open').toBe(false);
    const closed = closeOpenSheet(tl, mesh, { bottomZ: BOTTOM_Z });
    expect(closed.note).toContain('skirt');
    expect(closed.note).toContain('1 boundary loop');
    expect(closed.mesh.bbox.min[2]).toBeCloseTo(BOTTOM_Z, 5);
    const check = manifoldAccepts(closed.mesh);
    expect(check.ok, check.reason).toBe(true);
  });

  it('an already-closed mesh is returned unchanged (the panther, a closed import)', () => {
    const cube = tl.Manifold.cube([10, 10, 10]);
    const m = cube.getMesh();
    const positions = new Float32Array((m.vertProperties.length / m.numProp) * 3);
    for (let v = 0; v < positions.length / 3; v++) {
      positions[3 * v] = m.vertProperties[v * m.numProp]!;
      positions[3 * v + 1] = m.vertProperties[v * m.numProp + 1]!;
      positions[3 * v + 2] = m.vertProperties[v * m.numProp + 2]!;
    }
    cube.delete();
    const mesh = parsedOf({ positions, indices: Uint32Array.from(m.triVerts) });
    const closed = closeOpenSheet(tl, mesh, { bottomZ: BOTTOM_Z });
    expect(closed.note).toContain('already closed');
    expect(closed.mesh).toBe(mesh);
  });

  it('two disconnected sheets are refused by name, with the count', () => {
    const a = sheetMesh(6, 10, 0x1234567);
    const b = sheetMesh(6, 10, 0x89abcdef, 20);
    const positions = new Float32Array(a.positions.length + b.positions.length);
    positions.set(a.positions, 0);
    positions.set(b.positions, a.positions.length);
    const offset = a.positions.length / 3;
    const indices = Uint32Array.from([...a.indices, ...Array.from(b.indices, (v) => v + offset)]);
    const mesh = parsedOf({ positions, indices });
    let caught: unknown = null;
    try {
      closeOpenSheet(tl, mesh, { bottomZ: BOTTOM_Z });
    } catch (err) {
      caught = err;
    }
    expect(caught, 'the fixture must be refused').toBeInstanceOf(UnclosableOpenMeshError);
    const message = (caught as Error).message;
    expect(message).toContain('goal-mesh-unclosable');
    expect(message).toContain('2 disconnected sheet components');
  });

  it('the goal path closes the sheet: buildModelPlanInputForGoal hands the engine a closed mesh', async () => {
    const sheet = sheetMesh(12, 20);
    const stl = buildBinaryStl([{ positions: sheet.positions, indices: sheet.indices }]);
    const goal: EngraveTargetObject = {
      id: 'goal-open-966',
      name: 'relief-sheet.stl',
      format: 'stl',
      sha256: 'a'.repeat(64),
      data: Buffer.from(stl).toString('base64'),
      size: { x: 20, y: 20, z: 0.8 },
      position: { x: 15, y: 10, z: 0 },
      rotation: 0,
      enabled: true,
      role: 'goal',
    };
    const BALL: Tool = flatEndMill(2, { number: 1, id: 'ball-2', name: 'ball-2', shape: 'ball', typeText: 'Ball Nose' });
    const FLAT: Tool = flatEndMill(3, { number: 2, id: 'flat-3', name: 'flat-3' });
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      stock: { ...defaultEngraveJob().stock, length: 30, width: 20, thickness: 10 },
      targetObject: goal,
    };
    const input = await buildModelPlanInputForGoal(job, goal, BALL, {
      tools: [
        { key: 'inv:ball-2', tool: { ...BALL, number: null }, provenance: 'test fixture' },
        { key: 'inv:flat-3', tool: { ...FLAT, number: null }, provenance: 'test fixture' },
      ],
    });
    const geometry = { positions: input.geometry.triangles.positions, indices: input.geometry.triangles.indices, triangleCount: input.geometry.triangles.triangleCount, bbox: input.geometry.triangles.bbox };
    // #966 — the goal path closes a sheet to its OWN lowest boundary (a relief), not the stock
    // bottom (−10): the closed solid is exactly as deep as the imported surface.
    expect(geometry.bbox.min[2]).toBeGreaterThan(-1);
    expect(geometry.bbox.min[2]).toBeLessThan(-0.2);
    const check = manifoldAccepts(geometry);
    expect(check.ok, `the geometry handed to planModelCam is still open: ${check.reason}`).toBe(true);
  });

  it('RED-FIRST #966: an open sheet closed by the repair is a RELIEF — no freeing contour, no cut below it', async () => {
    const sheet = sheetMesh(12, 20);
    const stl = buildBinaryStl([{ positions: sheet.positions, indices: sheet.indices }]);
    const goal: EngraveTargetObject = {
      id: 'goal-relief-966',
      name: 'relief-sheet.stl',
      format: 'stl',
      sha256: 'b'.repeat(64),
      data: Buffer.from(stl).toString('base64'),
      size: { x: 20, y: 20, z: 0.8 },
      position: { x: 15, y: 10, z: 0 },
      rotation: 0,
      enabled: true,
      role: 'goal',
    };
    const BALL: Tool = flatEndMill(2, { number: 1, id: 'ball-2', name: 'ball-2', shape: 'ball', typeText: 'Ball Nose' });
    const FLAT: Tool = flatEndMill(3, { number: 2, id: 'flat-3', name: 'flat-3' });
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      stock: { ...defaultEngraveJob().stock, length: 30, width: 20, thickness: 10 },
      targetObject: goal,
    };
    const shop = {
      tools: [
        { key: 'inv:ball-2', tool: { ...BALL, number: null }, provenance: 'test fixture' },
        { key: 'inv:flat-3', tool: { ...FLAT, number: null }, provenance: 'test fixture' },
      ],
    };
    const input = await buildModelPlanInputForGoal(job, goal, BALL, shop);
    // The tree reads the RELIEF: its part bottom is the sheet's own boundary, not the stock bottom.
    const tree = recogniseFeatures({ triangles: input.geometry.triangles }, input.setups[0]!.frame, tl);
    expect(tree.contour.frees, 'the relief was classified as a through-part (a freeing contour)').toBe(false);
    // And no move goes below the sheet's own lowest vertex.
    let minVertexZ = Infinity;
    for (let i = 2; i < input.geometry.triangles.positions.length; i += 3) minVertexZ = Math.min(minVertexZ, input.geometry.triangles.positions[i]!);
    const output = await planModelCam(input);
    let minMoveZ = Infinity;
    for (const setupPlan of output.perSetup) {
      for (const ir of setupPlan.programs) {
        for (const op of ir.operations) {
          for (const m of op.moves) minMoveZ = Math.min(minMoveZ, m.z);
        }
      }
    }
    expect(minMoveZ, `a move cut below the sheet's lowest vertex (${minVertexZ} mm)`).toBeGreaterThanOrEqual(minVertexZ - 0.01);
  }, 120_000);
});
