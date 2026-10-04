/**
 * Evaluate the tool-opened glyphs of a `PartPlan` and report what the cutter loses (#201).
 *
 * This is the worker half of the engravability check: `engravableProfile` is plain Profile
 * algebra, but AREA and POLYGONS only exist once the profile is evaluated to a Manifold
 * `CrossSection` (Clipper2). So this runs beside `executeProfile`, takes the toplevel the
 * same way the geometry worker does, and releases every handle it creates — a leak here is
 * paid on every keystroke once #205 calls it on a debounce.
 *
 * The output is deliberately the OPENED region, not the ideal glyph plus a warning: the
 * opened region is what #172 pockets, #205 previews and #206 checks the simulation against
 * (`/Fabrication.md` §7.5).
 */

import type { PartPlan } from '@/engine/cnc/engrave/partPlan';
import { engravableProfile } from '@/engine/cnc/engrave/engravable';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { itemLabel, jobTool } from '@/engine/cnc/engrave/jobSetup';
import { aabbOfProfile, pOffset, type Profile } from '@/engine/compiler/profile';
import type { EngraveItem, EngraveJob, EngraveShape } from '@/types/engraveJob';
import { executeProfile, type ManifoldToplevel } from '@/workers/geometry/evaluateOp';

/**
 * Ratio below which the opening has lost enough detail to warn. `0.9` is #171's starting
 * value; named here and cited rather than repeated as a bare literal (#201).
 */
export const LOST_DETAIL_RATIO = 0.9;

/**
 * Areas below this are floating-point dust, not a real overhang. The stock outline and the
 * opened glyph are both exact polygons, so a genuine breach is far larger (#201).
 */
export const OUTSIDE_AREA_TOLERANCE_MM2 = 0.01;

/**
 * One character's glyph profile, paired with the character it came from. `measureLabels`
 * cannot recover the character from a `Profile`, so the caller — who typeset the label —
 * supplies it here. (The issue wrote `perChar: (labelId) => Profile[]`; the `char` is
 * needed to fill `emptyChars`, and there is no other source for the text in this
 * signature. Flagged on #201.)
 */
export interface PerCharGlyph {
  char: string;
  profile: Profile;
}

export interface LabelEngravability {
  labelId: string;
  /** Area of the ideal glyph, mm². */
  glyphArea: number;
  /** Area of the tool-opened region, mm². */
  openedArea: number;
  /** `openedArea / glyphArea`; 1 when `glyphArea` is 0. */
  ratio: number;
  /** Characters (by index and character) whose opened region is empty. */
  emptyChars: { index: number; char: string }[];
  /** Area of the opened region lying outside the stock outline inset by `edgeMargin`, mm². */
  outsideArea: number;
  /** The opened region as plain polygons, work-frame XY — what #172 pockets and what the preview draws. */
  polygons: [number, number][][];
}

/**
 * Evaluate each of `plan.engraves` and its opening, and measure what is lost.
 *
 * `edgeMargin` insets the stock outline; anything cut beyond that inset is reported in
 * `outsideArea`. `perChar(labelId)` supplies one `{char, profile}` per character of the
 * label, built by the caller with `labelProfile` on a single-character label at the same
 * size — kerning does not matter for an emptiness test. Whitespace characters are skipped.
 *
 * Every `CrossSection` created here (glyph, opening, stock inset, per-character opening) is
 * deleted exactly once.
 */
