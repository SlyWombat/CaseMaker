/**
 * The documents the headless MCP tools accept, as JSON Schema (#480).
 *
 * The schemas themselves are the existing Zod documents — this module does not re-state a field.
 * `generateMcpSchemas` turns each into JSON Schema with `z.toJSONSchema()`, and the generator
 * script writes the result to `schemas/` beside this file. `tests/unit/mcpSchemas.spec.ts` reruns
 * generation and fails when a checked-in copy differs, so a schema change and its JSON land in
 * the same commit.
 *
 * The CURRENT-version aliases are deliberate: `projectSchema` and `engraveJobSchema` accept every
 * historical version and migrate them, and emitting one of those would produce sixteen (or three)
 * migrated copies of the same document rather than one shape an author can write.
 *
 * The receipt (#478) is here as of its own landing: it is the document every command returns, and
 * the MCP tools of #481 hand the same object back, so its schema belongs beside the inputs.
 */

import { z } from 'zod';

import { couponSpecFileSchema } from '@/engine/cnc/engrave/couponJob';
import { boardProfileSchema } from '@/library/schema';
import { engraveJobDocumentSchema } from '@/store/engraveJobSchema';
import { projectDocumentSchema } from '@/store/projectSchema';
import { receiptSchema } from '@/platform/headless/receipt';

/** One document per MCP input/result shape, in the order the generator writes them. */
export const mcpSchemaDocuments = {
  project: projectDocumentSchema,
  'engrave-job': engraveJobDocumentSchema,
  'board-library': z
    .array(boardProfileSchema)
    .describe('The board library: an array of board profiles bundled with or imported into the app.'),
  'coupon-spec': couponSpecFileSchema,
  receipt: receiptSchema,
} as const;

export type McpSchemaName = keyof typeof mcpSchemaDocuments;

export const MCP_SCHEMA_NAMES = Object.keys(mcpSchemaDocuments) as McpSchemaName[];

/**
 * JSON Schema is built with `io: 'input'` — the shape a caller AUTHORS. `unrepresentable: 'any'`
 * keeps a refinement-only or preprocessed field representable instead of throwing; the emitted
 * object for a `z.preprocess` is its inner object shape (Zod 4), which is what we want.
 */
export function generateMcpSchema(name: McpSchemaName): string {
  const json = z.toJSONSchema(mcpSchemaDocuments[name], {
    io: 'input',
    unrepresentable: 'any',
  });
  return `${JSON.stringify(sortKeys(json), null, 2)}\n`;
}

/**
 * Two normalisations while walking the generated object:
 *
 *  - object keys are sorted, so a declaration moving without changing meaning does not alter the
 *    checked-in file;
 *  - a `default` minted by `newId()` is DROPPED. The job and setup ids default to a fresh random
 *    id on every parse, so serialising today's value would make the artifact — and the freshness
 *    spec — change on every run. The field's description already says an id is generated when the
 *    document does not state one, which is the fact an author needs.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const name of Object.keys(record).sort()) {
    const child = record[name];
    if (name === 'default' && typeof child === 'string' && /^(?:job|setup)-[a-z0-9]+$/.test(child)) {
      continue;
    }
    sorted[name] = sortKeys(child);
  }
  return sorted;
}

/** All five documents, keyed by their file stem. */
export function generateMcpSchemas(): Record<McpSchemaName, string> {
  const out = {} as Record<McpSchemaName, string>;
  for (const name of MCP_SCHEMA_NAMES) out[name] = generateMcpSchema(name);
  return out;
}
