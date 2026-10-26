/**
 * #670 — A SURFACE TEXTURE: a seeded pattern of short strokes over a region, derived, never
 * stored.
 *
 * WHAT IT IS. The operator marks a region with a `TextureMark` (a pattern, a pitch, a stroke
 * length, a seed). This module turns those numbers plus the region's own geometry into
 * POLYLINES — the very thing `plan.traces` holds — so the pattern rides the trace funnel end to
 * end: the trace CAM cuts each stroke (plunge → feed → retract), a V-bit's prediction is the
 * swept CONE groove (`OraclePredicted.groove`), the preview draws `vGrooveSolid`, and the swept
 * cut check and the run sheet read the same entries. Nothing here needs the wasm harness: the
 * whole module is arithmetic over the shape's own fields.
 *
 * WHY NOT THE GOAL PIPELINE. A goal surface rasters its whole grid, so a stipple sampled into a
 * heightfield would be cut away between the strokes — the raster removes the ground, and the
 * texture with it. A texture is a family of discrete cuts, so it takes the discrete-cut funnel.
 *
 * THE NUMBERS, and where each comes from:
 *
 *   - `pitchMm`  — stroke (and row) spacing. {@link DEFAULT_TEXTURE_PITCH_MM}, a labelled CAM
 *                  default: "the CAM's default" until the operator types one.
 *   - `strokeMm` — a stipple stroke's length. {@link DEFAULT_TEXTURE_STROKE_MM}, same source word.
 *   - `seed`     — the jitter and direction seed. {@link DEFAULT_TEXTURE_SEED}, stored in the
 *                  document. The pattern is `mulberry32(seed)` over a fixed cell order, so the
 *                  same document posts the same program byte for byte.
 *   - the DEPTH is the shape's own `depth` field — the operator's number, checked by
 *                  `depth-exceeds-stock` like any region.
 *
 * THE PATTERNS:
 *
 *   - `stipple` — a grid of cells one pitch apart, row-major. Each cell's stroke is centred within
 *     ±35% of the cell (so a stroke never leaves its own cell's neighbourhood), with a random
 *     direction in [0, π). The cell's three numbers come from a HASH of (seed, cell index), not
 *     from a running stream: the pattern is anchored to the stock's own grid, so moving the region
 *     translates the pattern with it, and shrinking it removes strokes without reshuffling the
 *     ones that remain.
 *   - `scallop` — rows one pitch apart, each a chain of semicircular bumps of radius `pitch / 2`,
 *     sampled at {@link SCALLOP_ARC_SEGMENTS} segments (chord error 0.019·r — about 0.01 mm at
 *     r = 0.5). No randomness: the seed is unused by this pattern.
 *
 * CLIPPING is exact per shape kind (rect incl. its corner radius, circle, slot stadium, polygon
 * even-odd) in the shape's own local frame, with boundary crossings found by bisection and the
 * INSIDE side of the crossing returned — so every emitted point is inside the region and no
 * stroke hangs over the rim. A frame/cutaway has holes, so no one inside test describes it: the
 * four simple kinds are the surface a texture sits on, and `validateJob` refuses the rest by name.
 */

import type { EngraveShape, TextureMark, TexturePattern } from '@/types/engraveJob';
import type { Mm } from '@/types/units';

/** The pattern spacing a texture runs with when the operator states none, mm — labelled. */
export const DEFAULT_TEXTURE_PITCH_MM = 1;

/** A stipple stroke's length when the operator states none, mm — labelled. */
export const DEFAULT_TEXTURE_STROKE_MM = 1;

/** The seed a texture runs with when the operator states none — labelled, and stored on save. */
export const DEFAULT_TEXTURE_SEED = 1;

/**
 * The most paths one texture emits. Past it the plan keeps the first `maxStrokes` in generation
 * order and `texture-crowded` says so: the preview unions the swept cones per stroke, so the cap
 * is also the picture's cost bound.
 */
export const DEFAULT_MAX_TEXTURE_STROKES = 4000;

/** Segments per semicircular bump of a scallop row — 0.019·r chord error. */
export const SCALLOP_ARC_SEGMENTS = 8;

/** Halvings of a boundary-crossing bisection: 24 is ~6e-8 mm on a 1 mm stroke. */
const CLIP_ITERATIONS = 24;

