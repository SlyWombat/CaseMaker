/**
 * #241 slice 2 — THE FACE OPERATIONS TURNED INTO AN INDEXED PROGRAM'S FACE AND HOLE LIST.
 *
 * One place reads `job.faces` — the operations the wizard's step 4 makes, in cut order — and says
 * what the machine cuts: an `IndexedFace` (or a run of them) for a Flat and for each face of
 * Faces all round, an `IndexedHole` for a Cross-hole, and the ORACLE PREDICTION for each (`a`, the
 * depth below the surface, and the region that depth should leave).
 *
 * THE SHAPE OF A FACE. On a round stock a flat `d` deep is as wide as the CHORD there,
 * `2√(R² − (R − d)²)`; the face is a pocket at `Z = R − d` whose passes step over in Y
 * (`cam/indexed.ts`'s `facePassYs`). The passes span X between the jaws' keep-out and the
 * tailstock's band, LESS one cutter radius at each end, because the verifier judges the cutter's
 * EDGE against those bands (`wrap-into-clamp`) and a face that starts at the keep-out line would
 * drive the edge through it.
 *
 * THE PREDICTION is the swept region at the face's plane, never a plain rectangle: each pass is a
 * capsule at the pass's own Y, and the union is what the tool really leaves. The per-face oracle
 * compares it with the sweep turned back into the face frame (`#708`), so a face cut too shallow
 * or at the wrong index is named by `a`.
 *
 * Refusals are findings in operator words, with units: the job is not in the chuck, the cutter is
 * not a flat end, a depth reaches the axis, the across-flats is not inside the stock, the free
 * span has no room for the cutter, or a map item shares the job with a face. Each names the way
 * out. A cross-hole whose diameter differs from the cutter's is a WARNING that says what comes out.
 */

import type { Mm } from '@/types/units';
import type { EngraveFaceItem, EngraveFaceOp, EngraveFaceOpKind, EngraveJob } from '@/types/engraveJob';
import type { IndexedFace, IndexedHole } from '@/engine/cnc/cam/indexed';
import { facePassYs } from '@/engine/cnc/cam/indexed';
import type { CutParams } from '@/engine/cnc/feeds';
import type { OraclePredicted, OraclePoint } from '@/engine/cnc/engrave/oracle';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { cuttingDiameter, cuttingRadiusForSweep, type Tool } from '@/engine/cnc/tool';
import { rotaryFreeSpan, rotaryMapOf, sectionRadiusAt, sectionWords, type RotaryCutFace, type RotaryMap, type RotarySection } from './wrap';
import { liveShopDefaults } from '@/platform/defaultsClient';

/** The width of a face at a depth below the surface, mm: the chord of the turned circle. */
export function faceChordMm(radiusMm: Mm, depthMm: Mm): Mm {
  const r = Math.max(0, radiusMm);
  const inner = r - Math.max(0, depthMm);
  if (!(r > 0) || inner < 0) return 0;
  return 2 * Math.sqrt(Math.max(0, r * r - inner * inner));
}

/**
 * The chord of a RECT section by the plane `y·sinθ + z·cosθ = p`, mm — the length of that line
 * inside the rectangle `|y| ≤ width/2`, `|z| ≤ height/2`. Solved as two linear clips (one per
 * edge pair) along the line's own direction, so θ at 0 and 90° need no special case.
 */
function rectChordMm(width: Mm, height: Mm, theta: number, p: Mm): Mm {
  const halfW = width / 2;
  const halfH = height / 2;
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  // The line's points are q(t) = p·(sinθ, cosθ) + t·(cosθ, −sinθ); clip t against each pair.
  let lo = -Infinity;
  let hi = Infinity;
  const clip = (centre: number, dir: number, half: number): boolean => {
    if (Math.abs(dir) < 1e-12) return Math.abs(centre) <= half + 1e-9;
    const t1 = (-half - centre) / dir;
    const t2 = (half - centre) / dir;
    lo = Math.max(lo, Math.min(t1, t2));
    hi = Math.min(hi, Math.max(t1, t2));
    return true;
  };
  if (!clip(p * s, c, halfW)) return 0;
  if (!clip(p * c, -s, halfH)) return 0;
  return hi > lo ? hi - lo : 0;
}

