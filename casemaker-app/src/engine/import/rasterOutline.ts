import { finalizeOutline, type OutlineParseResult } from './outlineTypes';

/**
 * Raster image → traced cut outlines (#252).
 *
 * The trace half of decision 5's two image methods, and the half the corpus says comes first:
 * tracing is free-tier and near-universal, relief is the dexel engine's (#222). A trace produces
 * exactly what #217 already consumes — an `OutlineImport` of rings in mm — so the file lands in
 * the same dialog, the same `partPlan`, the same opening check and compromise reporting. Nothing
 * downstream knows this outline came from a picture rather than an SVG.
 *
 * PURE. This module takes pixels, not a file: decoding a PNG/JPEG is the browser's job and lives
 * in `imageDecode.ts`, so the algorithm here is testable in plain Node.
 *
 * The pipeline: luminance → a binary ink mask → despeckle (both directions) → closed boundary
 * rings following the cracks between ink and background pixels → Ramer–Douglas–Peucker to drop
 * the staircase → mm.
 *
 * WHY EVEN-ODD. Rings come out of the crack walk one per boundary, outer and hole alike, so a
 * donut traces as two rings. Even-odd fills the hole whatever the windings are, which is what a
 * bitmap means by a hole — there is no winding information in pixels to lose.
 */

/** An RGBA bitmap, row-major — the shape `ImageData` already has. */
export interface RasterImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, `width * height * 4` long. */
  data: Uint8ClampedArray | Uint8Array;
}

export interface TraceOptions {
  /** Luminance cutoff, 0–255. A pixel is ink when it is DARKER than this (or lighter, inverted). */
  threshold?: number;
  /** Trace the light pixels instead — white line art on a dark background. */
  invert?: boolean;
  /**
   * Drop a blob (or an enclosed hole) smaller than this many pixels. Antialiasing and JPEG
   * noise both leave single-pixel specks the cutter cannot cut anyway; 8 px at 96 dpi is
   * about 0.55 mm across.
   */
  despeckle?: number;
  /**
   * Staircase removal, in PIXELS of source resolution. The crack walk follows pixel edges, so a
   * diagonal becomes a staircase; this is the Ramer–Douglas–Peucker tolerance that straightens
   * it. 1 px is the least that removes the steps without rounding a real corner off.
   */
  simplify?: number;
}

export const TRACE_DEFAULTS = {
  threshold: 128,
  invert: false,
  despeckle: 8,
  simplify: 1,
} as const;

/**
 * A bitmap carries no physical size. 96 px/inch is SVG's own fallback for a file with no units
 * (#217), so an image traced here and a logo imported from an SVG assume the same scale — and
 * the import dialog shows the number and lets the user set the real width either way.
 */
export const MM_PER_PX = 25.4 / 96;
/** The `assuming` wording is the dialog's trigger for its size warning (#217). */
export const TRACE_SIZE_NOTE =
  'A bitmap has no physical size; assuming 96 px/inch (1 px = 0.2646 mm).';

/**
 * Refuse a bitmap larger than this BEFORE the O(n²)-ish work. 4 MP is far past what a cut region
 * can resolve: at 96 px/inch it is a 660 mm square. The decoder downscales to
 * `MAX_TRACE_EDGE`, so this is the guard for a caller that does not.
 */
export const MAX_RASTER_PIXELS = 4_000_000;
/** Longest edge the decoder keeps, px (#252). Beyond this the cutter cannot tell the difference. */
export const MAX_TRACE_EDGE = 1024;

type Pt = [number, number];

function optionsOf(o: TraceOptions | undefined): Required<TraceOptions> {
  return { ...TRACE_DEFAULTS, ...(o ?? {}) };
}

/** Ink mask from luminance. Transparent pixels are background: there is nothing to cut there. */
function buildMask(image: RasterImage, o: Required<TraceOptions>): Uint8Array {
  const { width, height, data } = image;
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    // Luma coefficients (sRGB), rounded to the usual 2-digit form. Alpha below 8 counts as
    // background before inversion: a fully transparent logo still has RGB in its dead pixels.
    const a = data[p + 3]!;
    const lum =
      a < 8
        ? 255
        : 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.0722 * data[p + 2]!;
    mask[i] = (o.invert ? lum >= o.threshold : lum < o.threshold) ? 1 : 0;
  }
  return mask;
}

/**
 * Flood one component, collecting its pixel indices. 8-connected for both directions, which is
 * the convention the boundary walk's left-turn rule below matches.
 */
function flood(
  mask: Uint8Array,
  w: number,
  h: number,
  start: number,
  want: number,
  seen: Uint8Array,
): number[] {
  const out: number[] = [];
  const stack = [start];
  seen[start] = 1;
  while (stack.length > 0) {
    const i = stack.pop()!;
    out.push(i);
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (seen[n] === 1 || mask[n] !== want) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
  }
  return out;
}

