import type { Mm, Vec3 } from '@/types/units';
import type { Sacrificial, SacrificialSide, ViseParams } from '@/types/engraveJob';
import type { FixtureEnvelope, ObstacleBox } from './setup';
import type { JobFinding } from './engrave/jobSetup';
import { hasSacrificial, noneSacrificial, stripHeight, viseJawShift } from './sacrificial';

/**
 * The fixture as an obstacle envelope (#203, decision 28, `/Simulation.md` §1.1).
 *
 * The part is HELD by the vise; what the tool must not HIT is the vise. Those are two
 * different things (decision 28): `Workholding` says *how* the part is held, this envelope
 * says *what is in the way* and belongs in `Setup.fixture`, not inside the `Workholding` union.
 *
 * The envelope is an INPUT with provenance — a shipped **default**, a **saved** measurement,
 * or a fresh **measurement** — never a catalogue lookup presented as truth. Every box is
 * grown by `uncertainty` before any collision check (#204), so a default can never be mistaken
 * for a measurement.
 *
 * V1 models the Z1 low-profile vise as exactly TWO boxes: the fixed jaw and the moving jaw.
 * The slot, the lip over the top edge, the screws and the body are deliberately NOT modelled
 * — #208 photographs and calipers the real vise, and refines the boxes only where a box is
 * shown to be wrong.
 *
 * THE LEDGE IS A NOTE, NOT A THIRD BOX (#208, decided 2026-10-15, with the calipers in hand).
 * Each soft jaw is an L: a 10 mm bar whose top is the jaw top, and a ledge 1.9 mm deep set 3.1 mm
 * below that top, facing inward, which the blank sits on. The ledge is the one unmodelled feature
 * that would carry material INSIDE the blank's own footprint (x 0…1.9 in from each jaw face), so
 * it was worth asking for. Three reasons it stays out:
 *   1. Its top plane IS the blank's underside — on a seated blank, `stockProud` + the 3.1 mm step =
 *      the blank's thickness — so a box whose top is that plane, grown by any `uncertainty` at all,
 *      would claim material *inside the blank* and refuse edge cuts that cut blank and nothing else.
 *   2. No verified program reaches it. Over the part a cut stops at `thickness − minFloor`
 *      (`verify.ts`), which is above the blank's underside, and the cutter column the sweep tests
 *      rises FROM the tool tip — so the column never reaches the ledge's plane, let alone below it.
 *      Only a `through` cut with `breakthrough` passes the underside at all, and nothing generates one.
 *   3. Nothing that asks "what is in the way" needs it. The probe plan tests the jaw FACES
 *      (`probePlan.ts` obstructionsOf), not the envelope, and the envelope's own Y span is the bar.
 * Revisit if a through-cut with breakthrough is ever generated (the cutter would then pass the
 * ledge's plane beside the blank's edge), or when a probe has to reach under the blank.
 *
 * The work frame is the job frame (`/Simulation.md` §2, `toSetup`): origin at the stock's
 * top-front-left corner, +X to the right along the jaws' clamping direction, +Y away from the
 * operator, Z = 0 on the stock's top face with cuts at negative Z.
 */

/**
 * How far the ENVELOPE box extends below the stock's underside, mm. It only has to be "far enough
 * that nothing can pass under it" (/Simulation.md §1.1: the holder-into-part check), so this is a
 * generous depth, not a measured body height.
 *
 * It also sizes the drawn body below the jaw bars (`viseBody`, #508), where it is a fixed height
 * rather than a distance from the stock. Both uses are the same unmeasured quantity — how tall the
 * body is — so they share the one PROVISIONAL figure rather than inventing a second.
 *
 * PROVISIONAL (#208): the real vise body is unmeasured.
 */
export const VISE_BODY_DEPTH = 20;

/**
 * The drawn soft-jaw bar's height, mm — PROVISIONAL, and it exists for the picture only (#508).
 *
 * The bar is calipered 10 mm ACROSS (#208, 2026-10-13); its height has never been measured. The
 * drawing needs one that does not change with the stock, and the envelope's `VISE_BODY_DEPTH` is
 * not it: that figure is a "nothing passes under it" distance below the stock, which is exactly
 * what made a thick blank look like it grew the jaws. So the drawn bar takes a fixed height,
 * chosen level with the body below it, and the jaw's source label says PROVISIONAL until the
 * bench calipers it — the same pending list as the body's height and footprint, the maximum
 * opening and the moving jaw's travel (#208/#444). Nothing checks the opening against a stock
 * yet: the number that would let it do so is on that list.
 */
