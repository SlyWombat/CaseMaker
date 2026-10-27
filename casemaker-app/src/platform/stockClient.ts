/**
 * The stock shelf (#413, `docs/design/cnc-job-workflow.md` §3.1, §5.1): its schema, and the requests
 * that read it and write an entry. The service's half is `src-tauri/src/stock.rs`.
 *
 * ONE SHAPE, TWO IMPLEMENTATIONS (#320's rule). The service holds an entry to the shelf's rules —
 * the dimensions its form needs, layers inside the stock, a domed height, reservations within the
 * count — and this schema restates them, plus the one thing only this side knows: the MATERIAL word,
 * which must be one of the app's own (`STOCK_MATERIALS`). The specimen both sides are tested against
 * is the `stock` list in `tests/unit/fixtures/location-doc.json`.
 *
 * READ ONE ENTRY AT A TIME, as machines are (#412 review): an entry this build cannot read — a
 * material word from a newer build — is set aside with its reason and the rest of the shelf loads.
 *
 * A SPHERE IS REFUSED BY NAME (decision Q20): nothing at the location holds one and nothing cuts one.
 */

import { z } from 'zod';
import { STOCK_MATERIALS } from '@/engine/cnc/materials';
import {
  houseRequest,
  type HouseFailure,
  type HouseReadFailure,
  type HouseRequestOptions,
  type HouseWrite,
} from './houseClient';

export const STOCK_FORMS = ['sheet', 'plate', 'block', 'rod', 'tube', 'disc', 'printed-blank'] as const;
export type StockForm = (typeof STOCK_FORMS)[number];
export const STOCK_FINISHES = ['rough', 'finished', 'printed', 'unknown'] as const;
export type StockFinish = (typeof STOCK_FINISHES)[number];
export const STOCK_FLATNESS = ['flat', 'domed', 'unknown'] as const;
export type StockFlatness = (typeof STOCK_FLATNESS)[number];
export const STOCK_SOURCES = ['purchased', 'printed', 'offcut', 'other'] as const;
export type StockSource = (typeof STOCK_SOURCES)[number];
/**
 * Where a laminate's cap came from (#492). `assumed` is the maintainer's 0.075 mm until the sheet
 * is measured; it is a different claim from a datasheet's or a bench reading and must read as one.
 * A printed blank has no cap of its own on the shelf — its colour facts are the job's print.
 */
export const STOCK_CAP_SOURCES = ['assumed', 'measured'] as const;
export type StockCapSource = (typeof STOCK_CAP_SOURCES)[number];

/** The sentence a sphere is refused with — the same reason `stock.rs` gives. */
export const SPHERE_REFUSAL =
  'sphere stock is not offered — nothing at the location holds one and nothing here cuts one';

/** The size fields, by form: what a form needs, and therefore all it may carry. */
export const SIZE_FIELDS: Readonly<Record<StockForm, readonly SizeField[]>> = {
  sheet: ['length', 'width', 'thickness'],
  plate: ['length', 'width', 'thickness'],
  block: ['length', 'width', 'thickness'],
  'printed-blank': ['length', 'width', 'thickness'],
  rod: ['diameter', 'length'],
  // #713 — a tube's size is its OUTER diameter, its wall and its length. The wall, not an inner
  // diameter: it is the number every later cut depth is capped by, and the job round-trips it as
  // `{ diameter, wall, length }`.
  tube: ['diameter', 'wall', 'length'],
  disc: ['diameter', 'thickness'],
};
export type SizeField = 'length' | 'width' | 'thickness' | 'diameter' | 'wall';
const ALL_SIZE_FIELDS: readonly SizeField[] = ['length', 'width', 'thickness', 'diameter', 'wall'];

/** Whether a form has a flat top a colour stack can sit in. */
export function formIsFlat(form: StockForm): boolean {
  return form !== 'rod' && form !== 'tube';
}

const mm = z.number().finite();
/** Not empty once trimmed — and NOT trimmed: the service keeps the text as sent, so this does too. */
const filled = z.string().refine((v) => v.trim().length > 0, 'is empty');
/** `stock.rs`'s id rule: not empty, no space at either end, no slash, no control character. */
const stockId = z
  .string()
  .refine(
    // eslint-disable-next-line no-control-regex
    (v) => v.trim().length > 0 && v === v.trim() && !v.includes('/') && !/[\u0000-\u001f\u007f-\u009f]/.test(v),
    'not empty, no slash, no control character, no space at either end',
  );
