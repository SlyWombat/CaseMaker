/**
 * The arguments every MCP tool accepts (#481), as Zod documents.
 *
 * These ARE the contract: the server advertises each one as `inputSchema` (JSON Schema, through
 * #480's representation) and validates the call with the same object before any engine code runs,
 * so a client's typo is a named field in an `isError` result rather than an exception mid-pipeline.
 *
 * A document can be handed inline (the mode the schemas exist for) or named by path. Exactly one
 * form per call; the refinement that enforces that is Zod-side, because JSON Schema cannot state
 * "one of these two" without also admitting the empty object.
 */
import { z } from 'zod';

import { engraveJobDocumentSchema } from '@/store/engraveJobSchema';
import { projectDocumentSchema } from '@/store/projectSchema';

/** Whether exactly one of two alternative fields is present. */
function exactlyOne(a: unknown, b: unknown): boolean {
  return (a === undefined) !== (b === undefined);
}

const EXACTLY_ONE_PROJECT = { message: 'give exactly one of `project` and `projectPath`' } as const;
const EXACTLY_ONE_JOB = { message: 'give exactly one of `job` and `jobPath`' } as const;

/** A project: inline as the app saves it, or a `.caseproj.json` the server reads. */
export const projectSourceSchema = z
  .object({
    project: projectDocumentSchema.optional().describe('The project document itself.'),
    projectPath: z
      .string()
      .min(1)
      .optional()
      .describe('Path to a project document the server reads instead of an inline one.'),
  })
  .refine((v) => exactlyOne(v.project, v.projectPath), EXACTLY_ONE_PROJECT)
  .describe('A project document, inline or by path.');

/** An engrave job: inline as a job document, or a `.job.json` path. */
export const jobSourceSchema = z
  .object({
    job: engraveJobDocumentSchema.optional().describe('The engrave job document itself.'),
    jobPath: z
      .string()
      .min(1)
      .optional()
      .describe('Path to a job document the server reads instead of an inline one.'),
  })
  .describe('An engrave job document, inline or by path.');

/** Where a tool writes, and which machine document the run resolves against. */
const destination = {
  outDir: z
    .string()
    .min(1)
    .optional()
    .describe('Directory to write into; a fresh directory under the system temp is used when omitted.'),
  location: z
    .string()
    .min(1)
    .optional()
    .describe('A location.json or house.json to resolve cutters against, by path.'),
};

export const listBoardsInput = z.strictObject({}).describe('No arguments.');

export const listTemplatesInput = z.strictObject({}).describe('No arguments.');

export const describeBoardInput = z
  .strictObject({
    boardId: z.string().min(1).describe('The board id, as `list_boards` reports it.'),
  })
  .describe('Describe one board.');

export const newProjectInput = z
  .strictObject({
    boardId: z
      .string()
      .min(1)
      .optional()
      .describe('Board to build the case around; the default board when omitted.'),
    templateId: z
      .string()
      .min(1)
      .optional()
      .describe('Template to build; when given, `boardId` is the template’s own board if it has one.'),
    outDir: destination.outDir,
  })
  .describe('Create a project document.');

export const patchCaseInput = z
  .strictObject({
    ...projectSourceSchema.shape,
    patch: z
      .record(z.string(), z.unknown())
      .describe('Case parameters to change, as the app’s `patchCase` accepts them (top-level partial).'),
    outDir: destination.outDir,
  })
  .refine((v) => exactlyOne(v.project, v.projectPath), EXACTLY_ONE_PROJECT)
  .describe('Change a project’s case parameters through `applyCasePatch`.');

export const compileProjectInput = z
  .strictObject({ ...projectSourceSchema.shape })
  .refine((v) => exactlyOne(v.project, v.projectPath), EXACTLY_ONE_PROJECT)
  .describe('Compile a project into its build plan.');

export const exportPartsInput = z
  .strictObject({ ...projectSourceSchema.shape, ...destination })
  .refine((v) => exactlyOne(v.project, v.projectPath), EXACTLY_ONE_PROJECT)
  .describe('Export a project’s parts as one print-ready STL with its PRINT-NOTES sidecar.');

export const generateProgramInput = z
  .strictObject({
    ...jobSourceSchema.shape,
    designPath: z
      .string()
      .min(1)
      .optional()
      .describe('A PrusaSlicer PROJECT .3mf to cut as a design instead of a job document.'),
    ...destination,
  })
  .refine(
    (v) =>
      exactlyOne(v.job, v.jobPath) &&
      !(v.designPath !== undefined && (v.job !== undefined || v.jobPath !== undefined)),
    { message: 'give exactly one of `job`, `jobPath` and `designPath`' },
  )
  .describe('Build a job’s program: generate, verify, simulate, write the .nc and the run sheet.');

export const runSheetInput = z
  .strictObject({ ...jobSourceSchema.shape, ...destination })
  .refine((v) => exactlyOne(v.job, v.jobPath), EXACTLY_ONE_JOB)
  .describe('Build a job and return its run sheet as Markdown alongside the receipt.');

export const readLocationInput = z
  .strictObject({
    section: z
      .enum(['tools', 'stock', 'machines'])
      .describe('Which section of the machine’s document to read.'),
    location: destination.location,
  })
  .describe('Read the machine’s own document: its tools, stock or machines.');

export type ListBoardsInput = z.infer<typeof listBoardsInput>;
export type DescribeBoardInput = z.infer<typeof describeBoardInput>;
export type NewProjectInput = z.infer<typeof newProjectInput>;
export type PatchCaseInput = z.infer<typeof patchCaseInput>;
export type CompileProjectInput = z.infer<typeof compileProjectInput>;
export type ExportPartsInput = z.infer<typeof exportPartsInput>;
export type GenerateProgramInput = z.infer<typeof generateProgramInput>;
export type RunSheetInput = z.infer<typeof runSheetInput>;
export type ReadLocationInput = z.infer<typeof readLocationInput>;
