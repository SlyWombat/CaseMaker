import { profileReachFrom, rectProfile } from '@/engine/compiler/profile';
import { placedSize } from '@/engine/cnc/engrave/targetScale';
import type { MillProfile } from '@/engine/cnc/machine';
import { getTools, NO_TOOL_KEY, toolForJob } from '@/engine/cnc/toolRegistry';
import {
  cuttingDiameter,
  cuttingForTrace,
  cuttingRadiusForSweep,
  drillPointAngle,
  pointLength,
  traceRadiusAt,
  DRILL_POINT_FALLBACK_DEG,
  type Tool,
} from '@/engine/cnc/tool';
import { jobVise, viseEnvelope } from '@/engine/cnc/fixture';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { blankDepthCeiling } from '@/engine/cnc/engrave/depthBounds';
import { validateSacrificial, viseJawShift } from '@/engine/cnc/sacrificial';
import { stubSetup, type FixtureEnvelope, type Setup, type Workholding } from '@/engine/cnc/setup';
import {
  chamferOperationName,
  cutoutOperationName,
  drillHoles,
  drillOperationName,
  flatStockOutline,
  itemOperationName,
  itemProfile,
  jawGapFor,
  polygonSelfIntersects,
  primitiveLabel,
  primitiveOperationName,
  primitiveReducesToRegion,
  resolveItems,
  sweptCuts,
  threadOperationName,
  traceOperationName,
  traceSelfOverlapFindings,
  type SweptCut,
} from '@/engine/cnc/engrave/partPlan';
import { FASTENERS } from '@/engine/compiler/fasteners';
import { vCone, vFluteLength } from '@/engine/cnc/vProfile';
import { inlayGlueGap, inlayMarked, inlayNumbers } from './inlay';
import { textureNumbers, textureStrokes } from './texture';
import { fluteNumbers, fluteOperationName } from './flute';
import { prismHeightRefusal, prismNumbers } from './prism';
import { reliefNumbers } from '@/engine/cnc/cam/relief';
import { bracketSettings, defaultClampPlacements, validateBracketMount, type ClampPlacement, type StockSize } from '@/engine/cnc/mounts/bracket';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type {
  BracketHold,
  EngraveAnyItem,
  EngraveChamfer,
  EngraveCutout,
  EngraveDrill,
  EngraveJob,
  EngraveKeepOut,
  EngraveShape,
  EngravePrimitive,
  EngraveTargetObject,
  EngraveThread,
  EngraveTraceItem,
  JobSetup,
  TapeHold,
  TextureMark,
} from '@/types/engraveJob';
import type { Mount, MountSpec, Orientation } from '@/engine/cnc/setups/types';

/**
 * The two pure derivations that turn an `EngraveJob` into the emulator's inputs (#200).
 *
 * The job frame IS the work frame: origin at the stock's top-front-left, +X to the right
 * along the jaws' clamping direction, +Y away from the operator, Z = 0 on the top face and
 * cuts at negative Z. `stubSetup` already builds exactly that (`topFrontLeft`), so the
 * placement here is the machine-aware stub and nothing more.
 */

export type JobFindingCode =
  | 'depth-exceeds-stock'
  | 'no-items'
  | 'tool-missing'
  // #740 — a POINTED cutter whose tip the record does not state. A V-bit's tip is the width that
  // reaches the design; for a chamfer and an engraver `diameter` is the shank, so there is no honest
  // geometry sentence to write about the item. Raised where the plane model would otherwise judge
  // it (`item-empty`, `vcarve-groove-too-narrow`), asking for the field instead.
  | 'tool-tip-unrecorded'
  // #740 — the tip is unrecorded and the job's variable-depth, inlay or prism items cut with the
  // cone, so the plan assumes a SHARP POINT. A warning, not the error above: those items are not
  // judged at a colour plane, and the carve proceeds with the assumption stated.
  | 'tool-tip-assumed-point'
  | 'vise-jaw-collision'
  | 'vise-default'
  | 'vise-stock-not-proud'
  | 'vise-stock-proud-exceeds-thickness'
  | 'vise-grip-shallow'
  | 'vise-jaw-short'
  // Which seat the blank rests on and the proud it gives (#508) — information, never a fault.
  | 'vise-seat'
  // Sacrificial material (#213): validated by `validateSacrificial`, raised through `validateJob`.
  | 'side-strip-unsupported'
  | 'strip-taller-than-part'
  | 'under-too-thin'
  | 'under-loose'
  | 'sacrificial-default'
  // Shape-specific (#214): a polygon that crosses itself is not a region.
  | 'polygon-self-intersecting'
  // Combined shapes (#215): a reference that is missing, disabled, self or cyclic.
  | 'item-reference'
  // Geometry-dependent findings: computed by the worker (#201), not `validateJob` — they
  // need the tool-opened region, which only exists once a CrossSection is evaluated. They
  // were `label-*`; #214 renamed them `item-*` (a shape is an item too) with the old names
  // kept as aliases in the user guide for one release.
  | 'item-empty'
  | 'item-chars-lost'
  | 'item-detail-lost'
  | 'item-outside-stock'
  // Raised text (#739): a cutaway leaves construction labels standing, and at the cutter's own
  // radius the field's opening no longer separates them — letters bridge, or a counter fills.
  // A warning, measured from the same `engravableProfile` opening the CAM cuts, and expressed
  // as the measured gap plus the cutter or cap height that clears it.
  | 'raised-text-fused'
  // A cut off the round FACE of a disc or a rod (#683). The job plans in the square around the
  // round stock, and that square's corners are air: a cut whose extent reaches one passes over
  // nothing, or into the jaw zone the square says is stock. The face is the inscribed circle of
  // ⌀D, less the job's edge margin, and every corner of the cut's swept box must be inside it.
  | 'item-off-round-stock'
  // V-CARVE region findings (#221). The design is correct at the COLOUR PLANE, so the two
  // disqualifying facts are about that plane: a cut that stops above it never reaches the second
  // colour, and a groove at it narrower than the machine's own X/Y step cannot be resolved into
  // two walls. Both are errors and both name the way out.
  | 'vcarve-above-colour-plane'
  | 'vcarve-groove-too-narrow'
  // A machine whose controller configuration has never been read has no steps-per-mm to judge a
  // groove against (#773): the check cannot be made, and the warning says which machine and what
  // one connection supplies. The Carvera Air's shipped user settings carry rates but not steps.
  | 'machine-steps-unread'
  // The design check from the brief: two surface openings that overlap merge at the top face and
  // leave a ridge of the top colour below. A warning — the merged look is the operator's to
  // accept — raised with the geometry in hand (engraveGenerate's `vCarveFindings`).
  | 'vcarve-surface-merge'
  // The step-over the feeds row asked for, cut down to the pitch the FLOOR allows (#221 slice D).
  // A warning with note wording: nothing is wrong with the job, but the number the operator sees
  // must be the one the CAM runs. The seed still states the request; this says when the tip
  // radius, not the seed, set the pitch.
  | 'vcarve-stepover-clamped'
  // #741 — A V-CARVE DEEPER THAN ITS CUTTER'S CONE. A V-bit is a cone only up to the height where
  // its flank meets its cylindrical body — (diameter − tip) / (2·tan halfAngle), 1.5375 mm for the
  // bench's 3.175 mm 90° chamfer. Deeper than that the BODY cuts a vertical wall, so the pocket is
  // no longer a V (and an inlay's plug cannot seat in it). Refused rather than capped: the depth is
  // the design, and a silent cap would change the part and desynchronise an inlay pair. The number
  // and the sentence come from one owner, `vDepthLimit` / `vDepthRefusal` in `vProfile.ts`, which
  // the CAM's own guard reads too.
  | 'vcarve-depth-beyond-cone'
  // #741 review — A SINGLE-STROKE V TRACE PAST THE CONE (warning) OR PAST THE STATED FLUTE
  // (error). A trace's depth is the design, so above the cone the bit's body rubs the groove but
  // the trace is still planned; past the flute there is no cutting edge at all, so it is refused.
  // Both sentences come from the same `vDepthLimit` owner in `vProfile.ts`.
  | 'vcarve-trace-beyond-cone'
  | 'vcarve-trace-beyond-flute'
  // A cutter Makera NAMES for metal, on a job cutting something that is not (#405). The line is a
  // property of the pair — the bit and the blank — so it cannot live on either side alone, and no
  // feed table can enforce it: a metal bit will happily cut PLA, badly, at numbers nobody measured.
  // A warning, not an error: the cut is the user's to make, but they are told what the box says the
  // bit is for.
  | 'tool-metal-line'
  // Under-surface voids (#171, built on #231's keep-outs). The warning for cutting over a
  // membrane that spans an unsupported void: a fact about OVERLAP, not depth — the material has
  // nothing under it however shallow the cut. There is deliberately no error twin here: a cut
  // deep enough to breach is `cut-too-deep`, raised by the verifier against the layer-aligned
  // limit, and a second limit computed at this stage would be a second owner of that number.
  | 'item-over-void'
  // A depth bound an item stated for itself (#345, superseding #285's `item-wrong-colour`): the
  // colour split, whose plane and side come from the item's own `depthIntent`. It is NOT a depth
  // limit — a `reveal` floor below the split is correct by design, which is why a `below` bound can
  // only be checked per item against the intent that put it there, never as a `cut-too-deep` limit
  // in `verify.ts`. The bounds a BLANK states (a void's ceiling, the stock's underside) keep the
  // owners named above: `cut-too-deep` and `depth-exceeds-stock`.
  | 'item-depth-bound'
  // Single-line traces (#219). `trace-self-overlap` is raised here; `trace-outside-stock` needs
  // the swept region intersected with the stock, which only the worker evaluates (#201). Both
  // are part of `TraceFindingCode` in `partPlan.ts`, where the geometry that detects them lives.
  | 'trace-self-overlap'
  | 'trace-outside-stock'
  // Plunge drills (#220). All four are checks on the job as data plus the resolved tool.
  | 'drill-outside-stock'
  | 'plunge-unproven'
  | 'drill-too-deep'
  // Bores to size (#668). A bore is a hole cut by an end mill helixing down its wall, so it has
  // three data-plus-tool checks of its own: a hole wider than the cutter (`bore-narrow`), a flat
  // end mill to cut it with (`bore-needs-end-mill`), and a stated hole diameter (`bore-no-diameter`).
  | 'bore-narrow'
  | 'bore-needs-end-mill'
  | 'bore-no-diameter'
  // Chamfers (#669). A bevel on a profile's edge or a pocket's rim is the cone's flank, so it has
  // four data-plus-tool checks: a cone cutter (`chamfer-needs-cone`), a rim to cut
  // (`chamfer-needs-edge`), a width the cone reaches (`chamfer-too-wide`) and a tip that clears
  // the floor (`chamfer-too-deep`); `chamfer-reach-unproven` is the cutter that states no diameter.
  | 'chamfer-needs-cone'
  | 'chamfer-needs-edge'
  | 'chamfer-too-wide'
  | 'chamfer-too-deep'
  | 'chamfer-reach-unproven'
  | 'chamfer-order'
  // Advanced V-carve (#665). A region can ask for the MEDIAL-AXIS depth map; only a cone can cut
  // it, because the depth follows the flank's width at every point.
  | 'vcarve-variable-needs-cone'
  // `vcarve-variable-core` is the opposite note: the carve is sound, and the middle is the flat
  // cutter's — a warning that names the area to pocket.
  | 'vcarve-variable-core'
  // V-carve inlays (#673). A half of an inlay is the cone's flank by definition
  // (`inlay-needs-cone`), its glue gap must derive into a real plug (`inlay-gap`), and its pocket
  // is the PLANE V's — a variable-depth region has no matching plug (`inlay-plane-depth`).
  | 'inlay-needs-cone'
  | 'inlay-gap'
  | 'inlay-plane-depth'
  // Surface textures (#670). A texture is a pattern of stroke TRACES over one simple region:
  // `texture-shape` is the region kind that cannot hold one (a profile with holes, or a half that
  // is also an inlay), `texture-through` the surface finish that is not a cut-through,
  // `texture-tool` the cutter the trace path refuses by name, and the two warnings say the
  // pattern came out empty or was capped (`texture-empty`, `texture-crowded`).
  | 'texture-shape'
  | 'texture-through'
  | 'texture-tool'
  | 'texture-empty'
  | 'texture-crowded'
  // Flutes and prisms (#674). `flute-tool` is the cutter the trace path refuses; `flute-short` a
  // path whose two ramps overlap, so the groove never reaches the stated depth. A prism's five are
  // the cone its sides need (`prism-needs-cone`), a height past what that cone's flank reaches
  // (`prism-height`, #741 review), the tip flat its base is cleared by (`prism-tip`), a base
  // narrower than that flat twice (`prism-base`), and a shape that cannot carry one (`prism-shape`).
  | 'flute-tool'
  | 'flute-short'
  | 'prism-needs-cone'
  | 'prism-height'
  | 'prism-tip'
  | 'prism-base'
  | 'prism-shape'
  // Through-cuts and cut-outs (#218). `through-needs-board`: no under-board, or one thinner than
  // the breakthrough plus a millimetre. `through-tool-reach`: the cutter's flutes/shank do not
  // cover `thickness + breakthrough`. `tab-unplaceable`, `cutout-empty` and `loose-piece` are
  // raised by the CAM checks that have the path geometry (`tab-unplaceable`, `cutout-empty`) and
  // the removal solid (`loose-piece`).
  | 'through-needs-board'
  | 'through-tool-reach'
  | 'tab-unplaceable'
  | 'cutout-empty'
  | 'cutout-needs-flat'
  | 'loose-piece'
  | 'released-onto-board'
  // #711 — the tape hold rule on a bed job (#707 BM-4): the tape under the STOCK, the tape under a
  // PIECE a through cut frees, and the note for a block taller than its narrowest width.
  | 'tape-hold-stock'
  | 'tape-hold-piece'
  | 'tape-tall-stock'
  // #712 — the bed's own through rules (#707 BM-5): the board must cover the stock, and a cut may
  // enter the wasteboard only to the shop's depth limit.
  | 'board-too-small'
  | 'wasteboard-depth'
  // #725 W12/#727 F6 — the bracket's own clamps: two on top of each other, or one hanging past the
  // edge of the stock (it would not hold). Both are the Holding step's own checks, raised here too
  // so the document gate and the step cannot disagree, and Generate refuses before a path exists.
  | 'clamps-overlap'
  | 'clamp-off-stock'
  // #434 — a drill bit is the cutter of a DRILL-ONLY program. Hand-edited work that pairs one with
  // a region, trace or thread is refused by name: a drill cannot open a region, and one program has
  // one tool, so the other work has to move to a cutter that can make it.
  | 'drill-mixed-tools'
  // Milled threads (#445, #434 phase 2). The same shape of data-plus-tool checks as the drills,
  // with the tool's own fit against the ISO thread added.
  | 'thread-wrong-tool'
  | 'thread-mixed-tools'
  | 'thread-cutter-fit'
  | 'thread-off-stock'
  | 'thread-too-deep'
  | 'thread-through-unavailable'
  | 'thread-pilot-unproven'
  | 'thread-flute-unproven'
  // 3D primitives (#435). A primitive is cut only where it reduces to a flat-floor region; the
  // other forms are refused BY NAME rather than approximated. Each sentence names the engine or
  // issue that can cut the shape, so the refusal is an instruction, not a dead end.
  | 'primitive-not-vertical'
  | 'primitive-cone-needs-cam'
  | 'primitive-sphere-needs-3d'
  // The reference object is never cut (#435): it is what the pockets are FOR. `stock − target` is
  // the profile cut-out work tracked in #218, so this is a warning, not an error.
  | 'target-object-not-cut'
  | 'target-mesh-missing'
  | 'target-mesh-loading'
  | 'target-mesh-unstored'
  // A GOAL object (#533): the embedded mesh IS the shape to make, so it is not warned as uncut.
  // `goal-object-oversize` is the sane-size check — the goal's footprint or depth exceeds the
  // blank it would be carved from, so no toolpath could reproduce it from this stock (an error).
  // `goal-object-no-toolpath` is an INFO note that the goal is a recognised input but 3D toolpath
  // generation (slice D, #534) is not built yet, so this job posts no cut for it — the goal's
  // counterpart to the reference's `target-object-not-cut`, answering "why is my goal not cut?".
  | 'goal-object-oversize'
  // #785 — a goal deeper than the chosen cutter's known reach: the holder would enter the part.
  // `goal-reach-unrecorded` is the INFO that stands in its place when no reach is recorded at all
  // (a stated assumption, never a block), and `goal-cut-top-band` the WARNING of the operator's
  // chosen depth-limited cut (the goal's top band; the rest is left in the stock).
  | 'goal-reach-short'
  | 'goal-reach-unrecorded'
  | 'goal-cut-top-band'
  // #785 — the goal's program would exceed the app's stated move budget: refused BY NAME with the
  // numbers and the fixes (a coarser grid, a bigger step-down, or two setups), never by dying.
  | 'goal-program-too-big'
  | 'goal-mold-rim'
  | 'goal-mold-floor'
  | 'goal-mold-one-sided'
  | 'goal-mold-no-draft'
  | 'goal-finish-finer-than-grid'
  | 'goal-object-no-toolpath'
  // Facing (#432). The job's facing depth is taken off the same blank every item is measured
  // against, so the check is one number against the stock's minimum floor — not a per-item one.
  // An item over-deep once the skim is counted is still `depth-exceeds-stock`, whose own check
  // measures from the faced surface.
  | 'facing-too-deep'
  // #473 — a material facingRefusal refuses is never faced (#474/#493). The worker refuses a job
  // that still carries the pass before any program is posted, because the engraving file's Z0 is
  // the faced top. `facing-plastic` is the class: every non-wood, non-metal material.
  | 'facing-plastic'
  // Programs (#419 J3, #472). One program is one setup cut with ONE cutter; a setup that names
  // none has nothing to post. A setup naming several states its per-cutter item assignment in
  // `toolItems`; without one, the first cutter owns every item and the later cutters are rest
  // passes. These four codes are the assignment's own checks — a missing item, one claimed twice,
  // a cutter (or item) the setup does not name, and a first cutter with nothing to clear.
  | 'setup-no-tool'
  | 'setup-items-unassigned'
  | 'setup-items-duplicated'
  | 'setup-tool-unknown'
  | 'setup-tool-no-items'
  // #472 — the rest pass itself. `unavailable` is an error: the first programme could not be
  // simulated, the named cutter is not on the bench, or a V-bit was named as a flat rest cutter, so
  // no honest second file can be written. `nothing` is a warning: the finer cutter is real and
  // measured, but the first programme already removed everything it can open.
  | 'setup-rest-unavailable'
  | 'setup-rest-nothing'
  // #765 — a V-bit rest was checked from the blank (the column engine cannot seed a rest pass).
  // Info: the rest geometry WAS measured against the first program's removal.
  | 'rest-swept-from-blank'
  // #649 — the fitted surface lifts the blank more than the nominal hop, so every rapid in this
  // program runs higher than usual. A warning: the program is safe (the hop was raised for it), but
  // the operator may prefer to level the top with G32 and keep the nominal clearance.
  | 'surface-hop-raised'
  // Rotary (#240 slice 2). `axis-crossing` — an engrave whose depth reaches or passes the stock's
  // radius, so the floor would be at or below the axis; the message is the design's "cuts through
  // the centre" (rotary-flow.md §4). `rotary-unsupported` — the document carries a cut class the
  // wrap does not cut yet (cut-outs, traces, drills, threads, chamfers, facing, through regions,
  // inlays, prisms, voids), refused BY NAME with the action that clears it. `wrap-into-clamp` —
  // an item's opened region reaches into the jaws' or the tailstock's band (the verifier raises
  // the same code against the moves). `wrap-off-free-end` — it reaches past the stick-out with
  // the tailstock out, where the map ends and there is no stock (#724). Codes are data: the
  // operator sentence never carries one.
  | 'axis-crossing'
  // #723 — a rotary GOAL's own envelope check: the part is wider than the rod it would be turned from.
  | 'goal-rotary-oversize'
  | 'rotary-unsupported'
  | 'wrap-into-clamp'
  | 'wrap-off-free-end'
  // #737 — the neck for parting's refusals. `neck-thin` — below the material-and-overhang minimum;
  // `neck-in-band` — it does not fit the free span, so it would run into the jaws or the tailstock;
  // `neck-cuts-item` — a design item's opened region overlaps the neck's span, so the cut would
  // erase it; `neck-wider-than-part` — no narrower than the stock, so there is nothing to cut;
  // `neck-too-short` — less than a saw kerf plus clearance either side; `neck-too-narrow-for-cutter`
  // — the neck is no longer than the last cutter is wide, so the cut pockets the neck away instead
  // of leaving a floor; `neck-not-cut` — no posted program carries the neck (the run's cutter cannot
  // leave a flat-bottomed band, or the program that would cut it was not posted);
  // `neck-jaw-clearance` (warning) — the fixture beside the neck (the jaws for a chuck-side neck,
  // the tailstock for a tailstock-side one) is not modelled as a solid, so the operator must
  // air-cut it first.
  | 'neck-thin'
  | 'neck-in-band'
  | 'neck-cuts-item'
  | 'neck-wider-than-part'
  | 'neck-too-short'
  | 'neck-too-narrow-for-cutter'
  | 'neck-jaw-clearance'
  | 'neck-not-cut'
  // #666 — THE ADAPTIVE-CLEARING STRATEGY a metal pocket is cut with (see `cam/adaptive.ts`).
  // `adaptive-clearing` (info) states the plan the file was cut from — engagement, levels, entry,
  // feed owner — in the plan's own words. `adaptive-fallback` (warning) says the planner declined a
  // pocket and it was cut with contour-parallel rings instead: the job still cuts, exactly as every
  // metal pocket did before #666. `adaptive-helix-refused` (info) is the planner's ramp-instead-of-
  // helix note, carried onto the job so the panel shows it.
  | 'adaptive-clearing'
  | 'adaptive-fallback'
  | 'adaptive-helix-refused';

