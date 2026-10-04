import { rectProfile } from '@/engine/compiler/profile';
import type { MachineProfile } from '@/engine/cnc/machine';
import { libraryTool } from '@/engine/cnc/toolLibrary';
import type { Tool } from '@/engine/cnc/tool';
import { viseEnvelope } from '@/engine/cnc/fixture';
import { stubSetup, type Setup, type Workholding } from '@/engine/cnc/setup';
import type { EngraveJob, EngraveLabel } from '@/types/engraveJob';

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
  | 'no-labels'
  | 'tool-missing'
  | 'stock-proud-too-small'
  | 'vise-default'
  | 'vise-stock-not-proud'
  | 'vise-stock-proud-exceeds-thickness'
  | 'vise-grip-shallow'
  | 'vise-jaw-short'
  // Geometry-dependent findings: computed by the worker (#201), not `validateJob` — they
  // need the tool-opened glyph, which only exists once a CrossSection is evaluated.
  | 'label-empty'
  | 'label-chars-lost'
  | 'label-detail-lost'
  | 'label-outside-stock';

export interface JobFinding {
  severity: 'error' | 'warning';
  code: JobFindingCode;
  /** The label a finding points at, when it is about one label. */
  labelId?: string;
  message: string;
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
 * Pure checks on the job as data. Geometry-dependent findings — a label hanging off the
 * stock, strokes too thin for the cutter — need the worker and are #201.
 */
export function validateJob(job: EngraveJob): JobFinding[] {
  const findings: JobFinding[] = [];
  const enabled = job.labels.filter((l) => l.enabled);
  const { thickness } = job.stock;
  const floorAllowed = thickness - job.minFloor;

  for (const label of enabled) {
    if (label.depth > floorAllowed) {
      const remaining = thickness - label.depth;
      findings.push({
        severity: 'error',
        code: 'depth-exceeds-stock',
        labelId: label.id,
        message:
          `Label "${label.text}" cuts ${label.depth} mm deep; only ${remaining} mm of floor ` +
          `would remain on a ${thickness} mm stock, below the ${job.minFloor} mm minimum.`,
      });
    }
  }

  if (!enabled.some((l) => l.text.trim().length > 0)) {
    findings.push({
      severity: 'error',
      code: 'no-labels',
      message: 'The job has no enabled label with text.',
    });
  }

  if (jobTool(job) === null) {
    findings.push({
      severity: 'error',
      code: 'tool-missing',
      message: `Tool key "${job.toolKey}" is not in the tool library.`,
    });
  }

  const deepest = enabled.reduce((max, l) => Math.max(max, l.depth), 0);
  if (job.workholding.vise.stockProud < deepest + 1) {
    const deepestLabel = enabled.reduce<EngraveLabel | null>(
      (deepestSoFar, l) => (!deepestSoFar || l.depth > deepestSoFar.depth ? l : deepestSoFar),
      null,
    );
    findings.push({
      severity: 'warning',
      code: 'stock-proud-too-small',
      labelId: deepestLabel?.id,
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

  return findings;
}
