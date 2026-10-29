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
import { keepOutMembrane, primitiveLabel, traceSweptProfile } from '@/engine/cnc/engrave/partPlan';
import { engravableProfile } from '@/engine/cnc/engrave/engravable';
import { aroundScale, hasFloor } from '@/engine/cnc/rotary/wrap';
import {
  boundsFor,
  checkBounds,
  defaultBoundaryMargin,
  voidFloor,
  voidMargin,
  type BoundViolation,
} from '@/engine/cnc/engrave/depthBounds';
import { printedLayerGridOf, voidCeilingFor } from '@/engine/cnc/layerStack';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { itemLabel } from '@/engine/cnc/engrave/jobSetup';
import { statedCuttingSize, type Tool } from '@/engine/cnc/tool';
import { vCone } from '@/engine/cnc/vProfile';
import { aabbOfProfile, pOffset, type Profile } from '@/engine/compiler/profile';
import type {
  EngraveAnyItem,
  EngraveCombinedShape,
  EngraveJob,
  EngraveLabel,
  EngravePrimitive,
  EngraveShape,
  EngraveVectorShape,
} from '@/types/engraveJob';
import { executeProfile, type ManifoldToplevel } from '@/workers/geometry/evaluateOp';

/**
 * The labelled fallback for `engrave.lostDetailWarnRatio`: the share of an item's area a cutter
 * must keep before `item-detail-lost` is raised. `0.9` is #171's starting value; the shop's own
 * number is read on the main thread (the worker cannot see the location) and arrives on the opts
 * object. Named and cited rather than repeated as a bare literal (#201, #451).
 */
export const LOST_DETAIL_RATIO_FALLBACK = 0.9;

