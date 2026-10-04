import { rectProfile } from '@/engine/compiler/profile';
import type { MachineProfile } from '@/engine/cnc/machine';
import { libraryTool } from '@/engine/cnc/toolLibrary';
import type { Tool } from '@/engine/cnc/tool';
import { viseEnvelope } from '@/engine/cnc/fixture';
import { validateSacrificial } from '@/engine/cnc/sacrificial';
import { stubSetup, type Setup, type Workholding } from '@/engine/cnc/setup';
import { polygonSelfIntersects } from '@/engine/cnc/engrave/partPlan';
import type { EngraveItem, EngraveJob } from '@/types/engraveJob';

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
  // Geometry-dependent findings: computed by the worker (#201), not `validateJob` — they
  // need the tool-opened region, which only exists once a CrossSection is evaluated. They
  // were `label-*`; #214 renamed them `item-*` (a shape is an item too) with the old names
  // kept as aliases in the user guide for one release.
  | 'item-empty'
  | 'item-chars-lost'
  | 'item-detail-lost'
  | 'item-outside-stock';

export interface JobFinding {
  severity: 'error' | 'warning';
  code: JobFindingCode;
  /** The item (label or shape) a finding points at, when it is about one item. */
  labelId?: string;
  message: string;
}

/** A human name for an item, for finding messages: `Label "CASE"`, `Circle ⌀6`, … */
export function itemLabel(item: EngraveItem): string {
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
  }
}

/** Does this item produce any region at all? A shape always does; a label needs text. */
function itemHasWork(item: EngraveItem): boolean {
  return 'kind' in item || item.text.trim().length > 0;
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
 * The obstacle boxes themselves are #203's job, not this one.
 */
export function toSetup(job: EngraveJob, machine: MachineProfile): Setup {
  const { length, width, thickness } = job.stock;
  const vise = job.workholding.vise;
  const workholding: Workholding = {
    kind: 'vise',
    jawFaces: [
      { origin: [0, 0, 0], normal: [1, 0, 0] }, // fixed jaw: x = 0, face normal +X
      { origin: [length, 0, 0], normal: [-1, 0, 0] }, // moving jaw: x = length, normal −X
    ],
    jawHeight: thickness - vise.stockProud,
  };
  return stubSetup(
    { kind: 'prism', outline: rectProfile(length, width), thickness },
    workholding,
    // The default job's tool is number 1 (`flat-1.0`); the starting tool is stated because a
    // program cannot know the machine's active tool (/Simulation.md §1.1). The fixture is the
    // vise's obstacle envelope (#203), carried with its provenance so the emulator never
    // mistakes a default for a measurement.
    { startingTool: 1, fixture: viseEnvelope(job.stock, vise) },
    machine,
  );
}

/**
 * Pure checks on the job as data. Geometry-dependent findings — an item hanging off the
 * stock, strokes too thin for the cutter — need the worker and are #201.
 */
export function validateJob(job: EngraveJob): JobFinding[] {
  const findings: JobFinding[] = [];
  const enabled: EngraveItem[] = [...job.labels, ...job.shapes].filter((item) => item.enabled);
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

  // A self-intersecting polygon is not a region — the fill rule would invent one (#214). It is
  // reported so the worker drops the cut, rather than cutting whatever the crossing makes.
  for (const shape of job.shapes) {
    if (shape.enabled && shape.kind === 'polygon' && polygonSelfIntersects(shape.points)) {
      findings.push({
        severity: 'error',
        code: 'polygon-self-intersecting',
        labelId: shape.id,
        message: `${itemLabel(shape)} crosses itself; fix the points so the outline is a simple region.`,
      });
    }
  }

  if (!enabled.some(itemHasWork)) {
    findings.push({
      severity: 'error',
      code: 'no-items',
      message: 'The job has no enabled label with text or shape.',
    });
  }

  if (jobTool(job) === null) {
    findings.push({
      severity: 'error',
      code: 'tool-missing',
      message: `Tool key "${job.toolKey}" is not in the tool library.`,
    });
  }

  const deepest = enabled.reduce((max, item) => Math.max(max, item.depth), 0);
  if (job.workholding.vise.stockProud < deepest + 1) {
    const deepestItem = enabled.reduce<EngraveItem | null>(
      (deepestSoFar, item) => (!deepestSoFar || item.depth > deepestSoFar.depth ? item : deepestSoFar),
      null,
    );
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

  findings.push(...validateSacrificial(job));

  return findings;
}
