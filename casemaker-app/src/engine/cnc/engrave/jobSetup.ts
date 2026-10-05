import { rectProfile } from '@/engine/compiler/profile';
import type { MachineProfile } from '@/engine/cnc/machine';
import { libraryTool } from '@/engine/cnc/toolLibrary';
import { cuttingRadiusForSweep, type Tool } from '@/engine/cnc/tool';
import { viseEnvelope } from '@/engine/cnc/fixture';
import { validateSacrificial, viseJawShift } from '@/engine/cnc/sacrificial';
import { stubSetup, type Setup, type Workholding } from '@/engine/cnc/setup';
import {
  polygonSelfIntersects,
  resolveItems,
  traceOperationName,
  traceSelfOverlapFindings,
} from '@/engine/cnc/engrave/partPlan';
import type { EngraveAnyItem, EngraveJob, EngraveTraceItem } from '@/types/engraveJob';

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
  | 'stock-proud-too-small'
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
  // Single-line traces (#219). `trace-self-overlap` is raised here; `trace-outside-stock` needs
  // the swept region intersected with the stock, which only the worker evaluates (#201). Both
  // are part of `TraceFindingCode` in `partPlan.ts`, where the geometry that detects them lives.
  | 'trace-self-overlap'
  | 'trace-outside-stock';

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

/** Does this item produce any region at all? A shape always does; a label needs text. */
function itemHasWork(item: EngraveAnyItem): boolean {
  return 'kind' in item || item.text.trim().length > 0;
}

/** Does this trace produce any cut? A line needs two points; a stroke label needs text (#219). */
function traceHasWork(trace: EngraveTraceItem): boolean {
  return trace.kind === 'line' ? trace.points.length >= 2 : trace.text.trim().length > 0;
}

/** The tool the job names, or null when `toolKey` is not in `TOOL_LIBRARY`. */
export function jobTool(job: EngraveJob): Tool | null {
  return libraryTool(job.toolKey);
}

/**
 * The part, its workholding and the work origin, for the emulator.
 *
 * The vise's two jaw faces are in the PART frame: the fixed jaw is the plane x = 0 with
 * normal +X (the fixed jaw is on the left, /Fabrication.md §7.3), the moving jaw is
 * x = length with normal −X. `jawHeight` is measured from the stock's seated bottom
 * (model z = 0) up to the jaw tops, which stand `stockProud` below the top face:
 * `thickness − stockProud`.
 *
 * SACRIFICIAL MATERIAL MOVES THE FACES (#213 §2): the jaws close on what is actually between
 * them, so `viseJawShift` pushes the fixed face to `x = −shift.left` and the moving face to
 * `x = length + shift.right`. With no sacrificial material the shift is zero and the faces sit
 * on the part's own edges exactly as before.
 *
 * The obstacle boxes themselves are #203's job, not this one.
 */
export function toSetup(job: EngraveJob, machine: MachineProfile): Setup {
  const { length, width, thickness } = job.stock;
  const vise = job.workholding.vise;
  const shift = viseJawShift(job.sacrificial);
  const workholding: Workholding = {
    kind: 'vise',
    jawFaces: [
      { origin: [0 - shift.left, 0, 0], normal: [1, 0, 0] }, // fixed jaw face, normal +X
      { origin: [length + shift.right, 0, 0], normal: [-1, 0, 0] }, // moving jaw face, normal −X
    ],
    jawHeight: thickness - vise.stockProud,
  };
  return stubSetup(
    { kind: 'prism', outline: rectProfile(length, width), thickness },
    workholding,
    // The default job's tool is number 1 (`flat-1.0`); the starting tool is stated because a
    // program cannot know the machine's active tool (/Simulation.md §1.1). The fixture is the
    // vise's obstacle envelope (#203), carried with its provenance so the emulator never
    // mistakes a default for a measurement. The sacrificial model rides along (#213) so the
    // sweep can model it as a second body; absent, every pre-#213 caller is unchanged.
    { startingTool: 1, fixture: viseEnvelope(job.stock, vise, job.sacrificial), sacrificial: job.sacrificial },
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
  const { thickness } = job.stock;
  const floorAllowed = thickness - job.minFloor;

  for (const item of enabled) {
    if (item.depth > floorAllowed) {
      const remaining = thickness - item.depth;
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
      const remaining = thickness - trace.depth;
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

  if (!enabled.some(itemHasWork) && !enabledTraces.some(traceHasWork)) {
    findings.push({
      severity: 'error',
      code: 'no-items',
      message: 'The job has no enabled label with text, shape or trace.',
    });
  }

  if (jobTool(job) === null) {
    findings.push({
      severity: 'error',
      code: 'tool-missing',
      message: `Tool key "${job.toolKey}" is not in the tool library.`,
    });
  }

  // The deepest cut across BOTH region items and traces, so an unmodelled-tall trace is reported
  // with the same clearance warning as a deep pocket.
  const deepestItem = [...enabled, ...enabledTraces].reduce<{ id: string; depth: number } | null>(
    (deepestSoFar, item) => (!deepestSoFar || item.depth > deepestSoFar.depth ? { id: item.id, depth: item.depth } : deepestSoFar),
    null,
  );
  const deepest = deepestItem?.depth ?? 0;
  if (job.workholding.vise.stockProud < deepest + 1) {
    findings.push({
      severity: 'warning',
      code: 'stock-proud-too-small',
      labelId: deepestItem?.id,
      message:
        `The stock stands ${job.workholding.vise.stockProud} mm above the jaw tops, but the ` +
        `deepest cut reaches ${deepest} mm; at least 1 mm of clearance is wanted, so the ` +
        `cutter would work below the jaw tops (` +
        `stockProud ≥ ${deepest + 1} mm).`,
    });
  }

  if (job.workholding.vise.source === 'default') {
    findings.push({
      severity: 'warning',
      code: 'vise-default',
      message: 'Vise dimensions are unmeasured defaults (#208); collisions cannot be trusted yet.',
    });
  }

  // A trace whose cutter-swept strokes come closer than the cutter width fills in (#219): the
  // letters merge. A warning, not an error — the cut still exists, it is just not what was drawn.
  // It needs the cutter's radius, so it is skipped when the job names no usable flat cutter.
  const tool = jobTool(job);
  if (tool) {
    const r = cuttingRadiusForSweep(tool);
    if (r.ok) findings.push(...traceSelfOverlapFindings(job, r.radius));
  }

  findings.push(...validateSacrificial(job));

  return findings;
}