/** The caller's warn ratio when it is a usable share, else {@link LOST_DETAIL_RATIO_FALLBACK}. */
export function lostDetailRatioFrom(lostDetailWarnRatio: number | null | undefined): number {
  return typeof lostDetailWarnRatio === 'number' &&
    Number.isFinite(lostDetailWarnRatio) &&
    lostDetailWarnRatio > 0
    ? lostDetailWarnRatio
    : LOST_DETAIL_RATIO_FALLBACK;
}

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
  /**
   * #240 — the item's cut reaches or passes the rotary AXIS, so it has no floor to measure on and
   * every area above is zero by construction, not by geometry. Its refusal is
   * `rotaryJobFindings`' "cuts through the centre"; the empty-item findings would blame the
   * cutter for a job the depth already refuses.
   */
  noFloor?: true;
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
 * `radiusFor` overrides `toolRadius` per item (#221): a V-carve's opening is measured at
 * `rPlane = tipRadius + (depth − film)·tanHalf`, which differs from item to item on a design whose
 * regions state different depths. Absent, every item uses `toolRadius`, exactly as before.
 *
 * `wrapFor(labelId)` says an item is authored on a ROTARY MAP (#240): `{radius, depth}` is the
 * stock's radius and the item's floor depth, and the opening is then the anisotropic one (R10),
 * built in the floor's own frame via `aroundScale`. Every polygon this returns STAYS IN MAP
 * MILLIMETRES — X along the axis, Y the surface arc at `R` — because that is the space the CAM,
 * the preview and the oracle all speak; `toRotaryIR` is the one place the map becomes `A`.
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
  radiusFor?: (labelId: string) => number,
  wrapFor?: (labelId: string) => { radius: number; depth: number } | null | undefined,
): LabelEngravability[] {
  const CS = tl.CrossSection;
  /**
   * The tool footprint's frame for one item, or `'no-floor'` when its depth reaches or passes the
   * axis (#240). A no-floor item measures EMPTY here: its refusal is the findings stage's
   * "cuts through the centre", and `aroundScale`'s own throw would pre-empt that sentence.
   * `toolRadius` is the item's own opening radius (a V's plane radius differs per item, #221).
   */
  const wrapOf = (labelId: string, toolRadius: number): { aroundScale: number } | 'no-floor' | undefined => {
    const w = wrapFor?.(labelId);
    if (!w) return undefined;
    return hasFloor(w.radius, w.depth) ? { aroundScale: aroundScale(w.radius, w.depth, toolRadius) } : 'no-floor';
  };
  // The safe region: the SUPPORTED FOOTPRINT eroded by the edge margin (#213 §3). With no
  // sacrificial material that footprint is the part outline, so this is today's check; with a
  // strip or board beside the part it is the union, which is what lets an item run over an edge.
  // The round join only draws arcs on an OUTWARD offset, so a convex outline insets without
  // rounding its corners.
  const stockInset = executeProfile(tl, pOffset(plan.stock.supported, -edgeMargin));
  const out: LabelEngravability[] = [];
  try {
    for (const engrave of plan.engraves) {
      // The opening this item is measured at. A flat cutter has one radius for the job; a V's
      // plane radius depends on the item's own depth (#221). A non-positive radius has no opening
      // at all, so the item measures empty — the findings stage refuses it by name.
      const itemRadius = radiusFor?.(engrave.id) ?? toolRadius;
      // The tool footprint's frame, when this item is authored on a rotary map (#240, R10). One
      // lookup for the region AND its per-character openings, so the two are measured on one
      // opening, at this item's own radius.
      const wrap = wrapOf(engrave.id, itemRadius);
      // A whitespace label is a `p-poly` with no contours, kept in the plan so it can be
      // reported (`labelProfile`). Manifold's `ofPolygons([])` throws, and every area is
      // zero anyway, so an empty profile short-circuits the whole evaluation. The same holds for
      // a floor at or past the axis (see `wrapOf`).
      const isEmpty = aabbOfProfile(engrave.profile) === null || !(itemRadius > 0) || wrap === 'no-floor';
      // Inside the `!isEmpty` block and the character loop below, `wrap` is a real floor frame.
      const openingWrap = wrap === 'no-floor' ? undefined : wrap;
      let glyphArea = 0;
      let openedArea = 0;
      let outsideArea = 0;
      let polygons: [number, number][][] = [];

      if (!isEmpty) {
        const glyphCS = executeProfile(tl, engrave.profile);
        glyphArea = glyphCS.area();
        glyphCS.delete();

        const openedCS = executeProfile(tl, engravableProfile(engrave.profile, itemRadius, openingWrap));
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
        // A no-floor item has no opening to measure at all; the depth finding names it.
        if (wrap === 'no-floor') return;
        if (entry.char.trim() === '') return;
        if (aabbOfProfile(entry.profile) === null) {
          emptyChars.push({ index, char: entry.char });
          return;
        }
        const charCS = executeProfile(tl, engravableProfile(entry.profile, itemRadius, openingWrap));
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
        ...(wrap === 'no-floor' ? { noFloor: true as const } : {}),
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
 * The area ratio is NOT linear in size — scaling the cap height by the warning bar over the
 * measured ratio has no physical basis (it suggested 93 mm for a 4 mm label at 3.9 % survival) — so
 * the suggestion is MEASURED rather than scaled: `measureAt` re-measures the label's opening ratio
 * at a candidate size, and the first size (rounded up to a whole millimetre) whose ratio reaches
 * the warning bar is returned. `null` means no tried size gets there, so the cutter is
 * too large for the text.
 *
 * `lostDetailWarnRatio` is the shop's `engrave.lostDetailWarnRatio` (#451), read by the caller;
 * `null`/absent (or an unusable value) leaves {@link LOST_DETAIL_RATIO_FALLBACK} in charge.
 *
 * Pure and injected, so it is tested without wasm; the caller supplies `measureAt` (the
 * worker re-measures that one label at the candidate size).
 */
export function suggestCapHeight(
  measureAt: (size: number) => number,
  current: number,
  lostDetailWarnRatio: number | null = null,
): number | null {
  const bar = lostDetailRatioFrom(lostDetailWarnRatio);
  for (let n = 1; n <= SUGGEST_CAP_HEIGHT_STEPS; n++) {
    const size = Math.ceil(current * SUGGEST_CAP_HEIGHT_GROWTH ** n);
    if (measureAt(size) >= bar) return size;
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
 * How a finding names the cutter it is about. A flat end mill is its diameter; a V-BIT is its tip
 * and its angle (#405), because "a 0.3 mm cutter" describes only the floor of the groove it cuts
 * and the angle is the other half of what the operator has to picture. Falls back to "the cutter"
 * when the job names none — a sentence must not invent a number.
 */
function cutterPhrase(tool: Tool | null): string {
  if (tool === null) return 'the cutter';
  // #740 — the size the record STATES. `cuttingDiameter` answers the shank for an engraver,
  // chamfer or drill with no tip, and a sentence that called that the cutter would name a width it
  // does not cut with. A record that states no size gets the cutter without a number, never an
  // invented one; the worker asks for the tip before an item is judged (`tool-tip-unrecorded`).
  const diameter = statedCuttingSize(tool);
  if (diameter === null) return 'the cutter';
  const cone = vCone(tool);
  if (cone !== null) return `a ${diameter} mm ${Math.round(cone.halfAngleDeg * 2)}° V-bit`;
  return `a ${diameter} mm cutter`;
}

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
 *
 * `tool` is HANDED IN, not resolved here (#305): this module is worker-side, where no store and
 * no registry is visible. The caller resolves it on the main thread (`jobTool`) or from the list
 * it passed (`toolForJob`) and the same `Tool` object then feeds the measurement, the messages
 * and the CAM, so a finding can never name a cutter the sweep did not use.
 *
 * `lostDetailWarnRatio` is the shop's `engrave.lostDetailWarnRatio` (#451), read by the caller
 * because this realm cannot see the location. `null`/absent — or a value that is not a positive
 * finite number — leaves {@link LOST_DETAIL_RATIO_FALLBACK} in charge, the labelled no-service
 * fallback.
 */
export function engravabilityFindings(
  job: EngraveJob,
  m: LabelEngravability[],
  ratioAt: LabelRatioAt,
  tool: Tool | null,
  lostDetailWarnRatio: number | null = null,
): JobFinding[] {
  const findings: JobFinding[] = [];
  const cutter = cutterPhrase(tool);
  const bar = lostDetailRatioFrom(lostDetailWarnRatio);

  for (const row of m) {
    // #240 — a rotary item with no floor was never measurable; the depth finding names it.
    if (row.noFloor === true) continue;
    const src = findItem(job, row.labelId);
    const primitive = src === undefined ? findPrimitive(job, row.labelId) : undefined;
    const label = src && !isShapeItem(src) ? src : null;
    const shape = src && isShapeItem(src) ? src : null;

    const empty =
      (src !== undefined && hasContent(src) && row.openedArea === 0) ||
      (primitive !== undefined && row.glyphArea > 0 && row.openedArea === 0);
    if (empty) {
      findings.push({
        severity: 'error',
        code: 'item-empty',
        labelId: row.labelId,
        message:
          primitive !== undefined
            ? `${primitiveLabel(primitive)} has nothing this cutter can reach: it is smaller than ${cutter}.`
            : src !== undefined
              ? emptyMessage(src, cutter)
              : '',
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

    if (label && row.ratio > 0 && row.ratio < bar) {
      const lostPct = (1 - row.ratio) * 100;
      // A measured suggestion, not a scaled one (#201 review): raise the cap height until
      // the re-measured opening reaches the warning bar, or say the cutter is too large.
      const suggested = suggestCapHeight((size) => ratioAt(row.labelId, size), label.size, bar);
      const hint =
        suggested === null
          ? 'this cutter is too large for this text — choose a smaller cutter'
          : `try ${suggested} mm or more`;
      findings.push({
        severity: 'warning',
        code: 'item-detail-lost',
        labelId: row.labelId,
        message: `Engrave text "${label.text}" loses ${lostPct.toFixed(0)}% of its area to ${cutter}; ${hint}.`,
      });
    } else if (shape && row.ratio > 0 && row.ratio < bar) {
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
 * Area below which a glyph contour, or a glyph's overlap with one kept component, is Clipper
 * dust rather than material, mm² (#739).
 */
export const RAISED_TEXT_AREA_TOLERANCE_MM2 = 0.001;

/**
 * Bisection steps for the smallest radius that joins a raised label's letters. The search runs
 * over the job's own cutter radius (a few millimetres at most), so sixteen halvings resolve the
 * threshold to far below the micron the sentence prints (#739).
 */
const RAISED_TEXT_BISECTION_STEPS = 16;

/** One glyph component of a raised label, evaluated once and kept for every fusion test (#739). */
interface RaisedIslandPart {
  labelId: string;
  cs: ReturnType<typeof executeProfile>;
  /** Holes the glyph itself has — its counters. A kept component with fewer has filled one. */
  holes: number;
}

/**
 * One raised label the cutter cannot keep apart (#739).
 *
 * It exists only for a label that DOES fuse at the job's cutter: the measurement is the answer
 * to "how much smaller must the cutter be", not a survey of every raised label.
 */
export interface RaisedTextMeasurement {
  /** The cutaway that clears the field. */
  cutawayId: string;
  labelId: string;
  /** The label's own text, for the sentence. */
  text: string;
  /** Its cap height in the document, mm. */
  size: number;
  /** The radius the cutaway is cut with, mm — a flat cutter's radius, or a V's radius at its plane. */
  cutterRadius: number;
  /** The measured narrowest gap the letters keep, mm: twice the smallest joining radius. */
  gap: number;
  /** Two or more glyph components end up in one kept component: letters run together. */
  joined: boolean;
  /** A kept component holding one glyph has fewer holes than the glyph: a counter fills in. */
  counterFilled: boolean;
  /**
   * The smallest whole-millimetre cap height whose gaps clear this cutter, or `null` when the
   * label's letters already touch at the document's size (a joined script, not a gap).
   */
  minSize: number | null;
}

/**
 * #739 — measure the raised labels the cutter joins, in the profile algebra the CAM already uses.
 *
 * A cutaway pocket is `field = outer − ⋃islands`, and the cutter removes its OPENING
 * `O(r) = offset(offset(field, −r), +r)` — the same `engravableProfile` every other reachability
 * check is built on. What stands at full height is therefore `⋃islands ∪ (field − O(r))`: the
 * labels themselves, plus any sliver of the field the cutter's radius could not clear. A label
 * has FUSED when one kept component holds two or more of its glyph components (letters bridged
 * into one), or when a kept component holding a single glyph has fewer holes than that glyph
 * (a counter filled in). Extra kept components and extra holes are ignored: they are loose
 * slivers and enclosed cleared pockets, not a letter losing its shape.
 *
 * This is a STRUCTURAL test, not a pairwise distance. "CNX" in the j02 bench job has an N–X gap
 * of 3.1137 mm — narrower than the 3.175 mm cutter — yet the opening still clears the pinch
 * because a disc of that radius reaches it from the sides, and the letters stay three separate
 * components. A minimum-distance rule would warn about a job the bench cut correctly.
 *
 * `gap` is twice the smallest radius at which the label fuses, found by bisection between zero
 * and the cutter's own radius (fusion is monotone: a larger radius removes more of the field and
 * can only add material to what stands). The suggested cap height is linear because the glyph
 * outline is: `size × (2·cutterRadius) / gap`, rounded up to a whole millimetre. That is the
 * measured threshold, not a table of sizes.
 *
 * `radiusFor` is the cutter radius the CUTAWAY is cut with. It is handed in for the same reason
 * `measureLabels` takes one: a flat cutter has one radius for the job, while a V's plane radius
 * follows the cutaway's own depth (#221). The sentence names the cutter with `cutterPhrase`;
 * for a V-bit the number compared is that plane width, not the tip.
 *
 * Every `CrossSection` this creates — the field, each glyph component, each opening, each kept
 * component and each overlap test — is deleted exactly once.
 */
export function measureRaisedTexts(
  tl: ManifoldToplevel,
  job: EngraveJob,
  raisedTexts: PartPlan['raisedTexts'],
  radiusFor: (cutawayId: string) => number | null,
): RaisedTextMeasurement[] {
  if (raisedTexts.length === 0) return [];
  const CS = tl.CrossSection;
  const labelById = new Map(job.labels.map((label) => [label.id, label] as const));
  const out: RaisedTextMeasurement[] = [];

  for (const raised of raisedTexts) {
    const cutterRadius = radiusFor(raised.id);
    // No width, no gap: a tool that cannot be sized for this cut has no sentence to make.
    if (cutterRadius === null || !(cutterRadius > 0)) continue;

    const fieldCS = executeProfile(tl, raised.field);
    const parts: RaisedIslandPart[] = [];
    try {
      if (fieldCS.area() <= RAISED_TEXT_AREA_TOLERANCE_MM2) continue;

      for (const island of raised.islands) {
        const islandCS = executeProfile(tl, island.profile);
        try {
          for (const part of islandCS.decompose()) {
            if (part.area() <= RAISED_TEXT_AREA_TOLERANCE_MM2) {
              part.delete();
              continue;
            }
            parts.push({ labelId: island.labelId, cs: part, holes: part.numContour() - 1 });
          }
        } finally {
          islandCS.delete();
        }
      }
      if (parts.length === 0) continue;

      /**
       * What fuses at radius `r`, by label. One evaluation of the kept region serves every
       * label: a kept component with two glyph components flags BOTH labels it joins, and one
       * with a single glyph flags that label only when its counters were filled.
       */
      const fusedAt = (r: number): Map<string, { joined: boolean; counterFilled: boolean }> => {
        const islands = CS.compose(parts.map((part) => part.cs));
        let kept = islands;
        if (r > 0) {
          const opened = executeProfile(tl, engravableProfile(raised.field, r));
          const leftover = CS.difference([fieldCS, opened]);
          opened.delete();
          kept = CS.union([islands, leftover]);
          leftover.delete();
          islands.delete();
        }
        const fused = new Map<string, { joined: boolean; counterFilled: boolean }>();
        const flag = (labelId: string, key: 'joined' | 'counterFilled'): void => {
          const cur = fused.get(labelId) ?? { joined: false, counterFilled: false };
          fused.set(labelId, { ...cur, [key]: true });
        };
        try {
          for (const part of kept.decompose()) {
            try {
              const inside = parts.filter((island) => {
                const hit = CS.intersection([part, island.cs]);
                try {
                  return hit.area() > island.cs.area() * 0.5;
                } finally {
                  hit.delete();
                }
              });
              if (inside.length > 1) {
                for (const island of inside) flag(island.labelId, 'joined');
              } else if (inside.length === 1) {
                const island = inside[0]!;
                if (part.numContour() - 1 < island.holes) flag(island.labelId, 'counterFilled');
              }
            } finally {
              part.delete();
            }
          }
        } finally {
          kept.delete();
        }
        return fused;
      };

      const fusedAtCutter = fusedAt(cutterRadius);
      if (fusedAtCutter.size === 0) continue;
      const fusedAtZero = fusedAt(0);
      for (const labelId of new Set(parts.map((part) => part.labelId))) {
        const cause = fusedAtCutter.get(labelId);
        if (cause === undefined) continue;
        const label = labelById.get(labelId);
        if (label === undefined) continue;

        // The smallest radius that joins THIS label. Zero when the letters already touch with
        // no cutter at all — then there is no gap to quote and no size to suggest.
        let fuseRadius = 0;
        if (!fusedAtZero.has(labelId)) {
          let lo = 0;
          let hi = cutterRadius;
          for (let i = 0; i < RAISED_TEXT_BISECTION_STEPS; i++) {
            const mid = (lo + hi) / 2;
            if (fusedAt(mid).has(labelId)) hi = mid;
            else lo = mid;
          }
          fuseRadius = hi;
        }
        const gap = 2 * fuseRadius;
        // Glyph geometry scales exactly with the cap height (the font is laid out at that size),
        // so the gap does too; the epsilon keeps an exact multiple from rounding up a millimetre.
        const minSize =
          gap > 0 ? Math.ceil((label.size * (2 * cutterRadius)) / gap - 1e-9) : null;
        out.push({
          cutawayId: raised.id,
          labelId,
          text: label.text,
          size: label.size,
          cutterRadius,
          gap,
          joined: cause.joined,
          counterFilled: cause.counterFilled,
          minSize,
        });
      }
    } finally {
      for (const part of parts) part.cs.delete();
      fieldCS.delete();
    }
  }
  return out;
}

/**
 * The sentences for the raised labels the cutter joins (#739).
 *
 * A WARNING, not an error: the cut still runs, and the operator may want the joined look. The
 * sentence names the text, its size, the measured gap, the width that cannot clear it, and the
 * two measured ways out. Every number carries its unit through `fmtMm` (three decimals at most,
 * trailing zeros dropped); the finding code stays in the diagnostic data and never in the words.
 */
export function raisedTextFindings(
  measurements: readonly RaisedTextMeasurement[],
  tool: Tool | null,
): JobFinding[] {
  const cutter = cutterPhrase(tool);
  // What the gap was measured AGAINST. For a flat cutter that is its own diameter; for a V it is
  // the WIDTH AT THE CUTAWAY'S DEPTH, not the tip (`planeRadiusFor`, the plane the CAM and the
  // reachability measurement use). Saying "narrower than a 0.3 mm V-bit" about a 1.6 mm gap would
  // be false, so the row's own radius supplies the number and the tip only names the tool.
  const cone = tool === null ? null : vCone(tool);
  return measurements.map((m) => {
    const gap = fmtMm(m.gap);
    const compared =
      cone === null ? cutter : `the ${fmtMm(2 * m.cutterRadius)} mm width ${cutter} cuts at that depth`;
    // A V's way out is a width at depth too, because that is the number the warning compared.
    const narrower =
      cone === null ? `a cutter ${gap} mm or smaller` : `a cutter no wider than ${gap} mm at that depth`;
    // The sentence says which measured thing happened, not a generic "it fails": two letters
    // bridged into one is a different picture from a counter filled in, and both are possible.
    const what =
      m.joined && m.counterFilled
        ? 'the letters will join and a counter will fill in'
        : m.joined
          ? 'the letters will join'
          : m.counterFilled
            ? 'a counter will fill in'
            : 'the raised text will lose its gaps';
    const advice =
      m.minSize !== null
        ? `Use ${narrower}, or text ${m.minSize} mm or more.`
        : m.joined
          ? `Use ${narrower}, or space the letters apart.`
          : `Use ${narrower}, or use larger text.`;
    return {
      severity: 'warning' as const,
      code: 'raised-text-fused' as const,
      labelId: m.labelId,
      message:
        `Raised text "${m.text}" at ${fmtMm(m.size)} mm has gaps down to ${gap} mm, ` +
        `narrower than ${compared}; ${what}. ${advice}`,
    };
  });
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
  /**
   * #218 — this cut reaches THROUGH the blank into the under-board. A void under it is not a
   * finish problem: the cut would break into the cavity and the membrane is all that holds the
   * freed piece, so `keepOutFindings` raises an error rather than a warning.
   */
  through?: boolean;
  /**
   * #218 — this region is a cut-out's KERF rather than a pocket. Only the sentence differs: it
   * has no document item, so the finding names it as `Cut-out "…"` instead of looking it up.
   */
  cutout?: boolean;
  /**
   * A V-carve's three outlines (#221), present only on a region cut by a cone. `polygons` above is
   * the colour-plane design; `floor` is the pocket bottom and `surface` the opening at the top
   * face. Structural, so this module still does not import `cam/engraveJob`. The preview draws all
   * three and cuts the stock with `surface`.
   */
  vCarve?: {
    plane: [number, number][][];
    floor: [number, number][][];
    surface: [number, number][][];
    /** Where the design outline sits: the film's depth, or the floor depth with no film. */
    planeDepth: number;
    planeRadius: number;
    floorInset: number;
    surfaceOutset: number;
    /**
     * #748 — the surface the item sits on, mm below the top face: the pocket floor a label is
     * written into, absent (0) at the stock's top face. The preview draws the surface opening
     * there; the fixed-depth toolpath does not read it.
     */
    floorDepth?: number;
  };
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
    ...(e.through === true ? { through: true as const } : {}),
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
 * `radiusAt` is the cutter's half-opening at a DEPTH, or null when the job has no cutter a trace
 * can take (#405): a V-bit's groove widens as it deepens, so each trace is swept at its own depth
 * rather than at one fixed radius, and a tool that cannot trace at all gives nothing to sweep and
 * the list is empty — the same "no cutter, nothing measured" rule `measureLabels` follows.
 */
export function traceCutRegions(
  tl: ManifoldToplevel,
  plan: PartPlan,
  radiusAt: (depth: number) => number | null,
): CutRegion[] {
  if (plan.traces.length === 0) return [];
  return plan.traces.flatMap((t): CutRegion[] => {
    // #674 — a FLUTE is swept per SEGMENT, at the segment's DEEP end: the plan's profile is the Z
    // the CAM and both engines follow (a move is swept at `min(z0, z1)`), so one entry per
    // segment is the same reduction the sim makes, not an approximation of it. The entry keeps
    // the trace's id — the preview matches its own per-segment drawing by it.
    if (t.depths !== undefined) {
      const out: CutRegion[] = [];
      for (let pi = 0; pi < t.paths.length; pi++) {
        const path = t.paths[pi]!;
        const depths = t.depths[pi];
        if (depths === undefined || path.length === 0) continue;
        const last = (t.closed[pi] ?? false) ? path.length : path.length - 1;
        for (let j = 0; j < last; j++) {
          // The move's DEEP end — the same reduction both sweep engines make (#629): `min` of the
          // negative Zs is `max` of the positive depths.
          const depth = Math.max(depths[j] ?? 0, depths[(j + 1) % path.length] ?? 0);
          if (!(depth > 0)) continue;
          const toolRadius = radiusAt(depth);
          if (toolRadius === null || toolRadius <= 0) continue;
          const segment: [number, number][] = [
            [path[j]![0], path[j]![1]],
            [path[(j + 1) % path.length]![0], path[(j + 1) % path.length]![1]],
          ];
          const cs = executeProfile(tl, traceSweptProfile([segment], [false], toolRadius));
          try {
            out.push({ id: t.id, name: t.name, depth, polygons: cs.toPolygons() as [number, number][][] });
          } finally {
            cs.delete();
          }
        }
      }
      return out;
    }
    const toolRadius = radiusAt(t.depth);
    if (toolRadius === null || toolRadius <= 0) return [];
    const cs = executeProfile(tl, traceSweptProfile(t.paths, t.closed, toolRadius));
    try {
      // `toPolygons()` returns each contour as [x, y][]; the same shape `measureLabels` produces.
      return [{ id: t.id, name: t.name, depth: t.depth, polygons: cs.toPolygons() as [number, number][][] }];
    } finally {
      cs.delete();
    }
  });
}

/**
 * The void that binds one cut region (#345), with the numbers a bound needs off it.
 *
 * It is a REDUCTION of a void, not a copy of one: the footprint `CrossSection` is gone, so this
 * survives the `delete()` the scan does and can be handed to the findings stage.
 */
export interface BindingVoid {
  /** The void's name as authored; `''` when it has none. */
  name: string;
  /** Solid material between the engraved face and the void's roof, mm (`keepOutMembrane`). */
  membrane: number;
  /**
   * The roof as a DEPTH below the face — the PLANE a bound sits at, which is what a finding quotes.
   * Layer-aligned where the blank states its print (`voidCeilingFor`), the declared membrane where
   * it states none.
   */
  ceiling: number;
  /** The deepest cut the void permits: `ceiling` less the margin its rule keeps, mm. */
  limit: number;
}

/**
 * The void that binds each cut region, by region id (#345, decision B) — the ONE scan.
 *
 * BOTH the per-move warning (`keepOutFindings`) and the per-item bound (`itemDepthBoundFindings`)
 * read this map, so the two cannot name different voids for the same overlap; that is the whole
 * point of extracting it. "Worst void wins" is the same rule `keepOutLimitAt` and the run sheet's
 * `keepOutOver` follow: when two voids overlap a cut, the shallower limit is the one to respect.
 *
 * The margin is `voidMargin`'s, i.e. the ceiling keeps the Z-error margin on a printed blank and
 * `max(boundaryMargin, minFloor)` on one that states no print (#345 decision A) — the same pair
 * `keepOutLimit` and the run sheet work out, so the three never keep different distances.
 *
 * `regions` must ALREADY include the trace regions (`traceCutRegions`): the caller builds that list
 * once, and a job that declares no void gets an empty map without paying for the sweep.
 */
export function bindingVoidsByRegion(
  tl: ManifoldToplevel,
  job: EngraveJob,
  plan: PartPlan,
  regions: readonly CutRegion[],
  margin: number = defaultBoundaryMargin(job),
): Map<string, BindingVoid> {
  const out = new Map<string, BindingVoid>();
  if (plan.stock.keepOuts.length === 0) return out;
  const CS = tl.CrossSection;
  // Each void footprint is evaluated ONCE, not once per cut: a blank carries a handful of voids
  // and a job dozens of cuts, and every evaluation is a Clipper2 op (#205 runs this on a debounce).
  const voids = plan.stock.keepOuts.map((ko) => {
    const membrane = keepOutMembrane(job, ko.zCeiling);
    const ceiling = voidCeilingFor(membrane, plan.stock.thickness, printedLayerGridOf(job.stock));
    return {
      name: ko.name,
      membrane,
      ceiling,
      limit: voidFloor(ceiling, voidMargin(job, margin)),
      cs: executeProfile(tl, ko.footprint),
    };
  });

  try {
    for (const region of regions) {
      if (region.polygons.length === 0) continue;
      const cut = CS.ofPolygons(region.polygons, 'Positive');
      try {
        let worst: (typeof voids)[number] | null = null;
        for (const void_ of voids) {
          const overlap = CS.intersection([cut, void_.cs]);
          const area = overlap.area();
          overlap.delete();
          if (area <= VOID_OVERLAP_AREA_MM2) continue;
          // `<`: at equal limits the first void named stays, which for a job whose voids are
          // declared in document order is the earlier one — stable, and never a silent re-pick.
          if (worst === null || void_.limit < worst.limit) worst = void_;
        }
        if (worst !== null) {
          out.set(region.id, {
            name: worst.name,
            membrane: worst.membrane,
            ceiling: worst.ceiling,
            limit: worst.limit,
          });
        }
      } finally {
        cut.delete();
      }
    }
  } finally {
    for (const v of voids) v.cs.delete();
  }
  return out;
}

/**
 * Warn about every cut that sits over an under-surface void (#171).
 *
 * #218 — a THROUGH cut (a region flagged `through`, or a cut-out's kerf) raised over a void is an
 * ERROR instead: the cut leaves the blank and breaks into the cavity, and the membrane over it is
 * the only material holding the freed piece. The warning's depth suppression does not apply to it.
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
 * `bound` is `bindingVoidsByRegion`'s map — the same one the item stage reads. A region with no
 * entry sits over nothing (or cuts nothing), so it has no warning to raise.
 */
export function keepOutFindings(
  job: EngraveJob,
  regions: readonly CutRegion[],
  bound: ReadonlyMap<string, BindingVoid>,
): JobFinding[] {
  const findings: JobFinding[] = [];
  for (const region of regions) {
    const worst = bound.get(region.id);
    if (worst === undefined) continue;
    // A THROUGH cut over a void is a refusal, not a finish warning (#218): the cut leaves the
    // blank and breaks into the cavity, whose membrane is the only material holding the piece
    // that would be freed. The ordinary suppression below exists to hand a BREACH to the
    // verifier; a through cut over a void is refused here, before a program is posted.
    const through = region.through === true;
    if (!through && region.depth > worst.limit + DEPTH_EPS_MM) continue;

    const src = findItem(job, region.id);
    const cutout = region.cutout === true;
    const primitive = cutout || src !== undefined ? undefined : findPrimitive(job, region.id);
    const who = cutout
      ? `Cut-out "${region.name || region.id}"`
      : src
        ? itemLabel(src)
        : primitive
          ? primitiveLabel(primitive)
          : region.name || `Item ${region.id}`;
    findings.push({
      severity: through ? 'error' : 'warning',
      code: 'item-over-void',
      labelId: region.id,
      message: through
        ? `${who} cuts through the blank over "${worst.name}" — the ${fmtMm(worst.membrane)} mm ` +
          'membrane over the void is the only thing holding the piece, so the cut would break ' +
          'into the cavity and free it. Move the cut clear of the void, or do not cut it through.'
        : `${who} cuts ${fmtMm(region.depth)} mm deep over "${worst.name}" — a ` +
          `${fmtMm(worst.membrane)} mm membrane with nothing under it — so expect chatter and a ` +
          `rough finish there. Moving the cut clear of the void will finish better.`,
    });
  }
  return findings;
}

/**
 * The 3D primitive a measurement row names (#435). Cuttable primitives join `plan.engraves`, so a
 * row can name one; they are not `EngraveAnyItem`s, which is why this is a second lookup.
 */
function findPrimitive(job: EngraveJob, id: string): EngravePrimitive | undefined {
  return (job.primitives ?? []).find((p) => p.id === id);
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
    return `Engrave text "${item.text}" has nothing this cutter can reach: every stroke is thinner than ${cutter}.`;
  }
  if (item.kind === 'circle') {
    return `A ${item.diameter} mm hole cannot be cut with ${cutter}: it is smaller than the cutter.`;
  }
  return `${itemLabel(item)} has nothing this cutter can reach: it is smaller than ${cutter}.`;
}

/**
 * The sentence a broken bound makes (#345) — the ITEM, the PLANE and the SIDE, in that order.
 *
 * ONE builder for both bound kinds, so the split's two orders and a void's ceiling read alike and
 * neither can drift into wording the other never uses. The advice at the end is the one that
 * applies to that plane: a split has a control to flip ("set the label to reveal"), a void does
 * not — the cut has to move, or the blank has to change.
 */
function boundMessage(label: EngraveLabel, hit: BoundViolation): string {
  const { bound, margin } = hit;
  const cuts = `${itemLabel(label)} cuts to ${fmtMm(label.depth)} mm`;
  const at = fmtMm(bound.at);
  const m = fmtMm(margin);
  if (bound.side === 'above') {
    const deepest = fmtMm(bound.at - margin);
    const advice =
      bound.source === 'split'
        ? 'Cut shallower, or set the label to "reveal".'
        : 'Cut shallower, or move the cut clear of the void.';
    const subject = bound.source === 'split' ? 'a "surface" label must stay' : 'a floor must stay';
    return `${cuts} — ${bound.name} is at ${at} mm and ${subject} ${m} mm above it, so no deeper than ${deepest} mm. ${advice}`;
  }
  return (
    `${cuts} — ${bound.name} is at ${at} mm and a "reveal" label must go ${m} mm below it, ` +
    `so at least ${fmtMm(bound.at + margin)} mm. Cut deeper, or set the label to "surface".`
  );
}

/**
 * Items whose floor breaks a bound (#285, decision 20; #345).
 *
 * An item is judged against EVERY bound under its footprint (#345 decision B): the colour split,
 * chosen by its own `depthIntent` (`surface` puts the floor above the plane, `reveal` below it), and
 * the ceiling of any void it sits over. The stock's underside is deliberately NOT judged here — it
 * is filtered out below, because `depth-exceeds-stock` is its owner and one over-deep item must not
 * produce two errors saying the same thing.
 *
 * Why a void bound here at all, when the per-move verifier already refuses a breach: the verifier
 * names a MOVE ("a cutting move reaches Z=… at (x, y)"), which is the right sentence for CAM and the
 * wrong one for the person who typed a depth into a label. This stage names the ITEM, the plane and
 * the side, and it is the stage that knows the item's own intent — `cut-too-deep` stays the
 * per-move backstop with the same plane name.
 *
 * Why not a `cut-too-deep` limit: a `reveal` floor crossing the split is the entire point of a
 * two-colour blank, so a per-move limit that refused every move past the plane would refuse the job
 * it exists to cut. A `below` bound is not a ceiling, and only `checkBounds` knows the difference.
 *
 * A job whose blank states no split and holds no void has nothing to be wrong about, and an item
 * with no `depthIntent` — every item authored before #170's control — carries no split bound.
 * `custom` is the advanced override and says "I know; the number is the point", so it carries no
 * bound from the split by design.
 *
 * `splitDepth` is the split ON the printer's layer grid (`colourBoundaryFor`), which is where a
 * floor can actually be, not the nominal height the design asked for. `bound` is
 * `bindingVoidsByRegion`'s map, the same one `keepOutFindings` reads.
 */
export function itemDepthBoundFindings(
  job: EngraveJob,
  splitDepth: number | null,
  margin: number,
  bound: ReadonlyMap<string, BindingVoid> = new Map(),
): JobFinding[] {
  if (splitDepth === null && bound.size === 0) return [];
  const findings: JobFinding[] = [];
  for (const label of job.labels) {
    // A construction label cuts nothing, so it has no floor to place.
    if (!label.enabled || label.construction === true) continue;
    const over = bound.get(label.id);
    const bounds = boundsFor(
      job,
      label,
      {
        split: splitDepth,
        overVoid: over === undefined ? null : { name: over.name, breach: over.ceiling },
      },
      margin,
    );
    // The underside is out of this stage's hands before the check, not after it: `checkBounds`
    // returns the FIRST broken bound, and leaving the underside in would let a job that breaks both
    // it and nothing else read as a violation this stage then has to un-report.
    const owned = bounds.filter((b) => b.source !== 'underside');
    if (owned.length === 0) continue;
    const hit = checkBounds(label.depth, owned, margin);
    if (hit === null) continue;
    findings.push({
      severity: 'error',
      code: 'item-depth-bound',
      labelId: label.id,
      message: boundMessage(label, hit),
    });
  }
  return findings;
}
