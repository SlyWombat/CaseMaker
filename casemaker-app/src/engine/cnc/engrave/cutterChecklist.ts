/**
 * #1127 — THE CUTTER CHECKLIST'S ONE RULE, in the engine so every reader agrees.
 *
 * A row is SETTLED when the operator ticked it (located) or replaced it with another owned cutter.
 * After a replacement the whole run is re-generated and the checklist follows the run (migrated to
 * the new package's hash, still keyed by the ORIGINAL cutter), so the row for the cutter the new
 * programs actually post is found through the replacement: the entry whose `replacedWith` names it.
 * That keeps the gate open across the regenerate and keeps the run sheet and the record able to
 * name the bit that is in the spindle.
 */
import type { CutterChecklistEntry, CutterSubstitutions, EngraveJob } from '@/types/engraveJob';
import { jobSetups } from './jobSetup';

/** One entry is a settled statement: located, or replaced with a named cutter. */
export function cutterSettled(entry: CutterChecklistEntry | undefined): boolean {
  return entry !== undefined && (entry.state === 'located' || (entry.state === 'replaced' && entry.replacedWith !== undefined));
}

/**
 * The entry that settles `key`: its own, or a replacement entry whose `replacedWith` is `key`.
 * Undefined when the row is unaccounted for.
 */
export function settledCutterEntry(
  entries: Readonly<Record<string, CutterChecklistEntry>> | undefined,
  key: string,
): CutterChecklistEntry | undefined {
  if (entries === undefined) return undefined;
  const own = entries[key];
  if (cutterSettled(own)) return own;
  for (const entry of Object.values(entries)) {
    if (entry.state === 'replaced' && entry.replacedWith === key) return entry;
  }
  return undefined;
}

/** The distinct cutters a program list posts, in program order (the checklist's rows). */
export function distinctCutterKeys(programs: readonly { toolKey: string }[]): string[] {
  const keys: string[] = [];
  for (const program of programs) if (!keys.includes(program.toolKey)) keys.push(program.toolKey);
  return keys;
}

/**
 * #1136 — RECORD A REPLACEMENT WITHOUT REWRITING THE JOB. The substitution is kept as a map
 * (setup id → the cutter it lists → its stand-in) that `jobSetups` applies, so the document's own
 * `toolKey`/`setups[].tools` keep naming the operator's bits and the checklist rows keep their
 * original key. Every setup that lists the cutter (or already maps it) gets the entry; the
 * measured search's substitution sentence goes, exactly as the old in-place write cleared it.
 */
export function withCutterReplacement(job: EngraveJob, fromKey: string, toKey: string): EngraveJob {
  if (fromKey === toKey || fromKey.length === 0 || toKey.length === 0) return job;
  const substitutions: CutterSubstitutions = { ...(job.cutterSubstitutions ?? {}) };
  let changed = false;
  for (const setup of jobSetups(job)) {
    const lists = setup.tools.includes(fromKey) || substitutions[setup.id]?.[fromKey] !== undefined;
    if (!lists) continue;
    substitutions[setup.id] = { ...(substitutions[setup.id] ?? {}), [fromKey]: toKey };
    changed = true;
  }
  return changed ? { ...job, cutterSubstitutions: substitutions, substitution: undefined } : job;
}

/**
 * #1136 — WHY A REPLACEMENT IS REFUSED, or null. A cutter the SAME setup already posts would merge
 * that setup's two refs into one — a different program list, order and file names — so the partial
 * post cannot keep its promise ("the unaffected programs' bytes and order do not change"). The
 * replace picker excludes these; a press that gets through is refused by this sentence.
 */
export function replacementProblem(job: EngraveJob, fromKey: string, toKey: string): string | null {
  if (fromKey === toKey) return null;
  for (const setup of jobSetups(job)) {
    const lists = setup.tools.includes(fromKey) || job.cutterSubstitutions?.[setup.id]?.[fromKey] !== undefined;
    if (!lists) continue;
    if (setup.tools.some((key) => key !== fromKey && key === toKey)) {
      return `the same setup already posts ${toKey} — replacing ${fromKey} with it would merge the two programs and change the run's order; choose another owned cutter`;
    }
  }
  return null;
}
