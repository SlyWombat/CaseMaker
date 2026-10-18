import { z } from 'zod';

// #480 — every field carries `.describe()`; these profiles are nested in the project document,
// which is emitted as JSON Schema for the headless MCP tools.

const xyzSchema = z.object({
  x: z.number().describe('X in millimetres.'),
  y: z.number().describe('Y in millimetres.'),
  z: z.number().describe('Z in millimetres.'),
});

const mountingHoleSchema = z.object({
  id: z.string().min(1).describe('Unique id for this hole within the HAT.'),
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
  id: z.string().min(1).describe('Unique id for this component within the HAT.'),
  kind: componentKindSchema.describe(
    'What the component is; this chooses the cutout profile and how the picker draws it.',
  ),
  position: xyzSchema.describe('Component origin on the HAT, in millimetres.'),
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
});

const mountingPositionSchema = z.object({
  id: z.string().min(1).describe('Unique id for this mounting position.'),
  label: z.string().min(1).describe('Label shown in the placement picker.'),
  offset: z
    .object({
      x: z.number().describe('X offset from the board centre, in millimetres.'),
      y: z.number().describe('Y offset from the board centre, in millimetres.'),
    })
    .describe('Where the HAT sits relative to the main board, in millimetres.'),
  rotation: z
    .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
    .describe('Rotation of the HAT on the board, in degrees.'),
});

export const hatProfileSchema = z.object({
  id: z.string().min(1).describe('Stable id for the HAT profile.'),
  name: z.string().min(1).describe('Human-readable HAT name.'),
  manufacturer: z.string().min(1).describe('HAT maker.'),
  pcb: z
    .object({
      size: xyzSchema
        .refine((s) => s.x > 0 && s.y > 0 && s.z > 0, {
          message: 'pcb size must be positive on all axes',
        })
        .describe('PCB extents in millimetres; Z is the board thickness.'),
    })
    .describe('The bare HAT PCB.'),
  mountingHoles: z
    .array(mountingHoleSchema)
    .describe('Mounting holes on the HAT; may be empty.'),
  headerHeight: z
    .number()
    .positive()
    .describe('Height of the stacking header between boards, in millimetres.'),
  components: z
    .array(componentSchema)
    .describe('Components on the HAT that need a cutout, opening or label.'),
  compatibleBoards: z
    .array(z.string())
    .describe("Ids of the main boards this HAT's mounting positions are defined against."),
  mountingPositions: z
    .array(mountingPositionSchema)
    .optional()
    .describe('Named placements on a compatible board; omit when the HAT has none.'),
  source: z.string().url().optional().describe('URL the HAT dimensions were taken from.'),
  builtin: z.boolean().describe('True for a profile bundled with the app.'),
});

export const builtinHatProfileSchema = hatProfileSchema.refine(
  (h) => h.builtin === true && typeof h.source === 'string' && h.source.length > 0,
  { message: 'builtin hat profiles must include a source URL for traceability' },
);

export type HatProfileInput = z.infer<typeof hatProfileSchema>;