export interface JobFinding {
  /**
   * `info` states a fact the panel should show but that blocks nothing — the seat a blank rests
   * on is one (#508): it is a mechanism, not a fault in the job.
   */
  severity: 'error' | 'warning' | 'info';
  code: JobFindingCode;
  /** The item (label or shape) a finding points at, when it is about one item. */
  labelId?: string;
  /**
   * #785 — the GOAL target object a finding is about, when it is about one. The reach findings name
   * it so the panel's one-click top-band option patches the goal the sentence is about.
   */
  targetId?: string;
  /**
   * #785 — on `goal-reach-short`, the safe top-band depth that the one-click option would cut (the
   * cutter's reach less {@link GOAL_BAND_CLEARANCE_MM}, from `engrave/goalReach.ts`), mm. The
   * panel's button names the number; absent when the band would be zero.
   */
  goalBandMm?: number;
  message: string;
}

/**
 * What the machine's bed carries under the stock, for the through-cut gate (#712, design
 * `bed-mounts-flow.md` §3.5). Built on the caller's side — the active bed profile lives in the
 * location, which the engine does not read — and ABSENT for a caller with no location, in which
 * case every through sentence reads exactly as it did before.
 */
export interface BedUnderFacts {
  /** The surface the active profile records under the stock. */
  surface: 'bare-bed' | 'wasteboard' | 'fixture-plate' | 'vacuum-bed';
  /** The wasteboard's thickness, mm, when the surface IS the wasteboard; null otherwise. */
  wasteboardMm: number | null;
  /** How deep a cut may go into the wasteboard, mm — the shop's `wasteboard.depthLimitMm`. */
  wasteboardLimitMm: number;
  /** The house board a bare bed needs: the thinnest that passes `breakthrough + 1`, mm; null when none does. */
  boardMm: number | null;
  /** That board's footprint, mm — a stock bigger than it in either direction cannot sit on it. */
  boardLengthMm: number | null;
  boardWidthMm: number | null;
  /** What the board is called in the sentence — `2 mm MDF`. */
  boardWords: string;
}

/** Whether the bed facts describe a wasteboard the breakthrough can enter (the board under, Q7). */
function wasteboardTakesBed(bed: BedUnderFacts, need: number): boolean {
  return bed.surface === 'wasteboard' && bed.wasteboardMm !== null && bed.wasteboardMm >= need;
}

/** Whether the house board a bare bed needs is big enough for this stock. */
function boardCoversStock(bed: BedUnderFacts, job: EngraveJob): boolean {
  if (bed.boardMm === null || bed.boardLengthMm === null || bed.boardWidthMm === null) return true;
  // #727 F7 — a board is a rectangle on the bench: it may be TURNED. A 120 × 90 plate sits on a
  // 90 × 120 board, and judging length-to-length refused one that plainly covers.
  const along = job.stock.length <= bed.boardLengthMm && job.stock.width <= bed.boardWidthMm;
  const turned = job.stock.length <= bed.boardWidthMm && job.stock.width <= bed.boardLengthMm;
  return along || turned;
}

/**
 * The one `through-needs-board` finding (#218, #712). A through cut needs material under the blank
 * to cut INTO: the under-board must be at least `breakthrough + 1` mm thick, so the breakthrough
 * never reaches its far face.
 *
 * ON THE BED (#712) the sentence is the design's: the WASTEBOARD is the machine's sacrificial
 * board (decision Q7), so it counts as the board under when it is thick enough, and a bare bed
 * needs a board put under it — "“Outline” cuts through the sheet, and only the bed is under it —
 * put a 2 mm MDF board under it, or tape it on the wasteboard." Null when there is nothing to
 * refuse (a board or the wasteboard takes the cut), INCLUDING the one case another finding owns:
 * a default board too small for the stock is `board-too-small`'s refusal, not this one's.
 */
function throughBoardFinding(labelId: string, who: string, job: EngraveJob, bed?: BedUnderFacts | null): JobFinding | null {
  const need = job.breakthrough + 1;
  const have = job.sacrificial.under?.thickness ?? 0;
  const bedHeld = job.workholding.kind === 'tape' || job.workholding.kind === 'bracket';
  if (bedHeld && bed !== undefined && bed !== null) {
    // The wasteboard is the board under: no board of the operator's own is needed. Its own depth
    // rule (`wasteboard-depth`, raised once by `validateJob`) judges how far the cut enters it.
    if (wasteboardTakesBed(bed, need)) return null;
    // A bare bed (or a wasteboard too thin to take the breakthrough): a board is required.
    if (have >= need) return null;
    if (!boardCoversStock(bed, job)) {
      // The size refusal is `board-too-small`'s, raised once by `validateJob`: the same fix, said
      // in one sentence with the board's own size.
      return null;
    }
    const board = bed.boardMm === null ? `a board at least ${fmt3(need)} mm thick` : `a ${bed.boardWords} board`;
    const message =
      bed.surface === 'wasteboard'
        ? `${who} cuts through the blank, and the wasteboard is ${fmt3(bed.wasteboardMm ?? 0)} mm — a ` +
          `through cut needs at least ${fmt3(need)} mm under it: put ${board} under it, or tape it on the wasteboard.`
        : `${who} cuts through the blank, and only the bed is under it — put ${board} under it, or tape it on the wasteboard.`;
    return { severity: 'error', code: 'through-needs-board', labelId, message };
  }
  return {
    severity: 'error',
    code: 'through-needs-board',
    labelId,
    message:
      have > 0
        ? `${who} cuts through the blank, but the under-board is ${fmt3(have)} mm; a through cut ` +
          `needs at least ${fmt3(need)} mm (the ${fmt3(job.breakthrough)} mm breakthrough plus ` +
          `1 mm) so it cannot reach the far face.`
        : `${who} cuts through the blank, which needs a sacrificial under-board at least ` +
          `${fmt3(need)} mm thick; add one under the part or this cut reaches the vise.`,
  };
}

/**
 * A human name for an item, for finding messages, in the OPERATION's words (#726 W17):
 * `Engrave text "CASE"`, `Circle ⌀6`, `Border …`. */
export function itemLabel(item: EngraveAnyItem): string {
  if (!('kind' in item)) return `Engrave text "${item.text}"`;
  const name = item.name ? ` "${item.name}"` : '';
  switch (item.kind) {
    case 'rect':
      return `Rectangle${name} ${item.width}×${item.height}`;
    case 'circle':
      return `Circle${name} ⌀${item.diameter}`;
    case 'slot':
      return `Slot${name} ${item.length}×${item.width}`;
    case 'polygon':
      return `Polygon${name} (${item.points.length} points)`;
    case 'border':
      return `Border${name} ${item.width} wide`;
    case 'frame':
      return `Frame${name} ${item.width} wide`;
    case 'cutaway':
      return `Cutaway${name} (${item.islands.length} island${item.islands.length === 1 ? '' : 's'})`;
    // Imported vector outline (#217), part of `EngraveAnyItem` so a frame/cut-away may name it.
    case 'vector':
      return `Imported vector${name} "${item.sourceName}" ${item.width}×${item.height}`;
  }
}

/**
 * Every item the panel's one-line list draws (#411), which is wider than `EngraveAnyItem`: the
 * traces, the drills and the under-surface voids each have a line of their own there even though a
 * combined shape cannot reference one.
 */
export type EngraveNamedItem =
  | EngraveAnyItem
  | EngraveTraceItem
  | EngraveDrill
  | EngraveThread
  | EngraveKeepOut
  | EngraveCutout
  | EngraveChamfer;

/**
 * The KIND in a word — "Rectangle", "Cut-away", "Single-line text", "Hole array" (#411).
 *
 * One copy, because two sentences now name an item's kind: the collapsed line that draws it and the
 * undo strip that says what was removed. Two maps would let the row say "Cut-away" and the strip
 * "Cutaway" about the same thing, and the panel has no other reason for a second opinion.
 *
 * `itemLabel` is the fuller sentence (`Rectangle "Face" 20×10`) for a finding message, where there is
 * room for the dimensions; this is the two words a list line has room for. A VOID answers with its
 * footprint's word here — the word "void" is the panel's, said once on the row's own tooltip.
 */
export function itemKindWord(item: EngraveNamedItem): string {
  if (!('kind' in item)) return 'Label';
  switch (item.kind) {
    case 'rect':
      return 'Rectangle';
    case 'circle':
      return 'Circle';
    case 'slot':
      return 'Slot';
    case 'polygon':
      return 'Polygon';
    case 'border':
      return 'Border';
    case 'frame':
      return 'Frame';
    case 'cutaway':
      return 'Cut-away';
    case 'vector':
      return 'Imported outline';
    case 'line':
      return 'Line';
    case 'stroke-label':
      return 'Single-line text';
    case 'drill':
      return 'Hole';
    case 'drill-array':
      return 'Hole array';
    case 'thread':
      return 'Thread';
    case 'cutout':
      return 'Cut-out';
    case 'chamfer':
      return 'Chamfer';
  }
}

/**
 * The item's own name, trimmed, or `''` when it has none — the caller decides what to draw instead
 * (`itemKindWord`, or the label row's "(empty label)"), because a collapsed line and an undo strip
 * are two different sentences and "Rectangle Rectangle" is what a helper that guessed would print.
 *
 * A LABEL is named by its text: it has no `name` field at all, and its text is what the line reads.
 * A VECTOR falls back to `sourceName`, the file it came from, because its outline IS the imported
 * file — the same reason the vector row names it that way.
 */
export function itemRowName(item: EngraveNamedItem): string {
  if (!('kind' in item)) return item.text.trim();
  if (item.kind === 'vector') return item.name?.trim() || item.sourceName;
  return item.name?.trim() ?? '';
}

/** Does this item produce any region at all? A shape always does; a label needs text. */
function itemHasWork(item: EngraveAnyItem): boolean {
  return 'kind' in item || item.text.trim().length > 0;
}

/** Does this trace produce any cut? A line needs two points; a stroke label needs text (#219). */
function traceHasWork(trace: EngraveTraceItem): boolean {
  return trace.kind === 'line' ? trace.points.length >= 2 : trace.text.trim().length > 0;
}

/**
 * The tool the job names, or null. Three steps, in order (#305 design point 2):
 *
 *   1. the job's OWN snapshot (`job.tool`), so a job reopened while the service is absent still
 *      generates, verifies and simulates — and so a cutter re-collared since the job was written
 *      does not silently re-prove it at a new stick-out;
 *   2. the registry entry `job.toolKey` names — the built-ins always, a catalogue or inventory
 *      tier when one is loaded;
 *   3. null, which leaves the holder gate saying "cannot be proven" exactly as it does today.
 *
 * The workers cannot call this: no store is visible inside them. They are handed the resolved
 * `Tool` (or the list, for the recommendation) and read `toolForJob` themselves.
 */
export function jobTool(job: EngraveJob): Tool | null {
  return toolForJob(job, getTools());
}

/**
 * How the job holds the part, in the PART frame — the ONE authority for the vise's jaw faces
 * (#188/decision 26). Both the emulator (`toSetup`, below) and the registration plan
 * (`engrave/registration.ts`) read this, so a jaw face can never be derived twice and disagree.
 *
 * The fixed jaw is the plane x = 0 with normal +X (the fixed jaw is on the left,
 * /Fabrication.md §7.3); the moving jaw is x = length with normal −X. `jawHeight` is measured
 * from the stock's seated bottom (model z = 0) up to the jaw tops, which stand `stockProud`
 * below the top face: `thickness − stockProud`.
 *
 * SACRIFICIAL MATERIAL MOVES THE FACES (#213 §2): the jaws close on what is actually between
 * them, so `viseJawShift` pushes the fixed face to `x = −shift.left` and the moving face to
 * `x = length + shift.right`. With no sacrificial material the shift is zero and the faces sit
 * on the part's own edges exactly as before.
 */
