/**
 * The cutter's side profile, computed from its `Tool` record (#489).
 *
 * THE PICTURE IS THE DATA. Makera Studio, Fusion and Carbide Create all swap a static PNG per
 * cutter category, so a 0.1 mm/20° engraver and a 0.5 mm/30° one look identical and the choice a
 * user gets wrong is the one the drawing cannot show. Nothing here is copied from any of that art:
 * the silhouette, the dimension lines and the scale come from `shape`, `handleDiameter`,
 * `tipDiameter`, `diameter`, `cornerRadius`, `angle`/`halfAngle`, `fluteLength`,
 * `shoulderLength` and `stickout` (and `vProfile` for a V-bit's cone).
 *
 * TWO RENDERERS, ONE MODEL. `buildCutterProfile` is pure and DOM-free; `CutterProfile.tsx` maps
 * it to React SVG for the picker, the editor and the my-tools rail, and `cutterProfileSvg` emits a
 * standalone monochrome SVG for the run sheet and its Markdown. `RunSheet` carries that string, so
 * the paper at the machine and the app cannot disagree about the cutter.
 *
 * HONESTY RULES, in the order they matter:
 *
 *   - **Drawn to scale.** One mm→unit scale fits the profile to its box; width or length is only
 *     stretched when it would otherwise be unreadably thin. Both axes print a scale bar whenever
 *     the two scales differ, and the model says so (`scaleNote`) rather than letting a distorted
 *     silhouette read as a measurement.
 *   - **Missing is missing.** A field the record does not state is `?` on a dashed dimension line,
 *     in the warning colour, and the edge that depends on it is dashed. A shoulder length Makera
 *     leaves empty is the first case. Geometry is built only from stated numbers; an unknown axial
 *     span is a dashed placeholder, never a guessed length.
 *   - **A refusal is drawn, not hidden.** An unknown `ToolShape`, or a refusal the simulator
 *     reported (`tool-refused`, `prior-removal-column`), greys the profile and prints the reason
 *     under it. The drawing stays on the page: the operator can see which cutter was refused.
 *   - **The V cone is honest.** For an engraving or chamfer cutter the profile extends the flanks
 *     to the job's depth and draws the groove's actual top opening from `grooveRadiusAt` — the
 *     width-coupled-to-depth fact a V-bit user has to understand (`/Fabrication.md` §7.4).
 *
 * No new diagnostic code is introduced: a refusal carries the simulator's existing `code` verbatim.
 */

import { type Tool, type ToolShape } from './tool';
import { grooveRadiusAt, vCone, type VCone } from './vProfile';
import type { Condition } from './toolCondition';

/** The three places a profile is drawn. `print` is the monochrome run-sheet version. */
export type CutterProfileSize = 'thumb' | 'full' | 'print';

/**
 * The `Tool` field a dimension is linked to. The dimension line and the editor field share this
 * key, which is what makes hover/focus work in both directions without a second mapping table.
 */
export type CutterField =
  | 'handleDiameter'
  | 'tipDiameter'
  | 'diameter'
  | 'cornerRadius'
  | 'angle'
  | 'halfAngle'
  | 'fluteLength'
  | 'shoulderLength';

/** The industry letter codes the drawing uses, in the vocabulary Makera/Fusion users already met. */
export type CutterDimensionCode = 'DS' | 'DC' | 'LS' | 'LC' | 'CR' | 'TI' | 'AN' | 'D1';

/** A refusal the caller wants drawn (the simulator's diagnostic), or one this module judges. */
export interface CutterRefusal {
  code: string;
  reason: string;
}

export interface CutterProfileOptions {
  size?: CutterProfileSize;
  /**
   * SVG units per mm, shared by every drawing in a list (#489 review). Without it a drawing fits
   * itself, which makes a 1 mm flat look as large as a 6.35 mm ball once the SVG is stretched to
   * the mount's width. Pass the value from {@link cutterProfileScale} with the same size and every
   * drawing in the list keeps its true relative size.
   */
  scale?: number | null;
  /** The job's cut depth, mm. Draws the V-bit's groove width at that depth when the tool is a cone. */
  grooveDepth?: number | null;
  /** The simulator's refusal for this cutter/job, drawn greyed with its reason. */
  refusal?: CutterRefusal | null;
  /**
   * The label colour of an owned cutter (`inv:*`), drawn as a band on the shank. The house/location
   * data that will supply it (`labels.json`) is not in this build yet; the prop is the seam, and a
   * missing colour draws no band rather than inventing one.
   */
  labelColor?: string | null;
  /** The physical condition, when the caller knows it: worn gets a mark, broken a break at the tip. */
  condition?: Condition | null;
  /**
   * The standalone SVG renders the refusal reason under the drawing; the React component writes it
   * in HTML beside the SVG instead. Internal to the two renderers.
   */
  reasonInSvg?: boolean;
}

export interface CutterDimensionSpec {
  code: CutterDimensionCode;
  field: CutterField;
  label: string;
  kind: 'diameter' | 'length' | 'angle' | 'radius';
  unit: 'mm' | 'deg';
  value: number | null;
  text: string;
  missing: boolean;
}

type Role =
  | 'outline'
  | 'tip'
  | 'flank'
  | 'shank'
  | 'neck'
  | 'break'
  | 'axis'
  | 'groove'
  | 'detail'
  | 'dimension'
  | 'extension'
  | 'leader'
  | 'arc'
  | 'arrow'
  | 'scale';

export interface CutterProfilePath {
  d: string;
  role: Role;
  dashed: boolean;
  /** True when the edge exists only because a field is absent; renderers use the warning colour. */
  missing: boolean;
  /** Filled paths are arrowheads and the label band; stroked paths are everything else. */
  fill?: boolean;
  /** The field this edge depends on, when it is not stated. */
  missingField?: CutterField;
}

export interface CutterProfileText {
  x: number;
  y: number;
  text: string;
  anchor: 'start' | 'middle' | 'end';
  rotate?: number;
  missing?: boolean;
  /** A background in the surface colour behind text that sits over the body. */
  background?: { x: number; y: number; width: number; height: number };
}

export interface CutterProfileDimension {
  code: CutterDimensionCode;
  field: CutterField;
  label: string;
  kind: CutterDimensionSpec['kind'];
  value: number | null;
  text: string;
  missing: boolean;
  paths: CutterProfilePath[];
  textAt: CutterProfileText;
}

export interface CutterProfileScaleBar {
  orientation: 'horizontal' | 'vertical';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  ticks: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  mm: number;
  textAt: CutterProfileText;
}

export interface CutterProfileModel {
  size: CutterProfileSize;
  viewBox: { x: number; y: number; width: number; height: number };
  /** SVG units per mm actually used, per axis. Equal unless a single drawing had to compress one. */
  scale: { x: number; y: number };
  title: string;
  desc: string;
  shape: ToolShape;
  paths: CutterProfilePath[];
  fillPath: string | null;
  labelBand: CutterProfilePath | null;
  dimensions: CutterProfileDimension[];
  scaleBars: CutterProfileScaleBar[];
  scaleNote: string | null;
  scaleNoteAt: CutterProfileText | null;
  extraMarks: CutterProfileText[];
  groove: { paths: CutterProfilePath[]; label: CutterProfileText } | null;
  cone: VCone | null;
  refusal: CutterRefusal | null;
  refusalLines: string[];
  refusalAt: { x: number; y: number } | null;
  labelColor: string | null;
  condition: Condition | null;
  missingFields: CutterField[];
}

// ---------------------------------------------------------------------------------------------
// The dimension vocabulary
// ---------------------------------------------------------------------------------------------

interface DimensionInfo {
  label: string;
  kind: CutterDimensionSpec['kind'];
  unit: 'mm' | 'deg';
}