/** How far a stipple stroke's centre may wander from its cell's centre, as a fraction of it. */
const JITTER = 0.35;

/** A clipped run shorter than this is dropped: it is a graze, not a stroke. */
const MIN_STROKE_MM = 1e-3;

const DEG = Math.PI / 180;

/** Where a texture number came from, in the words the row prints. */
export type TextureNumberSource = 'typed' | 'the CAM’s default';

/** The numbers one texture actually runs with — one reading, shared by the plan, row and sheet. */
export interface TextureNumbers {
  pattern: TexturePattern;
  pitchMm: Mm;
  strokeMm: Mm;
  seed: number;
  /** The shape's own depth, mm: every stroke is cut at this floor. */
  depthMm: Mm;
  pitchSource: TextureNumberSource;
  strokeSource: TextureNumberSource;
}

/** Resolve a document marker (or none) into the numbers the pattern runs with. */
export function textureNumbers(mark: TextureMark | undefined, depthMm: Mm): TextureNumbers {
  const pitch = mark?.pitchMm;
  const stroke = mark?.strokeMm;
  const seed = mark?.seed;
  const pitchOk = pitch !== undefined && Number.isFinite(pitch) && pitch > 0;
  const strokeOk = stroke !== undefined && Number.isFinite(stroke) && stroke > 0;
  const seedOk = seed !== undefined && Number.isInteger(seed) && seed >= 0;
  return {
    pattern: mark?.pattern ?? 'stipple',
    pitchMm: pitchOk ? (pitch as number) : DEFAULT_TEXTURE_PITCH_MM,
    strokeMm: strokeOk ? (stroke as number) : DEFAULT_TEXTURE_STROKE_MM,
    seed: seedOk ? (seed as number) : DEFAULT_TEXTURE_SEED,
    depthMm,
    pitchSource: pitchOk ? 'typed' : 'the CAM’s default',
    strokeSource: strokeOk ? 'typed' : 'the CAM’s default',
  };
}

/** The operation (and trace-entry) name for a pattern: what the NC's comment and the sheet read. */
export function textureOperationName(pattern: TexturePattern): string {
  return `Texture ${pattern}`;
}

/** The shape kinds a texture can sit on — the four with one exact inside test, no holes. */
export function textureCarries(kind: string): boolean {
  return kind === 'rect' || kind === 'circle' || kind === 'slot' || kind === 'polygon';
}

/** One texture's derived strokes, in the stock frame. */
export interface TextureStrokes {
  /** One polyline per stroke (stipple: one segment) or clipped run of a row (scallop). */
  paths: [Mm, Mm][][];
  /** True when the pattern wanted more than the cap; the first `maxStrokes` are emitted. */
  capped: boolean;
}

/**
 * Derive a texture's strokes from the shape and its numbers. Pure: the same shape and numbers
 * always give the same paths, in the same order, so the program is byte-identical run to run.
 */
