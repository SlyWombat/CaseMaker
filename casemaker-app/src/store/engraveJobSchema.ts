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
 *
 * #480 — every field carries `.describe()`. The current version of this document is emitted as
 * JSON Schema for the headless MCP tools, and the description is what a model reads before it
 * authors a job. Keep the text about the DATA (units, meaning, which values are legal), not about
 * this file's implementation.
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
  .catch(Z1.id)
  .describe('The mill the job is cut on; the build keeps the one machine it models.');

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
  x: z.number().finite().describe("X in millimetres from the stock's front-left corner."),
  y: z.number().finite().describe("Y in millimetres from the stock's front-left corner."),
});

const labelSchema = z.object({
  id: z.string().min(1).describe('Unique id for this label within the job.'),
  text: z.string().max(MAX_TEXT_LENGTH).describe('The text to engrave.'),
  font: z
    .string()
    .min(1)
    .describe('Font registry id: a bundled face ("sans-default", "mono-default", "serif-default") or a custom font id.'),
  weight: z.enum(['regular', 'bold']).describe('Stroke weight: regular or bold.'),
  size: z
    .number()
    .finite()
    .min(1)
    .max(MAX_LABEL_SIZE)
    .describe('Cap height in millimetres.'),
  position: positionSchema.describe("Centre of the text's bounding box in work coordinates."),
  rotation: z
    .number()
    .finite()
    .describe('Rotation in degrees counter-clockwise about position.'),
  depth: z
    .number()
    .finite()
    .positive()
    .describe("Engraving depth below the stock's top face, in millimetres."),
  // Which colour the floor is meant to land in (#285 reading decision 20). OPTIONAL, not
  // defaulted: a job authored before the control existed states no intent, carries no key, and
  // round-trips byte-for-byte — the same reason `construction` below is optional.
  depthIntent: z
    .enum(['reveal', 'surface', 'custom'])
    .optional()
    .describe(
      'Which colour the floor is meant to land in on a two-colour blank: reveal the lower ' +
        'colour, sit at the surface, or a custom depth; omit when no intent is stated.',
    ),
  enabled: z
    .boolean()
    .describe('False keeps the label in the document but out of the program.'),
  // Reference-only item (#215). Optional, so a pre-#215 job is unchanged.
  construction: z
    .boolean()
    .optional()
    .describe('Reference-only: cut nothing, but validators may use its geometry; omit for a real label.'),
});

/**
 * A shape pocket (#214). One discriminated union on `kind`, with the shared shape fields and
 * the two cross-field bounds (`cornerRadius`, slot `length ≥ width`) as a `superRefine` — a
 * plain union member cannot carry a refinement and still be a discriminant for
 * `z.discriminatedUnion`. Bounds are the issue's: every dimension > 0, 3–500 polygon points.
 */
const polygonPointSchema = z
  .tuple([z.number().finite(), z.number().finite()])
  .describe('An [x, y] point in millimetres, relative to the item position.');

const shapeBaseSchema = z.object({
  id: z.string().min(1).describe('Unique id for this item within the job.'),
  name: z.string().optional().describe('Optional human-readable name for the item list.'),
  position: positionSchema.describe(
    "Centre of the shape in work coordinates (a polygon's points are relative to it).",
  ),
  rotation: z
    .number()
    .finite()
    .describe('Rotation in degrees counter-clockwise about position.'),
  depth: z
    .number()
    .finite()
    .positive()
    .describe("Pocket depth below the stock's top face, in millimetres."),
  enabled: z.boolean().describe('False keeps the item in the document but out of the program.'),
  // Reference-only item (#215). Optional, so a pre-#215 job is unchanged.
  construction: z
    .boolean()
    .optional()
    .describe('Reference-only: cut nothing, but other items may refer to this shape.'),
  // Through pocket (#218), shapes only. Optional, so a pre-#218 document keeps no key and its
  // `depth` keeps its ordinary meaning.
  through: z
    .boolean()
    .optional()
    .describe(
      "Cut through the blank to the sacrificial board; the floor is the breakthrough rule and " +
        'depth is then only the checked pocket depth.',
    ),
});

const shapeKindsSchema = z.discriminatedUnion('kind', [
  shapeBaseSchema.extend({
    kind: z.literal('rect').describe('A rectangular pocket with rounded corners.'),
    width: z.number().finite().positive().describe('Width along X before rotation, in millimetres.'),
    height: z.number().finite().positive().describe('Height along Y before rotation, in millimetres.'),
    cornerRadius: z
      .number()
      .finite()
      .nonnegative()
      .describe('Corner radius in millimetres; at most half the smaller side.'),
  }),
  shapeBaseSchema.extend({
    kind: z.literal('circle').describe('A round pocket.'),
    diameter: z.number().finite().positive().describe('Pocket diameter in millimetres.'),
  }),
  shapeBaseSchema.extend({
    kind: z.literal('slot').describe('A stadium-shaped (rounded-ended) slot pocket.'),
    length: z
      .number()
      .finite()
      .positive()
      .describe('Overall length along X in millimetres; at least the width.'),
    width: z.number().finite().positive().describe('Slot width in millimetres.'),
  }),
  shapeBaseSchema.extend({
    kind: z.literal('polygon').describe('A closed polygonal pocket.'),
    points: z
      .array(polygonPointSchema)
      .min(3)
      .max(500)
      .describe('Closed polygon vertices relative to position; 3–500 points.'),
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
    kind: z.literal('border').describe("A ring pocket derived from an existing item's outline."),
    inset: z
      .number()
      .finite()
      .nonnegative()
      .describe("Distance of the ring from the referenced item's outline, in millimetres."),
    width: z.number().finite().positive().describe('Ring width in millimetres.'),
  }),
  shapeBaseSchema.extend({
    kind: z.literal('frame').describe('A frame around an existing item, with a gap.'),
    around: z.string().min(1).describe('Id of the item whose outline the frame follows.'),
    gap: z
      .number()
      .finite()
      .nonnegative()
      .describe('Clearance between the referenced outline and the frame, in millimetres.'),
    width: z.number().finite().positive().describe('Frame width in millimetres.'),
  }),
  shapeBaseSchema.extend({
    kind: z
      .literal('cutaway')
      .describe('Remove the area inside an outer item while leaving listed islands standing.'),
    outer: z.string().min(1).describe('Id of the item whose interior is cleared.'),
    islands: z
      .array(z.string().min(1))
      .describe('Ids of items kept standing inside the cleared area.'),
  }),
]);

/**
 * A profile cut-out (#218). It is NOT a region and carries no `depth`: its floor is always the
 * under-board's `thickness + breakthrough`. `of` names another item whose outline the path
 * follows, or `'stock-inset'` for the blank's own edge. `inset` is the PATH's distance from that
 * outline (the answered Q1 on #218), and the tab dimensions are the row's own — the shop's
 * `tabs.*` seeds only supply a new row's starting values.
 */
const cutoutSchema = z.object({
  kind: z
    .literal('cutout')
    .describe("A profile cut-out; its floor is the under-board's thickness plus breakthrough."),
  id: z.string().min(1).describe('Unique id for this cut-out within the job.'),
  name: z.string().optional().describe('Optional human-readable name for the item list.'),
  enabled: z.boolean().describe('False keeps the cut-out in the document but out of the program.'),
  of: z
    .union([z.literal('stock-inset'), z.string().min(1)])
    .describe("Outline to follow: \"stock-inset\" for the blank's own edge, or the id of another item."),
  side: z
    .enum(['outside', 'inside'])
    .describe('Cut outside the named outline or inside it.'),
  inset: z
    .number()
    .finite()
    .nonnegative()
    .describe("Distance of the cutting path from the named outline, in millimetres."),
  tabs: z
    .object({
      count: z
        .number()
        .int()
        .nonnegative()
        .max(64)
        .describe('Number of holding tabs around the path (0–64).'),
      width: z.number().finite().positive().describe('Tab width along the path, in millimetres.'),
      height: z
        .number()
        .finite()
        .positive()
        .describe("Tab height up from the cut's floor, in millimetres."),
    })
    .describe('Holding tabs that keep the part attached until the final pass.'),
});

/**
 * An imported vector outline (#217). It shares the shape base but is NOT a member of the
 * `EngraveShape` union: it is its own list on the job (`vectors`), like `combined` (#215) and
 * `traces` (#219), so the panel's exhaustive simple-shape switch and the hand-built shape editor
 * do not have to learn a kind whose geometry comes from a file. The caps are the importer's
 * (`MAX_OUTLINE_CONTOURS`, `MAX_OUTLINE_POINTS`) so a refusable file is also an unloadable job.
 */
