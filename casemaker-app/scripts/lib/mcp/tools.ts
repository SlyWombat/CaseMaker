/**
 * The MCP tool surface (#481): what the server offers, and what each call does.
 *
 * Two kinds of tool, one contract — every call returns the tier-1 receipt:
 *
 *  - the four that RUN a command of the CLI (`export_parts`, `generate_program`, `run_sheet`,
 *    `read_location`) capture that command's own receipt through `CommandSink` (#478), so the MCP
 *    and the terminal cannot disagree about what happened;
 *  - the six that run no command (`list_boards`, `list_templates`, `describe_board`,
 *    `new_project`, `patch_case`, `compile_project`) return the receipt's `mcp` variant.
 *
 * NOTHING here touches the machine. `machine_status` is deliberately absent, along with upload,
 * play, probe, power and `$H`: those await the physical-actions decision (#479), and a server that
 * does not name them cannot call them.
 *
 * Arguments are validated with the same Zod document that is advertised as `inputSchema`, before
 * any engine code runs; a bad argument is an `isError` result naming the field.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { compileProject } from '../../../src/engine/compiler/ProjectCompiler';
import { getBoard, listBoards } from '../../../src/library/registry';
import { findTemplateAcrossSources, listTemplates } from '../../../src/library/templateRegistry';
import { jsonSchemaOf } from '../../../src/platform/headless/mcpSchemas';
import { patchProject } from '../../../src/platform/headless/patch';
import {
  RECEIPT_VERSION,
  renderReceipt,
  type Receipt,
  type ReceiptMcpTool,
  type ReceiptRefusal,
} from '../../../src/platform/headless/receipt';
import { parseProject, serializeProject } from '../../../src/store/projectFile';
import { createDefaultProject } from '../../../src/store/projectStore';
import type { Project } from '../../../src/types';
import { engraveJobMain } from '../casemaker/engrave';
import { exportMain } from '../casemaker/exportCommand';
import { locationMain } from '../casemaker/locationCommand';
import type { CommandSink } from '../casemaker/output';
import { fileReceipt } from '../casemaker/receiptFiles';
import {
  compileProjectInput,
  describeBoardInput,
  exportPartsInput,
  generateProgramInput,
  listBoardsInput,
  listTemplatesInput,
  newProjectInput,
  patchCaseInput,
  readLocationInput,
  runSheetInput,
} from './toolInputs';

export const TOOL_NAMES = [
  'list_boards',
  'list_templates',
  'describe_board',
  'new_project',
  'patch_case',
  'compile_project',
  'export_parts',
  'generate_program',
  'run_sheet',
  'read_location',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** The Zod document each tool's arguments are validated against. */
const TOOL_INPUTS: Record<ToolName, z.ZodType> = {
  list_boards: listBoardsInput,
  list_templates: listTemplatesInput,
  describe_board: describeBoardInput,
  new_project: newProjectInput,
  patch_case: patchCaseInput,
  compile_project: compileProjectInput,
  export_parts: exportPartsInput,
  generate_program: generateProgramInput,
  run_sheet: runSheetInput,
  read_location: readLocationInput,
};