export function workholdingFor(job: EngraveJob): Workholding {
  const { length, width, thickness } = job.stock;
  const shift = viseJawShift(job.sacrificial);
  if (job.workholding.kind === 'tape') {
    // The tape holds along the whole underside: the contact IS the stock's footprint.
    return { kind: 'tape-down', contact: rectProfile(length, width) };
  }
  if (job.workholding.kind === 'bracket') {
    // Makera's origin is "relative to Anchor 1, X offset 0, Y offset 0" (§5): the bracket's corner
    // IS the stock's front-left corner until the offset is measured (BM-9's confirming touch).
    return { kind: 'anchor-bracket', anchor: job.workholding.bracket.anchor, offset: [0, 0] };
  }
  // #240 — the SETUP's neutral seat is the flat vise's: a job in the chuck is read through
  // `jobVise` here, because the emulator's view of the chuck is slice 3's rotary run sheet. The
  // unrolled map slice 2 builds lives in the CAM, the verifier and the column oracle, not in this
  // seat.
  const vise = jobVise(job);
  return {
    kind: 'vise',
    jawFaces: [
      { origin: [0 - shift.left, 0, 0], normal: [1, 0, 0] }, // fixed jaw face, normal +X
      { origin: [length + shift.right, 0, 0], normal: [-1, 0, 0] }, // moving jaw face, normal −X
    ],
    jawHeight: thickness - vise.stockProud,
  };
}

/**
 * A top-up mount: each stock face sits at the machine face of the same name. `setups/types.ts`
 * names this as the identity `Orientation`.
 */
const IDENTITY_ORIENTATION: Orientation = {
  top: 'top',
  bottom: 'bottom',
  left: 'left',
  right: 'right',
  front: 'front',
  back: 'back',
};

/**
 * The id of the derived single setup. It is deliberately not minted: the implicit setup is not a
 * stored record, so every caller and every call must get the same id. `implicit` cannot collide
 * with a minted id, which is `setup-` plus ten generated characters (`newId('setup')`).
 */
const IMPLICIT_SETUP_ID = 'setup-implicit';

/**
 * The job's setups (#419 J2). A job that states `setups[]` returns them UNTOUCHED — the stored
 * record is authoritative, and this is not a place to re-derive or normalise it.
 *
 * A job that does not (every document written before the field existed) gets the compatibility
 * reading of the single setup it has always meant: the blank top-up in the vise, mounted as
 * `workholding` says, cutting every ENABLED cutting item in document order with `job.toolKey`.
 *
 * "Cutting" is the operative word: `keepOuts` are voids and constraints, not work, so they are
 * excluded; a `construction: true` item is reference-only and produces no cut of its own, so it is
 * excluded too; a disabled item of any kind is excluded. The lists are walked in their document
 * order — labels, shapes, combined, traces, vectors, drills — which is the order a single-setup
 * job has always cut them in.
 *
 * This is a READING, not a second stored truth: the derived setup is built fresh on every call,
 * has no registration (nothing was planned) and no remount (there is nowhere to come from).
 */
export function jobSetups(job: EngraveJob): JobSetup[] {
  if (job.setups !== undefined) return job.setups;

  const items: { id: string; enabled: boolean; construction?: boolean }[] = [
    ...job.labels,
    ...job.shapes,
    ...(job.combined ?? []),
    ...(job.traces ?? []),
    ...(job.vectors ?? []),
    ...(job.drills ?? []),
    ...(job.threads ?? []),
    // #435 — only the primitives that actually cut belong in a setup's item list. A refused cone
    // or sphere is still the document's, and `validateJob` names it, but it is not work any cutter
    // owns.
    ...(job.primitives ?? []).filter(primitiveReducesToRegion),
    // #218 — a cut-out is cutting work like any other item: it belongs to the setup (and so to a
    // cutter's program) or a job with only cut-outs has no program assigned to it at all.
    ...(job.cutouts ?? []),
    // #669 — a chamfer is cutting work too, and it must ride in its TARGET's setup: one program
    // has one tool, and the bevel follows an edge that program's cut leaves.
    ...(job.chamfers ?? []),
  ];
  const itemIds = items
    .filter((item) => item.enabled && item.construction !== true)
    .map((item) => item.id);

  return [
    {
      id: IMPLICIT_SETUP_ID,
      // A copy: the derived setup is built fresh on every call, so no caller can mutate the
      // identity through one job and change the answer for the next.
      orientation: { ...IDENTITY_ORIENTATION },
      // #707 BM-1 — the derived setup's mount is the JOB's, in the setups engine's own word; a
      // taped or bracket job's one setup is that mount, and its `board` flag says the stock stands
      // on the sacrificial under-board.
      mount: derivedMount(job),
      itemIds,
      // #516 item 5 — no cutter chosen yet means no tools for the implicit setup; the fallback in
      // `setupTools` then posts no program rather than one that names the empty key.
      tools: job.toolKey === NO_TOOL_KEY ? [] : [job.toolKey],
    },
  ];
}

/**
 * How the job holds the stock for ONE setup (#419 J2, #442's #427 item; per-setup mounts, #471):
 * the stored setup's mount when the document states that setup, and `workholding`'s — the vise —
 * for the implicit one (or an index the document does not reach).
 *
 * The index is 0-based, like `job.setups` and unlike the operator's "Setup 1". This is the one
 * reader a caller needs to decide whether the mount's obstacles apply at all: a program on the
 * bracket is checked against the bracket's arms and clamps; a program in the vise is not
 * (`bracketMount` answers `null`). A caller reading a program passes its `setupIndex - 1`.
 */
export function jobMount(job: EngraveJob, setupIndex = 0): Mount {
  // A stored setup's mount is the document's own (#419), so it wins where the document reaches.
  const stored = job.setups?.[setupIndex]?.mount.kind;
  if (stored !== undefined) return stored;
  // #707 BM-1 — a derived setup for a bed job is the job's own mount: the workholding names it
  // with the same word the setups engine does (`tape` / `bracket`).
  if (job.workholding.kind === 'tape' || job.workholding.kind === 'bracket') return job.workholding.kind;
  // #240 — a derived setup for a rotary job is still read as the flat vise (see
  // `workholdingFor`).
  return 'vise';
}

/** The mount the implicit setup carries (#707 BM-1): `jobMount`'s word, with the board flag. */
function derivedMount(job: EngraveJob): MountSpec {
  const kind = jobMount(job);
  return kind === 'vise' ? { kind } : { kind, board: job.sacrificial.under !== null };
}

/**
 * The clamp places THIS JOB states, or null when it is not a bracket job (#707 BM-1).
 *
 * The one reader the CAM, the verifier, the simulation and the registration share, so a job's own
 * clamps are what is checked and the shop's default pair is only ever the STARTING PLACE a new
 * bracket job is given (`defaultBracketHold`).
 */
export function clampPlacementsFor(job: Pick<EngraveJob, 'workholding'>): ClampPlacement[] | null {
  return job.workholding.kind === 'bracket' ? job.workholding.bracket.clamps : null;
}

/**
 * The tape a new taped job starts from (#707 §5, each number with its source):
 *
 *   - width 20 mm — Makera's 20 mm double-sided tape (the accessory list); the house roll's own
 *     `consumables.tape.widthMm` replaces it when the bed profile states one (R);
 *   - thickness ~0.2 mm — Makera's store page for its 20 mm double-sided tape states
 *     "approximately 0.2mm thick" (`docs/design/z1-accessory-install.md` C21); typed on the bed
 *     profile until a bench coupon measures the roll in hand;
 *   - inset 2 mm — Case Maker's own (the edge scans land just past each edge, §3.4), so tape past
 *     an edge would be read as a step.
 */
export interface TapeDefaults {
  widthMm: number;
  thicknessMm: number;
  insetMm: number;
  /** Where these numbers came from, in words, for the Technical fold's provenance line. */
  provenance: string;
}

export const TAPE_DEFAULTS: TapeDefaults = {
  widthMm: 20,
  thicknessMm: 0.2,
  insetMm: 2,
  provenance: "Makera's 20 mm tape; ~0.2 mm (Makera's store), not measured here; 2 mm in from every edge",
};

/** A new taped job's holding: the design's defaults, `source: 'default'`, nothing measured. */
export function defaultTapeHold(defaults: TapeDefaults = TAPE_DEFAULTS): TapeHold {
  return {
    width: defaults.widthMm,
    thickness: defaults.thicknessMm,
    inset: defaults.insetMm,
    where: null,
    squareTo: 'front',
    source: 'default',
  };
}

/**
 * A new bracket job's holding: the Makera kit's thin bracket at anchor 1, with the QuickStart's
 * default clamp places (two on the back edge, `clamps.topInFromCornerMm` in from each corner).
 * `source: 'default'` — none of it is measured, and the sizes behind the places stay the shop's
 * own with their provenance.
 */
export function defaultBracketHold(stock: StockSize, defaults: ShopDefaults | null): BracketHold {
  const b = bracketSettings(defaults);
  return {
    anchor: 1,
    variant: 'thin',
    clamps: defaultClampPlacements(stock, b.settings),
    source: 'default',
  };
}

/**
 * The part, its workholding and the work origin, for the emulator.
 *
 * `fixture` REPLACES the vise's envelope when the job is held on the bracket (#442's #427 item):
 * one mount is in the machine, so its boxes are the fixture — not the vise's and not both. Absent,
 * the vise's envelope is derived exactly as before (#203).
 *
 * #725 B7 — `bed` is the machine's bed under the stock (the same `BedUnderFacts` the through gate
 * reads). A taped job on a recorded wasteboard gets that board as its under-board in the SETUP
 * only: the exact sweeper models `setup.sacrificial` as a second body, so its bed floor drops by
 * the board's thickness and the breakthrough a through cut is allowed into the wasteboard (design
 * fixture 2c) simulates instead of reading "a rapid below the bed". The DOCUMENT's sacrificial is
 * untouched — the operator never asked for a board, and nothing here changes a finding.
 */
export function toSetup(
  job: EngraveJob,
  machine: MillProfile,
  fixture?: FixtureEnvelope,
  bed?: BedUnderFacts | null,
): Setup {
  const { thickness } = job.stock;
  // #240 slice 2 — a ROTARY job's part is a cylinder on the chuck: there is no vise to model, no
  // sacrificial board under it, and the work origin is the axis (`stubSetup` places a cylinder's
  // WCS there — the slice-1 fix). The chuck's facts are the job's own; the jaw diameter is the
  // stock's unless the job states the capacity it closes on.
  const rotary = rotaryMapOf(job);
  if (rotary !== null) {
    const chuck = job.workholding.kind === 'rotary-chuck' ? job.workholding.rotary : null;
    return stubSetup(
      { kind: 'cylinder', diameter: rotary.radius * 2, length: rotary.length },
      {
        kind: 'rotary-chuck',
        jawDiameter: chuck?.gripDiameter ?? rotary.radius * 2,
        stickout: rotary.stickout,
      },
      { startingTool: 1 },
      machine,
    );
  }
  const vise = jobVise(job);
  const workholding = workholdingFor(job);
  // #707 BM-1 — the vise's envelope is the VISE's. A bracket job's obstacles are its arms and THE
  // JOB'S clamps, which the caller passes as `fixture` because their sizes live in the location's
  // defaults; a tape job puts nothing above the part. Handing a bed job the vise's jaws would
  // check it against a fixture that is not in the machine — the same false refusal the bracket
  // defect produced, one step earlier.
  const defaultFixture = jobMount(job) === 'vise' ? viseEnvelope(job.stock, vise, job.sacrificial) : undefined;
  return stubSetup(
    // #743 D6 — the seed solid is the stock's own plan: a disc's circular prism is its rim
    // extruded through the thickness, which is the cylinder the sweep starts from. It is a
    // `prism` and not `Setup`'s `cylinder`, because that variant is the ROTARY frame — axis along
    // X, work origin on the axis — and a disc is cut on its face with the origin on the top.
    { kind: 'prism', outline: flatStockOutline(job.stock), thickness },
    workholding,
    // The default job's tool is number 1 (`flat-1.0`); the starting tool is stated because a
    // program cannot know the machine's active tool (/Simulation.md §1.1). The fixture is the
    // mount's obstacle envelope (#203), carried with its provenance so the emulator never
    // mistakes a default for a measurement. The sacrificial model rides along (#213) so the
    // sweep can model it as a second body; absent, every pre-#213 caller is unchanged.
    // #725 B7 — the wasteboard, when the bed carries one and the job has no board of its own.
    { startingTool: 1, fixture: fixture ?? defaultFixture, sacrificial: sacrificialWithBedBoard(job, bed) },
    machine,
  );
}

/**
 * #725 B7 — the job's sacrificial model with the machine's wasteboard as the under-board, when the
 * job is held on the bed, states no board of its own, and the bed records one. The board takes the
 * part's own footprint (no overhang: the verifier's `bedBoardMm` rule, #712) so the sweep's bed
 * floor drops by exactly the thickness a through cut may use, and nothing more.
 */
function sacrificialWithBedBoard(job: EngraveJob, bed?: BedUnderFacts | null): EngraveJob['sacrificial'] {
  const mine = job.sacrificial;
  if (bed === null || bed === undefined) return mine;
  if (bed.surface !== 'wasteboard' || bed.wasteboardMm === null) return mine;
  if (mine.under !== null) return mine;
  if (job.workholding.kind !== 'tape' && job.workholding.kind !== 'bracket') return mine;
  return {
    ...mine,
    under: {
      thickness: bed.wasteboardMm,
      overhang: { left: 0, right: 0, front: 0, back: 0 },
      attach: 'tape',
    },
  };
}

/**
 * Pure checks on the job as data. Geometry-dependent findings — an item hanging off the
 * stock, strokes too thin for the cutter — need the worker and are #201.
 *
 * `drillPoint` is the shop's `drill.pointAngleDeg` reading, when the caller has one (#434). A drill
 * bit's tip is a POINT LENGTH below its full diameter, so the depth and flute checks need the
 * included angle. The worker passes the located reading (`shop.drill` / `shop.defaults`); a caller
 * with no location gets the same labelled fallback the CAM uses, never an unlabelled literal.
 */
/**
 * Validate a GOAL target object (#533): it must have volume and fit the blank it would be carved
 * from — a goal flat in one direction, or larger than the stock in footprint or depth, cannot be
 * reproduced. Factored out of {@link validateJob} (same findings, same messages) so the pure-goal
 * generate dispatch (#539) can gate on it before it samples and posts a surfacing program, instead
 * of surfacing an invalid goal that no `validateJob` call ever saw. Returns an `error`
 * `goal-object-oversize` when the goal is unmakeable. The `goal-object-no-toolpath` info is the
 * MIXED path's (a goal beside ordinary items, which the item program cuts instead of the goal);
 * a pure goal job is surfaced, so it gets no such note — pass `mixed: true` from a job that has
 * other work.
 */