export function measureLabels(
  tl: ManifoldToplevel,
  plan: PartPlan,
  toolRadius: number,
  edgeMargin: number,
  perChar: (labelId: string) => PerCharGlyph[],
): LabelEngravability[] {
  const CS = tl.CrossSection;
  // The safe region: the stock outline eroded by the edge margin. Erosion of a rectangle is
  // an inset rectangle; the round join only draws arcs on an OUTWARD offset, so a convex
  // outline insets without rounding its corners.
  const stockInset = executeProfile(tl, pOffset(plan.stock.outline, -edgeMargin));
  const out: LabelEngravability[] = [];
  try {
    for (const engrave of plan.engraves) {
      // A whitespace label is a `p-poly` with no contours, kept in the plan so it can be
      // reported (`labelProfile`). Manifold's `ofPolygons([])` throws, and every area is
      // zero anyway, so an empty profile short-circuits the whole evaluation.
      const isEmpty = aabbOfProfile(engrave.profile) === null;
      let glyphArea = 0;
      let openedArea = 0;
      let outsideArea = 0;
      let polygons: [number, number][][] = [];

      if (!isEmpty) {
        const glyphCS = executeProfile(tl, engrave.profile);
        glyphArea = glyphCS.area();
        glyphCS.delete();

        const openedCS = executeProfile(tl, engravableProfile(engrave.profile, toolRadius));
        openedArea = openedCS.area();
        // toPolygons() returns each contour as [x, y][]; that is the work-frame shape #172 wants.
        polygons = openedCS.toPolygons() as [number, number][][];

        const outsideCS = CS.difference([openedCS, stockInset]);
        outsideArea = outsideCS.area();
        outsideCS.delete();
        openedCS.delete();
      }

      const emptyChars: { index: number; char: string }[] = [];
      perChar(engrave.id).forEach((entry, index) => {
        if (entry.char.trim() === '') return;
        if (aabbOfProfile(entry.profile) === null) {
          emptyChars.push({ index, char: entry.char });
          return;
        }
        const charCS = executeProfile(tl, engravableProfile(entry.profile, toolRadius));
        const charArea = charCS.area();
        charCS.delete();
        if (charArea === 0) emptyChars.push({ index, char: entry.char });
      });

      out.push({
        labelId: engrave.id,
        glyphArea,
        openedArea,
        ratio: glyphArea === 0 ? 1 : openedArea / glyphArea,
        emptyChars,
        outsideArea,
        polygons,
      });
    }
  } finally {
    stockInset.delete();
  }
  return out;
}

/** Candidate cap heights `suggestCapHeight` tries, as `current × GROWTHⁿ` (#201 review). */
const SUGGEST_CAP_HEIGHT_GROWTH = 1.25;
/** How many growth steps the search tries before giving up (#201 review: n = 1…8). */
const SUGGEST_CAP_HEIGHT_STEPS = 8;

/**
 * The smallest cap height to suggest for a label that has lost detail (#201 review).
 *
 * The area ratio is NOT linear in size — `size × LOST_DETAIL_RATIO / ratio` has no physical
 * basis (it suggested 93 mm for a 4 mm label at 3.9 % survival) — so the suggestion is
 * MEASURED rather than scaled: `measureAt` re-measures the label's opening ratio at a
 * candidate size, and the first size (rounded up to a whole millimetre) whose ratio reaches
 * `LOST_DETAIL_RATIO` is returned. `null` means no tried size gets there, so the cutter is
 * too large for the text.
 *
 * Pure and injected, so it is tested without wasm; the caller supplies `measureAt` (the
 * worker re-measures that one label at the candidate size).
 */
export function suggestCapHeight(
  measureAt: (size: number) => number,
  current: number,
): number | null {
  for (let n = 1; n <= SUGGEST_CAP_HEIGHT_STEPS; n++) {
    const size = Math.ceil(current * SUGGEST_CAP_HEIGHT_GROWTH ** n);
    if (measureAt(size) >= LOST_DETAIL_RATIO) return size;
  }
  return null;
}

/**
 * Re-measure one label's opening ratio at a candidate cap height (mm). The supplier knows
 * the cutter and how to typeset the label; `engravabilityFindings` holds only the measured
 * losses, so this is injected rather than derived (#201 review).
 */
export type LabelRatioAt = (labelId: string, size: number) => number;

/**
 * Turn the measured losses into job findings (#201, #214).
 *
 * Codes and thresholds are the issue's table, renamed `item-*` by #214 (a shape is an item
 * too, and a shape has no characters): `item-empty` is an error, `item-chars-lost` an error,
 * `item-detail-lost` a warning, `item-outside-stock` an error. They are members of
 * `JobFindingCode` (`jobSetup.ts`), so this returns `JobFinding[]` like `validateJob`.
 *
 * `item-detail-lost` is suppressed at `ratio === 0`: a fully-lost item is already the
 * `item-empty` error, and there is no partial detail left to recover. `ratioAt` is consulted
 * only for a LABEL — a shape has no cap height to suggest.
 */
