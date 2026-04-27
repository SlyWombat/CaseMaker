import { z } from 'zod';
import { boardProfileSchema } from '@/library/schema';
import { hatProfileSchema } from '@/library/hatSchema';

const xyzSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

const caseParamsSchema = z.object({
  wallThickness: z.number().positive(),
  floorThickness: z.number().positive(),
  lidThickness: z.number().positive(),
  cornerRadius: z.number().nonnegative(),
  internalClearance: z.number().nonnegative(),
  zClearance: z.number().nonnegative(),
  joint: z.enum(['snap-fit', 'sliding', 'screw-down', 'flat-lid']),
  ventilation: z.object({
    enabled: z.boolean(),
    pattern: z.enum(['none', 'slots', 'hex']),
    coverage: z.number().min(0).max(1),
  }),
  bosses: z.object({
    enabled: z.boolean(),
    insertType: z.enum(['self-tap', 'heat-set-m2.5', 'heat-set-m3', 'pass-through']),
    outerDiameter: z.number().positive(),
    holeDiameter: z.number().positive(),
  }),
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
    'custom',
  ]),
  position: xyzSchema,
  size: xyzSchema,
  facing: z.enum(['+x', '-x', '+y', '-y', '+z']),
  cutoutMargin: z.number().nonnegative(),
  locked: z.boolean(),
  enabled: z.boolean(),
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
  ports: z.array(portPlacementSchema),
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

export const projectSchema = z.union([projectV1Schema, projectV2Schema]).transform((p) => {
  if (p.schemaVersion === 1) {
    return {
      ...p,
      schemaVersion: 2 as const,
      hats: [],
      customHats: [],
    };
  }
  return p;
});

export type ProjectInput = z.infer<typeof projectSchema>;
