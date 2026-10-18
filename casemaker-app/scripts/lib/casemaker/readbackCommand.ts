/**
 * `casemaker readback feeds|run` (#477) — the two readbacks behind one command.
 *
 * `feeds` applies a filled coupon record to `feeds.ts` (#248 item 3); `run` applies a filled run
 * record to `runHistory.ts` (#277). The section is consumed here and the remainder is the record
 * script's own argv, so the flags (`--feeds`, `--history`, `--dry-run`) are unchanged.
 */
import { readbackFeedsMain } from './readbackFeeds';
import { readbackRunMain } from './readbackRun';

export const READBACK_SECTIONS = ['feeds', 'run'] as const;
export type ReadbackSection = (typeof READBACK_SECTIONS)[number];

export interface ReadbackHandlers {
  feeds: (argv: string[]) => Promise<number>;
  run: (argv: string[]) => Promise<number>;
}

export const defaultReadbackHandlers: ReadbackHandlers = {
  feeds: readbackFeedsMain,
  run: readbackRunMain,
};

/** Route `feeds`/`run`. Unknown sections are a usage error; the record's argv is untouched. */
export async function readbackMain(
  argv: string[],
  handlers: ReadbackHandlers = defaultReadbackHandlers,
): Promise<number> {
  const [section, ...rest] = argv;
  if (section === 'feeds') return handlers.feeds(rest);
  if (section === 'run') return handlers.run(rest);
  console.error(
    `casemaker readback: ${section === undefined ? 'a section is required' : `unknown section "${section}"`} — ` +
      `one of ${READBACK_SECTIONS.join(', ')}\n` +
      'usage: casemaker readback feeds|run <record.json> [--feeds|--history <path>] [--dry-run]',
  );
  return 2;
}