export function validateGoalObject(
  target: EngraveTargetObject,
  stock: { length: number; width: number; thickness: number },
  opts: { mixed?: boolean; minFloor?: number; edgeMargin?: number } = {},
): JobFinding[] {
  const findings: JobFinding[] = [];
  const { length, width, thickness } = stock;
  // #721 — a MOLD is a cavity: it needs a rim of stock round it and a floor of stock under it,
  // which the item's "fits the blank" test does not ask. The rim is the job's edge margin, the
  // floor its minimum floor — the same two numbers every other pocket keeps.
  const mold = target.goalMode === 'mold' && target.format !== 'png' && (target.role ?? 'reference') === 'goal';
  // #672 — a PICTURE goal's depth is its relief map's, not `size.z`: the operator states
  // `relief.maxDepthMm` (or takes the labelled default), and the blank must hold it.
  // #722 — a mesh's PLACED size (parsed bbox × scale), the size the heightfield samples.
  // #723 part 2 — and it is the TURNED size: `placedSize` grows the extents by the mesh's X/Y/Z
  // turns, so the footprint is exactly what the stock sees (no second turn applied here).
  const placed = placedSize(target);
  const depth = target.format === 'png' ? reliefNumbers(target.relief).maxDepthMm : placed.z;
  const hasVolume = placed.x > 0 && placed.y > 0 && depth > 0;
  const footprint = { x: placed.x, y: placed.y };
  if (!hasVolume) {
    findings.push({
      severity: 'error',
      code: 'goal-object-oversize',
      message:
        `The goal object "${target.name}" is flat in at least one direction ` +
        `(${fmt3(placed.x)}×${fmt3(placed.y)}×${fmt3(depth)} mm); a goal needs ` +
        `volume to drive a 3D cut toward.`,
    });
  } else if (mold) {
    // #721 + #786 slice 2 — A MOLD'S RIM AND FLOOR ARE INFORMED, NOT REFUSED. The cavity is cut
    // only where the blank exists (the sampler clips it, #784), so a part that reaches past an
    // edge loses the wall there and a deep part leaves a thinner floor — both are outcomes with
    // numbers, and both are stated; the sweep's fixture checks still catch real contact.
    const rim = opts.edgeMargin ?? 0;
    const gxMin = target.position.x - footprint.x / 2;
    const gxMax = target.position.x + footprint.x / 2;
    const gyMin = target.position.y - footprint.y / 2;
    const gyMax = target.position.y + footprint.y / 2;
    const rims = [
      { side: 'left', mm: gxMin },
      { side: 'right', mm: length - gxMax },
      { side: 'front', mm: gyMin },
      { side: 'back', mm: width - gyMax },
    ].filter((r) => r.mm < rim - 1e-9);
    if (rims.length > 0) {
      const list = rims
        .map((r) => (r.mm < 0 ? `no rim on the ${r.side} (it breaks out by ${fmt3(-r.mm)} mm)` : `${fmt3(r.mm)} mm on the ${r.side}`))
        .join(', ');
      findings.push({
        severity: 'warning',
        code: 'goal-mold-rim',
        message:
          `The mold of "${target.name}" sits from X ${fmt3(gxMin)} to ${fmt3(gxMax)} mm and Y ${fmt3(gyMin)} to ` +
          `${fmt3(gyMax)} mm on the ${fmt3(length)}×${fmt3(width)} mm blank, where a cavity wants a ${fmt3(rim)} mm ` +
          `rim of stock all round it: ${list}. Generate cuts the cavity clipped to the blank, so the casting has no ` +
          `wall on those sides. Move the part inward, scale it down, or use a larger blank.`,
      });
    }
    const floor = opts.minFloor ?? 0;
    const floorLeft = thickness - depth + target.position.z;
    if (floorLeft < floor - 1e-9) {
      findings.push({
        severity: 'warning',
        code: 'goal-mold-floor',
        message:
          `The mold of "${target.name}" is ${fmt3(depth)} mm deep in the ${fmt3(thickness)} mm blank, ` +
          (floorLeft > 0
            ? `leaving ${fmt3(floorLeft)} mm of stock under the cavity where the job asks for at least ${fmt3(floor)} mm. `
            : `so the cavity breaks through the blank's bottom by ${fmt3(-floorLeft)} mm. `) +
          `Generate cuts it as it is. Scale the part down, use a thicker blank, or put a sacrificial board under it.`,
      });
    }
  } else {
    // #784 — A GOAL LARGER THAN THE BLANK IS INFORMED, NOT REFUSED. What lies outside is named
    // per axis and side; Generate cuts the goal CLIPPED to the blank (the sampler intersects its
    // grid with the stock). It is an error only when nothing of the goal is over the blank at all
    // — then there is genuinely nothing to cut.
    const gxMin = target.position.x - footprint.x / 2;
    const gxMax = target.position.x + footprint.x / 2;
    const gyMin = target.position.y - footprint.y / 2;
    const gyMax = target.position.y + footprint.y / 2;
    const gTop = target.position.z;
    const gBase = target.position.z - depth;
    const sides: string[] = [];
    const outside = (amount: number, words: string): void => {
      if (amount > 1e-6) sides.push(`${fmt3(amount)} mm ${words}`);
    };
    outside(-gxMin, 'past the left edge');
    outside(gxMax - length, 'past the right edge');
    outside(-gyMin, 'past the front edge');
    outside(gyMax - width, 'past the back edge');
    outside(gTop, "above the stock's top face");
    outside(-thickness - gBase, "below the stock's bottom face");
    const overlapX = Math.min(gxMax, length) - Math.max(gxMin, 0);
    const overlapY = Math.min(gyMax, width) - Math.max(gyMin, 0);
    const overlapZ = Math.min(gTop, 0) - Math.max(gBase, -thickness);
    const list = (items: string[]): string =>
      items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
    if (overlapX <= 1e-6 || overlapY <= 1e-6 || overlapZ <= 1e-6) {
      findings.push({
        severity: 'error',
        code: 'goal-object-oversize',
        message:
          `The goal object "${target.name}" lies entirely outside the blank` +
          (sides.length === 0 ? '' : `: ${list(sides)}`) +
          `. Nothing of it is inside the ${fmt3(length)}×${fmt3(width)}×${fmt3(thickness)} mm stock, so there ` +
          `is nothing to cut. Move it over the blank, scale it down, or use a larger stock.`,
      });
    } else if (sides.length > 0) {
      findings.push({
        severity: 'warning',
        code: 'goal-object-oversize',
        message:
          `The goal object "${target.name}" extends beyond the blank: ${list(sides)}. Generate cuts it ` +
          `clipped to the blank, so the part outside the stock is not cut; move it inward or use a larger ` +
          `stock to keep it whole.`,
      });
    }
  }
  if (opts.mixed === true && !findings.some((f) => f.severity === 'error')) {
    // #535 — the MIXED path's note: one job's program is the item work, so this goal is validated
    // and previewed but not cut. A pure goal job is surfaced instead and gets no note.
    findings.push({
      severity: 'info',
      code: 'goal-object-no-toolpath',
      message:
        `The goal object "${target.name}" is the shape to make, and it fits the blank. This job ` +
        `cuts other work too, and its program is that work: the goal is validated and previewed, ` +
        `and the roughing and finishing passes run when the goal is the job's only operation.`,
    });
  }
  return findings;
}

/**
 * How a too-deep sentence ends, in the frame the job is cut in (#724 W4). It names the limit the
 * cut crossed, never a delta from a limit it did not reach:
 *
 *   - a plate: the floor left under the item, against the minimum;
 *   - a solid rod short of the centre: the floor left above the AXIS (the limit is the radius);
 *   - a solid rod past the centre: how far past it the tip would go;
 *   - a tube: the bore its wall holds back — the sentence says the wall is broken, not the axis.
 */
function overDepthClause(job: EngraveJob, depth: number, facingDepth: number, floorAllowed: number): string {
  const map = rotaryMapOf(job);
  if (map !== null) {
    const wall = job.stock.wall;
    if (wall !== undefined && wall > 0 && wall < map.radius) {
      // The refusal fires from the ceiling (wall − floor), so a depth between the two leaves a
      // thin wall rather than breaking into the bore: name the wall's remaining floor, not a
      // breakthrough that would not happen.
      return depth >= wall
        ? `it breaks through the tube's ${fmt3(wall)} mm wall into its bore; at most ${fmt3(floorAllowed)} mm here`
        : `it leaves less than the ${fmt3(job.minFloor)} mm floor in the tube's ${fmt3(wall)} mm wall; at most ${fmt3(floorAllowed)} mm here`;
    }
    if (depth > map.radius) {
      return (
        `the cutter tip would reach ${fmt3(depth - map.radius)} mm past the axis, ` +
        `and a rotary cut keeps its floor above it — at most ${fmt3(floorAllowed)} mm here`
      );
    }
    return (
      `it leaves less than the ${fmt3(job.minFloor)} mm floor above the axis; ` +
      `at most ${fmt3(floorAllowed)} mm here`
    );
  }
  const remaining = job.stock.thickness - facingDepth - depth;
  return `only ${fmt3(remaining)} mm of floor would remain on a ${job.stock.thickness} mm stock, below the ${job.minFloor} mm minimum`;
}

/**
 * The goal object a PURE 3D-surfacing job carries (#534, #535), or `null`.
 *
 * A pure goal job carries an enabled `role: 'goal'` mesh and NO authoring items — no labels,
 * shapes, traces, drills, threads, cut-outs, primitives, vectors, combined shapes or keep-outs —
 * and no stated setups. Mixing a goal with ordinary item work stays on the item path (the item
 * program cuts; the goal keeps its `goal-object-no-toolpath` info). THE ONE DEFINITION: the
 * generate dispatch, `validateJob`'s work test and the setup bookkeeping all read this, so a job
 * cannot be "pure goal" to one and "empty" to another.
 */
export function pureGoalObject(job: EngraveJob): EngraveTargetObject | null {
  const t = job.targetObject;
  if (t === undefined || (t.role ?? 'reference') !== 'goal' || !t.enabled) return null;
  if (job.setups !== undefined) return null;
  return jobHasItems(job) ? null : t;
}

/** #723 P2-1b — whether the document holds any item work (the mixed-job test for a goal job). */
export function jobHasItems(job: EngraveJob): boolean {
  return (
    job.labels.length > 0 ||
    job.shapes.length > 0 ||
    (job.cutouts?.length ?? 0) > 0 ||
    (job.chamfers?.length ?? 0) > 0 ||
    (job.combined?.length ?? 0) > 0 ||
    (job.traces?.length ?? 0) > 0 ||
    (job.vectors?.length ?? 0) > 0 ||
    (job.keepOuts?.length ?? 0) > 0 ||
    (job.drills?.length ?? 0) > 0 ||
    (job.threads?.length ?? 0) > 0 ||
    (job.primitives?.length ?? 0) > 0
  );
}

/**
 * #723 P2-1b — every target object the document names, in order. The singular `targetObject` is
 * the one-goal form and reads as a one-entry list, so a job written before `targetObjects` existed
 * is indistinguishable from one that names its single goal in the list.
 */
export function jobTargetObjects(job: EngraveJob): EngraveTargetObject[] {
  if (job.targetObjects !== undefined) return job.targetObjects;
  return job.targetObject === undefined ? [] : [job.targetObject];
}

/** One side of a multi-setup goal job: the enabled goal and the setup that cuts it. */
export interface GoalSide {
  setup: JobSetup;
  /** 0-based, the setup's index in `jobSetups(job)`. */
  setupIndex: number;
  goal: EngraveTargetObject;
}

/**
 * #723 P2-1b — the goal jobs' SIDES, in setup order. One goal per setup: a goal that names
 * `setupId` takes that side; a goal that names none takes the FIRST setup (today's single-side
 * behaviour, and the schema refuses a second unassigned goal). Reference objects and disabled
 * targets are not sides and are skipped. A job with no saved setups (`job.setups === undefined`)
 * has no multi-side reading at all — that is the legacy single-goal path's.
 */
export function goalSides(job: EngraveJob): GoalSide[] {
  if (job.setups === undefined) return [];
  const goals = jobTargetObjects(job).filter((t) => (t.role ?? 'reference') === 'goal' && t.enabled);
  if (goals.length === 0) return [];
  const setups = jobSetups(job);
  const bySetup = new Map<string, EngraveTargetObject>();
  for (const goal of goals) {
    const setup = goal.setupId === undefined ? setups[0] : setups.find((s) => s.id === goal.setupId);
    // The schema refuses an unknown `setupId`; a document that reached here by other means simply
    // does not cut that goal rather than silently moving it to another side.
    if (setup === undefined || bySetup.has(setup.id)) continue;
    bySetup.set(setup.id, goal);
  }
  return setups.flatMap((setup, setupIndex) => {
    const goal = bySetup.get(setup.id);
    return goal === undefined ? [] : [{ setup, setupIndex, goal }];
  });
}

