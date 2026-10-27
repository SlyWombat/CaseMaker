import type { Mm, Vec3 } from '@/types/units';
import type { EngraveJob, Sacrificial, SacrificialSide, ViseParams } from '@/types/engraveJob';
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
 * The Z1 low-profile vise's PRODUCT constants (#448), as a sourced accessory record — the same
 * shape as {@link RotaryProfile}: one `sources` string per field, so a caliper reading and an
 * unmeasured provisional figure never wear the same provenance.
 *
 * The vise is identical on every Z1 (maintainer, 2026-10-13), so these are the product's own
 * numbers, measured once on the reference unit — the tier BELOW a machine's own saved
 * `fixtures.vise` (decision 28: default → saved → measured). The per-unit saved vise stays the
 * saved/measured tier; this record is the shipped default's source.
 *
 * MEASURED (`docs/bench/2026-10-bench-plan.md`, "Z1 low-profile vise: product constants"): the
 * soft-jaw top is 10 mm across on BOTH jaws (2026-10-13), the tall bar is 100 mm long in Y
 * (2026-10-15), and the ledges are 3.1 mm down / 1.9 mm in (2026-10-15). `bodyDepth` is the one
 * UNMEASURED figure (#208) — a provisional depth, never labelled a measurement.
 */
export interface ViseProfile {
  fixedJawThickness: Mm;
  movingJawThickness: Mm;
  jawLength: Mm;
  ledgeStep: Mm;
  ledgeWidth: Mm;
  bodyDepth: Mm;
  sources: {
    fixedJawThickness: string;
    movingJawThickness: string;
    jawLength: string;
    ledgeStep: string;
    ledgeWidth: string;
    bodyDepth: string;
  };
}

export const Z1_VISE: ViseProfile = {
  fixedJawThickness: 10,
  movingJawThickness: 10,
  jawLength: 100,
  ledgeStep: 3.1,
  ledgeWidth: 1.9,
  bodyDepth: 20,
  sources: {
    fixedJawThickness: 'calipered 2026-10-13 (docs/bench/2026-10-bench-plan.md, "Z1 low-profile vise: product constants")',
    movingJawThickness: 'calipered 2026-10-13 (docs/bench/2026-10-bench-plan.md, "Z1 low-profile vise: product constants")',
    jawLength: 'calipered 2026-10-15 (docs/bench/2026-10-bench-plan.md, "Z1 low-profile vise: product constants")',
    ledgeStep: 'calipered 2026-10-15 (docs/bench/2026-10-bench-plan.md, "Z1 low-profile vise: product constants")',
    ledgeWidth: 'calipered 2026-10-15 (docs/bench/2026-10-bench-plan.md, "Z1 low-profile vise: product constants")',
    bodyDepth: 'UNMEASURED (#208) — a provisional depth for "nothing can pass under it", not a measurement',
  },
};

/**
 * How far the ENVELOPE box extends below the stock's underside, mm — the accessory record's
 * UNMEASURED `bodyDepth` (#208, #448). It only has to be "far enough that nothing can pass under
 * it" (/Simulation.md §1.1: the holder-into-part check), so this is a generous depth, not a
 * measured body height. It also sizes the drawn body below the jaw bars (`viseBody`, #508).
 */
export const VISE_BODY_DEPTH = Z1_VISE.bodyDepth;

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
 * The LABELLED FALLBACK for the shop's `vise.uncertaintyMm` (#448): the band every collision box
 * is grown by (#204), mm, used with no house service. CHOSEN, not measured (#391 review, item 3):
 * nothing has calipered the spread of a remount. It has to cover clamping repeatability, the
 * blank's dome and a hand-set origin's error, and is deliberately the same for a saved measurement
 * — a reading does not make a remount repeatable. `defaultsClient.ts` reads this fallback for the
 * registry entry.
 */
export const VISE_UNCERTAINTY_FALLBACK: Mm = 0.5;

/**
 * Where a dimension came from is the whole point (decision 28), so the default uncertainty is a
 * function of the source, never a bare constant at the call site. Since #448 the band is the
 * shop's `vise.uncertaintyMm`, passed in; the jaws are calipered now (#208, 2026-10-13/15), so the
 * shipped default rests on readings too and both sources carry the same band — a chosen figure
 * rather than a reading (see {@link VISE_UNCERTAINTY_FALLBACK}). The function stays: a source that
 * is NOT a measurement would still need a band of its own.
 */
export function uncertaintyFor(source: ViseParams['source'], uncertaintyMm: Mm = VISE_UNCERTAINTY_FALLBACK): Mm {
  // The band no longer depends on `source` (#448): a shipped default and a saved/measured reading
  // carry the same chosen residual, so the caller's source stays only to keep the call sites honest.
  void source;
  return uncertaintyMm;
}

/**
 * The LABELLED FALLBACK for the shop's `vise.defaultStockProudMm` (#448): the working height a
 * normal blank stands proud of the jaw tops by default, mm — how much of the stock is out of the
 * jaws so the cutter can reach it. PROVISIONAL (#208 A5 measures the value a real vise wants);
 * this is the cap on the stock-derived default below, used with no house service. Since #508 it is
 * the placeholder `DEFAULT_VISE` carries for a caller that cannot say the stock — every stock-
 * carrying path derives the proud value from the seat instead.
 */
export const VISE_DEFAULT_STOCK_PROUD_FALLBACK: Mm = 4;

/**
 * The LABELLED FALLBACK for the shop's `vise.minCoverageFraction` (#448): the share of the stock's
 * width the jaws must cover in Y before `vise-jaw-short` warns. Chosen, not measured; used with no
 * house service.
 */
export const VISE_MIN_COVERAGE_FRACTION_FALLBACK = 0.5;

/**
 * The soft jaws' ledge: its top sits this far below the jaw top, mm — a caliper reading, not a
 * guess (#208, 2026-10-15, `docs/bench/2026-10-bench-plan.md`). A blank SEATED on the ledges
 * therefore stands `thickness − LEDGE_STEP` proud of the jaw tops, and the ledge, not the stock,
 * is what fixes that. Read from {@link Z1_VISE} (#448), where the provenance lives.
 */
export const LEDGE_STEP: Mm = Z1_VISE.ledgeStep;

/**
 * The soft jaws' ledge WIDTH: how far each ledge reaches in under the blank from its jaw face, mm —
 * calipered on 2026-10-15 (#208), with the step above. The blank's down face rests on
 * these two strips, so a cut there leaves it nothing to sit on (#428's `rests-on-cut`).
 * Read from {@link Z1_VISE} (#448), where the provenance lives.
 */
export const LEDGE_WIDTH: Mm = Z1_VISE.ledgeWidth;

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
export function defaultStockProud(
  thickness: Mm,
  seat: ViseParams['seat'] = 'ledge',
  defaultStockProudMm: Mm = VISE_DEFAULT_STOCK_PROUD_FALLBACK,
): Mm {
  if (seat === 'floor') return thickness - VISE_FLOOR_DEPTH;
  // The ledge seat, with the pre-#508 rule stated as its lower bound. `Math.min` contains
  // `thickness - LEDGE_STEP`, so the max can only ever return the seated value; the bound is kept
  // because it is the model's own statement of "never less proud than this", not because it can win.
  const lowerBound = Math.min(defaultStockProudMm, thickness / 2, thickness - LEDGE_STEP);
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
  stockProud: VISE_DEFAULT_STOCK_PROUD_FALLBACK, // Per-job, not a vise constant — `defaultStockProud` derives it from the stock and seat.
  seat: 'ledge', // #508: the blank sits on the soft jaws' ledges unless the operator says otherwise.
  fixedJawThickness: Z1_VISE.fixedJawThickness, // Calipered 2026-10-13: the soft-jaw top is 10 mm across (#208).
  movingJawThickness: Z1_VISE.movingJawThickness, // Calipered 2026-10-13: 10 on this jaw too — 9 was §11.8's band (#208).
  jawLength: Z1_VISE.jawLength, // Calipered 2026-10-15: the tall bar's length in Y (#208).
  jawStartY: -10, // NOT a vise constant (#208): where the blank is clamped along the 100 mm bar.
  source: 'default',
  uncertainty: VISE_UNCERTAINTY_FALLBACK,
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
 * The VISE numbers a reader can use for any job, including one held in the rotary chuck (#240).
 *
 * A vise job answers its own `workholding.vise`, exactly as before. A rotary job has no vise, and
 * the readers that still ask (the run sheet, the preview, the panel's technical fold) are slice 3's
 * to teach about the chuck — until then they get the SHIPPED default seated on the blank, which is
 * a labelled default and never a measurement. This is a compatibility answer, not a second stored
 * truth: nothing writes it back into the document.
 */
export function jobVise(job: Pick<EngraveJob, 'workholding' | 'stock'>): ViseParams {
  if (job.workholding.kind === 'vise') return job.workholding.vise;
  return seatedVise(DEFAULT_VISE, job.stock.thickness);
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
 * PROVISIONAL (#520): the vise rail's width across X, mm — how wide each base plate runs under its
 * jaw. The jaw sits at the rail's INNER edge and the row of screws runs along the exposed outer
 * half. Unmeasured; it joins #444's calipers list. Read from the 2026-10-18 photos.
 */
export const VISE_RAIL_WIDTH: Mm = 25;

/** PROVISIONAL (#520): the clamp screws on the moving rail — numbered 1..n in the photos. */
export const VISE_CLAMP_SCREWS = 3;

/** The vise's mounting screws — Makera's Low-Profile Vise page: "six M5×20 screws" (#717). */
export const VISE_MOUNT_SCREWS = 6;

/**
 * PROVISIONAL (#520): a screw head's drawn size, mm — a small square stand-in for the socket
 * heads in the photos. Unmeasured.
 */
export const VISE_SCREW_SIZE: Mm = 4;

/** PROVISIONAL (#520): how far the bed plate runs past the rails, mm. No bed model yet (#509/#510). */
export const VISE_BED_MARGIN: Mm = 25;

/** PROVISIONAL (#520): the bed plate's thickness, mm, and the coarse hole-grid pitch, mm. */
export const VISE_BED_THICKNESS: Mm = 10;
export const VISE_BED_HOLE_PITCH: Mm = 20;

/**
 * The machine Z of the blank's underside when the blank is seated in the Z1 low-profile vise —
 * the registration planner's AIM for the vise seat (#559): the `engrave-setup-seat-N` field's
 * default for the shipped Z1 vise, so `Plan registration` works with no hand-typed machine Z.
 * The probe still measures and writes the true surface (`probePlan.ts`), and the field stays an
 * operator's override for a non-standard setup.
 *
 * PROVISIONAL — ~25 mm above the bed (bed top −80) from the 2026-10-19 bench visual; to be
 * calipered (#444). The picture-only heights (VISE_BAR_HEIGHT 20 + VISE_BODY_DEPTH 20 +
 * VISE_BED_THICKNESS 10) over-estimate the real vise height and must NOT be composed here.
 */
export const VISE_SEAT_MACHINE_Z: Mm = -55;

/**
 * The vise as the preview DRAWS it, as it actually looks (#520): two stepped soft jaws — a 10 mm
 * land and a 1.9 mm ledge set 3.1 mm below the top (the #208 calipers) — two rails beneath them
 * (the PROVISIONAL 20 mm rail height), the screws the operator counts ("screw 2" is the moving
 * rail's second clamp), and a provisional bed plate with two rails and a coarse hole grid. The
 * slot between the jaws stays OPEN below the ledges, so a probe that lands on a miss reads as
 * landing in air, not on the vise.
 *
 * This is deliberately not `viseEnvelope`. The envelope is a conservative obstacle model — its
 * boxes run `VISE_BODY_DEPTH` below the stock's underside and its totals grow with stock
 * thickness — which is right for collision checks and wrong for a picture: drawn from the
 * envelope, a thicker blank made the jaws appear to grow with it.
 *
 * So the drawn geometry reads no stock thickness at all: `stock` is `{ length }`, and that is a
 * type-level promise, not a convention. What it does read is the measured jaw layout — widths,
 * `jawStartY`/`jawLength`, the `stockProud` seat, the sacrificial shift — plus the PROVISIONAL
 * rail and bed figures. The bars sit below the jaw tops (`-stockProud`), the ledges below them,
 * the rails beneath the bars, and the bed beneath the rails. The envelope is unchanged and stays
 * the thing the checks use.
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
  const railBottomZ = jawBottomZ - VISE_BODY_DEPTH;
  // The inner faces: the fixed jaw ends at the stock's left edge, the moving jaw starts at its
  // right edge, and the sacrificial shift moves each face by the strip/under-board it bears on.
  const fixedInnerX = 0 - shift.left;
  const movingInnerX = stock.length + shift.right;

  const boxes: ObstacleBox[] = [];

  // The two stepped soft jaws. Each is a 10 mm land bar plus a 1.9 mm ledge facing inward, its
  // top 3.1 mm below the jaw top. The ledge's top plane IS the blank's underside on the `ledge`
  // seat (`defaultStockProud` puts `-stockProud - LEDGE_STEP` at `-thickness`).
  boxes.push(
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
      id: 'vise-fixed-ledge',
      label: 'Vise fixed-jaw ledge',
      min: [fixedInnerX, jawMinY, jawTopZ - LEDGE_STEP - LEDGE_STEP],
      max: [fixedInnerX + LEDGE_WIDTH, jawMaxY, jawTopZ - LEDGE_STEP],
    },
    {
      id: 'vise-moving-ledge',
      label: 'Vise moving-jaw ledge',
      min: [movingInnerX - LEDGE_WIDTH, jawMinY, jawTopZ - LEDGE_STEP - LEDGE_STEP],
      max: [movingInnerX, jawMaxY, jawTopZ - LEDGE_STEP],
    },
  );

  // The two rails under the jaws, the PROVISIONAL 20 mm rail height, the full vise length. The
  // slot between them — under the blank, between the jaw faces — stays OPEN.
  boxes.push(
    {
      id: 'vise-fixed-rail',
      label: 'Vise fixed rail',
      min: [fixedInnerX - VISE_RAIL_WIDTH, jawMinY, railBottomZ],
      max: [fixedInnerX, jawMaxY, jawBottomZ],
    },
    {
      id: 'vise-moving-rail',
      label: 'Vise moving rail',
      min: [movingInnerX, jawMinY, railBottomZ],
      max: [movingInnerX + VISE_RAIL_WIDTH, jawMaxY, jawBottomZ],
    },
  );

  // The screws. Each is a small head sitting proud of its rail's top, on the exposed outer half
  // (the jaw covers the inner half). The moving rail's clamps are the numbered stations.
  const fixedScrewX = fixedInnerX - VISE_RAIL_WIDTH / 2;
  const movingScrewX = movingInnerX + VISE_RAIL_WIDTH / 2;
  const screwTop = jawBottomZ + VISE_SCREW_SIZE;
  for (let i = 0; i < VISE_MOUNT_SCREWS; i++) {
    const y = jawMinY + (vise.jawLength * (i + 1)) / (VISE_MOUNT_SCREWS + 1);
    boxes.push({
      id: `vise-fixed-screw-${i + 1}`,
      label: `Vise fixed-rail screw ${i + 1}`,
      min: [fixedScrewX - VISE_SCREW_SIZE / 2, y - VISE_SCREW_SIZE / 2, jawBottomZ],
      max: [fixedScrewX + VISE_SCREW_SIZE / 2, y + VISE_SCREW_SIZE / 2, screwTop],
    });
  }
  for (let i = 0; i < VISE_CLAMP_SCREWS; i++) {
    const y = jawMinY + (vise.jawLength * (i + 1)) / (VISE_CLAMP_SCREWS + 1);
    boxes.push({
      id: `vise-moving-clamp-${i + 1}`,
      label: `Vise clamp screw ${i + 1}`,
      min: [movingScrewX - VISE_SCREW_SIZE / 2, y - VISE_SCREW_SIZE / 2, jawBottomZ],
      max: [movingScrewX + VISE_SCREW_SIZE / 2, y + VISE_SCREW_SIZE / 2, screwTop],
    });
  }

  // A provisional bed: a plate under the vise, two rails running its length, and a coarse hole
  // grid, so a tall part and the head's chuck have something to judge clearance against. There is
  // no bed model yet (#509/#510) — these figures are context, not a machine reading.
  const bedMinX = fixedInnerX - VISE_RAIL_WIDTH - VISE_BED_MARGIN;
  const bedMaxX = movingInnerX + VISE_RAIL_WIDTH + VISE_BED_MARGIN;
  const bedMinY = jawMinY - VISE_BED_MARGIN;
  const bedMaxY = jawMaxY + VISE_BED_MARGIN;
  const bedRailBottom = railBottomZ - VISE_BED_THICKNESS - VISE_BED_THICKNESS;
  boxes.push(
    {
      id: 'vise-bed',
      label: 'Vise bed',
      min: [bedMinX, bedMinY, railBottomZ - VISE_BED_THICKNESS],
      max: [bedMaxX, bedMaxY, railBottomZ],
    },
    {
      id: 'vise-bed-rail-left',
      label: 'Bed rail (left)',
      min: [bedMinX, bedMinY, bedRailBottom],
      max: [bedMinX + VISE_BED_THICKNESS, bedMaxY, railBottomZ - VISE_BED_THICKNESS],
    },
    {
      id: 'vise-bed-rail-right',
      label: 'Bed rail (right)',
      min: [bedMaxX - VISE_BED_THICKNESS, bedMinY, bedRailBottom],
      max: [bedMaxX, bedMaxY, railBottomZ - VISE_BED_THICKNESS],
    },
  );
  for (let y = bedMinY + VISE_BED_HOLE_PITCH / 2; y < bedMaxY; y += VISE_BED_HOLE_PITCH) {
    for (let x = bedMinX + VISE_BED_HOLE_PITCH / 2; x < bedMaxX; x += VISE_BED_HOLE_PITCH) {
      boxes.push({
        id: `vise-bed-hole-${Math.round(x)}-${Math.round(y)}`,
        label: 'Bed hole',
        min: [x - 1.5, y - 1.5, railBottomZ],
        max: [x + 1.5, y + 1.5, railBottomZ + 0.5],
      });
    }
  }

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
  /** The shop's `vise.minCoverageFraction`; the labelled fallback when not passed (#448). */
  minCoverageFraction: number = VISE_MIN_COVERAGE_FRACTION_FALLBACK,
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
  if (covered < width * minCoverageFraction) {
    findings.push({
      severity: 'warning',
      code: 'vise-jaw-short',
      message:
        `The jaws span Y ${vise.jawStartY} to ${vise.jawStartY + vise.jawLength}, covering ` +
        `${covered} mm of the stock's ${width} mm width — less than the ${Math.round(minCoverageFraction * 100)} % the shop asks for.`,
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
      // once on the one the product was designed around, and this job's vise has not been measured
      // ITSELF. The sentence says which of the two it is in the operator's words (#690b): the
      // shipped set is a fact, and where it came from belongs in the Technical fold, not here.
      message:
        'Vise: the shipped dimensions, not measured on this machine.',
    });
  }

  return findings;
}

/** `2.6100000000000003` → `2.61`. Trailing zeros dropped, like every other printed figure. */
function fmtMm(n: number): string {
  return String(Number(n.toFixed(3)));
}
