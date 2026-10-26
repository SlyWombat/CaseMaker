/**
 * #673 — THE V-CARVE INLAY PAIR: the FEMALE pocket and the MALE plug, and the numbers that make
 * them close.
 *
 * THE MODEL: a job is ONE blank. `job.stock` is singular, and the simulation, the frozen package,
 * the Cut step and the machine all assume one blank on the bed per run — so an inlay is TWO JOBS,
 * one per blank. The female's job is an ordinary job whose region carries an {@link InlayMark};
 * `inlayMaleJob` derives the male's document from it (its own id and name, its own copy of the
 * blank, the design MIRRORED in Y for the glue-up flip, and one cutaway cutting the complement
 * around the plug). The male is saved as its own job file and cut as its own run; the run sheets
 * say which blank each is. Nothing at run time links the two documents: the male stores the
 * numbers it was built for, and its sheet says to build it again if the female changed.
 *
 * THE NUMBERS, one set, one place (this file):
 *  - the pocket depth F is the region's own `depth` (the existing field);
 *  - the glue gap g is the marker's `glueGapMm`, default {@link DEFAULT_INLAY_GLUE_GAP_MM};
 *  - the cone (half-angle θ, the tangent `tanHalf`) is the job's V-bit.
 * Everything else is DERIVED here and nowhere else: the plug depth `P = F − g`, the plug's top
 * inset `g·tanθ`, its end inset `F·tanθ`, the wall clearance `g·cosθ`, and the floor gap `g`.
 *
 * THE GEOMETRY (z = 0 at the female's top face, positive up; the cavity below):
 *  - the FEMALE cavity's cross-section at depth d is `erode(design, d·tanθ)` — what a V at θ cuts;
 *  - the plug's cross-section at depth d is `erode(design, (g+d)·tanθ)`: at the glue plane (d = 0,
 *    the plug's BASE) that is the design's ring `g·tanθ` wide, and at its END (d = P = F − g) it is
 *    `erode(design, F·tanθ)` — exactly the female floor's extent, so it stops `g` above the floor;
 *  - so at every depth the plug sits INSIDE the cavity with the walls parallel. The clearance
 *    measured square to the flank is `g·sinθ`: the flank plane turns by θ from vertical, so a
 *    vertical shift of g moves it `g·tanθ` horizontally and `g·tanθ·cosθ = g·sinθ` square to it.
 *
 * ON THE MALE, the island the cut leaves standing GROWS with depth: the cut region at depth m is
 * `R ⊖ m·tanθ`, so its hole — the island — is `islandTop ⊕ m·tanθ`. The island at the male's TOP
 * face is therefore the plug's TIP (`erode(design, F·tanθ)` — the female floor's extent), and the
 * island at the male's FLOOR (m = P) is its BASE (`erode(design, g·tanθ)`). The male's top face is
 * the face that goes to the bottom of the female pocket: male depth m maps to female depth
 * `d = P − m`.
 *
 * The male's design is MIRRORED in Y about the blank's centre line: the male is machined on the
 * face that is glued down, so the part it makes is the mirror image of the design as the female
 * shows it, and the glue-up flip turns it back.
 */

import { newId } from '@/utils/id';
import type {
  EngraveCombinedShape,
  EngraveJob,
  EngraveShape,
  InlayMark,
} from '@/types/engraveJob';
import type { VCone } from '../vProfile';

/** The glue gap a new inlay half runs with when the operator states none, mm — labelled, not measured. */
export const DEFAULT_INLAY_GLUE_GAP_MM = 0.2;

/**
 * #673 — every number an inlay pair runs with, derived once from the pocket depth, the glue gap
 * and the cone. The row, the findings, the male's builder and both run sheets read THIS.
 */
export interface InlayNumbers {
  /** The female's flat depth, mm — the region's own `depth`. */
  pocketDepthMm: number;
  /** The vertical clearance between the plug's end and the female's floor, mm. */
  glueGapMm: number;
  /** The male's carve depth, hence how far the plug stands proud of its face, mm: `F − g`. */
  plugDepthMm: number;
  /**
   * How far the plug's BASE sits inside the design at the glue plane, mm: `g·tanθ` — the visible
   * ring after planing. A derived FACT, not a build offset.
   */
  topInsetMm: number;
  /**
   * The plug's TIP's own inset, mm: `F·tanθ` — exactly the female floor's extent, and the erosion
   * the MALE's island takes at its top face (the island grows with depth, so the top face is the
   * tip).
   */
  endInsetMm: number;
  /**
   * The wall clearance between the plug and the cavity, square to the flank, mm: `g·sinθ`. The
   * flank turns θ from vertical, so a vertical shift of g moves it `g·tanθ` horizontally and
   * `g·tanθ·cosθ = g·sinθ` square to it.
   */
  wallClearanceMm: number;
  /** The cone's half-angle tangent the numbers were derived with. */
  tanHalf: number;
}

