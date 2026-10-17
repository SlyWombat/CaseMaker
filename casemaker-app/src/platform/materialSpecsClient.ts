/**
 * The vendor's purchasable stock sizes (#446): their schema, and the request that reads them. The
 * service's half is `src-tauri/src/catalogue.rs` — the sizes are read out of Makera Studio's
 * `t_MaterialSpecs` at sync time into `catalogue.json`, and served by `GET /api/v1/material-specs`
 * under #347 Route A. **No vendor row is committed to the repo**; this module only knows the shape.
 *
 * ONE SHAPE, TWO IMPLEMENTATIONS (#320's rule). The service drops a row that is missing a dimension
 * its shape needs, and this schema restates that rule per row — so a build reading a service from a
 * newer vendor library still loads the sizes it understands instead of failing the whole list.
 *
 * THE MATERIAL IS THE VENDOR'S WORD, VERBATIM ("6061 Aluminum", "PCB"), exactly as a feed row's is.
 * Deciding which of those the shelf can offer is the client's map's question (`feeds.ts`), not this
 * reader's: serving a size the app cannot cut is the vendor's claim, not a malformed row.
 *
 * TWO SHAPES, EACH WITH ITS OWN DIMS. `R` is a rectangular blank — `length × width × height` — and
 * `C` is a round bar, `diameter × length`. The dims a shape does not use are served `null`; a row that
 * states them anyway is refused, on the same reasoning as `stock.rs`'s "a form carries no other size
 * field": a round bar with a width is a row one of the two sides is misreading.
 */

import { z } from 'zod';
import { houseRequest, type HouseReadFailure, type HouseRequestOptions } from './houseClient';

export const MATERIAL_SPEC_SHAPES = ['R', 'C'] as const;
export type MaterialSpecShape = (typeof MATERIAL_SPEC_SHAPES)[number];

const positive = z.number().finite().positive();
const filled = z.string().refine((v) => v.trim().length > 0, 'is empty');

export const MaterialSpecSchema = z
  .object({
    /** `materialSpecsID`, the vendor's row identity. */
    id: filled,
    /** `t_MaterialList.materialSubcategoryName`, verbatim. */
    material: filled,
    /** `materialName` — the vendor's product name, which is what a picker would show. */
    name: filled,
    shape: z.enum(MATERIAL_SPEC_SHAPES),
    /** mm; present on both shapes. */
    length: positive,
    width: positive.nullable().default(null),
    height: positive.nullable().default(null),
    diameter: positive.nullable().default(null),
    /** `g_ID`, the vendor's stock-size code — provenance, not identity. May be empty. */
    stockCode: z.string().default(''),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const issue = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: 'custom', message, path });
    if (spec.shape === 'R') {
      if (spec.width == null) issue('a rectangular size needs a width, in mm', ['width']);
      if (spec.height == null) issue('a rectangular size needs a height, in mm', ['height']);
      if (spec.diameter != null) issue('a rectangular size has no diameter', ['diameter']);
    } else {
      if (spec.diameter == null) issue('a round size needs a diameter, in mm', ['diameter']);
      if (spec.width != null) issue('a round size has no width', ['width']);
      if (spec.height != null) issue('a round size has no height', ['height']);
    }
  });

export type MaterialSpec = z.infer<typeof MaterialSpecSchema>;

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unrecognised shape';
  const at = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${at}${issue.message}`;
}

export interface UnreadableMaterialSpec {
  id: string | null;
  reason: string;
}

export type MaterialSpecsRead =
  | { kind: 'ok'; etag: string | null; specs: MaterialSpec[]; unreadable: UnreadableMaterialSpec[] }
  | HouseReadFailure;

/**
 * Read the vendor sizes, ONE ROW AT A TIME as the shelf and the machines are: a row this build cannot
 * read — a shape from a newer library, a dim its shape needs but does not state — is set aside with
 * its reason and the rest still load.
 *
 * A 404 is a service from before #446, which has no sizes to offer. `[]` is a normal answer: a library
 * with no `t_MaterialSpecs`, or a catalogue synced before the sizes were read.
 */
export async function houseMaterialSpecs(opts?: HouseRequestOptions): Promise<MaterialSpecsRead> {
  const res = await houseRequest('GET', '/material-specs', undefined, opts);
  if (res.kind === 'refused') {
    return res.status === 404 ? { kind: 'absent', reason: res.message } : { kind: 'error', detail: res.message };
  }
  if (res.kind !== 'ok') return res;
  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    return { kind: 'error', detail: "the vendor's stock sizes are not readable JSON" };
  }
  if (!Array.isArray(json)) return { kind: 'error', detail: "the vendor's stock sizes are not a list" };
  const specs: MaterialSpec[] = [];
  const unreadable: UnreadableMaterialSpec[] = [];
  for (const raw of json) {
    const rawId = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
    const parsed = MaterialSpecSchema.safeParse(raw);
    if (parsed.success) specs.push(parsed.data);
    else unreadable.push({ id: typeof rawId === 'string' ? rawId : null, reason: firstIssue(parsed.error) });
  }
  return { kind: 'ok', etag: res.etag ?? null, specs, unreadable };
}
