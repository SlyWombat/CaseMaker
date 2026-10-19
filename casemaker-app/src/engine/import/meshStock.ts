/**
 * An STL or 3MF used AS THE STOCK (#418, §5.1's "Load" door) — what the mesh is, or why it cannot be
 * the stock a job cuts.
 *
 * Three questions, in the order a wrong answer would hurt:
 *
 *   1. **Is it closed?** A mesh with open edges has no inside, so there is no material to cut. The
 *      vertices are WELDED first (an STL repeats every vertex per triangle), then every edge must be
 *      shared by exactly two triangles; the refusal gives the count of those that are not (§5.1).
 *   2. **Is it a prism?** Every face flat on the bottom or top plane, or vertical — identical slices,
 *      so the stock is the same at every Z. Anything else is 3D stock, refused by name until #222.
 *   3. **Is its outline a rectangle?** A job's stock is length × width × thickness. A prism whose top
 *      face does not fill its bounding rectangle would have the job plan cuts into air beyond the
 *      outline, so it is refused with how much of the box it covers rather than rounded up to one.
 *
 * Z is up and the mesh's own X/Y are the job's (length = X, width = Y). The mesh's position on the
 * bed is irrelevant: only its extents are taken.
 *
 * Pure — a `ParsedMesh` in, plain data out — so a fixture tests it without a DOM or a worker.
 */

import { parseStl, type ParsedMesh } from './stlParser';
import { unzipSync } from 'fflate';
import { parse3MF } from './threeMfParser';
import { parsePrusaThreeMf } from './prusa3mf';
import { MAX_DESIGN_FILE_BYTES } from './designLimits';

/** Positions within this of each other are one vertex, mm. A slicer writes floats; 1 µm is plenty. */
export const WELD_TOLERANCE_MM = 1e-3;

/** How much of its bounding rectangle a top face must cover to count as that rectangle. */
export const RECTANGLE_COVER = 0.995;

export type MeshStockResult =
  | { ok: true; length: number; width: number; thickness: number; triangles: number }
  | { ok: false; reason: string };

function round(v: number): number {
  return Number(v.toFixed(3));
}

