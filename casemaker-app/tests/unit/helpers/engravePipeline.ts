// #305 — the sim workers no longer resolve a cutter; the caller names one. Every spec that drives
// the engrave pipeline therefore has to say which tool it runs with, and for a spec that hands
// over a JOB the only right answer is the tool that job names. These four wrappers say it, through
// the same `jobTool` the app itself uses, so a spec cannot quietly run against a different cutter
// than the job it describes — and thirteen specs carry one rule instead of thirteen.
//
// They are deliberately thin: each one is a single call, so a spec that wants to hand the pipeline
// a tool the job does NOT name (a probe, a deliberate mismatch) still calls the real function.

import type { MachineCalibration } from '@/engine/cnc/calibration';
import { jobTool, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { TOOL_LIBRARY } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import {
  engraveGenerate,
  engraveRegions,
  type EngraveGenerated,
  type EngraveRegions,
} from '@/workers/sim/engraveGenerate';
import { engravabilityFindings, type LabelEngravability, type LabelRatioAt } from '@/workers/sim/engraveGeometry';
import type { EngravePreview, EngravePreviewer } from '@/workers/sim/engravePreview';

/** `engraveGenerate` for a job, with the cutter that job names. */
export function generate(
  tl: ManifoldToplevel,
  job: EngraveJob,
  calibration: MachineCalibration | null = null,
): EngraveGenerated {
  return engraveGenerate(tl, job, jobTool(job), calibration);
}

/** `engraveRegions` for a job, with the cutter that job names. */
export function regions(tl: ManifoldToplevel, job: EngraveJob): EngraveRegions {
  return engraveRegions(tl, job, jobTool(job));
}

/** `engravabilityFindings` for a job, with the cutter that job names (its messages name it). */
export function engravability(job: EngraveJob, m: LabelEngravability[], ratioAt: LabelRatioAt): JobFinding[] {
  return engravabilityFindings(job, m, ratioAt, jobTool(job));
}

/**
 * A preview of `job` over the builtin registry — the list the app ships with when no later tier
 * is loaded, which is what every preview spec runs against.
 */
export function preview(previewer: EngravePreviewer, job: EngraveJob, gen: number): EngravePreview | null {
  return previewer.engravePreview(job, TOOL_LIBRARY, gen);
}
