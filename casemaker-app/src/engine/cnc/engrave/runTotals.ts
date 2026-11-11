/**
 * #1193 — THE RUN'S CYCLE, OVER EVERY POSTED PROGRAM.
 *
 * A flip run is planned SIDE BY SIDE: each side's `planModelCam` prices only its own programs, and
 * the seam appends the locating-hole program and every later side's programs. The result's
 * `plan.outcome.cycleSeconds` is therefore the FIRST side's plan, and a flip's stated cycle came
 * out at 9 826 s while its posted programs totalled 13 891 s (#1193's decomposition of the tray).
 *
 * This module prices the RUN: every posted program's own cycle, plus a bit change at every boundary
 * where the cutter changes — including across the setup boundary and around the locating program —
 * priced by the SAME rule the plan prices its internal changes with (`bitChangePriceSeconds`, from
 * the shop's four settings).
 *
 * WHAT IS NOT IN IT, stated rather than guessed: the FLIP itself. The app models no time for
 * turning the blank over and re-registering it, so the run's line says the flip is untimed instead
 * of inventing a number (`flip: true` is what lets it say so).
 *
 * THE 112 s AND THE 13 891 s: the tradeoff line stays a PLAN comparison (#975's ruling, restated by
 * the Manager 2026-11-10): its numbers are the plans' own, and its wording says whose cycle it is.
 * This total is the RUN's, and it is what §2 and the receipt state as the run's cycle.
 */

import { BIT_CHANGE_KEYS, bitChangePriceSeconds, type BitChangeRule } from '@/engine/cnc/cam/model/bitChange';
import { liveShopDefaults, readDefault } from '@/platform/defaultsClient';

/** One posted program, as the run total needs it. */
export interface RunProgramFact {
  /** This program's own posted cycle, seconds (`cam.estimatedSeconds`). */
  seconds: number;
  /** The cutter it runs — a change is priced where this differs from the program before it. */
  cutterKey: string;
  /** 1-based, the operator's setup number. */
  setupIndex: number;
}

/** The run's own cycle, and the facts its sentence needs. */
export interface RunCycle {
  /** Every posted program's own cycle, s. */
  cuttingSeconds: number;
  /** Every change between consecutive posted programs (none where the cutter is unchanged), s. */
  changeSeconds: number;
  /** How many bit changes the run has. */
  changes: number;
  /** Cutting + changes. The flip is not in it (not modelled) — {@link flip} says it is untimed. */
  totalSeconds: number;
  /** The posted programs counted — a reader can prove the scope. */
  programCount: number;
  /** How many setups the run covers. */
  setupCount: number;
  /** Whether the run turns the blank over between setups (its time is not modelled). */
  flip: boolean;
}

/**
 * The shop's bit-change rule, resolved exactly as the plan resolves it (`planModelCam` reads the
 * same four keys from the same defaults): a second reading would let the run's changes and the
 * plans' changes be priced by different numbers.
 */
export function runBitChangeRule(): BitChangeRule {
  const defaults = liveShopDefaults();
  return {
    attendedMinutes: readDefault(defaults, BIT_CHANGE_KEYS.attendedMinutes).value,
    attendedChangeSeconds: readDefault(defaults, BIT_CHANGE_KEYS.attendedChangeSeconds).value,
    walkAwayMinutes: readDefault(defaults, BIT_CHANGE_KEYS.walkAwayMinutes).value,
    returnMinutes: readDefault(defaults, BIT_CHANGE_KEYS.returnMinutes).value,
  };
}

/**
 * The run's cycle from its posted programs. A program with no stated cycle (an old or failed
 * result) is not counted rather than counted as zero-priced-but-present; when NO program states a
 * cycle there is nothing to state and the answer is null, never a made-up zero.
 */
export function runCycleOf(
  programs: readonly RunProgramFact[],
  rule: BitChangeRule,
  facts: { setupCount: number; flip: boolean },
): RunCycle | null {
  const counted = programs.filter((p) => Number.isFinite(p.seconds) && p.seconds > 0);
  if (counted.length === 0) return null;
  let cuttingSeconds = 0;
  let changeSeconds = 0;
  let changes = 0;
  for (let i = 0; i < counted.length; i++) {
    const program = counted[i]!;
    cuttingSeconds += program.seconds;
    if (i === 0) continue;
    const before = counted[i - 1]!;
    // No cutter change, no bit change: a new setup alone (or a program split by the planner for
    // another reason) is not a change the operator pays an attend/return price for.
    if (program.cutterKey === before.cutterKey) continue;
    changes += 1;
    changeSeconds += bitChangePriceSeconds(rule, before.seconds);
  }
  return {
    cuttingSeconds,
    changeSeconds,
    changes,
    totalSeconds: cuttingSeconds + changeSeconds,
    programCount: counted.length,
    setupCount: facts.setupCount,
    flip: facts.flip,
  };
}