const vectorSchema = shapeBaseSchema
  .extend({
    kind: z.literal('vector').describe('An outline imported from an SVG or DXF file.'),
    sourceName: z
      .string()
      .min(1)
      .describe('Name of the design file the outline came from.'),
    contours: z
      .array(z.array(polygonPointSchema).min(3))
      .min(1)
      .max(MAX_OUTLINE_CONTOURS)
      .describe(
        'Closed rings of [x, y] points in millimetres; at least one ring, each with at least three points.',
      ),
    fillRule: z
      .enum(['NonZero', 'EvenOdd'])
      .describe('How self-intersections are filled: NonZero or EvenOdd.'),
    width: z
      .number()
      .finite()
      .positive()
      .describe('Bounding-box width of the outline in millimetres.'),
    height: z
      .number()
      .finite()
      .positive()
      .describe('Bounding-box height of the outline in millimetres.'),
    // Which design file the item came from (#437): the Title and the bytes' hash. Optional because
    // SVG/DXF imports, hand-built items and older saved jobs carry none.
    importedFrom: z
      .object({
        name: z.string().min(1).describe('Title of the imported design file.'),
        sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .describe('Lowercase SHA-256 of the imported file (64 hex characters).'),
      })
      .optional()
      .describe('The design file this vector came from; omitted when unknown.'),
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
  id: z.string().min(1).describe('Unique id for this trace within the job.'),
  name: z.string().optional().describe('Optional human-readable name for the item list.'),
  position: positionSchema.describe("Origin the points (or the text's bounding box) are relative to."),
  rotation: z
    .number()
    .finite()
    .describe('Rotation in degrees counter-clockwise about position.'),
  depth: z
    .number()
    .finite()
    .positive()
    .describe("Cut depth of the single-line stroke below the stock's top face, in millimetres."),
  enabled: z.boolean().describe('False keeps the trace in the document but out of the program.'),
  construction: z
    .boolean()
    .optional()
    .describe('Reference-only: cut nothing, but other items may refer to this trace.'),
});

const traceKindsSchema = z.discriminatedUnion('kind', [
  traceBaseSchema.extend({
    kind: z.literal('line').describe('A free polyline cut as a single pass.'),
    points: z
      .array(polygonPointSchema)
      .min(2)
      .max(5000)
      .describe('Polyline vertices relative to position, in millimetres; 2–5000 points.'),
    closed: z
      .boolean()
      .describe('True closes the polyline back to its first point (needs at least three points).'),
  }),
  traceBaseSchema.extend({
    kind: z.literal('stroke-label').describe('Single-stroke (engraving-style) text.'),
    text: z.string().max(MAX_TEXT_LENGTH).describe('The text to cut.'),
    font: z
      .string()
      .min(1)
      .describe('Font registry id: a bundled face or a custom font id.'),
    size: z.number().finite().min(1).max(MAX_LABEL_SIZE).describe('Cap height in millimetres.'),
    // #409 — all three OPTIONAL (absent, not defaulted) so a pre-#409 job carries no key and
    // round-trips byte-for-byte. `widthScale` condenses x only; `weight` is a bold target cut
    // width, the width the stroke's parallel passes must span; `spacing: 'cut-width'` is the
    // opt-in that opens the glyph gaps to a groove's width of clear surface. Spacing is NOT on by
    // default even when the tool is a cone — that would silently re-cut every stored V-bit job.
    // Unknown keys are stripped by this schema, so these three MUST live here or the engine never
    // sees them (the #219/#285 trap).
    widthScale: z
      .number()
      .finite()
      .min(0.5)
      .max(2)
      .optional()
      .describe('Horizontal condensation of the glyphs (0.5–2); omit for 1.'),
    weight: z
      .number()
      .finite()
      .positive()
      .max(MAX_STROKE_WEIGHT)
      .optional()
      .describe('Target cut width of a bold stroke, in millimetres; omit for the font default.'),
    spacing: z
      .literal('cut-width')
      .optional()
      .describe('Set to "cut-width" to open glyph gaps to a groove width; omit to keep normal spacing.'),
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
  id: z.string().min(1).describe('Unique id for this keep-out within the job.'),
  name: z.string().optional().describe('Optional human-readable name for the item list.'),
  position: positionSchema.describe('Centre of the void in work coordinates.'),
  rotation: z
    .number()
    .finite()
    .describe('Rotation in degrees counter-clockwise about position.'),
  enabled: z.boolean().describe('False keeps the void in the document but out of the program.'),
  zCeiling: z
    .number()
    .finite()
    .positive()
    .describe("Ceiling of the void in part-frame Z from the blank's bottom face, in millimetres."),
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
  id: z.string().min(1).describe('Unique id for this drill within the job.'),
  name: z.string().optional().describe('Optional human-readable name for the item list.'),
  position: positionSchema.describe('The first hole centre, in work coordinates.'),
  rotation: z
    .number()
    .finite()
    .describe("Degrees counter-clockwise about position; ignored by a plain drill, rotates an array's lattice."),
  depth: z
    .number()
    .finite()
    .positive()
    .describe("Hole floor below the stock's top face, in millimetres."),
  enabled: z.boolean().describe('False keeps the drill in the document but out of the program.'),
  through: z
    .boolean()
    .describe('Drill through the blank into the sacrificial board, following the breakthrough rule.'),
});

const drillSchema = z.discriminatedUnion('kind', [
  drillBaseSchema.extend({
    kind: z.literal('drill').describe("One hole, as wide as the job's cutter."),
  }),
  drillBaseSchema.extend({
    kind: z.literal('drill-array').describe('A rectangular array of identical holes.'),
    count: z
      .object({
        x: z.number().int().min(1).describe('Number of holes along X.'),
        y: z.number().int().min(1).describe('Number of holes along Y.'),
      })
      .describe('Array size in holes along each axis.'),
    pitch: z
      .object({
        x: z.number().finite().positive().describe('Centre-to-centre spacing along X, in millimetres.'),
        y: z.number().finite().positive().describe('Centre-to-centre spacing along Y, in millimetres.'),
      })
      .describe('Hole spacing in millimetres along X and Y.'),
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
  kind: z.literal('thread').describe('A milled thread (a threaded hole).'),
  id: z.string().min(1).describe('Unique id for this thread within the job.'),
  name: z.string().optional().describe('Optional human-readable name for the item list.'),
  position: positionSchema.describe('Thread axis in work coordinates.'),
  enabled: z.boolean().describe('False keeps the thread in the document but out of the program.'),
  size: z
    .enum(['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6'])
    .describe('ISO metric thread size.'),
  standard: z.literal('metric').describe('Thread standard: metric (the only one this build cuts).'),
  classFit: z.literal('6H').describe('Tolerance class: 6H (the only one this build cuts).'),
  depth: z
    .number()
    .finite()
    .positive()
    .describe("Threaded depth below the stock's top face, in millimetres."),
  through: z.boolean().describe('Mill the thread through the blank to the sacrificial board.'),
});

/**
 * One 3D primitive (#435): a negative volume stated as a box, cylinder, cone or sphere. The
 * shared fields are `position`/`rotation`/`depth`/`enabled` like every other item, plus an
 * OPTIONAL `axis` that defaults (when absent) to `'z'` — the only axis the region CAM cuts.
 *
 * The two cross-field bounds are refused at the schema because they describe no solid at all:
 * a cone's tip cannot be wider than its mouth, and a sphere's cap cannot be deeper than the ball's
 * diameter. Whether a primitive's depth fits a particular blank is `validateJob`'s business
 * (`depth-exceeds-stock`), not the schema's.
 */
const primitiveBaseSchema = z.object({
  id: z.string().min(1).describe('Unique id for this primitive within the job.'),
  name: z.string().optional().describe('Optional human-readable name for the item list.'),
  position: positionSchema.describe("Footprint centre of the volume in the stock frame."),
  rotation: z
    .number()
    .finite()
    .describe('Rotation in degrees counter-clockwise about Z through position.'),
  enabled: z.boolean().describe('False keeps the primitive in the document but out of the program.'),
  axis: z
    .enum(['z', 'x', 'y'])
    .optional()
    .describe('Axis the volume is cut along; omit for Z, the only axis the region CAM cuts.'),
  depth: z
    .number()
    .finite()
    .positive()
    .describe("How far below the stock's top face the volume reaches, in millimetres."),
});

const primitiveSchema = z
  .discriminatedUnion('kind', [
    primitiveBaseSchema.extend({
      kind: z.literal('box').describe('A rectangular cut-away volume.'),
      width: z.number().finite().positive().describe('Width along X before rotation, in millimetres.'),
      height: z.number().finite().positive().describe('Height along Y before rotation, in millimetres.'),
    }),
    primitiveBaseSchema.extend({
      kind: z.literal('cylinder').describe('A cylindrical cut-away volume.'),
      diameter: z.number().finite().positive().describe('Cylinder diameter in millimetres.'),
    }),
    primitiveBaseSchema.extend({
      kind: z.literal('cone').describe('A conical cut-away, e.g. a countersink.'),
      diameter: z.number().finite().positive().describe('Cone diameter at its mouth, in millimetres.'),
      tipDiameter: z
        .number()
        .finite()
        .nonnegative()
        .describe('Cone diameter at its tip, in millimetres; 0 is a sharp point and it may not exceed diameter.'),
    }),
    primitiveBaseSchema.extend({
      kind: z.literal('sphere').describe('A spherical cut-away (a dimple).'),
      diameter: z
        .number()
        .finite()
        .positive()
        .describe('Ball diameter in millimetres; the cap depth may not exceed it.'),
    }),
  ])
  .superRefine((primitive, ctx) => {
    if (primitive.kind === 'cone' && primitive.tipDiameter > primitive.diameter) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tipDiameter must be ≤ diameter',
        path: ['tipDiameter'],
      });
    }
    if (primitive.kind === 'sphere' && primitive.depth > primitive.diameter) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a sphere cap depth must be ≤ its diameter',
        path: ['depth'],
      });
    }
  });

