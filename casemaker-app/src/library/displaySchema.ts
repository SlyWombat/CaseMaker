import { z } from 'zod';

// #480 — every field carries `.describe()`; these profiles are nested in the project document,
// which is emitted as JSON Schema for the headless MCP tools.

const xyzSchema = z.object({
  x: z.number().describe('X in millimetres.'),
  y: z.number().describe('Y in millimetres.'),
  z: z.number().describe('Z in millimetres.'),
});

const mountingHoleSchema = z.object({
  id: z.string().min(1).describe('Unique id for this hole within the display.'),
  x: z.number().describe('Hole centre X, millimetres from the board origin.'),
  y: z.number().describe('Hole centre Y, millimetres from the board origin.'),
  diameter: z.number().positive().describe('Hole diameter in millimetres.'),
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
  'antenna-connector',
  'custom',
]);

const cutoutShapeSchema = z.enum(['rect', 'round']);

const facingSchema = z.enum(['+x', '-x', '+y', '-y', '+z']);

const componentSchema = z.object({
  id: z.string().min(1).describe('Unique id for this component within the display.'),
  kind: componentKindSchema.describe(
    'What the component is; this chooses the cutout profile and how the picker draws it.',
  ),
  position: xyzSchema.describe('Component origin on the display board, in millimetres.'),
  size: xyzSchema.describe('Component extents in millimetres.'),
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
});

export const displayProfileSchema = z.object({
  id: z.string().min(1).describe('Stable id for the display profile.'),
  name: z.string().min(1).describe('Human-readable display name.'),
  manufacturer: z.string().min(1).describe('Display maker.'),
  pcb: z
    .object({
      size: xyzSchema.describe('PCB extents in millimetres; Z is the board thickness.'),
    })
    .describe('The bare display PCB.'),
  activeArea: z
    .object({
      x: z.number().positive().describe('Active area width, in millimetres.'),
      y: z.number().positive().describe('Active area height, in millimetres.'),
      offsetX: z.number().describe('Active area X offset from the PCB centre, in millimetres.'),
      offsetY: z.number().describe('Active area Y offset from the PCB centre, in millimetres.'),
    })
    .describe('The lit area of the display, in millimetres.'),
  bezel: z
    .object({
      top: z.number().nonnegative().describe('Bezel width at the top, in millimetres.'),
      right: z.number().nonnegative().describe('Bezel width on the right, in millimetres.'),
      bottom: z.number().nonnegative().describe('Bezel width at the bottom, in millimetres.'),
      left: z.number().nonnegative().describe('Bezel width on the left, in millimetres.'),
    })
    .describe('Bezel widths around the active area, in millimetres.'),
  overallHeight: z
    .number()
    .positive()
    .describe('Total height of the display assembly, in millimetres.'),
  mounting: z
    .enum(['gpio-mate', 'shield', 'standalone', 'corner-screws'])
    .describe('How the display is mounted.'),
  mountingHoles: z
    .array(mountingHoleSchema)
    .describe('Mounting holes on the display; may be empty.'),
  interface: z
    .enum(['dsi', 'hdmi', 'spi', 'i2c', 'parallel-rgb'])
    .describe('Electrical interface the display uses.'),
  touch: z
    .enum(['none', 'resistive', 'capacitive-fts', 'capacitive-ipt'])
    .describe('Touch technology, or none.'),
  components: z
    .array(componentSchema)
    .describe('Components on the display board that need a cutout or opening.'),
  compatibleBoards: z
    .array(z.string())
    .describe('Ids of the main boards this display can be paired with.'),
  source: z.string().url().optional().describe('URL the display dimensions were taken from.'),
  builtin: z.boolean().describe('True for a profile bundled with the app.'),
});

export const builtinDisplayProfileSchema = displayProfileSchema.refine(
  (d) => d.builtin === true && typeof d.source === 'string' && d.source.length > 0,
  { message: 'builtin display profiles must include a source URL for traceability' },
);

export type DisplayProfileInput = z.infer<typeof displayProfileSchema>;
