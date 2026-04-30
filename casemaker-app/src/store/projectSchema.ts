import { z } from 'zod';
import { boardProfileSchema } from '@/library/schema';
import { hatProfileSchema } from '@/library/hatSchema';
import { displayProfileSchema } from '@/library/displaySchema';

const xyzSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

export const caseParamsSchema = z.object({
  wallThickness: z.number().positive(),
  floorThickness: z.number().positive(),
  lidThickness: z.number().positive(),
  cornerRadius: z.number().nonnegative(),
  internalClearance: z.number().nonnegative(),
  zClearance: z.number().nonnegative(),
  joint: z.preprocess(
    (v) => (v === 'sliding' ? 'flat-lid' : v),
    z.enum(['snap-fit', 'screw-down', 'flat-lid']),
  ),
  lidRecess: z.boolean().optional(),
  extraCavityZ: z.number().nonnegative().optional(),
  snapType: z.enum(['barb', 'full-lid']).optional(),
  ventilation: z.object({
    // Issue #75 — surfaces the vent pattern is cut into. Optional so legacy
    // projects load with no migration; compiler defaults to ['back'].
    surfaces: z
      .array(z.enum(['top', 'bottom', 'front', 'back', 'left', 'right']))
      .optional(),
    enabled: z.boolean(),
    pattern: z.enum(['none', 'slots', 'hex']),
    coverage: z.number().min(0).max(1),
  }),
  bosses: z.object({
    enabled: z.boolean(),
    insertType: z.enum(['self-tap', 'heat-set-m2.5', 'heat-set-m3', 'pass-through', 'none']),
    outerDiameter: z.number().positive(),
    holeDiameter: z.number().positive(),
  }),
  snapCatches: z
    .array(
      z.object({
        id: z.string(),
        wall: z.enum(['+x', '-x', '+y', '-y']),
        uPosition: z.number(),
        enabled: z.boolean(),
        // Issue #69 + #78 — barb cross-section. Defaults to 'hook' at parse
        // time so older projects load with an explicit value (avoids the
        // UI-shows-wrong-option bug where the select didn't reflect the
        // engine's compile-time fallback).
        barbType: z
          .enum(['hook', 'asymmetric-ramp', 'symmetric-ramp', 'half-round', 'ball-socket'])
          .default('hook'),
        insertionRampDeg: z.number().optional(),
        retentionRampDeg: z.number().optional(),
        // Issue #64 — which part holds the flexing cantilever. Optional so
        // legacy projects load with the implicit 'lid' default; geometry
        // dispatch keys off the .default() at parse time.
        cantileverOn: z.enum(['lid', 'case']).default('lid'),
      }),
    )
    .optional(),
  // Issue #76 — freeform user-placed cutouts. Optional so legacy projects
  // load with no migration; a missing field is treated as an empty list.
  customCutouts: z
    .array(
      z.object({
        id: z.string(),
        face: z.enum(['top', 'bottom', 'front', 'back', 'left', 'right']),
        shape: z.enum(['rect', 'round', 'slot']),
        u: z.number(),
        v: z.number(),
        width: z.number().positive(),
        height: z.number().positive(),
        rotationDeg: z.number().optional(),
        enabled: z.boolean(),
        label: z.string().optional(),
      }),
    )
    .optional(),
});

const portPlacementSchema = z.object({
  id: z.string(),
  sourceComponentId: z.string().nullable(),
  kind: z.enum([
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
  ]),
  position: xyzSchema,
  size: xyzSchema,
  facing: z.enum(['+x', '-x', '+y', '-y', '+z']),
  cutoutMargin: z.number().nonnegative(),
  locked: z.boolean(),
  enabled: z.boolean(),
  cutoutShape: z.enum(['rect', 'round']).optional(),
});

