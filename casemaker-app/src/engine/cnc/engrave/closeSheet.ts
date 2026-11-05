/**
 * #966 — AN OPEN GOAL MESH CLOSES WITH A SKIRT BEFORE THE MANIFOLD CHECK.
 *
 * The everyday user goal is an STL/3MF that is a SURFACE, not a solid: a heightfield relief sheet
 * with a boundary and nothing under it. `planModelCam` builds its feature tree from a Manifold
 * solid (`buildTree` → `solidOf`), so such a goal was refused with the kernel's bare
 * "Not manifold" — no statement of what was open or why it could not be cut.
 *
 * This module closes the case the everyday import actually is: ONE open sheet whose boundary loops
 * project to XY WITHOUT overlapping (no nesting, no crossing). Every boundary edge gets a vertical
 * skirt down to the stock bottom, and the sheet's projected outline becomes a flat bottom cap
 * there — the sheet + skirt + cap is a closed solid whose top is the imported surface. Anything
 * else is refused BY NAME, with the count that decided it: several disconnected sheets, a
 * non-manifold edge, boundary vertices that do not form loops, loops whose projections overlap, or
 * a closed mesh the kernel still refuses.
 *
 * (1) The vertex weld is already there, one layer down: `solidOf` (`features/tree.ts`) builds a
 * `Manifold.Mesh` and calls `merge()` before `new tl.Manifold(mm)`. This module welds on the same
 * tolerance so its own boundary analysis sees the same seams; the kernel keeps its check.
 *
 * ONE FUNCTION, TWO CALLERS: the goal path (`buildModelPlanInputForGoal`) today, and #980's PNG
 * relief when it turns sampled heights into a solid.
 */
import type { ParsedMesh } from '@/engine/import/stlParser';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';

type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;
type CrossSectionInstance = InstanceType<ManifoldToplevel['CrossSection']>;
type MeshInstance = InstanceType<ManifoldToplevel['Mesh']>;

/** A goal mesh that is open and cannot be closed by the skirt rule. The message carries the code,
 * the count and the reason — callers surface it verbatim (#966: a named refusal, never a kernel
 * stack trace). */
export class UnclosableOpenMeshError extends Error {
  readonly code = 'goal-mesh-unclosable';
  constructor(reason: string) {
    super(`goal-mesh-unclosable: ${reason}`);
    this.name = 'UnclosableOpenMeshError';
  }
}

export interface CloseOpenSheetOptions {
  /** The stock's bottom face in the goal mesh's own frame, mm — the skirt's floor. */
  bottomZ: number;
  /** Vertex weld distance for the boundary analysis (the same order `solidOf`'s merge uses). */
  weldMm?: number;
}

export interface CloseOpenSheetResult {
  /** The closed mesh; the INPUT ITSELF when it was already closed. */
  mesh: ParsedMesh;
  /** One sentence for the plan's notes: what was added, or that nothing was. */
  note: string;
}

interface EdgeUse {
  /** The two welded vertex ids, `from` → `to` as the triangle winds them. */
  from: number;
  to: number;
  /** How many triangles use this undirected edge. */
  count: number;
}

/** The closure (#966). Throws {@link UnclosableOpenMeshError} when the mesh is open and the skirt
 * rule does not apply; returns the input unchanged when it is already closed. */