export const VISE_BAR_HEIGHT: Mm = 20;

/**
 * How far the body's floor — the surface a tall part is clamped directly against, "against the
 * bottom of the jaws" on the Makera vise page — sits below the jaw tops, mm (#508). It is the
 * seat under the `floor` seat, where a blank's underside rests on the body rather than on the
 * ledges.
 *
 * PROVISIONAL (#508): the body's height has never been calipered. It is seeded level with the
 * drawn bar's bottom (the body's top), so a floor-seated blank rests exactly on the body with no
 * gap and no overlap, and it joins `VISE_BAR_HEIGHT` on #444's calipers list. A reading that
 * separates them moves this constant alone; nothing derives from the pair's equality.
 */
export const VISE_FLOOR_DEPTH: Mm = 20;

/** How far the blank's underside sits below the jaw tops for a seat, mm (#508). */
export function seatDepth(seat: ViseParams['seat']): Mm {
  return seat === 'floor' ? VISE_FLOOR_DEPTH : LEDGE_STEP;
}

/**
 * The minimum stock gripped below the jaw tops, mm, below which the part can lift — the LABELLED
 * FALLBACK only. The shop's own value is `setups.minGripMm` in `location.json` (the maintainer's
 * rule: thresholds live in our database, not compiled in); this is what `defaultsClient.ts`'s registry
 * falls back to with no house service, and `validateVise`'s default when its caller passes none. One
 * figure, one place — the setups planner and the vise check both read the shop default through it.
 *
 * PROVISIONAL (#208): a placeholder threshold; #208's measurements and test cuts replace it.
 */
export const GRIP_MIN = 3;

/**
 * Where a dimension came from is the whole point (decision 28), so the default uncertainty is
 * a function of the source, never a bare constant at the call site.
 *
 * The two bands were 2 and 0.5 while the jaw widths were only bounded by §11.8's probe bands — "a
 * default is not a measurement". The jaws are calipered now (#208, 2026-10-13/15), so the shipped
 * default rests on readings too and both sources carry the same band, which is a chosen figure
 * rather than a reading the way either of the old two was (see `DEFAULT_UNCERTAINTY`). The function
 * stays: a source that is NOT a measurement would still need a band of its own.
 */
export function uncertaintyFor(source: ViseParams['source']): Mm {
  return source === 'default' ? DEFAULT_UNCERTAINTY : SAVED_UNCERTAINTY;
}

/**
 * The band the SHIPPED default carries, mm. It was 2 while the jaws could have been anywhere in
 * §11.8's bands; both jaw widths and the bar's length are calipered now
 * (`docs/bench/2026-10-bench-plan.md`, "Z1 low-profile vise: product constants", 2026-10-13 and
 * 2026-10-15) and the maintainer's ruling is that the vise is identical on every Z1 — so what is
 * left is caliper and mounting error, the same residual a user's own saved measurement carries.
 *
 * The figure is CHOSEN, not measured (#391 review, item 3): nothing has calipered the spread of a
 * remount, and it is not the caliper's own resolution. It is the number that has to cover clamping
 * repeatability, the blank's dome and a hand-set origin's error, and it is deliberately the same
 * for a saved measurement for the same reason — a reading does not make a remount repeatable. What
 * it must NOT try to cover is any of those errors INDIVIDUALLY: the origin is the user's, and it
 * is named on the run sheet rather than absorbed here (#391 review, item 2).
 *
 * `source` stays `'default'`: this is the SHIPPED set, not a reading of anyone's own vise, and the
 * run sheet (`vise-default`) still says where it came from. What changed is that a cut near a jaw
 * face is now judged against a number someone measured rather than against a 2 mm cloud.
 */
const DEFAULT_UNCERTAINTY: Mm = 0.5;
/** A measurement still carries caliper/mounting error — the same figure, for the same reason. */
const SAVED_UNCERTAINTY: Mm = 0.5;

/**
 * The working height a normal blank stands proud of the jaw tops by default, mm: how much of
 * the stock is out of the jaws so the cutter can reach it. PROVISIONAL (#208 A5 measures the
 * value a real vise wants); this is the cap on the stock-derived default below.
 */
export const DEFAULT_STOCK_PROUD: Mm = 4;

