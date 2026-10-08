import { z } from 'zod';
import { Z1 } from '@/engine/cnc/machine';
import { ToolSchema } from '@/engine/cnc/toolLibrary';
import { DEFAULT_BREAKTHROUGH, noneSacrificial } from '@/engine/cnc/sacrificial';
import { MAX_OUTLINE_CONTOURS, MAX_OUTLINE_POINTS } from '@/engine/import/outlineTypes';
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
  // Reference-only item (#215). Optional, so a pre-#215 job is unchanged.
  construction: z.boolean().optional(),
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
  // Reference-only item (#215). Optional, so a pre-#215 job is unchanged.
  construction: z.boolean().optional(),
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

/**
 * The three combined kinds (#215). Their dimensions are checked here (positive ring width,
 * non-negative gap / inset); whether a NAMED reference exists, is enabled or forms a cycle is
 * not a schema question — it is `resolveItems`'s job, reported as an `item-reference` finding.
 */
const combinedShapeSchema = z.discriminatedUnion('kind', [
  shapeBaseSchema.extend({
    kind: z.literal('border'),
    inset: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
  }),
  shapeBaseSchema.extend({
    kind: z.literal('frame'),
    around: z.string().min(1),
    gap: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
  }),
  shapeBaseSchema.extend({
    kind: z.literal('cutaway'),
    outer: z.string().min(1),
    islands: z.array(z.string().min(1)),
  }),
]);

/**
 * An imported vector outline (#217). It shares the shape base but is NOT a member of the
 * `EngraveShape` union: it is its own list on the job (`vectors`), like `combined` (#215) and
 * `traces` (#219), so the panel's exhaustive simple-shape switch and the hand-built shape editor
 * do not have to learn a kind whose geometry comes from a file. The caps are the importer's
 * (`MAX_OUTLINE_CONTOURS`, `MAX_OUTLINE_POINTS`) so a refusable file is also an unloadable job.
 */
const vectorSchema = shapeBaseSchema
  .extend({
    kind: z.literal('vector'),
    sourceName: z.string().min(1),
    contours: z.array(z.array(polygonPointSchema).min(3)).min(1).max(MAX_OUTLINE_CONTOURS),
    fillRule: z.enum(['NonZero', 'EvenOdd']),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .superRefine((v, ctx) => {
    let points = 0;
    for (const ring of v.contours) points += ring.length;
    if (points > MAX_OUTLINE_POINTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `outline has ${points} points; the limit is ${MAX_OUTLINE_POINTS}`,
        path: ['contours'],
      });
    }
  });

/**
 * Single-line traces (#219): a free polyline and a single-stroke text label. They share the trace
 * base (position/rotation/depth/enabled) with the shape kinds but are their OWN union — a trace is
 * not a region, so it never reaches `engraves` or the region-item switches. `points` is capped at
 * 5 000 (a hand-drawn path, not a spline dump); a CLOSED ring needs at least 3 points.
 */
const traceBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  position: positionSchema,
  rotation: z.number().finite(),
  depth: z.number().finite().positive(),
  enabled: z.boolean(),
  construction: z.boolean().optional(),
});

const traceKindsSchema = z.discriminatedUnion('kind', [
  traceBaseSchema.extend({
    kind: z.literal('line'),
    points: z.array(polygonPointSchema).min(2).max(5000),
    closed: z.boolean(),
  }),
  traceBaseSchema.extend({
    kind: z.literal('stroke-label'),
    text: z.string().max(MAX_TEXT_LENGTH),
    font: z.string().min(1),
    size: z.number().finite().min(1).max(MAX_LABEL_SIZE),
  }),
]);

/** A closed line needs three points to bound any path; an open line needs two. */
const traceSchema = traceKindsSchema.superRefine((trace, ctx) => {
  if (trace.kind === 'line' && trace.closed && trace.points.length < 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a closed line needs at least 3 points',
      path: ['points'],
    });
  }
});

/**
 * An under-surface void (#231 item 3). Its geometry mirrors the simple shapes but it carries
 * `zCeiling` (the void's ceiling in PART-frame z from the blank's bottom face) instead of a cut
 * `depth`, and it has no `construction` — a void is a fact about the blank, not an instruction.
 * The two cross-field bounds the simple shapes check (a rect's corner radius, a slot's length)
 * are checked here the same way; whether `zCeiling` fits under the stock's thickness is a fact
 * about the specific blank, not a schema question (a too-tall void simply yields no cut).
 */
const keepOutBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  position: positionSchema,
  rotation: z.number().finite(),
  enabled: z.boolean(),
  zCeiling: z.number().finite().positive(),
});

