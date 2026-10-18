import { z } from 'zod';

// Every field carries `.describe()` (#480): these documents are emitted as JSON Schema for the
// headless MCP tools, and the description is the only thing a model has to go on when it authors
// a profile. Keep the text about the DATA, not about the app's internals.

const componentKindSchema = z.enum([
  'usb-c',
  'usb-a',
  'usb-b',
  'micro-usb',
  'hdmi',
  'micro-hdmi',
  'barrel-jack',
  'ethernet-rj45',
  'gpio-header',
  'sd-card',
  'flat-cable',
  'fan-mount',
  'text-label',
  'antenna-connector',
  'custom',
]);

const cutoutShapeSchema = z.enum(['rect', 'round']);

const facingSchema = z.enum(['+x', '-x', '+y', '-y', '+z', '-z']);

const mountingHoleSchema = z.object({
  id: z.string().min(1).describe('Unique id for this hole within the board.'),
  x: z.number().describe('Hole centre X, millimetres from the board origin at the PCB corner.'),
  y: z.number().describe('Hole centre Y, millimetres from the board origin at the PCB corner.'),
  diameter: z
    .number()
    .positive()
    .describe('Hole diameter in millimetres; the standoff boss and screw pass through this.'),
});

const xyzSchema = z.object({
  x: z.number().describe('X in millimetres.'),
  y: z.number().describe('Y in millimetres.'),
  z: z.number().describe('Z in millimetres; Z is up, with the board top at Z 0.'),
});

const componentSchema = z.object({
  id: z.string().min(1).describe('Unique id for this component within the board.'),
  kind: componentKindSchema.describe(
    'What the component is; this chooses the cutout profile and how the picker draws it.',
  ),
  position: xyzSchema.describe(
    'Component origin on the board, in millimetres: X/Y from the PCB corner, Z above the board top.',
  ),
  size: xyzSchema
    .refine((s) => s.x > 0 && s.y > 0 && s.z > 0, {
      message: 'component size must be positive on all axes',
    })
    .describe('Component extents in millimetres, before any cutout margin is added.'),
  facing: facingSchema
    .optional()
    .describe('Face the component sits on; omit for a top-side component.'),
  cutoutMargin: z
    .number()
    .nonnegative()
    .optional()
    .describe('Extra clearance around the cutout in millimetres; omit for none.'),
  cutoutShape: cutoutShapeSchema
    .optional()
    .describe('Cutout outline: a rounded rectangle or a circle; omit for the kind default.'),
  fixtureId: z
    .string()
    .min(1)
    .optional()
    .describe('Id of a bench fixture that documents how this component is held while probing.'),
  // #130 — silkscreen legend for `kind: 'text-label'` components (the picker's
  // top view draws it). Optional and additive: existing files are unaffected.
  text: z
    .string()
    .min(1)
    .optional()
    .describe('Silkscreen legend drawn on the board, for components of kind "text-label".'),
});

/**
 * #130 — per-board visual assets. A board may ship a GLB model and/or
 * top/side photos, either bundled under `public/` (built-in boards) or
 * referenced by absolute URL (community boards hosted in the library repo).
 *
 * Licensed material: an asset may be present ONLY when the licence that
 * permits redistributing it and a URL naming its source are recorded too —
 * this is the machine-checkable half of the rule in `src/docs/board-assets.md`
 * ("never bundle non-redistributable assets"). Enforcement is deliberate and
 * load-bearing: built-in boards are validated at import, and local/remote
 * community boards are validated on import (`localBoardProfileSchema`), so a
 * profile that ships a photo without a licence is rejected rather than
 * silently vendored. The `npm test` run in CI therefore gates every asset.
 */