export function textureStrokes(
  shape: EngraveShape,
  numbers: TextureNumbers,
  maxStrokes: number = DEFAULT_MAX_TEXTURE_STROKES,
): TextureStrokes {
  if (!(numbers.depthMm > 0) || !(numbers.pitchMm > 0)) return { paths: [], capped: false };
  const inside = insideOf(shape);
  const box = worldBounds(shape);
  // A stroke's centre can sit half a stroke plus a jittered cell outside the box and still reach
  // in, so the generation window is grown by that reach before the rows/columns are enumerated.
  const reach = numbers.strokeMm / 2 + numbers.pitchMm;
  const minX = box.minX - reach;
  const maxX = box.maxX + reach;
  const minY = box.minY - reach;
  const maxY = box.maxY + reach;

  const paths: [Mm, Mm][][] = [];
  let capped = false;

  /** Clip one candidate polyline and keep its inside runs; false when the cap is reached. */
  const emit = (points: readonly [Mm, Mm][]): boolean => {
    for (const run of clipPolyline(points, inside)) {
      if (run.length < 2 || polylineLength(run) < MIN_STROKE_MM) continue;
      if (paths.length >= maxStrokes) {
        capped = true;
        return false;
      }
      paths.push(run);
    }
    return true;
  };

  if (numbers.pattern === 'scallop') {
    const r = numbers.pitchMm / 2;
    const step = numbers.pitchMm;
    const row0 = Math.floor(minY / step);
    const row1 = Math.ceil(maxY / step);
    outer: for (let row = row0; row <= row1; row++) {
      const cy = row * step;
      // One row is one polyline of chained bumps: bump k spans [k·step − r, k·step + r], and its
      // end point is the next bump's start, so the chain reads as a continuous scalloped line.
      const points: [Mm, Mm][] = [];
      const k0 = Math.floor(minX / step);
      const k1 = Math.ceil(maxX / step);
      for (let k = k0; k <= k1; k++) {
        const cx = k * step;
        for (let s = 0; s <= SCALLOP_ARC_SEGMENTS; s++) {
          if (k > k0 && s === 0) continue;
          const t = Math.PI * (1 - s / SCALLOP_ARC_SEGMENTS);
          points.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
        }
      }
      if (points.length < 2) continue;
      if (!emit(points)) break outer;
    }
    return { paths, capped };
  }

  // Stipple. The grid is anchored to the stock's origin, not to the region: a cell's numbers are a
  // HASH of the seed and the cell's absolute indices, so the pattern cannot reshuffle when the
  // region moves or shrinks, and the surviving strokes of a smaller region are a subset of a
  // larger one's (clip aside).
  const cell = numbers.pitchMm;
  const i0 = Math.floor(minX / cell);
  const i1 = Math.ceil(maxX / cell);
  const j0 = Math.floor(minY / cell);
  const j1 = Math.ceil(maxY / cell);
  const half = numbers.strokeMm / 2;
  outer: for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const rng = cellRandom(numbers.seed, i, j);
      const cx = (i + 0.5 + (rng() - 0.5) * 2 * JITTER) * cell;
      const cy = (j + 0.5 + (rng() - 0.5) * 2 * JITTER) * cell;
      const angle = rng() * Math.PI;
      const dx = Math.cos(angle) * half;
      const dy = Math.sin(angle) * half;
      if (!emit([[cx - dx, cy - dy], [cx + dx, cy + dy]])) break outer;
    }
  }
  return { paths, capped };
}

/**
 * A cell's own random stream: `mulberry32` seeded by a hash of (seed, i, j). The hash, not the
 * stream's position, is what makes the pattern a function of the CELL — see the header.
 */
