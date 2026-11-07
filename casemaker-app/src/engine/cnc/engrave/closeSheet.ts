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
import { assertFinitePolygons } from '@/engine/cnc/cam/engraveJob';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';

type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;
type CrossSectionInstance = InstanceType<ManifoldToplevel['CrossSection']>;

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
  /**
   * #966 — WHERE THE SKIRT FLOORS. `'lowestBoundary'` (the relief case): the skirt stops at the
   * sheet's own lowest boundary vertex, so the closed solid is exactly as deep as the relief and
   * the feature tree reads `partBottom` there — no freeing contour (`frees: false`), no cut below
   * the sheet. `'stockBottom'` (with `bottomZ`): the skirt runs to the stock's bottom face; that
   * closes the mesh to full stock height and the tree may classify a freeing through-cut, which is
   * right only where the caller really means a part spanning the stock.
   */
  skirtTo?: 'lowestBoundary' | 'stockBottom';
  /** The stock's bottom face in the goal mesh's own frame, mm — the skirt's floor when
   * `skirtTo` is `'stockBottom'` (the default, for backward compatibility). */
  bottomZ?: number;
  /** Vertex weld distance for the boundary analysis (the same order `solidOf`'s merge uses). */
  weldMm?: number;
}

export interface CloseOpenSheetResult {
  /** The closed mesh; the INPUT ITSELF when it was already closed. */
  mesh: ParsedMesh;
  /** One sentence for the plan's notes: what was added, or that nothing was. */
  note: string;
  /**
   * #987 — HOW (OR WHETHER) THIS CALL CLOSED THE MESH. `'none'`: the input was already a closed
   * solid — its outline is a real design edge. `'skirt'`: this call added the skirt and cap — the
   * outline is synthetic (the kernel's own requirement for a solid, not something the design asked
   * to be cut around). Callers carry this onto the feature tree (`FeatureSource.outline`) so a
   * contour demand is not raised against an edge the design never drew.
   */
  closedBy: 'none' | 'skirt';
}

interface EdgeUse {
  /** The two welded vertex ids, `from` → `to` as the triangle winds them. */
  from: number;
  to: number;
  /** How many triangles use this undirected edge. */
  count: number;
}


/**
 * #993 — SPLIT A NON-MANIFOLD EDGE INSTEAD OF REFUSING IT. Two sheets that touch along a line
 * (two pocket walls meeting at a zero-thickness knife edge) are topologically non-manifold but
 * geometrically ordinary; the tessellator emits both sheets' triangles on one edge and the weld
 * keeps them. The repair is the vertex-link split: at each vertex of an overused edge, the
 * triangles around it are grouped into their sheets (two triangles are on one sheet when they
 * share an edge through that vertex, EXCLUDING an overused edge), and each sheet beyond the first
 * gets its own copy of the vertex. A split is only made where EVERY sheet carries exactly two of
 * the triangles on each overused edge it touches — a flap hinged on one triangle (a three-use
 * edge) is left for the caller's named refusal, never silently unhinged. Every other edge stays
 * two-sided, so the result is the same surface with a zero-width slit wherever the sheets touched
 * — which `solidOf`'s Manifold accepts. Mutates `welded` and `weldedPos`; returns how many
 * OVERUSED EDGES the split resolved.
 */