/**
 * The embedded reference object (#435), strict like the other owned v3 blocks: an unknown key is
 * refused by path rather than silently dropped. `data` is base64 and capped at the same 4 MiB the
 * import path enforces, so a hand-edited document cannot make the app decode an unbounded string.
 * The hex pattern is the #425 `jobSourceSchema` rule — a lowercase SHA-256 is the object's identity.
 */
const MAX_TARGET_OBJECT_BASE64_CHARS = Math.ceil((4 * 1024 * 1024) / 3) * 4;

const targetObjectSchema = z
  .object({
    id: z.string().min(1).describe('Unique id for the reference object.'),
    name: z.string().min(1).describe('File name the reference object was imported from.'),
    format: z.enum(['stl', '3mf']).describe('File format of the reference mesh.'),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'a lowercase SHA-256 (64 hex characters)')
      .describe('Lowercase SHA-256 of the mesh file\'s bytes (64 hex characters).'),
    data: z
      .string()
      .min(1)
      .max(MAX_TARGET_OBJECT_BASE64_CHARS)
      .describe('Base64 of the mesh file, at most 4 MiB decoded.'),
    size: z
      .object({
        x: z.number().finite().positive().describe('Mesh bounding-box size along X, in millimetres.'),
        y: z.number().finite().positive().describe('Mesh bounding-box size along Y, in millimetres.'),
        z: z.number().finite().positive().describe('Mesh bounding-box size along Z, in millimetres.'),
      })
      .strict()
      .describe('Parsed mesh bounding-box size in millimetres.'),
    position: z
      .object({
        x: z.number().finite().describe('X of the mesh bounding-box centre, in the work frame.'),
        y: z.number().finite().describe('Y of the mesh bounding-box centre, in the work frame.'),
        z: z.number().finite().describe("Z of the mesh's TOP in the work frame."),
      })
      .strict()
      .describe('Where the reference mesh is placed: X/Y centre and TOP height in the work frame.'),
    rotation: z
      .number()
      .finite()
      .describe('Rotation in degrees counter-clockwise about Z through the mesh centre.'),
    enabled: z.boolean().describe('False keeps the object in the document but out of the program.'),
    // #533 — the role decides whether the mesh is positioned against (reference) or made (goal).
    // Left OPTIONAL rather than defaulted: an absent key stays absent, so a document written before
    // this slice round-trips byte-for-byte and the read site (`target.role ?? 'reference'`) treats
    // absent as 'reference'. The key MUST live here as well as in `types/engraveJob.ts`, or the
    // strict schema strips it.
    role: z
      .enum(['reference', 'goal'])
      .optional()
      .describe("What the mesh is to the job: 'reference' (positioned against, not cut; the default when absent) or 'goal' (the shape to make)."),
  })
  .strict()
  .describe('An embedded mesh (STL/3MF): a reference the cutting volumes are positioned against, or a goal shape to make.');