/** Read a mesh as a rectangular block of stock, or say why it is not one. */
export function meshAsStock(mesh: ParsedMesh, tol: number = WELD_TOLERANCE_MM): MeshStockResult {
  const { positions, indices } = mesh;
  const triCount = Math.floor(indices.length / 3);
  if (triCount === 0) return { ok: false, reason: 'the file holds no triangles' };

  // Weld: positions within `tol` of each other are one vertex. Bucketed on a grid of `tol`, and every
  // neighbouring bucket is searched too — a plain rounded key would split two points a hair apart that
  // happen to straddle a cell boundary (0.4999 and 0.5001 µm), and the mesh would read as open.
  const buckets = new Map<string, number[]>();
  const weld = new Uint32Array(positions.length / 3);
  const xyz: number[] = [];
  for (let v = 0; v < weld.length; v++) {
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;
    const cx = Math.round(x / tol);
    const cy = Math.round(y / tol);
    const cz = Math.round(z / tol);
    let id: number | undefined;
    search: for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const cand of buckets.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (
              Math.abs(xyz[cand * 3]! - x) <= tol &&
              Math.abs(xyz[cand * 3 + 1]! - y) <= tol &&
              Math.abs(xyz[cand * 3 + 2]! - z) <= tol
            ) {
              id = cand;
              break search;
            }
          }
        }
      }
    }
    if (id === undefined) {
      id = xyz.length / 3;
      xyz.push(x, y, z);
      const key = `${cx},${cy},${cz}`;
      const list = buckets.get(key);
      if (list) list.push(id);
      else buckets.set(key, [id]);
    }
    weld[v] = id;
  }

  // Edges: every undirected edge of every non-degenerate triangle, counted.
  const edges = new Map<string, number>();
  let used = 0;
  for (let t = 0; t < triCount; t++) {
    const a = weld[indices[t * 3]!]!;
    const b = weld[indices[t * 3 + 1]!]!;
    const c = weld[indices[t * 3 + 2]!]!;
    if (a === b || b === c || a === c) continue; // a sliver the weld collapsed — no area, no edge
    used++;
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = p < q ? `${p}:${q}` : `${q}:${p}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  if (used === 0) return { ok: false, reason: 'every triangle in the file has no area' };
  let open = 0;
  for (const n of edges.values()) if (n !== 2) open++;
  if (open > 0) {
    return {
      ok: false,
      reason: `the mesh is not closed — ${open} edge${open === 1 ? ' is' : 's are'} not shared by exactly two triangles, so it has no inside to cut`,
    };
  }

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < xyz.length; i += 3) {
    minX = Math.min(minX, xyz[i]!);
    maxX = Math.max(maxX, xyz[i]!);
    minY = Math.min(minY, xyz[i + 1]!);
    maxY = Math.max(maxY, xyz[i + 1]!);
    minZ = Math.min(minZ, xyz[i + 2]!);
    maxZ = Math.max(maxZ, xyz[i + 2]!);
  }
  const length = maxX - minX;
  const width = maxY - minY;
  const thickness = maxZ - minZ;
  if (!(length > tol && width > tol && thickness > tol)) {
    return { ok: false, reason: 'the mesh is flat — it has no thickness to cut' };
  }

  // A prism: identical slices. Every triangle either lies in the bottom or top plane, or stands
  // vertical (its normal has no Z part). A vertex between the planes is fine — a side face split at
  // mid-height is still a side face — but a sloped or stepped face is not.
  let shaped = 0;
  for (let t = 0; t < triCount; t++) {
    const a = weld[indices[t * 3]!]!;
    const b = weld[indices[t * 3 + 1]!]!;
    const c = weld[indices[t * 3 + 2]!]!;
    if (a === b || b === c || a === c) continue;
    const za = xyz[a * 3 + 2]!,
      zb = xyz[b * 3 + 2]!,
      zc = xyz[c * 3 + 2]!;
    const onPlane = (z: number) => Math.abs(za - z) <= tol && Math.abs(zb - z) <= tol && Math.abs(zc - z) <= tol;
    if (onPlane(minZ) || onPlane(maxZ)) continue;
    const ux = xyz[b * 3]! - xyz[a * 3]!,
      uy = xyz[b * 3 + 1]! - xyz[a * 3 + 1]!,
      uz = zb - za;
    const vx = xyz[c * 3]! - xyz[a * 3]!,
      vy = xyz[c * 3 + 1]! - xyz[a * 3 + 1]!,
      vz = zc - za;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const n = Math.hypot(nx, ny, nz);
    if (n > 0 && Math.abs(nz) > 1e-6 * n) shaped++;
  }
  if (shaped > 0) {
    return {
      ok: false,
      reason:
        `this is 3D stock — ${shaped} face${shaped === 1 ? ' is' : 's are'} neither flat on the top or bottom nor vertical, ` +
        'and cutting from a shaped (non-prismatic) blank is not supported yet',
    };
  }

  // The top face's area, from the triangles lying in the top plane (projected, so the winding's sign
  // does not matter).
  let top = 0;
  for (let t = 0; t < triCount; t++) {
    const a = weld[indices[t * 3]!]!;
    const b = weld[indices[t * 3 + 1]!]!;
    const c = weld[indices[t * 3 + 2]!]!;
    if (a === b || b === c || a === c) continue;
    const onTop = [a, b, c].every((v) => Math.abs(xyz[v * 3 + 2]! - maxZ) <= tol);
    if (!onTop) continue;
    const ax = xyz[a * 3]!,
      ay = xyz[a * 3 + 1]!;
    const bx = xyz[b * 3]!,
      by = xyz[b * 3 + 1]!;
    const cx = xyz[c * 3]!,
      cy = xyz[c * 3 + 1]!;
    top += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  }
  const cover = top / (length * width);
  if (cover < RECTANGLE_COVER) {
    const turned = rotatedRectangle(xyz, maxZ, tol, top);
    if (turned !== null) {
      return {
        ok: false,
        reason:
          `it is a rectangle turned ${turned} ° in plan — square it to the X and Y axes in the slicer or CAD and ` +
          'load it again (the job reads the stock square to the machine)',
      };
    }
    return {
      ok: false,
      reason:
        `its outline is not a rectangle — the top face covers ${Math.round(cover * 100)} % of its ` +
        `${round(length)} × ${round(width)} mm bounding box, and a job's stock is a rectangle, so it would plan cuts into air`,
    };
  }

  return { ok: true, length: round(length), width: round(width), thickness: round(thickness), triangles: used };
}

/**
 * Is the top face a rectangle turned in plan? Its corners are the top plane's vertices that are not
 * on a straight line between two others; four corners with right angles whose area is the face's
 * own make a rectangle. Returns the turn in degrees (0–90, one decimal), or null.
 */
function rotatedRectangle(xyz: number[], maxZ: number, tol: number, topArea: number): number | null {
  const pts: [number, number][] = [];
  for (let i = 0; i < xyz.length; i += 3) if (Math.abs(xyz[i + 2]! - maxZ) <= tol) pts.push([xyz[i]!, xyz[i + 1]!]);
  if (pts.length < 4) return null;
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  pts.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // Drop the points that lie on an edge (collinear with their neighbours).
  const corners = pts.filter((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length]!;
    const b = pts[(i + 1) % pts.length]!;
    const cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
    return Math.abs(cross) > tol * Math.hypot(b[0] - a[0], b[1] - a[1]);
  });
  if (corners.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    const c = corners[(i + 2) % 4]!;
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
    if (Math.abs(ux * vx + uy * vy) > 1e-3 * Math.hypot(ux, uy) * Math.hypot(vx, vy)) return null;
  }
  const [a, b, c] = [corners[0]!, corners[1]!, corners[2]!];
  const area = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]);
  if (Math.abs(area - topArea) > 0.005 * area) return null;
  const deg = ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 360) % 90;
  return Number(deg.toFixed(1));
}

