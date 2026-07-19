import { z } from 'zod';
import { caseParamsSchema } from '@/store/projectSchema';

/**
 * Declarative project-template format (#126). A template spec is pure data:
 * pick a host board (or synthesize an empty interior), patch the case, add
 * HATs / a display, choose the port policy. The interpreter
 * (buildFromSpec.ts) routes the case patch through the same auto-population
 * logic as the interactive patchCase path, so specs can't hit the
 * "template bypassed patchCase" bug class (#35/#62/#29).
 *
 * Templates that COMPUTE geometry from other values (the protective case's
 * wall-tangent-scaled hinge/latches) stay as code in index.ts — the spec
 * format deliberately has no expression language.
 */

const templateHatSchema = z.object({
  hatId: z.string().min(1),
  stackIndex: z.number().int().nonnegative().optional(),
  /** Stable placement id; defaults to tpl-hat-<templateId>-<index>. */
  placementId: z.string().min(1).optional(),
});

const templateDisplaySchema = z.object({
  displayId: z.string().min(1),
  framing: z.enum([
    'top-window',
    'recessed-bezel',
    'flush-glass',
    'hood-shade',
    'tilted',
    'removable-cap',
    'bracket-only',
  ]),
  offset: z.object({ x: z.number(), y: z.number() }).optional(),
  hostSupport: z.enum(['gpio-only', 'case-rim-bracket', 'under-board-posts', 'full-cradle']),
});

export const templateSpecSchema = z.object({
  /** Template-format version; absent = 1. */
  schemaVersion: z.number().int().positive().optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  estPrintMinutes: z.number().positive(),
  /** Sort key — TEMPLATES is ordered by this (list order is the contract:
   * findTemplateByBoard picks the first match; templates.spec.ts pins it). */
  order: z.number(),
  /** Host board id (any registry source). Omit when emptyBoard is set. */
  boardId: z.string().min(1).optional(),
  /** Synthesize a bare interior instead of a real host board (large-box). */
  emptyBoard: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      x: z.number().positive(),
      y: z.number().positive(),
    })
    .optional(),
  /** Project name after creation; defaults to the template name. */
  projectName: z.string().min(1).optional(),
  /** Top-level-partial case patch. Nested objects (ventilation, bosses,
   * stand, …) must be complete values — same contract as patchCase. */
  casePatch: caseParamsSchema.partial().optional(),
  hats: z.array(templateHatSchema).optional(),
  display: templateDisplaySchema.optional(),
  /** 'auto' (default): keep the ports createDefaultProject derived from the
   * board's components. 'none': start with no port cutouts (stand/box). */
  ports: z.enum(['auto', 'none']).optional(),
});

export type TemplateSpec = z.infer<typeof templateSpecSchema>;