export type InlayCheck = { ok: true; numbers: InlayNumbers } | { ok: false; reason: string };

/** `0.2` — a millimetre value as a sentence prints it. */
export function inlayMm(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/**
 * THE DERIVATION. The gap must be above zero (it IS the clearance) and below the pocket depth (a
 * plug that reaches the floor is a press fit with nowhere for the glue).
 */
export function inlayNumbers(cone: VCone, pocketDepthMm: number, glueGapMm: number): InlayCheck {
  if (!(pocketDepthMm > 0)) {
    return { ok: false, reason: 'the pocket depth must be above zero' };
  }
  if (!(glueGapMm > 0)) {
    return { ok: false, reason: `the glue gap must be above zero; it is ${inlayMm(glueGapMm)} mm` };
  }
  if (!(glueGapMm < pocketDepthMm)) {
    return {
      ok: false,
      reason:
        `the glue gap (${inlayMm(glueGapMm)} mm) must be below the pocket depth ` +
        `(${inlayMm(pocketDepthMm)} mm) — a plug that reaches the floor has no gap to glue into`,
    };
  }
  const tanHalf = cone.tanHalf;
  const sinHalf = tanHalf / Math.sqrt(1 + tanHalf * tanHalf);
  return {
    ok: true,
    numbers: {
      pocketDepthMm,
      glueGapMm,
      plugDepthMm: pocketDepthMm - glueGapMm,
      topInsetMm: glueGapMm * tanHalf,
      endInsetMm: pocketDepthMm * tanHalf,
      // Square to the flank: the vertical gap times sinθ (a vertical shift of g moves the flank
      // g·tanθ horizontally; its perpendicular component is g·tanθ·cosθ = g·sinθ).
      wallClearanceMm: glueGapMm * sinHalf,
      tanHalf,
    },
  };
}

/** The gap a marker runs with: its own, or the inlay default. */
export function inlayGlueGap(mark: InlayMark): number {
  return mark.glueGapMm ?? DEFAULT_INLAY_GLUE_GAP_MM;
}

/** The inlay-marked items of a job (shapes and combined items), with their markers. */
export function inlayMarked(
  job: EngraveJob,
): { item: EngraveShape | EngraveCombinedShape; mark: InlayMark }[] {
  const out: { item: EngraveShape | EngraveCombinedShape; mark: InlayMark }[] = [];
  for (const shape of job.shapes) {
    if (shape.inlay !== undefined) out.push({ item: shape, mark: shape.inlay });
  }
  for (const combined of job.combined ?? []) {
    if (combined.inlay !== undefined) out.push({ item: combined, mark: combined.inlay });
  }
  return out;
}

/**
 * Mirror a region item in Y about the blank's centre line — the glue-up flip about the X axis.
 *
 * The transform is exact: the position's Y becomes `width − y`, the rotation NEGATES (a mirror
 * conjugates a rotation: `diag(1,−1)·R(r)·diag(1,−1) = R(−r)`), and a polygon's local points
 * mirror in their own Y. Rect, circle and slot are symmetric in their own frame, so their
 * geometry needs nothing else.
 */
export function mirrorShapeInY<T extends EngraveShape | EngraveCombinedShape>(shape: T, stockWidth: number): T {
  const base = {
    ...shape,
    position: { x: shape.position.x, y: stockWidth - shape.position.y },
    rotation: -shape.rotation,
  };
  if (shape.kind === 'polygon') {
    return { ...base, points: shape.points.map(([x, y]) => [x, -y] as [number, number]) } as T;
  }
  return base as T;
}

/** The male job's name for a female's: the pair's one link, said in words. */
export function inlayMaleJobName(femaleName: string): string {
  return `${femaleName} — male`;
}

export type InlayMaleResult = { ok: true; job: EngraveJob } | { ok: false; reason: string };

/**
 * #673 — THE MALE BLANK'S DOCUMENT, derived from the female's.
 *
 * The male is an ordinary job: one blank (a copy of the female's, its measured bow dropped — it
 * is a different piece), the same cutter, and ONE cutaway per inlay region. The cutaway clears the
 * blank's inset minus the region's island, and the island is the design MIRRORED in Y. Its depth
 * is the derived `P = F − g`, and its marker stores the numbers it was built for, including the
 * island's erosion (`g·tanθ`), which `itemProfile` applies as a profile offset.
 *
 * Refused (with the reason) when the female has no inlay region or one of its numbers does not
 * derive; the findings say the same sentence in the panel.
 */
export function inlayMaleJob(job: EngraveJob, cone: VCone): InlayMaleResult {
  const shapeIds = new Set(job.shapes.map((shape) => shape.id));
  const females = inlayMarked(job).filter(
    (entry) => entry.mark.role === 'female' && shapeIds.has(entry.item.id),
  ) as { item: EngraveShape; mark: InlayMark }[];
  if (females.length === 0) {
    return { ok: false, reason: 'this job has no inlay region to make a male for' };
  }
  const margin = Math.max(job.edgeMargin, 0.5);
  const derived = females
    .map((entry) => ({ entry, check: inlayNumbers(cone, entry.item.depth, inlayGlueGap(entry.mark)) }))
    .filter((row): row is { entry: (typeof females)[number]; check: { ok: true; numbers: InlayNumbers } } => row.check.ok);
  if (derived.length === 0) {
    return { ok: false, reason: 'the inlay numbers do not derive — fix the glue gap or the pocket depth first' };
  }
  // The construction items never cut, but the schema wants a real depth on every shape; the plug
  // depth is the honest one (it is the depth the island is carved around).
  const blankId = 'inlay-blank';
  const shapes: EngraveShape[] = [
    {
      id: blankId,
      name: 'blank around the plugs',
      kind: 'rect',
      position: { x: job.stock.length / 2, y: job.stock.width / 2 },
      rotation: 0,
      depth: derived[0]!.check.numbers.plugDepthMm,
      cornerRadius: 0,
      width: Math.max(0.1, job.stock.length - 2 * margin),
      height: Math.max(0.1, job.stock.width - 2 * margin),
      enabled: true,
      construction: true,
    },
  ];
  const cuts: EngraveCombinedShape[] = [];
  derived.forEach(({ entry, check }, index) => {
    const n = check.numbers;
    const mirrored = mirrorShapeInY(entry.item, job.stock.width);
    const islandId = `inlay-plug-${index + 1}`;
    const island: EngraveShape = {
      ...mirrored,
      id: islandId,
      name: entry.item.name === undefined ? 'male plug' : `${entry.item.name} (plug)`,
      depth: n.plugDepthMm,
      construction: true,
      inlay: undefined,
    };
    shapes.push(island);
    cuts.push({
      kind: 'cutaway',
      id: `inlay-male-${index + 1}`,
      name: entry.item.name === undefined ? 'male plug' : `${entry.item.name} — male plug`,
      position: { x: 0, y: 0 },
      rotation: 0,
      depth: n.plugDepthMm,
      enabled: true,
      outer: blankId,
      islands: [islandId],
      inlay: {
        role: 'male',
        glueGapMm: n.glueGapMm,
        pocketDepthMm: n.pocketDepthMm,
        tanHalf: n.tanHalf,
        // The island's TOP face is the plug's TIP (the V's hole grows with depth), so the island
        // is eroded by the tip's inset — the female floor's extent — not by the base's ring.
        islandInsetMm: n.endInsetMm,
      },
    });
  });
  const { flatness: _measuredOnTheFemale, ...stock } = job.stock;
  return {
    ok: true,
    job: {
      schemaVersion: 3,
      id: newId('job'),
      name: inlayMaleJobName(job.name),
      machineId: job.machineId,
      stock,
      // The plug's island is a construction item; the cutaway is the one operation. No setups:
      // the implicit single setup cuts every enabled region with the job's cutter.
      labels: [],
      shapes,
      combined: cuts,
      toolKey: job.toolKey,
      ...(job.tool === undefined ? {} : { tool: job.tool }),
      workholding: job.workholding,
      minFloor: job.minFloor,
      edgeMargin: job.edgeMargin,
      sacrificial: job.sacrificial,
      breakthrough: job.breakthrough,
      jawClearance: job.jawClearance,
      ...(job.margins === undefined ? {} : { margins: job.margins }),
      ...(job.cutOverride === undefined ? {} : { cutOverride: job.cutOverride }),
      ...(job.metalLineOverride === undefined ? {} : { metalLineOverride: job.metalLineOverride }),
      ...(job.facing === undefined ? {} : { facing: job.facing }),
      customFonts: [],
    },
  };
}