const visualAssetsSchema = z
  .object({
    glb: z.string().min(1).optional().describe('Path or URL of a glTF binary (GLB) model.'),
    topImage: z.string().min(1).optional().describe('Path or URL of a top-down board photo.'),
    sideImage: z.string().min(1).optional().describe('Path or URL of a side-on board photo.'),
    license: z
      .string()
      .min(1)
      .optional()
      .describe('Licence that permits redistributing the assets; required with any asset.'),
    sourceUrl: z
      .string()
      .url()
      .optional()
      .describe('Where the assets came from; required with any asset.'),
  })
  .superRefine((assets, ctx) => {
    const hasAsset = Boolean(assets.glb || assets.topImage || assets.sideImage);
    if (!hasAsset) return;
    if (!assets.license) {
      ctx.addIssue({
        code: 'custom',
        path: ['license'],
        message:
          'visualAssets.license is required when glb/topImage/sideImage is present — record the redistribution licence (see src/docs/board-assets.md)',
      });
    }
    if (!assets.sourceUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceUrl'],
        message:
          'visualAssets.sourceUrl is required when glb/topImage/sideImage is present — record where the asset came from',
      });
    }
  })
  .describe('Optional model and photo assets, with the licence and source they were taken from.');

export const boardProfileSchema = z.object({
  // Board-profile format version. Optional (absent = 1) so every existing
  // file stays valid; bump when a breaking format change ships so future
  // registries/importers can migrate old community files forward.
  schemaVersion: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Board-profile format version; omit for version 1.'),
  id: z
    .string()
    .min(1)
    .describe('Stable id for the board, e.g. "esp32-devkit-v1"; the library keys off this.'),
  name: z.string().min(1).describe('Human-readable board name shown in the picker.'),
  manufacturer: z.string().min(1).describe('Board maker, e.g. "Espressif".'),
  pcb: z
    .object({
      size: xyzSchema
        .refine((s) => s.x > 0 && s.y > 0 && s.z > 0, {
          message: 'pcb size must be positive on all axes',
        })
        .describe('PCB extents in millimetres; Z is the board thickness.'),
    })
    .describe('The bare PCB: its size determines the case cavity footprint.'),
  // #112 — generic-empty boards (Protective case interior, large box)
  // legitimately have zero mounting holes. The case still has bosses
  // disabled in those templates so no geometry depends on the hole list.
  mountingHoles: z
    .array(mountingHoleSchema)
    .describe('Mounting holes that should receive standoff bosses; may be empty.'),
  components: z
    .array(componentSchema)
    .describe('Components on the board that need a cutout, opening or label.'),
  defaultStandoffHeight: z
    .number()
    .nonnegative()
    .describe('Gap in millimetres between the cavity floor and the underside of the PCB.'),
  recommendedZClearance: z
    .number()
    .nonnegative()
    .describe('Clearance in millimetres to leave above the tallest component.'),
  // Board-retention seat shoulder — raised perimeter rim so a face-down panel
  // seats snug instead of floating in the internal-clearance gap (see boardSnap).
  retentionShoulder: z
    .boolean()
    .optional()
    .describe('Raise a perimeter seat rim so a face-down board sits snug; omit for off.'),
  // Scope board-retention to a sub-rectangle of the PCB (extended boards).
  retentionFootprint: z
    .object({
      x: z.number().describe('Footprint origin X in millimetres from the PCB corner.'),
      y: z.number().describe('Footprint origin Y in millimetres from the PCB corner.'),
      width: z.number().positive().describe('Footprint width in millimetres.'),
      height: z.number().positive().describe('Footprint height in millimetres.'),
    })
    .optional()
    .describe('Restrict board retention to this rectangle of the PCB; omit for the whole board.'),
  // Explicit board-retention clip placements (two-jaw catches or shelf-only
  // support tabs; see boardSnap).
  retentionClips: z
    .array(
      z.object({
        edge: z
          .enum(['+x', '-x', '+y', '-y'])
          .describe('PCB edge the clip is placed on.'),
        offset: z
          .number()
          .nonnegative()
          .describe('Distance in millimetres from the start of that edge.'),
        width: z
          .number()
          .positive()
          .optional()
          .describe('Clip width along the edge in millimetres; omit for the builder default.'),
        style: z
          .enum(['clip', 'shelf'])
          .optional()
          .describe('A two-jaw clip or a shelf-only support tab; omit for "clip".'),
        reach: z
          .number()
          .positive()
          .optional()
          .describe('How far in millimetres the clip reaches over the board; omit for the default.'),
      }),
    )
    .optional()
    .describe('Explicit board-retention clips; omit to let the builder choose placements.'),
  // Secondary boards held on snap clips above the floor (e.g. SlyTherm MSR-2).
  secondaryBoardMounts: z
    .array(
      z.object({
        id: z.string().min(1).describe('Unique id for this secondary mount.'),
        position: z
          .object({
            x: z.number().describe('Mount origin X in millimetres.'),
            y: z.number().describe('Mount origin Y in millimetres.'),
          })
          .describe('Where the secondary board sits in plan view, in millimetres.'),
        size: xyzSchema
          .refine((s) => s.x > 0 && s.y > 0 && s.z > 0)
          .describe('Secondary board extents in millimetres.'),
        standoffHeight: z
          .number()
          .nonnegative()
          .describe('Height in millimetres above the cavity floor.'),
        overhang: z
          .number()
          .positive()
          .optional()
          .describe('How far in millimetres the board may overhang its supports.'),
        clips: z
          .array(
            z.object({
              edge: z
                .enum(['+x', '-x', '+y', '-y'])
                .describe('Board edge the snap clip is placed on.'),
              offset: z
                .number()
                .nonnegative()
                .describe('Distance in millimetres from the start of that edge.'),
              width: z
                .number()
                .positive()
                .optional()
                .describe('Clip width along the edge in millimetres.'),
            }),
          )
          .describe('Snap clips that hold the secondary board.'),
      }),
    )
    .optional()
    .describe('Boards held above the floor on snap clips; omit for none.'),
  // Finished module in a vendor shell (stand archetype needs its shell, not a cavity).
  enclosure: z
    .object({
      flangeThickness: z
        .number()
        .positive()
        .describe('Thickness of the device shell wall in millimetres.'),
      body: z
        .object({
          x: z.number().describe('Body origin X in millimetres.'),
          y: z.number().describe('Body origin Y in millimetres.'),
          width: z.number().positive().describe('Body width in millimetres.'),
          height: z.number().positive().describe('Body height in millimetres.'),
          depth: z.number().positive().describe('Body depth in millimetres.'),
        })
        .describe('The vendor shell body in plan view and depth, in millimetres.'),
      bossDiameter: z
        .number()
        .positive()
        .describe('Diameter in millimetres of the shell mounting bosses.'),
      bossHeight: z
        .number()
        .positive()
        .describe('Height in millimetres of the shell mounting bosses.'),
      // Bumps on the rear body's side faces that a frame must channel around.
      edgeProtrusions: z
        .array(
          z.object({
            id: z.string().min(1).describe('Unique id for this protrusion.'),
            edge: z
              .enum(['+x', '-x', '+y', '-y'])
              .describe('Body face the protrusion is on.'),
            from: z
              .number()
              .describe('Start of the protrusion along that edge, in millimetres.'),
            to: z.number().describe('End of the protrusion along that edge, in millimetres.'),
            depth: z
              .number()
              .positive()
              .describe('How far the protrusion stands out in millimetres.'),
          }),
        )
        .optional()
        .describe('Bumps on the shell face that a mount must channel around; omit for none.'),
      // Rear T-slot mounting channel (slide-on bracket devices, e.g. the
      // UniFi U7 Pro Outdoor). Consumed by the stand archetype's 'slider'
      // mount. throat < cavity and lip < total, or the bracket can't lock.
      sliderChannel: z
        .object({
          cavityWidth: z
            .number()
            .positive()
            .describe('Width in millimetres of the wide part of the T-slot.'),
          throatWidth: z
            .number()
            .positive()
            .describe('Width in millimetres of the narrow slot opening; must be less than cavityWidth.'),
          lipDepth: z
            .number()
            .positive()
            .describe('Depth in millimetres of the retaining lip; must be less than totalDepth.'),
          totalDepth: z
            .number()
            .positive()
            .describe('Total depth in millimetres of the channel.'),
          length: z
            .number()
            .positive()
            .describe('Length in millimetres of the channel along the body.'),
          topFromDeviceBottom: z
            .number()
            .positive()
            .describe('Channel top position in millimetres above the bottom of the device.'),
        })
        .refine((c) => c.throatWidth < c.cavityWidth, {
          message: 'sliderChannel.throatWidth must be smaller than cavityWidth',
        })
        .refine((c) => c.lipDepth < c.totalDepth, {
          message: 'sliderChannel.lipDepth must be smaller than totalDepth',
        })
        .optional()
        .describe('Rear T-slot channel a slide-on bracket locks into; omit for none.'),
    })
    .optional()
    .describe('A finished device in a vendor shell, for the stand archetype; omit for a bare PCB.'),
  source: z
    .string()
    .url()
    .optional()
    .describe('URL the board dimensions were taken from; required for built-in profiles.'),
  crossReference: z
    .string()
    .url()
    .optional()
    .describe('URL of an alternate source that corroborates the dimensions.'),
  datasheetRevision: z
    .string()
    .optional()
    .describe('Revision of the datasheet the dimensions were read from.'),
  measurementMethod: z
    .enum(['datasheet', 'open-source-cad', 'physical-measurement'])
    .optional()
    .describe('How the dimensions were obtained: datasheet, open-source CAD, or a physical measurement.'),
  clonedFrom: z
    .string()
    .min(1)
    .optional()
    .describe('Id of the board this profile was cloned from.'),
  visualAssets: visualAssetsSchema
    .optional()
    .describe('Optional model and photo assets, with the licence and source they were taken from.'),
  // No `verified` tier (#128). A badge saying a third-party profile is
  // "verified" would claim we audited dimensions we cannot audit; the picker
  // states a board's ORIGIN instead. An index that still carries the old
  // key is not rejected — this object strips unknown keys (see board.ts).

  // #128 — per-board version carried by a community index. Optional and
  // additive (built-ins leave it absent). The update flow compares an index's
  // value against the cached copy to flag boards that changed upstream, so a
  // publisher bumps it whenever the board's data changes. String or number so
  // an index can use "1.2.0" or a monotonic counter.
  version: z
    .union([z.string().min(1), z.number()])
    .optional()
    .describe('Publisher version of this profile ("1.2.0" or a counter); bump when the data changes.'),
  builtin: z
    .boolean()
    .describe('True for a profile bundled with the app; imported profiles are coerced to false.'),
});