const externalAssetSchema = z.object({
  id: z.string(),
  name: z.string(),
  format: z.enum(['stl', '3mf']),
  data: z.string(),
  transform: z.object({
    position: z.tuple([z.number(), z.number(), z.number()]),
    rotation: z.tuple([z.number(), z.number(), z.number()]),
    scale: z.number(),
  }),
  visibility: z.enum(['reference', 'subtract', 'union']),
});

const hatPlacementSchema = z.object({
  id: z.string(),
  hatId: z.string(),
  stackIndex: z.number().int().nonnegative(),
  liftOverride: z.number().optional(),
  offsetOverride: z.object({ x: z.number(), y: z.number() }).optional(),
  mountingPositionId: z.string().optional(),
  ports: z.array(portPlacementSchema),
  enabled: z.boolean(),
});

const mountingFeatureSchema = z.object({
  id: z.string(),
  type: z.enum([
    // Issue #80 — extended type set. Internal mounts live on the cavity
    // floor; external mounts extrude past the case envelope.
    'screw-tab',
    'end-flange',
    'zip-tie-slot',
    'vesa-mount',
    'aligned-standoff',
    'saddle',
  ]),
  // Issue #80 — required field. .default('external') so v5-vintage
  // entries (no mountClass on disk) load with the right class — every
  // pre-#80 mounting type is external by definition.
  mountClass: z.enum(['external', 'internal']).default('external'),
  face: z.enum(['+x', '-x', '+y', '-y', '+z', '-z']),
  position: z.object({ u: z.number(), v: z.number() }),
  rotation: z.number(),
  params: z.record(z.string(), z.union([z.number(), z.string()])),
  enabled: z.boolean(),
  presetId: z.string().optional(),
});

const displayPlacementSchema = z.object({
  id: z.string(),
  displayId: z.string(),
  framing: z.enum([
    'top-window',
    'recessed-bezel',
    'flush-glass',
    'hood-shade',
    'tilted',
    'removable-cap',
    'bracket-only',
  ]),
  tiltAngle: z.number().optional(),
  hoodHeight: z.number().optional(),
  bezelInset: z.number().optional(),
  offset: z.object({ x: z.number(), y: z.number() }),
  hostSupport: z.enum(['gpio-only', 'case-rim-bracket', 'under-board-posts', 'full-cradle']),
  enabled: z.boolean(),
});

const projectV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  modifiedAt: z.string(),
  board: boardProfileSchema,
  case: caseParamsSchema,
  ports: z.array(portPlacementSchema),
  externalAssets: z.array(externalAssetSchema),
});

const projectV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  modifiedAt: z.string(),
  board: boardProfileSchema,
  case: caseParamsSchema,
  ports: z.array(portPlacementSchema),
  externalAssets: z.array(externalAssetSchema),
  hats: z.array(hatPlacementSchema),
  customHats: z.array(hatProfileSchema),
});

const projectV3Schema = z.object({
  schemaVersion: z.literal(3),
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  modifiedAt: z.string(),
  board: boardProfileSchema,
  case: caseParamsSchema,
  ports: z.array(portPlacementSchema),
  externalAssets: z.array(externalAssetSchema),
  hats: z.array(hatPlacementSchema),
  customHats: z.array(hatProfileSchema),
  mountingFeatures: z.array(mountingFeatureSchema),
  display: displayPlacementSchema.nullable(),
  customDisplays: z.array(displayProfileSchema),
});

const fanMountSchema = z.object({
  id: z.string(),
  size: z.enum(['30x30x10', '40x40x10', '40x40x20', '50x50x10', '60x60x15']),
  face: z.enum(['+x', '-x', '+y', '-y', '+z', '-z']),
  position: z.object({ u: z.number(), v: z.number() }),
  grille: z.enum(['cross', 'spiral', 'honeycomb', 'concentric', 'open']),
  bladeStandoff: z.number().nonnegative(),
  bossesEnabled: z.boolean(),
  enabled: z.boolean(),
});