const keepOutSchema = z
  .discriminatedUnion('kind', [
    keepOutBaseSchema.extend({
      kind: z.literal('rect').describe('A rectangular void.'),
      width: z.number().finite().positive().describe('Width along X before rotation, in millimetres.'),
      height: z.number().finite().positive().describe('Height along Y before rotation, in millimetres.'),
      cornerRadius: z
        .number()
        .finite()
        .nonnegative()
        .describe('Corner radius in millimetres; at most half the smaller side.'),
    }),
    keepOutBaseSchema.extend({
      kind: z.literal('circle').describe('A round void.'),
      diameter: z.number().finite().positive().describe('Void diameter in millimetres.'),
    }),
    keepOutBaseSchema.extend({
      kind: z.literal('slot').describe('A stadium-shaped (rounded-ended) void.'),
      length: z
        .number()
        .finite()
        .positive()
        .describe('Overall length along X in millimetres; at least the width.'),
      width: z.number().finite().positive().describe('Void width in millimetres.'),
    }),
    keepOutBaseSchema.extend({
      kind: z.literal('polygon').describe('A closed polygonal void.'),
      points: z
        .array(polygonPointSchema)
        .min(3)
        .max(500)
        .describe('Closed polygon vertices relative to position; 3–500 points.'),
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
  stockProud: z
    .number()
    .finite()
    .describe('How far the stock stands proud of the jaws, in millimetres.'),
  // #508 — what the blank's underside rests on. DEFAULTED rather than optional: a document written
  // before the seat existed was a ledge job by definition (the shipped model only had the ledge),
  // so it parses into the same shape without a schemaVersion bump.
  seat: z
    .enum(['ledge', 'floor'])
    .default('ledge')
    .describe("What the blank's underside rests on: the soft jaws' ledge or the body floor."),
  fixedJawThickness: z
    .number()
    .finite()
    .describe('Fixed jaw thickness in millimetres.'),
  movingJawThickness: z
    .number()
    .finite()
    .describe('Moving jaw thickness in millimetres.'),
  jawLength: z.number().finite().describe('Jaw length in millimetres.'),
  jawStartY: z
    .number()
    .finite()
    .describe('Work-coordinate Y where the jaws begin, in millimetres.'),
  source: z
    .enum(['default', 'saved', 'measured'])
    .describe('Where these jaw numbers came from: a default, a saved setup, or a measurement.'),
  uncertainty: z
    .number()
    .finite()
    .nonnegative()
    .describe('Measurement uncertainty in millimetres; 0 for values taken as exact.'),
  // Optional: a shipped default carries no date. Absent keys are preserved as absent.
  measuredAt: z
    .string()
    .optional()
    .describe('When the jaws were measured; omitted for a default or saved set.'),
});

/**
 * One side strip (#213). `height` is 'flush' (level with the part's top) or a positive height
 * from the part's bottom face, mm.
 */
const sacrificialSideSchema = z.object({
  thickness: z.number().finite().positive().describe('Strip thickness in millimetres.'),
  height: z
    .union([z.literal('flush'), z.number().finite().positive()])
    .describe('"flush" for level with the part top, or a positive height from the part bottom in millimetres.'),
});

const sacrificialUnderSchema = z.object({
  thickness: z.number().finite().positive().describe('Under-board thickness in millimetres.'),
  // 0 = flush; never negative.
  overhang: z
    .object({
      left: z.number().finite().nonnegative().describe('Overhang on the left side, in millimetres; 0 is flush.'),
      right: z.number().finite().nonnegative().describe('Overhang on the right side, in millimetres; 0 is flush.'),
      front: z.number().finite().nonnegative().describe('Overhang at the front, in millimetres; 0 is flush.'),
      back: z.number().finite().nonnegative().describe('Overhang at the back, in millimetres; 0 is flush.'),
    })
    .describe('How far the board extends beyond the stock on each side, in millimetres.'),
  attach: z
    .enum(['tape', 'glue', 'screws', 'loose'])
    .describe('How the under-board is held to the stock.'),
});

const sacrificialSchema = z.object({
  under: sacrificialUnderSchema
    .nullable()
    .describe('The board under the stock, or null when there is none.'),
  sides: z
    .object({
      left: sacrificialSideSchema.nullable().describe('Strip on the left side, or null.'),
      right: sacrificialSideSchema.nullable().describe('Strip on the right side, or null.'),
      front: sacrificialSideSchema.nullable().describe('Strip at the front, or null.'),
      back: sacrificialSideSchema.nullable().describe('Strip at the back, or null.'),
    })
    .describe('Side strips around the stock, per side.'),
  source: z
    .enum(['default', 'saved', 'measured'])
    .describe('Where these sacrificial numbers came from: a default, a saved set, or a measurement.'),
});

/**
 * The colour planes a two-colour blank's depth model needs (#492, from #285). OPTIONAL, not
 * defaulted: a job that is not a two-colour blank keeps no key, so it round-trips byte-for-byte
 * and its depth limit stays the analytic one. `capMm`/`layerHeight` are bounded by the same limits
 * as the stock's own Z, so a hand-edited file cannot smuggle in a boundary that is not on the
 * blank. The stock-level `superRefine` checks `capMm` against THIS blank's thickness and refuses a
 * laminate that claims layers.
 */
const stockColourSchema = z.object({
  kind: z
    .enum(['printed', 'laminate'])
    .describe('A printed two-colour blank, or a laminate with the colour plane already in it.'),
  capMm: z
    .number()
    .finite()
    .nonnegative()
    .max(STOCK_LIMITS.thickness)
    .describe("Thickness of the top colour layer, measured from the engraved face, in millimetres."),
  // Printed only. Absent is a printed blank whose slicer never stated a grid: its cap is still a
  // fact, but there is no layer line to snap the boundary to.
  layerHeight: z
    .number()
    .finite()
    .positive()
    .max(STOCK_LIMITS.thickness)
    .optional()
    .describe('Print layer height in millimetres; printed blanks only, omit when unknown.'),
  firstLayerHeight: z
    .number()
    .finite()
    .positive()
    .max(STOCK_LIMITS.thickness)
    .optional()
    .describe('First-layer height in millimetres; printed blanks only, and needs layerHeight.'),
});

/**
 * Pre-#492 migration: a job's `stock.print: { split, layerHeight, firstLayerHeight? }` becomes
 * `stock.colour: { kind: 'printed', capMm: thickness − split, … }`.
 *
 * The old `split` was the colour change height above the blank's BOTTOM face; `capMm` is the top
 * colour's thickness from the engraved face, so the two are complements about `thickness`. This is
 * the ONE place the old document shape is read — everything downstream reads `colour` — and it
 * runs before the object schema, so `print` is not a key this build can accidentally keep.
 *
 * A malformed `print` is left alone and stripped by the object schema: an unreadable old print is
 * "no colour facts", never a guess.
 */
function migrateStockPrint(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const record = raw as Record<string, unknown>;
  if (record.colour !== undefined || record.print === undefined) return raw;
  const print = record.print;
  const thickness = record.thickness;
  if (
    typeof print !== 'object' ||
    print === null ||
    typeof thickness !== 'number' ||
    !Number.isFinite(thickness)
  ) {
    return raw;
  }
  const { split, layerHeight, firstLayerHeight } = print as Record<string, unknown>;
  if (typeof split !== 'number' || typeof layerHeight !== 'number') return raw;
  const { print: _print, ...rest } = record;
  return {
    ...rest,
    colour: {
      kind: 'printed',
      capMm: thickness - split,
      layerHeight,
      ...(firstLayerHeight !== undefined ? { firstLayerHeight } : {}),
    },
  };
}

/**
 * The bow MEASURED on the clamped piece (#496): a drop per stock axis, with how and when it was
 * read. OPTIONAL, not defaulted, for the same byte-for-byte reason as `print`: a job whose surface
 * has not been measured keeps no key, and the recommendation then says "not yet measured" rather
 * than carrying an invented 0. Bounded by the stock's own thickness — a bow taller than the blank
 * is not a flatness.
 */
const measuredFlatnessSchema = z.object({
  xMm: z
    .number()
    .finite()
    .nonnegative()
    .max(STOCK_LIMITS.thickness)
    .describe('Measured bow along X, in millimetres, over the clamped piece.'),
  yMm: z
    .number()
    .finite()
    .nonnegative()
    .max(STOCK_LIMITS.thickness)
    .describe('Measured bow along Y, in millimetres, over the clamped piece.'),
  source: z.literal('measured').describe('Always "measured": these numbers came from the probe.'),
  touchCount: z
    .number()
    .int()
    .positive()
    .max(1000)
    .describe('How many probe touches produced the measurement.'),
  measuredAt: z.string().min(1).max(64).describe('When the measurement was taken.'),
});

/**
 * A pre-#496 flatness: one figure and a direction word. It is DROPPED on load rather than migrated
 * — one span cannot state a two-span measurement, and the direction word was read in opposite
 * senses by different modules, so carrying its number onto an axis would invent the other half.
 * The job loads as "not yet measured", which is what it is until the extents touches run again.
 */
const legacyFlatnessSchema = z.object({
  dome: z
    .number()
    .finite()
    .nonnegative()
    .describe('Legacy single bow figure in millimetres; dropped on load.'),
  across: z
    .enum(['width', 'length'])
    .describe('Legacy direction word; dropped on load with the figure.'),
  source: z
    .enum(['badge', 'user', 'measured'])
    .describe('Where the legacy figure came from; dropped on load.'),
});

const stockFlatnessSchema = z.union([
  measuredFlatnessSchema,
  legacyFlatnessSchema.transform(() => undefined),
]);

const stockObjectSchema = z
  .object({
    length: z
      .number()
      .finite()
      .positive()
      .max(STOCK_LIMITS.length)
      .describe('Stock length along X, in millimetres (the machine limit is 200).'),
    width: z
      .number()
      .finite()
      .positive()
      .max(STOCK_LIMITS.width)
      .describe('Stock width along Y, in millimetres (the machine limit is 200).'),
    thickness: z
      .number()
      .finite()
      .positive()
      .max(STOCK_LIMITS.thickness)
      .describe('Stock thickness along Z, in millimetres (the machine limit is 100).'),
    material: z
      .enum(STOCK_MATERIALS)
      .describe('Stock material; selects the feeds/speeds table the job starts from.'),
    // #464 — the fibre a printed blank's filament states, beside the material. OPTIONAL, not
    // defaulted: a job that has never seen a fibre filament keeps no key and round-trips byte-for-
    // byte, and `setStock` clears it when a later import states none.
    fibre: z
      .enum(['cf', 'gf'])
      .optional()
      .describe('Fibre in a printed blank: carbon fibre ("cf") or glass fibre ("gf"); omit for none.'),
    colour: stockColourSchema
      .optional()
      .describe('Two-colour blank facts; omit for a single-colour blank.'),
    flatness: stockFlatnessSchema
      .optional()
      .describe('Bow measured on the clamped piece; omit when the surface has not been measured.'),
  })
  .superRefine((stock, ctx) => {
    const colour = stock.colour;
    if (colour === undefined) return;
    // The cap is measured from the engraved face, so it cannot be thicker than the blank. (The
    // legacy migration makes cap = thickness − split, which is already inside the stock.)
    if (colour.capMm > stock.thickness + 1e-9) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['colour', 'capMm'],
        message: 'the colour cap cannot be thicker than the stock',
      });
    }
    if (colour.kind === 'laminate') {
      if (colour.capMm <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['colour', 'capMm'],
          message: 'a laminate states a positive cap',
        });
      }
      // A laminate is bought with its colour plane already in it: there is no layer grid to snap
      // to, so a layer height here would be invented print facts.
      if (colour.layerHeight !== undefined || colour.firstLayerHeight !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['colour', 'kind'],
          message: 'a laminate has no print layers',
        });
      }
    } else if (colour.firstLayerHeight !== undefined && colour.layerHeight === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['colour', 'firstLayerHeight'],
        message: 'a first layer height needs the layer height it belongs to',
      });
    }
  });

const stockSchema = z.preprocess(migrateStockPrint, stockObjectSchema);

/**
 * The job's own Z-error margins (#345). OPTIONAL, not defaulted: a job with none runs on the house
 * setting at generate time, and a stored document that keeps no key round-trips byte-for-byte.
 * Both numbers may be 0 (a job that has decided it needs no margin), so neither is `.positive()`.
 */
const engraveMarginsSchema = z.object({
  boundaryMargin: z
    .number()
    .finite()
    .nonnegative()
    .max(STOCK_LIMITS.thickness)
    .describe("Extra clearance kept from the stock's boundary, in millimetres."),
  zTolerance: z
    .number()
    .finite()
    .nonnegative()
    .max(STOCK_LIMITS.thickness)
    .describe('Tolerance on the Z floor, in millimetres.'),
  source: z
    .enum(['default', 'recommended', 'user'])
    .describe('Where these margins came from: a default, a recommendation, or the user.'),
});

const customFontSchema = z.object({
  id: z.string().min(1).describe('Id the job\'s labels use to name this font.'),
  name: z.string().describe('Human-readable font name.'),
  data: z.string().describe('Base64 of the TTF/OTF file.'),
});

/**
 * The user's hand edits to the feeds/speeds (#205), one optional key per `CutParams` field.
 * Deliberately NOT `.positive()`: a bad number is a CUTTING mistake (`feedsFor` names it and
 * refuses to cut), not a reason to fail loading the whole job file. Every key is optional, and
 * an absent `cutOverride` means "use the computed values unchanged".
 */