/**
 * #1059 — A FACE'S WIDTH IS THE SECTION'S OWN, not the turned circle's. The face at index `a`
 * cuts down from the stock's surface THERE — `sectionRadiusAt(section, a)` — and is as wide as
 * the section at `depth` below it. On a ROUND rod this is exactly {@link faceChordMm} (the
 * surface is the envelope at every angle); on a BLOCK it is the flat's own side at A 0 (44.5 mm
 * on a 44.5 mm square, where the circle's chord is 22.07) and the corner's chord at A 45 (2 mm
 * one millimetre below the corner, where the circle's is 15.34).
 */
export function sectionFaceChordMm(section: RotarySection, a: number, depthMm: Mm): Mm {
  const theta = (a * Math.PI) / 180;
  const surface = sectionRadiusAt(section, theta);
  const p = surface - Math.max(0, depthMm);
  if (!(surface > 0) || p < 0) return 0;
  if (section.kind === 'round') return 2 * Math.sqrt(Math.max(0, surface * surface - p * p));
  return rectChordMm(section.width, section.height, theta, p);
}

/**
 * #1085 — THE SECTION THE FACES LEAVE. A relief cut after the faces is planned from the stock
 * those cuts make — the octagon after an A 45 corner ring on a square, not the square's corners.
 * Each `flat` and each cutting face of a `faces-all-round` is a plane at a fixed distance from
 * the axis; the section is the smallest radius under the stock's own sides and every such plane.
 *
 * The depths read the ORIGINAL section, exactly as {@link planFaceCuts} reads them: every op cuts
 * the stock as it was mounted, in one program. Returns the section unchanged when no op cuts.
 */
export function processedSectionOf(section: RotarySection, faces: readonly EngraveFaceOp[]): RotarySection {
  if (section.kind !== 'rect') return section;
  const cutFaces: RotaryCutFace[] = [];
  for (const op of faces) {
    if (op.kind === 'flat') {
      const a = (op.a * Math.PI) / 180;
      const distance = sectionRadiusAt(section, a) - (op.depth ?? 0);
      if ((op.depth ?? 0) > 0 && distance > 0) cutFaces.push({ a, distance });
    } else if (op.kind === 'faces-all-round') {
      const count = op.count ?? 0;
      const acrossFlats = op.acrossFlats ?? 0;
      if (!(count >= 3) || !(acrossFlats > 0)) continue;
      for (let k = 0; k < count; k++) {
        const a = ((op.a + (k * 360) / count) * Math.PI) / 180;
        if (sectionRadiusAt(section, a) - acrossFlats / 2 > 1e-9) cutFaces.push({ a, distance: acrossFlats / 2 });
      }
    }
  }
  return cutFaces.length === 0 ? section : { ...section, cutFaces };
}

/** Three decimal places — enough for a stated size, and no float dust on a face operation. */
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * The operation a new face cut starts as, per `rotary-flow.md` §5's options matrix: a Flat at 0°
 * and 1 mm deep; Faces all round as a hex whose across-flats is the largest inside the stock
 * (`⌀·cos(180°/6)` — 17.321 mm on ⌀20) at 0°; a Cross-hole at 0° on the job's own cutter, so the
 * hole it cuts is the one the machine can make.
 */
export function defaultFaceOperation(
  kind: EngraveFaceOpKind,
  radiusMm: Mm,
  cutterDiameterMm: Mm,
): Omit<EngraveFaceOp, 'id'> {
  return kind === 'flat'
    ? { kind, a: 0, depth: 1 }
    : kind === 'faces-all-round'
      ? { kind, a: 0, count: 6, acrossFlats: round3(2 * radiusMm * Math.cos(Math.PI / 6)) }
      : { kind, a: 0, diameter: round3(cutterDiameterMm > 0 ? cutterDiameterMm : 3.175) };
}

/** What the stock's free span leaves a face between the cutter's edges, mm (negative = none). */
export function faceSpanMm(map: RotaryMap, cutterRadiusMm: Mm): { from: Mm; to: Mm } {
  const free = rotaryFreeSpan(map);
  return { from: free.from + cutterRadiusMm, to: free.to - cutterRadiusMm };
}

