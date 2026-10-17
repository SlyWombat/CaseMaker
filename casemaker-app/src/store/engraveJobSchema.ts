import { z } from 'zod';
import { MACHINES, Z1 } from '@/engine/cnc/machine';
import { STOCK_MATERIALS } from '@/engine/cnc/materials';
import { ToolSchema } from '@/engine/cnc/toolLibrary';
import { DEFAULT_BREAKTHROUGH, noneSacrificial } from '@/engine/cnc/sacrificial';
import { DEFAULT_JAW_CLEARANCE_MM } from '@/engine/cnc/engrave/depthBounds';
import { FACING_DEPTH_MAX_MM } from '@/engine/cnc/stockStart';
import { MAX_OUTLINE_CONTOURS, MAX_OUTLINE_POINTS } from '@/engine/import/outlineTypes';
import { FACES, type Face } from '@/engine/cnc/setups/types';
import type { EngraveJob } from '@/types/engraveJob';
import { newId } from '@/utils/id';

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
 *
 * The Z1 is the only MILL this app models (#347), so these are every job's bounds today. When a
 * second machine lands they become ITS bounds and the job's own `machineId` picks which — the
 * schema cannot express a per-machine bound while there is one machine, and pretending otherwise
 * would be a limit no document has.
 */
const STOCK_LIMITS = {
  length: Z1.envelope.x.max - Z1.envelope.x.min,
  width: Z1.envelope.y.max - Z1.envelope.y.min,
  thickness: Z1.envelope.z.max - Z1.envelope.z.min,
} as const;

/**
 * The ids the job may name (#347). Read off `MACHINES` rather than retyped, so a second mill is an
 * entry there and nothing here — and `.catch(Z1.id)` rather than a plain enum, because a document
 * is the user's own file and must still LOAD: a job naming a machine a later build added comes back
 * as the one this build has, which the panel and the run sheet then state plainly. (The alternative
 * — failing the parse — would throw away a whole job over a field that has a correct answer.)
 */
const machineIdSchema = z
  .enum(Object.keys(MACHINES) as [string, ...string[]])
  .catch(Z1.id);

/** The largest a label's cap height may be, mm. A blank this size is 12 mm thick; 100 mm is a guard, not a physical limit. */
const MAX_LABEL_SIZE = 100;
/**
 * The widest a bold stroke's target cut width may be, mm (#409). A 30° bit 1 mm deep cuts 0.836 mm,
 * so a few mm is the whole useful range; 20 mm is a parser guard, not a physical limit.
 */
const MAX_STROKE_WEIGHT = 20;
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
  // Which colour the floor is meant to land in (#285 reading decision 20). OPTIONAL, not
  // defaulted: a job authored before the control existed states no intent, carries no key, and
  // round-trips byte-for-byte — the same reason `construction` below is optional.
  depthIntent: z.enum(['reveal', 'surface', 'custom']).optional(),
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
    // Which design file the item came from (#437): the Title and the bytes' hash. Optional because
    // SVG/DXF imports, hand-built items and older saved jobs carry none.
    importedFrom: z
      .object({ name: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) })
      .optional(),
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
    // #409 — all three OPTIONAL (absent, not defaulted) so a pre-#409 job carries no key and
    // round-trips byte-for-byte. `widthScale` condenses x only; `weight` is a bold target cut
    // width, the width the stroke's parallel passes must span; `spacing: 'cut-width'` is the
    // opt-in that opens the glyph gaps to a groove's width of clear surface. Spacing is NOT on by
    // default even when the tool is a cone — that would silently re-cut every stored V-bit job.
    // Unknown keys are stripped by this schema, so these three MUST live here or the engine never
    // sees them (the #219/#285 trap).
    widthScale: z.number().finite().min(0.5).max(2).optional(),
    weight: z.number().finite().positive().max(MAX_STROKE_WEIGHT).optional(),
    spacing: z.literal('cut-width').optional(),
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

/**
 * A milled thread (#445, #434 phase 2), a sibling of a drill and never a region.
 *
 * The size enum is the `FastenerSize` union — the ISO 261 table in `engine/compiler/fasteners.ts`
 * is the one place those names live, and a size added there must be added here too (the same
 * type/schema trap this file's header documents for every field). `standard` and `classFit` are
 * literals, not enums: the CAM knows exactly the one value each may take in phase 2 (D5), and a
 * value outside it is a document this version does not understand rather than one to approximate.
 */
