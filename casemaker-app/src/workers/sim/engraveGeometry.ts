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
import { keepOutLimit, keepOutMembrane, traceSweptProfile } from '@/engine/cnc/engrave/partPlan';
import { engravableProfile } from '@/engine/cnc/engrave/engravable';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { itemLabel, jobTool } from '@/engine/cnc/engrave/jobSetup';
import { aabbOfProfile, pOffset, type Profile } from '@/engine/compiler/profile';
import type {
  EngraveAnyItem,
  EngraveCombinedShape,
  EngraveJob,
  EngraveShape,
  EngraveVectorShape,
} from '@/types/engraveJob';
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
  /** Area of the opened region lying outside the supported footprint inset by `edgeMargin`, mm². */
  outsideArea: number;
  /** The opened region as plain polygons, work-frame XY — what #172 pockets and what the preview draws. */
  polygons: [number, number][][];
}

/**
 * Evaluate each of `plan.engraves` and its opening, and measure what is lost.
 *
 * `edgeMargin` insets the SUPPORTED FOOTPRINT (`plan.stock.supported`, #213 §3) — the part
 * outline ∪ any sacrificial material beside it; anything cut beyond that inset is reported in
 * `outsideArea`. With no sacrificial material the supported footprint is the part outline, so
 * today's rule holds unchanged; with a strip or board beside the part, an item may run over the
 * part's edge onto it, up to the margin from the sacrificial material's own outer edge.
 * `perChar(labelId)` supplies one `{char, profile}` per character of the label, built by the
 * caller with `labelProfile` on a single-character label at the same size — kerning does not
 * matter for an emptiness test. Whitespace characters are skipped.
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
  // The safe region: the SUPPORTED FOOTPRINT eroded by the edge margin (#213 §3). With no
  // sacrificial material that footprint is the part outline, so this is today's check; with a
  // strip or board beside the part it is the union, which is what lets an item run over an edge.
  // The round join only draws arcs on an OUTWARD offset, so a convex outline insets without
  // rounding its corners.
  const stockInset = executeProfile(tl, pOffset(plan.stock.supported, -edgeMargin));
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
          `${who} cuts ${row.outsideArea.toFixed(2)} mm² beyond the supported material inset ` +
          `by the ${job.edgeMargin} mm edge margin.`,
      });
    }
  }

  return findings;
}

/**
 * Surface area below which an overlap is the two regions sharing an edge rather than covering
 * each other, mm² (#171). Same order as `OUTSIDE_AREA_TOLERANCE_MM2` and far above the ~1e-8 mm²
 * Clipper2 noise floor `ofPolygons` leaves behind.
 */
export const VOID_OVERLAP_AREA_MM2 = 0.01;

/** The verifier's own slack on a depth comparison — `verify.ts` step 4 uses the same 1e-6 mm. */
export const DEPTH_EPS_MM = 1e-6;

/**
 * A cut, reduced to what the void checks read (#171): what it is, how deep it goes and the region
 * it removes. Structural rather than imported — `EngraveRegion` (`cam/engraveJob.ts`) satisfies
 * it — so a worker-sim module need not reach into `cam/`, and `engraveCutRegions` below is the
 * one place a caller builds these from an evaluated plan.
 */
export interface CutRegion {
  id: string;
  /** The operation's display name; the fallback when no document item carries the id. */
  name?: string;
  /** Positive mm below the top face. */
  depth: number;
  polygons: [number, number][][];
}

