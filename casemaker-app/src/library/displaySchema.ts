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
  'flat-cable',
  'fan-mount',
  'text-label',
  'custom',
]);

const facingSchema = z.enum(['+x', '-x', '+y', '-y', '+z']);

const componentSchema = z.object({
  id: z.string().min(1),
  kind: componentKindSchema,
  position: xyzSchema,
  size: xyzSchema,
  facing: facingSchema.optional(),
  cutoutMargin: z.number().nonnegative().optional(),
});

export const displayProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  manufacturer: z.string().min(1),
  pcb: z.object({ size: xyzSchema }),
  activeArea: z.object({
    x: z.number().positive(),
    y: z.number().positive(),
    offsetX: z.number(),
    offsetY: z.number(),
  }),
  bezel: z.object({
    top: z.number().nonnegative(),
    right: z.number().nonnegative(),
    bottom: z.number().nonnegative(),
    left: z.number().nonnegative(),
  }),
  overallHeight: z.number().positive(),
  mounting: z.enum(['gpio-mate', 'shield', 'standalone', 'corner-screws']),
  mountingHoles: z.array(mountingHoleSchema),
  interface: z.enum(['dsi', 'hdmi', 'spi', 'i2c', 'parallel-rgb']),
  touch: z.enum(['none', 'resistive', 'capacitive-fts', 'capacitive-ipt']),
  components: z.array(componentSchema),
  compatibleBoards: z.array(z.string()),
  source: z.string().url().optional(),
  builtin: z.boolean(),
});

export const builtinDisplayProfileSchema = displayProfileSchema.refine(
  (d) => d.builtin === true && typeof d.source === 'string' && d.source.length > 0,
  { message: 'builtin display profiles must include a source URL for traceability' },
);

export type DisplayProfileInput = z.infer<typeof displayProfileSchema>;