// Strict at every level, as the service is (`deny_unknown_fields`): a key this build does not know
// is a refusal on both sides, not a key Zod silently drops (#413 review).
const ClaimSchema = z
  .object({
    jobId: filled,
    quantity: z.number().int().positive(),
    at: filled,
  })
  .strict();
export type StockClaim = z.infer<typeof ClaimSchema>;

export const StockItemSchema = z
  .object({
    id: stockId,
    material: z.enum(STOCK_MATERIALS),
    form: z.string(),
    size: z
      .object({
        length: mm.nullable().optional(),
        width: mm.nullable().optional(),
        thickness: mm.nullable().optional(),
        diameter: mm.nullable().optional(),
        wall: mm.nullable().optional(),
      })
      .strict(),
    layers: z.array(z.object({ name: filled, thickness: mm }).strict()).default([]),
    /**
     * The top colour's thickness from the top face, mm (#492) — a PURCHASED two-colour laminate's
     * stated cap. `null` on every other entry. It is not a layer: a row with a cap carries no
     * `layers`, because a laminate has no printer grid.
     */
    capMm: mm.nullable().default(null),
    /** Where the cap came from (#492). Present exactly when `capMm` is. */
    capSource: z.enum(STOCK_CAP_SOURCES).nullable().default(null),
    finish: z.enum(STOCK_FINISHES),
    flatness: z.enum(STOCK_FLATNESS),
    domeHeight: mm.nullable().default(null),
    conductive: z.boolean(),
    quantity: z.number().int().nonnegative(),
    reservations: z.array(ClaimSchema).default([]),
    consumed: z.array(ClaimSchema).default([]),
    source: z.enum(STOCK_SOURCES),
    notes: z.string().nullable().default(null),
    addedAt: filled,
  })
  .strict()
  .superRefine((item, ctx) => {
    const issue = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: 'custom', message, path });
    if (item.form === 'sphere') return issue(SPHERE_REFUSAL, ['form']);
    if (!(STOCK_FORMS as readonly string[]).includes(item.form)) {
      return issue(`"${item.form}" is not a stock form`, ['form']);
    }
    const form = item.form as StockForm;
    const needed = SIZE_FIELDS[form];
    for (const f of ALL_SIZE_FIELDS) {
      const v = item.size[f];
      const present = v !== null && v !== undefined;
      if (needed.includes(f) && !(present && v > 0)) issue(`a ${f} is needed, in mm, above 0`, ['size', f]);
      if (!needed.includes(f) && present) issue(`a ${form} has no ${f}`, ['size', f]);
    }
    // #713 — a tube's wall must leave a bore: two walls less than the outer diameter.
    if (form === 'tube' && 2 * (item.size.wall ?? 0) >= (item.size.diameter ?? 0)) {
      issue("a tube's wall must leave a bore — two walls are less than its outer diameter", ['size', 'wall']);
    }
    if (item.layers.length > 0) {
      const total = item.size.thickness;
      if (!formIsFlat(form) || total == null) issue(`a ${form} has no flat top to carry layers`, ['layers']);
      else {
        if (item.layers.some((l) => !(l.thickness > 0))) issue('every layer needs a thickness above 0', ['layers']);
        const sum = item.layers.reduce((a, l) => a + l.thickness, 0);
        if (sum > total + 1e-9) issue(`the layers come to ${sum} mm, more than the ${total} mm stock`, ['layers']);
      }
    }
    if (item.flatness === 'domed' && !(item.domeHeight != null && item.domeHeight > 0)) {
      issue("domed stock needs the dome's height, in mm", ['domeHeight']);
    }
    if (item.flatness !== 'domed' && item.domeHeight != null) issue('only domed stock has a dome height', ['domeHeight']);
    // #492 — a purchased laminate's colour cap. It requires a flat top and a thickness to measure
    // from, cannot exceed the stock, and cannot sit beside printed layers: those are two different
    // descriptions of a colour plane, and claiming both would let the depth model pick one silently.
    if (item.capMm != null) {
      if (!formIsFlat(form) || item.size.thickness == null) {
        issue(`a ${form} has no flat top to carry a colour cap`, ['capMm']);
      } else if (!(item.capMm > 0) || item.capMm > item.size.thickness + 1e-9) {
        issue(`the colour cap must be above 0 and no thicker than the ${item.size.thickness} mm stock`, ['capMm']);
      }
      if (item.layers.length > 0) issue('a laminate has no printed layers', ['layers']);
      if (form === 'printed-blank') issue('a printed blank states its colour in the job, not as a shelf cap', ['capMm']);
      if (item.capSource == null) issue('a colour cap states where it came from, assumed or measured', ['capSource']);
    } else if (item.capSource != null) {
      issue('only a stock entry with a colour cap states a cap source', ['capSource']);
    }
    const jobs = new Set<string>();
    for (const r of item.reservations) {
      if (jobs.has(r.jobId)) issue(`job ${r.jobId} holds two reservations`, ['reservations']);
      jobs.add(r.jobId);
    }
    const held = item.reservations.reduce((a, r) => a + r.quantity, 0);
    if (held > item.quantity) issue(`${held} reserved, but only ${item.quantity} on the shelf`, ['reservations']);
  })
  .transform((item) => ({ ...item, form: item.form as StockForm }));