export const builtinBoardProfileSchema = boardProfileSchema.refine(
  (b) => b.builtin === true && typeof b.source === 'string' && b.source.length > 0,
  { message: 'builtin boards must include a source URL for traceability' },
);

/**
 * User-imported (local-library) board profiles. Same shape as builtin, but:
 *  - `builtin` is optional on input and always coerced to false — an imported
 *    file must never masquerade as a bundled profile;
 *  - no source-URL requirement (a home-measured board has no URL) — the
 *    import UI surfaces a soft warning instead.
 */
export const localBoardProfileSchema = boardProfileSchema
  .extend({ builtin: z.boolean().optional() })
  .transform((b) => ({ ...b, builtin: false }));

export type BoardProfileInput = z.infer<typeof boardProfileSchema>;

/**
 * Field names that were once in the schema and are deliberately gone. An
 * import carrying one is not "authored for a newer Case Maker" — the field
 * was retired on purpose — so it must stay quiet while a genuinely unknown
 * key still warns.
 *
 * `verified` is the #128 community "✓ printed" tier: a curator-set flag whose
 * badge claimed a printed fit, dropped because we cannot audit a third
 * party's dimensions.
 */
const RETIRED_BOARD_KEYS = new Set(['verified']);

/**
 * Top-level keys of `raw` the board schema doesn't know (#129). Zod parsing
 * silently STRIPS unknown keys, so a board authored against a newer Case
 * Maker would lose fields without a trace — surface them as import warnings
 * instead. Retired keys are known-by-absence and are not surfaced.
 */
export function unknownBoardKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const known = new Set(Object.keys(boardProfileSchema.shape));
  return Object.keys(raw).filter((k) => !known.has(k) && !RETIRED_BOARD_KEYS.has(k));
}