export function validateJob(
  job: EngraveJob,
  drillPoint: { deg: number; source: string } | null = null,
  /**
   * #677 — work the DOCUMENT does not hold. The core-clearance program is built from a sub-job
   * with no items (the core is derived, not drawn), so its validation must count the derived
   * regions as work or `no-items` would refuse a program that has cutting to do.
   */
  options: {
    derivedCores?: number;
    /**
     * #712 — what the machine's bed carries under the stock (`BedUnderFacts`), built by the caller
     * from the active bed profile. Absent: no location, and the through sentences are the pre-#712
     * ones (the vise's).
     */
    bed?: BedUnderFacts | null;
    /**
     * #725 W12 — the location's shop defaults, when the caller can read them: the bracket's and
     * the clamps' sizes live there, and two clamps on top of each other is a mount that does not
     * hold. Absent (`undefined`): the caller has no location and the overlap check is skipped
     * rather than judged with a clamp the house may not own.
     */
    defaults?: ShopDefaults | null;
  } = {},
): JobFinding[] {
  const bed = options.bed ?? null;
  const findings: JobFinding[] = [];
  const all: EngraveAnyItem[] = [
    ...job.labels,
    ...job.shapes,
    ...(job.combined ?? []),
    ...(job.vectors ?? []),
  ];
  // A construction item (#215) produces no cut of its own, so its depth is irrelevant and it
  // must not be the reason a job reads as "has work".
  const enabled: EngraveAnyItem[] = all.filter((item) => item.enabled && !item.construction);
  // Traces (#219) are a separate list and carry their own depth and enable flag.
  const enabledTraces: EngraveTraceItem[] = (job.traces ?? []).filter((t) => t.enabled && !t.construction);
  // Plunge drills (#220) are a third list. A drill has no `construction`; a disabled one does
  // nothing.
  const enabledDrills: EngraveDrill[] = (job.drills ?? []).filter((d) => d.enabled);
  // Milled threads (#445) are a fourth list. A thread has no `construction`; a disabled one does
  // nothing.
  const enabledThreads: EngraveThread[] = (job.threads ?? []).filter((t) => t.enabled);
  // 3D primitives (#435) are a fifth list. Only the cuttable forms count as WORK; the refused
  // forms are still enabled items, so they get their own findings below rather than vanishing.
  const enabledPrimitives: EngravePrimitive[] = (job.primitives ?? []).filter((p) => p.enabled);
  const cuttablePrimitives = enabledPrimitives.filter(primitiveReducesToRegion);
  // PROFILE CUT-OUTS (#218) are a sixth list. A cut-out has no `construction`; a disabled one
  // does nothing. Every enabled cut-out cuts through by definition.
  const enabledCutouts = (job.cutouts ?? []).filter((c) => c.enabled);
  // CHAMFERS (#669) are a seventh list. A chamfer has no `construction`; a disabled one does
  // nothing, and an enabled one must name a rim the job really cuts.
  const enabledChamfers = (job.chamfers ?? []).filter((c) => c.enabled);
  const { thickness } = job.stock;

  // #432 — the facing skim is material the items no longer have under them. Every item's depth is
  // measured from the FACED top (that is the frame the document is written in), so the floor an
  // item may cut to is one facing-depth lower than the blank's own: `thickness − facing − minFloor`.
  // Absent, disabled or zero means the job does not face and every number below is unchanged.
  const facingDepth = job.facing !== undefined && job.facing.enabled && job.facing.depth > 0 ? job.facing.depth : 0;
  if (facingDepth > thickness - job.minFloor) {
    findings.push({
      severity: 'error',
      code: 'facing-too-deep',
      message:
        `The facing pass would take ${facingDepth} mm off the ${thickness} mm stock, leaving less ` +
        `than the ${job.minFloor} mm minimum floor. A facing pass is a light skim: keep it shallow, ` +
        `or start from thicker stock.`,
    });
  }
  // #724 W4 — the floor allowed is the BLANK's ceiling, facing taken: on a plate the thickness
  // less the floor, on a rotary job the RADIUS (or a tube's wall) less the floor — a ⌀20 rod's
  // limit is 9 mm, and 19 has no stock under it at all. The same number the row's field, its
  // sentence and the recommendation use.
  const floorAllowed = blankDepthCeiling(job) - facingDepth;

  for (const item of enabled) {
    // A through region has no typed depth (#218): its floor is the board, and the through gate
    // below judges it. `item.depth` on a through item is deliberately ignored. Only a shape can
    // carry `through`; a label has no such field.
    if ('through' in item && item.through === true) continue;
    if (item.depth > floorAllowed) {
      findings.push({
        severity: 'error',
        code: 'depth-exceeds-stock',
        labelId: item.id,
        message: `${itemLabel(item)} cuts ${item.depth} mm deep; ${overDepthClause(job, item.depth, facingDepth, floorAllowed)}.`,
      });
    }
  }

  for (const trace of enabledTraces) {
    if (trace.depth > floorAllowed) {
      findings.push({
        severity: 'error',
        code: 'depth-exceeds-stock',
        labelId: trace.id,
        message: `${traceOperationName(trace)} cuts ${trace.depth} mm deep; ${overDepthClause(job, trace.depth, facingDepth, floorAllowed)}.`,
      });
    }
  }

  // 3D primitives (#435), in two parts: the depth every enabled primitive must respect, and the
  // by-name refusals for the forms the region CAM cannot cut. A refused primitive is an ERROR even
  // when it is the job's only work: silently dropping it would let Generate report "nothing to do"
  // about a shape the person drew. An axis other than Z is tested first — it makes even a box an
  // undercut — and each message names the way the shape CAN be cut.
  for (const primitive of enabledPrimitives) {
    if (primitive.depth > floorAllowed) {
      findings.push({
        severity: 'error',
        code: 'depth-exceeds-stock',
        labelId: primitive.id,
        message: `${primitiveLabel(primitive)} cuts ${primitive.depth} mm deep; ${overDepthClause(job, primitive.depth, facingDepth, floorAllowed)}.`,
      });
    }
    const axis = primitive.axis ?? 'z';
    if (axis !== 'z') {
      findings.push({
        severity: 'error',
        code: 'primitive-not-vertical',
        labelId: primitive.id,
        message:
          `${primitiveLabel(primitive)} opens along ${axis.toUpperCase()}, which is a side-opening ` +
          `undercut — not a top-face region the region CAM can cut. Set its axis to Z, or cut it ` +
          `with the 3D engine; it is refused rather than approximated.`,
      });
      continue;
    }
    if (primitive.kind === 'cone') {
      findings.push({
        severity: 'error',
        code: 'primitive-cone-needs-cam',
        labelId: primitive.id,
        message:
          `${primitiveLabel(primitive)} has a sloped wall. The region CAM only cuts walls parallel ` +
          `to the cutter axis, so a cone would be approximated as a cylinder and is refused. The ` +
          `V-carve/chamfer work and the 3D engine are the ways to cut it.`,
      });
      continue;
    }
    if (primitive.kind === 'sphere') {
      findings.push({
        severity: 'error',
        code: 'primitive-sphere-needs-3d',
        labelId: primitive.id,
        message:
          `${primitiveLabel(primitive)} has a curved floor. A sphere is a dexel job, not a ` +
          `flat-floor region; it is refused rather than approximated as a circle pocket.`,
      });
    }
  }

  // The embedded mesh (#435, #533) is judged by its ROLE. Absent means 'reference', so a document
  // written before #533 keeps today's behaviour exactly.
  if (job.targetObject?.enabled === true) {
    const target = job.targetObject;
    // #720 — the mesh's BYTES live beside the document now (the persisted job carries the hash,
    // the size and the name). When this browser no longer holds them, the job says so in words the
    // operator can act on: a goal cannot be made without its shape, and a reference cannot be
    // drawn. The import door is the fix in both cases.
    if (target.data === undefined) {
      const role = target.role ?? 'reference';
      findings.push({
        severity: role === 'goal' ? 'error' : 'warning',
        code: 'target-mesh-missing',
        labelId: target.id,
        message:
          `The ${role === 'goal' ? 'goal' : 'reference'} mesh “${target.name}” is not in this ` +
          `browser any more — Import it again.`,
      });
    }
    if ((target.role ?? 'reference') === 'goal') {
      // A GOAL (#533) IS the work, so it is never warned as uncut. It is validated instead
      // ({@link validateGoalObject}), which the pure-goal generate path reuses (#539). #535 — the
      // "posts no cut for it" info belongs to a MIXED job only; a pure goal job is surfaced.
      findings.push(
        ...validateGoalObject(target, job.stock, {
          mixed: pureGoalObject(job) === null,
          minFloor: job.minFloor,
          edgeMargin: job.edgeMargin,
        }),
      );
    } else {
      // A REFERENCE (#435). Saying so once, as a warning, keeps "why is my imported part not being
      // cut?" from being answered by silence; it never blocks the other work.
      findings.push({
        severity: 'warning',
        code: 'target-object-not-cut',
        message:
          `The target object "${target.name}" is a reference: it is shown in the viewport ` +
          `but not cut. Cutting the stock around it is the profile cut-out work; ` +
          `this job's other items are unaffected.`,
      });
    }
  }

  // Plunge drills (#220): depth, reach, stock containment, a centre-cutting tool and the
  // through-cut gate. The tool is resolved once here. A DRILL BIT (#434) is judged by its own
  // geometry: its full diameter is `cuttingDiameter` (the tip diameter when its record states one),
  // and its tip is a POINT LENGTH below that full diameter — so reach uses the diameter and depth
  // uses the point angle, not the flat cutter's radius. `cuttingRadiusForSweep` refuses a drill, so
  // the two shapes take separate answers here while the checks themselves stay one block.
  const drillTool = jobTool(job);
  const drillIsBit = drillTool !== null && drillTool.shape === 'drill';
  const drillDiameter = drillIsBit ? cuttingDiameter(drillTool) : null;
  const drillRadiusResult = drillTool && !drillIsBit ? cuttingRadiusForSweep(drillTool) : null;
  const drillRadius = drillIsBit
    ? drillDiameter !== null && drillDiameter > 0
      ? drillDiameter / 2
      : null
    : drillRadiusResult && drillRadiusResult.ok
      ? drillRadiusResult.radius
      : null;
  // The angle's fallback is the shop's reading when the caller had one; otherwise the same chosen
  // 118° the CAM uses, labelled as a fallback so a message never presents it as measured.
  const drillAngle = drillIsBit
    ? drillPointAngle(drillTool, drillPoint ?? { deg: DRILL_POINT_FALLBACK_DEG, source: 'fallback' })
    : null;
  const drillPointLength =
    drillIsBit && drillAngle !== null && drillAngle.ok && drillDiameter !== null && drillDiameter > 0
      ? pointLength(drillDiameter, drillAngle.deg)
      : 0;
  // #218 — one gate for every through cut. The board must exist AND leave a millimetre under the
  // breakthrough; without it a through cut is a cut into the vise. `throughDepth` is the work
  // depth a through cut reaches, the same number `toPartPlan` gives every through region and
  // cut-out.
  const throughDepth = thickness + job.breakthrough;
  // #712 — on the bed the WASTEBOARD is the board under when the profile puts it there and it is
  // thick enough (decision Q7); a board of the operator's own counts anywhere.
  const bedHeldJob = job.workholding.kind === 'tape' || job.workholding.kind === 'bracket';
  const throughReady =
    (job.sacrificial.under !== null && job.sacrificial.under.thickness >= job.breakthrough + 1) ||
    (bedHeldJob && bed !== null && wasteboardTakesBed(bed, job.breakthrough + 1));
  // #712 — THE BED'S OWN THROUGH RULES, said ONCE (the per-item findings say the rest):
  //   - the house board a bare bed needs must COVER the stock (the design's size sentence);
  //   - a cut may enter the wasteboard only to the shop's depth limit.
  const hasThroughWork =
    enabled.some((i) => 'through' in i && i.through === true) || enabledCutouts.length > 0 || enabledDrills.some((d) => d.through);
  if (hasThroughWork && bedHeldJob && bed !== null) {
    const need = job.breakthrough + 1;
    const have = job.sacrificial.under?.thickness ?? 0;
    if (have < need && !wasteboardTakesBed(bed, need) && !boardCoversStock(bed, job)) {
      const long = bed.boardLengthMm !== null && job.stock.length > bed.boardLengthMm;
      const extent = long ? `${fmt3(job.stock.length)} mm long` : `${fmt3(job.stock.width)} mm wide`;
      findings.push({
        severity: 'error',
        code: 'board-too-small',
        message:
          `The ${bed.boardWords} boards are ${fmt3(bed.boardLengthMm ?? 0)} × ${fmt3(bed.boardWidthMm ?? 0)} mm; ` +
          `this plate is ${extent} — tape it to the wasteboard, or choose a larger board.`,
      });
    }
    // #727 F5/F8 — the depth that ENTERS the wasteboard is the deepest reach less whatever the
    // operator's own board already absorbs: a drill bit's TIP stands a point length below its full
    // diameter (`drillBit.ts`), and a board under the part takes its own thickness first. Judged by
    // the raw breakthrough, a 3 mm 118° drill passed at 0.3 mm while its tip went 1.2 mm in, and a
    // 0.5 mm board that covers all but 0.2 mm of the cut was refused as if it covered none.
    if (wasteboardTakesBed(bed, need)) {
      const throughDrillPoint = enabledDrills.some((d) => d.through) ? drillPointLength : 0;
      const intoWasteboard = Math.round(Math.max(0, job.breakthrough + throughDrillPoint - have) * 1000) / 1000;
      if (intoWasteboard > bed.wasteboardLimitMm) {
        findings.push({
          severity: 'error',
          code: 'wasteboard-depth',
          message:
            `A through cut goes ${fmt3(intoWasteboard)} mm into the wasteboard, deeper than the ` +
            `${fmt3(bed.wasteboardLimitMm)} mm limit — reduce the breakthrough, or put a board under the part.`,
        });
      }
    }
  }
  // #725 W12 — the bracket's own clamps: two on top of each other is a mount that does not hold.
  // The Holding step raises the same sentence beside the picture; this is the DOCUMENT gate's copy,
  // so Generate refuses it before a program is planned (and the blocker's Fix opens Holding).
  if (job.workholding.kind === 'bracket' && options.defaults !== undefined) {
    const read = bracketSettings(options.defaults);
    for (const m of validateBracketMount(
      { x: job.stock.length, y: job.stock.width, z: job.stock.thickness },
      job.workholding.bracket.clamps,
      read,
    )) {
      if (m.code === 'clamps-overlap' || m.code === 'clamp-off-stock') {
        findings.push({ severity: 'error', code: m.code, message: m.text });
      }
    }
  }
  // A profiler needs SHANK clearance, so its limit is `shoulderLength ?? fluteLength` — the same
  // number the sweep's holder gate uses. A drill bit is judged in its own loop by flute length.
  const profilerReach =
    drillTool !== null && !drillIsBit ? (drillTool.shoulderLength ?? drillTool.fluteLength) : null;

  // Through shape pockets (#218). Their depth is the board, so the ordinary floor check above
  // skipped them; these are the two facts that can refuse one.
  for (const item of enabled) {
    if (!('through' in item) || item.through !== true) continue;
    const who = itemLabel(item);
    if (!throughReady) {
      const board = throughBoardFinding(item.id, who, job, bed);
      if (board !== null) findings.push(board);
    } else if (profilerReach !== null && profilerReach > 0 && throughDepth > profilerReach) {
      findings.push({
        severity: 'error',
        code: 'through-tool-reach',
        labelId: item.id,
        message:
          `${who} cuts through to ${fmt3(throughDepth)} mm, past the ${fmt3(profilerReach)} mm of ` +
          `"${drillTool!.name}" above its shank; the holder would rub the blank.`,
      });
    }
  }

  // Cut-outs (#218): every one cuts through, so the same board and reach gates apply, and its
  // `of` reference must resolve. A cut-out is not part of `resolveItems` (it references an
  // outline but produces none), so this is its own reference check.
  const allById = new Map(all.map((item) => [item.id, item] as const));
  for (const cutout of enabledCutouts) {
    const who = cutout.name ? `Cut-out "${cutout.name}"` : 'The cut-out';
    if (drillTool !== null && drillTool.shape !== 'flat') {
      findings.push({
        severity: 'error',
        code: 'cutout-needs-flat',
        labelId: cutout.id,
        message:
          `${who} follows its outline with the side of the cutter, so it needs a flat end mill; ` +
          `"${drillTool.name}" is a ${drillTool.shape} cutter and cannot profile.`,
      });
    }
    if (!throughReady) {
      const board = throughBoardFinding(cutout.id, who, job, bed);
      if (board !== null) findings.push(board);
    } else if (profilerReach !== null && profilerReach > 0 && throughDepth > profilerReach) {
      findings.push({
        severity: 'error',
        code: 'through-tool-reach',
        labelId: cutout.id,
        message:
          `${who} cuts through to ${fmt3(throughDepth)} mm, past the ${fmt3(profilerReach)} mm of ` +
          `"${drillTool!.name}" above its shank; the holder would rub the blank.`,
      });
    }
    if (cutout.tabs.count === 0) {
      findings.push({
        severity: 'warning',
        code: 'released-onto-board',
        labelId: cutout.id,
        message:
          `${who} has no holding tabs, so it is freed onto the board at the end of the cut and is ` +
          'held only by the tape, glue or screws that fixed the blank. A released part can move ' +
          'under the cutter; add tabs if the part must stay put until the program ends.',
      });
    }
    if (cutout.of !== 'stock-inset') {
      const target = allById.get(cutout.of);
      if (target === undefined) {
        findings.push({
          severity: 'error',
          code: 'item-reference',
          labelId: cutout.id,
          message: `${who} follows "${cutout.of}", which is not in the job.`,
        });
      } else if (!target.enabled) {
        findings.push({
          severity: 'error',
          code: 'item-reference',
          labelId: cutout.id,
          message: `${who} follows "${cutout.of}", which is disabled.`,
        });
      }
    }
  }

  const { length, width } = job.stock;
  for (const drill of enabledDrills) {
    const who = drillOperationName(drill);
    // #668 — A BORE TO SIZE is the same item cut a different way: an end mill helixes down the
    // wall of a hole wider than itself. Its three refusals are data-plus-tool facts, raised here
    // so a bad job is named before any toolpath exists (the CAM refuses the same pairs itself).
    const isBore = drill.mode === 'bore';
    const holeRadius = isBore && drill.diameter !== undefined && drill.diameter > 0 ? drill.diameter / 2 : null;
    if (isBore) {
      if (holeRadius === null) {
        findings.push({
          severity: 'error',
          code: 'bore-no-diameter',
          labelId: drill.id,
          message:
            `${who} is a bore with no hole diameter. State the diameter of the hole to cut — ` +
            'a bore makes the hole the job asks for, not the cutter’s width.',
        });
      }
      if (drillTool !== null && drillTool.shape !== 'flat') {
        findings.push({
          severity: 'error',
          code: 'bore-needs-end-mill',
          labelId: drill.id,
          message:
            `${who} helixes down the wall of the hole, so it needs a flat end mill; ` +
            `"${drillTool.name}" is a ${drillTool.shape} cutter and cannot ramp.`,
        });
      }
      if (holeRadius !== null && drillRadius !== null && holeRadius <= drillRadius) {
        findings.push({
          severity: 'error',
          code: 'bore-narrow',
          labelId: drill.id,
          message:
            `${who} asks for a ⌀${fmt3(holeRadius * 2)} mm hole, which is not wider than the ` +
            `⌀${fmt3(drillRadius * 2)} mm cutter. A bore needs a hole wider than the cutter — ` +
            'cut a bigger hole or use a smaller cutter.',
        });
      }
    }
    // A drill bit's tip is the deepest point of the hole; a flat end mill's floor is its depth.
    const tipDepth = drill.depth + drillPointLength;
    const depthAtFloor = drillIsBit ? tipDepth : drill.depth;
    if (drill.through) {
      // #218 — a through hole cuts to the board, not to `drill.depth`. The gate is the one every
      // through cut shares: an under-board exists and is thick enough, and the cutter's flutes
      // cover the breakthrough. A drill needs FLUTES to clear chips, so its limit is
      // `fluteLength` (never `shoulderLength`, which is a profiler's shank-clearance number).
      if (!throughReady) {
        const board = throughBoardFinding(drill.id, who, job, bed);
        if (board !== null) findings.push(board);
      } else if (
        drillTool !== null &&
        drillTool.fluteLength !== null &&
        drillTool.fluteLength > 0 &&
        throughDepth > drillTool.fluteLength
      ) {
        findings.push({
          severity: 'error',
          code: 'through-tool-reach',
          labelId: drill.id,
          message:
            `${who} cuts through to ${fmt3(throughDepth)} mm, past the ${drillTool.fluteLength} mm ` +
            `flute of "${drillTool.name}"; the flutes would be buried and chips could not clear.`,
        });
      }
    } else if (depthAtFloor > floorAllowed) {
      findings.push({
        severity: 'error',
        code: 'depth-exceeds-stock',
        labelId: drill.id,
        message: drillIsBit
          ? `${who}'s tip reaches ${fmt3(tipDepth)} mm (${fmt3(drill.depth)} mm of full diameter ` +
            `plus the ${fmt3(drillPointLength)} mm point); ${overDepthClause(job, tipDepth, facingDepth, floorAllowed)}.`
          : `${who} drills ${drill.depth} mm deep; ${overDepthClause(job, drill.depth, facingDepth, floorAllowed)}.`,
      });
    }
    // A hole is a disc — the cutter's radius for a drill, the HOLE's own radius for a bore — so it
    // is off the stock when its RIM crosses an edge, not just its centre.
    const rimRadius = holeRadius ?? drillRadius;
    if (rimRadius !== null) {
      for (const [hx, hy] of drillHoles(drill)) {
        if (hx - rimRadius < 0 || hx + rimRadius > length || hy - rimRadius < 0 || hy + rimRadius > width) {
          findings.push({
            severity: 'error',
            code: 'drill-outside-stock',
            labelId: drill.id,
            message:
              `${who} has a hole centred at (${hx}, ${hy}) mm whose rim reaches past the stock ` +
              `edge; the cutter must stay on the blank.`,
          });
          break; // one finding per item is enough
        }
      }
    }
  }

  // CHAMFERS (#669): a bevel is cut by a CONE's flank along a rim the job cuts, so every check
  // here is a data-plus-tool fact: the rim must be a profile's part edge or a pocket's wall, the
  // cutter must be a cone, its cone must reach the width, and the tip must stay above the floor.
  // The depth is DERIVED — `width / tan(halfAngle)` — never a document field.
  if (enabledChamfers.length > 0) {
    const chamferTool = jobTool(job);
    const cone = chamferTool === null ? null : vCone(chamferTool);
    const fluteLength = chamferTool === null ? null : vFluteLength(chamferTool);
    const reach = cone !== null && fluteLength !== null ? fluteLength * cone.tanHalf : null;
    // The rim an operator may name: an item whose own profile is a closed edge — a shape, an
    // imported outline or a combined shape. Neither labels nor primitives: a glyph's outline is
    // not a rim a bevel follows, and a primitive is a 3D cut-away, not an edge.
    const rims = new Map<string, EngraveNamedItem>();
    for (const item of [
      ...(job.shapes as readonly EngraveNamedItem[]),
      ...((job.combined ?? []) as readonly EngraveNamedItem[]),
      ...((job.vectors ?? []) as readonly EngraveNamedItem[]),
    ]) {
      rims.set(item.id, item);
    }
    const anyById = new Map<string, EngraveNamedItem>([
      ...all.map((item) => [item.id, item as EngraveNamedItem] as const),
      ...((job.traces ?? []).map((item) => [item.id, item as EngraveNamedItem] as const)),
      ...((job.drills ?? []).map((item) => [item.id, item as EngraveNamedItem] as const)),
      ...((job.threads ?? []).map((item) => [item.id, item as EngraveNamedItem] as const)),
      ...((job.cutouts ?? []).map((item) => [item.id, item as EngraveNamedItem] as const)),
      ...((job.chamfers ?? []).map((item) => [item.id, item as EngraveNamedItem] as const)),
    ]);
    const rimName = (item: EngraveNamedItem): string => itemLabel(item as EngraveAnyItem);
    // One program per (setup, tool). A chamfer is cut by the cone, so a cut-out or a flat-milled
    // pocket is necessarily ANOTHER program — and the order between programs is the operator's,
    // through the setups' order. This is the order the material comes out in, at the program
    // level: a pocket's rim after the pocket, a part's edge before the cut-out frees it.
    const programs = jobSetups(job).flatMap((setup) =>
      setupTools(setup, job).map((toolKey, toolIndex) => new Set(toolItemsFor(setup, toolKey, toolIndex))),
    );
    const programOf = (id: string): number => programs.findIndex((items) => items.has(id));
    const floorOf = (item: EngraveNamedItem | undefined): number | null => {
      if (item === undefined || !('kind' in item)) return null;
      if ('through' in item && item.through === true) return thickness;
      return 'depth' in item && typeof item.depth === 'number' ? item.depth : null;
    };
    const isThroughRim = (item: EngraveNamedItem | undefined): boolean =>
      item === undefined || !('kind' in item) || ('through' in item && item.through === true);
    for (const chamfer of enabledChamfers) {
      const target = chamfer.of === undefined ? undefined : anyById.get(chamfer.of);
      const rim = chamfer.of === undefined ? undefined : rims.get(chamfer.of);
      const who = chamferOperationName(chamfer, rim === undefined ? null : rimName(rim));
      if (chamfer.of === undefined) {
        findings.push({
          severity: 'error',
          code: 'chamfer-needs-edge',
          labelId: chamfer.id,
          message:
            `${who} has no rim yet. A chamfer follows a shape’s or an imported outline’s edge — ` +
            'choose one on the row.',
        });
      } else if (target === undefined) {
        findings.push({
          severity: 'error',
          code: 'item-reference',
          labelId: chamfer.id,
          message: `${who} follows "${chamfer.of}", which is not in the job.`,
        });
      } else if (!target.enabled) {
        findings.push({
          severity: 'error',
          code: 'item-reference',
          labelId: chamfer.id,
          message: `${who} follows "${chamfer.of}", which is disabled.`,
        });
      } else if (rim === undefined) {
        findings.push({
          severity: 'error',
          code: 'chamfer-needs-edge',
          labelId: chamfer.id,
          message:
            `${who} names ${rimName(target)}, which has no closed edge to chamfer. A chamfer ` +
            'follows a shape, an imported outline or a combined shape.',
        });
      } else if (job.setups !== undefined) {
        // The order findings read the WHOLE document's setups. A sub-job — one program's items,
        // its `setups[]` stripped by `jobForSetup` — has no order to judge, and judging it there
        // would fire on every chamfer whose program is not the first.
        const here = programOf(chamfer.id);
        if (chamfer.side === 'outside') {
          // A part's edge: every cut-out that frees this outline must run AFTER the bevel, or the
          // bevel is cut into a released piece.
          const freeing = (job.cutouts ?? []).filter((c) => c.enabled && c.of === rim.id);
          const later = freeing.map((c) => programOf(c.id)).filter((at) => at >= 0);
          const early = later.filter((at) => at <= here);
          if (here >= 0 && early.length > 0) {
            findings.push({
              severity: 'error',
              code: 'chamfer-order',
              labelId: chamfer.id,
              message:
                `${who} is program ${here + 1}, but the cut-out that frees ${rimName(rim)} is ` +
                `program ${early[0]! + 1}. A part’s edge is chamfered BEFORE its cut-out frees the ` +
                'part — put this chamfer’s setup earlier.',
            });
          }
        } else {
          // A pocket's rim: the pocket must be cut FIRST, by another program — a pocket cut by
          // this same cone has a sloping wall, which a bevel does not follow.
          const there = programOf(rim.id);
          if (here >= 0 && there >= 0 && there >= here) {
            findings.push({
              severity: 'error',
              code: 'chamfer-order',
              labelId: chamfer.id,
              message:
                `${who} is program ${here + 1} and its rim ${rimName(rim)} is program ${there + 1}. ` +
                'A pocket’s rim is chamfered AFTER a flat end mill has opened it — the pocket needs ' +
                'its own program, earlier in the run.',
            });
          }
        }
      }
      if (chamferTool === null) continue; // `tool-missing` names the absent cutter already
      if (cone === null) {
        findings.push({
          severity: 'error',
          code: 'chamfer-needs-cone',
          labelId: chamfer.id,
          message:
            `${who} is one flat bevel cut by a cone’s flank, and "${chamferTool.name}" is a ` +
            `${chamferTool.shape} cutter with none. Use a V-bit or a chamfer bit.`,
        });
        continue;
      }
      if (reach === null) {
        findings.push({
          severity: 'error',
          code: 'chamfer-reach-unproven',
          labelId: chamfer.id,
          message:
            `${who} needs the cutter’s cutting diameter to know how wide a chamfer its cone ` +
            `reaches, and "${chamferTool.name}" states none. Record the cutter’s diameter.`,
        });
      } else if (chamfer.width > reach + 1e-9) {
        findings.push({
          severity: 'error',
          code: 'chamfer-too-wide',
          labelId: chamfer.id,
          message:
            `${who} asks for a ${fmt3(chamfer.width)} mm chamfer, but "${chamferTool.name}"’s cone ` +
            `reaches ${fmt3(reach)} mm in one pass (its ${fmt3(fluteLength as number)} mm flute at ` +
            `${fmt3(cone.halfAngleDeg * 2)}°). Use a wider chamfer bit, or a chamfer up to ` +
            `${fmt3(reach)} mm.`,
        });
      }
      // The tip plane is the bevel's bottom: `width / tan(halfAngle)` below the top face. A
      // PART's edge is bounded by the blank's underside; a POCKET's rim by the pocket's own floor.
      const depth = chamfer.width / cone.tanHalf;
      const floor = chamfer.side === 'outside' ? thickness : floorOf(rim);
      if (floor !== null && depth >= floor - 1e-9) {
        findings.push({
          severity: 'error',
          code: 'chamfer-too-deep',
          labelId: chamfer.id,
          message:
            `${who} reaches ${fmt3(depth)} mm below the top face, and ` +
            (chamfer.side === 'outside' || isThroughRim(rim)
              ? `the blank is only ${fmt3(floor)} mm thick`
              : `the pocket’s floor is only ${fmt3(floor)} mm down`) +
            '; the tip would cut past it. Use a smaller chamfer.',
        });
      }
    }
  }

  // ADVANCED V-CARVE (#665): a variable-depth region's depth follows the cone's width at every
  // point, so a flat cutter would pocket it at one depth and silently drop the request. The cap
  // is the item's own depth, whose floor bound the every-item depth checks already hold.
  for (const item of enabled) {
    if (!('vCarveDepth' in item) || item.vCarveDepth !== 'variable') continue;
    const carveTool = jobTool(job);
    if (carveTool === null || vCone(carveTool) !== null) continue;
    findings.push({
      severity: 'error',
      code: 'vcarve-variable-needs-cone',
      labelId: item.id,
      message:
        `${itemLabel(item)} is a variable-depth V-carve, so its depth follows the cutter's flank ` +
        `at every point; "${carveTool.name}" is a ${carveTool.shape} cutter with no cone. Use a V-bit.`,
    });
  }

  // V-CARVE INLAYS (#673). Two checks per half, both data-plus-tool: the pair is a cone's flank
  // (a flat cutter makes no wedge), and the numbers must derive — the glue gap above zero and
  // below the pocket depth. A MALE half is generated, not edited, so its check is that the
  // numbers it stores still describe the cut it carries.
  for (const { item, mark } of inlayMarked(job)) {
    // #728 — a switched-off (or construction) half is not cut, so it asks nothing of the cutter:
    // the recommender counts enabled halves only, and the two must agree.
    if (!item.enabled || item.construction === true) continue;
    const who = itemLabel(item);
    const inlayTool = jobTool(job);
    const inlayCone = inlayTool === null ? null : vCone(inlayTool);
    if (inlayTool === null || inlayCone === null) {
      findings.push({
        severity: 'error',
        code: 'inlay-needs-cone',
        labelId: item.id,
        message:
          inlayTool === null
            ? `${who} is an inlay half, and an inlay is cut by a V-bit's flank: choose a V-bit first.`
            : `${who} is an inlay half, and an inlay is cut by a V-bit's flank; "${inlayTool.name}" ` +
              `is a ${inlayTool.shape} cutter with no cone. Use a V-bit.`,
      });
      continue;
    }
    if (mark.role === 'female' && 'vCarveDepth' in item && item.vCarveDepth === 'variable') {
      findings.push({
        severity: 'error',
        code: 'inlay-plane-depth',
        labelId: item.id,
        message:
          `${who} is a variable-depth V-carve, and an inlay's plug is the PLANE V's mirror: ` +
          'a variable-depth region has no matching plug. Set the V-carve depth back to plane.',
      });
      continue;
    }
    if (mark.role === 'female') {
      const check = inlayNumbers(inlayCone, item.depth, inlayGlueGap(mark));
      if (!check.ok) {
        findings.push({
          severity: 'error',
          code: 'inlay-gap',
          labelId: item.id,
          message: `${who} cannot pair with a plug: ${check.reason}.`,
        });
      }
      continue;
    }
    // The male's numbers are the ones it was BUILT for: its cut depth is the plug's, and its
    // island's erosion is what keeps the plug inside the female's wall.
    if (mark.islandInsetMm === undefined) {
      findings.push({
        severity: 'error',
        code: 'inlay-gap',
        labelId: item.id,
        message:
          `${who} is a male inlay half with no plug inset stored; save the male blank from the ` +
          'female’s job again rather than editing this one.',
      });
      continue;
    }
    if (
      mark.pocketDepthMm !== undefined &&
      mark.tanHalf !== undefined &&
      Math.abs(mark.islandInsetMm - mark.pocketDepthMm * mark.tanHalf) > 1e-6
    ) {
      findings.push({
        severity: 'error',
        code: 'inlay-gap',
        labelId: item.id,
        message:
          `${who} erodes its plug island by ${fmt3(mark.islandInsetMm)} mm, but the island's top ` +
          `face is the plug's tip: at a ${fmt3(mark.pocketDepthMm)} mm pocket the inset is ` +
          `${fmt3(mark.pocketDepthMm * mark.tanHalf)} mm. Save the male blank from the female’s ` +
          'job again.',
      });
      continue;
    }
    if (mark.pocketDepthMm !== undefined && mark.glueGapMm !== undefined) {
      const expected = mark.pocketDepthMm - mark.glueGapMm;
      if (Math.abs(item.depth - expected) > 1e-6) {
        findings.push({
          severity: 'error',
          code: 'inlay-gap',
          labelId: item.id,
          message:
            `${who} cuts ${fmt3(item.depth)} mm deep, but the numbers it was built for ` +
            `(${fmt3(mark.pocketDepthMm)} mm pocket, ${fmt3(mark.glueGapMm)} mm gap) need ` +
            `${fmt3(expected)} mm. Save the male blank from the female’s job again.`,
        });
      }
    }
  }

  // SURFACE TEXTURES (#670). A texture is a seeded pattern of stroke traces over one simple
  // region, cut at the shape's own `depth`. The plan derives nothing for a document finding here
  // (a through texture, an inlay marker, a combined region), so each refusal is the reason a
  // marked shape produces no strokes rather than a second opinion on the plan's numbers. The two
  // warnings report the DERIVED pattern, from the same `textureStrokes` the plan calls.
  const textureTool = jobTool(job);
  const traceTool = textureTool === null ? null : cuttingForTrace(textureTool);
  const texturedShapes = job.shapes.filter(
    (s): s is EngraveShape & { texture: TextureMark } =>
      s.enabled && !s.construction && s.texture !== undefined,
  );
  for (const item of texturedShapes) {
    const who = itemLabel(item);
    if (item.inlay !== undefined) {
      findings.push({
        severity: 'error',
        code: 'texture-shape',
        labelId: item.id,
        message:
          `${who} carries both a texture and an inlay half; the same region cannot be a pattern ` +
          'of strokes and a pocket. Clear one of the two markers.',
      });
      continue;
    }
    if (item.through === true) {
      findings.push({
        severity: 'error',
        code: 'texture-through',
        labelId: item.id,
        message:
          `${who} is a texture, which is a surface finish, not a cut through the blank. Turn ` +
          '`through` off and state the pattern’s depth.',
      });
      continue;
    }
    if (textureTool !== null && traceTool !== null && !traceTool.ok) {
      findings.push({
        severity: 'error',
        code: 'texture-tool',
        labelId: item.id,
        message:
          `${who} is a texture, and a texture is cut as traces; "${textureTool.name}" ` +
          `(${textureTool.shape}) is not a trace cutter. Use a V-bit for dimpled strokes or a ` +
          'flat end mill for flat-bottomed ones.',
      });
      continue;
    }
    const numbers = textureNumbers(item.texture, item.depth);
    const strokes = textureStrokes(item, numbers);
    if (strokes.paths.length === 0) {
      findings.push({
        severity: 'warning',
        code: 'texture-empty',
        labelId: item.id,
        message:
          `${who}’s ${numbers.pattern} pattern comes out empty at a ${fmt3(numbers.pitchMm)} mm ` +
          'pitch over this region; widen the region or narrow the pitch.',
      });
    } else if (strokes.capped) {
      findings.push({
        severity: 'warning',
        code: 'texture-crowded',
        labelId: item.id,
        message:
          `${who}’s pattern wants more than the 4000-` +
          `${numbers.pattern === 'scallop' ? 'run' : 'stroke'} cap at a ${fmt3(numbers.pitchMm)} mm ` +
          'pitch; the program cuts the first 4000. Widen the pitch to cut the whole region.',
      });
    }
  }
  for (const item of job.combined ?? []) {
    if (!item.enabled || item.texture === undefined) continue;
    findings.push({
      severity: 'error',
      code: 'texture-shape',
      labelId: item.id,
      message:
        `${itemLabel(item)} carries a texture, but a texture sits on a rectangle, circle, slot ` +
        'or polygon: a border, frame or cutaway has holes, so the pattern has no one region to ' +
        'fill. Draw the area as a shape of its own.',
    });
  }

  // FLUTES (#674). A flute is a line cut with a Z profile instead of a plunge: the tool starts on
  // the surface and feeds down, and back up at the other end. Two things can be wrong with the
  // document — a cutter the trace path refuses, and ramps that overlap because the line is short —
  // and both are stated with the numbers the plan will run.
  const fluteTool = jobTool(job);
  const traceCapable = fluteTool === null ? null : cuttingForTrace(fluteTool);
  for (const trace of job.traces ?? []) {
    if (!trace.enabled || trace.construction || trace.kind !== 'line' || trace.flute === undefined) continue;
    const who = fluteOperationName(trace);
    if (fluteTool !== null && traceCapable !== null && !traceCapable.ok) {
      findings.push({
        severity: 'error',
        code: 'flute-tool',
        labelId: trace.id,
        message:
          `${who} is a flute, and a flute is cut as a trace; "${fluteTool.name}" (${fluteTool.shape}) ` +
          'is not a trace cutter. Use a V-bit for a V groove or a flat end mill for a flat-bottomed one.',
      });
      continue;
    }
    const numbers = fluteNumbers(trace.flute, trace.depth);
    const pathLength = lineLength(trace.points, trace.closed);
    if (2 * numbers.rampMm >= pathLength) {
      const peak = pathLength > 0 ? (trace.depth * pathLength) / (2 * numbers.rampMm) : 0;
      findings.push({
        severity: 'warning',
        code: 'flute-short',
        labelId: trace.id,
        message:
          `${who}: the path is ${fmt3(pathLength)} mm long and its two ${fmt3(numbers.rampMm)} mm ` +
          `ramps overlap, so the groove peaks at ${fmt3(peak)} mm instead of the stated ` +
          `${fmt3(trace.depth)} mm. Shorten the ramp or lengthen the line.`,
      });
    }
  }

  // RAISED PRISMS (#674). The V's flank IS the shape's side, so a prism needs a cone, and a side
  // can only stand as high as that cone's own flank reaches (#741 review); its base is cleared by
  // the tip flat, so it needs a tipped V and a base wider than that flat twice. Each refusal is
  // the reason the ring the plan derives would not cut what the document asks for.
  const prismTool = jobTool(job);
  const prismCone = prismTool === null ? null : vCone(prismTool);
  for (const item of job.shapes) {
    if (!item.enabled || item.construction || item.prism === undefined) continue;
    const who = itemLabel(item);
    if (item.texture !== undefined || item.inlay !== undefined || item.vCarveDepth === 'variable') {
      findings.push({
        severity: 'error',
        code: 'prism-shape',
        labelId: item.id,
        message:
          `${who} is marked as a prism, and a prism is one plane region: it cannot also be a ` +
          'texture, an inlay half, or a variable-depth V-carve. Clear the other marker.',
      });
      continue;
    }
    if (item.through === true) {
      findings.push({
        severity: 'error',
        code: 'prism-shape',
        labelId: item.id,
        message:
          `${who} is a raised prism, which stands ON the blank; a through cut has nothing to ` +
          'stand on. Turn `through` off.',
      });
      continue;
    }
    const check = prismNumbers(prismCone, item.depth, item.prism);
    const n = check.numbers;
    if (check.ok) continue;
    if (check.code === 'prism-needs-cone') {
      findings.push({
        severity: 'error',
        code: 'prism-needs-cone',
        labelId: item.id,
        message:
          prismTool === null
            ? `${who} is a raised prism, and a prism's sides are a V-bit's flank: choose a V-bit first.`
            : `${who} is a raised prism, and a prism's sides are a V-bit's flank; "${prismTool.name}" ` +
              `is a ${prismTool.shape} cutter with no cone. Use a V-bit.`,
      });
      continue;
    }
    if (check.code === 'prism-height') {
      findings.push({
        severity: 'error',
        code: 'prism-height',
        labelId: item.id,
        message: prismHeightRefusal(who, n, prismTool === null ? null : prismTool.name),
      });
      continue;
    }
    if (check.code === 'prism-tip') {
      findings.push({
        severity: 'error',
        code: 'prism-tip',
        labelId: item.id,
        message:
          `${who} is a raised prism, and its base is cleared by the cutter's tip flat; ` +
          `"${prismTool === null ? 'the cutter' : prismTool.name}" has a point tip, which leaves ` +
          `the ${fmt3(n.baseMm)} mm base as ridges. Use a V-bit with a tip diameter.`,
      });
      continue;
    }
    findings.push({
      severity: 'error',
      code: 'prism-base',
      labelId: item.id,
      message:
        `${who}'s base is ${fmt3(n.baseMm)} mm, but the tip's flat is ${fmt3(2 * (n.planeRadiusMm - n.slopeWidthMm))} mm ` +
        "across, so the tip has no path between the shape's slope and the base's outer bevel. " +
        `Widen the base past ${fmt3(2 * (n.planeRadiusMm - n.slopeWidthMm))} mm, or use a smaller tip.`,
    });
  }
  for (const item of job.combined ?? []) {
    if (!item.enabled || item.prism === undefined) continue;
    findings.push({
      severity: 'error',
      code: 'prism-shape',
      labelId: item.id,
      message:
        `${itemLabel(item)} is marked as a prism, but a prism sits on a rectangle, circle, slot or ` +
        'polygon: a border, frame or cutaway has holes, so there is no one outline for the slope ' +
        'to stand on. Draw the shape as its own region.',
    });
  }

  // MILLED THREADS (#445, #434 phase 2). A thread mill does not drill (D1): every check here
  // assumes the pilot, and the pilot's existence is a WARNING with the uncertainty named, because
  // no program in this app cut it and no document proves it. The CAM is the exact gate for the
  // fit; these checks report the same rules on the document as data, so a bad job is refused
  // before a toolpath exists.
  //
  // The run-out charged below is ONE PITCH. `validateJob` is pure and cannot read the location's
  // `thread.bottomClearancePitches`, so it takes the smallest run-out the CAM may use from the
  // thread itself; the CAM's plan and the verifier's `cut-too-deep` carry the exact number when
  // the setting says otherwise. The floor check therefore errs toward the user, not away.
  if (enabledThreads.length > 0) {
    const threadTool = jobTool(job);
    const threadDiameter = threadTool === null ? null : cuttingDiameter(threadTool);
    if (threadTool !== null && threadTool.shape !== 'thread') {
      findings.push({
        severity: 'error',
        code: 'thread-wrong-tool',
        labelId: enabledThreads[0]!.id,
        message:
          `The job has a thread, but the tool is "${threadTool.name}" (${threadTool.shape}), not a ` +
          `thread mill. A thread is cut by orbiting a small cutter inside the pilot; a flat end mill ` +
          `cannot cut one.`,
      });
    }
    // One program has one tool (D1). A thread beside any other enabled cut would need a tool
    // change mid-program, which `ToolpathIR` cannot describe.
    const otherWork: string[] = [
      ...enabled.filter(itemHasWork).map(itemLabel),
      ...enabledTraces.filter(traceHasWork).map(traceOperationName),
      ...enabledDrills.map(drillOperationName),
      ...cuttablePrimitives.map(primitiveOperationName),
    ];
    if (otherWork.length > 0) {
      findings.push({
        severity: 'error',
        code: 'thread-mixed-tools',
        labelId: enabledThreads[0]!.id,
        message:
          `A thread program has ONE tool (the thread mill), but this job also cuts ` +
          `${otherWork[0]}${otherWork.length > 1 ? ` and ${otherWork.length - 1} other item(s)` : ''}. ` +
          `Cut the thread in its own program, after the pilot and any other work is done.`,
      });
    }

    for (const thread of enabledThreads) {
      const who = threadOperationName(thread);
      const { major, pitch, minor } = FASTENERS[thread.size];
      const runOut = pitch;

      if (thread.through) {
        findings.push({
          severity: 'error',
          code: 'thread-through-unavailable',
          labelId: thread.id,
          message:
            `${who} asks to thread through the blank, which needs a sacrificial board and ` +
            `the through-cut depth rules; neither is in yet, so the thread is refused rather ` +
            `than cut into the vise.`,
        });
      } else {
        const tipDepth = thread.depth + runOut;
        if (tipDepth > floorAllowed) {
          findings.push({
            severity: 'error',
            code: 'thread-too-deep',
            labelId: thread.id,
            message:
              `${who} threads ${thread.depth} mm, and its tip runs about ${Number(runOut.toFixed(3))} mm ` +
              `below the last full thread; on a ${thickness} mm stock that leaves less than the ` +
              `${job.minFloor} mm minimum floor.`,
          });
        }
        if (threadTool !== null && threadTool.fluteLength !== null && threadTool.fluteLength > 0 && tipDepth > threadTool.fluteLength) {
          findings.push({
            severity: 'error',
            code: 'thread-too-deep',
            labelId: thread.id,
            message:
              `${who} needs ${Number(tipDepth.toFixed(3))} mm of flute (the thread plus its run-out), ` +
              `past the ${threadTool.fluteLength} mm flute of "${threadTool.name}".`,
          });
        }
      }

      // The two physical checks D2 says the planner can make from the item and the tool alone:
      // the cutter must enter the pilot, and its radius must span the thread's radial depth.
      if (threadTool !== null && threadTool.shape === 'thread' && threadDiameter !== null) {
        if (threadDiameter >= minor) {
          findings.push({
            severity: 'error',
            code: 'thread-cutter-fit',
            labelId: thread.id,
            message:
              `${who}: the ${threadDiameter} mm cutting diameter cannot enter the ⌀${minor} mm pilot ` +
              `of ${thread.size} (the tool must be smaller than the thread's minor diameter).`,
          });
        } else if (threadDiameter < (major - minor) / 2) {
          findings.push({
            severity: 'error',
            code: 'thread-cutter-fit',
            labelId: thread.id,
            message:
              `${who}: the ${threadDiameter} mm cutting diameter spans less than the ` +
              `${Number(((major - minor) / 2).toFixed(3))} mm radial depth of ${thread.size} ` +
              `(⌀${major} over ⌀${minor}); the tooth cannot reach the major diameter.`,
          });
        }
      }

      // The thread is a disc of the MAJOR radius — the widest the orbit reaches — so it is off
      // the stock when that rim crosses an edge, not just its axis.
      const r = major / 2;
      if (thread.position.x - r < 0 || thread.position.x + r > length || thread.position.y - r < 0 || thread.position.y + r > width) {
        findings.push({
          severity: 'error',
          code: 'thread-off-stock',
          labelId: thread.id,
          message:
            `${who} is centred at (${thread.position.x}, ${thread.position.y}) mm and its ` +
            `⌀${major} mm thread reaches past the stock edge; the thread must stay on the blank.`,
        });
      }

      findings.push({
        severity: 'warning',
        code: 'thread-pilot-unproven',
        labelId: thread.id,
        message:
          `${who} assumes a ⌀${minor} mm pilot (${thread.size} basic minor) at least ` +
          `${Number((thread.depth + pitch).toFixed(3))} mm deep is ALREADY in the blank. This program ` +
          `cuts the thread only and never the pilot (D1); drill and measure the pilot first.`,
      });

      if (threadTool !== null && threadTool.fluteLength === null) {
        findings.push({
          severity: 'warning',
          code: 'thread-flute-unproven',
          labelId: thread.id,
          message:
            `Nothing recorded for "${threadTool.name}" states its flute length, so the run-out has ` +
            `not been shown to clear the flutes; the owned cutters' recorded lengths would settle it.`,
        });
      }
    }
  }

  // A plunge needs a CENTRE-CUTTING cutter. The tool record does not carry the field (#220), so
  // a parsed or generic tool is `null` — unknown. That is a WARNING with the uncertainty named,
  // never a silent plunge; a tool explicitly recorded as not centre-cutting is an ERROR.
  if (enabledDrills.length > 0 && drillTool) {
    if (drillTool.centreCutting === false) {
      findings.push({
        severity: 'error',
        code: 'plunge-unproven',
        labelId: enabledDrills[0]!.id,
        message:
          `The job drills, but "${drillTool.name}" is recorded as NOT centre-cutting: it cannot ` +
          `plunge straight down without a pilot hole.`,
      });
    } else if (drillTool.centreCutting === null && !drillIsBit) {
      // A DRILL BIT is centre-cutting by construction (#434): its point is the cutting end, so
      // the flat cutter's unproven-plunge warning would be a false doubt. The explicit `false`
      // above still fires: a record that says so is a contradiction worth showing.
      findings.push({
        severity: 'warning',
        code: 'plunge-unproven',
        labelId: enabledDrills[0]!.id,
        message:
          `The job drills, but nothing recorded for "${drillTool.name}" says it is centre-cutting ` +
          `(the .nc header has no such field); an owned cutter's own record settles it.`,
      });
    }
    // A peck must fit inside the flute: beyond it the chips have nowhere to go. A drill bit's
    // TIP is the deepest point, so the whole tip depth — hole plus point — has to fit.
    if (drillTool.fluteLength !== null && drillTool.fluteLength > 0) {
      for (const drill of enabledDrills) {
        // A through drill's reach is judged by `through-tool-reach` against the board depth, not
        // against `drill.depth` (which it does not use). One owner for the number.
        if (drill.through) continue;
        const needed = drill.depth + drillPointLength;
        if (needed > drillTool.fluteLength) {
          findings.push({
            severity: 'error',
            code: 'drill-too-deep',
            labelId: drill.id,
            message: drillIsBit
              ? `${drillOperationName(drill)} needs ${fmt3(needed)} mm of flute (the ${fmt3(drill.depth)} mm ` +
                `hole plus its ${fmt3(drillPointLength)} mm point), past the ${drillTool.fluteLength} mm ` +
                `flute of "${drillTool.name}": once the flutes are buried, chips cannot clear.`
              : `${drillOperationName(drill)} drills ${drill.depth} mm, past the ${drillTool.fluteLength} mm ` +
                `flute of "${drillTool.name}": once the flutes are buried, chips cannot clear.`,
          });
        }
      }
    }
    // #434 — a drill bit is the cutter of a DRILL-ONLY program. This is checked here, on the job's
    // own document, only when there is no `setups[]`: a setup job's cutters are per setup and the
    // generator judges each setup's sub-job (which carries one materialised cutter) with this same
    // function. A legacy document pairing the drill with a region, trace or thread would otherwise
    // reach the drill branch with work the bit cannot do.
    if (drillIsBit && job.setups === undefined) {
      const otherWork: string[] = [
        ...enabled.map(itemLabel),
        ...enabledTraces.map(traceOperationName),
        ...enabledThreads.map(threadOperationName),
        ...cuttablePrimitives.map(primitiveOperationName),
      ];
      if (otherWork.length > 0 && !findings.some((f) => f.code === 'drill-mixed-tools')) {
        findings.push({
          severity: 'error',
          code: 'drill-mixed-tools',
          labelId:
            enabledDrills[0]?.id ??
            enabled[0]?.id ??
            enabledTraces[0]?.id ??
            enabledThreads[0]?.id ??
            enabledPrimitives[0]?.id,
          message:
            `"${drillTool.name}" is a drill bit, but this job also cuts ${otherWork[0]}` +
            `${otherWork.length > 1 ? ` and ${otherWork.length - 1} other item(s)` : ''}. A drill ` +
            `program cuts drilled holes only; give the other work to an end mill in another setup ` +
            `or cutter.`,
        });
      }
    }
  }

  // A frame/cutaway (#215) must name an item that exists, is enabled and forms no cycle.
  // `resolveItems` reports one error per bad reference; here it becomes a finding.
  for (const error of resolveItems(job).errors) {
    const src = all.find((item) => item.id === error.itemId);
    const who = src ? itemLabel(src) : `Item ${error.itemId}`;
    const message =
      error.reason === 'self'
        ? `${who} references itself; a shape cannot be its own outline.`
        : error.reason === 'missing'
          ? `${who} references "${error.referencedId}", which is not in the job.`
          : error.reason === 'disabled'
            ? `${who} references "${error.referencedId}", which is disabled.`
            : `${who} and "${error.referencedId}" reference each other in a cycle; ` +
              'one of them must not depend on the other.';
    findings.push({ severity: 'error', code: 'item-reference', labelId: error.itemId, message });
  }

  // A self-intersecting polygon is not a region — the fill rule would invent one (#214). It is
  // reported so the worker drops the cut, rather than cutting whatever the crossing makes.
  for (const shape of job.shapes) {
    if (
      shape.enabled &&
      !shape.construction &&
      shape.kind === 'polygon' &&
      polygonSelfIntersects(shape.points)
    ) {
      findings.push({
        severity: 'error',
        code: 'polygon-self-intersecting',
        labelId: shape.id,
        message: `${itemLabel(shape)} crosses itself; fix the points so the outline is a simple region.`,
      });
    }
  }

  // #516 item 5 — "has work" is the negation of the `no-items` test below, computed once so the
  // tool-missing gate reads the same answer. ANY enabled primitive counts as stated work: a
  // refused cone/sphere already has its own by-name error, so "nothing to do" would be a second,
  // misleading complaint about the shape the person drew.
  //
  // #535 — a PURE GOAL job's work is the goal mesh itself: it posts the surfacing program, so it
  // must not read as "nothing to cut" (a job emptied of its items to add Surface a mesh is the
  // ordinary way to build one).
  const pureGoal = pureGoalObject(job);
  const hasWork =
    enabled.some(itemHasWork) ||
    enabledTraces.some(traceHasWork) ||
    enabledDrills.length > 0 ||
    enabledThreads.length > 0 ||
    enabledPrimitives.length > 0 ||
    enabledCutouts.length > 0 ||
    enabledChamfers.length > 0 ||
    (options.derivedCores ?? 0) > 0 ||
    pureGoal !== null;

  if (!hasWork) {
    findings.push({
      severity: 'error',
      code: 'no-items',
      message:
        'Nothing to cut yet — add an operation, or turn one back on.',
    });
  }

  // #516 item 5 — a job with no items has no tool finding, and a job with items but NO cutter
  // chosen yet (the empty key a fresh default job / import route starts from) is the normal
  // pre-recommendation state, not an error. The finding is only for a REAL key that names nothing:
  // a stale or hand-typed cutter the library does not hold.
  if (jobTool(job) === null && hasWork && job.toolKey !== NO_TOOL_KEY) {
    findings.push({
      severity: 'error',
      code: 'tool-missing',
      message: `Tool key "${job.toolKey}" is not in the tool library.`,
    });
  }

  // #488 — THE JAW RULE IS GEOMETRIC. A blank below the jaw tops is not a refusal by itself: what
  // decides is whether a cut can reach a jaw. Every enabled cut's SWEPT extent (`sweptCuts`: the
  // outline for an engrave — a label or a pocket — the line plus its cutter radius for a trace, a
  // disc for a drill or a thread) is measured against the jaw faces `viseEnvelope` places, and the
  // job's own `jawClearance` (#362) is the margin it must keep. Only a cut that comes inside that
  // margin is refused. The reading is the STATED geometry, with no uncertainty band: a refusal is
  // an instruction, and it must be shown by the numbers the job holds rather than by a band the
  // real jaw may or may not fill.
  const jawClearance = job.jawClearance;
  // #240 — the jaw rule is the VISE's, and a job in the rotary chuck has no jaw faces to reach.
  // Slice 1 reads no swept cuts for it at all; slice 3's rotary rules are what will judge the cut
  // against the chuck, the tailstock and the stock's own cylinder.
  const swept = job.workholding.kind === 'vise' ? sweptCuts(job) : [];
  for (const cut of swept) {
    const { jaw, gap } = jawGapFor(job, cut.box);
    if (gap >= jawClearance) continue;
    findings.push({
      severity: 'error',
      code: 'vise-jaw-collision',
      labelId: cut.id,
      message:
        `${cut.name} comes within ${fmt3(gap)} mm of the ${jaw} jaw face; the job keeps ` +
        `${fmt3(jawClearance)} mm clear, so the cutter would run into the jaw. ` +
        `Move the cut in from the jaw by ${fmt3(jawClearance - gap)} mm` +
        // #406's packer advice, moved here (#488 item 2): raising the blank only answers a blank
        // that sits below the jaw tops, and it is one of two answers, not the rule.
        (jobVise(job).stockProud <= 0
          ? `, or raise the blank on a packer so it works above the jaw tops and state how far it then stands proud.`
          : '.'),
    });
  }

  // A round piece's CUT FACE is a circle inscribed in the square the job plans in (#683, §3.3).
  // The square's corners are air; a cut that reaches one is a pass over nothing, and at the front or
  // left it can be over the jaw zone the square reports as stock. Test the swept box's four corners
  // against the face's circle, less the job's edge margin: a convex box is inside the circle exactly
  // when all four are. The diameter is the smaller side, so a stored rectangle that is not square
  // still gets the circle the round face can actually fill.
  //
  // #743 D7 — ROUND IS A FACT ABOUT THE STOCK, not about where it came from: the job reads
  // `stock.shape`, so a disc described by a document with NO stock entry (j04) is checked too. A
  // pre-#743 document states round only through its entry's form (`disc` or `rod`) and has no
  // shape, and keeps that reading — the entry is the only statement it carries.
  const roundShape = job.stock.shape;
  const legacyRound =
    roundShape === undefined &&
    (job.stockEntry?.form === 'disc' || job.stockEntry?.form === 'rod');
  if (roundShape === 'disc' || roundShape === 'cylinder' || legacyRound) {
    const disc = roundShape === 'disc';
    const diameter = Math.min(job.stock.length, job.stock.width);
    const radius = diameter / 2 - job.edgeMargin;
    for (const cut of swept) {
      // #743 — THE READING IS THE REGION'S REACH, not its box's corners. A centred ⌀26 pocket in
      // a ⌀30 disc has corners in the air outside the rim it never enters; `reach` is the upper
      // bound read from the profile and the path (see `SweptCut.reach`).
      if (cut.reach <= radius + 1e-6) continue;
      findings.push({
        severity: 'error',
        code: 'item-off-round-stock',
        labelId: cut.id,
        message:
          `${cut.name} reaches past the ⌀${fmt3(diameter)} mm face of the ${disc ? 'disc' : 'round stock'}: the ` +
          `${fmt3(job.stock.length)} × ${fmt3(job.stock.width)} mm box around it has air at its ` +
          `corners, and the cut runs into that air. Keep it inside the circle, ` +
          `${fmt3(job.edgeMargin)} mm in from the edge.`,
      });
    }
    // #743 — REFERENCE-ONLY ITEMS SIT ON THE FACE TOO. A construction label is not cut, but it is
    // where the design's material stays; the issue's own acceptance moves "Software" 2 mm out to
    // see this refusal, and a job with NO stock entry carries no form to read it from — which is
    // exactly why the check now reads `stock.shape` (#743 D7). A referenced combination (border,
    // frame, cutaway) resolves only with the plan's context; those are the cut reading's, above.
    for (const item of resolveItems(job).order) {
      if (!item.enabled || !item.construction) continue;
      const profile = itemProfile(item, job.customFonts);
      const reach = profileReachFrom(profile, [job.stock.length / 2, job.stock.width / 2]);
      if (reach <= radius + 1e-6) continue;
      findings.push({
        severity: 'error',
        code: 'item-off-round-stock',
        labelId: item.id,
        message:
          `${itemOperationName(item)} reaches past the ⌀${fmt3(diameter)} mm face of the ${disc ? 'disc' : 'round stock'}: ` +
          `it sits outside the circle the stock actually has. Keep it inside the circle, ` +
          `${fmt3(job.edgeMargin)} mm in from the edge.`,
      });
    }
  }

  // The cutter also has to REACH the depth: the jaw tops are at `−stockProud`, so a cut `d` deep
  // works `d − stockProud` below them, and the flutes must cover that with the same clearance
  // kept. Only a cutter that states its flute length can be judged; one that does not is the
  // record's own uncertainty (`thread-flute-unproven`'s pattern), not a refusal invented here.
  const deepestCut = swept.reduce<SweptCut | null>(
    (deepest, cut) => (deepest === null || cut.depth > deepest.depth ? cut : deepest),
    null,
  );
  const cuttingTool = jobTool(job);
  const belowJawTops = deepestCut === null ? 0 : deepestCut.depth - jobVise(job).stockProud;
  if (
    cuttingTool !== null &&
    cuttingTool.fluteLength !== null &&
    deepestCut !== null &&
    belowJawTops > cuttingTool.fluteLength - jawClearance
  ) {
    findings.push({
      severity: 'error',
      code: 'vise-jaw-collision',
      labelId: deepestCut.id,
      message:
        `${deepestCut.name} cuts ${fmt3(deepestCut.depth)} mm deep, which is ${fmt3(belowJawTops)} mm ` +
        `below the jaw tops; the ${fmt3(cuttingTool.fluteLength)} mm flute of "${cuttingTool.name}" reaches ` +
        `${fmt3(cuttingTool.fluteLength - jawClearance)} mm with ${fmt3(jawClearance)} mm kept clear. ` +
        `Use a cutter with a longer flute, or raise the blank so the cut works less far below the jaw tops.`,
    });
  }

  // #488 item 2 — a blank BELOW the jaw tops is a NOTE, not an error. The cuts above are the whole
  // question and every one of them kept the margin, so the note says the fact and the result: the
  // operator is not asked to find a packer the job does not need.
  if (
    jobVise(job).stockProud <= 0 &&
    swept.length > 0 &&
    !findings.some((f) => f.code === 'vise-jaw-collision')
  ) {
    findings.push({
      severity: 'warning',
      code: 'vise-stock-not-proud',
      message:
        `The blank sits ${fmt3(-jobVise(job).stockProud)} mm below the jaw tops; the cut ` +
        `stays at least ${fmt3(jawClearance)} mm clear of the jaws, so it needs no packer.`,
    });
  }

  // The unmeasured-vise warning is NOT raised here (#353): `validateVise` owns `vise-default`, so
  // the vise has exactly one validator saying so, and a consumer that shows only vise findings
  // (`blankViseFindings`) is not the one place that goes silent about it. Every consumer that
  // needs the whole picture merges the two lists through `dedupeFindings` below.

  // A trace whose cutter-swept strokes come closer than the cutter width fills in (#219): the
  // letters merge. A warning, not an error — the cut still exists, it is just not what was drawn.
  // It needs the cutter's width, so it is skipped when the job names no cutter the trace path can
  // take. Since #405 that width is a FUNCTION of the trace's own depth — a V-bit's groove opens as
  // it deepens — so the radius is asked per trace rather than resolved once.
  const tool = jobTool(job);
  if (tool) findings.push(...traceSelfOverlapFindings(job, (depth) => traceRadiusAt(tool, depth)));

  findings.push(...validateSacrificial(job));
  // #677 — a derived-work program (the core clearance) has no items by construction, and its
  // sub-job has no stored setups: the setup split has nothing to judge there. The run's own
  // whole-job pass owns that question.
  if ((options.derivedCores ?? 0) === 0) findings.push(...setupProgramFindings(job));

  return findings;
}