export type StockItem = z.infer<typeof StockItemSchema>;

/** The whole shelf, strict: what an import is checked against. One id per entry. */
export const StockShelfSchema = z.array(StockItemSchema).superRefine((list, ctx) => {
  const ids = new Set<string>();
  list.forEach((s, i) => {
    if (ids.has(s.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `stock ${s.id} appears twice` });
    ids.add(s.id);
  });
});

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unrecognised shape';
  const at = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${at}${issue.message}`;
}

/** Why an entry would be refused, or null — for a form that wants to say so before it sends. */
export function stockProblem(item: unknown): string | null {
  const parsed = StockItemSchema.safeParse(item);
  return parsed.success ? null : firstIssue(parsed.error);
}

export interface UnreadableStock {
  id: string | null;
  reason: string;
}

export type StockRead =
  | { kind: 'ok'; etag: string | null; items: StockItem[]; unreadable: UnreadableStock[] }
  | HouseReadFailure;

/** Read the shelf, one entry at a time. A 404 is a service from before #413: no shelf there. */
export async function houseStock(opts?: HouseRequestOptions): Promise<StockRead> {
  const res = await houseRequest('GET', '/stock', undefined, opts);
  if (res.kind === 'refused') {
    return res.status === 404 ? { kind: 'absent', reason: res.message } : { kind: 'error', detail: res.message };
  }
  if (res.kind !== 'ok') return res;
  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    return { kind: 'error', detail: 'the stock shelf is not readable JSON' };
  }
  if (!Array.isArray(json)) return { kind: 'error', detail: 'the stock shelf is not a list' };
  const items: StockItem[] = [];
  const unreadable: UnreadableStock[] = [];
  for (const raw of json) {
    const rawId = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
    const parsed = StockItemSchema.safeParse(raw);
    if (parsed.success) items.push(parsed.data);
    else unreadable.push({ id: typeof rawId === 'string' ? rawId : null, reason: firstIssue(parsed.error) });
  }
  return { kind: 'ok', etag: res.etag ?? null, items, unreadable };
}

/** Checked against the schema before it is sent, so a refusal names the field in this build's words. */
function checked(item: StockItem): HouseFailure | null {
  const why = stockProblem(item);
  return why === null ? null : { kind: 'refused', status: 400, message: why };
}

function okOnly(res: Awaited<ReturnType<typeof houseRequest>>): HouseWrite {
  return res.kind === 'ok' ? { kind: 'ok' } : res;
}

/** Put an entry on the shelf. Not guarded: the id is judged instead (409 when it is taken). */
export async function houseAddStock(item: StockItem, opts?: HouseRequestOptions): Promise<HouseWrite> {
  return checked(item) ?? okOnly(await houseRequest('POST', '/stock', item, opts));
}

/** Replace an entry. GUARDED (#321) on the shelf's `ETag`. */
export async function houseReplaceStock(
  item: StockItem,
  ifMatch: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  return (
    checked(item) ??
    okOnly(await houseRequest('PATCH', `/stock/${encodeURIComponent(item.id)}`, item, { ...opts, ifMatch }))
  );
}

/** Take an entry off the shelf. Guarded as a replace is. */
export async function houseRemoveStock(
  id: string,
  ifMatch: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  return okOnly(await houseRequest('DELETE', `/stock/${encodeURIComponent(id)}`, undefined, { ...opts, ifMatch }));
}