const cutOverrideSchema = z.object({
  rpm: z.number().finite().optional().describe('Spindle speed override, rpm; omit to use the computed value.'),
  feed: z.number().finite().optional().describe('Cutting feed override, mm/min; omit to use the computed value.'),
  plungeFeed: z.number().finite().optional().describe('Plunge feed override, mm/min; omit to use the computed value.'),
  stepDown: z.number().finite().optional().describe('Depth per pass override, millimetres; omit to use the computed value.'),
  stepOver: z.number().finite().optional().describe('Step-over override, millimetres; omit to use the computed value.'),
  // #220: the peck depth for plunge drilling, mm.
  peck: z.number().finite().optional().describe('Peck depth for plunge drilling, millimetres; omit for no pecking.'),
  air: z.boolean().optional().describe('True cuts this job in air (no material); omit for a real cut.'),
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
  enabled: z.boolean().describe('True runs a facing pass before the job.'),
  depth: z
    .number()
    .finite()
    .min(0)
    .max(FACING_DEPTH_MAX_MM)
    .describe('Total depth taken off the top face, in millimetres; 0 means nothing is removed.'),
  // #432 slice 2 — the facing program's own cutter, as a registry key. OPTIONAL, so a job written
  // before the field existed round-trips byte-for-byte, and null/absent asks the default rule.
  toolKey: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('Registry key of the facing cutter; null or omitted asks the default rule.'),
});

/**
 * Where an asserted value came from (#246/#254/#310). The same four states as `FieldSource` —
 * `catalogue` is Makera's own starting number for a cutter they sell, and it is here because a job
 * that adopts one must round-trip it: without this key the Zod object would STRIP it on load and
 * the value would come back reading `computed`. Every key is optional, so a job that asserts
 * nothing carries no `sources` key at all and round-trips.
 */
const fieldSourceSchema = z
  .enum(['computed', 'catalogue', 'user', 'measured', 'assumed'])
  .describe('Where this value came from: computed, a cutter catalogue, the user, a measurement, or an assumption.');

/**
 * Where the stock came from (#418, `EngraveJob.stockEntry`). Strict where it can be: the form is
 * one of the rectangular ones a job can hold, and a shelf pick names its entry.
 */
