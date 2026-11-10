/**
 * #1136 — WHICH PROGRAMS A CUTTER REPLACEMENT ACTUALLY TOUCHES, and whether a partial post is
 * even admissible. The brain of the feature, kept pure so the generator and the Cut card read ONE
 * answer:
 *
 *  - THE DESIGN MUST NOT HAVE MOVED. `jobFingerprint` strips the substitution map (its effect rides
 *    the resolved setups), so comparing it with the frozen package's `jobHash` says whether a
 *    replacement is the ONLY change. Anything else is a full regenerate, stated.
 *  - A SETUP IS AFFECTED when its resolved tool list (or its face cutter) differs from what the
 *    package froze. Everything else carries its frozen programs VERBATIM — same `nc`, same hash.
 *  - THE AFFECTED SET IS CLOSED BY CONSTRUCTION: an affected setup re-posts as a whole, so the
 *    rest-pass partners (measured within the setup) and the setup's face ref re-post with it.
 *  - A REPLACEMENT THAT MERGES TWO REFS is refused before any posting: a cutter already in the
 *    same setup would turn two programs into one and renumber the run, breaking the promise that
 *    the unaffected programs' bytes AND order do not change.
 *
 * The judgement is NOT this module's: after the partial post the verifier, the sweep and the goal
 * check run over the WHOLE composed package (the Manager's condition on #1136), and a composed
 * package that fails where a full regenerate passes falls back to the full regenerate.
 */
import type { EngraveJob } from '@/types/engraveJob';
import { jobFingerprint, type FrozenPackage, type PackageProgramInput } from './package';
import { jobSetups } from './jobSetup';

export interface PartialRegenOk {
  ok: true;
  /** The setups that re-post (1-based, the Cut screen's own numbering), in order. */
  affectedSetups: number[];
  /** The set of setup ids being re-posted, for `jobSetups`' own identity. */
  affectedSetupIds: string[];
  /** The unaffected setups' frozen programs, in cut order — carried over byte-for-byte. */
  carry: PackageProgramInput[];
}

export interface PartialRegenNo {
  ok: false;
  /** Why a partial post is not admissible; the caller re-posts the whole run and says so. */
  reason: string;
}

export type PartialRegenPlan = PartialRegenOk | PartialRegenNo;

/**
 * THE COST THE OPERATOR AGREES TO, in one sentence: how much of the run a partial post re-posts,
 * and how much rides over unchanged. It names only the affected programs' setups — the operator's
 * "is this the bit I am replacing?" check — never the whole run's cost when only a part moves.
 *
 * The sentence is the Cut screen's regenerate line and the Generate result's own statement, so the
 * two cannot say different things about the same plan.
 */
export function partialRegenSentence(plan: PartialRegenOk, pkg: FrozenPackage): string {
  const affected = new Set(plan.affectedSetupIds);
  const repost = pkg.programs.filter((program) => affected.has(program.setupId)).length;
  const total = pkg.programs.length;
  const carried = total - repost;
  const setupWords =
    plan.affectedSetups.length === 1 ? `setup ${plan.affectedSetups[0]}` : `setups ${plan.affectedSetups.join(', ')}`;
  return (
    `${repost} of ${total} program${total === 1 ? '' : 's'} re-post (${setupWords}); ` +
    `the other ${carried} ${carried === 1 ? 'rides' : 'ride'} over unchanged`
  );
}

/** A setup's byte-relevant cutter facts: its tool list in order and its face cutter. */
function toolsOf(setup: { tools: readonly string[]; faceToolKey?: string }): string {
  return JSON.stringify([setup.tools, setup.faceToolKey ?? null]);
}

export function partialRegenPlan(job: EngraveJob, pkg: FrozenPackage): PartialRegenPlan {
  // The replacement is the ONLY change: the fingerprint of the job WITHOUT its substitutions
  // still matches the freeze. (The map is stripped from the view, but its EFFECT lives in the
  // resolved setups — so the comparison must run against an empty map, not the job as-is.)
  const unsubstituted: EngraveJob = { ...job, cutterSubstitutions: {} };
  if (jobFingerprint(unsubstituted) !== pkg.jobHash) {
    return { ok: false, reason: 'the job changed beyond the cutter replacement — re-post the whole run' };
  }
  const resolved = jobSetups(job);
  if (resolved.length !== pkg.setups.length || resolved.some((setup, i) => setup.id !== pkg.setups[i]!.id)) {
    return { ok: false, reason: 'the setups changed beyond the cutter replacement — re-post the whole run' };
  }
  const affectedSetups: number[] = [];
  const affectedSetupIds: string[] = [];
  for (const [i, setup] of resolved.entries()) {
    if (toolsOf(setup) === toolsOf(pkg.setups[i]!)) continue;
    // A replacement that lands on a cutter the same setup already posts would merge two refs —
    // a different program list and numbering. Refused, never faked.
    if (new Set(setup.tools).size !== setup.tools.length) {
      return {
        ok: false,
        reason: `setup ${i + 1} would post the same cutter twice — the replacement would merge two programs and renumber the run; choose another owned cutter`,
      };
    }
    affectedSetups.push(i + 1);
    affectedSetupIds.push(setup.id);
  }
  if (affectedSetups.length === 0) {
    return { ok: false, reason: 'no setup posts a different cutter' };
  }
  const affected = new Set(affectedSetupIds);
  const carry: PackageProgramInput[] = pkg.programs
    .filter((program) => !affected.has(program.setupId))
    .map((program) => ({
      setupIndex: program.setupIndex,
      setupId: program.setupId,
      toolKey: program.toolKey,
      nc: program.nc,
      frameNc: program.frameNc,
      programHash: program.hash,
      ...(program.frame === undefined ? {} : { frame: program.frame }),
    }));
  return { ok: true, affectedSetups, affectedSetupIds, carry };
}
