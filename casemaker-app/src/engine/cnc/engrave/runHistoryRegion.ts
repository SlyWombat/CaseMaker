/**
 * The `<runs-measured>` region of `runHistory.ts`: where it starts, where it ends, and how a list
 * of measured runs is rendered back into it (#277).
 *
 * WHY THIS IS ITS OWN MODULE, and not three functions inside `scripts/run-readback.ts` where
 * `feeds-readback.ts` keeps its twins. The script REWRITES A SOURCE FILE IN PLACE: a rendering that
 * does not match the region it replaces corrupts the file it was run on, and that is not something
 * to find out from a diff. Here the rendering is a pure function of the record list, so a spec can
 * assert the round trip the trade demands — splicing the empty list into the shipped `runHistory.ts`
 * returns the file byte for byte, and re-splicing a merged list is idempotent.
 *
 * The marker strings are BUILT from a name rather than written out, so this file does not itself
 * contain the marker line it searches for — not even in these comments, which a textual scan cannot
 * tell from code. `runHistory.ts` must hold that literal once, for the region to exist at all; if
 * this module held a second copy, a scan of the wrong file would splice the wrong place — silently,
 * and into source. `tests/unit/runHistory.spec.ts` asserts both halves of that.
 */

import type { RunRecord } from '@/engine/cnc/engrave/runRecord';

const REGION_NAME = 'runs-measured';
/** The two comment lines that bound the generated region. `runHistory.ts` carries the literals. */
export const RUNS_BEGIN = `// <${REGION_NAME}>`;
export const RUNS_END = `// </${REGION_NAME}>`;

/** Where the region lies in `source`. Throws — it does not guess — when there is no region. */
export function regionBounds(source: string, path = 'runHistory.ts'): { start: number; end: number } {
  const start = source.indexOf(RUNS_BEGIN);
  const end = source.indexOf(RUNS_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`${path} has no ${RUNS_BEGIN} … ${RUNS_END} region`);
  }
  return { start, end: end + RUNS_END.length };
}

/** The records the region currently declares. Throws when it is not a JSON array — never guesses. */
export function extractMeasuredRuns(source: string, path?: string): RunRecord[] {
  const { start, end } = regionBounds(source, path);
  const region = source.slice(start, end);
  const m = region.match(/=\s*(\[[\s\S]*\])\s*;/);
  if (!m) throw new Error(`the measured region in ${path ?? 'runHistory.ts'} has no array literal`);
  try {
    return JSON.parse(m[1]!) as RunRecord[];
  } catch (e) {
    throw new Error(`the measured region is not valid JSON: ${(e as Error).message}`);
  }
}

/** The region exactly as `runHistory.ts` ships it, for a list of records. */
export function renderMeasuredRuns(runs: readonly RunRecord[]): string {
  return [
    RUNS_BEGIN,
    '// Machine-written by `scripts/run-readback.ts` (#277) from a filled run record. Do not hand-edit.',
    `export const MEASURED_RUNS: readonly RunRecord[] = ${JSON.stringify(runs, null, 2)};`,
    RUNS_END,
  ].join('\n');
}

/** `source` with its region replaced. Pure, so a spec can check the splice without a filesystem. */
export function spliceMeasuredRuns(source: string, runs: readonly RunRecord[], path?: string): string {
  const { start, end } = regionBounds(source, path);
  return source.slice(0, start) + renderMeasuredRuns(runs) + source.slice(end);
}
