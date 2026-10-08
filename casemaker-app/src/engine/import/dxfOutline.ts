import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import type { Vec2, Mm } from '@/types';
import {
  finalizeOutline,
  MAX_OUTLINE_FILE_BYTES,
  type OutlineParseResult,
} from './outlineTypes';

/**
 * DXF outline import (#217), phase two of the vector import: the closed regions of a DXF as
 * flattened rings in mm.
 *
 * IN: `LWPOLYLINE` (closed), `CIRCLE`, and closed chains of `LINE`/`ARC` — joined at shared
 * endpoints. `LWPOLYLINE` bulges (group code 42) are honoured, so a rounded rectangle drawn in
 * Fusion does not silently arrive as a sharp one.
 *
 * OUT, each named in `notes`: open `LWPOLYLINE`s, open `LINE`/`ARC` chains, and any entity type
 * not listed above (old-style `POLYLINE`, `SPLINE`, `ELLIPSE`, …).
 *
 * Units come from `$INSUNITS`; absent or unitless defaults to mm WITH a visible note (#217).
 * DXF's Y axis is already up, so — unlike SVG — there is no flip; the import is recentred on its
 * bounding-box origin by `finalizeOutline`.
 *
 * Hand-rolled, no dependency (the issue forbids adding one without asking): DXF is a flat
 * "group code / value" pair stream, so this reads exactly the codes it needs.
 */

/** DXF `$INSUNITS` code → mm per drawing unit (the standard INSUNITS table, AutoCAD). */
const INSUNITS_MM: Record<number, number> = {
  1: 25.4, // inches
  2: 304.8, // feet
  3: 1609344, // miles
  4: 1, // millimetres
  5: 10, // centimetres
  6: 1000, // metres
  7: 1e6, // kilometres
  8: 2.54e-5, // microinches
  9: 0.0254, // mils
  10: 914.4, // yards
  11: 1e-7, // angstroms
  12: 1e-6, // nanometres
  13: 1e-3, // micrometres
  14: 0.1, // decimetres
  15: 10, // decametres
  16: 1e12, // gigametres
  17: 1.495978707e14, // astronomical units
  18: 9.4607304725808e18, // light years
  19: 3.08567758149137e19, // parsecs
  20: 3.08567758149137e16, // US survey feet
};

/** Default chord error for DXF arcs, mm. PROVISIONAL: the same budget as glyph flattening. */
const DXF_CHORD_TOLERANCE_MM = 0.02;

/**
 * Endpoints closer than this join into one chain, mm. PROVISIONAL: DXF geometry that shares a
 * vertex usually matches to the file's own precision (far finer); 1 µm absorbs export rounding
 * without bridging genuinely separate loops.
 */
const DXF_JOIN_TOLERANCE_MM = 1e-3;

interface Pair {
  code: number;
  value: string;
}

/** Split a DXF into its (group code, value) pairs, resyncing if a line is not a numeric code. */
function parsePairs(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: Pair[] = [];
  let i = 0;
  while (i < lines.length) {
    const code = parseInt(lines[i]!.trim(), 10);
    if (!Number.isFinite(code) || i + 1 >= lines.length) {
      i++; // not a code line: skip and try again on the next
      continue;
    }
    out.push({ code, value: lines[i + 1]! });
    i += 2;
  }
  return out;
}

function firstValue(pairs: readonly Pair[], code: number): number | null {
  const p = pairs.find((x) => x.code === code);
  if (!p) return null;
  const n = parseFloat(p.value);
  return Number.isFinite(n) ? n : null;
}

/** The groups of one entity, keyed by code (values are positional, so keep the pair list too). */
interface Entity {
  type: string;
  pairs: Pair[];
}

/** Every entity in the ENTITIES section, split on each `0/<TYPE>` record. */
function readEntities(pairs: readonly Pair[]): Entity[] {
  // Locate the ENTITIES section: `0/SECTION` immediately followed by `2/ENTITIES`.
  let start = -1;
  for (let i = 0; i + 1 < pairs.length; i++) {
    if (pairs[i]!.code === 0 && pairs[i]!.value === 'SECTION' && pairs[i + 1]!.code === 2 && pairs[i + 1]!.value.trim() === 'ENTITIES') {
      start = i + 2;
      break;
    }
  }
  if (start < 0) return [];

  const entities: Entity[] = [];
  let cur: Entity | null = null;
  for (let i = start; i < pairs.length; i++) {
    const p = pairs[i]!;
    if (p.code === 0) {
      if (p.value === 'ENDSEC') break;
      cur = { type: p.value.trim().toUpperCase(), pairs: [] };
      entities.push(cur);
      continue;
    }
    cur?.pairs.push(p);
  }
  return entities;
}