const stockEntrySchema = z
  .object({
    kind: z.enum(['shelf', 'file', 'made']).describe('A shelf entry, an imported file, or stock made in place.'),
    shelfId: z
      .string()
      .min(1)
      .nullable()
      .describe('Shelf entry id; null unless kind is "shelf".'),
    file: z
      .object({
        name: z.string().describe('File name the stock was read from.'),
        sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .describe('Lowercase SHA-256 of the file\'s bytes (64 hex characters).'),
      })
      .nullable()
      .describe('Name and hash of the stock file; null unless kind is "file".'),
    form: z
      .enum(['sheet', 'plate', 'block', 'printed-blank'])
      .describe('Stock form: sheet, plate, block, or a printed blank.'),
    finish: z
      .enum(['rough', 'finished', 'printed', 'unknown'])
      .describe('Surface the stock arrived with.'),
    conductive: z.boolean().describe('True when the stock conducts (a safety-relevant fact).'),
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
const mountSchema = z
  .enum(['vise', 'bracket', 'tape'])
  .describe('How the stock is held: in the vise, on the bracket, or with tape.');

const faceSchema = z
  .enum(FACES)
  .describe('A stock face name; this setup slot states which face it refers to.');
const orientationSchema = z
  .object(
    Object.fromEntries(FACES.map((face) => [face, faceSchema])) as Record<Face, typeof faceSchema>,
  )
  .describe('Which stock face the setup works on, per face name.');

const mountSpecSchema = z.object({
  kind: mountSchema,
  // Vise: the widest the jaws open, mm. Bracket/tape: a board under the stock.
  viseOpeningMm: z
    .number()
    .finite()
    .positive()
    .optional()
    .describe('Widest jaw opening in millimetres; for a vise setup.'),
  board: z
    .boolean()
    .optional()
    .describe('True when a board sits under the stock; for bracket and tape setups.'),
});

const edgeScanSchema = z.object({
  edge: z.enum(['left', 'right', 'front', 'back']).describe('Stock edge this scan measures.'),
  along: z.number().finite().describe('Position along the edge where the scan runs, in millimetres.'),
  expectedAt: z.number().finite().describe('Expected edge position, in millimetres.'),
  outward: z.union([z.literal(1), z.literal(-1)]).describe('Scan direction: +1 or −1 along the axis.'),
  start: z.number().finite().describe('Scan start position, in millimetres.'),
  limit: z.number().finite().describe('Scan travel limit, in millimetres.'),
  coarseStep: z.number().finite().describe('Coarse search step, in millimetres.'),
  fineStep: z.number().finite().describe('Fine search step, in millimetres.'),
  label: z.string().optional().describe('Optional label shown next to the scan in the run sheet.'),
  oppositeAt: z
    .number()
    .finite()
    .optional()
    .describe('Opposite edge position the inward search is bounded by (#593); absent on a reference scan.'),
});

/** The stock as the job expected it, work XY — `ExpectedStock`. */
const expectedStockSchema = z.object({
  xMin: z.number().finite().describe('Expected stock minimum X, in the work frame.'),
  yMin: z.number().finite().describe('Expected stock minimum Y, in the work frame.'),
  xMax: z.number().finite().describe('Expected stock maximum X, in the work frame.'),
  yMax: z.number().finite().describe('Expected stock maximum Y, in the work frame.'),
  cornerRadius: z
    .number()
    .finite()
    .nonnegative()
    .describe('Expected corner radius in millimetres; 0 for square corners.'),
});

const bracketOriginSchema = z.object({
  x: z.number().finite().describe('Bracket origin X, in millimetres.'),
  y: z.number().finite().describe('Bracket origin Y, in millimetres.'),
  from: z.string().describe('What the origin was derived from.'),
  offsetMeasured: z.boolean().describe('True when the offset was measured rather than assumed.'),
});

/** A clamp or the bracket's arm, as the operator must confirm it (#427). */
const planObstacleSchema = z.object({
  kind: z.enum(['clamp', 'bracket']).describe('The kind of obstacle: a clamp or the bracket arm.'),
  label: z.string().describe('Label shown to the operator.'),
  min: z
    .tuple([z.number().finite(), z.number().finite()])
    .describe('[x, y] minimum corner of the obstacle, in millimetres.'),
  max: z
    .tuple([z.number().finite(), z.number().finite()])
    .describe('[x, y] maximum corner of the obstacle, in millimetres.'),
  topZ: z.number().finite().describe('Top of the obstacle in part-frame Z, in millimetres.'),
});

/** A reference cut in an earlier setup, read to find the stock again (#429). */
const referenceEntrySchema = z.object({
  itemId: z.string().min(1).describe('Id of the item whose cut is used as a reference.'),
  name: z.string().describe('Item name, for the run sheet.'),
  centre: positionSchema.describe('Reference centre in work coordinates.'),
  size: z
    .object({
      x: z.number().finite().describe('Reference size along X, in millimetres.'),
      y: z.number().finite().describe('Reference size along Y, in millimetres.'),
    })
    .describe('Reference extent in millimetres.'),
  xScans: z
    .array(z.number().int().nonnegative())
    .describe('Scan indices along X that touch this reference.'),
  yScans: z
    .array(z.number().int().nonnegative())
    .describe('Scan indices along Y that touch this reference.'),
});

/** The location's registration tunables (#430) as an approved plan froze them. */
const registrationSettingsSchema = z.object({
  capBelowSurfaceMm: z.number().finite().describe('Probe cap height below the nominal surface, in millimetres.'),
  coarseStepMm: z.number().finite().describe('Coarse search step, in millimetres.'),
  fineStepMm: z.number().finite().describe('Fine search step, in millimetres.'),
  parkAboveSurfaceMm: z.number().finite().describe('Parking height above the surface, in millimetres.'),
  scanInsideMm: z.number().finite().describe('How far inside the expected edge a scan starts, in millimetres.'),
  scanReachMm: z.number().finite().describe('How far a scan may travel, in millimetres.'),
  cornerClearanceMm: z.number().finite().describe('Clearance kept from corners, in millimetres.'),
  surfaceBandMm: z.number().finite().describe('Height band treated as the surface, in millimetres.'),
  tipRadiusMm: z.number().finite().describe('Effective probe tip radius, in millimetres.'),
  tipRadiusUncertaintyMm: z.number().finite().describe('Uncertainty on the probe tip radius, in millimetres.'),
  tipDiameterMm: z.number().finite().describe('Probe tip diameter, in millimetres.'),
  edgeMarginMm: z.number().finite().describe('Margin kept from the stock edge, in millimetres.'),
  surfaceSeekMm: z.number().finite().describe('Distance to seek down to find the surface, in millimetres.'),
  surfaceToleranceMm: z.number().finite().describe('Tolerance for a surface touch, in millimetres.'),
  // #475 — absent in a plan frozen before this key existed; such a plan is still a valid record
  // of the registration it was approved with, and the seed is the value every new plan carries.
  surfaceTouchCount: z
    .number()
    .int()
    .min(5)
    .max(9)
    .default(5)
    .describe('Number of surface touches (5–9) the approved plan used.'),
  touchFeed: z.number().finite().describe('Probe feed while touching, mm/min.'),
  surfaceFastFeed: z.number().finite().describe('Fast probe feed during the surface seek, mm/min.'),
  surfaceSlowFeed: z.number().finite().describe('Slow probe feed during the final surface approach, mm/min.'),
  surfaceSlowSeekMm: z.number().finite().describe('Distance over which the slow approach runs, in millimetres.'),
  idlePollLimit: z.number().int().describe('How many status polls may show the machine idle before a touch gives up.'),
  scanMissMarginMm: z.number().finite().describe('Extra travel past the expected edge before a scan counts as missed, in millimetres.'),
  readingResolutionMm: z.number().finite().describe('Resolution of a probe position reading, in millimetres.'),
});

const registrationPlanSchema = z.object({
  mount: mountSchema,
  stock: expectedStockSchema.describe('The stock as this plan expects to find it.'),
  surfacePoint: positionSchema.describe('Work-coordinate point where the surface is probed.'),
  seek: z
    .object({
      fromMachineZ: z.number().finite().describe('Machine Z the seek starts from, in millimetres.'),
      travelMm: z.number().finite().describe('How far the seek may travel down, in millimetres.'),
      band: z
        .object({
          min: z.number().finite().describe('Bottom of the accepted surface band, in millimetres.'),
          max: z.number().finite().describe('Top of the accepted surface band, in millimetres.'),
        })
        .describe('Height band accepted as the surface, in millimetres.'),
    })
    .describe('The surface seek this plan runs.'),
  mountDatum: z
    .object({
      jawTopZ: z.number().finite().describe('Measured jaw-top machine Z, in millimetres.'),
      measuredAt: z.string().describe('When the datum was measured.'),
      by: z.string().describe('The probe id/variant that tapped the datum.'),
    })
    .nullable()
    .default(null)
    .describe('The measured mount datum the seek is a search from, or null/absent on the legacy seat path.'),
  probe: z
    .object({
      id: z.string().describe('The checked-out probe accessory id.'),
      variant: z.string().nullable().describe('The probe variant, or null.'),
      tip: z
        .object({
          diameterMm: z.number().finite().describe('Probe tip diameter, in millimetres.'),
          rimOffsetMm: z.number().finite().describe('Effective probe rim offset, in millimetres.'),
          rimOffsetUncertaintyMm: z.number().finite().describe('Rim offset spread, ± millimetres.'),
        })
        .describe('The probe tip values that resolved the settings.'),
    })
    .nullable()
    .default(null)
    .describe('The checked-out probe on the plan, or null/absent.'),
  mountTap: z
    .object({
      x: z.number().finite().describe('The tap point X, machine coordinates, in millimetres.'),
      y: z.number().finite().describe('The tap point Y, machine coordinates, in millimetres.'),
      fromMachineZ: z.number().finite().describe('The travel height the tap starts from, machine Z.'),
      label: z.string().describe('What the tap touches, for the operator.'),
    })
    .nullable()
    .default(null)
    .describe('The mount tap the executor touches before the surface seek, or null/absent.'),
  scans: z.array(edgeScanSchema).describe('Edge scans the plan runs.'),
  bracketOrigin: bracketOriginSchema
    .nullable()
    .describe('Bracket origin when the plan found one, or null.'),
  mountObstacles: z.array(planObstacleSchema).describe('Clamps and bracket arms the operator must confirm are clear.'),
  settings: registrationSettingsSchema.describe('The registration tunables the plan was computed with.'),
  notes: z.array(z.string()).describe('Human-readable notes shown with the plan.'),
  references: z
    .array(referenceEntrySchema)
    .optional()
    .describe('Reference cuts used to relocate the stock in a later setup; omit if none.'),
  referenceRotation: z
    .object({
      between: z
        .tuple([z.string(), z.string()])
        .describe('The two reference ids whose separation fixes the rotation.'),
      separation: z.number().finite().describe('Centre-to-centre separation of the two references, in millimetres.'),
      resolutionMm: z.number().finite().describe('Resolution of the rotation estimate, in millimetres.'),
    })
    .nullable()
    .optional()
    .describe('Rotation derived from two reference cuts, or null/omitted.'),
});

const jobSetupRegistrationSchema = z.object({
  method: mountSchema,
  plan: registrationPlanSchema.describe('The approved registration plan for this setup.'),
  expected: z.string().describe('One-line description of what the plan expects to find.'),
});

/** `RemountStep.confirm`'s shape: a landmark question, its answers, and the right one's index. */
const remountConfirmSchema = z.object({
  question: z.string().describe('The question put to the operator after remounting.'),
  options: z.array(z.string()).describe('Answer options.'),
  correct: z
    .number()
    .int()
    .nonnegative()
    .describe('Index of the correct answer in options.'),
});

const jobSetupSchema = z.object({
  // The schema mints a setup id exactly as it mints `EngraveJob.id`: a document written before the
  // field existed (or a hand-built setup) gains one on parse rather than failing to load.
  id: z
    .string()
    .min(1)
    .default(() => newId('setup'))
    .describe('Unique setup id; generated when a document does not state one.'),
  orientation: orientationSchema,
  mount: mountSpecSchema.describe('How the stock is held for this setup.'),
  itemIds: z.array(z.string().min(1)).describe('Ids of the items cut in this setup.'),
  tools: z.array(z.string().min(1)).describe('Registry keys of the cutters this setup uses.'),
  // #472 — per-cutter item assignment. Named here because the schema strips an unknown field on
  // load, and a saved assignment silently lost is a setup that cuts the wrong items.
  toolItems: z
    .record(z.string().min(1), z.array(z.string().min(1)))
    .optional()
    .describe('Item ids cut by each cutter, keyed by registry key; omit when not assigned per cutter.'),
  registration: jobSetupRegistrationSchema
    .optional()
    .describe('The approved registration for this setup; omit for none.'),
  remount: z
    .object({
      instruction: z.array(z.string()).describe('Steps shown when the stock is remounted.'),
      confirm: remountConfirmSchema
        .nullable()
        .describe('The landmark question that confirms the remount, or null.'),
    })
    .optional()
    .describe('Instructions for remounting the stock; omit when the setup is never remounted.'),
});

/** A v3 source record (#425 §6): the file's bytes, or its name and SHA-256 when it is too large. */
export const jobSourceSchema = z
  .object({
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'a lowercase SHA-256 (64 hex characters)')
      .describe("Lowercase SHA-256 of the source file's bytes (64 hex characters)."),
    kind: z.enum(['svg', 'dxf', 'image', '3mf', 'font']).describe('What kind of file the source is.'),
    name: z.string().min(1).describe('File name the source was imported from.'),
    embedded: z
      .object({
        encoding: z.literal('base64').describe('Always base64.'),
        data: z.string().describe('Base64 of the source file.'),
      })
      .strict()
      .nullable()
      .describe('The embedded bytes, or null when the file was too large to embed.'),
    size: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('Source size in bytes, or null when unknown.'),
    path: z
      .string()
      .nullable()
      .describe('Path the source was read from, or null when not recorded.'),
  })
  .strict()
  .describe('A file the job was made from, with its identity and optionally its bytes.');

/** One frozen program in the package block (#419 §4, #425). */
export const frozenProgramSchema = z
  .object({
    setupIndex: z.number().int().nonnegative().describe('Index of the setup that runs this program.'),
    setupId: z.string().min(1).describe('Id of the setup that runs this program.'),
    toolKey: z.string().min(1).describe('Registry key of the cutter this program uses.'),
    nc: z.string().describe('The frozen G-code program.'),
    hash: z.string().min(1).describe('Hash of the frozen program text.'),
    frameNc: z.string().nullable().describe('The frozen frame program, or null when none was posted.'),
    frameHash: z.string().nullable().describe('Hash of the frame program, or null.'),
  })
  .strict()
  .describe('One program frozen when Cut was pressed.');

/**
 * The package block Cut freezes (#419 §4, R8). Strict: the block is ours and a key this build does
 * not name is not a field it can validate, so it is refused with its path rather than stripped.
 * The integrity of the hashes is checked when a document is OPENED (`package.ts`), not here — a
 * bad hash is a reason to refuse the package, never a reason a job file will not load.
 */
export const frozenPackageSchema = z
  .object({
    jobId: z.string().min(1).describe('Id of the job the package froze.'),
    frozenAt: z.string().min(1).describe('When the package was frozen.'),
    hash: z.string().min(1).describe('Package fingerprint over the frozen content.'),
    jobHash: z.string().min(1).describe('Hash of the job document the package froze.'),
    programs: z
      .array(frozenProgramSchema)
      .min(1)
      .describe('The frozen programs, at least one.'),
    setups: z.array(jobSetupSchema).describe('The setups the frozen programs run in.'),
    stockEntryId: z
      .string()
      .nullable()
      .describe('Shelf entry id of the stock, or null when not a shelf entry.'),
    surface: z
      .object({
        plane: z
          .object({
            offset: z.number().describe('The plane z at the origin, mm (machine Z).'),
            slopeX: z.number().describe('dZ per mm of X.'),
            slopeY: z.number().describe('dZ per mm of Y.'),
          })
          .strict()
          .describe('The fitted surface plane the programs were posted against (#608).'),
        z0: z.number().describe('The reference reading the origin was written from (the lowest touch).'),
      })
      .strict()
      .nullable()
      .optional()
      .describe('The surface the programs were posted against, or null/absent when posted flat (#608).'),
  })
  .strict()
  .describe('The programs and setups frozen by Cut, so a rerun cuts exactly what was approved.');

/** One program's outcome in the document's run log (#425 §6). */
export const jobRunLogEntrySchema = z
  .object({
    programHash: z.string().min(1).describe('Hash of the program that ran.'),
    setupIndex: z.number().int().nonnegative().describe('Index of the setup the program ran in.'),
    setupId: z.string().min(1).describe('Id of the setup the program ran in.'),
    toolKey: z.string().min(1).describe('Registry key of the cutter used.'),
    at: z.string().min(1).describe('When the run was recorded.'),
    outcome: z
      .enum(['finished', 'stopped', 'failed'])
      .describe('How the run ended: finished, stopped by the operator, or failed.'),
    ncHash: z.string().optional().describe('Hash of the program text actually run; omit when not recorded.'),
    transcript: z.string().optional().describe('The machine-run transcript (the run lines, joined); omit when not recorded.'),
  })
  .strict()
  .describe('One program run recorded in the job document.');

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
      // #492 — the two-colour facts' provenance. Pre-#492 documents stamped this as `print`.
      colour: fieldSourceSchema.optional(),
      print: fieldSourceSchema.optional(),
      // #345 — the printed face's dome, stamped with the print it belongs to. Listed explicitly
      // because zod STRIPS what an object does not name: the far side of a round trip would lose
      // the provenance while keeping the value, which is worse than either.
      flatness: fieldSourceSchema.optional(),
    })
    .transform((stock) => {
      // Same complement as `migrateStockPrint`: an old `print` stamp is this job's colour stamp.
      if (stock.colour !== undefined || stock.print === undefined) {
        const { print: _print, ...rest } = stock;
        return rest;
      }
      const { print, ...rest } = stock;
      return { ...rest, colour: print };
    })
    .optional()
    .describe('Per-field provenance for the stock; omit when nothing was stamped.'),
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
    .optional()
    .describe('Per-field provenance for the cutting parameters; omit when nothing was stamped.'),
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
    .optional()
    .describe('Per-label provenance, keyed by label id; omit when no label was stamped.'),
});

