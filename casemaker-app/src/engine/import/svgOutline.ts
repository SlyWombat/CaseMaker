import { GLYPH_CHORD_TOLERANCE_MM } from '@/engine/compiler/glyphs';
import { flattenCubic, flattenQuadratic } from '@/engine/compiler/curveFlatten';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import type { Vec2, Mm } from '@/types';
import { finalizeOutline, MAX_OUTLINE_FILE_BYTES, type OutlineParseResult } from './outlineTypes';

/**
 * SVG outline import (#217): the filled, closed shapes of an SVG as flattened rings in mm.
 *
 * Pure except for the browser's `DOMParser` for the XML, which the issue sanctions. Given the
 * same text it always returns the same rings: no ids, no randomness, no file left behind.
 *
 * IN: `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<polygon>`, with `transform` and nested
 * `<g>`.
 *
 * OUT, each reported in `notes` so the dialog can name it rather than silently dropping it:
 * strokes without fill (a stroked line has no area — that is #219's trace feature), `<text>`,
 * `<image>`, gradients/patterns, clipping and masks, and open paths/subpaths. `<polyline>`,
 * `<line>` and paths that never `Z` are open and are skipped.
 *
 * Coordinates: SVG user units are scaled to mm by the root's `width`/`height` and `viewBox`,
 * falling back to 96 px/inch when neither carries a physical unit. SVG's Y is down and the
 * job's is up, so the result is flipped in Y once, then centred on its bounding-box origin
 * (`EngraveVectorShape` contours are relative to `position`).
 */

/** CSS reference pixel: 96 px = 1 in, so 1 px = 25.4/96 mm. The SVG default when no unit. */
const MM_PER_PX = 25.4 / 96;

/** Absolute length units SVG accepts, as mm per unit (CSS values; px is the 96 dpi pixel). */
const LENGTH_MM: Record<string, number> = {
  mm: 1,
  cm: 10,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
  px: MM_PER_PX,
};

/** One subpath of a `d` attribute, in SVG user units and still Y-down. */
export interface SvgSubpath {
  points: Vec2[];
  /** True when the subpath ended with `Z`/`z` — only closed subpaths are filled regions. */
  closed: boolean;
}

const PATH_ARITY: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

const PATH_TOKEN_RE = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)/g;

/** Split path data into command tokens with their raw argument lists, expanding implicit repeats. */
function tokenizePath(d: string): { cmd: string; args: number[] }[] {
  const raw: (string | number)[] = [];
  let m: RegExpExecArray | null;
  PATH_TOKEN_RE.lastIndex = 0;
  while ((m = PATH_TOKEN_RE.exec(d)) !== null) {
    raw.push(m[1] !== undefined ? m[1] : parseFloat(m[2]!));
  }

  const out: { cmd: string; args: number[] }[] = [];
  let i = 0;
  let cmd = '';
  while (i < raw.length) {
    const tok = raw[i];
    if (typeof tok === 'string') {
      cmd = tok;
      i++;
    } else if (!cmd) {
      throw new Error('path data must begin with a command');
    }
    const up = cmd.toUpperCase();
    if (up === 'Z') {
      out.push({ cmd, args: [] });
      cmd = '';
      continue;
    }
    const arity = PATH_ARITY[up]!;
    const args: number[] = [];
    for (let k = 0; k < arity; k++) {
      const v = raw[i];
      if (typeof v !== 'number') throw new Error(`path data: '${cmd}' needs ${arity} numbers`);
      args.push(v);
      i++;
    }
    out.push({ cmd, args });
    // An `M`/`m` with extra coordinate pairs draws implicit `L`/`l` (SVG path grammar).
    if (up === 'M') cmd = cmd === 'M' ? 'L' : 'l';
  }
  return out;
}

/** Signed angle from vector u to vector v. */
function angleBetween(u: Vec2, v: Vec2): number {
  return Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]);
}

/**
 * An SVG elliptical arc (endpoint parameterisation, SVG 1.1 §F.6.5) as points from `p0`
 * (exclusive) to `p1` (inclusive), within `tol` of the true arc. Degenerate radii or a
 * zero-length arc fall back to a straight segment.
 */
