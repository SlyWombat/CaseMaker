import { z } from 'zod';

const xyzSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

const mountingHoleSchema = z.object({
  id: z.string().min(1),
  x: z.number(),
  y: z.number(),
  diameter: z.number().positive(),
});

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
  'custom',
]);

const facingSchema = z.enum(['+x', '-x', '+y', '-y', '+z']);

const componentSchema = z.object({
  id: z.string().min(1),
  kind: componentKindSchema,
  position: xyzSchema,
  size: xyzSchema.refine((s) => s.x > 0 && s.y > 0 && s.z > 0, {
    message: 'component size must be positive on all axes',
  }),
  facing: facingSchema.optional(),
  cutoutMargin: z.number().nonnegative().optional(),
});

export const hatProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  manufacturer: z.string().min(1),
  pcb: z.object({
    size: xyzSchema.refine((s) => s.x > 0 && s.y > 0 && s.z > 0, {
      message: 'pcb size must be positive on all axes',
    }),
  }),
  mountingHoles: z.array(mountingHoleSchema),
  headerHeight: z.number().positive(),
  components: z.array(componentSchema),
  compatibleBoards: z.array(z.string()),
  source: z.string().url().optional(),
  builtin: z.boolean(),
});

export const builtinHatProfileSchema = hatProfileSchema.refine(
  (h) => h.builtin === true && typeof h.source === 'string' && h.source.length > 0,
  { message: 'builtin hat profiles must include a source URL for traceability' },
);

export type HatProfileInput = z.infer<typeof hatProfileSchema>;