export function engravabilityFindings(
  job: EngraveJob,
  m: LabelEngravability[],
  ratioAt: LabelRatioAt,
): JobFinding[] {
  const findings: JobFinding[] = [];
  const tool = jobTool(job);
  const diameter = tool?.tipDiameter ?? tool?.diameter ?? null;
  const cutter = diameter === null ? 'the cutter' : `a ${diameter} mm cutter`;

  for (const row of m) {
    const src = findItem(job, row.labelId);
    const label = src && !isShapeItem(src) ? src : null;
    const shape = src && isShapeItem(src) ? src : null;

    if (src && hasContent(src) && row.openedArea === 0) {
      findings.push({
        severity: 'error',
        code: 'item-empty',
        labelId: row.labelId,
        message: emptyMessage(src, cutter),
      });
    }

    // Whole characters are a label-only loss: a shape has no glyphs to lose one at a time.
    if (label && row.emptyChars.length > 0) {
      const list = row.emptyChars.map((c) => `"${c.char}" (index ${c.index})`).join(', ');
      findings.push({
        severity: 'error',
        code: 'item-chars-lost',
        labelId: row.labelId,
        message: `Characters lost to ${cutter}: ${list}.`,
      });
    }

    if (label && row.ratio > 0 && row.ratio < LOST_DETAIL_RATIO) {
      const lostPct = (1 - row.ratio) * 100;
      // A measured suggestion, not a scaled one (#201 review): raise the cap height until
      // the re-measured opening keeps 90 % of its area, or say the cutter is too large.
      const suggested = suggestCapHeight((size) => ratioAt(row.labelId, size), label.size);
      const hint =
        suggested === null
          ? 'this cutter is too large for this text — choose a smaller cutter'
          : `try ${suggested} mm or more`;
      findings.push({
        severity: 'warning',
        code: 'item-detail-lost',
        labelId: row.labelId,
        message: `Label "${label.text}" loses ${lostPct.toFixed(0)}% of its area to ${cutter}; ${hint}.`,
      });
    } else if (shape && row.ratio > 0 && row.ratio < LOST_DETAIL_RATIO) {
      // No cap height to offer: say so plainly and point at the two real choices (#214).
      const lostPct = (1 - row.ratio) * 100;
      findings.push({
        severity: 'warning',
        code: 'item-detail-lost',
        labelId: row.labelId,
        message:
          `${itemLabel(shape)} loses ${lostPct.toFixed(0)}% of its area to ${cutter}; ` +
          `use a smaller cutter or a larger shape.`,
      });
    }

    if (row.outsideArea > OUTSIDE_AREA_TOLERANCE_MM2) {
      const who = src ? itemLabel(src) : `Item ${row.labelId}`;
      findings.push({
        severity: 'error',
        code: 'item-outside-stock',
        labelId: row.labelId,
        message:
          `${who} cuts ${row.outsideArea.toFixed(2)} mm² beyond the stock outline inset ` +
          `by the ${job.edgeMargin} mm edge margin.`,
      });
    }
  }

  return findings;
}

/** The item — label or shape — a measurement row names (#214). */
function findItem(job: EngraveJob, id: string): EngraveItem | undefined {
  return job.labels.find((l) => l.id === id) ?? job.shapes.find((s) => s.id === id);
}

function isShapeItem(item: EngraveItem): item is EngraveShape {
  return 'kind' in item;
}

/**
 * Does this item have anything to cut? A shape always does; a label only if it has non-space
 * text. A whitespace label is kept in the plan (#201) and measures an empty opening, but the
 * job-level `no-items` finding already says the job has nothing — it must not ALSO read as
 * `item-empty` (which would mean "the cutter is too big for this text").
 */
function hasContent(item: EngraveItem): boolean {
  return 'kind' in item || item.text.trim().length > 0;
}

/** Why an item has no opened region at all. A circle smaller than the cutter reads as a hole. */
function emptyMessage(item: EngraveItem, cutter: string): string {
  if (!isShapeItem(item)) {
    return `Label "${item.text}" has nothing this cutter can reach: every stroke is thinner than ${cutter}.`;
  }
  if (item.kind === 'circle') {
    return `A ${item.diameter} mm hole cannot be cut with ${cutter}: it is smaller than the cutter.`;
  }
  return `${itemLabel(item)} has nothing this cutter can reach: it is smaller than ${cutter}.`;
}