export function flattenArc(
  p0: Vec2,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: Vec2,
  tol: number,
): Vec2[] {
  const [x1, y1] = p0;
  const [x2, y2] = p1;
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [p1];

  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;

  let rx2 = rx * rx;
  let ry2 = ry * ry;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;
  const lambda = x1p2 / rx2 + y1p2 / ry2;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
    rx2 = rx * rx;
    ry2 = ry * ry;
  }

  const num = rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2;
  const den = rx2 * y1p2 + ry2 * x1p2;
  let coef = den > 0 ? Math.sqrt(Math.max(0, num / den)) : 0;
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;

  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = angleBetween([1, 0], [ux, uy]);
  let dTheta = angleBetween([ux, uy], [vx, vy]);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  // Steps per radian from the sagitta target on the larger radius; at least 8 per full circle
  // (matching `segmentsForRadius`'s floor) and bounded so a huge arc cannot ask for millions.
  const rMax = Math.max(rx, ry);
  const ratio = tol / rMax;
  const step = ratio >= 1 ? Math.PI / 4 : 2 * Math.acos(1 - ratio);
  const n = Math.min(2048, Math.max(1, Math.ceil(Math.abs(dTheta) / step)));

  const out: Vec2[] = [];
  for (let i = 1; i <= n; i++) {
    const t = theta1 + (dTheta * i) / n;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    out.push([cos * (rx * ct) - sin * (ry * st) + cx, sin * (rx * ct) + cos * (ry * st) + cy]);
  }
  // Land exactly on the endpoint the caller asked for; the parametrisation can be off by a ulp.
  out[out.length - 1] = p1;
  return out;
}

/**
 * Parse an SVG `d` attribute into subpaths in SVG user units (Y still down). `tolerance` is the
 * chord-error budget in those SAME units, so a caller working in a scaled space divides first.
 */
export function parseSvgPath(d: string, tolerance: number = GLYPH_CHORD_TOLERANCE_MM): SvgSubpath[] {
  const cmds = tokenizePath(d);
  const subs: SvgSubpath[] = [];
  let cur: Vec2 = [0, 0];
  let start: Vec2 = [0, 0];
  let ring: Vec2[] = [];
  let hasSub = false;
  let prevCubicCtrl: Vec2 | null = null;
  let prevQuadCtrl: Vec2 | null = null;

  const pushPoint = (p: Vec2): void => {
    ring.push(p);
    cur = p;
  };
  const begin = (): void => {
    if (!hasSub) {
      ring = [cur];
      hasSub = true;
    }
  };
  const flush = (closed: boolean): void => {
    if (ring.length >= 3) {
      const f = ring[0]!;
      const l = ring[ring.length - 1]!;
      if (ring.length > 3 && f[0] === l[0] && f[1] === l[1]) ring.pop();
    }
    if (ring.length >= 2) subs.push({ points: ring, closed });
    ring = [];
    hasSub = false;
  };

  for (const { cmd, args } of cmds) {
    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    const ax = rel ? cur[0] : 0;
    const ay = rel ? cur[1] : 0;
    switch (up) {
      case 'M': {
        if (hasSub) flush(false);
        const p: Vec2 = [ax + args[0]!, ay + args[1]!];
        start = p;
        ring = [p];
        cur = p;
        hasSub = true;
        prevCubicCtrl = null;
        prevQuadCtrl = null;
        break;
      }
      case 'L': {
        begin();
        pushPoint([ax + args[0]!, ay + args[1]!]);
        prevCubicCtrl = null;
        prevQuadCtrl = null;
        break;
      }
      case 'H': {
        begin();
        pushPoint([ax + args[0]!, cur[1]]);
        prevCubicCtrl = null;
        prevQuadCtrl = null;
        break;
      }
      case 'V': {
        begin();
        pushPoint([cur[0], ay + args[0]!]);
        prevCubicCtrl = null;
        prevQuadCtrl = null;
        break;
      }
      case 'C': {
        const c1: Vec2 = [ax + args[0]!, ay + args[1]!];
        const c2: Vec2 = [ax + args[2]!, ay + args[3]!];
        const p: Vec2 = [ax + args[4]!, ay + args[5]!];
        begin();
        for (const q of flattenCubic(cur, c1, c2, p, tolerance)) pushPoint(q);
        prevCubicCtrl = c2;
        prevQuadCtrl = null;
        break;
      }
      case 'S': {
        const c1: Vec2 = prevCubicCtrl
          ? [2 * cur[0] - prevCubicCtrl[0], 2 * cur[1] - prevCubicCtrl[1]]
          : cur;
        const c2: Vec2 = [ax + args[0]!, ay + args[1]!];
        const p: Vec2 = [ax + args[2]!, ay + args[3]!];
        begin();
        for (const q of flattenCubic(cur, c1, c2, p, tolerance)) pushPoint(q);
        prevCubicCtrl = c2;
        prevQuadCtrl = null;
        break;
      }
      case 'Q': {
        const c1: Vec2 = [ax + args[0]!, ay + args[1]!];
        const p: Vec2 = [ax + args[2]!, ay + args[3]!];
        begin();
        for (const q of flattenQuadratic(cur, c1, p, tolerance)) pushPoint(q);
        prevQuadCtrl = c1;
        prevCubicCtrl = null;
        break;
      }
      case 'T': {
        const c1: Vec2 = prevQuadCtrl
          ? [2 * cur[0] - prevQuadCtrl[0], 2 * cur[1] - prevQuadCtrl[1]]
          : cur;
        const p: Vec2 = [ax + args[0]!, ay + args[1]!];
        begin();
        for (const q of flattenQuadratic(cur, c1, p, tolerance)) pushPoint(q);
        prevQuadCtrl = c1;
        prevCubicCtrl = null;
        break;
      }
      case 'A': {
        const p: Vec2 = [ax + args[5]!, ay + args[6]!];
        begin();
        const arc = flattenArc(cur, args[0]!, args[1]!, args[2]!, args[3]! === 1, args[4]! === 1, p, tolerance);
        for (const q of arc) pushPoint(q);
        prevCubicCtrl = null;
        prevQuadCtrl = null;
        break;
      }
      case 'Z': {
        if (hasSub) {
          flush(true);
          cur = start;
        }
        prevCubicCtrl = null;
        prevQuadCtrl = null;
        break;
      }
      default:
        break;
    }
  }
  if (hasSub) flush(false);
  return subs;
}

