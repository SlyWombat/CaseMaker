// #481 — the MCP server's tool surface. Two layers, because they fail differently:
//
//  - `callTool` is a plain function, and every case here holds the contract the issue states:
//    the ten named tools, argument errors that name the field, and a tier-1 receipt from every
//    call — the command's own receipt where a CLI command ran, the `mcp` variant where none did.
//  - the spawned server proves the TRANSPORT, not a claim about it: a real client initialises,
//    lists the tools and calls one over stdio. A stray `console.log` would fail that case.
//
// The generate/run-sheet cases use the committed bench job (`docs/bench/single-barrel.job.json`),
// the same document the engrave specs use; its tool is inline, so no machine document is read.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { resetRegistry } from '@/engine/cnc/toolRegistry';
import { RECEIPT_MCP_TOOLS, parseReceipt, type Receipt } from '@/platform/headless/receipt';
import { parseProject } from '@/store/persistence';
import { callTool, TOOL_DEFINITIONS, TOOL_NAMES, type ToolResult } from '../../scripts/lib/mcp/tools';
import { SERVER_NAME } from '../../scripts/lib/mcp/server';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const ROOT = join(APP, '..');
const JOB = join(ROOT, 'docs', 'bench', 'single-barrel.job.json');
const LOCATION = join(HERE, 'fixtures', 'location-doc.json');
const ABSENT_LOCATION = join(tmpdir(), 'casemaker-mcp-no-such-location.json');

const scratch = mkdtempSync(join(tmpdir(), 'casemaker-mcp-spec-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => resetRegistry());

/** The receipt a call returned, validated the way every consumer validates it. */
function receiptOf(result: ToolResult): Receipt {
  expect(result.structuredContent, 'a tool that reached a receipt carries it').toBeDefined();
  return parseReceipt(result.structuredContent!.receipt);
}

/** The structured data beside the receipt. */
function dataOf<T>(result: ToolResult): T {
  expect(result.isError ?? false).toBe(false);
  return result.structuredContent!.data as T;
}

/** Narrow a receipt to the `mcp` variant, failing the case rather than casting. */
function mcpDetails(receipt: Receipt): { tool: string; document: string | null; items: string[] } {
  if (receipt.command !== 'mcp') throw new Error(`expected an mcp receipt, got ${receipt.command}`);
  return receipt.details;
}

/** A project document written by `new_project`, for the tools that take a project. */
async function freshProject(label: string): Promise<string> {
  const out = await callTool('new_project', { boardId: 'rpi-4b', outDir: join(scratch, label) });
  const data = dataOf<{ document: string }>(out);
  expect(existsSync(data.document)).toBe(true);
  return data.document;
}

describe('#481 the advertised surface', () => {
  it('exposes exactly the ten tools, and never a machine action', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual([...TOOL_NAMES]);
    expect(new Set(names).size).toBe(10);

    // #481 excludes the physical actions by NAME: a server that does not name them cannot call
    // them. `machine_status` is #479's, not this server's.
    expect(names).not.toContain('machine_status');
    for (const forbidden of ['upload', 'play', 'probe', 'power']) {
      expect(names.filter((n) => n.includes(forbidden))).toEqual([]);
    }
  });

  it('advertises an object schema and a description for every tool', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema['type'], tool.name).toBe('object');
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      expect(tool.title.length, tool.name).toBeGreaterThan(0);
    }
  });

  it('names the bad field and runs nothing when arguments do not validate', async () => {
    const missing = await callTool('describe_board', {});
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toBeUndefined();
    expect(missing.content[0]!.text).toContain('boardId');

    const absent = await callTool('compile_project', {});
    expect(absent.isError).toBe(true);
    expect(absent.content[0]!.text).toContain('projectPath');

    // A tool that takes no arguments refuses one rather than ignoring it.
    const extra = await callTool('list_boards', { machine: 'on' });
    expect(extra.isError).toBe(true);
    expect(extra.content[0]!.text).toContain('machine');

    const unknown = await callTool('frobnicate', {});
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toContain('unknown tool');
  });
});

describe('#481 the library tools', () => {
  it('lists boards with their size and origin, and returns the mcp receipt', async () => {
    const result = await callTool('list_boards', {});
    const receipt = receiptOf(result);
    const details = mcpDetails(receipt);
    // A literal pin, not `RECEIPT_VERSION`: a bump is a wire change and must be deliberate. 3 added
    // the `machine` variant (#477).
    expect(receipt.version).toBe(3);
    expect(receipt.ok).toBe(true);
    expect(details.tool).toBe('list_boards');

    const boards = dataOf<Array<{ id: string; size: unknown; origin: string }>>(result);
    expect(boards.map((b) => b.id)).toContain('rpi-4b');
    expect(details.items).toEqual(boards.map((b) => b.id));
    for (const board of boards) {
      expect(board.size).toBeDefined();
      expect(typeof board.origin).toBe('string');
    }
  });

  it('lists templates, and describes one board in full', async () => {
    const listed = await callTool('list_templates', {});
    const templates = dataOf<Array<{ id: string }>>(listed);
    expect(mcpDetails(receiptOf(listed)).tool).toBe('list_templates');
    expect(templates.map((t) => t.id)).toContain('protective-case');

    const described = await callTool('describe_board', { boardId: 'rpi-4b' });
    const board = dataOf<{ id: string; pcb: { size: { x: number } } }>(described);
    expect(board.id).toBe('rpi-4b');
    expect(board.pcb.size.x).toBeGreaterThan(0);
    expect(mcpDetails(receiptOf(described)).items).toEqual(['rpi-4b']);
  });

  it('refuses an unknown board by name, with no receipt to pretend a call happened', async () => {
    const result = await callTool('describe_board', { boardId: 'no-such-board' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]!.text).toContain('no-such-board');
  });
});