/** Version 1 (#200): the document before sacrificial material existed. */
const engraveJobV1Schema = z.object({
  schemaVersion: z.literal(1).describe('Document schema version.'),
  name: z.string().describe('Human-readable job name.'),
  // #347 — on the BASE version, not v2, because that is where every job gets it: the field is
  // DEFAULTED to the one mill this build models (`machineIdSchema`'s `.catch`), so a v1 job and a v2
  // job written before the field existed both load carrying `'Z1'`. Unlike the optional keys below
  // it is never absent, because a job has a machine whether or not anyone wrote one down.
  machineId: machineIdSchema,
  stock: stockSchema.describe('The blank being cut.'),
  labels: z.array(labelSchema).describe('Text labels engraved into the stock.'),
  // #516 item 5 — an EMPTY key is legal at every version: a fresh default job (and the `--from-3mf`
  // / badge routes) starts with no cutter and the recommendation fills a real key in later. A v1
  // document predates "no cutter", so none was ever written with one, but the schema need not
  // enforce history — empty just means "no cutter is chosen yet".
  toolKey: z.string().describe('Registry key of the cutter the job starts with; empty means no cutter is chosen yet.'),
  workholding: z
    .object({
      kind: z.literal('vise').describe('Always vise in version 1.'),
      vise: viseSchema.describe('The vise jaw measurements the job was set up with.'),
    })
    .describe('How the stock is held.'),
  minFloor: z
    .number()
    .finite()
    .nonnegative()
    .describe("Minimum allowed distance from the blank's bottom face to a floor, in millimetres."),
  edgeMargin: z
    .number()
    .finite()
    .nonnegative()
    .describe("Margin kept from the stock's edge, in millimetres."),
  customFonts: z
    .array(customFontSchema)
    .describe('Fonts embedded in the document, usable by id from labels.'),
});

/** Version 2 (#213): adds `sacrificial` and `breakthrough`. */
const engraveJobV2Schema = engraveJobV1Schema.extend({
  schemaVersion: z.literal(2).describe('Document schema version.'),
  // #419's job identity. DEFAULTED, not optional: a stock reservation and `RunContext.jobId` are
  // keyed to it, so every parsed job must carry one. A v2 document written before this field
  // existed gains an id on parse with no `schemaVersion` bump — nothing about the document changes
  // but this key. A v1 document is minted in the transform below, which is the only way it can get
  // one: the v1 schema predates the field, so its branch never reaches this default.
  id: z
    .string()
    .min(1)
    .default(() => newId('job'))
    .describe('Stable job id; generated when a document does not state one.'),
  sacrificial: sacrificialSchema.describe('The sacrificial material under and around the stock.'),
  breakthrough: z
    .number()
    .finite()
    .nonnegative()
    .describe("How far a through cut goes past the blank's bottom face, in millimetres."),
  // #362's jaw clearance. DEFAULTED, unlike the optional keys below: the shipped value is the 1 mm
  // the jaw check carried as a bare constant before it became a setting (#488), so a job written
  // without this field loads with exactly the clearance it was judged by, and no document changes
  // behaviour by the field existing.
  jawClearance: z
    .number()
    .finite()
    .nonnegative()
    .default(DEFAULT_JAW_CLEARANCE_MM)
    .describe('Clearance kept from the vise jaws, in millimetres.'),
  // #345's Z-error margins. OPTIONAL, not defaulted: an absent `margins` means "run on the house
  // setting", which is what every job written before this field existed does.
  margins: engraveMarginsSchema
    .optional()
    .describe('The job\'s own Z-error margins; omit to run on the house setting.'),
  // #205's hand-override of the feeds/speeds. Optional, so a v2 job without it is unchanged.
  cutOverride: cutOverrideSchema
    .optional()
    .describe("The user's hand edits to feeds and speeds; omit to use the computed values."),
  // #572's cutter/material override. OPTIONAL, not defaulted: an absent key means the refusal stands,
  // which is what every job written before the field existed carries.
  metalLineOverride: z
    .boolean()
    .optional()
    .describe('The operator acknowledged a refused cutter/material pair; downgrades the refusal to a warning.'),
  // #432's facing choice. OPTIONAL, not defaulted, for the byte-for-byte reason every list below
  // gives: an absent key means the job does not face, which is what every stored document says.
  facing: facingSchema.optional().describe('The facing pass to run first; omit to skip facing.'),
  // #214's shape pockets. Defaulted to empty so a v2 job written before shapes existed (and
  // the v1 transform below) still loads as a text-only job.
  shapes: z.array(shapeSchema).default([]).describe('Rectangular, round, slot and polygon pockets.'),
  // #215's combined shapes (border/frame/cutaway). OPTIONAL, not defaulted: a job that has
  // none keeps no key, so an existing document round-trips byte-for-byte (the same reason
  // `cutOverride` is optional). Consumers read it as `combined ?? []`.
  combined: z
    .array(combinedShapeSchema)
    .optional()
    .describe('Shapes derived from other items (border, frame, cutaway); omit for none.'),
  // #219's single-line traces. OPTIONAL for the same byte-for-byte reason as `combined`.
  traces: z
    .array(traceSchema)
    .optional()
    .describe('Single-line polylines and stroke text; omit for none.'),
  // #217's imported vector outlines. OPTIONAL, not defaulted: a job with none keeps no key, so a
  // pre-#217 document round-trips byte-for-byte (the same reason `combined` and `traces` are).
  vectors: z
    .array(vectorSchema)
    .optional()
    .describe('Outlines imported from SVG/DXF files; omit for none.'),
  // #231 item 3's under-surface voids. OPTIONAL, not defaulted: a job with none keeps no key, so
  // a pre-#231 document round-trips byte-for-byte (the same reason `combined`/`traces`/`vectors`).
  keepOuts: z
    .array(keepOutSchema)
    .optional()
    .describe('Voids inside the blank that no cut may enter; omit for none.'),
  // #220's plunge drills. OPTIONAL for the same byte-for-byte reason as `combined`.
  drills: z
    .array(drillSchema)
    .optional()
    .describe('Plunge-drilled holes and hole arrays; omit for none.'),
  // #445's milled threads. OPTIONAL for the same byte-for-byte reason as `combined`.
  threads: z
    .array(threadSchema)
    .optional()
    .describe('Milled metric threads; omit for none.'),
  // #218's profile cut-outs. OPTIONAL, not defaulted: a job with none keeps no key, so a
  // pre-#218 document round-trips byte-for-byte (the same reason as `combined`).
  cutouts: z
    .array(cutoutSchema)
    .optional()
    .describe('Profile cut-outs that free the part from the stock; omit for none.'),
  // #246/#254's per-field provenance. OPTIONAL, not defaulted: a job that has never had a
  // cutting override or a guided setup applied carries no key.
  sources: jobSourcesSchema
    .optional()
    .describe('Where asserted feeds, stock and label values came from; omit when nothing was stamped.'),
  // #305's snapshot of the cutter the job was written with. OPTIONAL, not defaulted, for the
  // same byte-for-byte reason as `combined`/`traces`/`vectors`/`keepOuts`/`drills`, and nullable
  // so a snapshot that could not be taken stays an explicit null. Validated by the SAME
  // `ToolSchema` the library entries use, so a job file cannot smuggle in a tool shape the
  // sweeper would then have to defend against.
  tool: ToolSchema.nullish().describe('Snapshot of the cutter the job was written with, or null.'),
  // #418's material-first start: where the stock came from. OPTIONAL, not defaulted, for the same
  // byte-for-byte reason as `combined`/`traces`/`tool`.
  stockEntry: stockEntrySchema
    .optional()
    .describe('Where the stock came from: a shelf entry, a file, or made in place.'),
  // #419 J2's setups. OPTIONAL and NOT defaulted: absent is today's single implicit top-up vise
  // setup, and it must stay absent so every stored job round-trips byte-for-byte (the same rule as
  // `combined`/`traces`/`vectors`/`keepOuts`/`drills`). Consumers read it through `jobSetups`, which
  // supplies the implicit setup when the key is absent.
  setups: z
    .array(jobSetupSchema)
    .optional()
    .describe('Saved setups; omit for the implicit single top-up vise setup.'),
});