/**
 * The soft jaws' ledge: its top sits this far below the jaw top, mm — a caliper reading, not a
 * guess (#208, 2026-10-15, `docs/bench/2026-10-bench-plan.md`). A blank SEATED on the ledges
 * therefore stands `thickness − LEDGE_STEP` proud of the jaw tops, and the ledge, not the stock,
 * is what fixes that.
 */
export const LEDGE_STEP: Mm = 3.1;

/**
 * The soft jaws' ledge WIDTH: how far each ledge reaches in under the blank from its jaw face, mm —
 * calipered on 2026-10-15 (#208), with the step above. The blank's down face rests on
 * these two strips, so a cut there leaves it nothing to sit on (#428's `rests-on-cut`).
 */
export const LEDGE_WIDTH: Mm = 1.9;

/**
 * How far a stock of `thickness` stands proud of the jaw tops by default, mm — the HONEST
 * default (#231 item 2, corrected by #508).
 *
 * `stockProud` is a job input (`ViseParams.stockProud`) and stays one; this is the value the
 * SHIPPED default vise carries — what a new job starts from, and what `viseAfterStockEdit`
 * re-derives whenever an edit restates the blank's thickness (#344), so a job saved while the two
 * disagreed does not stay stuck.
 *
 * #508 — THE SEAT DECIDES. The blank rests on something, and that fixes where its top is: its
 * underside is `seatDepth(seat)` below the jaw tops, so a `thickness`-thick blank stands
 * `thickness − seatDepth` proud. Until #508 the default was `min(4, t/2, t − LEDGE_STEP)`, which
 * treated 4 mm as a working height and capped the proud value there; that picture was wrong for a
 * blank thicker than 7.1 mm — the stock's underside cannot float between the jaws. The old rule is
 * kept below as the LOWER bound (it already contains `t − LEDGE_STEP`, so on the ledge the seated
 * value always wins):
 *
 *   - **`ledge`** (the shipped default) — the soft jaws' ledges are a hard stop, so the blank's
 *     underside IS the ledge plane, `LEDGE_STEP` below the jaw tops: proud = `t − 3.1`. On the
 *     default 12 mm blank that is 8.9 mm, where the old cap said 4; the 3.82 mm badge blank still
 *     gets 0.72 mm, the number the 2026-10-15 bench read 0.82–0.90 above. Taking the seated value
 *     puts the modelled jaw top at the HIGHEST the real one can be — the safe end, since the jaw
 *     box is grown by `uncertainty` from there;
 *   - **`floor`** — a taller part clamped directly against the bottom of the jaws rests on the
 *     body, `VISE_FLOOR_DEPTH` below the jaw tops: proud = `t − floorDepth`, and NEGATIVE is
 *     allowed (a 12 mm blank on the floor sits 8.8 mm below the jaw tops). That is the #488 case:
 *     the app states the plane the blank really sits on, and whether the job is cuttable is decided
 *     by where its cuts are (`vise-jaw-collision`), not by a proud value invented to keep it
 *     positive.
 *
 * A blank NO TALLER than the seat depth (#406) gets a value `≤ 0` on the ledge too. That is the
 * truth about it: seated on the ledges, its top is at or below the jaw tops. Since #488 that is a
 * NOTE rather than a refusal, for the same reason as the floor case.
 */
export function defaultStockProud(thickness: Mm, seat: ViseParams['seat'] = 'ledge'): Mm {
  if (seat === 'floor') return thickness - VISE_FLOOR_DEPTH;
  // The ledge seat, with the pre-#508 rule stated as its lower bound. `Math.min` contains
  // `thickness - LEDGE_STEP`, so the max can only ever return the seated value; the bound is kept
  // because it is the model's own statement of "never less proud than this", not because it can win.
  const lowerBound = Math.min(DEFAULT_STOCK_PROUD, thickness / 2, thickness - LEDGE_STEP);
  return Math.max(lowerBound, thickness - LEDGE_STEP);
}