/** One tool as `tools/list` reports it. */
export interface ToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TITLES: Record<ToolName, { title: string; description: string }> = {
  list_boards: {
    title: 'List boards',
    description: 'Every board profile this build can resolve, with its size and where it came from.',
  },
  list_templates: {
    title: 'List templates',
    description: 'Every project template, with the board it is the curated recipe for.',
  },
  describe_board: {
    title: 'Describe board',
    description: 'One board profile in full: size, mounting holes and components.',
  },
  new_project: {
    title: 'New project',
    description:
      'Build a project from a board or a template and write it as a project document. A template’s own board wins over `boardId`.',
  },
  patch_case: {
    title: 'Patch case',
    description:
      'Change case parameters through `applyCasePatch` (never a raw mutation), so auto-populated fields such as snap catches follow. A rejected patch changes nothing.',
  },
  compile_project: {
    title: 'Compile project',
    description: 'Compile a project into its build plan: the node ids and the placement report.',
  },
  export_parts: {
    title: 'Export parts',
    description:
      'Lay the compiled parts out print-ready and write one binary STL with its PRINT-NOTES sidecar.',
  },
  generate_program: {
    title: 'Generate program',
    description:
      'Generate, verify and simulate a job or a 3MF design, then write the .nc, the frame and the run sheet. Returns the engrave receipt with the stage and gate reached.',
  },
  run_sheet: {
    title: 'Run sheet',
    description:
      'Build a job like `generate_program` and return its run sheet as Markdown, alongside the receipt.',
  },
  read_location: {
    title: 'Read location',
    description: 'Read the machine’s own document: its tools, its stock shelf, its machines or its accessories.',
  },
};

/** `tools/list`'s payload. Built once: the schemas are static. */
export const TOOL_DEFINITIONS: ToolDefinition[] = TOOL_NAMES.map((name) => ({
  name,
  title: TITLES[name].title,
  description: TITLES[name].description,
  inputSchema: jsonSchemaOf(TOOL_INPUTS[name]),
}));

/** What one call returns. `structuredContent.receipt` is the tier-1 receipt, always. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: { receipt: Receipt; data: unknown };
  isError?: boolean;
}

/** A refusal with no engine behind it: a missing board, a document that will not parse. */
class ToolRefusal extends Error {}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** A directory the tool writes into: the caller's, or a fresh one under the system temp. */
function outDirFor(outDir: string | undefined): string {
  if (outDir !== undefined) {
    mkdirSync(outDir, { recursive: true });
    return outDir;
  }
  return mkdtempSync(join(tmpdir(), 'casemaker-mcp-'));
}

/** A file stem from a project's own name, as the app's save path derives it. */
function stemFor(name: string): string {
  const safe = name.replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '');
  return safe === '' ? 'project' : safe;
}

function readProject(source: { project?: unknown; projectPath?: string }): Project {
  if (source.projectPath !== undefined) {
    let text: string;
    try {
      text = readFileSync(source.projectPath, 'utf8');
    } catch (e) {
      throw new ToolRefusal(`cannot read ${source.projectPath}: ${(e as Error).message}`);
    }
    try {
      return parseProject(text);
    } catch (e) {
      throw new ToolRefusal(`${source.projectPath} is not a valid project: ${(e as Error).message}`);
    }
  }
  try {
    return parseProject(JSON.stringify(source.project));
  } catch (e) {
    throw new ToolRefusal(`the project document is not valid: ${(e as Error).message}`);
  }
}

function writeProjectDocument(project: Project, outDir: string): string {
  const path = join(outDir, `${stemFor(project.name)}.caseproj.json`);
  writeFileSync(path, serializeProject(project));
  return path;
}

/** The `mcp` receipt for a tool that ran no command. */
function mcpReceipt(
  tool: ReceiptMcpTool,
  parts: {
    ok: boolean;
    stage: string | null;
    document?: string | null;
    items?: string[];
    outputs?: ReturnType<typeof fileReceipt>[];
    refusals?: ReceiptRefusal[];
  },
): Receipt {
  return {
    version: RECEIPT_VERSION,
    command: 'mcp',
    ok: parts.ok,
    stage: parts.stage,
    gate: null,
    inputs: [],
    outputs: parts.outputs ?? [],
    diagnostics: [],
    provenance: [],
    refusals: parts.refusals ?? [],
    details: {
      tool,
      document: parts.document ?? null,
      items: parts.items ?? [],
    },
  };
}

/** The result of a call that produced a receipt: its rendered lines and the receipt itself. */
function result(receipt: Receipt, data: unknown, failed = false): ToolResult {
  return {
    content: [{ type: 'text', text: renderReceipt(receipt).join('\n') }],
    structuredContent: { receipt, data },
    ...(failed || !receipt.ok ? { isError: true } : null),
  };
}

