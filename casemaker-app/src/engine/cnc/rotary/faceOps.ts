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
import type { EngraveFaceOp, EngraveFaceOpKind, EngraveJob } from '@/types/engraveJob';
import type { IndexedFace, IndexedHole } from '@/engine/cnc/cam/indexed';
import { facePassYs } from '@/engine/cnc/cam/indexed';
import type { CutParams } from '@/engine/cnc/feeds';
import type { OraclePredicted, OraclePoint } from '@/engine/cnc/engrave/oracle';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { cuttingDiameter, cuttingRadiusForSweep, type Tool } from '@/engine/cnc/tool';
import { rotaryFreeSpan, type RotaryMap } from './wrap';

/** The width of a face at a depth below the surface, mm: the chord of the turned circle. */
export function faceChordMm(radiusMm: Mm, depthMm: Mm): Mm {
  const r = Math.max(0, radiusMm);
  const inner = r - Math.max(0, depthMm);
  if (!(r > 0) || inner < 0) return 0;
  return 2 * Math.sqrt(Math.max(0, r * r - inner * inner));
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
  return { a: face.a, depth: face.depth, polygons };
}

/** One cross-hole's prediction: the hole the cutter plunges, at the face it is drilled from. */
function holePrediction(hole: IndexedHole, cutterRadiusMm: Mm): OraclePredicted {
  const n = segmentsForRadius(cutterRadiusMm);
  const disc: OraclePoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    disc.push([hole.x + cutterRadiusMm * Math.cos(t), cutterRadiusMm * Math.sin(t)]);
  }
  return { a: hole.a, depth: hole.depth, polygons: [disc] };
}

export interface FaceCutPlan {
  /** The indexed CAM's face list, in cut order. */
  faces: IndexedFace[];
  /** Its holes, after the faces, in cut order. */
  holes: IndexedHole[];
  /** What each cut should leave, for the per-face oracle. */
  predicted: OraclePredicted[];
}

export type FacePlanResult = { ok: true; plan: FaceCutPlan; findings: JobFinding[] } | { ok: false; findings: JobFinding[] };

const num = (v: number): string => String(Number(v.toFixed(2)));

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
  const holes: IndexedHole[] = [];
  const predicted: OraclePredicted[] = [];

  const addFace = (a: number, depth: Mm): void => {
    const width = faceChordMm(radius, depth);
    const face: IndexedFace = { a, fromX: span.from, toX: span.to, depth, ...(width > 0 ? { width } : {}) };
    faces.push(face);
    predicted.push(facePrediction(face, cutterRadius, params.stepOver));
  };

  for (const op of ops) {
    if (op.kind === 'flat') {
      const depth = op.depth ?? 0;
      if (!(depth > 0) || depth >= radius) {
        findings.push({
          severity: 'error',
          code: 'face-too-deep',
          labelId: op.id,
          message: `The flat at A ${num(op.a)}° is ${num(depth)} mm deep on a ${num(radius)} mm radius; a face keeps its floor above the axis, so its depth is under ${num(radius)} mm.`,
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
      addFace(op.a, depth);
    } else if (op.kind === 'faces-all-round') {
      const count = op.count ?? 0;
      const acrossFlats = op.acrossFlats ?? 0;
      const depth = radius - acrossFlats / 2;
      if (!(count >= 3) || !(acrossFlats > 0) || !(depth > 0)) {
        findings.push({
          severity: 'error',
          code: 'face-too-deep',
          labelId: op.id,
          message: `${num(acrossFlats)} mm across flats is not inside a ${num(2 * radius)} mm rod: ${count} evenly spaced faces need an across-flats above 0 and under ⌀${num(2 * radius)} mm.`,
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
      for (let k = 0; k < count; k++) addFace(op.a + (k * 360) / count, depth);
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
      const hole: IndexedHole = { a: op.a, x, depth: 2 * radius + Math.max(0, job.breakthrough) };
      holes.push(hole);
      predicted.push(holePrediction(hole, cutterRadius));
    }
  }

  if (findings.some((f) => f.severity === 'error')) return { ok: false, findings };
  return { ok: true, plan: { faces, holes, predicted }, findings };
}

/**
 * Which refusal a job with face operations earns BEFORE any geometry: a face is cut on round
 * stock in the chuck, and a program cannot be half map and half face. Null when the job is one
 * this module's CAM can cut.
 */
export function faceJobRefusal(job: EngraveJob): JobFinding | null {
  const ops = job.faces ?? [];
  if (ops.length === 0) return null;
  if (job.workholding.kind !== 'rotary-chuck' || job.stock.shape !== 'cylinder') {
    return {
      severity: 'error',
      code: 'face-needs-chuck',
      message:
        'Faces are cut on round stock held in the rotary chuck, and this job is held in the vise. Change the holding in the Holding step, or remove the face operations.',
    };
  }
  const hasMapItems =
    job.labels.length > 0 ||
    job.shapes.length > 0 ||
    (job.cutouts?.length ?? 0) > 0 ||
    (job.chamfers?.length ?? 0) > 0 ||
    (job.combined?.length ?? 0) > 0 ||
    (job.traces?.length ?? 0) > 0 ||
    (job.vectors?.length ?? 0) > 0 ||
    (job.keepOuts?.length ?? 0) > 0;
  if (hasMapItems) {
    return {
      severity: 'error',
      code: 'face-items-mixed',
      message:
        'This job has items on the map AND cuts on the stock’s faces, and one program cannot be both: cut the faces in their own job, or remove the map items. A wrapped program and an indexed one are two programs.',
    };
  }
  return null;
}