/**
 * The shipped default `ViseParams` for the Z1 low-profile vise, for a job that has no saved
 * measurement. The vise is identical on every Z1 (maintainer, 2026-10-13), so these are the
 * product's own numbers — measured once on the reference unit, not per-user values. `source` stays
 * `'default'` because they are not a reading of anyone's OWN vise; `measuredAt` stays absent for
 * the same reason (it dates a reading, and this is a shipped set).
 *
 * MEASURED — the caliper table is the authority and this is a copy of it (#208, 2026-10-13 and
 * 2026-10-15, `docs/bench/2026-10-bench-plan.md` "Z1 low-profile vise: product constants"):
 * the soft-jaw top is 10 mm across on BOTH jaws, and the tall bar is 100 mm long in Y. Those two
 * widths had been 15 (#391's review: outside both of §11.8's probed bands, so the material-scan's
 * "a jaw's top is a SURFACE" reading would have looked like a fault), then 10.5 and 9 — the middle
 * of each band, still a guess. Both are now the number on the calipers. The bar's 100 mm is why a
 * `jaw-jaw-short` warning is harder to earn than it was at 80: Y coverage is judged against it
 * (`validateVise`), and `jawStartY` below decides where the bar sits relative to the stock.
 *
 * STILL PROVISIONAL (#208): `GRIP_MIN` and `VISE_BODY_DEPTH` at the top of this file — how high the
 * vise body stands and how much grip a part needs before it can lift are both unmeasured, and no
 * test cut has been run under the probe.
 *
 * `stockProud` here is a PLACEHOLDER, not a height: `DEFAULT_VISE` knows no stock, so the proud
 * value is derived per job from the seat (`defaultStockProud`, #508) — 8.9 mm on the 12 mm default
 * blank, 0.72 on the badge blank, 46.9 on a 50 mm cube seated on the ledge. Every creation path
 * derives it; the constant's own 4 mm is what a caller that cannot say the stock gets.
 *
 * NOTE (#203): this is the ONE place the shipped numbers live. `engrave/defaults.ts` imports
 * `DEFAULT_VISE` for a new job's vise, and `engraveJobStore` passes a saved `ViseParams` back in
 * through `defaultEngraveJob(vise)` when settings holds one.
 */
export const DEFAULT_VISE: ViseParams = {
  stockProud: DEFAULT_STOCK_PROUD, // Per-job, not a vise constant — `defaultStockProud` derives it from the stock and seat.
  seat: 'ledge', // #508: the blank sits on the soft jaws' ledges unless the operator says otherwise.
  fixedJawThickness: 10, // Calipered 2026-10-13: the soft-jaw top is 10 mm across (#208).
  movingJawThickness: 10, // Calipered 2026-10-13: 10 on this jaw too — 9 was §11.8's band (#208).
  jawLength: 100, // Calipered 2026-10-15: the tall bar's length in Y (#208).
  jawStartY: -10, // NOT a vise constant (#208): where the blank is clamped along the 100 mm bar.
  source: 'default',
  uncertainty: DEFAULT_UNCERTAINTY,
};

/**
 * The vise a NEW `EngraveJob` starts from: the saved `ViseParams` from settings when one
 * exists, otherwise the shipped default. This is the seam the panel (#205) resolves a new job
 * through, so a saved measurement is picked up without retyping it.
 *
 * A job on a non-default stock passes `stock` so the shipped default's `stockProud` is derived
 * from that stock (#231 item 2) instead of the flat 4 mm that refuses a blank at or under 4 mm.
 * A SAVED or measured vise is never re-derived — the user's number is kept exactly, even when it
 * would refuse the stock, so the panel can still show why. Omitting `stock` keeps the shipped
 * value, so every pre-#231 caller is unchanged.
 *
 * The returned object is a copy — the caller may patch it without mutating settings.
 */
export function viseForNewJob(
  saved?: ViseParams,
  stock?: { thickness: Mm },
): ViseParams {
  if (saved) return { ...saved };
  if (!stock) return { ...DEFAULT_VISE };
  return {
    ...DEFAULT_VISE,
    stockProud: defaultStockProud(stock.thickness, DEFAULT_VISE.seat),
  };
}

/**
 * A vise as SEATED on a stock, mm (#508): a shipped-default vise's `stockProud` is re-derived
 * from the seat (`defaultStockProud`), and a SAVED or MEASURED vise keeps the number its owner
 * recorded, exactly — even when the seat geometry disagrees, so the panel can still show why.
 *
 * This is the one rule every creation path applies (`newDefaultJob`, `viseAfterStockEdit`, the
 * setup flow's blank fix), so a default job can never carry the placeholder in `DEFAULT_VISE`.
 */
export function seatedVise(vise: ViseParams, thickness: Mm): ViseParams {
  if (vise.source !== 'default') return { ...vise };
  return { ...vise, stockProud: defaultStockProud(thickness, vise.seat) };
}