function insUnitsMm(pairs: readonly Pair[], notes: string[]): number {
  const idx = pairs.findIndex((p) => p.code === 9 && p.value.trim() === '$INSUNITS');
  const code = idx >= 0 ? pairs[idx + 1] : undefined;
  const n = code ? parseInt(code.value.trim(), 10) : NaN;
  if (code && code.code === 70 && Number.isFinite(n) && n !== 0) {
    const mm = INSUNITS_MM[n];
    if (mm !== undefined) return mm;
  }
  notes.push('DXF has no usable $INSUNITS; assuming millimetres.');
  return 1;
}

/** Points along an arc sampled within `tol`, endpoints included, counter-clockwise. */
function arcPoints(cx: number, cy: number, r: number, a0Deg: number, a1Deg: number, tol: number): Vec2[] {
  const a0 = (a0Deg * Math.PI) / 180;
  let a1 = (a1Deg * Math.PI) / 180;
  while (a1 < a0) a1 += 2 * Math.PI;
  const sweep = a1 - a0;
  const ratio = r > 0 ? tol / r : 1;
  const step = ratio >= 1 ? Math.PI / 4 : 2 * Math.acos(1 - ratio);
  const n = Math.min(2048, Math.max(1, Math.ceil(sweep / step)));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + (sweep * i) / n;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return out;
}

/**
 * The points of a `LWPOLYLINE` bulge arc between `p0` and `p1` (both endpoints EXCLUDED — the
 * caller already holds the vertices). Bulge is tan(θ/4), sign = direction; a zero bulge is a line.
 */
function bulgeArc(p0: Vec2, p1: Vec2, bulge: number, tol: number): Vec2[] {
  if (Math.abs(bulge) < 1e-12) return [];
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const chord = Math.hypot(dx, dy);
  if (chord === 0) return [];
  const theta = 4 * Math.atan(bulge);
  const nx = -dy / chord;
  const ny = dx / chord;
  const h = chord / 2 / Math.tan(theta / 2);
  const cx = (p0[0] + p1[0]) / 2 + nx * h;
  const cy = (p0[1] + p1[1]) / 2 + ny * h;
  const r = Math.abs(chord / (2 * Math.sin(theta / 2)));
  const a0 = Math.atan2(p0[1] - cy, p0[0] - cx);
  const ratio = r > 0 ? tol / r : 1;
  const step = ratio >= 1 ? Math.PI / 4 : 2 * Math.acos(1 - ratio);
  const n = Math.min(2048, Math.max(1, Math.ceil(Math.abs(theta) / step)));
  const out: Vec2[] = [];
  for (let i = 1; i < n; i++) {
    const t = a0 + (theta * i) / n;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return out;
}

interface Segment {
  points: Vec2[];
}

function near(a: Vec2, b: Vec2, tol: number): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
}

/** Join segments end-to-end into closed rings; unclosed chains are counted and dropped. */
function joinSegments(segments: Segment[], tol: number): { rings: Vec2[][]; open: number } {
  const remaining = segments.slice();
  const rings: Vec2[][] = [];
  let open = 0;
  while (remaining.length > 0) {
    const chain = remaining.pop()!.points.slice();
    const extendAt = (at: 'end' | 'start'): boolean => {
      const anchor = at === 'end' ? chain[chain.length - 1]! : chain[0]!;
      for (let i = 0; i < remaining.length; i++) {
        const s = remaining[i]!;
        const first = s.points[0]!;
        const last = s.points[s.points.length - 1]!;
        // The points to add, in the order they are added, EXCLUDING the one that coincides with the
        // anchor. Which order is a fact about the side being extended (#294): at the START the new
        // points are prepended, so they must read toward the anchor; at the END they are appended, so
        // they must read away from it. A two-point LINE hides the difference — both orders are the
        // same one point — but an ARC does not, and a loop with an arc in it is every filleted outline.
        let joined: Vec2[] | null = null;
        if (near(last, anchor, tol)) {
          // The segment ends at the anchor: it reads toward it as stored, away from it reversed.
          joined = at === 'start' ? s.points.slice(0, -1) : s.points.slice(0, -1).reverse();
        } else if (near(first, anchor, tol)) {
          // The segment begins at the anchor: it reads away from it as stored, toward it reversed.
          joined = at === 'start' ? s.points.slice(1).reverse() : s.points.slice(1);
        }
        if (!joined) continue;
        if (at === 'end') chain.push(...joined);
        else chain.unshift(...joined);
        remaining.splice(i, 1);
        return true;
      }
      return false;
    };
    while (extendAt('end')) {
      /* keep joining */
    }
    while (extendAt('start')) {
      /* keep joining */
    }
    if (chain.length >= 3 && near(chain[0]!, chain[chain.length - 1]!, tol)) {
      chain.pop();
      rings.push(chain);
    } else {
      open++;
    }
  }
  return { rings, open };
}