/**
 * Version 3 (#425): the v2 document plus the three blocks Save/Open owns — the files it was made
 * from, the package Cut froze, and what has been run. Nothing in v2 is renamed or retyped, so a
 * v2 document is a v3 document with one literal changed and three keys absent; the byte-identical
 * `.nc` rule follows from that and not from a migration that rewrites fields.
 *
 * The ROOT is passthrough: an unknown top-level key a same-version build wrote survives an
 * open/save round trip, and is included in the package fingerprint (canonical JSON) so a package
 * is never judged against a document that lost a field. The three owned blocks above are strict
 * instead — an unknown key inside them is refused by path, never silently dropped.
 *
 * The embedded-file block is `sourceFiles`, NOT `sources`: `sources` has been the per-field
 * provenance map since #246/#254 (`EngraveJobSources`), and every v2 key carries forward
 * unchanged. Two different things both called "sources" in one document would invite exactly the
 * wrong read.
 */
const engraveJobV3Schema = engraveJobV2Schema
  .extend({
    schemaVersion: z.literal(3).describe('Document schema version.'),
    sourceFiles: z
      .array(jobSourceSchema)
      .optional()
      .describe('Files the job was made from, with their identity; omit for none.'),
    package: frozenPackageSchema
      .optional()
      .describe('The programs and setups frozen by Cut; omit before a cut is frozen.'),
    runLog: z
      .array(jobRunLogEntrySchema)
      .optional()
      .describe('Programs already run from this document; omit for none.'),
    // #435 — 3D primitives and the reference object they are positioned against. BOTH OPTIONAL and
    // not defaulted, so every document that predates them keeps its exact shape and parses
    // unchanged; `schemaVersion` stays 3 because nothing existing is renamed or retyped.
    primitives: z
      .array(primitiveSchema)
      .optional()
      .describe('3D negative volumes (box, cylinder, cone, sphere); omit for none.'),
    targetObject: targetObjectSchema
      .optional()
      .describe('Reference mesh the primitives are positioned against; omit for none.'),
  })
  .passthrough();

/**
 * The CURRENT engrave-job document, exactly as this build writes it (#480). `engraveJobSchema`
 * above accepts v1–v3 and migrates; a caller that AUTHORS a document should speak this shape, so
 * the MCP schema generator emits one document rather than three migrated copies.
 */
export const engraveJobDocumentSchema = engraveJobV3Schema.describe(
  'A Case Maker engrave job: the stock, the cutter, the workholding and every feature to cut.',
);

/** The version this build writes. A higher literal is refused by name, never parsed. */
export const CURRENT_JOB_SCHEMA_VERSION = 3;

/** The sentence an Open surface shows for a document written by a newer build. */
export function newerJobVersionMessage(version: number): string {
  return `This job file was written by a newer version of Case Maker (schema version ${version}). Update the app to open it.`;
}

type ParsedJobVersion = z.output<
  typeof engraveJobV1Schema | typeof engraveJobV2Schema | typeof engraveJobV3Schema
>;

/** The v1 and v2 transforms, applied to a document that already parsed against its own branch. */
function migrateParsedJob(job: ParsedJobVersion): EngraveJob {
  if (job.schemaVersion === 1) {
    return {
      ...job,
      // The v1 transform's work is unchanged; the v3 stamp is the one addition (#425). A v1 job
      // generates exactly the same program it did before the bump.
      schemaVersion: 3,
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
    };
  }
  // v2 → v3 (#425): the literal and nothing else. `sources`/`package`/`runLog` stay ABSENT, not
  // null and not empty, so a migrated document keeps the byte-for-byte rule every optional key
  // follows. A v3 document passes through as parsed.
  return job.schemaVersion === 2 ? { ...job, schemaVersion: 3 } : job;
}

export const engraveJobSchema = z
  .union([engraveJobV1Schema, engraveJobV2Schema, engraveJobV3Schema])
  .transform(migrateParsedJob);

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
  // A newer build's document is refused by NAME, before the union reduces it to "invalid literal".
  // The Open surface shows `newerJobVersionMessage`; hydration parks the payload and keeps the
  // sentence in the error list. Never parse a version this build does not know (#425).
  const rawVersion =
    json !== null && typeof json === 'object' && !Array.isArray(json)
      ? (json as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (
    typeof rawVersion === 'number' &&
    Number.isFinite(rawVersion) &&
    rawVersion > CURRENT_JOB_SCHEMA_VERSION
  ) {
    return { ok: false, errors: [newerJobVersionMessage(rawVersion)] };
  }
  // Parse the branch the document's own literal selects, ONCE, and migrate it. A union is not used
  // here for two reasons (#425): it reports every branch's failure as "<root>: Invalid input",
  // which names nothing, and — before short-circuiting — it runs the earlier branches' defaults.
  // A v3 document that reached the v3 branch after the v2 branch had already tried it would mint
  // a seeded setup id twice. A document with no literal is read as the current version: that is
  // what a hand-edited or half-written file is trying to be.
  const branch =
    rawVersion === 1 ? engraveJobV1Schema : rawVersion === 2 ? engraveJobV2Schema : engraveJobV3Schema;
  const result = branch.safeParse(json);
  if (result.success) return { ok: true, job: migrateParsedJob(result.data) };
  return {
    ok: false,
    errors: result.error.issues.flatMap(formatIssue),
  };
}

/**
 * One zod issue as the line a person reads. An `unrecognized_keys` issue on a strict object points
 * at the OBJECT (`package`) and names the key only in its message; the key is the field that has
 * to be fixed, so it is spliced into the path (`package.futureVerdict`).
 */
function formatIssue(issue: {
  path: readonly PropertyKey[];
  message: string;
  code?: string;
  keys?: readonly string[];
}): string[] {
  if (issue.code === 'unrecognized_keys' && issue.keys !== undefined) {
    const base = formatPath(issue.path);
    return issue.keys.map((key) => `${base === '<root>' ? key : `${base}.${key}`}: Unrecognized key`);
  }
  return [`${formatPath(issue.path)}: ${issue.message}`];
}

export { STOCK_LIMITS };