/** A line item's path length, mm: its segments, plus the closing one for a ring (#674). */
function lineLength(points: readonly (readonly [number, number])[], closed: boolean): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  if (closed && points.length >= 2) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    total += Math.hypot(first[0] - last[0], first[1] - last[1]);
  }
  return total;
}

/** A printed millimetre figure: rounded to 0.001, trailing zeros dropped (`2.0` → `2`, `2.61`). */
function fmt3(n: number): number {
  return Number(n.toFixed(3));
}

/**
 * The cutters a setup runs, in order. A setup naming none falls back to the job's cutter so the
 * reading is total; {@link setupProgramFindings} reports the empty case so the fallback is never
 * silent.
 */
export function setupTools(setup: JobSetup, job: EngraveJob): string[] {
  if (setup.tools.length > 0) return [...setup.tools];
  // #516 item 5 — a setup naming none falls back to the job's cutter only when the job HAS one;
  // a job with no cutter yet posts no program (the recommendation fills it in on the first
  // Generate / first visit to Tools).
  return job.toolKey === NO_TOOL_KEY ? [] : [job.toolKey];
}

/**
 * The items a cutter owns, in setup order — the one reading of `toolItems` used by both the
 * program split and its validation (#472).
 *
 * With no map, the first cutter owns every item and the rest own none (their work is measured).
 * With a map, the list is filtered through `itemIds`, so a stale assignment cannot resurrect an
 * item that left the setup, and the setup's order is what the program cuts.
 */
