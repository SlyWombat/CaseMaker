/**
 * The material model behind adaptive clearing (#433): a pocket region as exact 2D geometry, plus a
 * grid of the material still standing in it.
 *
 * TWO KINDS OF TRUTH, kept apart on purpose:
 *   - WHERE THE TOOL MAY GO is answered EXACTLY, from the region's own edges (`RegionGeometry`):
 *     a centre is allowed when it lies inside the region and at least the tool radius from every
 *     edge, so the cutter's disc is inside the pocket. Every point the planner moves to is checked
 *     this way; the grid never decides a gouge.
 *   - WHAT THE TOOL WOULD CUT is answered on the GRID (`MaterialGrid`): cells of side `h`, each
 *     standing or removed. A step's load is the area of the cells it newly removes, divided by its
 *     length — the effective radial engagement, in mm.
 *
 * This file contains NO polygon offsetting and no booleans — a distance-to-edge test is not an
 * offset (the pocket module's rule stands: Clipper does offsets). It is kernel-free so it runs in
 * node and in a worker alike.
 *
 * `Polygons` is the work-frame shape `CrossSection.toPolygons()` returns: outer contours CCW, holes
 * CW. Inside is decided by the even-odd rule, which agrees with that convention for any region whose
 * contours do not cross.
 */

import type { Polygons } from './pocket';

export type P2 = readonly [number, number];

/** Exact point queries on a region: inside, and distance to its nearest edge. */
export class RegionGeometry {
  /** Edge list, flattened: x0, y0, x1, y1 per edge. */
  private readonly edges: Float64Array;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;

  constructor(region: Polygons) {
    const list: number[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const contour of region) {
      if (contour.length < 3) continue;
      for (let i = 0; i < contour.length; i++) {
        const [ax, ay] = contour[i]!;
        const [bx, by] = contour[(i + 1) % contour.length]!;
        list.push(ax, ay, bx, by);
        if (ax < minX) minX = ax;
        if (ay < minY) minY = ay;
        if (ax > maxX) maxX = ax;
        if (ay > maxY) maxY = ay;
      }
    }
    this.edges = Float64Array.from(list);
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
  }

  get empty(): boolean {
    return this.edges.length === 0;
  }

  /** Even-odd point-in-region. */
  inside(x: number, y: number): boolean {
    const e = this.edges;
    let inside = false;
    for (let k = 0; k < e.length; k += 4) {
      const ay = e[k + 1]!;
      const by = e[k + 3]!;
      if (ay > y !== by > y) {
        const ax = e[k]!;
        const bx = e[k + 2]!;
        const xCross = ax + ((y - ay) * (bx - ax)) / (by - ay);
        if (x < xCross) inside = !inside;
      }
    }
    return inside;
  }

  /** Distance from (x, y) to the nearest edge of the region. */
  clearance(x: number, y: number): number {
    const e = this.edges;
    let best = Infinity;
    for (let k = 0; k < e.length; k += 4) {
      const ax = e[k]!;
      const ay = e[k + 1]!;
      const dx = e[k + 2]! - ax;
      const dy = e[k + 3]! - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const px = ax + t * dx - x;
      const py = ay + t * dy - y;
      const d2 = px * px + py * py;
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
  }

  /** The cutter's disc of `radius` centred here lies inside the region. */
  allows(x: number, y: number, radius: number): boolean {
    return this.inside(x, y) && this.clearance(x, y) >= radius - 1e-9;
  }
}

/** What a move would remove: cells, the ones that were still to clear, and which side they lie on. */
export interface Removal {
  /** Standing cells newly inside the swept capsule. */
  cells: number;
  /** Of those, the ones the job must clear (reachable material). */
  targetCells: number;
  /** Σ cross(direction, cell − end) over the removed cells: negative = material on the right. */
  side: number;
}

/**
 * The standing material, on a grid of square cells of side `h` over the region's box.
 *
 * `material` is 1 where a cell's centre is inside the region and not yet cut. `target` is 1 where a
 * cell is one the job must clear — inside the region AND within the tool radius of some allowed
 * centre; a cell no allowed centre reaches (an inside corner tighter than the cutter) stays standing
 * by geometry, is not counted as left behind, and still counts as load if a cut ever grazes it.
 */
export class MaterialGrid {
  readonly h: number;
  readonly x0: number;
  readonly y0: number;
  readonly nx: number;
  readonly ny: number;
  readonly material: Uint8Array;
  readonly target: Uint8Array;
  remainingTargets = 0;
  totalTargets = 0;