/** The result of a call that never reached a receipt: a named refusal, no document. */
function refused(reason: string): ToolResult {
  return { content: [{ type: 'text', text: reason }], isError: true };
}

/** Run a command function with its two channels captured instead of printed. */
async function capture(
  run: (options: { json: boolean; sink: CommandSink }) => Promise<number>,
): Promise<{ code: number; receipts: Receipt[]; progress: string[] }> {
  const receipts: Receipt[] = [];
  const progress: string[] = [];
  const code = await run({
    json: true,
    sink: {
      progress: (line) => progress.push(line),
      receipt: (receipt) => receipts.push(receipt),
    },
  });
  return { code, receipts, progress };
}

/** The arguments of a destination-bearing call, as the command's flags. */
function locationFlags(location: string | undefined): string[] {
  return location === undefined ? [] : ['--location', location];
}

// ---------------------------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------------------------

async function call(name: ToolName, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'list_boards': {
      const boards = listBoards().map(({ board, origin }) => ({
        id: board.id,
        name: board.name,
        manufacturer: board.manufacturer,
        size: board.pcb.size,
        origin: origin.kind,
      }));
      const receipt = mcpReceipt('list_boards', {
        ok: true,
        stage: 'read',
        items: boards.map((b) => b.id),
      });
      return result(receipt, boards);
    }

    case 'list_templates': {
      const templates = listTemplates().map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        estPrintMinutes: t.estPrintMinutes,
        boardId: t.boardId ?? null,
        sourceLabel: t.sourceLabel ?? null,
      }));
      const receipt = mcpReceipt('list_templates', {
        ok: true,
        stage: 'read',
        items: templates.map((t) => t.id),
      });
      return result(receipt, templates);
    }

    case 'describe_board': {
      const board = getBoard(String(args['boardId']));
      if (board === undefined) throw new ToolRefusal(`unknown board "${String(args['boardId'])}"`);
      const receipt = mcpReceipt('describe_board', {
        ok: true,
        stage: 'read',
        items: [board.id],
      });
      return result(receipt, board);
    }

    case 'new_project': {
      const templateId = args['templateId'] as string | undefined;
      const template = templateId === undefined ? undefined : findTemplateAcrossSources(templateId);
      if (templateId !== undefined && template === undefined) {
        throw new ToolRefusal(`unknown template "${templateId}"`);
      }
      const project =
        template !== undefined
          ? template.build()
          : createDefaultProject(args['boardId'] as string | undefined);
      const outDir = outDirFor(args['outDir'] as string | undefined);
      const document = writeProjectDocument(project, outDir);
      return result(
        mcpReceipt('new_project', {
          ok: true,
          stage: 'written',
          document,
          items: [project.id],
          outputs: [fileReceipt(document)],
        }),
        { project, document },
      );
    }

    case 'patch_case': {
      const project = readProject(args as { project?: unknown; projectPath?: string });
      const patch = patchProject(project, args['patch']);
      if (!patch.ok) {
        return result(
          mcpReceipt('patch_case', {
            ok: false,
            stage: 'validated',
            items: patch.issues.map((i) => `${i.path}: ${i.message}`),
            refusals: [{ code: 'patch-refused', reason: patch.reason }],
          }),
          patch,
          true,
        );
      }
      const outDir = outDirFor(args['outDir'] as string | undefined);
      const document = writeProjectDocument(patch.project, outDir);
      return result(
        mcpReceipt('patch_case', {
          ok: true,
          stage: 'written',
          document,
          items: Object.keys(args['patch'] as Record<string, unknown>),
          outputs: [fileReceipt(document)],
        }),
        { project: patch.project, document },
      );
    }

    case 'compile_project': {
      const project = readProject(args as { project?: unknown; projectPath?: string });
      const plan = compileProject(project);
      const nodes = plan.nodes.map((n) => ({ id: n.id, kind: n.op.kind }));
      return result(
        mcpReceipt('compile_project', { ok: true, stage: 'compiled', items: nodes.map((n) => n.id) }),
        {
          projectId: project.id,
          nodes,
          placement: plan.placementReport ?? null,
          splitOffer: plan.splitOffer ?? null,
          smartCutoutDecisions: plan.smartCutoutDecisions ?? null,
        },
      );
    }

    case 'export_parts': {
      const project = readProject(args as { project?: unknown; projectPath?: string });
      const outDir = outDirFor(args['outDir'] as string | undefined);
      // An inline document is written beside the export so the receipt's input is a real file
      // with a hash, rather than a path that does not exist.
      const projectPath =
        (args['projectPath'] as string | undefined) ?? writeProjectDocument(project, outDir);
      const run = await capture((options) =>
        exportMain(
          [projectPath, '--out', outDir, ...locationFlags(args['location'] as string | undefined)],
          options,
        ),
      );
      if (run.receipts.length === 0) {
        return refused(`export did not reach a receipt:\n${run.progress.join('\n')}`);
      }
      return result(run.receipts[0]!, { outDir, projectPath }, run.code !== 0);
    }

    case 'generate_program':
    case 'run_sheet': {
      const o = args as {
        job?: { name?: string };
        jobPath?: string;
        designPath?: string;
        outDir?: string;
        location?: string;
      };
      const outDir = outDirFor(o.outDir);
      let input: string[];
      if (o.designPath !== undefined) {
        input = ['--from-3mf', o.designPath];
      } else if (o.jobPath !== undefined) {
        input = [o.jobPath];
      } else {
        const stem = stemFor(o.job?.name ?? 'job');
        const jobPath = join(outDir, `${stem}.job.json`);
        writeFileSync(jobPath, JSON.stringify(o.job, null, 2) + '\n');
        input = [jobPath];
      }
      const run = await capture((options) =>
        engraveJobMain([...input, '--out', outDir, ...locationFlags(o.location)], options),
      );
      if (run.receipts.length === 0) {
        return refused(`engrave did not reach a receipt:\n${[...run.progress].join('\n')}`);
      }
      const receipt = run.receipts[0]!;
      if (name === 'generate_program' || receipt.command !== 'engrave') {
        return result(receipt, { outDir }, run.code !== 0);
      }
      // `run_sheet`: the generation already wrote the sheets; return their text beside the receipt.
      const sheets = receipt.details.programs.flatMap((program) => {
        if (program.sheet === null) return [];
        const file = join(receipt.details.outDir, program.sheet.file);
        try {
          return [{ file, markdown: readFileSync(file, 'utf8') }];
        } catch {
          return [];
        }
      });
      return result(receipt, { outDir: receipt.details.outDir, sheets }, run.code !== 0);
    }

    case 'read_location': {
      const section = String(args['section']);
      const run = await capture((options) =>
        locationMain([section, ...locationFlags(args['location'] as string | undefined)], options),
      );
      if (run.receipts.length === 0) {
        return refused(`location did not reach a receipt:\n${[...run.progress].join('\n')}`);
      }
      return result(run.receipts[0]!, { section }, run.code !== 0);
    }
  }
}

/**
 * Validate and run one tool call. The returned object is what `tools/call` reports: the receipt as
 * `structuredContent`, its rendered lines as text, and `isError` when the run stopped.
 */
export async function callTool(name: string, args: unknown): Promise<ToolResult> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) {
    return refused(`unknown tool "${name}"`);
  }
  const tool = name as ToolName;
  const parsed = TOOL_INPUTS[tool].safeParse(args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return refused(`${tool}: invalid arguments — ${detail}`);
  }
  try {
    return await call(tool, parsed.data as Record<string, unknown>);
  } catch (e) {
    if (e instanceof ToolRefusal) return refused(e.message);
    throw e;
  }
}
