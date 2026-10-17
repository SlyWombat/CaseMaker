/**
 * The feeds table (#450): its schema, the one thing both sides agree on. The service's half is
 * `src-tauri/src/feeds.rs`.
 *
 * ONE SHAPE, TWO IMPLEMENTATIONS (#320's rule). The service holds a row to the table's rules — an id,
 * a material word, an ordered positive diameter band, seven positive parameters, a source and its
 * date, a sentence of note and a sentence of provenance — and this schema restates them, plus the two
 * things only this side knows: the MATERIAL word, which must be one of the app's own
 * (`STOCK_MATERIALS`), and the vocabulary of `source` and `edge` as literals rather than enums.
 *
 * THE ONE CROSS-ROW RULE (#450). `entryFor` (`engine/cnc/feeds.ts:757`) takes the FIRST row whose
 * material, edge and diameter range match, and the inclusive both-ends convention at a shared boundary
 * is load-bearing (`feeds.ts:174-177`). Two rows that share a material and an edge may TOUCH — 0.8-1.6
 * and 1.6-3.2 — but they may not overlap or repeat a range, or the answer depends on row ORDER rather
 * than on the cutter. `.superRefine` on `FeedsTableSchema` refuses it on import, as `validate_table`
 * refuses it on the service, so an imported document cannot carry a table the service would reject.
 *
 * THE SPECIMEN BOTH SIDES READ is `tests/unit/fixtures/feed-table.json`, the way `stock-refusals.json`
 * is for the shelf: `feedTable.spec.ts` parses its rows through this schema and `feeds.rs` parses them
 * through serde, and a key spelled differently on one side fails that side's reader.
 */

import { z } from 'zod';
import { STOCK_MATERIALS } from '@/engine/cnc/materials';

/** The cutter edge a row is for (#405). `null` — an absent field — means `flat`. */
export const FEED_EDGES = ['flat', 'v'] as const;
export type FeedEdge = (typeof FEED_EDGES)[number];

/** Where a row's numbers came from — the vocabulary the shop `defaults` section already uses. */
export const FEED_SOURCES = ['seeded', 'chosen', 'measured'] as const;
export type FeedSource = (typeof FEED_SOURCES)[number];

/** The longest a `note` or a `provenance` may be, matching `defaults.rs`'s sentence rule. */
const MAX_SENTENCE = 400;

const positive = z.number().finite().positive();
// eslint-disable-next-line no-control-regex
const NO_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** `defaults.rs`'s note rule: a sentence of at most 400 characters, with no control character. */
const sentence = z.string().max(MAX_SENTENCE).refine((v) => !NO_CONTROL.test(v), 'has a control character');
/** `feeds.rs`'s id rule: not empty, no space at either end, no slash, no control character. */
const feedId = z
  .string()
  .refine(
    (v) => v.trim().length > 0 && v === v.trim() && !v.includes('/') && !NO_CONTROL.test(v),
    'not empty, no slash, no control character, no space at either end',
  );

// Strict at every level, as the service is (`deny_unknown_fields`): a key this build does not know is
// a refusal on both sides, not a key Zod silently drops.
export const FeedParamsSchema = z
  .object({
    rpm: positive,
    feed: positive,
    plungeFeed: positive,
    stepDown: positive,
    stepOverFraction: positive,
    peckFraction: positive,
    air: z.boolean(),
  })
  .strict();
export type FeedParams = z.infer<typeof FeedParamsSchema>;

export const FeedRowSchema = z
  .object({
    id: feedId,
    material: z.enum(STOCK_MATERIALS),
    edge: z.enum(FEED_EDGES).nullable().default(null),
    minDiameter: positive,
    maxDiameter: positive,
    params: FeedParamsSchema,
    source: z.enum(FEED_SOURCES),
    setAt: z.string().nullable().default(null),
    note: sentence.nullable().default(null),
    provenance: sentence.refine((v) => v.trim().length > 0, 'is empty'),
  })
  .strict()
  .superRefine((row, ctx) => {
    const issue = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: 'custom', message, path });
    if (row.minDiameter > row.maxDiameter) {
      issue(`its diameters run backwards: ${row.minDiameter} mm to ${row.maxDiameter} mm`, ['maxDiameter']);
    }
    if (row.source !== 'seeded' && (row.setAt == null || row.setAt.trim() === '')) {
      issue('a chosen or measured row says when it was set', ['setAt']);
    }
  });

export type FeedRow = z.infer<typeof FeedRowSchema>;

/** The effective edge the cross-row rule groups by: an absent `edge` is `flat`. */
export function effectiveEdge(row: Pick<FeedRow, 'edge'>): FeedEdge {
  return row.edge ?? 'flat';
}

/**
 * The whole table, strict: what an import is checked against. One id per row, and the cross-row rule —
 * no two rows that share a material and an edge may overlap or repeat a diameter range.
 */
export const FeedsTableSchema = z.array(FeedRowSchema).superRefine((rows, ctx) => {
  const issue = (message: string, path: (string | number)[] = []) =>
    ctx.addIssue({ code: 'custom', message, path });
  const ids = new Set<string>();
  rows.forEach((row, i) => {
    if (ids.has(row.id)) issue(`feed ${row.id} appears twice`, [i, 'id']);
    ids.add(row.id);
  });
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i]!;
      const b = rows[j]!;
      if (a.material !== b.material || effectiveEdge(a) !== effectiveEdge(b)) continue;
      // Touching at a shared boundary is allowed on purpose; only interiors meeting is a conflict.
      const overlap = a.minDiameter < b.maxDiameter && b.minDiameter < a.maxDiameter;
      const duplicate = a.minDiameter === b.minDiameter && a.maxDiameter === b.maxDiameter;
      if (overlap || duplicate) {
        issue(
          `feeds ${a.id} and ${b.id} both cover ${a.minDiameter}–${a.maxDiameter} mm and ` +
            `${b.minDiameter}–${b.maxDiameter} mm for ${a.material}: the first matching row wins, so ` +
            `an overlap makes the answer depend on row order`,
          [j, 'minDiameter'],
        );
      }
    }
  }
});

export type FeedsTable = z.infer<typeof FeedsTableSchema>;

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unrecognised shape';
  const at = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${at}${issue.message}`;
}

/** Why a row would be refused, or null — for a form that wants to say so before it sends. */
export function feedProblem(row: unknown): string | null {
  const parsed = FeedRowSchema.safeParse(row);
  return parsed.success ? null : firstIssue(parsed.error);
}

/** Why a whole table would be refused, or null — the cross-row rule a single row cannot see. */
export function feedTableProblem(table: unknown): string | null {
  const parsed = FeedsTableSchema.safeParse(table);
  return parsed.success ? null : firstIssue(parsed.error);
}
