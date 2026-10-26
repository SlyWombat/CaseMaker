import { rectProfile } from '@/engine/compiler/profile';
import type { MillProfile } from '@/engine/cnc/machine';
import { getTools, NO_TOOL_KEY, toolForJob } from '@/engine/cnc/toolRegistry';
import {
  cuttingDiameter,
  cuttingRadiusForSweep,
  drillPointAngle,
  pointLength,
  traceRadiusAt,
  DRILL_POINT_FALLBACK_DEG,
  type Tool,
} from '@/engine/cnc/tool';
import { viseEnvelope } from '@/engine/cnc/fixture';
import { validateSacrificial, viseJawShift } from '@/engine/cnc/sacrificial';
import { stubSetup, type FixtureEnvelope, type Setup, type Workholding } from '@/engine/cnc/setup';
import {
  chamferOperationName,
  cutoutOperationName,
  drillHoles,
  drillOperationName,
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
import type {
  EngraveAnyItem,
  EngraveChamfer,
  EngraveCutout,
  EngraveDrill,
  EngraveJob,
  EngraveKeepOut,
  EngravePrimitive,
  EngraveTargetObject,
  EngraveThread,
  EngraveTraceItem,
  JobSetup,
} from '@/types/engraveJob';
import type { Mount, Orientation } from '@/engine/cnc/setups/types';

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
  // V-CARVE region findings (#221). The design is correct at the COLOUR PLANE, so the two
  // disqualifying facts are about that plane: a cut that stops above it never reaches the second
  // colour, and a groove at it narrower than the machine's own X/Y step cannot be resolved into
  // two walls. Both are errors and both name the way out.
  | 'vcarve-above-colour-plane'
  | 'vcarve-groove-too-narrow'
  // The design check from the brief: two surface openings that overlap merge at the top face and
  // leave a ridge of the top colour below. A warning — the merged look is the operator's to
  // accept — raised with the geometry in hand (engraveGenerate's `vCarveFindings`).
  | 'vcarve-surface-merge'
  // The step-over the feeds row asked for, cut down to the pitch the FLOOR allows (#221 slice D).
  // A warning with note wording: nothing is wrong with the job, but the number the operator sees
  // must be the one the CAM runs. The seed still states the request; this says when the tip
  // radius, not the seed, set the pitch.
  | 'vcarve-stepover-clamped'
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
  // A GOAL object (#533): the embedded mesh IS the shape to make, so it is not warned as uncut.
  // `goal-object-oversize` is the sane-size check — the goal's footprint or depth exceeds the
  // blank it would be carved from, so no toolpath could reproduce it from this stock (an error).
  // `goal-object-no-toolpath` is an INFO note that the goal is a recognised input but 3D toolpath
  // generation (slice D, #534) is not built yet, so this job posts no cut for it — the goal's
  // counterpart to the reference's `target-object-not-cut`, answering "why is my goal not cut?".
  | 'goal-object-oversize'
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
  // #649 — the fitted surface lifts the blank more than the nominal hop, so every rapid in this
  // program runs higher than usual. A warning: the program is safe (the hop was raised for it), but
  // the operator may prefer to level the top with G32 and keep the nominal clearance.
  | 'surface-hop-raised';

export interface JobFinding {
  /**
   * `info` states a fact the panel should show but that blocks nothing — the seat a blank rests
   * on is one (#508): it is a mechanism, not a fault in the job.
   */
  severity: 'error' | 'warning' | 'info';
  code: JobFindingCode;
  /** The item (label or shape) a finding points at, when it is about one item. */
  labelId?: string;
  message: string;
}

/**
 * The one `through-needs-board` finding (#218). A through cut needs material under the blank to
 * cut INTO: the under-board must be at least `breakthrough + 1` mm thick, so the breakthrough
 * never reaches its far face.
 */
function throughBoardFinding(labelId: string, who: string, job: EngraveJob): JobFinding {
  const need = job.breakthrough + 1;
  const have = job.sacrificial.under?.thickness ?? 0;
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
 * A human name for an item, for finding messages: `Label "CASE"`, `Circle ⌀6`, `Border …`. */
export function itemLabel(item: EngraveAnyItem): string {
  if (!('kind' in item)) return `Label "${item.text}"`;
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
  const { length, thickness } = job.stock;
  const shift = viseJawShift(job.sacrificial);
  return {
    kind: 'vise',
    jawFaces: [
      { origin: [0 - shift.left, 0, 0], normal: [1, 0, 0] }, // fixed jaw face, normal +X
      { origin: [length + shift.right, 0, 0], normal: [-1, 0, 0] }, // moving jaw face, normal −X
    ],
    jawHeight: thickness - job.workholding.vise.stockProud,
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
      mount: { kind: job.workholding.kind },
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
  return job.setups?.[setupIndex]?.mount.kind ?? job.workholding.kind;
}

/**
 * The part, its workholding and the work origin, for the emulator.
 *
 * `fixture` REPLACES the vise's envelope when the job is held on the bracket (#442's #427 item):
 * one mount is in the machine, so its boxes are the fixture — not the vise's and not both. Absent,
 * the vise's envelope is derived exactly as before (#203).
 */
export function toSetup(job: EngraveJob, machine: MillProfile, fixture?: FixtureEnvelope): Setup {
  const { length, width, thickness } = job.stock;
  const vise = job.workholding.vise;
  const workholding = workholdingFor(job);
  return stubSetup(
    { kind: 'prism', outline: rectProfile(length, width), thickness },
    workholding,
    // The default job's tool is number 1 (`flat-1.0`); the starting tool is stated because a
    // program cannot know the machine's active tool (/Simulation.md §1.1). The fixture is the
    // vise's obstacle envelope (#203), carried with its provenance so the emulator never
    // mistakes a default for a measurement. The sacrificial model rides along (#213) so the
    // sweep can model it as a second body; absent, every pre-#213 caller is unchanged.
    { startingTool: 1, fixture: fixture ?? viseEnvelope(job.stock, vise, job.sacrificial), sacrificial: job.sacrificial },
    machine,
  );
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
  opts: { mixed?: boolean } = {},
): JobFinding[] {
  const findings: JobFinding[] = [];
  const { length, width, thickness } = stock;
  const hasVolume = target.size.x > 0 && target.size.y > 0 && target.size.z > 0;
  const fitsFootprint = target.size.x <= length && target.size.y <= width;
  const fitsDepth = target.size.z <= thickness;
  if (!hasVolume) {
    findings.push({
      severity: 'error',
      code: 'goal-object-oversize',
      message:
        `The goal object "${target.name}" is flat in at least one direction ` +
        `(${fmt3(target.size.x)}×${fmt3(target.size.y)}×${fmt3(target.size.z)} mm); a goal needs ` +
        `volume to drive a 3D cut toward.`,
    });
  } else if (!fitsFootprint || !fitsDepth) {
    findings.push({
      severity: 'error',
      code: 'goal-object-oversize',
      message:
        `The goal object "${target.name}" is ` +
        `${fmt3(target.size.x)}×${fmt3(target.size.y)}×${fmt3(target.size.z)} mm, larger than the ` +
        `${fmt3(length)}×${fmt3(width)}×${fmt3(thickness)} mm blank it would be carved from; ` +
        `it cannot be reproduced from this stock. Use a larger blank or scale the goal.`,
    });
  } else if (opts.mixed === true) {
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
  const hasItems =
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
    (job.primitives?.length ?? 0) > 0;
  return hasItems ? null : t;
}

export function validateJob(
  job: EngraveJob,
  drillPoint: { deg: number; source: string } | null = null,
  /**
   * #677 — work the DOCUMENT does not hold. The core-clearance program is built from a sub-job
   * with no items (the core is derived, not drawn), so its validation must count the derived
   * regions as work or `no-items` would refuse a program that has cutting to do.
   */
  options: { derivedCores?: number } = {},
): JobFinding[] {
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
  const floorAllowed = thickness - facingDepth - job.minFloor;

  for (const item of enabled) {
    // A through region has no typed depth (#218): its floor is the board, and the through gate
    // below judges it. `item.depth` on a through item is deliberately ignored. Only a shape can
    // carry `through`; a label has no such field.
    if ('through' in item && item.through === true) continue;
    if (item.depth > floorAllowed) {
      const remaining = thickness - facingDepth - item.depth;
      findings.push({
        severity: 'error',
        code: 'depth-exceeds-stock',
        labelId: item.id,
        message:
          `${itemLabel(item)} cuts ${item.depth} mm deep; only ${remaining} mm of floor ` +
          `would remain on a ${thickness} mm stock, below the ${job.minFloor} mm minimum.`,
      });
    }
  }

  for (const trace of enabledTraces) {
    if (trace.depth > floorAllowed) {
      const remaining = thickness - facingDepth - trace.depth;
      findings.push({
        severity: 'error',
        code: 'depth-exceeds-stock',
        labelId: trace.id,
        message:
          `${traceOperationName(trace)} cuts ${trace.depth} mm deep; only ${remaining} mm of floor ` +
          `would remain on a ${thickness} mm stock, below the ${job.minFloor} mm minimum.`,
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
      const remaining = thickness - facingDepth - primitive.depth;
      findings.push({
        severity: 'error',
        code: 'depth-exceeds-stock',
        labelId: primitive.id,
        message:
          `${primitiveLabel(primitive)} cuts ${primitive.depth} mm deep; only ${remaining} mm of ` +
          `floor would remain on a ${thickness} mm stock, below the ${job.minFloor} mm minimum.`,
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
    if ((target.role ?? 'reference') === 'goal') {
      // A GOAL (#533) IS the work, so it is never warned as uncut. It is validated instead
      // ({@link validateGoalObject}), which the pure-goal generate path reuses (#539). #535 — the
      // "posts no cut for it" info belongs to a MIXED job only; a pure goal job is surfaced.
      findings.push(...validateGoalObject(target, job.stock, { mixed: pureGoalObject(job) === null }));
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
  const throughReady =
    job.sacrificial.under !== null && job.sacrificial.under.thickness >= job.breakthrough + 1;
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
      findings.push(throughBoardFinding(item.id, who, job));
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
      findings.push(throughBoardFinding(cutout.id, who, job));
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
        findings.push(throughBoardFinding(drill.id, who, job));
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
      const remaining = thickness - facingDepth - depthAtFloor;
      findings.push({
        severity: 'error',
        code: 'depth-exceeds-stock',
        labelId: drill.id,
        message: drillIsBit
          ? `${who}'s tip reaches ${fmt3(tipDepth)} mm (${fmt3(drill.depth)} mm of full diameter ` +
            `plus the ${fmt3(drillPointLength)} mm point); only ${fmt3(remaining)} mm of floor would ` +
            `remain on a ${thickness} mm stock, below the ${job.minFloor} mm minimum.`
          : `${who} drills ${drill.depth} mm deep; only ${remaining} mm of floor would remain on a ` +
            `${thickness} mm stock, below the ${job.minFloor} mm minimum.`,
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
        'The job has no enabled label with text, shape, trace, drilled hole, thread, cuttable 3D primitive or cut-out.',
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
  const swept = sweptCuts(job);
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
        (job.workholding.vise.stockProud <= 0
          ? `, or raise the blank on a packer so it works above the jaw tops and state how far it then stands proud.`
          : '.'),
    });
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
  const belowJawTops = deepestCut === null ? 0 : deepestCut.depth - job.workholding.vise.stockProud;
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
    job.workholding.vise.stockProud <= 0 &&
    swept.length > 0 &&
    !findings.some((f) => f.code === 'vise-jaw-collision')
  ) {
    findings.push({
      severity: 'warning',
      code: 'vise-stock-not-proud',
      message:
        `The blank sits ${fmt3(-job.workholding.vise.stockProud)} mm below the jaw tops; the cut ` +
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
