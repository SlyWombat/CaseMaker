/**
 * #966 — the headless MCP server, the real Node-process analogue of "the house server starts".
 *
 * #1180 — SPLIT from casemakerManifoldNode966.spec.ts so this real process runs on its own worker.
 * The body is moved verbatim; the script/env plumbing lives in helpers/casemakerNode966.ts.
 */
import { describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { tsxArgs } from '../tools/tsxCli';
import { APP, MCP_SCRIPT, childEnv } from './helpers/casemakerNode966';

describe('#966 the headless MCP server — the real Node-process analogue of "the house server starts"', () => {
it('(c) comes up over stdio, answers tools/list, and closes clean', async () => {
    // `casemaker --headless --bind-all` (docs/deployment.md) is the compiled Tauri RUST binary
    // (src-tauri/src/lib.rs, run_headless) — never tsx/Node, so this bug cannot reach it, and
    // building it is out of scope for this checkout (CLAUDE.md: Windows build on Windows only; a
    // Linux build needs its own dedicated WSL clone with webkit2gtk, neither present here). This is
    // the Node-process service that actually shares the risk: its import graph reaches
    // cam/model/plan.ts -> ManifoldRuntime.ts exactly as `casemaker cut`'s does (see header).
    const env = childEnv();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: tsxArgs(MCP_SCRIPT),
      cwd: APP,
      env,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'casemaker-966-smoke', version: '0.0.0' });
    try {
      // A cold tsx transform of this script's whole import graph (compileProject, the board/
      // template registries, patch, …) can outrun the SDK's own 60s default request timeout on a
      // first run — raised on both the initialize handshake (`connect`) and the call below, not
      // because the server is slow once warm, but because this is a "does it come up and answer
      // at all" check, not a latency budget.
      await client.connect(transport, { timeout: 150_000 });
      const listed = await client.listTools(undefined, { timeout: 150_000 });
      expect(listed.tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 200_000);
});
