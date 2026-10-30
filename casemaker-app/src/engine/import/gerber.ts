/**
 * Gerber (RS-274X) copper import (#743 P-2) — a PCB layer's artwork as rings in mm.
 *
 * WHY OUR OWN PARSER (design D3). It sits beside `svgOutline.ts` and `dxfOutline.ts`: a pure
 * function, no dependency, and every refusal is ours to word. The subset is what KiCad writes, and
 * anything outside it is REFUSED BY NAME with the file's own line — nothing is silently dropped.
 *
 * WHAT IS READ. `%FS%` (format, zero suppression, absolute or incremental coordinates),
 * `%MO%` (mm or inch), `%AD%` apertures C, R, O, P and macro apertures, `%AM%` macros with
 * primitives 1 (circle), 4 (outline), 5 (polygon), 20 (vector line) and 21 (centre line), their
 * arithmetic (`$n`, `+ − x /`, parentheses and assignments), `D01`/`D02`/`D03`, `G01`/`G02`/`G03`
 * with multi-quadrant arcs, regions `G36`/`G37`, and polarity `%LPD%`/`%LPC%`. Arcs are chorded to
 * the shop's `import.dxfChordToleranceMm`, the same tolerance the DXF reader uses.
 *
 * WHAT A SHAPE IS. One drawn object: a flash, one stroked segment, or one region. Its
 * `polarity` says whether it adds copper or clears it, and its `fillRule` is EvenOdd for a region
 * (whose inner contours are holes) and NonZero for a flash or a stroke. The ORDER is the file's,
 * and {@link mergeGerberShapes} applies it: dark adds, clear subtracts.
 *
 * A STROKE IS THE APERTURE SWEPT ALONG THE SEGMENT. For a convex aperture that is exactly the
 * convex hull of its two placements, which is what this builds. A MACRO aperture may be concave;
 * its stroke is then taken as the hull too, and the read reports a note saying so — the hull is
 * never smaller than the true sweep, and a copper layer that is too large is the safe direction
 * for the layer the isolation is built around.
 *
 * UNITS. `%MOIN%` scales every coordinate, aperture size and macro parameter by 25.4 on the way in;
 * the output is millimetres, like every other importer.
 */

import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import { MAX_OUTLINE_CONTOURS, MAX_OUTLINE_POINTS } from './outlineTypes';

/** Default chord error for arcs, mm — the labelled fallback of `import.dxfChordToleranceMm`. */
export const GERBER_CHORD_TOLERANCE_FALLBACK_MM = 0.02;

/**
 * The chord error a CURVE may have as a fraction of its own radius, at most. The shop's tolerance
 * is an upper bound (it is written for a drawing's arcs); a PCB's pads are tenths of a millimetre,
 * and at 0.02 mm chord error a 0.25 mm pad would be an octagon 10 % short of the copper the design
 * keeps — and the isolation band is built around that copper. 0.3 % of the radius keeps a sampled
 * circle's area within ~0.35 % of the true one, which is the accuracy the design's own fixture
 * asks for (#743 P-2).
 */
const CURVE_CHORD_RATIO = 0.003;

/** The chord error to sample a curve of this radius at, mm. */
function curveTolerance(radius: number, tol: number): number {
  return Math.min(tol, Math.max(1e-6, radius * CURVE_CHORD_RATIO));
}

export type GerberPoint = [number, number];

export type GerberPolarity = 'dark' | 'clear';

export interface GerberShape {
  polarity: GerberPolarity;
  /** Closed rings in mm (the first point is not repeated at the end). */
  contours: GerberPoint[][];
  /** EvenOdd for a region with inner contours; NonZero for one flash or stroke. */
  fillRule: 'EvenOdd' | 'NonZero';
  /** The source line the shape starts on, for a sentence about it. */
  line: number;
}

export interface GerberReadOk {
  ok: true;
  shapes: GerberShape[];
  /** `%TF.FileFunction%` verbatim (e.g. `Copper,L1,Top`), or null when the file states none. */
  fileFunction: string | null;
  /** The drawing's bounding box, mm, in the file's own coordinates. */
  bounds: { min: GerberPoint; max: GerberPoint } | null;
  notes: string[];
}

export type GerberRead = GerberReadOk | { ok: false; error: string };

export interface GerberReadOpts {
  /** Chord error for arcs, mm. The caller passes the shop's `import.dxfChordToleranceMm`. */
  chordToleranceMm?: number;
}

/* ------------------------------------------------------------------------------------------- */
/* Tokenising                                                                                    */

interface Statement {
  /** `%...%` is one extended command; anything else is one `*`-terminated word. */
  extended: boolean;
  text: string;
  line: number;
}

class GerberRefusal extends Error {}

// A function DECLARATION, not an arrow assigned to a const: TypeScript only narrows a value after
// a call that returns `never` when the callee is declared this way.
function refuse(line: number, what: string): never {
  throw new GerberRefusal(`line ${line}: ${what}`);
}