export function closeOpenSheet(tl: ManifoldToplevel, mesh: ParsedMesh, opts: CloseOpenSheetOptions): CloseOpenSheetResult {
  const weld = opts.weldMm ?? 1e-4;
  const positions = mesh.positions;
  const indices = mesh.indices;
  const triCount = indices.length / 3;

  // Weld by position so the boundary analysis sees the seams `solidOf`'s merge will weld.
  const idOf = new Map<string, number>();
  const welded = new Int32Array(indices.length);
  const weldedPos: number[] = [];
  for (let v = 0; v < indices.length; v++) {
    const i = indices[v]! * 3;
    const key = `${Math.round(positions[i]! / weld)}:${Math.round(positions[i + 1]! / weld)}:${Math.round(positions[i + 2]! / weld)}`;
    let id = idOf.get(key);
    if (id === undefined) {
      id = weldedPos.length / 3;
      idOf.set(key, id);
      weldedPos.push(positions[i]!, positions[i + 1]!, positions[i + 2]!);
    }
    welded[v] = id;
  }

  // Degenerate triangles (a pole of a polar tessellation collapses two vertices onto one) are
  // dropped before the boundary analysis: they carry no surface and would fake non-manifold edges.
  const kept: number[] = [];
  let degenerate = 0;
  for (let t = 0; t < triCount; t++) {
    const a = welded[3 * t]!, b = welded[3 * t + 1]!, c = welded[3 * t + 2]!;
    if (a === b || b === c || a === c) { degenerate++; continue; }
    kept.push(t);
  }
  const edges = new Map<string, EdgeUse>();
  const edgeKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
  let signedArea2 = 0;
  for (const t of kept) {
    const a = welded[3 * t]!, b = welded[3 * t + 1]!, c = welded[3 * t + 2]!;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const key = edgeKey(u, v);
      const use = edges.get(key);
      if (use === undefined) edges.set(key, { from: u, to: v, count: 1 });
      else use.count++;
    }
    // The XY projection's signed area: its sign is the sheet's facing (+ up).
    const pa = 3 * a, pb = 3 * b, pc = 3 * c;
    signedArea2 += (weldedPos[pb]! - weldedPos[pa]!) * (weldedPos[pc + 1]! - weldedPos[pa + 1]!)
      - (weldedPos[pc]! - weldedPos[pa]!) * (weldedPos[pb + 1]! - weldedPos[pa + 1]!);
  }
  const boundary: EdgeUse[] = [];
  let overused = 0;
  for (const use of edges.values()) {
    if (use.count === 1) boundary.push(use);
    else if (use.count > 2) overused++;
  }
  if (overused > 0) throw new UnclosableOpenMeshError(`${overused} edge(s) shared by more than two triangles — the mesh is not a surface`);
  if (boundary.length === 0) {
    return { mesh, note: 'the goal mesh is already closed' };
  }
  if (!(signedArea2 > 0)) {
    throw new UnclosableOpenMeshError(
      `the open sheet faces down (its triangles' XY projection is negative) — a top-setup part's surface must face up`,
    );
  }

  // Edge-connected components: an open goal must be ONE sheet.
  const parent = new Int32Array(triCount);
  for (let t = 0; t < triCount; t++) parent[t] = t;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) { const n = parent[x]!; parent[x] = r; x = n; }
    return r;
  };
  const triOfEdge = new Map<string, number>();
  for (const t of kept) {
    const a = welded[3 * t]!, b = welded[3 * t + 1]!, c = welded[3 * t + 2]!;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const key = edgeKey(u, v);
      const first = triOfEdge.get(key);
      if (first === undefined) triOfEdge.set(key, t);
      else {
        const ra = find(first), rb = find(t);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  }
  const roots = new Set<number>();
  for (const t of kept) roots.add(find(t));
  if (roots.size > 1) throw new UnclosableOpenMeshError(`${roots.size} disconnected sheet components — only a single open sheet can be closed`);

  // Boundary loops: each boundary vertex must have exactly one outgoing and one incoming edge.
  const out = new Map<number, EdgeUse>();
  const inCount = new Map<number, number>();
  for (const use of boundary) {
    if (out.has(use.from)) {
      throw new UnclosableOpenMeshError(`a boundary vertex at (${weldedPos[3 * use.from]!.toFixed(2)}, ${weldedPos[3 * use.from + 1]!.toFixed(2)}) has more than one outgoing boundary edge — the boundary is not a set of simple loops`);
    }
    out.set(use.from, use);
    inCount.set(use.to, (inCount.get(use.to) ?? 0) + 1);
  }
  for (const n of inCount.values()) {
    if (n !== 1) throw new UnclosableOpenMeshError(`${n} incoming boundary edges at one vertex — the boundary is not a set of simple loops`);
  }
  const loops: EdgeUse[][] = [];
  const seen = new Set<EdgeUse>();
  for (const start of boundary) {
    if (seen.has(start)) continue;
    const loop: EdgeUse[] = [];
    let edge: EdgeUse | undefined = start;
    while (edge !== undefined && !seen.has(edge)) {
      seen.add(edge);
      loop.push(edge);
      edge = out.get(edge.to);
      if (edge === start) edge = undefined;
    }
    const closed = loop.length > 0 && out.get(loop[loop.length - 1]!.to) === start;
    if (!closed) throw new UnclosableOpenMeshError('a boundary walk did not return to its start — the boundary is not a closed loop');
    loops.push(loop);
  }

  // The projected loops must not overlap in XY: build the cap region and require its area to be
  // exactly the loops' own summed area (a nested or crossing pair would lose area to the union).
  const loopsXY: [number, number][][] = loops.map((loop) => loop.map((edge) => [weldedPos[3 * edge.from]!, weldedPos[3 * edge.from + 1]!] as [number, number]));
  let loopArea = 0;
  for (const ring of loopsXY) {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i]!;
      const [x1, y1] = ring[(i + 1) % ring.length]!;
      a += x0 * y1 - x1 * y0;
    }
    loopArea += Math.abs(a) / 2;
  }
  const capTriangles: [number, number, number][][] = [];
  {
    let cs: CrossSectionInstance | null = null;
    let solid: ManifoldInstance | null = null;
    try {
      cs = tl.CrossSection.ofPolygons(loopsXY, 'EvenOdd');
      const area = cs.area();
      if (Math.abs(area - loopArea) > Math.max(1e-6, 1e-4 * loopArea)) {
        throw new UnclosableOpenMeshError(
          `${loops.length} boundary loop(s) overlap in XY (the projected region is ${area.toFixed(3)} mm², the loops' own sum ${loopArea.toFixed(3)} mm²) — only a sheet whose loops are disjoint in projection can be closed`,
        );
      }
      // Extrude the region by 1 mm and lift its BOTTOM cap (the solid's down-facing z = 0 faces):
      // the kernel's own triangulation, holes and non-convex outlines included.
      solid = tl.Manifold.extrude(cs, 1);
      const cap = solid.getMesh();
      for (let t = 0; t < cap.triVerts.length / 3; t++) {
        const ids = [cap.triVerts[3 * t]!, cap.triVerts[3 * t + 1]!, cap.triVerts[3 * t + 2]!];
        const zs = ids.map((id) => cap.vertProperties[id * cap.numProp + 2]!);
        if (zs.every((z) => Math.abs(z) <= 1e-5)) {
          capTriangles.push(
            ids.map((id) => [cap.vertProperties[id * cap.numProp]!, cap.vertProperties[id * cap.numProp + 1]!, opts.bottomZ] as [number, number, number]),
          );
        }
      }
      if (capTriangles.length === 0) throw new UnclosableOpenMeshError('the projected outline yielded no bottom cap — the region could not be triangulated');
    } catch (err) {
      if (err instanceof UnclosableOpenMeshError) throw err;
      throw new UnclosableOpenMeshError(`the projected outline could not be turned into a bottom cap (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      solid?.delete();
      cs?.delete();
    }
  }

  // Assemble: the sheet, the skirt, the cap.
  const newPositions = Array.from(positions);
  const newIndices: number[] = [];
  for (const t of kept) newIndices.push(indices[3 * t]!, indices[3 * t + 1]!, indices[3 * t + 2]!);
  let skirtTriangles = 0;
  const addVertex = (x: number, y: number, z: number): number => {
    const id = newPositions.length / 3;
    newPositions.push(x, y, z);
    return id;
  };
  for (const loop of loops) {
    for (const edge of loop) {
      const ax = weldedPos[3 * edge.from]!, ay = weldedPos[3 * edge.from + 1]!;
      const bx = weldedPos[3 * edge.to]!, by = weldedPos[3 * edge.to + 1]!;
      const a = addVertex(ax, ay, weldedPos[3 * edge.from + 2]!);
      const ad = addVertex(ax, ay, opts.bottomZ);
      const bd = addVertex(bx, by, opts.bottomZ);
      const b = addVertex(bx, by, weldedPos[3 * edge.to + 2]!);
      // Outward-facing skirt for an edge whose interior is on its left (the sheet's own winding).
      newIndices.push(a, ad, bd, a, bd, b);
      skirtTriangles += 2;
    }
  }
  for (const triangle of capTriangles) {
    const ids = triangle.map(([x, y, z]) => addVertex(x, y, z));
    newIndices.push(ids[0]!, ids[1]!, ids[2]!);
  }

  const outPositions = new Float32Array(newPositions);
  const outIndices = Uint32Array.from(newIndices);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < outPositions.length; i += 3) {
    const x = outPositions[i]!, y = outPositions[i + 1]!, z = outPositions[i + 2]!;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const closed: ParsedMesh = {
    positions: outPositions,
    indices: outIndices,
    triangleCount: outIndices.length / 3,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };

  // THE KERNEL KEEPS ITS CHECK — the same one `solidOf` will run. Weld first (`merge`), as there.
  {
    let mm: MeshInstance | null = null;
    let solid: ManifoldInstance | null = null;
    try {
      mm = new tl.Mesh({ numProp: 3, vertProperties: outPositions, triVerts: outIndices });
      mm.merge();
      solid = new tl.Manifold(mm);
    } catch (err) {
      throw new UnclosableOpenMeshError(`the closed sheet still fails the manifold check (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      solid?.delete();
    }
  }

  return {
    mesh: closed,
    note:
      `the open goal sheet was closed with a skirt: ${loops.length} boundary loop(s), ` +
      `${skirtTriangles} skirt triangle(s) down to the stock bottom at ${opts.bottomZ} mm and ` +
      `${capTriangles.length} bottom-cap triangle(s)` +
      (degenerate > 0 ? ` (${degenerate} degenerate triangle(s) dropped)` : ''),
  };
}