/** What `despeckle` removed, so the dialog can say the control did something (#252). */
interface SpeckCount {
  /** Ink blobs too small to keep, dropped. */
  specks: number;
  /** Pinholes too small to cut, filled in. */
  pinholes: number;
}

/**
 * Remove specks in BOTH directions: ink blobs smaller than `minPx`, and enclosed holes smaller
 * than `minPx`. A hole the background cannot reach from the border is a hole, so the border
 * flood is what separates "outside" from "inside a shape" — no geometry needed.
 */
function despeckle(mask: Uint8Array, w: number, h: number, minPx: number): SpeckCount {
  if (minPx <= 1) return { specks: 0, pinholes: 0 };

  let specks = 0;
  const seenInk = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1 || seenInk[i] === 1) continue;
    const blob = flood(mask, w, h, i, 1, seenInk);
    if (blob.length < minPx) {
      specks++;
      for (const p of blob) mask[p] = 0;
    }
  }

  // Background reachable from the border is OUTSIDE and is never touched. Whatever background
  // is left is a hole; each hole component is measured and filled if it is a speck.
  let pinholes = 0;
  const seenBg = new Uint8Array(mask.length);
  for (let x = 0; x < w; x++) {
    for (const i of [x, (h - 1) * w + x]) if (mask[i] === 0 && seenBg[i] === 0) flood(mask, w, h, i, 0, seenBg);
  }
  for (let y = 0; y < h; y++) {
    for (const i of [y * w, y * w + w - 1]) if (mask[i] === 0 && seenBg[i] === 0) flood(mask, w, h, i, 0, seenBg);
  }
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0 || seenBg[i] === 1) continue;
    const hole = flood(mask, w, h, i, 0, seenBg);
    if (hole.length < minPx) {
      pinholes++;
      for (const p of hole) mask[p] = 1;
    }
  }
  return { specks, pinholes };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The closed rings around the ink, following the unit cracks between an ink pixel and a
 * background one. Every ink pixel contributes the sides that face background; the cracks are
 * directed so that walking one keeps the ink on a fixed hand, and a walk ends when it returns to
 * where it started.
 *
 * AMBIGUITY. Two ink pixels touching only at a corner share that corner, which then has two
 * outgoing cracks. The walk prefers the LEFTMOST turn, which keeps the two pixels in ONE ring
 * pinched at the corner — the same 8-connected reading `despeckle` uses, so a diagonal stroke is
 * one blob bound by one ring rather than a chain of separate squares.
 */
function crackRings(mask: Uint8Array, w: number, h: number): Pt[][] {
  const key = (x: number, y: number): number => y * (w + 1) + x;
  const out = new Map<number, number[]>();
  const add = (ax: number, ay: number, bx: number, by: number): void => {
    const k = key(ax, ay);
    const list = out.get(k);
    if (list) list.push(bx, by);
    else out.set(k, [bx, by]);
  };
  const ink = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ink(x, y)) continue;
      // Clockwise around the pixel in image coordinates (y down).
      if (!ink(x, y - 1)) add(x, y, x + 1, y);
      if (!ink(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!ink(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!ink(x - 1, y)) add(x, y + 1, x, y);
    }
  }

  const used = new Set<number>();
  const edgeId = (ax: number, ay: number, i: number): number => key(ax, ay) * 4 + i;
  const rings: Pt[][] = [];

  for (const [k, list] of out) {
    const startX = k % (w + 1);
    const startY = (k - startX) / (w + 1);
    for (let i = 0; i < list.length; i += 2) {
      if (used.has(edgeId(startX, startY, i / 2))) continue;

      const ring: Pt[] = [[startX, startY]];
      let cx = startX;
      let cy = startY;
      let dx = list[i]! - cx;
      let dy = list[i + 1]! - cy;
      used.add(edgeId(startX, startY, i / 2));

      // Bounded by the number of edges: an unclosed walk in a consistent edge set cannot
      // happen, but a malformed one must not hang the worker.
      const limit = mask.length * 4 + 8;
      for (let step = 0; step < limit; step++) {
        cx += dx;
        cy += dy;
        if (cx === startX && cy === startY) break;
        ring.push([cx, cy]);

        const here = out.get(key(cx, cy));
        if (!here) break;
        // Turn priority relative to the travel direction: left, straight, right, back. See the
        // ambiguity note above — left is what merges a corner-touching pair.
        const order: Pt[] = [[dy, -dx], [dx, dy], [-dy, dx], [-dx, -dy]];
        let picked = -1;
        for (const [tx, ty] of order) {
          for (let j = 0; j < here.length; j += 2) {
            if (used.has(edgeId(cx, cy, j / 2))) continue;
            if (here[j] === cx + tx && here[j + 1] === cy + ty) {
              picked = j;
              break;
            }
          }
          if (picked >= 0) break;
        }
        if (picked < 0) break;
        used.add(edgeId(cx, cy, picked / 2));
        dx = here[picked]! - cx;
        dy = here[picked + 1]! - cy;
      }

      // A ring must have area; a 2-point "ring" traces nothing.
      if (ring.length >= 4 && ringArea(ring) !== 0) rings.push(ring);
    }
  }
  return rings;
}

