/**
 * #1141 phase 2a — THE CUT-SWATH OVERLAY'S CORE.
 *
 * What the controller gives us: the `?` reply's `P:<line>,<percent>,…` while a program runs, where
 * `<line>` is the PHYSICAL 1-based source line of the file being played (bench-proved: a 34-line
 * air program read `P:34` at 100 %, and its six `G1`s at their own lines). Plus `WPos`, the physical
 * tip. What we need: the cutting moves the program has made so far, and never one more.
 *
 * THE RULING (2026-11-09): draw the program's line-labelled cutting moves up to the reported line;
 * the WPos cap is ALWAYS on — the swath never passes the segment holding the live tip, even when the
 * reported line runs ahead of the physical cut; a line drop resets the overlay (a retry); and
 * nothing clears on a mid-job `Idle` at `M05` or a missing `P:` — those are holds.
 *
 * This module is pure geometry and arithmetic: the component that draws it decides the colour and
 * the plane (the uncut blank is opaque, so the ribbon is lifted onto its top face; the segment's own
 * Z is what the pure side keeps, and the lift is the caller's).
 */
import { parseGcode } from '@/engine/cnc/gcode/interpreter';

export interface SwathPoint {
  x: number;
  y: number;
  z: number;
}

export interface SwathSegment {
  /** The 1-based source line the move came from. */
  line: number;
  /** True when the move cuts; rapids are kept for the tip search, never drawn. */
  cut: boolean;
  from: SwathPoint;
  to: SwathPoint;
}

export interface SwathIndex {
  segments: SwathSegment[];
}

/** How far the tip may sit from a segment and still be ON it, mm (the tip is the tool centre). */
export const SWATH_TIP_TOLERANCE_MM = 2;

const point = (p: readonly [number | null, number | null, number | null]): SwathPoint | null =>
  p[0] === null || p[1] === null || p[2] === null ? null : { x: p[0], y: p[1], z: p[2] };

/**
 * The posted program as line-labelled work-frame moves. The parser is the app's own interpreter
 * (`parseGcode`, the Z1 dialect); a move whose position the program has not established is skipped
 * (it cannot be drawn), and arcs arrive tessellated with their arc's own line.
 */
export function buildSwathIndex(nc: string): SwathIndex {
  const parsed = parseGcode(nc, { dialect: 'z1' });
  const segments: SwathSegment[] = [];
  for (const event of parsed.events) {
    if (event.kind !== 'move' || event.frame !== 'work') continue;
    const from = point(event.from);
    const to = point(event.to);
    if (from === null || to === null) continue;
    segments.push({ line: event.line, cut: event.mode === 'cut', from, to });
  }
  return { segments };
}

/** One step of the overlay's state machine: hold, or draw (reset first when the line dropped). */
export type SwathStep =
  | { kind: 'hold' }
  | {
      kind: 'draw';
      /** The reported line dropped: the caller clears what it drew and repaints from the start. */
      reset: boolean;
      /** Every cutting move with `line > (reset ? -∞ : lastLine)` and `line <= throughLine`. */
      throughLine: number;
    };

/** Distance from `p` to the segment `a–b`, mm. */
function distanceToSegment(p: SwathPoint, a: SwathPoint, b: SwathPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / len2));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const cz = a.z + t * dz;
  return Math.hypot(p.x - cx, p.y - cy, p.z - cz);
}

/**
 * The line of the segment holding the live tip, or null when no segment within `maxLine` is within
 * {@link SWATH_TIP_TOLERANCE_MM}. The tip is the tool centre: it lies ON the program's path, so a
 * millimetre band around the geometry is the honest locator.
 */
export function tipLine(index: SwathIndex, wpos: SwathPoint, maxLine: number): number | null {
  let best: { line: number; distance: number } | null = null;
  for (const segment of index.segments) {
    if (segment.line > maxLine) continue;
    const distance = distanceToSegment(wpos, segment.from, segment.to);
    if (distance > SWATH_TIP_TOLERANCE_MM) continue;
    if (best === null || distance <= best.distance) best = { line: segment.line, distance };
  }
  return best === null ? null : best.line;
}

/**
 * One tick's decision. `lastLine` is the last line the caller has drawn (null before the first
 * draw); `reportedLine` is `P:` field 1; `wpos` is the live tip in the work frame.
 *
 * - A missing `P:` holds (nothing clears): a heartbeat gap or the firmware's mid-job `Idle` at
 *   `M05` must not wipe the picture.
 * - A reported line the tip cannot be located on holds — the cap is always on, and drawing past a
 *   tip we cannot find would break it.
 * - A line drop draws again from the program's start (`reset`), up to the tip.
 * - Otherwise the swath advances to `min(reportedLine, tipLine)`.
 */
export function swathStep(
  lastLine: number | null,
  reportedLine: number | null,
  wpos: SwathPoint | null,
  index: SwathIndex,
): SwathStep {
  if (reportedLine === null || reportedLine <= 0) return { kind: 'hold' };
  const reset = lastLine !== null && reportedLine < lastLine;
  if (wpos === null) return { kind: 'hold' };
  const tip = tipLine(index, wpos, reportedLine);
  if (tip === null) return { kind: 'hold' };
  const throughLine = Math.min(reportedLine, tip);
  if (reset) return { kind: 'draw', reset: true, throughLine };
  if (lastLine !== null && throughLine <= lastLine) return { kind: 'hold' };
  return { kind: 'draw', reset: false, throughLine };
}

/**
 * The ribbon's triangles for every cutting move with `line > afterLine` (all of them when
 * `afterLine` is null) and `line <= throughLine`, each widened to the cutter's radius. A plunge
 * (no XY length) has no surface footprint and draws nothing; `liftZ` puts the whole ribbon on one
 * plane (the caller's top-face overlay) while every other coordinate stays the program's own.
 * Positions are a flat xyz array, six vertices per segment (two triangles).
 */
export function swathQuads(
  index: SwathIndex,
  afterLine: number | null,
  throughLine: number,
  radiusMm: number,
  liftZ?: number,
): Float32Array {
  const out: number[] = [];
  const z = (v: number): number => (liftZ === undefined ? v : liftZ);
  for (const segment of index.segments) {
    if (!segment.cut) continue;
    if (segment.line > throughLine) continue;
    if (afterLine !== null && segment.line <= afterLine) continue;
    const dx = segment.to.x - segment.from.x;
    const dy = segment.to.y - segment.from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue; // a plunge: no XY footprint to draw
    const nx = (-dy / len) * radiusMm;
    const ny = (dx / len) * radiusMm;
    const a = segment.from;
    const b = segment.to;
    // Two triangles: a−n, a+n, b+n and a−n, b+n, b−n.
    out.push(a.x - nx, a.y - ny, z(a.z), a.x + nx, a.y + ny, z(a.z), b.x + nx, b.y + ny, z(b.z));
    out.push(a.x - nx, a.y - ny, z(a.z), b.x + nx, b.y + ny, z(b.z), b.x - nx, b.y - ny, z(b.z));
  }
  return new Float32Array(out);
}
