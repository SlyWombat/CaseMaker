import { z } from 'zod';

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
  id: z.string().min(1),
  x: z.number(),
  y: z.number(),
  diameter: z.number().positive(),
});

const xyzSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

const componentSchema = z.object({
  id: z.string().min(1),
  kind: componentKindSchema,
  position: xyzSchema,
  size: xyzSchema.refine((s) => s.x > 0 && s.y > 0 && s.z > 0, {
    message: 'component size must be positive on all axes',
  }),
  facing: facingSchema.optional(),
  cutoutMargin: z.number().nonnegative().optional(),
  cutoutShape: cutoutShapeSchema.optional(),
  fixtureId: z.string().min(1).optional(),
});

export const boardProfileSchema = z.object({
  // Board-profile format version. Optional (absent = 1) so every existing
  // file stays valid; bump when a breaking format change ships so future
  // registries/importers can migrate old community files forward.
  schemaVersion: z.number().int().positive().optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  manufacturer: z.string().min(1),
  pcb: z.object({
    size: xyzSchema.refine((s) => s.x > 0 && s.y > 0 && s.z > 0, {
      message: 'pcb size must be positive on all axes',
    }),
  }),
  // #112 — generic-empty boards (Protective case interior, large box)
  // legitimately have zero mounting holes. The case still has bosses
  // disabled in those templates so no geometry depends on the hole list.
  mountingHoles: z.array(mountingHoleSchema),
  components: z.array(componentSchema),
  defaultStandoffHeight: z.number().nonnegative(),
  recommendedZClearance: z.number().nonnegative(),
  // Board-retention seat shoulder — raised perimeter rim so a face-down panel
  // seats snug instead of floating in the internal-clearance gap (see boardSnap).
  retentionShoulder: z.boolean().optional(),
  // Scope board-retention to a sub-rectangle of the PCB (extended boards).
  retentionFootprint: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .optional(),
  // Explicit board-retention clip placements (two-jaw catches or shelf-only
  // support tabs; see boardSnap).
  retentionClips: z
    .array(
      z.object({
        edge: z.enum(['+x', '-x', '+y', '-y']),
        offset: z.number().nonnegative(),
        width: z.number().positive().optional(),
        style: z.enum(['clip', 'shelf']).optional(),
        reach: z.number().positive().optional(),
      }),
    )
    .optional(),
  // Secondary boards held on snap clips above the floor (e.g. SlyTherm MSR-2).
  secondaryBoardMounts: z
    .array(
      z.object({
        id: z.string().min(1),
        position: z.object({ x: z.number(), y: z.number() }),
        size: xyzSchema.refine((s) => s.x > 0 && s.y > 0 && s.z > 0),
        standoffHeight: z.number().nonnegative(),
        overhang: z.number().positive().optional(),
        clips: z.array(
          z.object({
            edge: z.enum(['+x', '-x', '+y', '-y']),
            offset: z.number().nonnegative(),
            width: z.number().positive().optional(),
          }),
        ),
      }),
    )
    .optional(),
  // Finished module in a vendor shell (stand archetype needs its shell, not a cavity).
  enclosure: z
    .object({
      flangeThickness: z.number().positive(),
      body: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number().positive(),
        height: z.number().positive(),
        depth: z.number().positive(),
      }),
      bossDiameter: z.number().positive(),
      bossHeight: z.number().positive(),
      // Bumps on the rear body's side faces that a frame must channel around.
      edgeProtrusions: z
        .array(
          z.object({
            id: z.string().min(1),
            edge: z.enum(['+x', '-x', '+y', '-y']),
            from: z.number(),
            to: z.number(),
            depth: z.number().positive(),
          }),
        )
        .optional(),
    })
    .optional(),
  source: z.string().url().optional(),
  crossReference: z.string().url().optional(),
  datasheetRevision: z.string().optional(),
  measurementMethod: z.enum(['datasheet', 'open-source-cad', 'physical-measurement']).optional(),
  clonedFrom: z.string().min(1).optional(),
  visualAssets: z
    .object({
      glb: z.string().optional(),
      topImage: z.string().optional(),
      sideImage: z.string().optional(),
      license: z.string().optional(),
      sourceUrl: z.string().url().optional(),
    })
    .optional(),
  verified: z.boolean().optional(),
  builtin: z.boolean(),
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
 * Top-level keys of `raw` the board schema doesn't know (#129). Zod parsing
 * silently STRIPS unknown keys, so a board authored against a newer Case
 * Maker would lose fields without a trace — surface them as import warnings
 * instead.
 */
export function unknownBoardKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const known = new Set(Object.keys(boardProfileSchema.shape));
  return Object.keys(raw).filter((k) => !known.has(k));
}
