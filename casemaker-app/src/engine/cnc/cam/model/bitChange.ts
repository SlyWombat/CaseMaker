/**
 * #1114 — THE BIT CHANGE IS PRICED, AND ITS PRICE DEPENDS ON THE PROGRAM BEFORE IT.
 *
 * The maintainer's decision (2026-11-09): "Bit change time is variable. If the current job is more
 * than 30 min, a bit change is exponentially longer than [after] a 5 minute job — people will walk
 * away from the machine." A change after a long program is not the same act as one after a short
 * one, so a plan that puts its changes early is worth more than a flat per-change allowance says.
 *
 * THE RULE, from four shop settings (recommendations, not constants — the thresholds rule):
 *
 *  - while the preceding program is at most `attendedMinutes` (rec. 5): the operator is there, and
 *    the change costs `attendedChangeSeconds` (rec. 120);
 *  - from `walkAwayMinutes` (rec. 30) on: they have left, and the change costs `returnMinutes`
 *    (rec. 15) on top — 1 020 s with the recommendations;
 *  - between the two the cost rises on a smooth step, `3t² − 2t³` with `t` the position between the
 *    thresholds. The sheet states the shape, so an estimate read on paper is auditable.
 *
 * The earlier flat `toolChange.seconds` remains the LABELLED FALLBACK for a caller with no rule
 * ({@link flatBitChangeRule}), so a pocket-chain estimate that never had a duration to price against
 * keeps its own number and every pre-#1114 caller is unchanged.
 */

/** The four shop numbers the change price reads. */
export interface BitChangeRule {
  /** A change after a program at most this long is attended. */
  attendedMinutes: number;
  /** What an attended change costs, s. */
  attendedChangeSeconds: number;
  /** A change after a program at least this long finds the operator gone. */
  walkAwayMinutes: number;
  /** The return on top of the attended cost once they have left, minutes. */
  returnMinutes: number;
}

/** The recommended rule — the values the issue's decision states. */
export const BIT_CHANGE_RECOMMENDED: BitChangeRule = {
  attendedMinutes: 5,
  attendedChangeSeconds: 120,
  walkAwayMinutes: 30,
  returnMinutes: 15,
};

/** The settings' keys, so the reader and the seeds cannot spell one differently. */
export const BIT_CHANGE_KEYS = {
  attendedMinutes: 'bitChange.attendedMinutes',
  attendedChangeSeconds: 'bitChange.attendedChangeSeconds',
  walkAwayMinutes: 'bitChange.walkAwayMinutes',
  returnMinutes: 'bitChange.returnMinutes',
} as const;

export type BitChangeStanding = 'attended' | 'rising' | 'walk-away';

/** Where the operator is when the change comes. */
export function bitChangeStanding(rule: BitChangeRule, precedingSeconds: number): BitChangeStanding {
  const minutes = precedingSeconds / 60;
  if (minutes <= rule.attendedMinutes) return 'attended';
  if (minutes >= rule.walkAwayMinutes) return 'walk-away';
  return 'rising';
}

/**
 * What a change costs, s, given the preceding program's own duration. A rule whose thresholds
 * coincide (or a flat rule, `walkAwayMinutes: 0`) prices every change the same — the pre-#1114
 * behaviour through the same function.
 */
export function bitChangePriceSeconds(rule: BitChangeRule, precedingSeconds: number): number {
  const minutes = precedingSeconds / 60;
  if (minutes <= rule.attendedMinutes) return rule.attendedChangeSeconds;
  if (minutes >= rule.walkAwayMinutes) return rule.attendedChangeSeconds + rule.returnMinutes * 60;
  const span = rule.walkAwayMinutes - rule.attendedMinutes;
  if (span <= 0) return rule.attendedChangeSeconds + rule.returnMinutes * 60;
  const t = (minutes - rule.attendedMinutes) / span;
  const s = t * t * (3 - 2 * t);
  return rule.attendedChangeSeconds + rule.returnMinutes * 60 * s;
}

/** The pre-#1114 flat allowance expressed as a rule the same functions can price. */
export function flatBitChangeRule(seconds: number): BitChangeRule {
  return { attendedMinutes: 0, attendedChangeSeconds: seconds, walkAwayMinutes: 0, returnMinutes: 0 };
}

/** The shape stated on the sheet, in the rule's own numbers. */
export function bitChangeShapeSentence(rule: BitChangeRule): string {
  const a = rule.attendedMinutes;
  const b = rule.walkAwayMinutes;
  const attended = formatSeconds(rule.attendedChangeSeconds);
  const away = formatSeconds(rule.attendedChangeSeconds + rule.returnMinutes * 60);
  if (b <= a) return `every bit change is priced at ${attended}`;
  return (
    `a bit change is priced from the program before it: ${attended} up to ${a} min, ` +
    `${away} from ${b} min on, and a smooth rise (3t² − 2t³) between`
  );
}

function formatSeconds(seconds: number): string {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}