  constructor(geom: RegionGeometry, h: number) {
    this.h = h;
    this.x0 = geom.minX - h;
    this.y0 = geom.minY - h;
    this.nx = Math.ceil((geom.maxX - geom.minX) / h) + 2;
    this.ny = Math.ceil((geom.maxY - geom.minY) / h) + 2;
    const n = this.nx * this.ny;
    this.material = new Uint8Array(n);
    this.target = new Uint8Array(n);
    for (let j = 0; j < this.ny; j++) {
      const y = this.cy(j);
      for (let i = 0; i < this.nx; i++) {
        if (geom.inside(this.cx(i), y)) this.material[j * this.nx + i] = 1;
      }
    }
  }

  cx(i: number): number {
    return this.x0 + (i + 0.5) * this.h;
  }

  cy(j: number): number {
    return this.y0 + (j + 0.5) * this.h;
  }

  /** The cell whose square holds (x, y), or -1 off the grid. */
  index(x: number, y: number): number {
    const i = Math.floor((x - this.x0) / this.h);
    const j = Math.floor((y - this.y0) / this.h);
    return i < 0 || j < 0 || i >= this.nx || j >= this.ny ? -1 : j * this.nx + i;
  }

  /** Mark the job's targets: standing cells whose `distToAllowed` (mm) is within `radius`. */
  setTargets(distToAllowed: Float64Array, radius: number): void {
    let count = 0;
    for (let k = 0; k < this.material.length; k++) {
      if (this.material[k] === 1 && distToAllowed[k]! <= radius) {
        this.target[k] = 1;
        count++;
      }
    }
    this.remainingTargets = count;
    this.totalTargets = count;
  }

  /**
   * The standing cells the capsule from `a` to `b` (radius `r`) covers that the disc at `a` does
   * not — what moving the tool from `a` to `b` removes, given that everything under the tool at `a`
   * is already gone. With `stamp` the cells are removed.
   */
  sweep(a: P2, b: P2, r: number, stamp: boolean): Removal {
    const out: Removal = { cells: 0, targetCells: 0, side: 0 };
    const [ax, ay] = a;
    const [bx, by] = b;
    const len = Math.hypot(bx - ax, by - ay);
    const ux = len > 0 ? (bx - ax) / len : 0;
    const uy = len > 0 ? (by - ay) / len : 0;
    const nxv = -uy;
    const nyv = ux;
    const h = this.h;
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r - this.y0) / h - 0.5));
    const j1 = Math.min(this.ny - 1, Math.ceil((Math.max(ay, by) + r - this.y0) / h - 0.5));
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const y = this.cy(j);
      // The capsule's chord on this row: disc(a) ∪ disc(b) ∪ the strip between them. Convex, so the
      // union is one interval.
      let lo = Infinity;
      let hi = -Infinity;
      let aLo = Infinity;
      let aHi = -Infinity;
      const dya = y - ay;
      if (dya * dya <= r2) {
        const w = Math.sqrt(r2 - dya * dya);
        aLo = ax - w;
        aHi = ax + w;
        lo = aLo;
        hi = aHi;
      }
      const dyb = y - by;
      if (dyb * dyb <= r2) {
        const w = Math.sqrt(r2 - dyb * dyb);
        lo = Math.min(lo, bx - w);
        hi = Math.max(hi, bx + w);
      }
      if (len > 0) {
        const strip = slabIntersect(
          slab(ux, (y - ay) * uy, 0, len, ax),
          slab(nxv, (y - ay) * nyv, -r, r, ax),
        );
        if (strip !== null) {
          lo = Math.min(lo, strip[0]);
          hi = Math.max(hi, strip[1]);
        }
      }
      if (!(hi >= lo)) continue;
      const i0 = Math.max(0, Math.ceil((lo - this.x0) / h - 0.5));
      const i1 = Math.min(this.nx - 1, Math.floor((hi - this.x0) / h - 0.5));
      const row = j * this.nx;
      for (let i = i0; i <= i1; i++) {
        const x = this.cx(i);
        if (x >= aLo && x <= aHi) {
          // Inside disc(a): already cut. Jump to the end of that chord.
          const skip = Math.floor((aHi - this.x0) / h - 0.5);
          if (skip > i) i = skip;
          continue;
        }
        const k = row + i;
        if (this.material[k] !== 1) continue;
        out.cells++;
        const isTarget = this.target[k] === 1;
        if (isTarget) out.targetCells++;
        out.side += ux * (y - by) - uy * (x - bx);
        if (stamp) {
          this.material[k] = 0;
          if (isTarget) {
            this.target[k] = 0;
            this.remainingTargets--;
          }
        }
      }
    }
    return out;
  }

  /** Remove every standing cell within `r` of `c`. */
  stampDisc(c: P2, r: number): void {
    const h = this.h;
    const j0 = Math.max(0, Math.floor((c[1] - r - this.y0) / h - 0.5));
    const j1 = Math.min(this.ny - 1, Math.ceil((c[1] + r - this.y0) / h - 0.5));
    for (let j = j0; j <= j1; j++) {
      const dy = this.cy(j) - c[1];
      if (dy * dy > r * r) continue;
      const w = Math.sqrt(r * r - dy * dy);
      const i0 = Math.max(0, Math.ceil((c[0] - w - this.x0) / h - 0.5));
      const i1 = Math.min(this.nx - 1, Math.floor((c[0] + w - this.x0) / h - 0.5));
      for (let i = i0; i <= i1; i++) {
        const k = j * this.nx + i;
        if (this.material[k] !== 1) continue;
        this.material[k] = 0;
        if (this.target[k] === 1) {
          this.target[k] = 0;
          this.remainingTargets--;
        }
      }
    }
  }

  /** Standing cells within `r` of `c` (whether the disc there is already clear). */
  discCells(c: P2, r: number): number {
    const h = this.h;
    let count = 0;
    const j0 = Math.max(0, Math.floor((c[1] - r - this.y0) / h - 0.5));
    const j1 = Math.min(this.ny - 1, Math.ceil((c[1] + r - this.y0) / h - 0.5));
    for (let j = j0; j <= j1; j++) {
      const dy = this.cy(j) - c[1];
      if (dy * dy > r * r) continue;
      const w = Math.sqrt(r * r - dy * dy);
      const i0 = Math.max(0, Math.ceil((c[0] - w - this.x0) / h - 0.5));
      const i1 = Math.min(this.nx - 1, Math.floor((c[0] + w - this.x0) / h - 0.5));
      for (let i = i0; i <= i1; i++) if (this.material[j * this.nx + i] === 1) count++;
    }
    return count;
  }

  /** Remove every standing cell within `r` of the segment a–b. */
  stampCapsule(a: P2, b: P2, r: number): void {
    // The disc at `a` first (sweep never removes it), then the rest of the capsule.
    this.stampDisc(a, r);
    this.sweep(a, b, r, true);
  }
}