const DIMENSIONS: Record<CutterDimensionCode, DimensionInfo> = {
  DS: { label: 'shank Ø', kind: 'diameter', unit: 'mm' },
  DC: { label: 'cutting Ø', kind: 'diameter', unit: 'mm' },
  LS: { label: 'shoulder length', kind: 'length', unit: 'mm' },
  LC: { label: 'flute length', kind: 'length', unit: 'mm' },
  CR: { label: 'corner radius', kind: 'radius', unit: 'mm' },
  TI: { label: 'included tip angle', kind: 'angle', unit: 'deg' },
  AN: { label: 'half angle', kind: 'angle', unit: 'deg' },
  D1: { label: 'flat tip Ø', kind: 'diameter', unit: 'mm' },
};

/**
 * The codes each shape is dimensioned with. The list follows Makera's category drawing — the
 * vocabulary the user met in Studio — with one deliberate addition: CR on a bull nose, because
 * that radius is what makes a bull nose a bull nose.
 */
export const SHAPE_DIMENSION_CODES: Readonly<Record<ToolShape, readonly CutterDimensionCode[]>> = {
  flat: ['DS', 'DC', 'LS', 'LC'],
  ball: ['DS', 'DC', 'LS', 'LC', 'CR'],
  'tapered-ball': ['DS', 'DC', 'LS', 'LC', 'CR'],
  engraving: ['DS', 'DC', 'LC', 'AN', 'D1'],
  chamfer: ['DS', 'DC', 'LC', 'TI'],
  drill: ['DS', 'DC', 'LS', 'LC'],
  thread: ['DS', 'DC', 'LS'],
  bull: ['DS', 'DC', 'LS', 'LC', 'CR'],
  unknown: [],
};

const SHAPE_LABELS: Record<ToolShape, string> = {
  flat: 'flat end mill',
  ball: 'ball nose',
  'tapered-ball': 'tapered ball nose',
  engraving: 'engraving cutter',
  chamfer: 'chamfer cutter',
  drill: 'drill',
  thread: 'thread mill',
  bull: 'bull nose',
  unknown: 'cutter of an unknown shape',
};

/** `4.0` for a whole millimetre, `3.175` for a real one, three decimals at most. */
export function fmtMm(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(Number(value.toFixed(3)));
}

/** `30` for 30°, `7.5` for 7.5°. */
export function fmtDeg(value: number): string {
  return String(Number(value.toFixed(2)));
}

function positive(v: number | null | undefined): number | null {
  return v !== null && v !== undefined && Number.isFinite(v) && v > 0 ? v : null;
}

function nonNegative(v: number | null | undefined): number | null {
  return v !== null && v !== undefined && Number.isFinite(v) && v >= 0 ? v : null;
}

/** A shape whose `diameter=` is the SHANK, not the cutting tip (`Tool.diameter`). */
const SHANK_DIAMETER_SHAPES: readonly ToolShape[] = ['engraving', 'chamfer', 'drill', 'thread'];

/**
 * The record's `DC` — the cutting diameter — and the field it came from.
 *
 * For the shapes whose `diameter=` is the SHANK, DC is the body's major cutting diameter, which is
 * what Makera writes there; for a flat, ball or bull nose the cutting diameter is the tip's. The
 * field name travels with the number so the hover link highlights the box that actually supplied it.
 */
function cuttingDiameterSource(tool: Tool): { field: CutterField; value: number | null } {
  if (SHANK_DIAMETER_SHAPES.includes(tool.shape)) {
    if (positive(tool.diameter) !== null) return { field: 'diameter', value: tool.diameter };
    if (positive(tool.tipDiameter) !== null) return { field: 'tipDiameter', value: tool.tipDiameter };
    return { field: 'diameter', value: null };
  }
  if (positive(tool.tipDiameter) !== null) return { field: 'tipDiameter', value: tool.tipDiameter };
  if (positive(tool.diameter) !== null) return { field: 'diameter', value: tool.diameter };
  return { field: 'tipDiameter', value: null };
}

function valueFor(tool: Tool, code: CutterDimensionCode): { field: CutterField; value: number | null } {
  switch (code) {
    case 'DS':
      return { field: 'handleDiameter', value: positive(tool.handleDiameter) };
    case 'DC':
      return cuttingDiameterSource(tool);
    case 'LS':
      return { field: 'shoulderLength', value: positive(tool.shoulderLength) };
    case 'LC':
      return { field: 'fluteLength', value: positive(tool.fluteLength) };
    case 'CR':
      return { field: 'cornerRadius', value: nonNegative(tool.cornerRadius) };
    case 'TI': {
      // The included angle is `angle` when stated, or twice a stated half angle. The field name is
      // the one that actually supplied it, so the editor highlights the right box.
      const angle = positive(tool.angle);
      if (angle !== null) return { field: 'angle', value: angle };
      const half = positive(tool.halfAngle);
      if (half !== null) return { field: 'halfAngle', value: half * 2 };
      return { field: 'angle', value: null };
    }
    case 'AN': {
      const half = positive(tool.halfAngle);
      if (half !== null) return { field: 'halfAngle', value: half };
      const angle = positive(tool.angle);
      if (angle !== null) return { field: 'angle', value: angle / 2 };
      return { field: 'halfAngle', value: null };
    }
    case 'D1':
      return { field: 'tipDiameter', value: positive(tool.tipDiameter) };
  }
}