/** Twice the signed area of a lattice ring (shoelace). Zero means the ring is degenerate. */
function ringArea(ring: readonly Pt[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  }
  return a;
}

/** Squared distance from p to segment ab. */
function segDist2(p: Pt, a: Pt, b: Pt): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const dx = wx - t * vx;
  const dy = wy - t * vy;
  return dx * dx + dy * dy;
}

/** Ramer–Douglas–Peucker over an open polyline; both ends are always kept. */
function rdp(pts: readonly Pt[], eps2: number): Pt[] {
  if (pts.length <= 2) return pts.map((p): Pt => [p[0], p[1]]);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop()!;
    let best = -1;
    let bestD = eps2;
    for (let k = i + 1; k < j; k++) {
      const d = segDist2(pts[k]!, pts[i]!, pts[j]!);
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i, best], [best, j]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i] === 1) out.push([pts[i]![0], pts[i]![1]]);
  return out;
}

/**
 * Simplify a CLOSED ring. The loop is cut at the point farthest from the first so RDP has two
 * anchors, simplified in two halves, and re-joined without duplicating the anchors.
 */
function simplifyRing(ring: readonly Pt[], eps: number): Pt[] {
  if (ring.length <= 3 || eps <= 0) return ring.map((p): Pt => [p[0], p[1]]);
  let far = 0;
  let best = -1;
  for (let i = 1; i < ring.length; i++) {
    const dx = ring[i]![0] - ring[0]![0];
    const dy = ring[i]![1] - ring[0]![1];
    const d = dx * dx + dy * dy;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const eps2 = eps * eps;
  const head = rdp(ring.slice(0, far + 1), eps2);
  const tail = rdp([...ring.slice(far), ring[0]!], eps2);
  const out = [...head.slice(0, -1), ...tail.slice(0, -1)];
  return out.length >= 3 ? out : ring.map((p): Pt => [p[0], p[1]]);
}

/**
 * Trace a bitmap to cut outlines. Returns the same `OutlineParseResult` the SVG and DXF parsers
 * do, so the caller cannot tell the three apart — except by the `raster` format in the dialog's
 * header and the size note it carries.
 *
 * An image with no ink is NOT an error: it traces to zero shapes with a note, exactly as a
 * strokes-only SVG does, and the dialog decides whether that is addable.
 */
export function traceRaster(
  image: RasterImage,
  options?: TraceOptions,
  sourceName = 'image',
): OutlineParseResult {
  const { width, height } = image;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return { ok: false, error: 'The image has no pixels.' };
  }
  // Size before data length: a caller that hands us a 30 MP bitmap is refused without us first
  // demanding its 120 MB of pixels.
  if (width * height > MAX_RASTER_PIXELS) {
    return {
      ok: false,
      error: `The image is ${width} × ${height} pixels; the limit is ${MAX_RASTER_PIXELS / 1_000_000} MP.`,
    };
  }
  if (image.data.length < width * height * 4) {
    return { ok: false, error: 'The image data is shorter than its width × height × 4 bytes.' };
  }

  const o = optionsOf(options);
  const minPx = Math.round(o.despeckle);
  const mask = buildMask(image, o);
  const removed = despeckle(mask, width, height, minPx);

  // The controls change the picture, so what they removed is reported rather than silent: a
  // despeckle that quietly ate a logo's dot is exactly the surprise this dialog exists to stop.
  const notes: string[] = [TRACE_SIZE_NOTE];
  if (removed.specks > 0) {
    notes.push(`${plural(removed.specks, 'speck', 'specks')} smaller than ${minPx} px dropped.`);
  }
  if (removed.pinholes > 0) {
    notes.push(`${plural(removed.pinholes, 'pinhole', 'pinholes')} smaller than ${minPx} px filled in.`);
  }

  const contours: [number, number][][] = [];
  for (const ring of crackRings(mask, width, height)) {
    const simplified = simplifyRing(ring, o.simplify);
    if (simplified.length < 3) continue;
    // Image Y is down, the job's is up; flipping here is the same correction the SVG parser
    // makes, and it is why a traced outline is never mirrored.
    contours.push(simplified.map(([x, y]): [number, number] => [x * MM_PER_PX, -y * MM_PER_PX]));
  }

  return finalizeOutline({ format: 'raster', sourceName, contours, fillRule: 'EvenOdd', notes });
}