/** A capsule contour, counter-clockwise, exactly as the sweep's own footprint builder makes it. */
function capsule(out: OraclePoint[][], x0: number, y0: number, x1: number, y1: number, r: number, n: number): void {
  const disc = (cx: number, cy: number): OraclePoint[] => {
    const p: OraclePoint[] = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return p;
  };
  out.push(disc(x1, y1));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return;
  out.push(disc(x0, y0));
  const nx = (-dy / len) * r;
  const ny = (dx / len) * r;
  out.push([
    [x0 - nx, y0 - ny],
    [x1 - nx, y1 - ny],
    [x1 + nx, y1 + ny],
    [x0 + nx, y0 + ny],
  ]);
}

/** The region one face's passes leave at its plane: one capsule per pass, in the face frame. */
function facePrediction(face: IndexedFace, cutterRadiusMm: Mm, stepOverMm: Mm): OraclePredicted {
  const n = segmentsForRadius(cutterRadiusMm);
  const polygons: OraclePoint[][] = [];
  for (const y of facePassYs(face.width ?? 0, cutterRadiusMm, stepOverMm)) {
    capsule(polygons, face.fromX, y, face.toX, y, cutterRadiusMm, n);
  }
  // #1059 — the depth is below the SECTION's surface at this index; the oracle judges the level
  // at that surface, not at the stock's top (see `indexedFaceOracle`).
  return { a: face.a, depth: face.depth, polygons, ...(face.surfaceRadius !== undefined ? { surfaceRadius: face.surfaceRadius } : {}) };
}

/** One cross-hole's prediction: the hole the cutter plunges, at the face it is drilled from. */
function holePrediction(hole: IndexedHole, cutterRadiusMm: Mm): OraclePredicted {
  const n = segmentsForRadius(cutterRadiusMm);
  const disc: OraclePoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    disc.push([hole.x + cutterRadiusMm * Math.cos(t), cutterRadiusMm * Math.sin(t)]);
  }
  return { a: hole.a, depth: hole.depth, polygons: [disc], ...(hole.surfaceRadius !== undefined ? { surfaceRadius: hole.surfaceRadius } : {}) };
}

/**
 * #833 — ONE FACE as the CAM sees it: the index, the plane's depth, its span and chord, and the
 * cuts on it. `faces[i]` and `frames[i]` are the same face; a ring expands to one of each per face.
 */
export interface FaceFrame {
  a: number;
  /** The face plane's depth below the rod's surface, mm. */
  depth: Mm;
  /** The face's X span in the rotary frame, mm (one cutter radius clear of each band). */
  from: Mm;
  to: Mm;
  /** The face's width across Y, mm — its chord at `depth`. */
  chord: Mm;
  /**
   * #1059 — the stock's own surface at this index, mm, when it is not the envelope (a block):
   * the face's plane is `surfaceRadius − depth`, and a cut lifted onto the face starts there.
   */
  surfaceRadius?: Mm;
  /** The cuts on the face, in the face's own frame (see `EngraveFaceItem`). */
  items: readonly EngraveFaceItem[];
}

export interface FaceCutPlan {
  /** The indexed CAM's face list, in cut order. */
  faces: IndexedFace[];
  /** The same faces as frames — `faces[i]` is `frames[i]`. */
  frames: FaceFrame[];
  /** Its holes, after the faces, in cut order. */
  holes: IndexedHole[];
  /** What each cut should leave, for the per-face oracle. */
  predicted: OraclePredicted[];
}

export type FacePlanResult = { ok: true; plan: FaceCutPlan; findings: JobFinding[] } | { ok: false; findings: JobFinding[] };

const num = (v: number): string => String(Number(v.toFixed(2)));

/**
 * #833 — the cut a new face operation starts as, at the face's centre: an engraving 0.5 mm into
 * the face with the words the operator typed, a 1 mm pocket about a third of the face long, or a
 * 2 mm hole at the cutter's own diameter. The caller states the text (an engraving with no words
 * is not a cut); `faceLengthMm` and `chordMm` size the defaults to the face they land on.
 */