/* ---------------------------------------------------------------------------------------------
 * Transform composition (SVG 1.1 §7): a 2×3 affine matrix [a b c d e f].
 * -------------------------------------------------------------------------------------------*/

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** `m · n` — n applied to a point first, then m. */
function matMul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function applyMat(m: Mat, p: Vec2): Vec2 {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

const TRANSFORM_RE = /([a-zA-Z]+)\s*\(([^)]*)\)/g;

function transformFn(name: string, a: number[]): Mat {
  const deg = (d: number): number => (d * Math.PI) / 180;
  switch (name) {
    case 'translate':
      return [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
    case 'scale': {
      const sx = a[0] ?? 1;
      return [sx, 0, 0, a[1] ?? sx, 0, 0];
    }
    case 'rotate': {
      const r = deg(a[0] ?? 0);
      const c = Math.cos(r);
      const s = Math.sin(r);
      const cx = a[1] ?? 0;
      const cy = a[2] ?? 0;
      return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
    }
    case 'matrix':
      return [a[0] ?? 1, a[1] ?? 0, a[2] ?? 0, a[3] ?? 1, a[4] ?? 0, a[5] ?? 0];
    case 'skewX':
      return [1, 0, Math.tan(deg(a[0] ?? 0)), 1, 0, 0];
    case 'skewY':
      return [1, Math.tan(deg(a[0] ?? 0)), 0, 1, 0, 0];
    default:
      return IDENTITY;
  }
}

/** Parse a `transform` attribute into one matrix, applied left to right. */
function parseTransform(value: string | null): Mat {
  if (!value) return IDENTITY;
  let m: Mat = IDENTITY;
  TRANSFORM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TRANSFORM_RE.exec(value)) !== null) {
    const nums = match[2]!
      .split(/[\s,]+/)
      .filter((s) => s.length > 0)
      .map(Number);
    m = matMul(m, transformFn(match[1]!, nums));
  }
  return m;
}

/** Approximate uniform scale a matrix applies, from |det| — for choosing a local chord tolerance. */
function matScale(m: Mat): number {
  const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
  return det > 0 ? Math.sqrt(det) : 1;
}