function splitNonManifoldEdges(
  welded: Int32Array,
  weldedPos: number[],
  kept: readonly number[],
  edgeKey: (a: number, b: number) => string,
): number {
  const edgeUses = (): Map<string, { u: number; v: number; count: number }> => {
    const uses = new Map<string, { u: number; v: number; count: number }>();
    for (const t of kept) {
      const a = welded[3 * t]!, b = welded[3 * t + 1]!, c = welded[3 * t + 2]!;
      for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
        const key = edgeKey(u, v);
        const use = uses.get(key);
        if (use === undefined) uses.set(key, { u, v, count: 1 });
        else use.count++;
      }
    }
    return uses;
  };
  const overusedCount = (uses: Map<string, { count: number }>): number => {
    let n = 0;
    for (const use of uses.values()) if (use.count > 2) n++;
    return n;
  };

  const initialUses = edgeUses();
  const initial = overusedCount(initialUses);
  if (initial === 0) return 0;
  const candidates = [...new Set([...initialUses.values()].filter((e) => e.count > 2).flatMap((e) => [e.u, e.v]))].sort((a, b) => a - b);

  for (const vertex of candidates) {
    const uses = edgeUses();
    const overusedAt = [...uses.entries()].filter(([, e]) => e.count > 2 && (e.u === vertex || e.v === vertex));
    // The triangles around this vertex, grouped by the spokes they share (a spoke is an edge
    // through the vertex used by exactly two triangles; an overused one is the seam itself).
    const spokes = new Map<string, number[]>();
    const incident: number[] = [];
    for (const t of kept) {
      const ids = [welded[3 * t]!, welded[3 * t + 1]!, welded[3 * t + 2]!];
      const at = ids.indexOf(vertex);
      if (at < 0) continue;
      incident.push(t);
      for (const w of [ids[(at + 1) % 3]!, ids[(at + 2) % 3]!]) {
        const key = edgeKey(vertex, w);
        const list = spokes.get(key);
        if (list === undefined) spokes.set(key, [t]);
        else list.push(t);
      }
    }
    if (incident.length === 0) continue;
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      let r = parent.get(x) ?? x;
      while (r !== (parent.get(r) ?? r)) r = parent.get(r) ?? r;
      let c = x;
      while (c !== r) { const n = parent.get(c) ?? c; parent.set(c, r); c = n; }
      return r;
    };
    for (const list of spokes.values()) {
      if (list.length !== 2) continue;
      const a = find(list[0]!), b = find(list[1]!);
      if (a !== b) parent.set(a, b);
    }
    const order: number[] = [];
    const members = new Map<number, number[]>();
    for (const t of incident) {
      const r = find(t);
      if (!members.has(r)) { members.set(r, []); order.push(r); }
      members.get(r)!.push(t);
    }
    if (order.length <= 1) continue;
    // VALIDITY: every sheet (component) must carry 0 or 2 of the triangles on each overused edge
    // it touches — one or three is a flap, and separating it would open a free edge.
    let valid = true;
    for (const [key] of overusedAt) {
      for (const root of order) {
        let n = 0;
        for (const t of members.get(root)!) {
          const ids = [welded[3 * t]!, welded[3 * t + 1]!, welded[3 * t + 2]!];
          for (let i = 0; i < 3; i++) {
            if (edgeKey(ids[i]!, ids[(i + 1) % 3]!) === key) { n++; break; }
          }
        }
        if (n !== 0 && n !== 2) { valid = false; break; }
      }
      if (!valid) break;
    }
    if (!valid) continue;
    // Components in first-appearance order; the first keeps the welded vertex.
    for (let k = 1; k < order.length; k++) {
      const copy = weldedPos.length / 3;
      weldedPos.push(weldedPos[3 * vertex]!, weldedPos[3 * vertex + 1]!, weldedPos[3 * vertex + 2]!);
      for (const t of members.get(order[k]!)!) {
        for (let i = 0; i < 3; i++) if (welded[3 * t + i] === vertex) welded[3 * t + i] = copy;
      }
    }
  }
  return initial - overusedCount(edgeUses());
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
  // #993 — EXACT DUPLICATE TRIANGLES ARE NOT GEOMETRY: a triangle repeated verbatim adds two uses
  // of each of its edges. Dropped here (counted for the note); a genuine non-manifold edge goes
  // through the split below.
  let duplicateTriangles = 0;
  {
    const seen = new Set<string>();
    const unique: number[] = [];
    for (const t of kept) {
      const ids = [welded[3 * t]!, welded[3 * t + 1]!, welded[3 * t + 2]!].sort((x, y) => x - y);
      const key = `${ids[0]}:${ids[1]}:${ids[2]}`;
      if (seen.has(key)) { duplicateTriangles++; continue; }
      seen.add(key);
      unique.push(t);
    }
    // #1015 — NO SPREAD OVER THE MESH: `push(...unique)` passes every triangle index as a call
    // argument and V8 refuses past ~125k of them, so the 12 MB dragon's 243,602-triangle
    // heightfield (and any goal past that count) died here with "Maximum call stack size
    // exceeded" before the mould, the solid or the tree existed.
    kept.length = 0;
    for (const t of unique) kept.push(t);
  }

  const edgeKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const buildEdges = (): Map<string, EdgeUse> => {
    const out = new Map<string, EdgeUse>();
    for (const t of kept) {
      const a = welded[3 * t]!, b = welded[3 * t + 1]!, c = welded[3 * t + 2]!;
      for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
        const key = edgeKey(u, v);
        const use = out.get(key);
        if (use === undefined) out.set(key, { from: u, to: v, count: 1 });
        else use.count++;
      }
    }
    return out;
  };
  // #993 — a knife edge is split (the weld undone for one sheet) before any refusal; what pairing
  // cannot resolve stays overused and is refused with its count and the first edge's position.
  const splitEdgeCount = splitNonManifoldEdges(welded, weldedPos, kept, edgeKey);

  const edges = buildEdges();
  let signedArea2 = 0;
  for (const t of kept) {
    const a = welded[3 * t]!, b = welded[3 * t + 1]!, c = welded[3 * t + 2]!;
    const pa = 3 * a, pb = 3 * b, pc = 3 * c;
    signedArea2 += (weldedPos[pb]! - weldedPos[pa]!) * (weldedPos[pc + 1]! - weldedPos[pa + 1]!)
      - (weldedPos[pc]! - weldedPos[pa]!) * (weldedPos[pb + 1]! - weldedPos[pa + 1]!);
  }
  const boundary: EdgeUse[] = [];
  let overused = 0;
  let firstOverused: EdgeUse | null = null;
  for (const use of edges.values()) {
    if (use.count === 1) boundary.push(use);
    else if (use.count > 2) { overused++; firstOverused ??= use; }
  }
  if (overused > 0) {
    const at = firstOverused === null ? '' :
      `; the first at (${weldedPos[3 * firstOverused.from]!.toFixed(3)}, ${weldedPos[3 * firstOverused.from + 1]!.toFixed(3)}), z ${weldedPos[3 * firstOverused.from + 2]!.toFixed(3)}–${weldedPos[3 * firstOverused.to + 2]!.toFixed(3)}`;
    throw new UnclosableOpenMeshError(`${overused} edge(s) shared by more than two triangles — the mesh is not a surface${at}`);
  }
  if (boundary.length === 0) {
    if (splitEdgeCount === 0 && duplicateTriangles === 0) {
      return { mesh, note: 'the goal mesh is already closed', closedBy: 'none' };
    }
    // The topology changed (a split or a dropped duplicate), so the input mesh is no longer the
    // right answer: rebuild from the welded ids, keeping the split's duplicated vertices.
    const outPositions = new Float32Array(weldedPos);
    const outIndices = new Uint32Array(kept.length * 3);
    for (let i = 0; i < kept.length; i++) {
      const t = kept[i]!;
      for (let k = 0; k < 3; k++) outIndices[3 * i + k] = welded[3 * t + k]!;
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < outPositions.length; i += 3) {
      minX = Math.min(minX, outPositions[i]!); maxX = Math.max(maxX, outPositions[i]!);
      minY = Math.min(minY, outPositions[i + 1]!); maxY = Math.max(maxY, outPositions[i + 1]!);
      minZ = Math.min(minZ, outPositions[i + 2]!); maxZ = Math.max(maxZ, outPositions[i + 2]!);
    }
    return {
      mesh: { positions: outPositions, indices: outIndices, triangleCount: outIndices.length / 3, bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } },
      note:
        `the goal mesh is already closed; ${splitEdgeCount} non-manifold edge(s) split` +
        (duplicateTriangles > 0 ? ` and ${duplicateTriangles} duplicate triangle(s) dropped` : ''),
      closedBy: 'none',
    };
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

  // #966 — THE SKIRT'S FLOOR. A relief closes only to its own lowest boundary; the stock bottom is
  // for a caller that really means a full-height solid. The cap sits at the same floor either way.
  const skirtTo = opts.skirtTo ?? 'stockBottom';
  // #1015 — a running minimum, not `Math.min(...loops.flatMap(...))`: the spread is the same
  // fixed-argument limit this issue fixes above, and a fragmented sheet's boundary is unbounded.
  let lowestBoundaryZ = Infinity;
  for (const loop of loops) for (const edge of loop) lowestBoundaryZ = Math.min(lowestBoundaryZ, weldedPos[3 * edge.from + 2]!);
  const floorZ = skirtTo === 'lowestBoundary' ? lowestBoundaryZ : opts.bottomZ;
  if (floorZ === undefined || !Number.isFinite(floorZ)) {
    throw new UnclosableOpenMeshError(skirtTo === 'stockBottom' ? 'the skirt floor (bottomZ) is missing' : 'the boundary states no lowest Z');
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
      // #1029 — the loops' own projection is the last thing that can carry a non-finite value
      // into the kernel; refuse it by name rather than let the glue trap.
      assertFinitePolygons(loopsXY, 'the open sheet\u2019s XY loops');
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
            ids.map((id) => [cap.vertProperties[id * cap.numProp]!, cap.vertProperties[id * cap.numProp + 1]!, floorZ] as [number, number, number]),
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

  // Assemble: the sheet, the skirt, the cap — from the WELDED ids, so a split's duplicated
  // vertices survive into the output (positions are the same; only the topology differs).
  const newPositions = Array.from(weldedPos);
  const newIndices: number[] = [];
  for (const t of kept) newIndices.push(welded[3 * t]!, welded[3 * t + 1]!, welded[3 * t + 2]!);
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
      const ad = addVertex(ax, ay, floorZ);
      const bd = addVertex(bx, by, floorZ);
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
    let solid: ManifoldInstance | null = null;
    try {
      const mm = new tl.Mesh({ numProp: 3, vertProperties: outPositions, triVerts: outIndices });
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
      `${skirtTriangles} skirt triangle(s) down to ${skirtTo === 'lowestBoundary' ? "the sheet's lowest boundary" : 'the stock bottom'} at ${floorZ} mm and ` +
      `${capTriangles.length} bottom-cap triangle(s)` +
      (degenerate > 0 ? ` (${degenerate} degenerate triangle(s) dropped)` : '') +
      (splitEdgeCount > 0 ? ` (${splitEdgeCount} non-manifold edge(s) split)` : '') +
      (duplicateTriangles > 0 ? ` (${duplicateTriangles} duplicate triangle(s) dropped)` : ''),
    closedBy: 'skirt',
  };
}