/** Every dimension the shape's vocabulary calls for, with its stated or derived value or `null`. */
export function cutterDimensionSpecs(tool: Tool): CutterDimensionSpec[] {
  return SHAPE_DIMENSION_CODES[tool.shape].map((code) => {
    const info = DIMENSIONS[code];
    const { field, value } = valueFor(tool, code);
    const missing = value === null;
    const text = missing
      ? '?'
      : info.unit === 'deg'
        ? `${fmtDeg(value)}°`
        : fmtMm(value);
    return { code, field, label: info.label, kind: info.kind, unit: info.unit, value, text, missing };
  });
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

/** A point in SVG user units (y down). */
interface Pt {
  x: number;
  y: number;
}

const DEG = Math.PI / 180;

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function line(x1: number, y1: number, x2: number, y2: number): string {
  return `M${round(x1)},${round(y1)} L${round(x2)},${round(y2)}`;
}

function polyline(points: readonly Pt[], close = false): string {
  if (points.length === 0) return '';
  const first = points[0]!;
  const rest = points.slice(1).map((p) => `L${round(p.x)},${round(p.y)}`).join(' ');
  return `M${round(first.x)},${round(first.y)} ${rest}${close ? ' Z' : ''}`;
}

function rectPath(x: number, y: number, width: number, height: number): string {
  return polyline(
    [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
    true,
  );
}

function circlePath(cx: number, cy: number, r: number, steps = 20): string {
  return polyline(arcPoints(cx, cy, r, 0, 360, steps), true);
}

/**
 * An arc sampled into a polyline. Sampling rather than an SVG `A` command keeps the direction
 * conventions in one place: every angle here is measured from +x with +y UP, and the caller gets
 * SVG points with y already flipped by the `X`/`Y` closures.
 */
function arcPoints(cx: number, cy: number, r: number, fromDeg: number, toDeg: number, steps = 20): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (fromDeg + ((toDeg - fromDeg) * i) / steps) * DEG;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

function arrowHead(tip: Pt, toward: Pt, size = 4): string {
  const dx = toward.x - tip.x;
  const dy = toward.y - tip.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const base = { x: tip.x + ux * size, y: tip.y + uy * size };
  return polyline(
    [
      tip,
      { x: base.x + px * size * 0.45, y: base.y + py * size * 0.45 },
      { x: base.x - px * size * 0.45, y: base.y - py * size * 0.45 },
    ],
    true,
  );
}

function charWidth(fontSize: number, text: string): number {
  return Math.max(fontSize, text.length * fontSize * 0.58);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// ---------------------------------------------------------------------------------------------
// The profile's mm space
// ---------------------------------------------------------------------------------------------

interface Layout {
  /** SVG units per mm, per axis. */
  sx: number;
  sy: number;
  /** SVG y of the tip plane. Geometry above the tip is negative y; the groove below is positive. */
  tipY: number;
  font: number;
  maxRmm: number;
  bodyRmm: number | null;
  tipRmm: number | null;
  shankRmm: number | null;
  /** Top of the cutting body, mm from the tip. Always the drawn value. */
  cutTopMm: number;
  /** Whether `cutTopMm` is stated or derived from stated numbers, not a display placeholder. */
  cutTopKnown: boolean;
  /** Where the shank begins, mm from the tip. Always the drawn value. */
  shoulderMm: number;
  shoulderKnown: boolean;
  shankTopMm: number;
  /** A nominal radius used only where a diameter is unstated; always drawn dashed. */
  displayRmm: number;
  /** The radius of the outline at `cutTopMm`. Set by the shape pass. */
  topRmm: number;
}

const FULL_SIZE = { w: 330, h: 250, font: 9.5 };
const PRINT_SIZE = { w: 300, h: 225, font: 8.5 };
const THUMB_SIZE = { w: 118, h: 82, font: 0 };

function sizeOf(size: CutterProfileSize): { w: number; h: number; font: number } {
  if (size === 'thumb') return THUMB_SIZE;
  if (size === 'print') return PRINT_SIZE;
  return FULL_SIZE;
}

/**
 * The axial anchors, in mm from the tip. A `null` means the record does not state enough to place
 * it, and the drawing puts a dashed placeholder there. `cutTop` also uses the V cone's own height:
 * where the cone reaches the stated body diameter is geometry, not a guess.
 */
function axialLayout(tool: Tool, cone: VCone | null, bodyR: number | null, tipR: number | null): Layout {
  const flute = positive(tool.fluteLength);
  const shoulder = positive(tool.shoulderLength);
  const handle = positive(tool.handleDiameter);
  const shankR = handle === null ? null : handle / 2;
  const displayR = clamp(bodyR ?? tipR ?? 1.5, 0.75, 3.5);

  const coneHeight =
    cone !== null && bodyR !== null && tipR !== null && bodyR > tipR
      ? (bodyR - tipR) / cone.tanHalf
      : null;

  const cutTopKnownVal = flute ?? coneHeight;
  const cutTop = cutTopKnownVal ?? Math.max(4, displayR * 3.2);

  // A shoulder below the flute top is a malformed record; draw the transition at the flute top so
  // the drawing cannot imply the shank starts inside the cutting edge, and let the LS dimension
  // show the stated number.
  const shoulderDraw =
    shoulder !== null ? Math.max(shoulder, cutTop) : cutTop + Math.max(2.5, displayR * 1.6);
  const shankDisplay = clamp((shankR ?? displayR) * 5, 7, 20);
  const shankTop = shoulderDraw + shankDisplay;

  return {
    sx: 1,
    sy: 1,
    tipY: 0,
    font: 0,
    maxRmm: Math.max(bodyR ?? 0, tipR ?? 0, shankR ?? 0, displayR),
    bodyRmm: bodyR,
    tipRmm: tipR,
    shankRmm: shankR,
    cutTopMm: cutTop,
    cutTopKnown: cutTopKnownVal !== null,
    shoulderMm: shoulderDraw,
    shoulderKnown: shoulder !== null,
    shankTopMm: shankTop,
    displayRmm: displayR,
    topRmm: bodyR ?? displayR,
  };
}

interface ShapePass {
  paths: CutterProfilePath[];
  fillPoints: Pt[];
  labelBand: CutterProfilePath | null;
  extraMarks: CutterProfileText[];
  groove: { paths: CutterProfilePath[]; label: CutterProfileText } | null;
  topRmm: number;
}

/**
 * Build the profile's right-hand outline (mirrored to the left), the top break, the axis, any
 * condition mark and the groove overlay. `lay` is mutated: `topRmm` is the radius at the top of
 * the cutting body, which the length dimensions' extension lines need.
 */
function buildProfile(tool: Tool, cone: VCone | null, lay: Layout, options: CutterProfileOptions): ShapePass {
  const paths: CutterProfilePath[] = [];
  const fillRight: Pt[] = [];
  const extraMarks: CutterProfileText[] = [];

  const X = (mm: number): number => mm * lay.sx;
  const Y = (mm: number): number => lay.tipY - mm * lay.sy;
  const pt = (xmm: number, ymm: number): Pt => ({ x: X(xmm), y: Y(ymm) });

  const bodyR = lay.bodyRmm;
  const tipR = lay.tipRmm;
  const shankR = lay.shankRmm;
  const displayR = lay.displayRmm;
  const rBody = bodyR ?? displayR;
  const rShank = shankR ?? Math.max(rBody, displayR);
  const cutTop = lay.cutTopMm;
  const cutKnown = lay.cutTopKnown;
  const shoulder = lay.shoulderMm;
  const shankTop = lay.shankTopMm;

  const addLine = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    opts: { dashed: boolean; role: Role; missingField?: CutterField; mirror?: boolean },
  ) => {
    const p1 = pt(x1, y1);
    const p2 = pt(x2, y2);
    const missing = opts.dashed && opts.missingField !== undefined;
    paths.push({
      d: line(p1.x, p1.y, p2.x, p2.y),
      role: opts.role,
      dashed: opts.dashed,
      missing,
      missingField: opts.missingField,
    });
    if (opts.mirror !== false) {
      paths.push({
        d: line(-p1.x, p1.y, -p2.x, p2.y),
        role: opts.role,
        dashed: opts.dashed,
        missing,
        missingField: opts.missingField,
      });
    }
    fillRight.push(p2);
  };

  const addArc = (
    cx: number,
    cy: number,
    r: number,
    fromDeg: number,
    toDeg: number,
    opts: { dashed: boolean; role: Role; missingField?: CutterField },
  ) => {
    const pts = arcPoints(cx, cy, r, fromDeg, toDeg).map((p) => pt(p.x, p.y));
    const missing = opts.dashed && opts.missingField !== undefined;
    paths.push({
      d: polyline(pts),
      role: opts.role,
      dashed: opts.dashed,
      missing,
      missingField: opts.missingField,
    });
    const mirrored = pts.map((p) => ({ x: -p.x, y: p.y })).reverse();
    paths.push({
      d: polyline(mirrored),
      role: opts.role,
      dashed: opts.dashed,
      missing,
      missingField: opts.missingField,
    });
    fillRight.push(...pts);
  };

  fillRight.push(pt(0, 0));

  const bodyKnown = bodyR !== null;
  let topR = rBody;

  switch (tool.shape) {
    case 'flat': {
      // A flat end mill's corner is sharp; `cornerRadius` on a record whose type says "flat" is
      // ignored rather than turning it into a bull nose the header did not claim.
      addLine(0, 0, rBody, 0, {
        dashed: !bodyKnown,
        role: 'tip',
        missingField: bodyKnown ? undefined : 'tipDiameter',
      });
      addLine(rBody, 0, rBody, cutTop, {
        dashed: !bodyKnown || !cutKnown,
        role: 'flank',
        missingField: !bodyKnown ? 'tipDiameter' : !cutKnown ? 'fluteLength' : undefined,
      });
      topR = rBody;
      break;
    }
    case 'bull': {
      const crValue = nonNegative(tool.cornerRadius);
      const crKnown = crValue !== null;
      const cr = crValue !== null ? Math.min(crValue, rBody) : Math.min(0.5, rBody * 0.4);
      addLine(0, 0, Math.max(0, rBody - cr), 0, {
        dashed: !bodyKnown,
        role: 'tip',
        missingField: bodyKnown ? undefined : 'tipDiameter',
      });
      if (cr > 0.0001) {
        addArc(rBody - cr, cr, cr, -90, 0, {
          dashed: !crKnown || !bodyKnown,
          role: 'tip',
          missingField: !crKnown ? 'cornerRadius' : !bodyKnown ? 'tipDiameter' : undefined,
        });
      }
      addLine(rBody, cr, rBody, cutTop, {
        dashed: !bodyKnown || !cutKnown,
        role: 'flank',
        missingField: !bodyKnown ? 'tipDiameter' : !cutKnown ? 'fluteLength' : undefined,
      });
      topR = rBody;
      break;
    }
    case 'ball': {
      const r = tipR ?? rBody;
      addArc(0, r, r, -90, 0, {
        dashed: !bodyKnown,
        role: 'tip',
        missingField: bodyKnown ? undefined : 'tipDiameter',
      });
      addLine(r, r, r, Math.max(cutTop, r), {
        dashed: !bodyKnown || !cutKnown,
        role: 'flank',
        missingField: !bodyKnown ? 'tipDiameter' : !cutKnown ? 'fluteLength' : undefined,
      });
      topR = r;
      break;
    }
    case 'tapered-ball': {
      const r = tipR ?? rBody;
      const included = positive(tool.angle);
      const half = positive(tool.halfAngle) ?? (included !== null ? included / 2 : null);
      addArc(0, r, r, -90, 0, {
        dashed: !bodyKnown,
        role: 'tip',
        missingField: bodyKnown ? undefined : 'tipDiameter',
      });
      let rTop = r;
      if (half !== null) {
        rTop = Math.min(rShank, r + Math.max(0, cutTop - r) * Math.tan(half * DEG));
      } else if (shankR !== null) {
        // No angle: the taper's endpoint is known from the shank but its slope is not. Draw the
        // endpoint, dashed, and mark the angle missing.
        rTop = shankR;
      }
      addLine(r, r, rTop, Math.max(cutTop, r), {
        dashed: !bodyKnown || !cutKnown || half === null,
        role: 'flank',
        missingField:
          half === null ? 'halfAngle' : !bodyKnown ? 'tipDiameter' : !cutKnown ? 'fluteLength' : undefined,
      });
      topR = rTop;
      break;
    }
    case 'engraving':
    case 'chamfer': {
      const tipStated = tipR !== null;
      const rTipDraw = tipR ?? Math.max(0.02, displayR * 0.15);
      const rBodyDraw = bodyR ?? rShank;
      const tanHalf = cone?.tanHalf ?? Math.tan(30 * DEG);
      const coneHeight =
        cone !== null && bodyR !== null && bodyR > rTipDraw ? (bodyR - rTipDraw) / tanHalf : null;
      const top = cone !== null && cutKnown ? cutTop : coneHeight ?? cutTop;
      const coneTop = coneHeight !== null ? Math.min(top, coneHeight) : top;
      const rAtConeTop = Math.min(rBodyDraw, rTipDraw + coneTop * tanHalf);
      const edgeMissing: CutterField | undefined = !tipStated
        ? 'tipDiameter'
        : !bodyKnown
          ? 'diameter'
          : cone === null
            ? tool.shape === 'engraving'
              ? 'halfAngle'
              : 'angle'
            : !cutKnown
              ? 'fluteLength'
              : undefined;

      addLine(0, 0, rTipDraw, 0, {
        dashed: !tipStated,
        role: 'tip',
        missingField: tipStated ? undefined : 'tipDiameter',
      });
      addLine(rTipDraw, 0, rAtConeTop, coneTop, {
        dashed: cone === null || !cutKnown || !bodyKnown,
        role: 'flank',
        missingField: edgeMissing,
      });
      if (coneTop < top - 1e-9) {
        addLine(rAtConeTop, coneTop, rBodyDraw, coneTop, {
          dashed: !bodyKnown,
          role: 'flank',
          missingField: bodyKnown ? undefined : 'diameter',
        });
        addLine(rBodyDraw, coneTop, rBodyDraw, top, {
          dashed: !bodyKnown || !cutKnown,
          role: 'flank',
          missingField: !bodyKnown ? 'diameter' : !cutKnown ? 'fluteLength' : undefined,
        });
        topR = rBodyDraw;
      } else {
        topR = rAtConeTop;
        if (bodyKnown && topR < rBodyDraw - 1e-9) {
          // The flute ends before the cone reaches the body diameter: step out to the shank at the
          // flute top. The step is geometry from the stated DC, not a guess.
          addLine(topR, top, rBodyDraw, top, { dashed: false, role: 'neck' });
          topR = rBodyDraw;
        }
      }
      break;
    }
    case 'drill': {
      const pointAngle = positive(tool.angle);
      const pointKnown = pointAngle !== null && pointAngle < 180;
      const pointH = pointKnown ? rBody / Math.tan((pointAngle / 2) * DEG) : Math.min(rBody * 1.2, 4);
      addLine(0, 0, rBody, pointH, {
        dashed: !pointKnown || !bodyKnown,
        role: 'tip',
        missingField: !bodyKnown ? 'tipDiameter' : undefined,
      });
      addLine(rBody, pointH, rBody, cutTop, {
        dashed: !bodyKnown || !cutKnown,
        role: 'flank',
        missingField: !bodyKnown ? 'tipDiameter' : !cutKnown ? 'fluteLength' : undefined,
      });
      if (!pointKnown) {
        extraMarks.push({ x: X(rBody) + 6, y: Y(pointH) + 3, text: '?', anchor: 'start', missing: true });
      }
      topR = rBody;
      break;
    }
    case 'thread': {
      addLine(0, 0, rBody, 0, {
        dashed: !bodyKnown,
        role: 'tip',
        missingField: bodyKnown ? undefined : 'tipDiameter',
      });
      addLine(rBody, 0, rBody, cutTop, {
        dashed: !bodyKnown || !cutKnown,
        role: 'flank',
        missingField: !bodyKnown ? 'tipDiameter' : !cutKnown ? 'fluteLength' : undefined,
      });
      // A few shallow notches say "thread mill" without inventing a pitch this record does not
      // carry.
      if (bodyKnown && cutKnown && cutTop > 0) {
        for (let i = 1; i <= 4; i++) {
          const y = (cutTop * i) / 5;
          const p1 = pt(rBody, y);
          const p2 = pt(rBody * 0.86, y + Math.min(0.8, cutTop / 18));
          paths.push({ d: line(p1.x, p1.y, p2.x, p2.y), role: 'detail', dashed: false, missing: false });
          paths.push({ d: line(-p1.x, p1.y, -p2.x, p2.y), role: 'detail', dashed: false, missing: false });
        }
      }
      if (!cutKnown) {
        extraMarks.push({ x: X(rBody) + 6, y: Y(cutTop * 0.55), text: '?', anchor: 'start', missing: true });
      }
      topR = rBody;
      break;
    }
    case 'unknown': {
      // The refusal placeholder: a clearly dashed body, never a guessed silhouette.
      const r = displayR;
      addLine(0, 0, r, 0, { dashed: true, role: 'tip', missingField: 'tipDiameter' });
      addLine(r, 0, r, cutTop, { dashed: true, role: 'flank', missingField: 'fluteLength' });
      topR = r;
      break;
    }
  }

  // ---- the neck, shoulder step and shank -----------------------------------------------------
  if (cutTop < shoulder - 1e-9) {
    addLine(topR, cutTop, topR, shoulder, {
      dashed: !lay.shoulderKnown,
      role: 'neck',
      missingField: lay.shoulderKnown ? undefined : 'shoulderLength',
    });
  }
  addLine(topR, shoulder, rShank, shoulder, {
    dashed: !lay.shoulderKnown || shankR === null,
    role: 'neck',
    missingField: !lay.shoulderKnown ? 'shoulderLength' : shankR === null ? 'handleDiameter' : undefined,
  });
  addLine(rShank, shoulder, rShank, shankTop, {
    dashed: shankR === null,
    role: 'shank',
    missingField: shankR === null ? 'handleDiameter' : undefined,
  });
  lay.topRmm = topR;

  // The top break: a short zigzag says the shank continues past the drawing.
  const breakPts: Pt[] = [];
  for (let i = 0; i <= 4; i++) {
    const x = -rShank + ((2 * rShank) * i) / 4;
    breakPts.push({ x: X(x), y: Y(shankTop) + (i % 2 === 0 ? 0 : 5) });
  }
  paths.push({ d: polyline(breakPts), role: 'break', dashed: false, missing: false });

  // The axis: a light centre line from below the tip to the break.
  paths.push({
    d: line(0, Y(-Math.max(2, displayR)), 0, Y(shankTop)),
    role: 'axis',
    dashed: true,
    missing: false,
  });

  // The tip plane line, light, so the reader can see where Z0 of the profile is.
  const planeR = Math.max(rBody, tipR ?? 0);
  paths.push({ d: line(X(-planeR), Y(0), X(planeR), Y(0)), role: 'axis', dashed: true, missing: false });

  // The fill polygon: right side bottom→top, across the break, left side top→bottom.
  const fillPoints: Pt[] = [...fillRight];
  fillPoints.push({ x: -X(rShank), y: Y(shankTop) });
  for (let i = fillRight.length - 1; i >= 0; i--) {
    const p = fillRight[i]!;
    fillPoints.push({ x: -p.x, y: p.y });
  }

  // The label band on the shank of an owned cutter, as a separate fill the React view can colour.
  let labelBand: CutterProfilePath | null = null;
  if (options.labelColor !== null && options.labelColor !== undefined) {
    const bandH = Math.min(2.6, Math.max(0.8, (shankTop - shoulder) * 0.3));
    const bandTop = shankTop - Math.max(1.2, bandH * 0.55);
    labelBand = {
      d: rectPath(X(-rShank), Y(bandTop), 2 * X(rShank), bandH * lay.sy),
      role: 'shank',
      dashed: false,
      missing: false,
      fill: true,
    };
  }

  // The condition marks (#432): worn is a small ring on the flute; broken is a break at the tip.
  if (options.condition === 'worn') {
    const cx = X(Math.max(topR, 0.5)) + 8;
    const cy = Y(Math.max(cutTop * 0.45, 1));
    paths.push({ d: circlePath(cx, cy, 5), role: 'detail', dashed: false, missing: false });
    paths.push({ d: line(cx - 8, cy, cx + 8, cy), role: 'detail', dashed: false, missing: false });
  } else if (options.condition === 'broken') {
    const y = Y(0);
    const r = Math.max(X(tipR ?? displayR * 0.3), 2);
    paths.push({
      d: polyline([
        { x: -r, y: y - 5 },
        { x: -r * 0.3, y: y + 5 },
        { x: r * 0.3, y: y - 5 },
        { x: r, y: y + 5 },
      ]),
      role: 'detail',
      dashed: false,
      missing: false,
    });
  }

  // The groove width at the job's depth: the honest second outline for a V-bit.
  let groove: ShapePass['groove'] = null;
  const grooveDepth = positive(options.grooveDepth);
  if (cone !== null && grooveDepth !== null) {
    const grooveR = grooveRadiusAt(cone, grooveDepth);
    const pL = pt(-cone.tipRadius, 0);
    const pR = pt(cone.tipRadius, 0);
    const qL = pt(-grooveR, -grooveDepth);
    const qR = pt(grooveR, -grooveDepth);
    groove = {
      paths: [
        { d: line(pR.x, pR.y, qR.x, qR.y), role: 'groove', dashed: true, missing: false },
        { d: line(pL.x, pL.y, qL.x, qL.y), role: 'groove', dashed: true, missing: false },
        { d: line(qL.x, qL.y, qR.x, qR.y), role: 'groove', dashed: false, missing: false },
        { d: line(0, pL.y, 0, qL.y), role: 'axis', dashed: true, missing: false },
      ],
      label: {
        x: X(grooveR) + 8,
        y: Y(-grooveDepth) + 4,
        text: `Ø ${fmtMm(grooveR * 2)} mm at ${fmtMm(grooveDepth)} mm deep`,
        anchor: 'start',
      },
    };
  }

  return { paths, fillPoints, labelBand, extraMarks, groove, topRmm: topR };
}

// ---------------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------------

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function newBounds(): Bounds {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
}

function addPoint(b: Bounds, x: number, y: number, pad = 0): void {
  b.minX = Math.min(b.minX, x - pad);
  b.maxX = Math.max(b.maxX, x + pad);
  b.minY = Math.min(b.minY, y - pad);
  b.maxY = Math.max(b.maxY, y + pad);
}

function addPathBounds(b: Bounds, p: CutterProfilePath): void {
  const nums = p.d.match(/-?\d+(?:\.\d+)?/g);
  if (nums === null) return;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = Number(nums[i]);
    const y = Number(nums[i + 1]);
    if (Number.isFinite(x) && Number.isFinite(y)) addPoint(b, x, y);
  }
}

function addTextBounds(b: Bounds, t: CutterProfileText, font: number): void {
  const w = charWidth(font, t.text);
  const left = t.anchor === 'start' ? t.x : t.anchor === 'middle' ? t.x - w / 2 : t.x - w;
  addPoint(b, left, t.y - font);
  addPoint(b, left + w, t.y + font * 0.4);
}

function boundsOrFallback(b: Bounds): Bounds {
  if (!Number.isFinite(b.minX)) return { minX: -20, minY: -20, maxX: 20, maxY: 20 };
  return b;
}

// ---------------------------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------------------------

function placeDimensions(
  tool: Tool,
  specs: readonly CutterDimensionSpec[],
  lay: Layout,
  cone: VCone | null,
): CutterProfileDimension[] {
  const X = (mm: number): number => mm * lay.sx;
  const Y = (mm: number): number => lay.tipY - mm * lay.sy;
  const bodyR = lay.bodyRmm ?? lay.displayRmm;
  const tipR = lay.tipRmm ?? Math.max(0.02, lay.displayRmm * 0.15);
  const shankR = lay.shankRmm ?? Math.max(bodyR, lay.displayRmm);
  const cutTop = lay.cutTopMm;
  const shoulder = lay.shoulderMm;
  const shankTop = lay.shankTopMm;
  const topR = lay.topRmm;
  const font = lay.font;
  const maxR = Math.max(bodyR, tipR, shankR, lay.displayRmm);
  const vShape = tool.shape === 'engraving' || tool.shape === 'chamfer';

  const out: CutterProfileDimension[] = [];
  let lengthLevel = 0;

  for (const spec of specs) {
    const missing = spec.missing;
    const paths: CutterProfilePath[] = [];

    if (spec.kind === 'diameter') {
      let yMm: number;
      let rMm: number;
      if (spec.code === 'D1') {
        yMm = -Math.max(3, lay.displayRmm * 1.2);
        rMm = tipR;
      } else if (spec.code === 'DC') {
        // A V-bit's major diameter is at the top of its cone; dimensioning it across the middle of
        // the cone would show a width the bit does not have there.
        yMm = vShape
          ? cutTop < shoulder - 1e-9
            ? cutTop + Math.min(0.8, (shoulder - cutTop) / 2)
            : Math.max(cutTop - 0.6, 0.2)
          : Math.max(cutTop * 0.45, 0.4);
        rMm = bodyR;
      } else {
        yMm = (shoulder + shankTop) / 2;
        rMm = shankR;
      }
      const y = Y(yMm);
      const x1 = -X(rMm);
      const x2 = X(rMm);
      paths.push({ d: line(x1, y, x2, y), role: 'dimension', dashed: missing, missing });
      paths.push({
        d: arrowHead({ x: x1, y }, { x: x2, y }),
        role: 'arrow',
        dashed: false,
        missing: false,
        fill: true,
      });
      paths.push({
        d: arrowHead({ x: x2, y }, { x: x1, y }),
        role: 'arrow',
        dashed: false,
        missing: false,
        fill: true,
      });
      if (spec.code === 'D1') {
        paths.push({ d: line(-X(tipR), Y(0), -X(tipR), y), role: 'extension', dashed: missing, missing });
        paths.push({ d: line(X(tipR), Y(0), X(tipR), y), role: 'extension', dashed: missing, missing });
      } else if (spec.code === 'DS') {
        paths.push({ d: line(-X(shankR), Y(shoulder), -X(shankR), y), role: 'extension', dashed: missing, missing });
        paths.push({ d: line(X(shankR), Y(shoulder), X(shankR), y), role: 'extension', dashed: missing, missing });
      } else if (vShape) {
        // The widest point of the cone is its top; draw the extension from there to the dimension.
        paths.push({ d: line(-X(bodyR), Y(cutTop), -X(bodyR), y), role: 'extension', dashed: missing, missing });
        paths.push({ d: line(X(bodyR), Y(cutTop), X(bodyR), y), role: 'extension', dashed: missing, missing });
      }
      const text = `${spec.code} ${spec.text}`;
      const tw = charWidth(font, text);
      out.push({
        ...spec,
        paths,
        textAt: {
          x: 0,
          y: y - 4,
          text,
          anchor: 'middle',
          missing,
          background: { x: -tw / 2 - 2, y: y - 4 - font, width: tw + 4, height: font + 2 },
        },
      });
      continue;
    }

    if (spec.kind === 'length') {
      const isFlute = spec.code === 'LC';
      const anchorMm = isFlute ? cutTop : shoulder;
      const edgeTop = isFlute ? topR : shankR;
      const edgeBottom = tipR;
      const x = -X(maxR) - 14 - lengthLevel * 20;
      lengthLevel += 1;
      const yTop = Y(anchorMm);
      const yBottom = Y(0);
      paths.push({ d: line(x, yTop, x, yBottom), role: 'dimension', dashed: missing, missing });
      paths.push({
        d: arrowHead({ x, y: yTop }, { x, y: yBottom }),
        role: 'arrow',
        dashed: false,
        missing: false,
        fill: true,
      });
      paths.push({
        d: arrowHead({ x, y: yBottom }, { x, y: yTop }),
        role: 'arrow',
        dashed: false,
        missing: false,
        fill: true,
      });
      paths.push({ d: line(-X(edgeTop), yTop, x, yTop), role: 'extension', dashed: missing, missing });
      paths.push({ d: line(-X(edgeBottom), yBottom, x, yBottom), role: 'extension', dashed: missing, missing });
      out.push({
        ...spec,
        paths,
        textAt: {
          x: x - 5,
          y: (yTop + yBottom) / 2 + 3,
          text: `${spec.code} ${spec.text}`,
          anchor: 'middle',
          rotate: -90,
          missing,
        },
      });
      continue;
    }

    if (spec.kind === 'angle') {
      // A dimension arc at the tip. AN is measured from the axis; TI spans both flanks.
      const half =
        spec.code === 'TI'
          ? spec.value !== null
            ? spec.value / 2
            : (cone?.halfAngleDeg ?? 30)
          : spec.value !== null
            ? spec.value
            : (cone?.halfAngleDeg ?? 30);
      const radius = clamp(maxR * lay.sx * 0.55, 14, 30);
      const a0 = spec.code === 'TI' ? 90 - half : 90;
      const a1 = spec.code === 'TI' ? 90 + half : 90 - half;
      const pts = arcPoints(0, 0, radius, a0, a1).map((p) => ({ x: p.x, y: Y(0) - p.y }));
      paths.push({ d: polyline(pts), role: 'arc', dashed: missing, missing });
      for (const a of [a0, a1]) {
        const r0 = radius - 3;
        const r1 = radius + 3;
        const p0 = { x: r0 * Math.cos(a * DEG), y: Y(0) - r0 * Math.sin(a * DEG) };
        const p1 = { x: r1 * Math.cos(a * DEG), y: Y(0) - r1 * Math.sin(a * DEG) };
        paths.push({ d: line(p0.x, p0.y, p1.x, p1.y), role: 'extension', dashed: missing, missing });
      }
      const mid = (a0 + a1) / 2;
      const labelR = radius + 9;
      // AN is the half angle, and on a narrow V (a 30° engraver is 15° a side) the arc's midpoint
      // is only a few pixels from the axis: a centred label there sits on the cone's own edge (#489
      // visual review). Put AN just outside the measured flank, reading away from the tool; TI spans
      // the whole point and its centred label is clear inside a wide cone.
      const isAn = spec.code === 'AN';
      const labelAngle = isAn ? a1 : mid;
      out.push({
        ...spec,
        paths,
        textAt: {
          x: isAn
            ? radius * Math.cos(labelAngle * DEG) + 14
            : labelR * Math.cos(mid * DEG),
          y: Y(0) - radius * Math.sin(labelAngle * DEG) + 3,
          text: `${spec.code} ${spec.text}`,
          anchor: isAn ? 'start' : 'middle',
          missing,
        },
      });
      continue;
    }

    // CR: a leader to the tip corner (or the ball's arc).
    const ball = tool.shape === 'ball' || tool.shape === 'tapered-ball';
    const px = ball ? tipR * 0.72 : tipR;
    const py = ball
      ? tipR * (1 - 0.72)
      : Math.min(nonNegative(tool.cornerRadius) ?? lay.displayRmm * 0.3, tipR);
    const from = { x: X(px) + 5, y: Y(py) + 4 };
    const to = { x: X(px) + 26, y: Y(py) - 14 };
    paths.push({ d: line(from.x, from.y, to.x, to.y), role: 'leader', dashed: missing, missing });
    paths.push({
      d: circlePath(from.x, from.y, 1.4),
      role: 'leader',
      dashed: false,
      missing: false,
      fill: true,
    });
    out.push({
      ...spec,
      paths,
      textAt: { x: to.x + 2, y: to.y + 2, text: `${spec.code} ${spec.text}`, anchor: 'start', missing },
    });
  }

  return out;
}

// ---------------------------------------------------------------------------------------------
// Refusal and prose
// ---------------------------------------------------------------------------------------------

/**
 * The refusal this module can judge for itself, with the simulator's own code. Missing numbers are
 * NOT a refusal: they are drawn dashed (`?`), because a record can be completed. Only a type this
 * module has no profile for is refused here; a simulator refusal arrives through `options.refusal`.
 */
function judgeRefusal(tool: Tool): CutterRefusal | null {
  if (tool.shape === 'unknown') {
    return {
      code: 'tool-refused',
      reason: `the record names type "${tool.typeText || '(missing)'}" — no cutter profile is defined for it`,
    };
  }
  return null;
}

function uniq<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function describeProfile(
  tool: Tool,
  specs: readonly CutterDimensionSpec[],
  missing: readonly CutterField[],
  cone: VCone | null,
  grooveDepth: number | null,
  refusal: CutterRefusal | null,
): string {
  const stated = specs.filter((s) => !s.missing).map((s) => `${s.code} ${s.text} (${s.label})`);
  const absent = specs.filter((s) => s.missing).map((s) => `${s.code} ${s.label}`);
  const parts = [
    `Side profile of ${tool.name || 'a cutter'}, drawn from its Tool record: a ${SHAPE_LABELS[tool.shape]}.`,
    stated.length > 0 ? `Stated: ${stated.join(', ')}.` : 'No dimensions are stated.',
    absent.length > 0
      ? `Not stated, drawn dashed: ${absent.join(', ')}.`
      : 'Every dimension in this shape’s vocabulary is stated.',
  ];
  if (missing.includes('shoulderLength') && !absent.some((a) => a.startsWith('LS'))) {
    parts.push('Shoulder length is not stated, so the edge that depends on it is dashed.');
  }
  if (cone !== null && grooveDepth !== null && grooveDepth > 0) {
    const width = grooveRadiusAt(cone, grooveDepth) * 2;
    parts.push(
      `At ${fmtMm(grooveDepth)} mm deep the V groove is Ø ${fmtMm(width)} mm across its top opening.`,
    );
  } else if (cone !== null) {
    parts.push(
      'The V cone is drawn from the stated tip diameter and half angle; no job depth was supplied for its groove width.',
    );
  }
  if (refusal !== null) parts.push(`The simulator refuses it: ${refusal.reason}.`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------------------------
// Building the model
// ---------------------------------------------------------------------------------------------

/** A round millimetre value whose drawn length lands in `[minUnits, maxUnits]`. */
function niceBarMm(scale: number, minUnits: number, maxUnits: number): { mm: number; units: number } {
  const candidates = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
  let best = candidates[0]!;
  for (const mm of candidates) {
    const units = mm * scale;
    if (units >= minUnits && units <= maxUnits) return { mm, units };
    if (units < minUnits) best = mm;
  }
  return { mm: best, units: best * scale };
}

/** The layout a tool's numbers produce, before any scale is chosen. */
function layoutFor(tool: Tool): { lay: Layout; cone: VCone | null } {
  const cone = vCone(tool);
  const dc = cuttingDiameterSource(tool);
  const tip = positive(tool.tipDiameter);
  return {
    lay: axialLayout(tool, cone, dc.value !== null ? dc.value / 2 : null, tip !== null ? tip / 2 : null),
    cone,
  };
}

/** The largest scale at which this tool fits its mount at one uniform px/mm. */
function fitScale(lay: Layout, size: CutterProfileSize): number {
  const dims = sizeOf(size);
  const widthRoom = dims.w * (size === 'thumb' ? 0.92 : 0.56);
  const heightRoom = dims.h * (size === 'thumb' ? 0.9 : 0.66);
  const fitX = widthRoom / Math.max(0.2, lay.maxRmm * 2);
  const fitY = heightRoom / Math.max(1, lay.shankTopMm);
  return Math.min(fitX, fitY);
}

/**
 * One scale for a list of drawings (#489 review), so the tools table, a picker list and a sheet
 * drawn side by side keep their true relative sizes: a 1 mm flat looks small beside a 6.35 mm ball.
 * The smallest fit among the tools is the one every drawing can use. Pass it to each
 * `buildCutterProfile`/`CutterProfile` with the same `size`.
 */
export function cutterProfileScale(
  tools: readonly Tool[],
  size: CutterProfileSize = 'full',
): number {
  let scale = Infinity;
  for (const tool of tools) scale = Math.min(scale, fitScale(layoutFor(tool).lay, size));
  // The same ceiling the single-drawing path applies, so a list of only tiny cutters cannot blow
  // the mount's px/mm up without bound.
  return Number.isFinite(scale) ? Math.min(scale, 200) : 1;
}

/**
 * The profile, as a model the two renderers share. Pure: same input, same output, no DOM.
 */
export function buildCutterProfile(tool: Tool, options: CutterProfileOptions = {}): CutterProfileModel {
  const size = options.size ?? 'full';
  const dims = sizeOf(size);
  const { lay, cone } = layoutFor(tool);

  // One uniform scale is the truthful default. For a single drawing, an axis is only stretched when
  // it would be unreadably thin at that scale, and the note says which one and by how much. A
  // caller passing a shared `scale` gets that scale untouched on both axes, so a list stays
  // comparable.
  const shared = positive(options.scale ?? null);
  if (shared !== null) {
    lay.sx = Math.min(shared, 260);
    lay.sy = lay.sx;
  } else {
    const uniform = fitScale(lay, size);
    let sx = uniform;
    let sy = uniform;
    const minWidth = size === 'thumb' ? 8 : 14;
    const minHeight = size === 'thumb' ? 22 : 32;
    if (lay.maxRmm * 2 * sx < minWidth) sx = minWidth / Math.max(0.2, lay.maxRmm * 2);
    if (lay.shankTopMm * sy < minHeight) sy = minHeight / Math.max(1, lay.shankTopMm);
    lay.sx = Math.min(sx, 260);
    lay.sy = Math.min(sy, 200);
  }
  lay.font = dims.font;

  const built = buildProfile(tool, cone, lay, options);
  const specs = cutterDimensionSpecs(tool);
  const dimensions = size === 'thumb' ? [] : placeDimensions(tool, specs, lay, cone);
  // A V-bit's D1 sits directly under the tip — exactly where the groove note would land. Move the
  // note below that dimension line rather than letting the two texts overprint each other. Chamfer
  // has no D1, so its note keeps the leader it was built with.
  const tipDimension = dimensions.find((d) => d.code === 'D1');
  if (built.groove !== null && tipDimension !== undefined) {
    built.groove.label = {
      ...built.groove.label,
      y: tipDimension.textAt.y + lay.font + 4,
    };
  }
  const extraMarks = size === 'thumb' ? [] : built.extraMarks;
  const judged = judgeRefusal(tool);
  const refusal = options.refusal ?? judged;
  const refusalLines =
    refusal === null ? [] : wrapText(`${refusal.code}: ${refusal.reason}`, size === 'thumb' ? 30 : 62);

  // ---- bounds -------------------------------------------------------------------------------
  const b = newBounds();
  for (const p of built.paths) addPathBounds(b, p);
  for (const p of built.groove?.paths ?? []) addPathBounds(b, p);
  if (built.labelBand !== null) addPathBounds(b, built.labelBand);
  for (const d of dimensions) {
    for (const p of d.paths) addPathBounds(b, p);
    addTextBounds(b, d.textAt, dims.font);
  }
  for (const m of extraMarks) addTextBounds(b, m, dims.font);
  if (built.groove !== null) addTextBounds(b, built.groove.label, dims.font);

  // ---- one scale bar, under the tool on the shank's axis (#489 review) -----------------------
  const scaleBars: CutterProfileScaleBar[] = [];
  let scaleNote: string | null = null;
  let scaleNoteAt: CutterProfileText | null = null;
  if (size !== 'thumb') {
    const base = boundsOrFallback(b);
    const barY = base.maxY + 22;
    const bar = niceBarMm(lay.sx, 34, 78);
    const half = bar.units / 2;
    scaleBars.push({
      orientation: 'horizontal',
      x1: -half,
      y1: barY,
      x2: half,
      y2: barY,
      ticks: [
        { x1: -half, y1: barY - 4, x2: -half, y2: barY + 4 },
        { x1: half, y1: barY - 4, x2: half, y2: barY + 4 },
      ],
      mm: bar.mm,
      textAt: {
        x: 0,
        y: barY + 13,
        text: `scale ${bar.mm} mm`,
        anchor: 'middle',
      },
    });
    // The scale bar measures the horizontal axis. Say so only when a single drawing really had to
    // compress the other axis to fit its mount; a shared list scale never does.
    const ratio = lay.sy / lay.sx;
    if (ratio < 0.75) scaleNote = `length compressed ${fmtDeg(1 / ratio)}×`;
    else if (ratio > 1.33) scaleNote = `width compressed ${fmtDeg(ratio)}×`;
    for (const b1 of scaleBars) {
      addPoint(b, b1.x1, b1.y1, 4);
      addPoint(b, b1.x2, b1.y2, 4);
      addTextBounds(b, b1.textAt, dims.font);
      for (const t of b1.ticks) {
        addPoint(b, t.x1, t.y1);
        addPoint(b, t.x2, t.y2);
      }
    }
    if (scaleNote !== null) {
      scaleNoteAt = {
        x: 0,
        y: barY + 28,
        text: scaleNote,
        anchor: 'middle',
      };
      addTextBounds(b, scaleNoteAt, dims.font - 0.5);
    }
  }

  // ---- the refusal's reason, when the standalone SVG will carry it ---------------------------
  let refusalAt: { x: number; y: number } | null = null;
  if (size !== 'thumb' && refusalLines.length > 0) {
    const base = boundsOrFallback(b);
    refusalAt = { x: base.minX + 4, y: base.maxY + 18 };
    if (options.reasonInSvg === true) {
      refusalLines.forEach((text, i) => {
        addTextBounds(
          b,
          { x: refusalAt!.x, y: refusalAt!.y + i * 11, text, anchor: 'start', missing: true },
          dims.font - 0.5,
        );
      });
    }
  }

  const missingFields = uniq<CutterField>([
    ...specs.filter((s) => s.missing).map((s) => s.field),
    ...built.paths.flatMap((p) => (p.missingField !== undefined ? [p.missingField] : [])),
  ]);

  const final = boundsOrFallback(b);
  const padX = size === 'thumb' ? 4 : 8;
  const padY = size === 'thumb' ? 4 : 8;
  const title = `${tool.name || 'Cutter'} — ${SHAPE_LABELS[tool.shape]} profile`;
  const desc = describeProfile(tool, specs, missingFields, cone, options.grooveDepth ?? null, refusal);

  return {
    size,
    viewBox: {
      x: final.minX - padX,
      y: final.minY - padY,
      width: Math.max(1, final.maxX - final.minX + padX * 2),
      height: Math.max(1, final.maxY - final.minY + padY * 2),
    },
    scale: { x: lay.sx, y: lay.sy },
    title,
    desc,
    shape: tool.shape,
    paths: built.paths,
    fillPath: built.fillPoints.length > 2 ? polyline(built.fillPoints, true) : null,
    labelBand: built.labelBand,
    dimensions,
    scaleBars,
    scaleNote,
    scaleNoteAt,
    extraMarks,
    groove: built.groove,
    cone,
    refusal,
    refusalLines,
    refusalAt,
    labelColor: options.labelColor ?? null,
    condition: options.condition ?? null,
    missingFields,
  };
}

// ---------------------------------------------------------------------------------------------
// The standalone SVG (run sheet + Markdown)
// ---------------------------------------------------------------------------------------------

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function pathAttrs(p: CutterProfilePath): string {
  const dash = p.dashed ? ' stroke-dasharray="4 3"' : '';
  if (p.fill === true) return 'fill="currentColor" stroke="none"';
  const colour = p.missing
    ? 'var(--cutter-missing, #8a1c1c)'
    : p.role === 'axis' || p.role === 'detail' || p.role === 'extension'
      ? 'var(--cutter-muted, currentColor)'
      : 'currentColor';
  const width =
    p.role === 'tip' || p.role === 'flank' || p.role === 'shank' || p.role === 'neck'
      ? 1.4
      : p.role === 'break'
        ? 1.1
        : p.role === 'dimension' || p.role === 'leader'
          ? 0.7
          : 0.6;
  const opacity = p.role === 'axis' ? ' opacity="0.45"' : p.role === 'detail' ? ' opacity="0.7"' : '';
  return `fill="none" stroke="${colour}" stroke-width="${width}"${dash}${opacity} stroke-linecap="round" stroke-linejoin="round"`;
}

function textSvg(t: CutterProfileText, fontSize: number, colour: string): string {
  const rotate =
    t.rotate === undefined ? '' : ` transform="rotate(${t.rotate} ${round(t.x)} ${round(t.y)})"`;
  const fill = t.missing === true ? 'var(--cutter-missing, #8a1c1c)' : colour;
  return (
    `<text x="${round(t.x)}" y="${round(t.y)}" text-anchor="${t.anchor}" font-family="ui-sans-serif, system-ui, sans-serif" ` +
    `font-size="${round(fontSize)}" font-weight="${t.missing === true ? '600' : '400'}" fill="${fill}"${rotate}>${esc(t.text)}</text>`
  );
}

/**
 * The profile as a standalone monochrome SVG string. The run sheet stores this, and the Markdown
 * renderer embeds it verbatim, so the paper does not depend on the app's stylesheet (#489).
 */
export function cutterProfileSvg(tool: Tool, options: CutterProfileOptions = {}): string {
  const size = options.size ?? 'print';
  const model = buildCutterProfile(tool, { ...options, size, reasonInSvg: true });
  const vb = model.viewBox;
  const font = sizeOf(size).font;
  const ink = model.refusal !== null ? '#666666' : '#111111';
  const fill = model.refusal !== null ? '#eeeeee' : '#f4f4f4';
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(vb.x)} ${round(vb.y)} ${round(vb.width)} ${round(vb.height)}" ` +
      `class="cutter-profile-svg cutter-profile--${size}${model.refusal !== null ? ' is-refused' : ''}" ` +
      `role="img" aria-label="${esc(model.title)}" style="color:${ink};--cutter-missing:#8a1c1c;--cutter-muted:#555555">`,
  );
  parts.push(`<title>${esc(model.title)}</title><desc>${esc(model.desc)}</desc>`);

  if (model.fillPath !== null) {
    parts.push(
      `<path d="${model.fillPath}" fill="${fill}" stroke="none" fill-opacity="${size === 'thumb' ? '0.5' : '1'}" />`,
    );
  }
  for (const p of model.paths) parts.push(`<path d="${p.d}" ${pathAttrs(p)} />`);
  if (model.labelBand !== null) {
    parts.push(`<path d="${model.labelBand.d}" fill="${ink}" stroke="none" fill-opacity="0.22" />`);
  }

  for (const d of model.dimensions) {
    parts.push(
      `<g class="cutter-profile__dimension${d.missing ? ' is-missing' : ''}" data-dimension="${d.code}" data-field="${d.field}">`,
    );
    for (const p of d.paths) parts.push(`<path d="${p.d}" ${pathAttrs(p)} />`);
    if (d.textAt.background) {
      const bg = d.textAt.background;
      parts.push(
        `<rect x="${round(bg.x)}" y="${round(bg.y)}" width="${round(bg.width)}" height="${round(bg.height)}" fill="${fill}" />`,
      );
    }
    parts.push(textSvg(d.textAt, font, ink));
    parts.push('</g>');
  }

  if (model.groove !== null) {
    parts.push('<g class="cutter-profile__groove">');
    for (const p of model.groove.paths) parts.push(`<path d="${p.d}" ${pathAttrs(p)} />`);
    parts.push(textSvg(model.groove.label, font, ink));
    parts.push('</g>');
  }

  for (const m of model.extraMarks) parts.push(textSvg(m, font, ink));

  if (model.scaleBars.length > 0) {
    parts.push('<g class="cutter-profile__scale">');
    for (const bar of model.scaleBars) {
      parts.push(
        `<path d="${line(bar.x1, bar.y1, bar.x2, bar.y2)}" fill="none" stroke="${ink}" stroke-width="1" />`,
      );
      for (const t of bar.ticks) {
        parts.push(`<path d="${line(t.x1, t.y1, t.x2, t.y2)}" fill="none" stroke="${ink}" stroke-width="1" />`);
      }
      parts.push(textSvg(bar.textAt, Math.max(7.5, font - 0.5), ink));
    }
    if (model.scaleNoteAt !== null) {
      parts.push(textSvg(model.scaleNoteAt, Math.max(7.5, font - 0.5), ink));
    }
    parts.push('</g>');
  }

  if (model.refusalLines.length > 0 && model.refusalAt !== null && size !== 'thumb') {
    parts.push('<g class="cutter-profile__refusal">');
    model.refusalLines.forEach((text, i) => {
      parts.push(
        `<text x="${round(model.refusalAt!.x)}" y="${round(model.refusalAt!.y + i * 11)}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="${round(font - 0.5)}" fill="#8a1c1c" font-weight="600">${esc(text)}</text>`,
      );
    });
    parts.push('</g>');
  }

  parts.push('</svg>');
  return parts.join('');
}