/* ---------------------------------------------------------------------------------------------
 * Document walk
 * -------------------------------------------------------------------------------------------*/

interface Length {
  value: number;
  unit: string;
  mm: number;
}

/** Parse an SVG length. `mm` uses the CSS factor (px = 96 dpi); a `%` length is unusable here. */
function parseLength(value: string | null): Length | null {
  if (!value) return null;
  const m = /^\s*([+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)\s*([a-z%]*)\s*$/.exec(value);
  if (!m) return null;
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === '%') return null;
  const v = parseFloat(m[1]!);
  const factor = LENGTH_MM[unit] ?? MM_PER_PX; // no unit = px, like CSS
  return { value: v, unit: unit || 'px', mm: v * factor };
}

interface ViewTransform {
  scale: number;
  originX: number;
  originY: number;
  /** True when no physical unit was found, so 96 dpi was assumed. */
  assumedPx: boolean;
}

/** Resolve the root's `width`/`height`/`viewBox` to a user-unit → mm scale and a viewBox origin. */
function resolveViewTransform(root: Element, notes: string[]): ViewTransform {
  const w = parseLength(root.getAttribute('width'));
  const h = parseLength(root.getAttribute('height'));
  const vbRaw = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const vb = vbRaw.length === 4 && vbRaw.every(Number.isFinite) ? vbRaw : null;

  // A viewBox is what maps user units to the viewport: without it the user unit IS the CSS
  // pixel regardless of the `width` attribute (SVG 1.1 §7.7), so `width` alone sets no scale.
  let scale: number | null = null;
  if (vb && vb[2]! > 0) {
    if (w && w.value > 0) scale = w.mm / vb[2]!;
    if (h && h.value > 0 && vb[3]! > 0) {
      const sy = h.mm / vb[3]!;
      scale = scale === null ? sy : Math.min(scale, sy); // preserveAspectRatio default is uniform
    }
  }

  const physical = (l: Length | null): boolean => !!l && l.unit !== 'px';
  const assumedPx = !physical(w) && !physical(h);
  if (assumedPx) {
    notes.push('SVG has no physical size; assuming 96 px/inch (1 px = 0.2646 mm).');
  }
  return {
    scale: scale && scale > 0 ? scale : MM_PER_PX,
    originX: vb?.[0] ?? 0,
    originY: vb?.[1] ?? 0,
    assumedPx,
  };
}

/** Read an element's `style` attribute into a property map. */
function styleOf(el: Element): Map<string, string> {
  const out = new Map<string, string>();
  const style = el.getAttribute('style');
  if (!style) return out;
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    out.set(decl.slice(0, idx).trim().toLowerCase(), decl.slice(idx + 1).trim());
  }
  return out;
}

/** A presentation property: attribute wins, then inline style, then the inherited value. */
function prop(el: Element, style: Map<string, string>, name: string, inherited: string | undefined): string | undefined {
  const attr = el.getAttribute(name);
  if (attr !== null) return attr;
  const s = style.get(name);
  if (s !== undefined) return s;
  return inherited;
}

/** Has this element's own (non-inherited) `clip-path`/`mask`? */
function hasClipOrMask(el: Element, style: Map<string, string>): boolean {
  return (
    el.getAttribute('clip-path') !== null ||
    el.getAttribute('mask') !== null ||
    style.has('clip-path') ||
    style.has('mask')
  );
}

function circlePoints(cx: number, cy: number, rx: number, ry: number, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

function ellipseArcPoints(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  a0: number,
  a1: number,
  n: number,
): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + ((a1 - a0) * i) / n;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

function num(el: Element, name: string, fallback = 0): number {
  const v = el.getAttribute(name);
  if (v === null) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function parsePointsAttr(value: string | null): Vec2[] {
  if (!value) return [];
  const nums = value
    .trim()
    .split(/[\s,]+/)
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i]!, nums[i + 1]!]);
  return out;
}

interface Collector {
  collected: { points: Vec2[]; rule: 'NonZero' | 'EvenOdd' }[];
  rules: Set<'NonZero' | 'EvenOdd'>;
  notes: string[];
  strokes: number;
  openPaths: number;
  sawCss: boolean;
}

