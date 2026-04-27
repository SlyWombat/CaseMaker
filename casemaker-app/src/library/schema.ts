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

const facingSchema = z.enum(['+x', '-x', '+y', '-y', '+z']);

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
});

export const boardProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  manufacturer: z.string().min(1),
  pcb: z.object({
    size: xyzSchema.refine((s) => s.x > 0 && s.y > 0 && s.z > 0, {
      message: 'pcb size must be positive on all axes',
    }),
  }),
  mountingHoles: z.array(mountingHoleSchema).min(1),
  components: z.array(componentSchema),
  defaultStandoffHeight: z.number().nonnegative(),
  recommendedZClearance: z.number().nonnegative(),
  source: z.string().url().optional(),
  crossReference: z.string().url().optional(),
  datasheetRevision: z.string().optional(),
  measurementMethod: z.enum(['datasheet', 'open-source-cad', 'physical-measurement']).optional(),
  visualAssets: z
    .object({
      glb: z.string().optional(),
      topImage: z.string().optional(),
      sideImage: z.string().optional(),
      license: z.string().optional(),
      sourceUrl: z.string().url().optional(),
    })
    .optional(),
  builtin: z.boolean(),
});

export const builtinBoardProfileSchema = boardProfileSchema.refine(
  (b) => b.builtin === true && typeof b.source === 'string' && b.source.length > 0,
  { message: 'builtin boards must include a source URL for traceability' },
);

export type BoardProfileInput = z.infer<typeof boardProfileSchema>;