/**
 * The x-interval where `lo ≤ (x − x0)·k + c ≤ hi`, or the whole line / nothing when `k` is 0.
 */
function slab(k: number, c: number, lo: number, hi: number, x0: number): [number, number] | null {
  if (Math.abs(k) < 1e-12) return c >= lo && c <= hi ? [-Infinity, Infinity] : null;
  const t0 = (lo - c) / k + x0;
  const t1 = (hi - c) / k + x0;
  return t0 <= t1 ? [t0, t1] : [t1, t0];
}

function slabIntersect(a: [number, number] | null, b: [number, number] | null): [number, number] | null {
  if (a === null || b === null) return null;
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  return lo <= hi && Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null;
}

/**
 * Euclidean distance, in mm, from every cell centre to the nearest cell where `feature` is 1
 * (Felzenszwalb–Huttenlocher, exact on the grid, linear time). Infinity where there is none.
 */
export function distanceField(feature: Uint8Array, nx: number, ny: number, h: number): Float64Array {
  const INF = 1e20;
  const n = nx * ny;
  const g = new Float64Array(n);
  for (let k = 0; k < n; k++) g[k] = feature[k] === 1 ? 0 : INF;
  const size = Math.max(nx, ny);
  const f = new Float64Array(size);
  const d = new Float64Array(size);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);
  const pass = (len: number): void => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k--;
        s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1]! < q) k++;
      const dq = q - v[k]!;
      d[q] = dq * dq + f[v[k]!]!;
    }
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) f[j] = g[j * nx + i]!;
    pass(ny);
    for (let j = 0; j < ny; j++) g[j * nx + i] = d[j]!;
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) f[i] = g[j * nx + i]!;
    pass(nx);
    for (let i = 0; i < nx; i++) g[j * nx + i] = d[i]!;
  }
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) out[k] = g[k]! >= INF / 2 ? Infinity : Math.sqrt(g[k]!) * h;
  return out;
}