function fillRuleOf(value: string | undefined): 'NonZero' | 'EvenOdd' {
  return value?.toLowerCase() === 'evenodd' ? 'EvenOdd' : 'NonZero';
}

function shapeRings(el: Element, node: string, tol: number, notes: string[]): Vec2[][] {
  switch (node) {
    case 'rect': {
      const x = num(el, 'x');
      const y = num(el, 'y');
      const w = num(el, 'width');
      const h = num(el, 'height');
      if (!(w > 0) || !(h > 0)) return [];
      const rxRaw = el.getAttribute('rx');
      const ryRaw = el.getAttribute('ry');
      const rx = Math.min(rxRaw !== null ? num(el, 'rx') : ryRaw !== null ? num(el, 'ry') : 0, w / 2);
      const ry = Math.min(ryRaw !== null ? num(el, 'ry') : rxRaw !== null ? num(el, 'rx') : 0, h / 2);
      if (!(rx > 0) && !(ry > 0)) return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];
      const n = Math.max(2, Math.ceil(segmentsForRadius(Math.max(rx, ry), tol) / 4));
      const ring: Vec2[] = [
        [x + rx, y],
        [x + w - rx, y],
        ...ellipseArcPoints(x + w - rx, y + ry, rx, ry, -Math.PI / 2, 0, n),
        [x + w, y + h - ry],
        ...ellipseArcPoints(x + w - rx, y + h - ry, rx, ry, 0, Math.PI / 2, n),
        [x + rx, y + h],
        ...ellipseArcPoints(x + rx, y + h - ry, rx, ry, Math.PI / 2, Math.PI, n),
        [x, y + ry],
        ...ellipseArcPoints(x + rx, y + ry, rx, ry, Math.PI, (3 * Math.PI) / 2, n),
      ];
      return [ring];
    }
    case 'circle': {
      const cx = num(el, 'cx');
      const cy = num(el, 'cy');
      const r = num(el, 'r');
      if (!(r > 0)) return [];
      return [circlePoints(cx, cy, r, r, segmentsForRadius(r, tol))];
    }
    case 'ellipse': {
      const cx = num(el, 'cx');
      const cy = num(el, 'cy');
      const rx = num(el, 'rx');
      const ry = num(el, 'ry');
      if (!(rx > 0) || !(ry > 0)) return [];
      return [circlePoints(cx, cy, rx, ry, segmentsForRadius(Math.max(rx, ry), tol))];
    }
    case 'polygon': {
      const pts = parsePointsAttr(el.getAttribute('points'));
      return pts.length >= 3 ? [pts] : [];
    }
    case 'path': {
      const subs = parseSvgPath(el.getAttribute('d') ?? '', tol);
      const rings: Vec2[][] = [];
      for (const sub of subs) {
        if (!sub.closed) {
          notes.push('Skipped an open subpath: only closed, filled shapes import.');
          continue;
        }
        if (sub.points.length >= 3) rings.push(sub.points);
      }
      return rings;
    }
    default:
      return [];
  }
}

