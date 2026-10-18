// The Case Maker MCP server (#481) — one long-lived process over stdio.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/mcp-server.ts
//
// A Claude Code session points at it in its MCP configuration; the tool surface, the receipts and
// the schema checks live in `scripts/lib/mcp/`. Nothing here prints to stdout: stdout is the
// protocol.
import { runStdioServer } from './lib/mcp/server';

runStdioServer().catch((e: unknown) => {
  console.error(`mcp-server: ${(e as Error).message}`);
  process.exitCode = 1;
});