export function defaultFaceItem(
  kind: EngraveFaceItem['kind'],
  faceLengthMm: Mm,
  chordMm: Mm,
  cutterDiameterMm: Mm,
  text?: string,
): Omit<EngraveFaceItem, 'id'> {
  const x = round3(faceLengthMm / 2);
  if (kind === 'text') {
    return {
      kind,
      x,
      y: 0,
      depth: 0.5,
      text: text ?? '',
      size: Math.max(1.5, Math.min(3, round3(chordMm / 2.5))),
    };
  }
  if (kind === 'pocket') {
    // A pocket narrower than the cutter has nothing to cut (#201's own finding): the default is
    // at least twice the cutter wide and tall, held inside the face — and a face too small for
    // that is NAMED by the finding rather than silently made uncuttable.
    const d = cutterDiameterMm > 0 ? cutterDiameterMm : 3.175;
    const width = Math.max(2 * d, Math.min(6, round3(faceLengthMm / 3)));
    const height = Math.max(2 * d, Math.min(3, round3(chordMm / 2)));
    return {
      kind,
      x,
      y: 0,
      depth: 1,
      width: round3(Math.min(width, Math.max(1, faceLengthMm - 2))),
      height: round3(Math.min(height, Math.max(1, chordMm - 2))),
    };
  }
  // A hole is a PLUNGE (like a cross-hole): it comes out at the cutter's own diameter, so the
  // default states that diameter — the seed is a hole the machine can make.
  return { kind, x, y: 0, depth: 2, diameter: round3(cutterDiameterMm > 0 ? cutterDiameterMm : 3.175) };
}

/** One cut on a face in the panel's words, with its numbers and units (#833). */
export function faceItemWords(item: EngraveFaceItem): string {
  if (item.kind === 'text') return `Engrave “${item.text ?? ''}” · ${num(item.depth)} mm deep`;
  if (item.kind === 'pocket') return `Pocket ${num(item.width ?? 0)} × ${num(item.height ?? 0)} mm · ${num(item.depth)} mm deep`;
  return `Hole ⌀${num(item.diameter ?? 0)} mm · ${num(item.depth)} mm deep`;
}

/** An operator's word for one face cut: "engraving", "pocket", "hole". */
function faceItemWord(item: EngraveFaceItem): string {
  return item.kind === 'text' ? 'engraving' : item.kind === 'pocket' ? 'pocket' : 'hole';
}

/** The operation in the panel's words, with its numbers and units: `Flat 1 mm deep at A 0°`. */
export function faceOperationWords(op: EngraveFaceOp): string {
  if (op.kind === 'flat') return `Flat ${num(op.depth ?? 0)} mm deep at A ${num(op.a)}°`;
  if (op.kind === 'faces-all-round') return `${op.count ?? 0} flats ${num(op.acrossFlats ?? 0)} mm across at A ${num(op.a)}°`;
  return `Cross-hole ⌀${num(op.diameter ?? 0)} mm at A ${num(op.a)}°`;
}

/**
 * Read the job's face operations into the indexed CAM's request. `map` must be the job's own
 * rotary map (`rotaryMapOf`), so the radius and the free span are the program's, not a second
 * reading's; `params` are the feeds row's numbers (the step-over is the passes' pitch).
 */