/**
 * Split the file into statements. Extended commands (`%...%`) may contain `*` separators inside
 * their own syntax, so they are delimited by the percent signs alone.
 */
function statements(text: string): Statement[] {
  const out: Statement[] = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === '\r' || ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '%') {
      const startLine = line;
      const end = text.indexOf('%', i + 1);
      if (end < 0) throw new GerberRefusal(`line ${startLine}: an extended command (%…) is not closed`);
      const body = text.slice(i + 1, end);
      for (const c of body) if (c === '\n') line++;
      out.push({ extended: true, text: body, line: startLine });
      i = end + 1;
      continue;
    }
    const end = text.indexOf('*', i);
    if (end < 0) throw new GerberRefusal(`line ${line}: the last command has no ‘*’ terminator`);
    const body = text.slice(i, end);
    for (const c of body) if (c === '\n') line++;
    out.push({ extended: false, text: body.trim(), line });
    i = end + 1;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- */
/* Macro arithmetic                                                                              */

/**
 * A Gerber macro parameter expression: numbers, `$n` variables, `+ − x /`, parentheses and a
 * leading sign. `x` (either case) is the spec's multiplication sign, `*` is accepted too.
 */
class Expression {
  private i = 0;
  private readonly text: string;
  private readonly vars: Readonly<Record<number, number>>;
  private readonly line: number;
  constructor(text: string, vars: Readonly<Record<number, number>>, line: number) {
    this.text = text;
    this.vars = vars;
    this.line = line;
  }

  evaluate(): number {
    const value = this.expression();
    this.skip();
    if (this.i < this.text.length) refuse(this.line, `the macro expression “${this.text}” has trailing “${this.text.slice(this.i)}”`);
    return value;
  }

  private skip(): void {
    while (this.i < this.text.length && (this.text[this.i] === ' ' || this.text[this.i] === '\t')) this.i++;
  }

  private expression(): number {
    let value = this.term();
    for (;;) {
      this.skip();
      const op = this.text[this.i];
      if (op === '+') {
        this.i++;
        value += this.term();
      } else if (op === '-') {
        this.i++;
        value -= this.term();
      } else {
        return value;
      }
    }
  }

  private term(): number {
    let value = this.factor();
    for (;;) {
      this.skip();
      const op = this.text[this.i];
      if (op === 'x' || op === 'X') {
        this.i++;
        value *= this.factor();
      } else if (op === '/') {
        this.i++;
        const divisor = this.factor();
        if (divisor === 0) refuse(this.line, `a macro expression divides by zero (“${this.text}”)`);
        value /= divisor;
      } else {
        return value;
      }
    }
  }