/**
 * Plunge drills (#220): one hole, or a rectangular array of the same hole. They share a base with
 * the other items (position/rotation/depth/enabled) but are their OWN union — a drill is not a
 * region, so it never reaches `engraves`. There is deliberately no `diameter`: the hole IS the
 * cutter's diameter (a bigger hole is a circle pocket, #214). `count` is whole numbers ≥ 1, and
 * `pitch` is positive; the plain drill ignores `rotation`, an array rotates its lattice about
 * `position`.
 */
const drillBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  position: positionSchema,
  rotation: z.number().finite(),
  depth: z.number().finite().positive(),
  enabled: z.boolean(),
  through: z.boolean(),
});

const drillSchema = z.discriminatedUnion('kind', [
  drillBaseSchema.extend({ kind: z.literal('drill') }),
  drillBaseSchema.extend({
    kind: z.literal('drill-array'),
    count: z.object({ x: z.number().int().min(1), y: z.number().int().min(1) }),
    pitch: z.object({ x: z.number().finite().positive(), y: z.number().finite().positive() }),
  }),
]);

const keepOutSchema = z
  .discriminatedUnion('kind', [
    keepOutBaseSchema.extend({
      kind: z.literal('rect'),
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
      cornerRadius: z.number().finite().nonnegative(),
    }),
    keepOutBaseSchema.extend({
      kind: z.literal('circle'),
      diameter: z.number().finite().positive(),
    }),
    keepOutBaseSchema.extend({
      kind: z.literal('slot'),
      length: z.number().finite().positive(),
      width: z.number().finite().positive(),
    }),
    keepOutBaseSchema.extend({
      kind: z.literal('polygon'),
      points: z.array(polygonPointSchema).min(3).max(500),
    }),
  ])
  .superRefine((ko, ctx) => {
    if (ko.kind === 'rect' && ko.cornerRadius > Math.min(ko.width, ko.height) / 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cornerRadius must be ≤ min(width, height) / 2',
        path: ['cornerRadius'],
      });
    }
    if (ko.kind === 'slot' && ko.length < ko.width) {
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
  // #220: the peck depth for plunge drilling, mm.
  peck: z.number().finite().optional(),
  air: z.boolean().optional(),
});

/**
 * Where an asserted value came from (#246/#254). The same three states as `FieldSource`. Every
 * key is optional, so a job that asserts nothing carries no `sources` key at all and round-trips.
 */
const fieldSourceSchema = z.enum(['computed', 'user', 'measured']);

const jobSourcesSchema = z.object({
  stock: z
    .object({
      length: fieldSourceSchema.optional(),
      width: fieldSourceSchema.optional(),
      thickness: fieldSourceSchema.optional(),
      material: fieldSourceSchema.optional(),
    })
    .optional(),
  tool: fieldSourceSchema.optional(),
  cut: z
    .object({
      rpm: fieldSourceSchema.optional(),
      feed: fieldSourceSchema.optional(),
      plungeFeed: fieldSourceSchema.optional(),
      stepDown: fieldSourceSchema.optional(),
      stepOver: fieldSourceSchema.optional(),
      air: fieldSourceSchema.optional(),
    })
    .optional(),
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
  // #215's combined shapes (border/frame/cutaway). OPTIONAL, not defaulted: a job that has
  // none keeps no key, so an existing document round-trips byte-for-byte (the same reason
  // `cutOverride` is optional). Consumers read it as `combined ?? []`.
  combined: z.array(combinedShapeSchema).optional(),
  // #219's single-line traces. OPTIONAL for the same byte-for-byte reason as `combined`.
  traces: z.array(traceSchema).optional(),
  // #217's imported vector outlines. OPTIONAL, not defaulted: a job with none keeps no key, so a
  // pre-#217 document round-trips byte-for-byte (the same reason `combined` and `traces` are).
  vectors: z.array(vectorSchema).optional(),
  // #231 item 3's under-surface voids. OPTIONAL, not defaulted: a job with none keeps no key, so
  // a pre-#231 document round-trips byte-for-byte (the same reason `combined`/`traces`/`vectors`).
  keepOuts: z.array(keepOutSchema).optional(),
  // #220's plunge drills. OPTIONAL for the same byte-for-byte reason as `combined`.
  drills: z.array(drillSchema).optional(),
  // #246/#254's per-field provenance. OPTIONAL, not defaulted: a job that has never had a
  // cutting override or a guided setup applied carries no key.
  sources: jobSourcesSchema.optional(),
  // #305's snapshot of the cutter the job was written with. OPTIONAL, not defaulted, for the
  // same byte-for-byte reason as `combined`/`traces`/`vectors`/`keepOuts`/`drills`, and nullable
  // so a snapshot that could not be taken stays an explicit null. Validated by the SAME
  // `ToolSchema` the library entries use, so a job file cannot smuggle in a tool shape the
  // sweeper would then have to defend against.
  tool: ToolSchema.nullish(),
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
          // …and no combined shapes (#215): the optional key is simply absent, so a v1 job
          // round-trips byte-for-byte.
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
