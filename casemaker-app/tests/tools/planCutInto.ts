/**
 * #982 follow-up (A's review) — SWEEP A MODEL PLAN'S PROGRAMS AGAINST ITS GOAL and report the
 * goal check's own numbers: coverage and the adjudicated cut-into fraction. The fallback pins
 * asserted "plans + the right note"; this is the outcome check that makes the 11 mm-gouge class
 * loud instead of silent (the balls-only elephant's 0.0904 % once had no pin at all).
 */
import { sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { checkGoalCutInto } from '@/engine/cnc/engrave/designCheck';
import { Z1 } from '@/engine/cnc/machine';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { parseGcode, setupFromHeader, stubSetup } from '@/engine/cnc';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { exactSweptFieldTooled } from '@/workers/sim/sweptPoint';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { NO_SHOP } from './noShop';

export interface CutIntoReport {
  /** 1 − the leftover fraction inside the 0.1 mm band. */
  coverage: number;
  /** The goal check's own adjudicated cut-into fraction (the gate's number). */
  adjudicated: number;
  /** Every cell cut below the goal, before adjudication. */
  raw: number;
}

/** Post, sweep and judge every program of a model plan against the job's goal. */
export function planCutInto(job: EngraveJob, target: EngraveTargetObject, programs: readonly ToolpathIR[]): CutIntoReport {
  const field = sampleGoalHeightfield(target, { maxCells: NO_SHOP.goalMaxCells, pitchMm: 0.1, stockTopZ: 0 });
  const fields: Float32Array[] = [];
  for (const ir of programs) {
    const ctx: PostContext = {
      jobName: 'pin-cut-into',
      stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness },
      materialName: job.stock.material,
      zDatum: 'probed-top-face',
      origin: 'topFrontLeft',
      camVersion: 'test-982',
      toolKey: 'multi',
    };
    const posted = postZ1(ir, ctx, Z1);
    if (!posted.ok) throw new Error(`post refused: ${posted.errors.join('; ')}`);
    const parsed = parseGcode(posted.text);
    const part = setupFromHeader(parsed.header).patch.part;
    if (part === undefined || part.kind !== 'prism' || part.outline.kind !== 'p-rect') throw new Error('no stock header');
    const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool: 1 }, Z1);
    const timeline = buildTimeline(parsed, setup, Z1);
    const stamp = exactSweptFieldTooled(field, timeline, () => ir.tool);
    if (stamp !== null) fields.push(stamp.field);
  }
  const union = Float32Array.from(fields[0] ?? new Float32Array(field.nx * field.ny).fill(0));
  for (let p = 1; p < fields.length; p++) {
    const f = fields[p]!;
    for (let k = 0; k < union.length; k++) if (f[k]! < union[k]!) union[k] = f[k]!;
  }
  const top = (x: number, y: number): number | null => {
    const i = Math.round((x - field.x0) / field.pitch);
    const j = Math.round((y - field.y0) / field.pitch);
    if (i < 0 || j < 0 || i >= field.nx || j >= field.ny) return null;
    return union[j * field.nx + i]!;
  };
  const report = checkGoalCutInto(field, top, { passCoverage: 0.95 });
  return {
    coverage: 1 - (report.leftoverFractions[0] ?? 0),
    adjudicated: report.adjudicatedFraction,
    raw: report.cutIntoFraction,
  };
}
