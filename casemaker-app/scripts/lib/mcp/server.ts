/**
 * The MCP server (#481): one long-lived process over stdio, offering the headless tools.
 *
 * This is the THIN layer. The tool surface and every call live in `tools.ts`; here there are only
 * the two MCP requests (`tools/list`, `tools/call`) and the transport. That keeps the server's
 * behaviour testable without a socket: `callTool` is a plain function.
 *
 * Stdout belongs to JSON-RPC. Progress a command would print is captured by its sink and returned
 * in the tool result, never written to stdout — a stray `console.log` here corrupts the protocol,
 * so nothing in this module logs.
 */
import { createRequire } from 'node:module';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { callTool, TOOL_DEFINITIONS } from './tools';

export const SERVER_NAME = 'casemaker';

/** The app's own version, so a client can tell which build answered. */
export const SERVER_VERSION: string = (
  createRequire(import.meta.url)('../../../package.json') as { version: string }
).version;

/**
 * The MCP server, wired to the tool table. `Server` is the low-level SDK class on purpose: the
 * tool schemas are generated from the Zod documents (#480) and advertised verbatim, rather than
 * restated through the high-level registration helper.
 */
export function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Case Maker headless tools: build cases from the board library, compile and export them, ' +
        'and generate engraving programs and run sheets. Nothing here touches the machine — no ' +
        'upload, play, probe or power action exists in this server.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: { ...tool.inputSchema, type: 'object' } as {
        type: 'object';
        [key: string]: unknown;
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callTool(request.params.name, request.params.arguments);
    return {
      content: result.content,
      ...(result.structuredContent === undefined
        ? null
        : { structuredContent: result.structuredContent }),
      ...(result.isError === true ? { isError: true } : null),
    };
  });

  return server;
}

/** Serve over stdio until the client closes the pipe. */
export async function runStdioServer(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