describe('#481 new_project and patch_case', () => {
  it('writes a project document the app can read back', async () => {
    const outDir = join(scratch, 'new-project');
    const result = await callTool('new_project', { boardId: 'rpi-4b', outDir });
    const receipt = receiptOf(result);
    const details = mcpDetails(receipt);
    expect(receipt.ok).toBe(true);
    expect(details.tool).toBe('new_project');
    expect(details.document).not.toBeNull();
    expect(receipt.outputs.map((o) => o.path)).toEqual([details.document]);

    const data = dataOf<{ project: { id: string; board: { id: string } }; document: string }>(result);
    // The project gets its own editable copy of the profile (#82), whose id names the board.
    expect(data.project.board.id).toContain('rpi-4b');
    const saved = parseProject(readFileSync(details.document!, 'utf8'));
    expect(saved.id).toBe(data.project.id);
    expect(saved.board.id).toBe(data.project.board.id);

    // Both forms at once is refused: the refinement names the two fields.
    const both = await callTool('compile_project', {
      project: JSON.parse(readFileSync(details.document!, 'utf8')),
      projectPath: details.document!,
    });
    expect(both.isError).toBe(true);
    expect(both.content[0]!.text).toContain('exactly one');
  });

  it('builds a template’s own project, and refuses an unknown template', async () => {
    const result = await callTool('new_project', {
      templateId: 'protective-case',
      outDir: join(scratch, 'template'),
    });
    const data = dataOf<{ project: { id: string; name: string } }>(result);
    expect(data.project.id.length).toBeGreaterThan(0);
    expect(data.project.name.length).toBeGreaterThan(0);

    const missing = await callTool('new_project', { templateId: 'no-such-template' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain('no-such-template');
  });

  it('applies a valid patch through applyCasePatch and writes the new document', async () => {
    const projectPath = await freshProject('patch-ok');
    const result = await callTool('patch_case', {
      projectPath,
      patch: { wallThickness: 3 },
      outDir: join(scratch, 'patch-ok-out'),
    });
    const receipt = receiptOf(result);
    expect(receipt.ok).toBe(true);
    expect(mcpDetails(receipt).items).toEqual(['wallThickness']);
    expect(receipt.outputs).toHaveLength(1);

    const saved = parseProject(readFileSync(mcpDetails(receipt).document!, 'utf8'));
    expect(saved.case.wallThickness).toBe(3);
  });

  it('refuses an invalid patch as a receipt, naming the field and changing nothing', async () => {
    const projectPath = await freshProject('patch-refused');
    const result = await callTool('patch_case', {
      projectPath,
      patch: { wallThickness: -1 },
      outDir: join(scratch, 'patch-refused-out'),
    });
    expect(result.isError).toBe(true);
    const receipt = receiptOf(result);
    expect(receipt.command).toBe('mcp');
    expect(receipt.ok).toBe(false);
    expect(receipt.stage).toBe('validated');
    expect(receipt.refusals[0]!.code).toBe('patch-refused');
    expect(mcpDetails(receipt).items.join('\n')).toContain('wallThickness');
    expect(receipt.outputs).toEqual([]);
  });
});

describe('#481 compile and export', () => {
  it('compiles a project and reports every node id and kind', async () => {
    const projectPath = await freshProject('compile');
    const result = await callTool('compile_project', { projectPath });
    const receipt = receiptOf(result);
    expect(receipt.ok).toBe(true);
    expect(mcpDetails(receipt).tool).toBe('compile_project');

    const plan = dataOf<{
      projectId: string;
      nodes: Array<{ id: string; kind: string }>;
      placement: unknown;
    }>(result);
    expect(plan.nodes.length).toBeGreaterThan(0);
    expect(mcpDetails(receipt).items).toEqual(plan.nodes.map((n) => n.id));
    expect(plan.nodes.every((n) => n.kind.length > 0)).toBe(true);
    // The placement report is what `compile` exists to show; it is present even when empty.
    expect(plan.placement).toBeDefined();
  }, 60_000);

  it('exports a project as one STL with its PRINT-NOTES sidecar, under the export receipt', async () => {
    const projectPath = await freshProject('export');
    const result = await callTool('export_parts', {
      projectPath,
      outDir: join(scratch, 'export-out'),
      location: ABSENT_LOCATION,
    });
    const receipt = receiptOf(result);
    // The command's OWN receipt, not the mcp variant: the MCP call ran `casemaker export`.
    expect(receipt.command).toBe('export');
    expect(receipt.ok).toBe(true);

    const stl = receipt.outputs.find((o) => o.path.endsWith('.stl'));
    expect(stl, 'the export writes an STL').toBeDefined();
    expect(existsSync(stl!.path)).toBe(true);
    expect(stl!.bytes).toBeGreaterThan(84); // a non-empty binary STL header + triangles
    expect(receipt.outputs.some((o) => o.path.endsWith('PRINT-NOTES.txt'))).toBe(true);
    if (receipt.command === 'export') expect(receipt.details.triangles).toBeGreaterThan(0);
  }, 120_000);
});

describe('#481 the command-backed tools', () => {
  it('generates a program from the committed bench job, and the receipt carries its stage', async () => {
    const outDir = join(scratch, 'generate');
    const result = await callTool('generate_program', {
      jobPath: JOB,
      outDir,
      location: ABSENT_LOCATION,
    });
    const receipt = receiptOf(result);
    expect(receipt.command).toBe('engrave');
    expect(receipt.ok).toBe(true);
    expect(receipt.stage).toBe('done');
    // Nothing was stopped, so no gate was reported (#206).
    expect(receipt.gate).toBeNull();

    const data = dataOf<{ outDir: string }>(result);
    expect(data.outDir).toBe(outDir);
    const nc = receipt.outputs.find((o) => o.path.endsWith('.nc') && !o.path.includes('frame'));
    expect(nc, 'the run writes its .nc').toBeDefined();
    expect(existsSync(nc!.path)).toBe(true);
  }, 180_000);

  it('returns the run sheet’s Markdown beside the receipt', async () => {
    const outDir = join(scratch, 'run-sheet');
    const result = await callTool('run_sheet', {
      jobPath: JOB,
      outDir,
      location: ABSENT_LOCATION,
    });
    const receipt = receiptOf(result);
    expect(receipt.command).toBe('engrave');
    expect(receipt.ok).toBe(true);

    const data = dataOf<{ sheets: Array<{ file: string; markdown: string }> }>(result);
    expect(data.sheets.length).toBeGreaterThan(0);
    expect(data.sheets[0]!.markdown).toContain('single barrel');
    expect(existsSync(data.sheets[0]!.file)).toBe(true);
  }, 180_000);

  it('reads a location section from a named document, under the location receipt', async () => {
    const result = await callTool('read_location', { section: 'tools', location: LOCATION });
    const receipt = receiptOf(result);
    expect(receipt.command).toBe('location');
    expect(receipt.ok).toBe(true);

    const data = dataOf<{ section: string }>(result);
    expect(data.section).toBe('tools');
    expect(result.content[0]!.text).toContain('Test bench');
  });

  it('reports a missing machine document as no document, never a failure (#477)', async () => {
    const result = await callTool('read_location', {
      section: 'stock',
      location: ABSENT_LOCATION,
    });
    const receipt = receiptOf(result);
    expect(receipt.command).toBe('location');
    expect(receipt.ok).toBe(true);
    expect(result.content[0]!.text).toContain('no location document');
  });
});

describe('#481 the server over stdio', () => {
  it('initialises, lists the same ten tools and calls one, through the real transport', async () => {
    const require = createRequire(import.meta.url);
    const TSX = pathToFileURL(require.resolve('tsx')).href;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', TSX, join(APP, 'scripts', 'mcp-server.ts')],
      cwd: APP,
      env: {
        ...(process.env as Record<string, string>),
        TSX_TSCONFIG_PATH: join(APP, 'tsconfig.scripts.json'),
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'casemaker-spec', version: '0.0.0' });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe(SERVER_NAME);

      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
      for (const tool of listed.tools) {
        expect(tool.inputSchema.type).toBe('object');
      }
      expect(listed.tools.map((t) => t.name)).not.toContain('machine_status');

      const called = await client.callTool({ name: 'list_boards', arguments: {} });
      const structured = called.structuredContent as {
        receipt: Receipt;
        data: Array<{ id: string }>;
      };
      expect(structured).toBeDefined();
      expect(structured.receipt.command).toBe('mcp');
      expect(structured.data.map((b) => b.id)).toContain('rpi-4b');
    } finally {
      await client.close();
    }
  }, 180_000);
});

// The receipt's own spec pins the `mcp` variant's shape; this one keeps the two lists honest.
describe('#481 the mcp receipt variant', () => {
  it('covers every pure tool in the receipt’s own tool list', () => {
    const pure = ['list_boards', 'list_templates', 'describe_board', 'new_project', 'patch_case', 'compile_project'];
    expect([...RECEIPT_MCP_TOOLS]).toEqual(pure);
    // The tools that run a command do NOT use the variant — their receipt is the command's own.
    for (const name of ['export_parts', 'generate_program', 'run_sheet', 'read_location']) {
      expect([...RECEIPT_MCP_TOOLS]).not.toContain(name);
    }
  });
});