/**
 * The Z1 low-profile vise as two obstacle boxes, in the WORK frame, mm. Returned UN-INFLATED:
 * consumers grow each box by `envelope.uncertainty` before checking (decision 28).
 *
 * The fixed jaw is the LEFT jaw (/Fabrication.md §7.3), so it sits at work X <= 0 with its
 * face on x = 0; the moving jaw sits at work X >= length with its face on x = length. Both
 * jaws' TOPS are at `Z = -stockProud` — below the stock's top face by however much the stock
 * stands proud. In Y the jaws span `[jawStartY, jawStartY + jawLength]`.
 *
 * `sacrificial` moves the FACES outward (#213 §2): when the job has material between the jaw
 * and the part (`viseJawShift`), the fixed jaw's face moves from x = 0 to
 * `−max(left strip thickness, under.overhang.left)` and the moving jaw's from x = L to
 * `L + max(right strip thickness, under.overhang.right)`. The jaw BODY keeps its thickness, so
 * the whole box translates outward. Absent (or no material) is the pre-#213 envelope exactly:
 * faces on the part's own edges.
 */
export function viseEnvelope(
  stock: { length: Mm; width: Mm; thickness: Mm },
  vise: ViseParams,
  sacrificial: Sacrificial = noneSacrificial(),
): FixtureEnvelope {
  const { length, thickness } = stock;
  const jawMinY = vise.jawStartY;
  const jawMaxY = vise.jawStartY + vise.jawLength;
  const boxMinZ = -(thickness + VISE_BODY_DEPTH);
  const jawTopZ = -vise.stockProud;
  const shift = viseJawShift(sacrificial);
  const boxes: ObstacleBox[] = [
    {
      id: 'vise-fixed-jaw',
      label: 'Vise fixed jaw (left)',
      min: [-shift.left - vise.fixedJawThickness, jawMinY, boxMinZ],
      // `0 - shift.left`, not `-shift.left`: the latter is `-0` when there is no shift, and a
      // `-0` bound makes boxesOverlap's strict `<` comparisons and the tests disagree about zero.
      max: [0 - shift.left, jawMaxY, jawTopZ],
    },
    {
      id: 'vise-moving-jaw',
      label: 'Vise moving jaw (right)',
      min: [length + shift.right, jawMinY, boxMinZ],
      max: [length + shift.right + vise.movingJawThickness, jawMaxY, jawTopZ],
    },
  ];
  // `measuredAt` is copied through with the provenance: the envelope must be able to say WHEN it
  // was measured, not only that it was (#203).
  return { boxes, source: vise.source, uncertainty: vise.uncertainty, measuredAt: vise.measuredAt };
}

/**
 * The vise as the preview DRAWS it (#508): two jaw bars and the body beneath them, sized from the
 * constants the bench has calipered and from nothing else.
 *
 * This is deliberately not `viseEnvelope`. The envelope is a conservative obstacle model — its
 * boxes run `VISE_BODY_DEPTH` below the stock's underside and its totals grow with stock
 * thickness — which is right for collision checks and wrong for a picture: drawn from the
 * envelope, a thicker blank made the jaws appear to grow with it.
 *
 * So the drawn geometry reads no stock thickness at all: `stock` is `{ length }`, and that is a
 * type-level promise, not a convention. What it does read is the measured jaw layout — widths,
 * `jawStartY`/`jawLength`, the `stockProud` seat, the sacrificial shift — plus the PROVISIONAL
 * bar height. The bars sit below the jaw tops (`-stockProud`) and the body hangs beneath them,
 * spanning the opening. The envelope is unchanged and stays the thing the checks use.
 */