const threadSchema = z.object({
  kind: z.literal('thread'),
  id: z.string().min(1),
  name: z.string().optional(),
  position: positionSchema,
  enabled: z.boolean(),
  size: z.enum(['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6']),
  standard: z.literal('metric'),
  classFit: z.literal('6H'),
  depth: z.number().finite().positive(),
  through: z.boolean(),
});

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

/**
 * The print facts a two-colour blank's depth model needs (#285). OPTIONAL, not defaulted: a job
 * that is not a badge keeps no key, so it round-trips byte-for-byte and its depth limit stays the
 * analytic one. `split`/`layerHeight` are bounded by the same limits as the stock's own Z, so a
 * hand-edited file cannot smuggle in a boundary that is not on the blank.
 */
const stockPrintSchema = z.object({
  split: z.number().finite().nonnegative().max(STOCK_LIMITS.thickness),
  layerHeight: z.number().finite().positive().max(STOCK_LIMITS.thickness),
  firstLayerHeight: z.number().finite().positive().max(STOCK_LIMITS.thickness).optional(),
});

/**
 * The printed face's dome (#345). OPTIONAL, not defaulted, for the same byte-for-byte reason as
 * `print`: a blank nobody has stated a flatness for keeps no key, and the recommendation then says
 * "flatness unknown" rather than carrying an invented 0. Bounded by the stock's own thickness — a
 * dome taller than the blank is not a flatness.
 */
const stockFlatnessSchema = z.object({
  dome: z.number().finite().nonnegative().max(STOCK_LIMITS.thickness),
  across: z.enum(['width', 'length']),
  source: z.enum(['badge', 'user', 'measured']),
});

const stockSchema = z.object({
  length: z.number().finite().positive().max(STOCK_LIMITS.length),
  width: z.number().finite().positive().max(STOCK_LIMITS.width),
  thickness: z.number().finite().positive().max(STOCK_LIMITS.thickness),
  material: z.enum(STOCK_MATERIALS),
  // #464 — the fibre a printed blank's filament states, beside the material. OPTIONAL, not
  // defaulted: a job that has never seen a fibre filament keeps no key and round-trips byte-for-
  // byte, and `setStock` clears it when a later import states none.
  fibre: z.enum(['cf', 'gf']).optional(),
  print: stockPrintSchema.optional(),
  flatness: stockFlatnessSchema.optional(),
});

/**
 * The job's own Z-error margins (#345). OPTIONAL, not defaulted: a job with none runs on the house
 * setting at generate time, and a stored document that keeps no key round-trips byte-for-byte.
 * Both numbers may be 0 (a job that has decided it needs no margin), so neither is `.positive()`.
 */
