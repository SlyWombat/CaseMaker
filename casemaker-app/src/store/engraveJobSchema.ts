import { z } from 'zod';
import { Z1 } from '@/engine/cnc/machine';
import { DEFAULT_BREAKTHROUGH, noneSacrificial } from '@/engine/cnc/sacrificial';
import type { EngraveJob } from '@/types/engraveJob';

/**
 * The Zod mirror of `EngraveJob` (#200). A field on the TypeScript type with no entry here
 * is silently stripped on load, so the two must be edited together.
 *
 * Unknown keys are STRIPPED (Zod's default object behaviour), not rejected: a hand-edited or
 * newer-minor file still loads, with keys this version does not know dropped rather than
 * failing the whole job. That is the opposite of the refusal policy for UNTRUSTED tool input
 * (`/Simulation.md` §6): a job file is the user's own document, not a foreign one.
 *
 * #213 bumped the document to version 2 (sacrificial material + breakthrough). The union of
 * versioned schemas plus a transform is the same forward-migration pattern as
 * `projectSchema.ts`: a version-1 job on disk parses against v1 and is stamped to v2 with NO
 * sacrificial material (`noneSacrificial()`) and the default breakthrough.
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

/**
 * A shape pocket (#214). One discriminated union on `kind`, with the shared shape fields and
 * the two cross-field bounds (`cornerRadius`, slot `length ≥ width`) as a `superRefine` — a
 * plain union member cannot carry a refinement and still be a discriminant for
 * `z.discriminatedUnion`. Bounds are the issue's: every dimension > 0, 3–500 polygon points.
 */
const polygonPointSchema = z.tuple([z.number().finite(), z.number().finite()]);

const shapeBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  position: positionSchema,
  rotation: z.number().finite(),
  depth: z.number().finite().positive(),
  enabled: z.boolean(),
});

const shapeKindsSchema = z.discriminatedUnion('kind', [
  shapeBaseSchema.extend({
    kind: z.literal('rect'),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    cornerRadius: z.number().finite().nonnegative(),
  }),
  shapeBaseSchema.extend({
    kind: z.literal('circle'),
    diameter: z.number().finite().positive(),
  }),
  shapeBaseSchema.extend({
    kind: z.literal('slot'),
    length: z.number().finite().positive(),
    width: z.number().finite().positive(),
  }),
  shapeBaseSchema.extend({
    kind: z.literal('polygon'),
    points: z.array(polygonPointSchema).min(3).max(500),
  }),
]);

/**
 * A polygon that crosses itself is not a region — the fill rule would invent one. The schema
 * cannot decide it (that is a finding, #214) but the two length relationships can be checked
 * here.
 */
const shapeSchema = shapeKindsSchema.superRefine((shape, ctx) => {
  if (shape.kind === 'rect' && shape.cornerRadius > Math.min(shape.width, shape.height) / 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cornerRadius must be ≤ min(width, height) / 2',
      path: ['cornerRadius'],
    });
  }
  if (shape.kind === 'slot' && shape.length < shape.width) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'slot length must be ≥ width',
      path: ['length'],
    });
  }
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

/**
 * One side strip (#213). `height` is 'flush' (level with the part's top) or a positive height
 * from the part's bottom face, mm.
 */
const sacrificialSideSchema = z.object({
  thickness: z.number().finite().positive(),
  height: z.union([z.literal('flush'), z.number().finite().positive()]),
});

const sacrificialUnderSchema = z.object({
  thickness: z.number().finite().positive(),
  // 0 = flush; never negative.
  overhang: z.object({
    left: z.number().finite().nonnegative(),
    right: z.number().finite().nonnegative(),
    front: z.number().finite().nonnegative(),
    back: z.number().finite().nonnegative(),
  }),
  attach: z.enum(['tape', 'glue', 'screws', 'loose']),
});

const sacrificialSchema = z.object({
  under: sacrificialUnderSchema.nullable(),
  sides: z.object({
    left: sacrificialSideSchema.nullable(),
    right: sacrificialSideSchema.nullable(),
    front: sacrificialSideSchema.nullable(),
    back: sacrificialSideSchema.nullable(),
  }),
  source: z.enum(['default', 'saved', 'measured']),
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

/**
 * The user's hand edits to the feeds/speeds (#205), one optional key per `CutParams` field.
 * Deliberately NOT `.positive()`: a bad number is a CUTTING mistake (`feedsFor` names it and
 * refuses to cut), not a reason to fail loading the whole job file. Every key is optional, and
 * an absent `cutOverride` means "use the computed values unchanged".
 */
const cutOverrideSchema = z.object({
  rpm: z.number().finite().optional(),
  feed: z.number().finite().optional(),
  plungeFeed: z.number().finite().optional(),
  stepDown: z.number().finite().optional(),
  stepOver: z.number().finite().optional(),
  air: z.boolean().optional(),
});

/** Version 1 (#200): the document before sacrificial material existed. */
const engraveJobV1Schema = z.object({
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

/** Version 2 (#213): adds `sacrificial` and `breakthrough`. */
const engraveJobV2Schema = engraveJobV1Schema.extend({
  schemaVersion: z.literal(2),
  sacrificial: sacrificialSchema,
  breakthrough: z.number().finite().nonnegative(),
  // #205's hand-override of the feeds/speeds. Optional, so a v2 job without it is unchanged.
  cutOverride: cutOverrideSchema.optional(),
  // #214's shape pockets. Defaulted to empty so a v2 job written before shapes existed (and
  // the v1 transform below) still loads as a text-only job.
  shapes: z.array(shapeSchema).default([]),
});

export const engraveJobSchema = z
  .union([engraveJobV1Schema, engraveJobV2Schema])
  .transform((job): EngraveJob =>
    job.schemaVersion === 1
      ? {
          ...job,
          schemaVersion: 2,
          // An old job loads with no sacrificial material (#213): the default is none.
          sacrificial: noneSacrificial(),
          breakthrough: DEFAULT_BREAKTHROUGH,
          // …and no shapes (#214): every old label stays a label, so a version-1 job loads and
          // cuts byte-identically.
          shapes: [],
        }
      : job,
  );

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
