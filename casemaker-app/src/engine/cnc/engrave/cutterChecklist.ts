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
import type { CutterChecklistEntry } from '@/types/engraveJob';

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
