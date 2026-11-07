// #966 — ManifoldRuntime.ts's wasm?url import never loads under plain Node/tsx, proved through
// REAL SPAWNED SUBPROCESSES (`tests/tools/tsxCli.ts`'s `tsxArgs()` convention, the one established
// convention this codebase now spawns every tsx script with — 3fc0ecb1, 21832b4d, 6d6aff49).
//
// On this branch's base (965-int @ dfe9c451), `workers/sim/engraveGenerate.ts` already imports
// `cam/model/plan.ts` for its `USE_MODEL_CAM_ENGINE` constant UNCONDITIONALLY — the import is
// static, so it is resolved at module load time regardless of the constant's value (965-int has
// no `CASEMAKER_MODEL_CAM` environment wiring yet; it is hard-coded `false`, "set only by specs for
// now"). That means `casemaker cut` on ANY job at all — not only a goal job, not gated by any flag
// — loads `ManifoldRuntime.ts` the moment the CLI starts. Before the #966 fix this crashed with
// `ERR_MODULE_NOT_FOUND: Cannot find package 'a'` before a single line of job logic ran. Two cases
// below exercise that at two different depths of the import graph:
//
//   (a) an ordinary 2D job (no goal/3D geometry at all) — proves the baseline CLI path, which never
//       touches a Manifold op, is unaffected simply because `ManifoldRuntime.ts` sits in the
//       static import graph of the module it loads.
//   (b) a goal job (a real 3D target object, planned and swept through the heightfield/goal engine)
//       — proves `ManifoldRuntime.ts` is not just imported but actually CALLED (`getToplevel()`,
//       real wasm boolean ops) end to end through the CLI, under plain Node.
//
// A third case checks the Node-process analogue of "the house server starts": `casemaker --headless
// --bind-all` (docs/deployment.md) is the compiled Tauri RUST binary (`src-tauri/src/lib.rs`'s
// `run_headless`) — a native executable that never runs tsx or Node and so is simply not at risk
// from this bug; building it is out of scope here per this repo's own CLAUDE.md (Windows build runs
// on Windows only, a Linux build needs its own dedicated WSL clone with webkit2gtk — neither exists
// in this checkout). The actual long-lived Node/tsx service with the identical risk profile is
// `scripts/mcp-server.ts`: `scripts/lib/casemaker/engrave.ts`'s own comment says "the CLI and the
// MCP server start the same way" (the shared headless bootstrap, #476), and `scripts/lib/mcp/
// tools.ts` statically imports `engraveJobMain` from the same `engrave.ts` the CLI uses — so the
// MCP server's import graph reaches `cam/model/plan.ts` → `ManifoldRuntime.ts` exactly as the CLI's
// does. Case (c) spawns it for real and proves it comes up, answers one request and closes clean.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '../../src/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { ToolLibraryEntry } from '../../src/engine/cnc/toolLibrary';
import { parseReceipt, type Receipt } from '../../src/platform/headless/receipt';
import type { EngraveJob, EngraveTargetObject } from '../../src/types/engraveJob';
import { buildRandomPart } from '../tools/randomParts';
import { tsxArgs } from '../tools/tsxCli';
import { tl } from './helpers/manifoldExec';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const CLI_SCRIPT = join(APP, 'scripts', 'casemaker.ts');
const MCP_SCRIPT = join(APP, 'scripts', 'mcp-server.ts');
const LOCATION = join(APP, 'tests', 'unit', 'fixtures', 'location-doc.json');

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-manifold-node-966-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface CliRun {
  code: number;
  receipt: Receipt | null;
  stderr: string;
}

/** Spawns the real `casemaker cut` entry, exactly as `casemakerCutPrograms.spec.ts` does. */
function cliCut(job: EngraveJob, name: string, locationText: string): CliRun {
  const dir = join(SCRATCH, name);
  mkdirSync(dir, { recursive: true });
  const jobPath = join(dir, 'job.json');
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + '\n');
  const locationPath = join(dir, 'location.json');
  writeFileSync(locationPath, locationText);
  const outDir = join(dir, 'out');

  // No CASEMAKER_MODEL_CAM in the child's environment at all: the fix is about the wasm `?url`
  // import itself, not about the model-CAM engine, and must hold with that flag off (its only
  // state on this branch — 965-int has no env wiring for it yet, see header comment).
  const env = { ...process.env };
  delete env.CASEMAKER_MODEL_CAM;

  const run = spawnSync(
    process.execPath,
    tsxArgs(CLI_SCRIPT, ['cut', jobPath, '--json', '--out', outDir, '--location', locationPath]),
    { cwd: APP, encoding: 'utf8', timeout: 180_000, env },
  );
  const receipt =
    run.stdout.trim() === ''
      ? null
      : (() => {
          try {
            return parseReceipt(JSON.parse(run.stdout));
          } catch {
            return null;
          }
        })();
  return { code: run.status ?? 1, receipt, stderr: run.stderr };
}