export function viseBody(
  stock: { length: Mm },
  vise: ViseParams,
  sacrificial: Sacrificial = noneSacrificial(),
): FixtureEnvelope {
  const jawMinY = vise.jawStartY;
  const jawMaxY = vise.jawStartY + vise.jawLength;
  const shift = viseJawShift(sacrificial);
  const jawTopZ = -vise.stockProud;
  const jawBottomZ = jawTopZ - VISE_BAR_HEIGHT;
  const bodyBottomZ = jawBottomZ - VISE_BODY_DEPTH;
  // The inner faces: the fixed jaw ends at the stock's left edge, the moving jaw starts at its
  // right edge, and the sacrificial shift moves each face by the strip/under-board it bears on.
  const fixedInnerX = 0 - shift.left;
  const movingInnerX = stock.length + shift.right;
  const boxes: ObstacleBox[] = [
    {
      id: 'vise-fixed-jaw',
      label: 'Vise fixed jaw (left)',
      min: [fixedInnerX - vise.fixedJawThickness, jawMinY, jawBottomZ],
      max: [fixedInnerX, jawMaxY, jawTopZ],
    },
    {
      id: 'vise-moving-jaw',
      label: 'Vise moving jaw (right)',
      min: [movingInnerX, jawMinY, jawBottomZ],
      max: [movingInnerX + vise.movingJawThickness, jawMaxY, jawTopZ],
    },
    {
      id: 'vise-body',
      label: 'Vise body',
      min: [fixedInnerX, jawMinY, bodyBottomZ],
      max: [movingInnerX, jawMaxY, jawBottomZ],
    },
  ];
  return { boxes, source: vise.source, uncertainty: vise.uncertainty, measuredAt: vise.measuredAt };
}

/**
 * The ISO date (`YYYY-MM-DD`) for `ViseParams.measuredAt` / `FixtureEnvelope.measuredAt`. Takes
 * `now` so it stays pure and testable; the stores pass the clock when a measurement is recorded
 * ("Save as my vise" / "I just measured these", #203).
 */
export function todayISODate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Grow every bound of a box by `by` mm on every side. Negative `by` shrinks it. */
export function inflate(box: ObstacleBox, by: Mm): ObstacleBox {
  return {
    ...box,
    min: [box.min[0] - by, box.min[1] - by, box.min[2] - by] as Vec3,
    max: [box.max[0] + by, box.max[1] + by, box.max[2] + by] as Vec3,
  };
}

/**
 * True when the two boxes' INTERIORS overlap on all three axes. Boxes that merely touch — one
 * bound equal on a single axis — do NOT overlap, so a jaw seated flush against the stock is
 * not a collision.
 */
export function boxesOverlap(a: ObstacleBox, b: ObstacleBox): boolean {
  return (
    a.min[0] < b.max[0] &&
    b.min[0] < a.max[0] &&
    a.min[1] < b.max[1] &&
    b.min[1] < a.max[1] &&
    a.min[2] < b.max[2] &&
    b.min[2] < a.max[2]
  );
}

/**
 * How much material each jaw actually bears on, mm (#213 §2). `vise-grip-shallow` judges the
 * grip on what is really clamped, not on the raw stock: a side strip between the jaw and the
 * part is what the jaw grips, and an under-board whose overhang carries the jaw face out past
 * the part is what it grips too. The jaw face sits on `−max(strip thickness, board overhang)`
 * (`viseJawShift`), so whichever of the two is thicker is the one bearing on the face.
 *
 * A jaw can only reach as high as its top — `thickness − stockProud` above the part's bottom —
 * so a strip taller than that is gripped to the jaw top only, and a shorter one over its whole
 * height. An under-board lies entirely below the part's underside, within the jaw's full height,
 * so it is gripped over its own thickness.
 */
function grippedHeights(
  stock: { thickness: Mm },
  vise: ViseParams,
  sacrificial: Sacrificial,
): { left: Mm; right: Mm } {
  // Clamped to the blank's own thickness (#406): a stock at or below the jaw tops (`stockProud <= 0`)
  // is gripped over its whole height, never MORE than that. Without the clamp a 2 mm blank seated
  // 1.1 mm below the jaw tops read as 3.1 mm gripped and the shallow-grip warning fell silent.
  const partGrip = Math.min(stock.thickness, stock.thickness - vise.stockProud);
  const side = (strip: SacrificialSide | null, overhang: Mm): Mm => {
    // The strip bears when it is at least as thick as the board's overhang, else the board edge.
    if (strip && strip.thickness >= overhang) {
      return Math.min(stripHeight(strip, stock.thickness), partGrip);
    }
    const under = sacrificial.under;
    if (under && overhang > 0) return under.thickness;
    return partGrip; // the jaw is against the part itself
  };
  return {
    left: side(sacrificial.sides.left, sacrificial.under?.overhang.left ?? 0),
    right: side(sacrificial.sides.right, sacrificial.under?.overhang.right ?? 0),
  };
}