function cellRandom(seed: number, i: number, j: number): () => number {
  let h = (seed ^ Math.imul(i, 0x9e3779b1) ^ Math.imul(j, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return mulberry32((h ^ (h >>> 15)) >>> 0);
}

/** `mulberry32` — a small, fast, fully deterministic PRNG. The document stores only the seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The region's exact inside test, in the shape's own local frame (rotation undone). */
function insideOf(shape: EngraveShape): (x: number, y: number) => boolean {
  const c = Math.cos(shape.rotation * DEG);
  const s = Math.sin(shape.rotation * DEG);
  const px = shape.position.x;
  const py = shape.position.y;
  const local = (x: number, y: number): [number, number] => {
    const dx = x - px;
    const dy = y - py;
    return [dx * c + dy * s, -dx * s + dy * c];
  };
  switch (shape.kind) {
    case 'rect': {
      const hw = Math.abs(shape.width) / 2;
      const hh = Math.abs(shape.height) / 2;
      const r = Math.max(0, Math.min(shape.cornerRadius, Math.min(hw, hh)));
      return (x, y) => {
        const [lx, ly] = local(x, y);
        if (Math.abs(lx) > hw || Math.abs(ly) > hh) return false;
        if (r <= 0) return true;
        const qx = Math.abs(lx) - (hw - r);
        const qy = Math.abs(ly) - (hh - r);
        return !(qx > 0 && qy > 0) || Math.hypot(qx, qy) <= r;
      };
    }
    case 'circle': {
      const rad = Math.abs(shape.diameter) / 2;
      return (x, y) => {
        const [lx, ly] = local(x, y);
        return Math.hypot(lx, ly) <= rad;
      };
    }
    case 'slot': {
      // A stadium: overall `length`, end radius `width / 2`, centred on the shape's position.
      const rad = Math.abs(shape.width) / 2;
      const halfCentre = Math.max(0, (Math.abs(shape.length) - Math.abs(shape.width)) / 2);
      return (x, y) => {
        const [lx, ly] = local(x, y);
        const nx = Math.max(-halfCentre, Math.min(halfCentre, lx));
        return Math.hypot(lx - nx, ly) <= rad;
      };
    }
    case 'polygon': {
      const ring = shape.points;
      return (x, y) => {
        const [lx, ly] = local(x, y);
        // Even-odd ray cast. A self-intersecting polygon is refused before a texture is derived
        // (`polygon-self-intersecting`), so the fill rule cannot disagree with the profile there.
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i]!;
          const [xj, yj] = ring[j]!;
          if (yi > ly !== yj > ly && lx < ((xj - xi) * (ly - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      };
    }
  }
}

/** The shape's axis-aligned bounding box in the STOCK frame (rotation applied). */
function worldBounds(shape: EngraveShape): { minX: number; maxX: number; minY: number; maxY: number } {
  let corners: [number, number][];
  switch (shape.kind) {
    case 'rect': {
      const hw = Math.abs(shape.width) / 2;
      const hh = Math.abs(shape.height) / 2;
      corners = [
        [-hw, -hh],
        [hw, -hh],
        [hw, hh],
        [-hw, hh],
      ];
      break;
    }
    case 'circle': {
      const r = Math.abs(shape.diameter) / 2;
      corners = [
        [-r, -r],
        [r, -r],
        [r, r],
        [-r, r],
      ];
      break;
    }
    case 'slot': {
      const hl = Math.abs(shape.length) / 2;
      const hw = Math.abs(shape.width) / 2;
      corners = [
        [-hl, -hw],
        [hl, -hw],
        [hl, hw],
        [-hl, hw],
      ];
      break;
    }
    case 'polygon':
      corners = shape.points.map(([x, y]) => [x, y] as [number, number]);
      break;
  }
  const c = Math.cos(shape.rotation * DEG);
  const s = Math.sin(shape.rotation * DEG);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [lx, ly] of corners) {
    const x = shape.position.x + lx * c - ly * s;
    const y = shape.position.y + lx * s + ly * c;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Split one candidate polyline into the runs that lie inside the region. Each run starts and ends
 * at a point the inside test HOLDS (the bisection keeps the inside end), so clipping never leaves
 * a stroke point over the rim.
 */
function clipPolyline(
  points: readonly [Mm, Mm][],
  inside: (x: number, y: number) => boolean,
): [Mm, Mm][][] {
  if (points.length < 2) return [];
  const runs: [Mm, Mm][][] = [];
  let run: [Mm, Mm][] = [];
  let prev = points[0]!;
  let prevIn = inside(prev[0], prev[1]);
  if (prevIn) run.push([prev[0], prev[1]]);
  for (let i = 1; i < points.length; i++) {
    const cur = points[i]!;
    const curIn = inside(cur[0], cur[1]);
    if (curIn !== prevIn) {
      const boundary = prevIn ? bisectInside(prev, cur, inside) : bisectInside(cur, prev, inside);
      if (prevIn) {
        run.push(boundary);
        runs.push(run);
        run = [];
      } else {
        run = [boundary, [cur[0], cur[1]]];
      }
    } else if (curIn) {
      run.push([cur[0], cur[1]]);
    }
    prev = cur;
    prevIn = curIn;
  }
  if (run.length > 0) runs.push(run);
  return runs.filter((r) => r.length >= 2);
}

/** The point nearest the boundary on the INSIDE of the segment `insidePoint → outsidePoint`. */
function bisectInside(
  insidePoint: [Mm, Mm],
  outsidePoint: [Mm, Mm],
  inside: (x: number, y: number) => boolean,
): [Mm, Mm] {
  let lo: [number, number] = [insidePoint[0], insidePoint[1]];
  let hi: [number, number] = [outsidePoint[0], outsidePoint[1]];
  for (let i = 0; i < CLIP_ITERATIONS; i++) {
    const mid: [number, number] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
    if (inside(mid[0], mid[1])) lo = mid;
    else hi = mid;
  }
  return lo;
}

function polylineLength(points: readonly [Mm, Mm][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  return total;
}