/** A number for a finding sentence, rounded to the micron so a float artefact never prints. */
function fmtMm(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/**
 * The cuts a void check reads: one `CutRegion` per engrave, carrying the SAME opened polygons
 * `measureLabels` produced — so the check, the CAM and the live preview cannot disagree about
 * where a cut is. A whitespace label has none and is skipped by `polygons.length === 0`.
 *
 * Shared by the preview and the run because BOTH must report the same warning (#171): a warning
 * the live panel hides until Generate is a warning the user never sees while placing the label.
 *
 * Drills (#220) are deliberately absent. A plunge into a magnet pocket is a BREACH, which the
 * verifier already refuses as `cut-too-deep`; the warning here is about the finish of a pocketed
 * floor, which a drilled hole does not have.
 */
export function engraveCutRegions(plan: PartPlan, measured: readonly LabelEngravability[]): CutRegion[] {
  const byId = new Map(measured.map((m) => [m.labelId, m] as const));
  return plan.engraves.map((e) => ({
    id: e.id,
    name: e.name,
    depth: e.depth,
    polygons: byId.get(e.id)?.polygons ?? [],
  }));
}

/**
 * The cuts a void check reads for SINGLE-LINE TRACES (#270): one `CutRegion` per trace, its region
 * the path swept by the cutter. `traceSweptProfile` is the same shape the oracle predicts with, so
 * the warning and the simulation cannot disagree about where a trace cuts.
 *
 * A trace IS warned about, unlike a drill (#220). The reason the drill is exempt does not apply
 * here: a trace is a single pass, so it has no pocketed floor, but the advice the warning carries —
 * move the cut clear, it costs nothing — is exactly the advice that helps. Material over a void is
 * an unsupported membrane whatever the depth, so a traced line crossing one will chatter.
 *
 * `toolRadius` is null when the job has no usable cutter, in which case there is nothing to sweep
 * and the list is empty — the same "no cutter, nothing measured" rule `measureLabels` follows.
 */
export function traceCutRegions(
  tl: ManifoldToplevel,
  plan: PartPlan,
  toolRadius: number | null,
): CutRegion[] {
  if (toolRadius === null || toolRadius <= 0 || plan.traces.length === 0) return [];
  return plan.traces.map((t) => {
    const cs = executeProfile(tl, traceSweptProfile(t.paths, t.closed, toolRadius));
    try {
      // `toPolygons()` returns each contour as [x, y][]; the same shape `measureLabels` produces.
      return { id: t.id, name: t.name, depth: t.depth, polygons: cs.toPolygons() as [number, number][][] };
    } finally {
      cs.delete();
    }
  });
}

/**
 * Warn about every cut that sits over an under-surface void (#171).
 *
 * One finding, not two: a cut deep enough to breach the membrane is refused as `cut-too-deep` by
 * the VERIFIER, against the LAYER-ALIGNED limit #178's stack supplies, and that refusal's own
 * advice is to move the cut clear. Computing a second breach test here would mean a second owner
 * of the same depth limit at a different resolution — the two could disagree by a layer — so this
 * raises the WARNING only, suppressed where the cut has already breached (the depth the verifier
 * will refuse) to keep one fact to one finding.
 *
 * The warning is not a lesser error; it is a different fact. The blank is printed flipped, so the
 * material over a void is an unsupported membrane however shallow the cut — that is
 * `/Fabrication.md` §7.2's chatter, and it is true at 0.1 mm. `region.depth` here is only used to
 * hand the case to the verifier; the membrane thickness is what the sentence reports.
 *
 * Each cut yields at most one finding, about the void with the SHALLOWEST limit among those it
 * covers: the same "worst void wins" rule `keepOutLimitAt` and the run sheet's `keepOutOver` use,
 * so the banner and the sheet name the same void.
 *
 * `regions` are the engrave regions (`engraveCutRegions`); single-line traces are swept from the
 * plan here instead (#270), so a caller does not have to remember they exist. Drills are still
 * absent (#220) — see `engraveCutRegions`.
 */
export function keepOutFindings(
  tl: ManifoldToplevel,
  job: EngraveJob,
  plan: PartPlan,
  regions: readonly CutRegion[],
  toolRadius: number | null,
): JobFinding[] {
  // A void-free job is the common case and pays for nothing more than this line (#171): the trace
  // regions below need the toplevel to sweep, and sweeping them for a job with no voids to check
  // against would be pure waste on #205's debounce.
  if (plan.stock.keepOuts.length === 0) return [];
  const CS = tl.CrossSection;
  const findings: JobFinding[] = [];
  // #270 — traces reach the void check here rather than through `engraveCutRegions`, because their
  // region is a swept path rather than a measured opening. Built only once the job is known to
  // declare a void, so the early return above still holds.
  const all: readonly CutRegion[] = [...regions, ...traceCutRegions(tl, plan, toolRadius)];

  // Each void footprint is evaluated ONCE, not once per cut: a blank carries a handful of voids
  // and a job dozens of cuts, and every evaluation is a Clipper2 op (#205 runs this on a debounce).
  const voids = plan.stock.keepOuts.map((ko) => {
    const membrane = keepOutMembrane(job, ko.zCeiling);
    return { name: ko.name, cs: executeProfile(tl, ko.footprint), membrane, limit: keepOutLimit(job, membrane) };
  });

  try {
    for (const region of all) {
      if (region.polygons.length === 0) continue;
      const cut = CS.ofPolygons(region.polygons, 'Positive');
      try {
        let worst: { name: string; membrane: number; limit: number } | null = null;
        for (const void_ of voids) {
          const overlap = CS.intersection([cut, void_.cs]);
          const area = overlap.area();
          overlap.delete();
          if (area <= VOID_OVERLAP_AREA_MM2) continue;
          // `<=`: at equal limits the first void named stays, which for a job whose voids are
          // declared in document order is the earlier one — stable, and never a silent re-pick.
          if (worst === null || void_.limit < worst.limit) worst = void_;
        }
        if (worst === null) continue;

        // A breach is the verifier's refusal, on the real text and the layer-aligned limit; the
        // user reads the advice to move the cut clear there. Saying it twice is noise.
        if (region.depth > worst.limit + DEPTH_EPS_MM) continue;

        const src = findItem(job, region.id);
        const who = src ? itemLabel(src) : region.name || `Item ${region.id}`;
        findings.push({
          severity: 'warning',
          code: 'item-over-void',
          labelId: region.id,
          message:
            `${who} cuts ${fmtMm(region.depth)} mm deep over "${worst.name}" — a ` +
            `${fmtMm(worst.membrane)} mm membrane with nothing under it — so expect chatter and a ` +
            `rough finish there. Moving the cut clear of the void will finish better.`,
        });
      } finally {
        cut.delete();
      }
    }
  } finally {
    for (const v of voids) v.cs.delete();
  }
  return findings;
}

/** The item — label, shape, combined shape or imported vector — a measurement row names (#214/#215/#217). */
function findItem(job: EngraveJob, id: string): EngraveAnyItem | undefined {
  return (
    job.labels.find((l) => l.id === id) ??
    job.shapes.find((s) => s.id === id) ??
    (job.combined ?? []).find((c) => c.id === id) ??
    (job.vectors ?? []).find((v) => v.id === id)
  );
}

function isShapeItem(
  item: EngraveAnyItem,
): item is EngraveShape | EngraveCombinedShape | EngraveVectorShape {
  return 'kind' in item;
}

/**
 * Does this item have anything to cut? A shape always does; a label only if it has non-space
 * text. A whitespace label is kept in the plan (#201) and measures an empty opening, but the
 * job-level `no-items` finding already says the job has nothing — it must not ALSO read as
 * `item-empty` (which would mean "the cutter is too big for this text").
 */
function hasContent(item: EngraveAnyItem): boolean {
  return 'kind' in item || item.text.trim().length > 0;
}

/** Why an item has no opened region at all. A circle smaller than the cutter reads as a hole. */
function emptyMessage(item: EngraveAnyItem, cutter: string): string {
  if (!isShapeItem(item)) {
    return `Label "${item.text}" has nothing this cutter can reach: every stroke is thinner than ${cutter}.`;
  }
  if (item.kind === 'circle') {
    return `A ${item.diameter} mm hole cannot be cut with ${cutter}: it is smaller than the cutter.`;
  }
  return `${itemLabel(item)} has nothing this cutter can reach: it is smaller than ${cutter}.`;
}
