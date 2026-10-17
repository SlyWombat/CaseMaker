import { rectProfile } from '@/engine/compiler/profile';
import type { MillProfile } from '@/engine/cnc/machine';
import { getTools, toolForJob } from '@/engine/cnc/toolRegistry';
import { cuttingDiameter, cuttingRadiusForSweep, traceRadiusAt, type Tool } from '@/engine/cnc/tool';
import { viseEnvelope } from '@/engine/cnc/fixture';
import { validateSacrificial, viseJawShift } from '@/engine/cnc/sacrificial';
import { stubSetup, type FixtureEnvelope, type Setup, type Workholding } from '@/engine/cnc/setup';
import {
  drillHoles,
  drillOperationName,
  jawGapFor,
  polygonSelfIntersects,
  resolveItems,
  sweptCuts,
  threadOperationName,
  traceOperationName,
  traceSelfOverlapFindings,
  type SweptCut,
} from '@/engine/cnc/engrave/partPlan';
import { FASTENERS } from '@/engine/compiler/fasteners';
import type {
  EngraveAnyItem,
  EngraveDrill,
  EngraveJob,
  EngraveKeepOut,
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
  // #475 — the blank's top is bowed more than the cut's depth band, so no Z0 can keep every floor
  // past the colour line and clear of the pocket. Raised when the surface touches are measured, not
  // by `validateJob`: the job document has no readings.
  | 'blank-bowed'
  // Single-line traces (#219). `trace-self-overlap` is raised here; `trace-outside-stock` needs
  // the swept region intersected with the stock, which only the worker evaluates (#201). Both
  // are part of `TraceFindingCode` in `partPlan.ts`, where the geometry that detects them lives.
  | 'trace-self-overlap'
  | 'trace-outside-stock'
  // Plunge drills (#220). All four are checks on the job as data plus the resolved tool.
  | 'drill-outside-stock'
  | 'plunge-unproven'
  | 'drill-too-deep'
  | 'drill-through-unavailable'
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
  // Facing (#432). The job's facing depth is taken off the same blank every item is measured
  // against, so the check is one number against the stock's minimum floor — not a per-item one.
  // An item over-deep once the skim is counted is still `depth-exceeds-stock`, whose own check
  // measures from the faced surface.
  | 'facing-too-deep'
  // #473 — a material facingRefusal refuses is never faced (#474/#493). The worker refuses a job
  // that still carries the pass before any program is posted, because the engraving file's Z0 is
  // the faced top. `facing-plastic` is the class: every non-wood, non-metal material.
  | 'facing-plastic'
  // Programs (#419 J3). One program is one setup cut with ONE cutter; a setup that names none has
  // nothing to post, and one that names several cannot say which items belong to which cutter
  // (#410's assignment), so cutting it as one program per cutter would cut every item twice.
  | 'setup-no-tool'
  | 'setup-tools-unassigned';

export interface JobFinding {
  severity: 'error' | 'warning';
  code: JobFindingCode;
  /** The item (label or shape) a finding points at, when it is about one item. */
  labelId?: string;
  message: string;
}

/** A human name for an item, for finding messages: `Label "CASE"`, `Circle ⌀6`, `Border …`. */
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
export type EngraveNamedItem = EngraveAnyItem | EngraveTraceItem | EngraveDrill | EngraveThread | EngraveKeepOut;

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
      tools: [job.toolKey],
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
 */
export function validateJob(job: EngraveJob): JobFinding[] {
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

  // Plunge drills (#220): depth, reach, stock containment, a centre-cutting tool and the
  // through-cut gate. The tool is resolved once here; `drill-outside-stock` and the
  // centre-cutting check need its radius, and skip cleanly when the job names no flat cutter
  // (the `tool-missing`/feeds stage reports that instead).
  const drillTool = jobTool(job);
  const drillRadiusResult = drillTool ? cuttingRadiusForSweep(drillTool) : null;
  const drillRadius = drillRadiusResult && drillRadiusResult.ok ? drillRadiusResult.radius : null;
  const { length, width } = job.stock;
  for (const drill of enabledDrills) {
    const who = drillOperationName(drill);
    if (drill.through) {
      findings.push({
        severity: 'error',
        code: 'drill-through-unavailable',
        labelId: drill.id,
        message:
          `${who} asks to cut through the blank, which needs a sacrificial board (#213) and the ` +
          `through-cut depth rules (#218); neither is in yet, so the hole is refused rather than ` +
          `cut into the vise.`,
      });
    } else if (drill.depth > floorAllowed) {
      const remaining = thickness - facingDepth - drill.depth;
      findings.push({
        severity: 'error',
        code: 'depth-exceeds-stock',
        labelId: drill.id,
        message:
          `${who} drills ${drill.depth} mm deep; only ${remaining} mm of floor would remain on a ` +
          `${thickness} mm stock, below the ${job.minFloor} mm minimum.`,
      });
    }
    // A hole is a disc of the cutter's radius, so it is off the stock when its RIM crosses an
    // edge, not just its centre.
    if (drillRadius !== null) {
      for (const [hx, hy] of drillHoles(drill)) {
        if (hx - drillRadius < 0 || hx + drillRadius > length || hy - drillRadius < 0 || hy + drillRadius > width) {
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
            `${who} asks to thread through the blank, which needs a sacrificial board (#213) and ` +
            `the through-cut depth rules (#218); neither is in yet, so the thread is refused rather ` +
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
            `not been shown to clear the flutes (#208 records the owned cutters' lengths).`,
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
    } else if (drillTool.centreCutting === null) {
      findings.push({
        severity: 'warning',
        code: 'plunge-unproven',
        labelId: enabledDrills[0]!.id,
        message:
          `The job drills, but nothing recorded for "${drillTool.name}" says it is centre-cutting ` +
          `(the .nc header has no such field, #220); #208 A1 settles it for cutters that are owned.`,
      });
    }
    // A peck must fit inside the flute: beyond it the chips have nowhere to go.
    if (drillTool.fluteLength !== null && drillTool.fluteLength > 0) {
      for (const drill of enabledDrills) {
        if (!drill.through && drill.depth > drillTool.fluteLength) {
          findings.push({
            severity: 'error',
            code: 'drill-too-deep',
            labelId: drill.id,
            message:
              `${drillOperationName(drill)} drills ${drill.depth} mm, past the ${drillTool.fluteLength} mm ` +
              `flute of "${drillTool.name}": once the flutes are buried, chips cannot clear.`,
          });
        }
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

  if (!enabled.some(itemHasWork) && !enabledTraces.some(traceHasWork) && enabledDrills.length === 0 && enabledThreads.length === 0) {
    findings.push({
      severity: 'error',
      code: 'no-items',
      message: 'The job has no enabled label with text, shape, trace, drilled hole or thread.',
    });
  }

  if (jobTool(job) === null) {
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
  findings.push(...setupProgramFindings(job));

  return findings;
}

/** A printed millimetre figure: rounded to 0.001, trailing zeros dropped (`2.0` → `2`, `2.61`). */
function fmt3(n: number): number {
  return Number(n.toFixed(3));
}

/**
 * Every setup must be postable as exactly one program (#419 J3): a setup naming no cutter has
 * nothing to post, and one naming several cannot say which items each cutter takes (#410's
 * assignment), so one program per cutter would cut every item twice.
 *
 * Its own function because the GENERATOR needs it on the WHOLE job: `engraveRegions` validates the
 * per-setup sub-job, which carries one `toolKey` by construction, so the multi-tool case can only be
 * seen before the split. Exported so the run's own findings list says the same thing the panel's
 * validation does.
 */
export function setupProgramFindings(job: EngraveJob): JobFinding[] {
  const findings: JobFinding[] = [];
  jobSetups(job).forEach((setup, i) => {
    if (setup.tools.length === 0) {
      findings.push({
        severity: 'error',
        code: 'setup-no-tool',
        message: `Setup ${i + 1} names no cutter, so there is nothing to write a program for.`,
      });
    } else if (setup.tools.length > 1) {
      findings.push({
        severity: 'error',
        code: 'setup-tools-unassigned',
        message:
          `Setup ${i + 1} names ${setup.tools.length} cutters (${setup.tools.join(', ')}), but which ` +
          `items each one cuts is not modelled yet — one program per cutter would cut every item ` +
          `twice. Name one cutter per setup, or give the second its own setup.`,
      });
    }
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