describe('#966 casemaker cut survives ManifoldRuntime.ts being in the import graph, under plain Node', () => {
  it('(a) an ordinary 2D job — no goal, no 3D geometry — still posts clean', () => {
    const job = defaultEngraveJob();
    const locationText = readFileSync(LOCATION, 'utf8');
    const { code, receipt, stderr } = cliCut(job, '2d-job', locationText);

    expect(code, `stderr:\n${stderr}\nreceipt: ${JSON.stringify(receipt)}`).toBe(0);
    expect(receipt).not.toBeNull();
    expect(receipt!.ok, JSON.stringify(receipt)).toBe(true);
    // The exact crash this fix removes, named so a regression is unmistakable, not a timeout.
    expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(stderr).not.toContain("Cannot find package 'a'");
  }, 120_000);

  it('(b) a goal job — real 3D target, planned through getToplevel()’s wasm ops for real', () => {
    // Same fixture `casemakerCliModelCam966.spec.ts` already proves `planModelCam` plans, posts and
    // verifies clean for (ROUND 2's `camModelSeam966.spec.ts` fixture too): the flats are owned in
    // the location for a rough/finish split, the goal's own finishing ball rides in the job
    // document's own `tool` snapshot. Deliberately NOT a 6 mm flat in hardwood (no feeds-table row
    // for that pair) — this spec is about ManifoldRuntime.ts loading, not about picking a fixture
    // the feeds table happens to cover.
    const FLAT6_KEY = 'user:flat6-966smoke';
    const FLAT3175_KEY = 'user:flat3175-966smoke';
    const BALL2_KEY = 'user:ball2-966smoke';
    const FLAT6: Tool = flatEndMill(6, { number: 1, id: FLAT6_KEY, name: 'flat-6' });
    const FLAT3175: Tool = flatEndMill(3.2, { number: 2, id: FLAT3175_KEY, name: 'flat-3.2' });
    const BALL2: Tool = { ...flatEndMill(2, { number: 3, id: BALL2_KEY, name: 'ball-2' }), typeText: 'Ball Nose', shape: 'ball' };
    function entry(key: string, tool: Tool): ToolLibraryEntry {
      return { key, tool, provenance: 'test fixture' };
    }
    const locationText =
      JSON.stringify({ tools: [entry(FLAT6_KEY, FLAT6), entry(FLAT3175_KEY, FLAT3175)], inventory: [] }, null, 2) +
      '\n';

    // #964's own seeded "sloped" fixture, already proven elsewhere (camModelSeam966.spec.ts,
    // curvedOpsProperty959.spec.ts) to plan clean — used here only to drive a real goal job through
    // the CLI, not to assert anything new about planning quality.
    const part = buildRandomPart(1, 'sloped', tl);
    const goal: EngraveTargetObject = { ...part.target, position: { x: part.stock.length / 2, y: part.stock.width / 2, z: 0 } };
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      stock: { ...defaultEngraveJob().stock, length: part.stock.length, width: part.stock.width, thickness: part.stock.thickness },
      workholding: { kind: 'tape', tape: { width: 20, thickness: 0.1, inset: 2, where: null, squareTo: 'front', source: 'default' } },
      targetObject: goal,
      toolKey: BALL2_KEY,
      tool: BALL2,
    };

    const { code, receipt, stderr } = cliCut(job, 'goal-job', locationText);

    expect(code, `stderr:\n${stderr}\nreceipt: ${JSON.stringify(receipt)}`).toBe(0);
    expect(receipt).not.toBeNull();
    expect(receipt!.ok, JSON.stringify(receipt)).toBe(true);
    expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(stderr).not.toContain("Cannot find package 'a'");
  }, 180_000);
});

describe('#966 the headless MCP server — the real Node-process analogue of "the house server starts"', () => {
  it('(c) comes up over stdio, answers tools/list, and closes clean', async () => {
    // `casemaker --headless --bind-all` (docs/deployment.md) is the compiled Tauri RUST binary
    // (src-tauri/src/lib.rs, run_headless) — never tsx/Node, so this bug cannot reach it, and
    // building it is out of scope for this checkout (CLAUDE.md: Windows build on Windows only; a
    // Linux build needs its own dedicated WSL clone with webkit2gtk, neither present here). This is
    // the Node-process service that actually shares the risk: its import graph reaches
    // cam/model/plan.ts -> ManifoldRuntime.ts exactly as `casemaker cut`'s does (see header).
    const env = { ...process.env };
    delete env.CASEMAKER_MODEL_CAM;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: tsxArgs(MCP_SCRIPT),
      cwd: APP,
      env: env as Record<string, string>,
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