/**
 * What a plain 3MF carries that `parse3MF` does not apply (#418 review): a model unit other than
 * millimetres, an object built from `<components>`, more than one mesh object, more than one build
 * item, or a build transform that is more than a translation. Any of them would read the stock at
 * the wrong size or the wrong turn, silently — so the file is refused with which one it is. A
 * translation is harmless: only the mesh's extents are taken. Null when the file is plain.
 */
export function plain3mfProblem(bytes: ArrayBuffer): string | null {
  const zip = unzipSync(new Uint8Array(bytes));
  const entry = zip['3D/3dmodel.model'] ?? zip['3d/3dmodel.model'];
  if (!entry) return null; // parse3MF names the missing entry itself
  const xml = new TextDecoder('utf-8').decode(entry);
  const unit = /<model\b[^>]*\bunit="([^"]*)"/.exec(xml)?.[1];
  if (unit !== undefined && unit !== 'millimeter') {
    return `its model is in ${unit}s, and only millimetres are read as stock — export it in mm`;
  }
  if (/<components\b/.test(xml)) {
    return 'its object is assembled from components, which are not read as stock — export one merged mesh';
  }
  const meshes = (xml.match(/<mesh\b/g) ?? []).length;
  if (meshes > 1) return `it holds ${meshes} mesh objects — stock is one piece; export just the blank`;
  const items = [...xml.matchAll(/<item\b[^>]*>/g)].map((m) => m[0]);
  if (items.length > 1) return `its build places ${items.length} items — stock is one piece in one place`;
  const transform = items[0] === undefined ? undefined : /\btransform="([^"]*)"/.exec(items[0])?.[1];
  if (transform !== undefined) {
    const m = transform.trim().split(/\s+/).map(Number);
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    if (m.length !== 12 || m.some((v) => !Number.isFinite(v))) return `its build transform cannot be read ("${transform}")`;
    if (identity.some((v, i) => Math.abs(m[i]! - v) > 1e-6)) {
      return 'its build transform scales or turns the object, which is not applied here — apply it in the slicer and export again';
    }
  }
  return null;
}

/** SHA-256 of a file's bytes, as lower-case hex — the hash the job records beside the file's name. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** What a picked stock file turned out to be. */
export type StockFileRead =
  /** A closed rectangular prism: the stock is its box. */
  | { kind: 'mesh'; name: string; sha256: string; length: number; width: number; thickness: number }
  /**
   * A PrusaSlicer project with NEGATIVE VOLUMES: the blank and the design in one file (#410). The
   * caller reads it with `readDesignFile`, which gives the stock and the items together.
   */
  | { kind: 'design'; name: string; sha256: string; negativeVolumes: number }
  | { kind: 'refused'; name: string; reason: string };

/**
 * Read a picked `.stl` / `.3mf` as stock. Never throws: every failure is a sentence the person who
 * picked the file is told. A 3MF is first asked whether it is a PrusaSlicer project with negative
 * volumes — that one is a design, not just a blank — and otherwise read as one mesh.
 */
export async function readStockFile(file: File): Promise<StockFileRead> {
  const name = file.name;
  if (file.size > MAX_DESIGN_FILE_BYTES) {
    return { kind: 'refused', name, reason: `${name} is larger than the ${MAX_DESIGN_FILE_BYTES / (1024 * 1024)} MB limit` };
  }
  const lower = name.toLowerCase();
  const isStl = lower.endsWith('.stl');
  const is3mf = lower.endsWith('.3mf');
  if (!isStl && !is3mf) return { kind: 'refused', name, reason: `${name} is not an .stl or .3mf file` };
  try {
    const bytes = await file.arrayBuffer();
    const sha256 = await sha256Hex(bytes);
    if (is3mf) {
      let negativeVolumes = 0;
      try {
        negativeVolumes = parsePrusaThreeMf(bytes).volumes.filter((v) => v.volumeType === 'NegativeVolume').length;
      } catch {
        // Not a PrusaSlicer project (no `Slic3r_PE_model.config`): read below as a plain mesh.
      }
      if (negativeVolumes > 0) return { kind: 'design', name, sha256, negativeVolumes };
    }
    if (is3mf) {
      const why = plain3mfProblem(bytes);
      if (why !== null) return { kind: 'refused', name, reason: why };
    }
    const mesh = isStl ? parseStl(bytes) : parse3MF(bytes);
    const read = meshAsStock(mesh);
    if (!read.ok) return { kind: 'refused', name, reason: read.reason };
    return { kind: 'mesh', name, sha256, length: read.length, width: read.width, thickness: read.thickness };
  } catch (e) {
    return { kind: 'refused', name, reason: e instanceof Error ? e.message : String(e) };
  }
}