export function planFaceCuts(
  job: EngraveJob,
  map: RotaryMap,
  tool: Tool,
  params: CutParams,
): FacePlanResult {
  const findings: JobFinding[] = [];
  const ops: readonly EngraveFaceOp[] = job.faces ?? [];
  const radius = map.radius;
  const cutter = cuttingRadiusForSweep(tool);
  if (!cutter.ok) {
    findings.push({
      severity: 'error',
      code: 'face-needs-flat-tool',
      message: `A face is a flat pocket, so it needs a flat end mill; "${tool.name}" has no flat width to cut it with. Choose a flat end mill for this job.`,
    });
    return { ok: false, findings };
  }
  const cutterRadius = cutter.radius;
  const span = faceSpanMm(map, cutterRadius);
  const spanMm = span.to - span.from;
  const faces: IndexedFace[] = [];
  const frames: FaceFrame[] = [];
  const holes: IndexedHole[] = [];
  const predicted: OraclePredicted[] = [];

  const addFace = (a: number, depth: Mm, items: readonly EngraveFaceItem[]): void => {
    // #1059 — the surface THIS index cuts from and the section's own chord there. A round rod
    // reads the envelope and `faceChordMm`, exactly as before; a block reads its section.
    const surface = sectionRadiusAt(map.section, (a * Math.PI) / 180);
    const width = sectionFaceChordMm(map.section, a, depth);
    const face: IndexedFace = {
      a,
      fromX: span.from,
      toX: span.to,
      depth,
      ...(width > 0 ? { width } : {}),
      ...(map.section.kind === 'rect' ? { surfaceRadius: surface } : {}),
    };
    faces.push(face);
    // #833 — A HOLE is a PLUNGE at the face's index, like a cross-hole but stopping at its depth
    // below the plane: the program's hole list carries it, and the cutter decides its size.
    const surfaceItems = items.filter((it) => it.kind !== 'hole');
    frames.push({
      a,
      depth,
      from: span.from,
      to: span.to,
      chord: width,
      ...(map.section.kind === 'rect' ? { surfaceRadius: surface } : {}),
      items: surfaceItems,
    });
    predicted.push(facePrediction(face, cutterRadius, params.stepOver));
    for (const item of items) {
      if (item.kind === 'hole') {
        const hole: IndexedHole = { a, x: span.from + item.x, depth: depth + item.depth };
        holes.push(hole);
        predicted.push(holePrediction(hole, cutterRadius));
        const asked = item.diameter ?? 0;
        if (asked > 0 && Math.abs(asked - 2 * cutterRadius) > 1e-6) {
          findings.push({
            severity: 'warning',
            code: 'face-hole-cutter',
            labelId: item.id,
            message: `The hole on the face at A ${num(a)}° asks for ⌀${num(asked)} mm and the job's cutter is ⌀${num(2 * cutterRadius)} mm, so the hole comes out at ⌀${num(2 * cutterRadius)} mm. Use a ⌀${num(asked)} mm cutter for the hole you asked for.`,
          });
        }
      }
    }
    // A CUT ON THE FACE HAS TO FIT IT: its centre within the face's span and chord, its
    // own extent inside them, and its floor above the axis (the face's depth plus the cut's).
    for (const item of items) {
      const halfW = (item.kind === 'pocket' ? (item.width ?? 0) / 2 : item.kind === 'hole' ? (item.diameter ?? 0) / 2 : (item.size ?? 0) / 2);
      const halfH = (item.kind === 'pocket' ? (item.height ?? 0) / 2 : item.kind === 'hole' ? (item.diameter ?? 0) / 2 : (item.size ?? 0) / 2);
      const along = item.x;
      const across = Math.abs(item.y);
      if (!(item.depth > 0) || depth + item.depth >= surface) {
        findings.push({
          severity: 'error',
          code: 'face-item-too-deep',
          labelId: item.id,
          message: `The ${faceItemWord(item)} on the face at A ${num(a)}° is ${num(item.depth)} mm below the face, and the face is ${num(depth)} mm deep: together they reach the ${num(surface)} mm radius the stock has there. Make the cut shallower.`,
        });
        continue;
      }
      if (along - halfW < 0 || along + halfW > span.to - span.from || across + halfH > width / 2 + 1e-6 || across - halfH < -width / 2 - 1e-6) {
        findings.push({
          severity: 'error',
          code: 'face-item-off-face',
          labelId: item.id,
          message: `The ${faceItemWord(item)} on the face at A ${num(a)}° does not fit the face: the face is ${num(span.to - span.from)} mm along and ${num(width)} mm across, and the cut reaches past one of its edges. Move it onto the face, or make it smaller.`,
        });
      }
    }
  };

  for (const op of ops) {
    if (op.kind === 'flat') {
      const depth = op.depth ?? 0;
      // #1059 — the depth is read against the surface at THIS index: on a block at A 0 that is
      // the section's half-height, so a depth the envelope would allow can still reach the axis.
      const surface = sectionRadiusAt(map.section, (op.a * Math.PI) / 180);
      if (!(depth > 0) || depth >= surface) {
        findings.push({
          severity: 'error',
          code: 'face-too-deep',
          labelId: op.id,
          message: `The flat at A ${num(op.a)}° is ${num(depth)} mm deep on a ${num(surface)} mm radius; a face keeps its floor above the axis, so its depth is under ${num(surface)} mm.`,
        });
        continue;
      }
      if (!(spanMm > 0)) {
        findings.push({
          severity: 'error',
          code: 'face-no-room',
          labelId: op.id,
          message: `A ${num(2 * cutterRadius)} mm cutter leaves no room for a face between the jaws' keep-out and the ${map.tailstock ? "tailstock's band" : 'free end'}: the free span is ${num(rotaryFreeSpan(map).to - rotaryFreeSpan(map).from)} mm. Take the tailstock out, or use a longer stick-out.`,
        });
        continue;
      }
      addFace(op.a, depth, op.items ?? []);
    } else if (op.kind === 'faces-all-round') {
      const count = op.count ?? 0;
      const acrossFlats = op.acrossFlats ?? 0;
      if (!(count >= 3) || !(acrossFlats > 0) || !(acrossFlats / 2 < radius)) {
        findings.push({
          severity: 'error',
          code: 'face-too-deep',
          labelId: op.id,
          message: `${num(acrossFlats)} mm across flats is not inside ${sectionWords(map.section)}: ${count} evenly spaced faces need an across-flats above 0 and under ⌀${num(2 * radius)} mm.`,
        });
        continue;
      }
      if (!(spanMm > 0)) {
        findings.push({
          severity: 'error',
          code: 'face-no-room',
          labelId: op.id,
          message: `A ${num(2 * cutterRadius)} mm cutter leaves no room for a face between the jaws' keep-out and the ${map.tailstock ? "tailstock's band" : 'free end'}: the free span is ${num(rotaryFreeSpan(map).to - rotaryFreeSpan(map).from)} mm. Take the tailstock out, or use a longer stick-out.`,
        });
        continue;
      }
      // #1059 — THE DEPTH IS PER FACE. Each face cuts from the surface at ITS OWN index down to
      // the one across-flats plane: on a round rod every index is the same radius, so this is the
      // single `R − acrossFlats/2` it always was; on a block the four flats are already at that
      // plane (depth 0 — the square → octagon corner removal) and only the corners remove stock.
      const items = op.items ?? [];
      let cuts = 0;
      let widest = 0;
      for (let k = 0; k < count; k++) {
        const a = op.a + (k * 360) / count;
        const surface = sectionRadiusAt(map.section, (a * Math.PI) / 180);
        widest = Math.max(widest, surface);
        const depth = surface - acrossFlats / 2;
        if (depth > 1e-9) {
          addFace(a, depth, items);
          cuts++;
        } else if (items.length > 0) {
          // A cut cannot live on a face that is not cut: name the face and the way out.
          findings.push({
            severity: 'error',
            code: 'face-item-no-face',
            labelId: op.id,
            message: `The ${faceItemWord(items[0]!)} on the face at A ${num(a)}° cannot be cut: that face is already at the ${num(acrossFlats)} mm across-flats, so there is no face to cut it into. Set a smaller across-flats, or move the cut to a face this ring removes.`,
          });
        }
      }
      if (cuts === 0) {
        findings.push({
          severity: 'error',
          code: 'face-too-deep',
          labelId: op.id,
          message: `${num(acrossFlats)} mm across flats is already the stock's own surface at every one of ${count} faces: there is no stock to remove. Set an across-flats smaller than ${num(2 * widest)} mm.`,
        });
      }
    } else {
      const diameter = op.diameter ?? 0;
      const cutterDiameter = cuttingDiameter(tool) ?? 2 * cutterRadius;
      if (!(diameter > 0)) {
        findings.push({
          severity: 'error',
          code: 'face-too-deep',
          labelId: op.id,
          message: `The cross-hole at A ${num(op.a)}° needs a diameter above 0 mm.`,
        });
        continue;
      }
      if (Math.abs(diameter - cutterDiameter) > 1e-6) {
        findings.push({
          severity: 'warning',
          code: 'cross-hole-cutter',
          labelId: op.id,
          message: `The cross-hole asks for ⌀${num(diameter)} mm and "${tool.name}" is ⌀${num(cutterDiameter)} mm, so the hole comes out at ⌀${num(cutterDiameter)} mm. Use a ⌀${num(diameter)} mm cutter for the hole you asked for.`,
        });
      }
      const free = rotaryFreeSpan(map);
      const x = op.atX ?? free.centre;
      // #1059 — a through cross-hole is 2 × the surface at ITS index deep: from the section's
      // edge at A to the far edge at −A. On a block at A 0 that is 44.5 on the 44.5 bar, not the
      // envelope's 62.93 (which plunged 9.2 mm of air past the block's underside).
      const surface = sectionRadiusAt(map.section, (op.a * Math.PI) / 180);
      const hole: IndexedHole = {
        a: op.a,
        x,
        depth: 2 * surface + Math.max(0, job.breakthrough),
        ...(map.section.kind === 'rect' ? { surfaceRadius: surface } : {}),
      };
      holes.push(hole);
      predicted.push(holePrediction(hole, cutterRadius));
    }
  }

  if (findings.some((f) => f.severity === 'error')) return { ok: false, findings };
  return { ok: true, plan: { faces, frames, holes, predicted }, findings };
}