const textLabelSchema = z.object({
  id: z.string(),
  text: z.string(),
  font: z.enum(['sans-default', 'mono-default']),
  weight: z.enum(['regular', 'bold']),
  size: z.number().positive(),
  face: z.enum(['+x', '-x', '+y', '-y', '+z', '-z']),
  position: z.object({ u: z.number(), v: z.number() }),
  rotation: z.number(),
  depth: z.number().positive(),
  mode: z.enum(['engrave', 'emboss']),
  enabled: z.boolean(),
  attachedToPortId: z.string().optional(),
});

const projectV4Schema = z.object({
  schemaVersion: z.literal(4),
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  modifiedAt: z.string(),
  board: boardProfileSchema,
  case: caseParamsSchema,
  ports: z.array(portPlacementSchema),
  externalAssets: z.array(externalAssetSchema),
  hats: z.array(hatPlacementSchema),
  customHats: z.array(hatProfileSchema),
  mountingFeatures: z.array(mountingFeatureSchema),
  display: displayPlacementSchema.nullable(),
  customDisplays: z.array(displayProfileSchema),
  fanMounts: z.array(fanMountSchema),
  textLabels: z.array(textLabelSchema),
});

const antennaPlacementSchema = z.object({
  id: z.string(),
  type: z.enum(['internal', 'rpi-external', 'external-mount']),
  enabled: z.boolean(),
  facing: z.enum(['+x', '-x', '+y', '-y']).optional(),
  uOffset: z.number().optional(),
});

const projectV5Schema = z.object({
  schemaVersion: z.literal(5),
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  modifiedAt: z.string(),
  board: boardProfileSchema,
  case: caseParamsSchema,
  ports: z.array(portPlacementSchema),
  externalAssets: z.array(externalAssetSchema),
  hats: z.array(hatPlacementSchema),
  customHats: z.array(hatProfileSchema),
  mountingFeatures: z.array(mountingFeatureSchema),
  display: displayPlacementSchema.nullable(),
  customDisplays: z.array(displayProfileSchema),
  fanMounts: z.array(fanMountSchema),
  textLabels: z.array(textLabelSchema),
  antennas: z.array(antennaPlacementSchema),
});

// Issue #80 — v6 differs from v5 only in that mountingFeatures items now
// REQUIRE `mountClass`. The schema's .default('external') already fills
// missing values on parse, so the wire-format change is technically
// backwards-compatible; the version bump is bookkeeping for "this project
// understands the internal/external split."
const projectV6Schema = projectV5Schema.extend({
  schemaVersion: z.literal(6),
});

export const projectSchema = z
  .union([
    projectV1Schema,
    projectV2Schema,
    projectV3Schema,
    projectV4Schema,
    projectV5Schema,
    projectV6Schema,
  ])
  .transform((p) => {
    if (p.schemaVersion === 1) {
      return {
        ...p,
        schemaVersion: 6 as const,
        hats: [],
        customHats: [],
        mountingFeatures: [],
        display: null,
        customDisplays: [],
        fanMounts: [],
        textLabels: [],
        antennas: [],
      };
    }
    if (p.schemaVersion === 2) {
      return {
        ...p,
        schemaVersion: 6 as const,
        mountingFeatures: [],
        display: null,
        customDisplays: [],
        fanMounts: [],
        textLabels: [],
        antennas: [],
      };
    }
    if (p.schemaVersion === 3) {
      return {
        ...p,
        schemaVersion: 6 as const,
        fanMounts: [],
        textLabels: [],
        antennas: [],
      };
    }
    if (p.schemaVersion === 4) {
      return {
        ...p,
        schemaVersion: 6 as const,
        antennas: [],
      };
    }
    if (p.schemaVersion === 5) {
      // mountingFeatures items already have mountClass filled by the
      // mountingFeatureSchema default at parse time; just stamp the version.
      return { ...p, schemaVersion: 6 as const };
    }
    return p;
  });

export type ProjectInput = z.infer<typeof projectSchema>;