function walk(el: Element, parentM: Mat, view: ViewTransform, inherited: {
  fill?: string;
  fillRule?: string;
  stroke?: string;
}, c: Collector): void {
  const style = styleOf(el);
  const display = prop(el, style, 'display', undefined);
  if (display === 'none') return;

  const localM = matMul(parentM, parseTransform(el.getAttribute('transform')));
  const fill = prop(el, style, 'fill', inherited.fill);
  const fillRule = prop(el, style, 'fill-rule', inherited.fillRule);
  const stroke = prop(el, style, 'stroke', inherited.stroke);
  const childInherited = { fill, fillRule, stroke };

  const node = el.localName;
  // Never render defs/gradients/templates: they are referenced, not drawn, and we resolve no
  // references. A <style> block also means CSS we do not evaluate.
  if (node === 'style') {
    c.sawCss = true;
    return;
  }
  if (
    node === 'defs' ||
    node === 'symbol' ||
    node === 'clipPath' ||
    node === 'mask' ||
    node === 'pattern' ||
    node === 'marker' ||
    node === 'linearGradient' ||
    node === 'radialGradient' ||
    node === 'filter' ||
    node === 'script' ||
    node === 'title' ||
    node === 'desc' ||
    node === 'metadata'
  ) {
    return;
  }
  if (node === 'text' || node === 'tspan' || node === 'textPath') {
    c.notes.push('Skipped <text>: convert text to outlines in the drawing program first.');
    return;
  }
  if (node === 'image') {
    c.notes.push('Skipped <image>: raster images are not vector outlines.');
    return;
  }
  if (node === 'use') {
    c.notes.push('Skipped <use>: referenced content is not resolved.');
    return;
  }
  if (node === 'g' || node === 'a' || node === 'svg') {
    for (const child of Array.from(el.children)) walk(child, localM, view, childInherited, c);
    return;
  }

  if (node === 'polyline' || node === 'line') {
    c.openPaths++;
    c.notes.push('Skipped an open path (<polyline>/<line>): only closed, filled shapes import.');
    return;
  }

  const shapeNodes = node === 'path' || node === 'rect' || node === 'circle' || node === 'ellipse' || node === 'polygon';
  if (!shapeNodes) return;

  if (hasClipOrMask(el, style)) {
    c.notes.push('Skipped a clipped or masked shape: clipping and masks are not supported.');
    return;
  }

  const effectiveFill = fill === undefined ? '#000000' : fill;
  if (effectiveFill === 'none') {
    if (stroke !== undefined && stroke !== 'none') {
      c.strokes++;
      c.notes.push('Skipped a stroke without fill: a stroked line has no area (that is the trace feature).');
    }
    return;
  }
  if (effectiveFill.startsWith('url(')) {
    c.notes.push('Fill is a gradient or pattern; the outline is cut, the colour is not.');
  }

  // Chord tolerance in the shape's LOCAL units, so a later `scale()` transform does not inflate
  // the error past GLYPH_CHORD_TOLERANCE_MM in the finished outline.
  const localScale = view.scale * matScale(localM);
  const tol = localScale > 0 ? GLYPH_CHORD_TOLERANCE_MM / localScale : GLYPH_CHORD_TOLERANCE_MM;

  const rule = fillRuleOf(fillRule);
  for (const ring of shapeRings(el, node, tol, c.notes)) {
    const placed = ring.map((p) => applyMat(localM, p));
    c.collected.push({ points: placed, rule });
    c.rules.add(rule);
  }
}

/**
 * Parse an SVG document into an outline import. Pure: the only ambient dependency is the
 * browser `DOMParser` for the XML. See the module header for what is in and out of scope.
 */
export function parseSvgOutline(text: string, sourceName = 'outline.svg'): OutlineParseResult {
  // Refuse an oversized file before the XML parser ever sees it (#217).
  if (text.length >= MAX_OUTLINE_FILE_BYTES) {
    return {
      ok: false,
      error: `The SVG is ${(text.length / (1024 * 1024)).toFixed(1)} MB — larger than the ${
        MAX_OUTLINE_FILE_BYTES / (1024 * 1024)
      } MB import limit.`,
    };
  }
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    return { ok: false, error: 'The SVG could not be parsed: it is not well-formed XML.' };
  }
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg') {
    return { ok: false, error: 'The file is not an SVG document (no <svg> root).' };
  }

  const notes: string[] = [];
  const view = resolveViewTransform(root, notes);
  const c: Collector = { collected: [], rules: new Set(), notes, strokes: 0, openPaths: 0, sawCss: false };
  walk(root, IDENTITY, view, {}, c);

  if (c.sawCss) {
    c.notes.push('The SVG has a <style> block; CSS rules are ignored, only presentation attributes are read.');
  }

  // SVG user units → mm, Y flipped (SVG is Y-down, the job is Y-up), then centred by finalize.
  const contours: [Mm, Mm][][] = c.collected.map(({ points }) =>
    points.map(([x, y]): [Mm, Mm] => [(x - view.originX) * view.scale, -(y - view.originY) * view.scale]),
  );

  let fillRule: 'NonZero' | 'EvenOdd' = 'NonZero';
  if (c.rules.size === 1) fillRule = [...c.rules][0]!;
  else if (c.rules.size > 1) {
    c.notes.push('Shapes use mixed fill rules; the outline is read as NonZero.');
  }

  const deduped = [...new Set(c.notes)];
  return finalizeOutline({ format: 'svg', sourceName, contours, fillRule, notes: deduped });
}
