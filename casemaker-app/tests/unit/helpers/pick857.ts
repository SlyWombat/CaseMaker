/**
 * #857's coin and its four cutters, shared by the two split specs (#1180).
 *
 * The two tests were independent but ran serially in one file: one checks the counters against the
 * sweep, the other asks the search how it ranks them. Splitting them into their own files lets two
 * workers run them at once; this module is the fixture both read — the demo bench's own job file,
 * the four inventory cutters it names, and the two candidate plans. Nothing here is memoised or
 * mutable across tests; each file's tests build their own evaluations.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tl } from './manifoldExec';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { evaluatePlan, type CandidatePlan, type PlanEvaluation } from '@/workers/sim/planEvaluate';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';

export const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pick857');

export function coin(): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(join(DIR, 'j04-coin-pla-proxy.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.job;
}

const ALL = JSON.parse(readFileSync(join(DIR, 'tools.json'), 'utf8')) as ToolLibraryEntry[];
export const FLAT_3175 = 'inv:lib-111011313817';
export const CORN_19 = 'inv:lib-111218193810';
export const CORN_06 = 'inv:kz-corn-0-6-3';
export const V_03 = 'inv:lib-121032035020'; // 6 mm shank, 0.3 mm tip, 20° included
export const TOOLS = ALL.filter((t) => [FLAT_3175, CORN_19, CORN_06, V_03].includes(t.key));

const plan = (first: string, rest: string): CandidatePlan => ({
  cutters: [
    { key: first, items: ['clear'] },
    { key: rest, items: [] },
  ],
  source: { [first]: 'owned', [rest]: 'owned' },
});
export const CORN_PLAN = plan(CORN_19, CORN_06);
export const V_PLAN = plan(FLAT_3175, V_03);

export const ctx = { tl, tools: TOOLS, catalogue: [], shop: { tools: TOOLS }, calibration: null };

export const evaluate = async (job: EngraveJob, p: CandidatePlan, level: 'coarse' | 'full'): Promise<PlanEvaluation> =>
  await evaluatePlan(job, p, ctx, { level });

export const counterOf = (e: PlanEvaluation, char: string) => {
  const item = e.items.find((i) => i.id === 'clear')!;
  return (item.counters ?? []).filter((c) => c.char === char);
};

export const standing = (e: PlanEvaluation): number =>
  e.items.reduce((sum, i) => sum + (i.counters ?? []).reduce((s, c) => s + c.standingMm2, 0), 0);
