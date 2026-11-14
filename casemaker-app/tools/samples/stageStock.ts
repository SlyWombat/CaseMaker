/**
 * #1263 — THE BENCH STATES ITS OWN MATERIAL, AND NEVER STAGES A JOB THE SCHEMA WILL REFUSE.
 *
 * The wizard no longer assumes a material (`proposeStock` answers `material: null`, the Stock step
 * asks), and the sample harness used to copy the proposal's material into the job it stages: every
 * mesh sample was then refused by the job schema in two seconds ("stock.material: Invalid option"),
 * which read like a product refusal. A sample carries no material of its own (the manifest has none,
 * unless one states it), so the BENCH chooses: the sample's own where it has one, else hardwood,
 * said in that sample's line ("harness chose hardwood") like the harness's tab answer is. And a staged
 * job whose stock has a field the schema requires null is the harness's own failure, naming the field.
 */

import type { EngraveJob } from '../../src/types/engraveJob';

/** What the bench cuts a sample in when the sample states nothing: the one it has always used. */
export const HARNESS_MATERIAL = 'hardwood' as const;

export interface StagedMaterial {
  material: EngraveJob['stock']['material'];
  /** True when the harness chose it (the sample states none): the sample's line says so. */
  chosen: boolean;
}

/** The sample's own stated material where the manifest has one; otherwise the harness's. */
export function stagedMaterial(sample: { material?: string | null }): StagedMaterial {
  if (typeof sample.material === 'string' && sample.material.length > 0) {
    return { material: sample.material as EngraveJob['stock']['material'], chosen: false };
  }
  return { material: HARNESS_MATERIAL, chosen: true };
}

/**
 * The harness's own check, before the job is written: every stock field the job schema requires must
 * hold a value. Throws with a message that names the field (the caller records it as THIS sample's
 * "harness error", never as a schema refusal from the CLI).
 */
export function assertStaged(job: EngraveJob): void {
  const stock = job.stock as unknown as Record<string, unknown>;
  for (const field of ['material', 'length', 'width', 'thickness']) {
    const v = stock[field];
    const numeric = field !== 'material';
    if (v === null || v === undefined || (numeric ? !(typeof v === 'number' && Number.isFinite(v) && v > 0) : typeof v !== 'string' || v.length === 0)) {
      throw new Error(`the staged job's stock.${field} is ${v === null ? 'null' : v === undefined ? 'missing' : `not usable (${String(v)})`} — the harness copied it from a proposal that did not state one (#1263)`);
    }
  }
}
