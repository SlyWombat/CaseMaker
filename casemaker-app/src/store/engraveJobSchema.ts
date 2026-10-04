import { z } from 'zod';
import { Z1 } from '@/engine/cnc/machine';
import type { EngraveJob } from '@/types/engraveJob';

/**
 * The Zod mirror of `EngraveJob` (#200). A field on the TypeScript type with no entry here
 * is silently stripped on load, so the two must be edited together.
 *
 * Unknown keys are STRIPPED (Zod's default object behaviour), not rejected: a hand-edited or
 * newer-minor file still loads, with keys this version does not know dropped rather than
 * failing the whole job. That is the opposite of the refusal policy for UNTRUSTED tool input
 * (`/Simulation.md` §6): a job file is the user's own document, not a foreign one.
 */

/**
 * The stock bounds ARE the Z1 work envelope, read rather than retyped (200 × 200 × 100). The
 * envelope runs negative in machine coordinates, so the usable size is max − min per axis.
 */
const STOCK_LIMITS = {
  length: Z1.envelope.x.max - Z1.envelope.x.min,
  width: Z1.envelope.y.max - Z1.envelope.y.min,
  thickness: Z1.envelope.z.max - Z1.envelope.z.min,
} as const;

/** The largest a label's cap height may be, mm. A blank this size is 12 mm thick; 100 mm is a guard, not a physical limit. */
const MAX_LABEL_SIZE = 100;
/** Longest label text, characters. Matches nothing physical — a parser and display guard. */
const MAX_TEXT_LENGTH = 200;

const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

const labelSchema = z.object({
  id: z.string().min(1),
  text: z.string().max(MAX_TEXT_LENGTH),
  font: z.string().min(1),
  weight: z.enum(['regular', 'bold']),
  size: z.number().finite().min(1).max(MAX_LABEL_SIZE),
  position: positionSchema,
  rotation: z.number().finite(),
  depth: z.number().finite().positive(),
  enabled: z.boolean(),
});

const viseSchema = z.object({
  stockProud: z.number().finite(),
  fixedJawThickness: z.number().finite(),
  movingJawThickness: z.number().finite(),
  jawLength: z.number().finite(),
  jawStartY: z.number().finite(),
  source: z.enum(['default', 'saved', 'measured']),
  uncertainty: z.number().finite().nonnegative(),
  // Optional: a shipped default carries no date. Absent keys are preserved as absent.
  measuredAt: z.string().optional(),
});

const stockSchema = z.object({
  length: z.number().finite().positive().max(STOCK_LIMITS.length),
  width: z.number().finite().positive().max(STOCK_LIMITS.width),
  thickness: z.number().finite().positive().max(STOCK_LIMITS.thickness),
  material: z.enum(['softwood', 'hardwood', 'mdf', 'pla']),
});

const customFontSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  data: z.string(),
});

export const engraveJobSchema: z.ZodType<EngraveJob> = z.object({
  schemaVersion: z.literal(1),
  name: z.string(),
  stock: stockSchema,
  labels: z.array(labelSchema),
  toolKey: z.string().min(1),
  workholding: z.object({
    kind: z.literal('vise'),
    vise: viseSchema,
  }),
  minFloor: z.number().finite().nonnegative(),
  edgeMargin: z.number().finite().nonnegative(),
  customFonts: z.array(customFontSchema),
});

export type ParseEngraveJobResult =
  | { ok: true; job: EngraveJob }
  | { ok: false; errors: string[] };

/**
 * `labels[0].depth: ...` rather than Zod's `path.join('.')` — a finding a human reads should
 * point at the array element the way JavaScript spells it.
 */
function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out || '<root>';
}

/** Validate an unknown payload as an `EngraveJob`, collecting every issue as a readable line. */
export function parseEngraveJob(json: unknown): ParseEngraveJobResult {
  const result = engraveJobSchema.safeParse(json);
  if (result.success) return { ok: true, job: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`),
  };
}

export { STOCK_LIMITS };