const engraveMarginsSchema = z.object({
  boundaryMargin: z.number().finite().nonnegative().max(STOCK_LIMITS.thickness),
  zTolerance: z.number().finite().nonnegative().max(STOCK_LIMITS.thickness),
  source: z.enum(['default', 'recommended', 'user']),
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
 * The job's facing choice (#432). `depth` is the TOTAL taken off the top, mm, and it is the depth
 * every later program is posted from — so a job cannot say "face" without saying how far.
 *
 * Zero is legal and means "nothing to remove": the toggle can be on with the default not yet
 * filled, and the plan treats a zero depth as no facing. The upper bound is the same one
 * `defaults.rs` states for the shop's facing depth seeds — a skim is a skim, and a number that
 * would take a whole blank belongs in a different operation. `facing-too-deep` (validateJob) is the
 * check against the JOB's own thickness; this one only keeps a hand-edited document sane.
 */
const facingSchema = z.object({
  enabled: z.boolean(),
  depth: z.number().finite().min(0).max(FACING_DEPTH_MAX_MM),
  // #432 slice 2 — the facing program's own cutter, as a registry key. OPTIONAL, so a job written
  // before the field existed round-trips byte-for-byte, and null/absent asks the default rule.
  toolKey: z.string().min(1).nullable().optional(),
});

/**
 * Where an asserted value came from (#246/#254/#310). The same four states as `FieldSource` —
 * `catalogue` is Makera's own starting number for a cutter they sell, and it is here because a job
 * that adopts one must round-trip it: without this key the Zod object would STRIP it on load and
 * the value would come back reading `computed`. Every key is optional, so a job that asserts
 * nothing carries no `sources` key at all and round-trips.
 */
const fieldSourceSchema = z.enum(['computed', 'catalogue', 'user', 'measured']);

/**
 * Where the stock came from (#418, `EngraveJob.stockEntry`). Strict where it can be: the form is
 * one of the rectangular ones a job can hold, and a shelf pick names its entry.
 */
const stockEntrySchema = z
  .object({
    kind: z.enum(['shelf', 'file', 'made']),
    shelfId: z.string().min(1).nullable(),
    file: z.object({ name: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).nullable(),
    form: z.enum(['sheet', 'plate', 'block', 'printed-blank']),
    finish: z.enum(['rough', 'finished', 'printed', 'unknown']),
    conductive: z.boolean(),
  })
  .refine((e) => e.kind !== 'shelf' || e.shelfId !== null, 'a shelf pick names its shelf entry')
  .refine((e) => e.kind !== 'file' || e.file !== null, 'stock read from a file names the file');

/**
 * The job's saved setups (#419 J2, §5.4). Every field of `JobSetup` in `types/engraveJob.ts` must
 * be NAMED here: this object STRIPS what it does not name, so a field added to the interface alone
 * silently disappears on load (the #219/#285 trap, three times over).
 *
 * `orientation` is derived from the setups engine's `FACES` rather than retyped, so a new face in
 * the vocabulary cannot be stripped here. `registration.plan` mirrors `RegistrationPlan` field for
 * field — the behavioural spec in `tests/unit/engraveJob.spec.ts` parses a REAL `planRegistration`
 * answer through this schema, which is what catches the planner growing a field the mirror does not
 * name. Its `settings` block is the same: #430's tunables are a shop default and move, so a plan
 * re-planned later is not the plan that was approved.
 */
const mountSchema = z.enum(['vise', 'bracket', 'tape']);

const faceSchema = z.enum(FACES);
const orientationSchema = z.object(
  Object.fromEntries(FACES.map((face) => [face, faceSchema])) as Record<Face, typeof faceSchema>,
);

const mountSpecSchema = z.object({
  kind: mountSchema,
  // Vise: the widest the jaws open, mm. Bracket/tape: a board under the stock.
  viseOpeningMm: z.number().finite().positive().optional(),
  board: z.boolean().optional(),
});

const edgeScanSchema = z.object({
  edge: z.enum(['left', 'right', 'front', 'back']),
  along: z.number().finite(),
  expectedAt: z.number().finite(),
  outward: z.union([z.literal(1), z.literal(-1)]),
  start: z.number().finite(),
  limit: z.number().finite(),
  coarseStep: z.number().finite(),
  fineStep: z.number().finite(),
  label: z.string().optional(),
});

/** The stock as the job expected it, work XY — `ExpectedStock`. */
const expectedStockSchema = z.object({
  xMin: z.number().finite(),
  yMin: z.number().finite(),
  xMax: z.number().finite(),
  yMax: z.number().finite(),
  cornerRadius: z.number().finite().nonnegative(),
});

const bracketOriginSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  from: z.string(),
  offsetMeasured: z.boolean(),
});

/** A clamp or the bracket's arm, as the operator must confirm it (#427). */
const planObstacleSchema = z.object({
  kind: z.enum(['clamp', 'bracket']),
  label: z.string(),
  min: z.tuple([z.number().finite(), z.number().finite()]),
  max: z.tuple([z.number().finite(), z.number().finite()]),
  topZ: z.number().finite(),
});

/** A reference cut in an earlier setup, read to find the stock again (#429). */
const referenceEntrySchema = z.object({
  itemId: z.string().min(1),
  name: z.string(),
  centre: positionSchema,
  size: z.object({ x: z.number().finite(), y: z.number().finite() }),
  xScans: z.array(z.number().int().nonnegative()),
  yScans: z.array(z.number().int().nonnegative()),
});

/** The location's registration tunables (#430) as an approved plan froze them. */
const registrationSettingsSchema = z.object({
  capBelowSurfaceMm: z.number().finite(),
  coarseStepMm: z.number().finite(),
  fineStepMm: z.number().finite(),
  parkAboveSurfaceMm: z.number().finite(),
  scanInsideMm: z.number().finite(),
  scanReachMm: z.number().finite(),
  cornerClearanceMm: z.number().finite(),
  surfaceBandMm: z.number().finite(),
  tipRadiusMm: z.number().finite(),
  tipRadiusUncertaintyMm: z.number().finite(),
  tipDiameterMm: z.number().finite(),
  edgeMarginMm: z.number().finite(),
  surfaceSeekMm: z.number().finite(),
  surfaceToleranceMm: z.number().finite(),
  // #475 — absent in a plan frozen before this key existed; such a plan is still a valid record
  // of the registration it was approved with, and the seed is the value every new plan carries.
  surfaceTouchCount: z.number().int().min(5).max(9).default(5),
  touchFeed: z.number().finite(),
  surfaceFastFeed: z.number().finite(),
  surfaceSlowFeed: z.number().finite(),
  surfaceSlowSeekMm: z.number().finite(),
  idlePollLimit: z.number().int(),
  scanMissMarginMm: z.number().finite(),
  readingResolutionMm: z.number().finite(),
});

const registrationPlanSchema = z.object({
  mount: mountSchema,
  stock: expectedStockSchema,
  surfacePoint: positionSchema,
  seek: z.object({
    fromMachineZ: z.number().finite(),
    travelMm: z.number().finite(),
    band: z.object({ min: z.number().finite(), max: z.number().finite() }),
  }),
  scans: z.array(edgeScanSchema),
  bracketOrigin: bracketOriginSchema.nullable(),
  mountObstacles: z.array(planObstacleSchema),
  settings: registrationSettingsSchema,
  notes: z.array(z.string()),
  references: z.array(referenceEntrySchema).optional(),
  referenceRotation: z
    .object({
      between: z.tuple([z.string(), z.string()]),
      separation: z.number().finite(),
      resolutionMm: z.number().finite(),
    })
    .nullable()
    .optional(),
});

const jobSetupRegistrationSchema = z.object({
  method: mountSchema,
  plan: registrationPlanSchema,
  expected: z.string(),
});

/** `RemountStep.confirm`'s shape: a landmark question, its answers, and the right one's index. */
const remountConfirmSchema = z.object({
  question: z.string(),
  options: z.array(z.string()),
  correct: z.number().int().nonnegative(),
});

const jobSetupSchema = z.object({
  // The schema mints a setup id exactly as it mints `EngraveJob.id`: a document written before the
  // field existed (or a hand-built setup) gains one on parse rather than failing to load.
  id: z.string().min(1).default(() => newId('setup')),
  orientation: orientationSchema,
  mount: mountSpecSchema,
  itemIds: z.array(z.string().min(1)),
  tools: z.array(z.string().min(1)),
  registration: jobSetupRegistrationSchema.optional(),
  remount: z
    .object({
      instruction: z.array(z.string()),
      confirm: remountConfirmSchema.nullable(),
    })
    .optional(),
});

const jobSourcesSchema = z.object({
  stock: z
    .object({
      length: fieldSourceSchema.optional(),
      width: fieldSourceSchema.optional(),
      thickness: fieldSourceSchema.optional(),
      material: fieldSourceSchema.optional(),
      // #464 — the fibre flag, stamped with the material it came beside. Listed for the same
      // reason as `flatness`: zod strips an unnamed key, and a round trip would keep the value
      // while losing the record of where it came from.
      fibre: fieldSourceSchema.optional(),
      // #285 — the badge's own print facts, stamped when they became the job's.
      print: fieldSourceSchema.optional(),
      // #345 — the printed face's dome, stamped with the print it belongs to. Listed explicitly
      // because zod STRIPS what an object does not name: the far side of a round trip would lose
      // the provenance while keeping the value, which is worse than either.
      flatness: fieldSourceSchema.optional(),
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
      // `peck` was missing here while `EngraveJobSources.cut` has had it all along (#220 added the
      // field to `CutParams`), so a job that stamped the peck's source lost the stamp on load.
      // Found fixing the same object for #310.
      peck: fieldSourceSchema.optional(),
      air: fieldSourceSchema.optional(),
    })
    .optional(),
  // #362 — per-label provenance, keyed by label id. Named explicitly for the same reason
  // `flatness` above is: zod strips what an object does not name, and a user's typed depth coming
  // back as an unclaimed one would let the next `takeBadgeBlank` overwrite it.
  //
  // `layout` is the same trap in the other direction (#363 review): it is what tells the badge
  // route whether a line is still one a route laid out, so a stamp lost on load would have the
  // route re-lay a line the person had moved or retyped.
  labels: z
    .record(
      z.string(),
      z.object({
        layout: fieldSourceSchema.optional(),
        depth: fieldSourceSchema.optional(),
        depthIntent: fieldSourceSchema.optional(),
      }),
    )
    .optional(),
});

/** Version 1 (#200): the document before sacrificial material existed. */
const engraveJobV1Schema = z.object({
  schemaVersion: z.literal(1),
  name: z.string(),
  // #347 — on the BASE version, not v2, because that is where every job gets it: the field is
  // DEFAULTED to the one mill this build models (`machineIdSchema`'s `.catch`), so a v1 job and a v2
  // job written before the field existed both load carrying `'Z1'`. Unlike the optional keys below
  // it is never absent, because a job has a machine whether or not anyone wrote one down.
  machineId: machineIdSchema,
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
  // #419's job identity. DEFAULTED, not optional: a stock reservation and `RunContext.jobId` are
  // keyed to it, so every parsed job must carry one. A v2 document written before this field
  // existed gains an id on parse with no `schemaVersion` bump — nothing about the document changes
  // but this key. A v1 document is minted in the transform below, which is the only way it can get
  // one: the v1 schema predates the field, so its branch never reaches this default.
  id: z.string().min(1).default(() => newId('job')),
  sacrificial: sacrificialSchema,
  breakthrough: z.number().finite().nonnegative(),
  // #362's jaw clearance. DEFAULTED, unlike the optional keys below: the shipped value is the 1 mm
  // the jaw check carried as a bare constant before it became a setting (#488), so a job written
  // without this field loads with exactly the clearance it was judged by, and no document changes
  // behaviour by the field existing.
  jawClearance: z.number().finite().nonnegative().default(DEFAULT_JAW_CLEARANCE_MM),
  // #345's Z-error margins. OPTIONAL, not defaulted: an absent `margins` means "run on the house
  // setting", which is what every job written before this field existed does.
  margins: engraveMarginsSchema.optional(),
  // #205's hand-override of the feeds/speeds. Optional, so a v2 job without it is unchanged.
  cutOverride: cutOverrideSchema.optional(),
  // #432's facing choice. OPTIONAL, not defaulted, for the byte-for-byte reason every list below
  // gives: an absent key means the job does not face, which is what every stored document says.
  facing: facingSchema.optional(),
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
  // #445's milled threads. OPTIONAL for the same byte-for-byte reason as `combined`.
  threads: z.array(threadSchema).optional(),
  // #246/#254's per-field provenance. OPTIONAL, not defaulted: a job that has never had a
  // cutting override or a guided setup applied carries no key.
  sources: jobSourcesSchema.optional(),
  // #305's snapshot of the cutter the job was written with. OPTIONAL, not defaulted, for the
  // same byte-for-byte reason as `combined`/`traces`/`vectors`/`keepOuts`/`drills`, and nullable
  // so a snapshot that could not be taken stays an explicit null. Validated by the SAME
  // `ToolSchema` the library entries use, so a job file cannot smuggle in a tool shape the
  // sweeper would then have to defend against.
  tool: ToolSchema.nullish(),
  // #418's material-first start: where the stock came from. OPTIONAL, not defaulted, for the same
  // byte-for-byte reason as `combined`/`traces`/`tool`.
  stockEntry: stockEntrySchema.optional(),
  // #419 J2's setups. OPTIONAL and NOT defaulted: absent is today's single implicit top-up vise
  // setup, and it must stay absent so every stored job round-trips byte-for-byte (the same rule as
  // `combined`/`traces`/`vectors`/`keepOuts`/`drills`). Consumers read it through `jobSetups`, which
  // supplies the implicit setup when the key is absent.
  setups: z.array(jobSetupSchema).optional(),
});

export const engraveJobSchema = z
  .union([engraveJobV1Schema, engraveJobV2Schema])
  .transform((job): EngraveJob =>
    job.schemaVersion === 1
      ? {
          ...job,
          schemaVersion: 2,
          // …and its own id (#419): v1 predates the field, and the v2 default above is not reached
          // by a document that parses against this branch, so it is minted here.
          id: newId('job'),
          // An old job loads with no sacrificial material (#213): the default is none.
          sacrificial: noneSacrificial(),
          breakthrough: DEFAULT_BREAKTHROUGH,
          // …and the jaw clearance that was the only number the check knew (#362): a v1 job is a
          // v1 job, and 1.0 mm is what it was judged by.
          jawClearance: DEFAULT_JAW_CLEARANCE_MM,
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