/**
 * Which refusal a job with face operations earns BEFORE any geometry: a face is cut on round
 * stock held in the chuck. Null when the job is one this module's CAM can cut. A job that ALSO
 * carries map items is not refused — it cuts two programs in cut order (#836).
 */
export function faceJobRefusal(job: EngraveJob): JobFinding | null {
  const ops = job.faces ?? [];
  if (ops.length === 0) return null;
  // #1059 — the gate is "the chuck holds this stock", read by the same classifier the map uses:
  // a ROD or a BLOCK (#777) in the chuck, and never a disc. A block's faces are indexed cuts on
  // its section exactly as a rod's are on its cylinder.
  if (rotaryMapOf(job, liveShopDefaults()) === null) {
    return {
      severity: 'error',
      code: 'face-needs-chuck',
      message:
        'Faces are cut on stock held in the rotary chuck, and this job is not held in the chuck. Change the holding in the Holding step, or remove the face operations.',
    };
  }
  return null;
}

/** The neck for parting as the face check reads it: its X span and how deep its floor is, mm. */
export interface FaceNeckSpan {
  fromMm: Mm;
  toMm: Mm;
  /** The neck's floor below the rod's surface, mm (`R − diameter / 2`). */
  depthMm: Mm;
  diameterMm: Mm;
}