export function toolItemsFor(setup: JobSetup, toolKey: string, toolIndex = 0): string[] {
  const stored = setup.toolItems?.[toolKey];
  if (stored !== undefined) {
    const wanted = new Set(stored);
    return setup.itemIds.filter((id) => wanted.has(id));
  }
  if (setup.toolItems !== undefined) return [];
  return toolIndex === 0 ? [...setup.itemIds] : [];
}

/** `a`, `a and b`, `a, b and c` — a list in a finding's sentence. */
function words(ids: readonly string[]): string {
  if (ids.length <= 1) return ids.join('');
  return `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`;
}

/**
 * Every setup must be postable as exactly one program per cutter (#419 J3, #472): a setup naming
 * no cutter has nothing to post; one naming several states which items each cutter owns, or leaves
 * the first cutter owning all of them and the later ones as rest passes.
 *
 * The assignment is checked here rather than in `programs.ts` because the GENERATOR needs it on the
 * WHOLE job: `engraveRegions` validates the per-setup sub-job, which carries one `toolKey` by
 * construction, so the multi-tool case can only be seen before the split. Exported so the run's own
 * findings list says the same thing the panel's validation does.
 */
export function setupProgramFindings(job: EngraveJob): JobFinding[] {
  const findings: JobFinding[] = [];
  // #535 — A PURE GOAL JOB's derived setup has no items BY DESIGN: the goal mesh is the setup's
  // one program (the surfacing pass). The rest-pass bookkeeping below measures a clearing program
  // from the setup's items, which does not apply, so there is nothing here to refuse.
  if (pureGoalObject(job) !== null) return findings;
  // Every enabled cutting item by id, for the drill-tool check below (#434): a drill bit owns
  // drills, never a region/trace/thread. Disabled and construction items are not work.
  const workById = new Map<string, string>();
  for (const item of [...job.labels, ...job.shapes, ...(job.combined ?? []), ...(job.vectors ?? [])]) {
    if (item.enabled && !item.construction) workById.set(item.id, itemLabel(item));
  }
  for (const trace of job.traces ?? []) {
    if (trace.enabled && !trace.construction) workById.set(trace.id, traceOperationName(trace));
  }
  for (const thread of job.threads ?? []) {
    if (thread.enabled) workById.set(thread.id, threadOperationName(thread));
  }
  // #435 — a cuttable primitive is region work, so a setup may assign it and the drill-tool check
  // has to see it as work the bit cannot do.
  for (const primitive of job.primitives ?? []) {
    if (primitive.enabled && primitiveReducesToRegion(primitive)) {
      workById.set(primitive.id, primitiveOperationName(primitive));
    }
  }
  for (const cutout of job.cutouts ?? []) {
    if (cutout.enabled) workById.set(cutout.id, cutoutOperationName(cutout, null));
  }
  jobSetups(job).forEach((setup, i) => {
    const tools = setupTools(setup, job);
    if (setup.tools.length === 0) {
      // #516 item 5 — a SAVED setup that names no cutter is refused (`setup-no-tool`); the derived
      // IMPLICIT setup of a tool-less job names none because the job has none to name, which is the
      // normal pre-recommendation state, not an error. Either way there is no cutter to iterate.
      if (job.setups !== undefined) {
        findings.push({
          severity: 'error',
          code: 'setup-no-tool',
          message: `Setup ${i + 1} names no cutter, so there is nothing to write a program for.`,
        });
      }
      return;
    }

    const known = new Set(setup.tools);
    const itemSet = new Set(setup.itemIds);
    if (setup.toolItems !== undefined) {
      const claimed = new Map<string, string[]>();
      for (const [toolKey, ids] of Object.entries(setup.toolItems)) {
        if (!known.has(toolKey)) {
          findings.push({
            severity: 'error',
            code: 'setup-tool-unknown',
            message:
              `Setup ${i + 1} assigns items to "${toolKey}", which is not one of its cutters ` +
              `(${setup.tools.join(', ')}).`,
          });
        }
        const unknown = ids.filter((id) => !itemSet.has(id));
        if (unknown.length > 0) {
          findings.push({
            severity: 'error',
            code: 'setup-tool-unknown',
            message:
              `Setup ${i + 1} assigns ${unknown.length === 1 ? 'an item' : `${unknown.length} items`} ` +
              `that ${unknown.length === 1 ? 'is' : 'are'} not in it: ${words(unknown)}.`,
          });
        }
        for (const id of ids) {
          if (!itemSet.has(id)) continue;
          claimed.set(id, [...(claimed.get(id) ?? []), toolKey]);
        }
      }

      const duplicated = [...claimed.entries()].filter(([, keys]) => keys.length > 1);
      for (const [id, keys] of duplicated) {
        findings.push({
          severity: 'error',
          code: 'setup-items-duplicated',
          message:
            `Setup ${i + 1} assigns item "${id}" to more than one cutter (${keys.join(', ')}). ` +
            'An item is cut once: give it to one cutter.',
        });
      }

      const unassigned = setup.itemIds.filter((id) => !claimed.has(id));
      if (unassigned.length > 0) {
        findings.push({
          severity: 'error',
          code: 'setup-items-unassigned',
          message:
            `Setup ${i + 1} names no cutter for ${unassigned.length === 1 ? 'an item' : `${unassigned.length} items`} ` +
            `(${words(unassigned)}), so ${unassigned.length === 1 ? 'it' : 'they'} would not be cut.`,
        });
      }
    }

    const firstItems = toolItemsFor(setup, tools[0]!, 0).filter((id) => itemSet.has(id));
    if (firstItems.length === 0) {
      findings.push({
        severity: 'error',
        code: 'setup-tool-no-items',
        message:
          `Setup ${i + 1}'s first cutter (${tools[0]}) has no items, so there is no clearing ` +
          'program to measure the rest from. Assign it at least one item, or remove it.',
      });
    }

    // #434 — a DRILL BIT cuts that setup's drilled holes only. Its program is the drill's own
    // (#434), not a clearing/rest pass: a region, trace or thread assigned to it is work the bit
    // cannot do, and one program has one tool. The generator's sub-job check sees the same fact
    // with the cutter materialised; this one lets the panel say it before Generate.
    tools.forEach((toolKey, toolIndex) => {
      const entryTool = toolForJob(
        { toolKey, ...(toolKey === job.toolKey && job.tool !== undefined && job.tool !== null ? { tool: job.tool } : {}) },
        getTools(),
      );
      if (entryTool?.shape !== 'drill') return;
      const other = toolItemsFor(setup, toolKey, toolIndex).filter((id) => itemSet.has(id) && workById.has(id));
      if (other.length === 0) return;
      findings.push({
        severity: 'error',
        code: 'drill-mixed-tools',
        labelId: other[0],
        message:
          `Setup ${i + 1} assigns ${workById.get(other[0]!)}` +
          `${other.length > 1 ? ` and ${other.length - 1} other item(s)` : ''} to the drill ` +
          `"${entryTool.name}". A drill program cuts drilled holes only; assign the other work to ` +
          `an end mill, or put it in its own setup.`,
      });
    });
  });
  return findings;
}