  private factor(): number {
    this.skip();
    const ch = this.text[this.i];
    if (ch === undefined) refuse(this.line, `the macro expression “${this.text}” ends early`);
    if (ch === '(') {
      this.i++;
      const value = this.expression();
      this.skip();
      if (this.text[this.i] !== ')') refuse(this.line, `the macro expression “${this.text}” has an unclosed ‘(’`);
      this.i++;
      return value;
    }
    if (ch === '-') {
      this.i++;
      return -this.factor();
    }
    if (ch === '+') {
      this.i++;
      return this.factor();
    }
    if (ch === '$') {
      this.i++;
      const start = this.i;
      while (this.i < this.text.length && /\d/.test(this.text[this.i] as string)) this.i++;
      if (start === this.i) refuse(this.line, `“${this.text}” names a variable with no number`);
      const value = this.vars[Number(this.text.slice(start, this.i))];
      if (value === undefined) refuse(this.line, `the macro expression “${this.text}” uses $${this.text.slice(start, this.i)}, which is not defined`);
      return value;
    }
    const start = this.i;
    while (this.i < this.text.length && /[0-9.]/.test(this.text[this.i] as string)) this.i++;
    if (start === this.i) refuse(this.line, `the macro expression “${this.text}” has “${this.text.slice(this.i)}” where a number belongs`);
    const value = Number(this.text.slice(start, this.i));
    if (!Number.isFinite(value)) refuse(this.line, `“${this.text}” is not a number`);
    return value;
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Geometry helpers                                                                              */

const TAU = Math.PI * 2;

function circleRing(cx: number, cy: number, r: number, tol: number): GerberPoint[] {
  const n = segmentsForRadius(r, curveTolerance(r, tol));
  const ring: GerberPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return ring;
}

function rotateRing(ring: readonly GerberPoint[], deg: number): GerberPoint[] {
  if (deg === 0) return ring.map(([x, y]): GerberPoint => [x, y]);
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return ring.map(([x, y]): GerberPoint => [x * c - y * s, x * s + y * c]);
}

function rectRing(x0: number, y0: number, x1: number, y1: number): GerberPoint[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Signed area; positive when the ring winds counter-clockwise. */
function signedArea(ring: readonly GerberPoint[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i] as GerberPoint;
    const [x1, y1] = ring[(i + 1) % ring.length] as GerberPoint;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/**
 * One winding for every ring of a flash: a macro may write its outline clockwise, and a NonZero
 * fill would then read it as a HOLE beside the counter-clockwise primitives.
 */
function ensureCCW(ring: GerberPoint[]): GerberPoint[] {
  return signedArea(ring) < 0 ? [...ring].reverse() : ring;
}

/** Andrew's monotone chain; CCW, no repeated first point. */
export function convexHull(points: readonly GerberPoint[]): GerberPoint[] {
  const pts = points
    .map(([x, y]): GerberPoint => [x, y])
    .sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  if (pts.length <= 2) return pts;
  const cross = (o: GerberPoint, a: GerberPoint, b: GerberPoint): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: GerberPoint[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as GerberPoint, lower[lower.length - 1] as GerberPoint, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: GerberPoint[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as GerberPoint;
    while (upper.length >= 2 && cross(upper[upper.length - 2] as GerberPoint, upper[upper.length - 1] as GerberPoint, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : pts;
}

/* ------------------------------------------------------------------------------------------- */
/* Apertures                                                                                     */

interface Aperture {
  /** The aperture's rings in its own frame, mm. */
  rings: GerberPoint[][];
  /** True when every ring is convex, so a stroke is exactly the hull of its two placements. */
  convex: boolean;
  /** The aperture's widest half-extent from its origin, mm — a cheap bound. */
  reach: number;
}

interface MacroPrimitive {
  code: number;
  params: string[];
  line: number;
}

interface MacroDef {
  params: MacroPrimitive[];
  assignments: { target: number; expr: string; line: number }[];
  line: number;
}

/** Split `aXbXc` into parts, respecting parentheses so an expression may contain an X? It may not. */
function splitParams(text: string): string[] {
  return text.length === 0 ? [] : text.split('X');
}

/** Split `a,b,c` into parts (macro primitives use commas). */
function splitCommas(text: string): string[] {
  return text.length === 0 ? [] : text.split(',');
}

function varsFor(params: readonly string[], vars: Readonly<Record<number, number>>, line: number): Record<number, number> {
  const out: Record<number, number> = { ...vars };
  params.forEach((param, i) => {
    out[i + 1] = new Expression(param, out, line).evaluate();
  });
  return out;
}

/**
 * The rings a macro primitive draws, in the aperture's frame. `scale` converts the file's unit to
 * mm (1 for mm, 25.4 for inch) — every parameter is in the file's own unit.
 */
function primitiveRings(
  primitive: MacroPrimitive,
  vars: Readonly<Record<number, number>>,
  scale: number,
  tol: number,
): GerberPoint[][] {
  const { line } = primitive;
  // A primitive's parameters are POSITIONAL, and their expressions read the MACRO's variables —
  // they must not be written back as $1..$n, or the second parameter would read the first one's
  // value where the macro said `$2`.
  const evaluated = primitive.params.map((param) => new Expression(param, vars, line).evaluate());
  const v = (i: number): number => evaluated[i - 1] as number;
  switch (primitive.code) {
    case 1: {
      // 1,exposure, diameter, cx, cy [, rotation]
      if ((evaluated[1] as number) === 0) refuse(line, 'an aperture macro uses a clearance primitive (exposure 0), which this import does not read');
      const dia = v(2) * scale;
      const cx = (v(3) ?? 0) * scale;
      const cy = (v(4) ?? 0) * scale;
      if (!(dia > 0)) refuse(line, 'an aperture macro draws a circle with no diameter');
      return [rotateRing(circleRing(cx, cy, dia / 2, tol), v(5) ?? 0)];
    }
    case 4: {
      // 4,exposure, n, x0,y0, …, xn,yn [, rotation]
      if ((evaluated[1] as number) === 0) refuse(line, 'an aperture macro uses a clearance primitive (exposure 0), which this import does not read');
      const n = Math.trunc(v(2));
      if (!(n >= 3)) refuse(line, 'an aperture macro outline has fewer than 3 points');
      const pts: GerberPoint[] = [];
      for (let i = 0; i < n; i++) {
        const x = evaluated[3 + i * 2];
        const y = evaluated[4 + i * 2];
        if (x === undefined || y === undefined) refuse(line, 'an aperture macro outline has fewer coordinates than points');
        pts.push([x * scale, y * scale]);
      }
      return [rotateRing(pts, v(3 + n * 2) ?? 0)];
    }
    case 5: {
      // 5,exposure, vertices, cx, cy, diameter [, rotation]
      if ((evaluated[1] as number) === 0) refuse(line, 'an aperture macro uses a clearance primitive (exposure 0), which this import does not read');
      const n = Math.trunc(v(2));
      if (!(n >= 3)) refuse(line, 'an aperture macro polygon has fewer than 3 vertices');
      const cx = (v(3) ?? 0) * scale;
      const cy = (v(4) ?? 0) * scale;
      const dia = v(5) * scale;
      if (!(dia > 0)) refuse(line, 'an aperture macro draws a polygon with no diameter');
      const rot = ((v(6) ?? 0) * Math.PI) / 180;
      const ring: GerberPoint[] = [];
      for (let i = 0; i < n; i++) {
        const a = rot + (i / n) * TAU;
        ring.push([cx + (dia / 2) * Math.cos(a), cy + (dia / 2) * Math.sin(a)]);
      }
      return [ring];
    }
    case 20: {
      // 20,exposure, width, x1,y1, x2,y2 [, rotation]
      if ((evaluated[1] as number) === 0) refuse(line, 'an aperture macro uses a clearance primitive (exposure 0), which this import does not read');
      const w = v(2) * scale;
      const x1 = (v(3) ?? 0) * scale;
      const y1 = (v(4) ?? 0) * scale;
      const x2 = (v(5) ?? 0) * scale;
      const y2 = (v(6) ?? 0) * scale;
      if (!(w > 0)) refuse(line, 'an aperture macro draws a line with no width');
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len === 0) return [circleRing(x1, y1, w / 2, tol)];
      const nx = (-(y2 - y1) / len) * (w / 2);
      const ny = ((x2 - x1) / len) * (w / 2);
      const ring: GerberPoint[] = [
        [x1 + nx, y1 + ny],
        [x2 + nx, y2 + ny],
        [x2 - nx, y2 - ny],
        [x1 - nx, y1 - ny],
      ];
      return [rotateRing(ring, v(7) ?? 0)];
    }
    case 21: {
      // 21,exposure, width, height, cx, cy [, rotation]
      if ((evaluated[1] as number) === 0) refuse(line, 'an aperture macro uses a clearance primitive (exposure 0), which this import does not read');
      const w = v(2) * scale;
      const h = v(3) * scale;
      const cx = (v(4) ?? 0) * scale;
      const cy = (v(5) ?? 0) * scale;
      if (!(w > 0) || !(h > 0)) refuse(line, 'an aperture macro draws a centre line with no width or height');
      return [rotateRing(rectRing(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), v(6) ?? 0)];
    }
    default:
      return refuse(line, `an aperture macro uses primitive ${primitive.code}, which this import does not read`);
  }
}

/** Standard apertures (C, R, O, P) and macros (everything else defined by `%AM…%`). */
function apertureFrom(
  template: string,
  params: readonly string[],
  macros: ReadonlyMap<string, MacroDef>,
  scale: number,
  tol: number,
  line: number,
): Aperture {
  const numbers = params.map((p) => new Expression(p, {}, line).evaluate() * scale);
  const make = (rings: GerberPoint[][], convex = true): Aperture => {
    let reach = 0;
    for (const ring of rings) for (const [x, y] of ring) reach = Math.max(reach, Math.hypot(x, y));
    return { rings, convex, reach };
  };
  switch (template) {
    case 'C': {
      const dia = numbers[0];
      if (dia === undefined || !(dia > 0)) refuse(line, 'a circle aperture has no diameter');
      return make([circleRing(0, 0, dia / 2, tol)]);
    }
    case 'R': {
      const w = numbers[0];
      const h = numbers[1];
      if (w === undefined || h === undefined || !(w > 0) || !(h > 0)) refuse(line, 'a rectangle aperture needs two sizes above 0');
      return make([rectRing(-w / 2, -h / 2, w / 2, h / 2)]);
    }
    case 'O': {
      const w = numbers[0];
      const h = numbers[1];
      if (w === undefined || h === undefined || !(w > 0) || !(h > 0)) refuse(line, 'an obround aperture needs two sizes above 0');
      // An obround is a rectangle with semicircular ends; sampling the ends as circles and taking
      // the hull gives an exact convex outline when the two circles are the same radius.
      const r = Math.min(w, h) / 2;
      if (w === h) return make([circleRing(0, 0, r, tol)]);
      const long = Math.max(w, h);
      const offset = long / 2 - r;
      const alongX = w >= h;
      const c1: GerberPoint = alongX ? [-offset, 0] : [0, -offset];
      const c2: GerberPoint = alongX ? [offset, 0] : [0, offset];
      const ring = [
        ...circleRing(c1[0], c1[1], r, tol),
        ...circleRing(c2[0], c2[1], r, tol),
        // The flat sides' corners, so a hull of the two caps is the obround rather than a capsule.
        ...(alongX
          ? ([
              [-offset, -r],
              [offset, -r],
              [offset, r],
              [-offset, r],
            ] as GerberPoint[])
          : ([
              [-r, -offset],
              [-r, offset],
              [r, offset],
              [r, -offset],
            ] as GerberPoint[])),
      ];
      return make([convexHull(ring)]);
    }
    case 'P': {
      // P,outer diameter [X vertices [X rotation]]
      const dia = numbers[0];
      const vertices = Math.trunc(numbers[1] ?? 3);
      const rot = numbers[2] ?? 0;
      if (dia === undefined || !(dia > 0)) refuse(line, 'a polygon aperture has no diameter');
      if (!(vertices >= 3 && vertices <= 64)) refuse(line, 'a polygon aperture needs 3 to 64 vertices');
      const ring: GerberPoint[] = [];
      for (let i = 0; i < vertices; i++) {
        const a = (rot * Math.PI) / 180 + (i / vertices) * TAU;
        ring.push([(dia / 2) * Math.cos(a), (dia / 2) * Math.sin(a)]);
      }
      return make([ring]);
    }
    default: {
      const macro = macros.get(template);
      if (macro === undefined) refuse(line, `aperture “${template}” is a macro this file does not define`);
      const vars = varsFor(params, {}, line);
      for (const assignment of macro.assignments) {
        vars[assignment.target] = new Expression(assignment.expr, vars, assignment.line).evaluate();
      }
      const rings: GerberPoint[][] = [];
      let convex = true;
      for (const primitive of macro.params) {
        const drawn = primitiveRings(primitive, vars, scale, tol);
        for (const ring of drawn) rings.push(ensureCCW(ring));
        if (primitive.code === 4) convex = false;
      }
      return make(rings, convex);
    }
  }
}

/* ------------------------------------------------------------------------------------------- */
/* The reader                                                                                    */

interface GerberState {
  line: number;
  scale: number; // mm per file unit
  xDecimals: number;
  yDecimals: number;
  incremental: boolean;
  x: number;
  y: number;
  aperture: Aperture | null;
  apertureCode: number | null;
  polarity: GerberPolarity;
  interpolation: 'linear' | 'cw' | 'ccw';
  region: { closed: GerberPoint[][]; current: GerberPoint[] | null } | null;
  sawG75: boolean;
  shapes: GerberShape[];
  notes: string[];
  hulledStrokes: boolean;
  arcsWithoutQuadrant: boolean;
}

export function readGerber(text: string, opts: GerberReadOpts = {}): GerberRead {
  const tol = opts.chordToleranceMm !== undefined && opts.chordToleranceMm > 0 ? opts.chordToleranceMm : GERBER_CHORD_TOLERANCE_FALLBACK_MM;
  try {
    return parseGerber(text, tol);
  } catch (e) {
    if (e instanceof GerberRefusal) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function parseGerber(text: string, tol: number): GerberRead {
  const macros = new Map<string, MacroDef>();
  const apertures = new Map<number, Aperture>();
  const state: GerberState = {
    line: 1,
    scale: 1,
    xDecimals: 4,
    yDecimals: 4,
    incremental: false,
    x: 0,
    y: 0,
    aperture: null,
    apertureCode: null,
    polarity: 'dark',
    interpolation: 'linear',
    region: null,
    shapes: [],
    notes: [],
    hulledStrokes: false,
    arcsWithoutQuadrant: false,
    sawG75: false,
  };
  let fileFunction: string | null = null;
  let seenFormat = false;
  let seenUnits = false;

  const finishContour = (): void => {
    const region = state.region;
    if (region === null || region.current === null) return;
    if (region.current.length >= 3) region.closed.push(region.current);
    region.current = null;
  };

  /**
   * A region is ONE shape whose contours are even-odd: an inner contour a pour leaves is a HOLE,
   * and emitting it as its own dark shape would add the area the designer cut away.
   */
  const finishRegion = (): void => {
    const region = state.region;
    if (region === null) return;
    finishContour();
    if (region.closed.length > 0) {
      state.shapes.push({ polarity: state.polarity, contours: region.closed, fillRule: 'EvenOdd', line: state.line });
    }
    state.region = null;
  };

  const pushShape = (rings: GerberPoint[][], fillRule: GerberShape['fillRule'] = 'NonZero'): void => {
    if (rings.length === 0) return;
    state.shapes.push({ polarity: state.polarity, contours: rings, fillRule, line: state.line });
  };

  const point = ([x, y]: GerberPoint): GerberPoint => [x, y];

  /** The aperture's rings at a point. */
  const apertureAt = (p: GerberPoint): GerberPoint[][] => {
    const aperture = state.aperture;
    if (aperture === null) refuse(state.line, 'a draw or flash happens before any aperture is selected');
    return aperture.rings.map((ring) => ring.map(([x, y]): GerberPoint => [x + p[0], y + p[1]]));
  };

  /** One straight stroke from `a` to `b` with the current aperture. */
  const stroke = (a: GerberPoint, b: GerberPoint): void => {
    const aperture = state.aperture;
    if (aperture === null) refuse(state.line, 'a draw happens before any aperture is selected');
    if (aperture.convex) {
      const hull = convexHull([...apertureAt(a).flat(), ...apertureAt(b).flat()]);
      pushShape([hull]);
    } else {
      // A concave macro aperture: the hull is never smaller than the true sweep.
      state.hulledStrokes = true;
      const hull = convexHull([...apertureAt(a).flat(), ...apertureAt(b).flat()]);
      pushShape([hull]);
    }
    state.x = b[0];
    state.y = b[1];
  };

  /** The points along an arc from `a` to `b`, centre at `a + (i, j)`. */
  const arcPoints = (a: GerberPoint, b: GerberPoint, i: number, j: number, clockwise: boolean): GerberPoint[] => {
    const cx = a[0] + i;
    const cy = a[1] + j;
    const r = Math.hypot(i, j);
    if (!(r > 0)) refuse(state.line, 'an arc states a zero radius (I and J are both 0)');
    const start = Math.atan2(a[1] - cy, a[0] - cx);
    const end = Math.atan2(b[1] - cy, b[0] - cx);
    let sweep = end - start;
    if (clockwise) {
      while (sweep >= 0) sweep -= TAU;
      while (sweep < -TAU) sweep += TAU;
    } else {
      while (sweep <= 0) sweep += TAU;
      while (sweep > TAU) sweep -= TAU;
    }
    // A full circle ends where it started: Gerber writes it as two half arcs, so a >2π reading is
    // impossible; keep the half-turn reading honest.
    const n = Math.max(2, segmentsForRadius(r, curveTolerance(r, tol)));
    const steps = Math.max(1, Math.ceil((Math.abs(sweep) / TAU) * n));
    const out: GerberPoint[] = [];
    for (let k = 1; k <= steps; k++) {
      const angle = start + (sweep * k) / steps;
      out.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
    }
    // The file's endpoint is the truth; a chorded sweep's last point should land on it.
    out[out.length - 1] = point(b);
    return out;
  };

  for (const statement of statements(text)) {
    state.line = statement.line;
    if (statement.extended) {
      parseExtended(statement, {
        macros,
        onFileFunction: (v) => {
          fileFunction = v;
        },
        onUnits: (inch) => {
          if (seenUnits) return;
          seenUnits = true;
          state.scale = inch ? 25.4 : 1;
        },
        onFormat: (f) => {
          state.xDecimals = f.xDecimals;
          state.yDecimals = f.yDecimals;
          state.incremental = f.incremental;
          seenFormat = true;
        },
        onPolarity: (p) => {
          state.polarity = p;
        },
        onAperture: (code, template, params) => {
          apertures.set(code, apertureFrom(template, params, macros, state.scale, tol, state.line));
        },
        onSelect: (code) => {
          const aperture = apertures.get(code);
          if (aperture === undefined) refuse(state.line, `aperture D${code} is selected before it is defined`);
          state.aperture = aperture;
          state.apertureCode = code;
        },
        note: (n) => state.notes.push(n),
      });
      continue;
    }

    const word = statement.text;
    if (word === '' || word.startsWith('G04')) continue;
    if (/^M0[012]\b/.test(word) || /^M02/.test(word)) {
      if (state.region !== null) refuse(state.line, 'the file ends inside a region (G36 without G37)');
      break;
    }

    let rest = word;
    // One or more G codes may lead the word.
    while (/^G\d/.test(rest)) {
      const m = /^G(\d+)/.exec(rest) as RegExpExecArray;
      const code = Number(m[1]);
      rest = rest.slice(m[0].length);
      switch (code) {
        case 1:
          state.interpolation = 'linear';
          break;
        case 2:
          state.interpolation = 'cw';
          break;
        case 3:
          state.interpolation = 'ccw';
          break;
        case 74:
          return { ok: false, error: `line ${state.line}: the file uses single-quadrant arcs (G74), which this import does not read` };
        case 75:
          state.sawG75 = true;
          break;
        case 36:
          if (state.region !== null) refuse(state.line, 'a region starts (G36) inside another region');
          state.region = { closed: [], current: null };
          break;
        case 37:
          if (state.region === null) refuse(state.line, 'a region ends (G37) without starting (G36)');
          finishRegion();
          break;
        case 54:
        case 55:
          // "Select aperture" prefix; the D code that follows does the work.
          break;
        default:
          refuse(state.line, `the file uses G${code}, which this import does not read`);
      }
    }

    // Coordinates and the operation.
    const coords: { x?: string; y?: string; i?: string; j?: string } = {};
    while (/^[XYIJ]/.test(rest)) {
      const key = rest[0]!.toLowerCase() as 'x' | 'y' | 'i' | 'j';
      rest = rest.slice(1);
      const m = /^[-+]?[0-9.]+/.exec(rest);
      if (m === null) refuse(state.line, `a coordinate after ${key.toUpperCase()} is missing`);
      coords[key] = m[0];
      rest = rest.slice(m[0].length);
    }
    let operation: 1 | 2 | 3 | null = null;
    if (/^D0?[123]$/.test(rest)) {
      operation = Number(rest.slice(1)) as 1 | 2 | 3;
      rest = '';
    } else if (/^D\d+$/.test(rest)) {
      const code = Number(rest.slice(1));
      const aperture = apertures.get(code);
      if (aperture === undefined) refuse(state.line, `aperture D${code} is selected before it is defined`);
      state.aperture = aperture;
      state.apertureCode = code;
      rest = '';
    }
    if (rest !== '') refuse(state.line, `“${rest}” is not a command this import reads`);

    const toMm = (raw: string | undefined, decimals: number): number | undefined => {
      if (raw === undefined) return undefined;
      if (raw.includes('.')) {
        const value = Number(raw);
        if (!Number.isFinite(value)) refuse(state.line, `“${raw}” is not a coordinate`);
        return value * state.scale;
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) refuse(state.line, `“${raw}” is not a coordinate`);
      return (value / 10 ** decimals) * state.scale;
    };

    const nx = toMm(coords.x, state.xDecimals);
    const ny = toMm(coords.y, state.yDecimals);
    const target: GerberPoint = [
      state.incremental ? state.x + (nx ?? 0) : (nx ?? state.x),
      state.incremental ? state.y + (ny ?? 0) : (ny ?? state.y),
    ];
    const current: GerberPoint = [state.x, state.y];

    if (operation === 2) {
      // A move: inside a region it starts a new contour; outside it just moves the pen.
      if (state.region !== null) {
        finishContour();
        state.region.current = [target];
      }
      state.x = target[0];
      state.y = target[1];
      continue;
    }
    if (operation === 3) {
      if (state.region !== null) refuse(state.line, 'a flash (D03) inside a region is not read');
      const rings = apertureAt(target);
      pushShape(rings);
      state.x = target[0];
      state.y = target[1];
      continue;
    }
    if (operation !== 1) {
      // A bare G36/G37 word, or a coordinate-free statement.
      continue;
    }

    // D01: a draw.
    if (state.region !== null) {
      const region = state.region;
      if (region.current === null) region.current = [current];
      if (state.interpolation !== 'linear' && !state.sawG75) state.arcsWithoutQuadrant = true;
      const points =
        state.interpolation === 'linear'
          ? [target]
          : arcPoints(current, target, toMm(coords.i, state.xDecimals) ?? 0, toMm(coords.j, state.yDecimals) ?? 0, state.interpolation === 'cw');
      region.current.push(...points);
      state.x = target[0];
      state.y = target[1];
      continue;
    }

    if (state.interpolation === 'linear') {
      if (current[0] !== target[0] || current[1] !== target[1]) stroke(current, target);
      else {
        // A zero-length draw is a flash of the aperture at the point.
        pushShape(apertureAt(target));
      }
    } else {
      if (!state.sawG75) state.arcsWithoutQuadrant = true;
      const i = toMm(coords.i, state.xDecimals) ?? 0;
      const j = toMm(coords.j, state.yDecimals) ?? 0;
      const points = arcPoints(current, target, i, j, state.interpolation === 'cw');
      let from = current;
      for (const p of points) {
        stroke(from, p);
        from = p;
      }
      if (points.length === 0) {
        state.x = target[0];
        state.y = target[1];
      }
    }
  }

  if (state.region !== null) return { ok: false, error: `line ${state.line}: the file ends inside a region (G36 without G37)` };
  if (!seenFormat) return { ok: false, error: 'the file states no coordinate format (%FS%), so its numbers cannot be read' };
  if (!seenUnits) return { ok: false, error: 'the file states no unit (%MOMM% or %MOIN%), so its sizes cannot be read' };
  if (state.shapes.length === 0) return { ok: false, error: 'the file draws no copper' };
  if (state.hulledStrokes) state.notes.push('a stroke with a concave macro aperture is taken as the convex hull of its two placements — never smaller than the true sweep.');
  if (state.arcsWithoutQuadrant) state.notes.push('an arc is read as multi-quadrant; the file does not state G75.');

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let points = 0;
  let contours = 0;
  for (const shape of state.shapes) {
    for (const ring of shape.contours) {
      contours++;
      points += ring.length;
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (contours > MAX_OUTLINE_CONTOURS) {
    return { ok: false, error: `the file draws ${contours} contours; this import reads up to ${MAX_OUTLINE_CONTOURS}` };
  }
  if (points > MAX_OUTLINE_POINTS) {
    return { ok: false, error: `the file's contours hold ${points} points; this import reads up to ${MAX_OUTLINE_POINTS}` };
  }
  return {
    ok: true,
    shapes: state.shapes,
    fileFunction,
    bounds: minX === Infinity ? null : { min: [minX, minY], max: [maxX, maxY] },
    notes: state.notes,
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Extended commands                                                                             */

interface ExtendedHandlers {
  macros: Map<string, MacroDef>;
  onFileFunction: (v: string) => void;
  onUnits: (inch: boolean) => void;
  onFormat: (f: { xDecimals: number; yDecimals: number; incremental: boolean }) => void;
  onPolarity: (p: GerberPolarity) => void;
  onAperture: (code: number, template: string, params: string[]) => void;
  onSelect: (code: number) => void;
  note: (n: string) => void;
}

function parseExtended(statement: Statement, h: ExtendedHandlers): void {
  const body = statement.text;
  const line = statement.line;
  // A macro definition is delimited by `*` inside the percent block.
  if (body.startsWith('AM')) {
    const chunks = body.split('*').map((c) => c.trim()).filter((c) => c.length > 0);
    const name = chunks.shift()?.slice(2) ?? '';
    if (name === '') refuse(line, 'an aperture macro has no name');
    const params: MacroPrimitive[] = [];
    const assignments: { target: number; expr: string; line: number }[] = [];
    for (const chunk of chunks) {
      if (chunk.startsWith('0')) continue; // a comment primitive
      const eq = chunk.match(/^\$(\d+)=(.*)$/);
      if (eq) {
        assignments.push({ target: Number(eq[1]), expr: eq[2] as string, line });
        continue;
      }
      const comma = chunk.indexOf(',');
      if (comma < 0) refuse(line, `an aperture macro primitive “${chunk}” has no parameters`);
      params.push({ code: Number(chunk.slice(0, comma)), params: splitCommas(chunk.slice(comma + 1)), line });
    }
    h.macros.set(name, { params, assignments, line });
    return;
  }
  const command = body.slice(0, 2);
  const rest = body.slice(2).replace(/\*$/, '');
  switch (command) {
    case 'FS': {
      // FSLAX46Y46
      const m = /^([LT])([AI])X(\d)(\d)Y(\d)(\d)$/.exec(rest);
      if (m === null) refuse(line, `the coordinate format “%${body}%” is not one this import reads`);
      h.onFormat({ incremental: m[2] === 'I', xDecimals: Number(m[4]), yDecimals: Number(m[6]) });
      return;
    }
    case 'MO':
      if (rest === 'MM') return h.onUnits(false);
      if (rest === 'IN') return h.onUnits(true);
      return refuse(line, `the unit “%${body}%” is not one this import reads (MOMM or MOIN)`);
    case 'AD': {
      // ADD10C,0.5*  |  ADD12RoundRect,1.0X0.6*
      const m = /^D(\d+)([^,]+)(?:,(.*))?$/.exec(rest);
      if (m === null) refuse(line, `the aperture definition “%${body}%” is not one this import reads`);
      h.onAperture(Number(m[1]), m[2] as string, splitParams(m[3] ?? ''));
      return;
    }
    case 'LP':
      if (rest === 'D') return h.onPolarity('dark');
      if (rest === 'C') return h.onPolarity('clear');
      return refuse(line, `the polarity “%${body}%” is not one this import reads (LPD or LPC)`);
    case 'TF': {
      const [attr, ...values] = rest.split(',');
      if (attr === '.FileFunction' && values.length > 0) h.onFileFunction(values.join(','));
      return;
    }
    case 'TA':
    case 'TO':
    case 'TD':
    case 'IN':
    case 'LN':
      // Metadata: names and attributes change nothing about the geometry.
      return;
    case 'SR':
      return refuse(line, 'the file uses step-and-repeat (%SR%), which this import does not read');
    case 'AB':
      return refuse(line, 'the file uses a block aperture (%AB%), which this import does not read');
    case 'LM':
    case 'LR':
    case 'LS':
      return refuse(line, `the file uses aperture ${command === 'LM' ? 'mirroring' : command === 'LR' ? 'rotation' : 'scaling'} (%${body}%), which this import does not read`);
    case 'IP':
      if (rest === 'NEG') return refuse(line, 'the file uses negative image polarity (%IPNEG%), which this import does not read');
      return;
    case 'OF':
      return refuse(line, 'the file sets an image offset (%OF%), which this import does not read');
    case 'MI':
    case 'SF':
    case 'AS':
    case 'IR':
      return refuse(line, `the file uses %${command}%, which this import does not read`);
    default:
      return refuse(line, `the extended command “%${body}%” is not one this import reads`);
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Merging a layer                                                                               */

export interface GerberLayer {
  /** The merged copper as rings in mm: outers CCW, holes CW (CrossSection's own convention). */
  contours: GerberPoint[][];
  /** How many connected pieces the copper is. */
  pieces: number;
  /** Area, mm². */
  areaMm2: number;
  /** The file's bounding box, mm — the copper's own, not the board outline's. */
  bounds: { min: GerberPoint; max: GerberPoint } | null;
}

/**
 * The copper a layer's shapes make: every dark shape unioned, every clear one subtracted, in the
 * file's order. The caller owns the result's rings (plain arrays) — no wasm handle survives.
 */
export function mergeGerberShapes(tl: ManifoldToplevel, shapes: readonly GerberShape[]): GerberLayer {
  type CS = ReturnType<ManifoldToplevel['CrossSection']['ofPolygons']>;
  const empty = tl.CrossSection.union([]);
  let region: CS = empty;
  for (const shape of shapes) {
    const cs = shape.fillRule === 'EvenOdd' ? tl.CrossSection.ofPolygons(shape.contours, 'EvenOdd') : tl.CrossSection.ofPolygons(shape.contours);
    const next = shape.polarity === 'dark' ? region.add(cs) : region.subtract(cs);
    if (region !== empty) region.delete();
    cs.delete();
    region = next;
  }
  const contours = region.toPolygons() as GerberPoint[][];
  const pieces = region.decompose().length;
  const areaMm2 = region.area();
  region.delete();

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of contours) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return {
    contours,
    pieces,
    areaMm2,
    bounds: minX === Infinity ? null : { min: [minX, minY], max: [maxX, maxY] },
  };
}