/**
 * Pure checks on the vise as data, before any geometry (#203). Codes the findings with the
 * same `JobFinding` the job validators use, so a panel can render them together.
 *
 * The grip check (`vise-grip-shallow`) is judged on the sacrificial stack (#213 §2): pass the
 * job's `Sacrificial` and it evaluates what the jaws actually grip, not the raw stock. Omitting
 * it is exactly the pre-#213 check — a job with no sacrificial material is unchanged.
 */
export function validateVise(
  stock: { length: Mm; width: Mm; thickness: Mm },
  vise: ViseParams,
  sacrificial: Sacrificial = noneSacrificial(),
  /** The shop's `setups.minGripMm` (`shopDefault(…)`); the labelled fallback when not passed. */
  minGripMm: Mm = GRIP_MIN,
): JobFinding[] {
  const findings: JobFinding[] = [];
  const { width, thickness } = stock;

  // A blank at or below the jaw tops is NOT refused here (#488). Whether it can be cut depends on
  // where the cuts are, not on the blank's height: a job whose cuts keep clear of the jaw faces
  // works perfectly well below them. That rule needs the items, so it lives in `validateJob`
  // (`vise-jaw-collision` and the `vise-stock-not-proud` note), where the geometry is known.

  if (vise.stockProud >= thickness) {
    findings.push({
      severity: 'error',
      code: 'vise-stock-proud-exceeds-thickness',
      message:
        `The stock stands ${vise.stockProud} mm above the jaw tops on a ${thickness} mm stock ` +
        `— nothing is left in the jaws.`,
    });
  }

  // What the jaws grip: the weaker of the two jaws, the side that lets go first.
  const gripped = grippedHeights(stock, vise, sacrificial);
  const grip = Math.min(gripped.left, gripped.right);
  if (grip < minGripMm) {
    const what = hasSacrificial(sacrificial) ? 'the material between the jaws' : 'the stock';
    findings.push({
      severity: 'warning',
      code: 'vise-grip-shallow',
      // The number is printed, so it is printed the way every other figure is (#394 review): a
      // float subtraction of two stated millimetres came out as `2.6100000000000003` on the badge
      // blank, in the run sheet's own warnings section.
      message:
        `Only ${fmtMm(grip)} mm of ${what} is gripped below the jaw tops; under ${minGripMm} mm ` +
        `the part can lift (a provisional threshold).`,
    });
  }

  // The jaw's Y span, intersected with the stock's own Y range [0, width].
  const covered = Math.max(
    0,
    Math.min(vise.jawStartY + vise.jawLength, width) - Math.max(vise.jawStartY, 0),
  );
  if (covered < width / 2) {
    findings.push({
      severity: 'warning',
      code: 'vise-jaw-short',
      message:
        `The jaws span Y ${vise.jawStartY} to ${vise.jawStartY + vise.jawLength}, covering ` +
        `${covered} mm of the stock's ${width} mm width — less than half.`,
    });
  }

  // #508 — the seat is where the blank's underside really is. It is a FACT about the setup, not a
  // fault in it, so it is `info`: the picture is only readable if the app says what it drew.
  const depth = seatDepth(vise.seat);
  const seatWords =
    vise.seat === 'floor'
      ? `the body floor, ${fmtMm(depth)} mm below the jaw tops (a provisional depth)`
      : `the soft jaws' ledge, ${fmtMm(depth)} mm below the jaw tops`;
  findings.push({
    severity: 'info',
    code: 'vise-seat',
    message:
      `The job seats the blank on ${seatWords}. It states the ${fmtMm(thickness)} mm blank ` +
      (vise.stockProud >= 0
        ? `stands ${fmtMm(vise.stockProud)} mm proud of the jaw tops.`
        : `sits ${fmtMm(-vise.stockProud)} mm below them.`),
  });

  if (vise.source === 'default') {
    findings.push({
      severity: 'warning',
      code: 'vise-default',
      // Still a warning now that the jaws are calipered: the numbers are the product's, measured
      // once on the reference unit, and this job's vise has not been measured ITSELF. The sentence
      // says which of the two it is, because "unmeasured defaults" stopped being true on 2026-10-15.
      message:
        'Vise dimensions are the shipped defaults, measured once on the reference unit; ' +
        'they are not a measurement of this machine\'s own vise.',
    });
  }

  return findings;
}

/** `2.6100000000000003` → `2.61`. Trailing zeros dropped, like every other printed figure. */
function fmtMm(n: number): string {
  return String(Number(n.toFixed(3)));
}