function lwPolylineRing(e: Entity, tol: number, notes: string[]): Vec2[] | null {
  const flags = firstValue(e.pairs, 70) ?? 0;
  const closed = (flags & 1) !== 0;
  const verts: { x: number; y: number; bulge: number }[] = [];
  let cur: { x: number; y: number; bulge: number } | null = null;
  for (const p of e.pairs) {
    if (p.code === 10) {
      const x = parseFloat(p.value);
      if (!Number.isFinite(x)) continue;
      cur = { x, y: 0, bulge: 0 };
      verts.push(cur);
    } else if (p.code === 20 && cur) {
      const y = parseFloat(p.value);
      if (Number.isFinite(y)) cur.y = y;
    } else if (p.code === 42 && cur) {
      const b = parseFloat(p.value);
      if (Number.isFinite(b)) cur.bulge = b;
    }
  }
  if (!closed || verts.length < 2) {
    if (!closed && verts.length >= 2) notes.push('Skipped an open LWPOLYLINE: only closed regions import.');
    return null;
  }
  const ring: Vec2[] = [];
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i]!;
    ring.push([v.x, v.y]);
    const w = verts[(i + 1) % verts.length]!;
    ring.push(...bulgeArc([v.x, v.y], [w.x, w.y], v.bulge, tol));
  }
  return ring.length >= 3 ? ring : null;
}

/**
 * Parse a DXF document into an outline import. Pure and dependency-free; see the module header
 * for what is in and out of scope.
 */
export function parseDxfOutline(text: string, sourceName = 'outline.dxf'): OutlineParseResult {
  if (text.length >= MAX_OUTLINE_FILE_BYTES) {
    return {
      ok: false,
      error: `The DXF is ${(text.length / (1024 * 1024)).toFixed(1)} MB — larger than the ${
        MAX_OUTLINE_FILE_BYTES / (1024 * 1024)
      } MB import limit.`,
    };
  }

  const pairs = parsePairs(text);
  if (!pairs.some((p) => p.code === 9 && p.value.trim() === '$ACADVER') && !pairs.some((p) => p.code === 0 && p.value === 'SECTION')) {
    return { ok: false, error: 'The file is not a DXF document.' };
  }

  const notes: string[] = [];
  const unitMm = insUnitsMm(pairs, notes);
  const entities = readEntities(pairs);
  const scale = (p: Vec2): Vec2 => [p[0] * unitMm, p[1] * unitMm];

  const rings: Vec2[][] = [];
  const segments: Segment[] = [];
  const unsupported = new Map<string, number>();

  for (const e of entities) {
    switch (e.type) {
      case 'LWPOLYLINE': {
        const ring = lwPolylineRing(e, DXF_CHORD_TOLERANCE_MM / unitMm, notes);
        if (ring) rings.push(ring.map(scale));
        break;
      }
      case 'CIRCLE': {
        const cx = firstValue(e.pairs, 10);
        const cy = firstValue(e.pairs, 20);
        const r = firstValue(e.pairs, 40);
        if (cx === null || cy === null || r === null || !(r > 0)) break;
        const n = segmentsForRadius(r, DXF_CHORD_TOLERANCE_MM / unitMm);
        const ring: Vec2[] = [];
        for (let i = 0; i < n; i++) {
          const t = (2 * Math.PI * i) / n;
          ring.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
        }
        rings.push(ring.map(scale));
        break;
      }
      case 'ARC': {
        const cx = firstValue(e.pairs, 10);
        const cy = firstValue(e.pairs, 20);
        const r = firstValue(e.pairs, 40);
        const a0 = firstValue(e.pairs, 50) ?? 0;
        const a1 = firstValue(e.pairs, 51) ?? 360;
        if (cx === null || cy === null || r === null || !(r > 0)) break;
        segments.push({ points: arcPoints(cx, cy, r, a0, a1, DXF_CHORD_TOLERANCE_MM / unitMm) });
        break;
      }
      case 'LINE': {
        const x1 = firstValue(e.pairs, 10);
        const y1 = firstValue(e.pairs, 20);
        const x2 = firstValue(e.pairs, 11);
        const y2 = firstValue(e.pairs, 21);
        if (x1 === null || y1 === null || x2 === null || y2 === null) break;
        segments.push({ points: [[x1, y1], [x2, y2]] });
        break;
      }
      default:
        unsupported.set(e.type, (unsupported.get(e.type) ?? 0) + 1);
        break;
    }
  }

  if (segments.length > 0) {
    const joined = joinSegments(segments, DXF_JOIN_TOLERANCE_MM / unitMm);
    for (const ring of joined.rings) rings.push(ring.map(scale));
    if (joined.open > 0) {
      notes.push(`Skipped ${joined.open} open LINE/ARC chain${joined.open === 1 ? '' : 's'}: only closed loops import.`);
    }
  }

  if (unsupported.size > 0) {
    const names = [...unsupported.keys()].sort().join(', ');
    notes.push(`Skipped unsupported DXF entities: ${names}.`);
  }

  // DXF has no fill rule; the standard reading of its closed loops is nonzero.
  return finalizeOutline({ format: 'dxf', sourceName, contours: rings as [Mm, Mm][][], fillRule: 'NonZero', notes });
}