/**
 * #849 — A FACE CUT THAT REACHES INTO THE NECK FOR PARTING, or null.
 *
 * A mixed job with a neck cuts the map items, then the faces, then the neck — so a face never
 * cuts a part already hanging on its neck. What is left to refuse is a face cut that eats into
 * the neck's own section: inside the neck's X span AND deeper than its floor, it leaves less
 * than the neck's stated diameter holding the part through the faces and the saw. A cut that
 * stays above the floor there is removed again by the neck itself, so it is not refused.
 *
 * `cutterRadiusMm` is the face program's cutter: a face's X span is one radius in from the free
 * span's ends, and a hole is as wide as the cutter that plunges it. An engraving's length along
 * the axis is not known before it is laid out, so it is judged over its whole face.
 */
export function faceCutIntoNeck(
  job: EngraveJob,
  map: RotaryMap,
  neck: FaceNeckSpan,
  cutterRadiusMm: Mm,
): JobFinding | null {
  const eps = 1e-6;
  const over = (from: number, to: number): boolean => from < neck.toMm - eps && to > neck.fromMm + eps;
  // #1059 — COMPARE FLOORS, NOT DEPTHS BELOW A SURFACE. A face's floor is the surface at its own
  // index less its depth; the neck's floor is `diameter / 2` above the axis whichever way it was
  // turned. On a round rod every surface is the envelope, so this is exactly `depth > depthMm`.
  const neckFloor = neck.diameterMm / 2;
  const surfaceAt = (a: number): Mm => sectionRadiusAt(map.section, (a * Math.PI) / 180);
  const eatsNeck = (floor: Mm): boolean => floor < neckFloor - eps;
  const span = faceSpanMm(map, cutterRadiusMm);
  const free = rotaryFreeSpan(map);
  const sentence = (what: string, at: number, depth: number, from: number, to: number, tip?: string): JobFinding => ({
    severity: 'error',
    code: 'face-cuts-neck',
    message:
      `${what} cuts into the neck for parting: it reaches ${num(depth)} mm below the surface between X ${num(Math.max(from, neck.fromMm))} and ` +
      `X ${num(Math.min(to, neck.toMm))} mm, and the neck keeps ⌀${num(neck.diameterMm)} mm there (${
        map.section.kind === 'round' ? `${num(neck.depthMm)} mm below the surface` : `its floor ${num(neckFloor)} mm from the axis`
      }), ` +
      `so less than the neck would hold the part. ${tip ?? `Keep the cut shallower than ${num(surfaceAt(at) - neckFloor)} mm`} or clear of X ${num(neck.fromMm)}–${num(neck.toMm)} mm, or move the neck.`,
  });
  for (const op of job.faces ?? []) {
    if (op.kind === 'cross-hole') {
      const x = op.atX ?? free.centre;
      const half = Math.max((op.diameter ?? 0) / 2, cutterRadiusMm);
      // A cross-hole goes through the axis: inside the span it always cuts the neck's section.
      if (over(x - half, x + half)) {
        return { ...sentence(`The cross-hole at A ${num(op.a)}°`, op.a, 2 * surfaceAt(op.a), x - half, x + half), labelId: op.id };
      }
      continue;
    }
    const name = op.kind === 'flat' ? `The flat at A ${num(op.a)}°` : `The ${op.count ?? 0} flats ${num(op.acrossFlats ?? 0)} mm across`;
    // A flat's floor is the surface at its index less its depth. A ring's faces ALL cut to the
    // across-flats plane, so its floor is `acrossFlats / 2` at every index it removes; the deep
    // reading is the largest surface it cuts from, which is the face the sentence names.
    let floor: Mm;
    let at = op.a;
    if (op.kind === 'flat') {
      floor = surfaceAt(op.a) - (op.depth ?? 0);
    } else {
      floor = (op.acrossFlats ?? 0) / 2;
      const count = op.count ?? 0;
      if (count >= 3) {
        for (let k = 0; k < count; k++) {
          const a = op.a + (k * 360) / count;
          if (surfaceAt(a) > surfaceAt(at)) at = a;
        }
      }
    }
    // On a block the knob is the across-flats, not a depth: the ring cuts every face to that plane.
    const tip =
      op.kind === 'faces-all-round' && map.section.kind === 'rect' ? `Keep the across-flats above ${num(2 * neckFloor)} mm` : undefined;
    const faceFrom = span.from - cutterRadiusMm;
    const faceTo = span.to + cutterRadiusMm;
    if (eatsNeck(floor) && over(faceFrom, faceTo)) return { ...sentence(name, at, surfaceAt(at) - floor, faceFrom, faceTo, tip), labelId: op.id };
    for (const item of op.items ?? []) {
      const itemFloor = floor - item.depth;
      if (!eatsNeck(itemFloor)) continue;
      const half =
        item.kind === 'pocket' ? (item.width ?? 0) / 2 : item.kind === 'hole' ? Math.max((item.diameter ?? 0) / 2, cutterRadiusMm) : Number.POSITIVE_INFINITY;
      const from = Number.isFinite(half) ? span.from + item.x - half : faceFrom;
      const to = Number.isFinite(half) ? span.from + item.x + half : faceTo;
      if (over(from, to)) return { ...sentence(`The ${faceItemWord(item)} on ${name.charAt(0).toLowerCase()}${name.slice(1)}`, at, surfaceAt(at) - itemFloor, from, to, tip), labelId: item.id };
    }
  }
  return null;
}