/**
 * #728 — the findings as the open session sees the target mesh. The job alone cannot tell a mesh
 * this browser no longer holds from one the blob store has not answered for yet, so
 * `target-mesh-missing` read "Import it again" for a moment on every reload. While the store is
 * being asked it says "loading" instead — at the same severity, so a goal still blocks Generate
 * until its shape is here; once the store refused a copy of bytes the job holds,
 * a warning says a reload would lose them. The other states change nothing.
 */
export function withTargetBlobState(
  findings: readonly JobFinding[],
  job: EngraveJob,
  state: 'none' | 'loading' | 'ready' | 'missing' | 'unstored',
): JobFinding[] {
  const target = job.targetObject;
  if (target === undefined || !target.enabled) return [...findings];
  const role = (target.role ?? 'reference') === 'goal' ? 'goal' : 'reference';
  if (state === 'loading') {
    return findings.map((f) =>
      f.code === 'target-mesh-missing'
        ? {
            severity: f.severity,
            code: 'target-mesh-loading',
            labelId: target.id,
            message: `The ${role} mesh “${target.name}” is loading from this browser’s store.`,
          }
        : f,
    );
  }
  if (state === 'unstored') {
    return [
      ...findings,
      {
        severity: 'warning',
        code: 'target-mesh-unstored',
        labelId: target.id,
        message:
          `This browser would not keep a copy of the ${role} mesh “${target.name}” (it may be full, ` +
          `or a private window): it is open now, but a reload loses it. Save the job to a file to keep it.`,
      },
    ];
  }
  return [...findings];
}

/**
 * The one de-duplicator for a merged finding list (#353). `validateJob` and `validateVise` are
 * separate passes with separate subjects, and a code can be answered by both — `vise-default` was
 * the shipped case, listed twice on the setup flow's blank step until this ran between them.
 *
 * The key is the whole finding, message included, rather than `code` + `labelId` alone: two
 * findings that share a code and an item but say different things are two findings (a trace can
 * cross itself in two places), and collapsing them would hide one. Byte-identical duplication is
 * the only thing this is meant to catch.
 */
export function dedupeFindings(findings: readonly JobFinding[]): JobFinding[] {
  const seen = new Set<string>();
  const out: JobFinding[] = [];
  for (const f of findings) {
    const key = `${f.severity}|${f.code}|${f.labelId ?? ''}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
