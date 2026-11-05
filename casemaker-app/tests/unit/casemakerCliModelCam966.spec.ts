// #966 — THE CLI FLAG, END TO END. `CASEMAKER_MODEL_CAM=1` in the environment is
// `cam/model/plan.ts`'s `USE_MODEL_CAM_ENGINE` initial value (landed on `963-job-model`@9025eec3,
// cherry-picked onto this branch — see this branch's own commit log), read ONCE at that module's
// first import. This spec proves the variable actually reaches `generateGoalProgram`'s branch
// (`workers/sim/engraveGenerate.ts`, "#966 — THE SEAM") through the REAL headless CLI entry point
// (`scripts/casemaker.ts` → `dispatch` → `engraveJobMain`, `scripts/lib/casemaker/engrave.ts`) for
// a single-setup goal job, and that the flag still defaults off when the variable is unset.
//
// REAL SPAWNED SUBPROCESSES, not `vi.resetModules()` + an in-process `import()`. This file
// originally avoided a real spawn because `casemakerCutPrograms.spec.ts`'s own two spawn-based
// tests were reported to fail in this checkout (`/mnt/d/Projects/Case Maker`, a path with a space)
// with `ERR_MODULE_NOT_FOUND` on `manifold.wasm` — blamed on tsx's ESM resolver mishandling the
// space. Investigated on `966-spawn-space` (#966): that could not be reproduced. A fresh `npm ci`
// in this exact checkout (same space in the path) runs both of that file's spawn-based tests clean,
// individually and as part of the full suite, under Node 22 and 24, and a manual replay of the same
// spawnSync argv — including a real job that runs the full geometry/manifold pipeline through to
// simulation — also succeeds. The two tests use `--import <tsx file:// URL>`; converting them to
// `tests/tools/tsxCli.ts`'s `tsxArgs()` convention (this file's own convention below, and the one
// `clParity.spec.ts`/`pageCardParity.spec.ts` already use) landed anyway, as a unification, not a
// bug fix — see that branch's commit for the full writeup. tsx is pinned to the same resolved
// version on `main` and on this branch's own `965-int` base, so this isn't version drift either.
//
// With that cleared, this spec now does what its own comment always said would be the more
// end-to-end proof: two real `spawnSync` calls per run — `tests/tools/modelCamFlagProbe.ts` (a tiny
// script that imports `cam/model/plan.ts` and prints `USE_MODEL_CAM_ENGINE`, spawned fresh so the
// read is a genuine subprocess's module-load-time value, the same check the old `vi.resetModules()`
// + `import()` made, but across a real process boundary) and the real `casemaker cut` CLI entry
// point itself, both via `tsxArgs()`. No module state leaks between tests because nothing is
// imported in-process anymore — the `afterEach` reset this file used to need is gone with it.
//
// The fixture is #964's own seeded "sloped" random part, seed 1, tooled with the SAME three house
// cutters (`FLAT6`/`FLAT3175`/`BALL2`) `camModelSeam966.spec.ts`'s ROUND 2 describe block and
// `curvedOpsProperty959.spec.ts` already prove `planModelCam` fully plans, posts and covers for a
// single setup — not a new, unproven fixture.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const PROBE_SCRIPT = join(APP, 'tests', 'tools', 'modelCamFlagProbe.ts');
const CLI_SCRIPT = join(APP, 'scripts', 'casemaker.ts');

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-cli-model-cam-966-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

// The same three house cutters `curvedOpsProperty959.spec.ts` plans this exact fixture with, BUT
// each `id` is set to the exact `user:` key it is (or, for the ball, would be) registered under —
// not the bare `camModelSeam966.spec.ts`-style id ('flat-6', 'ball-2'). `cutterKeyOf`
// (`cam/model/sequence.ts`) stamps a posted program's `toolKey` header with `tool.id ?? tool.name`,
// and the CLI's own post-generate SIMULATION stage (`programSweep.ts`'s `cutterFor`,
// `scripts/lib/casemaker/engrave.ts`) resolves that header back to a cutter either by matching
// `job.toolKey` exactly (the job's own snapshot, `BALL2` here) or by looking the string up in the
// tool REGISTRY (`entryFor`) — a bare short id matches neither, so a cam/model program built from
// one of these tools would read back as "not on this bench" even though it is the tool the job
// planned with. Giving each tool's `id` its real registry key (or the job's own `toolKey` for the
// snapshot) is what makes a cam/model posting round-trip through the CLI's own sweep exactly as a
// job built from a real location document would.
// #966 — the diameters deliberately dodge the registry's own PERMANENT built-in tier
// (`toolLibrary.ts`'s `TOOL_LIBRARY`: a 3.175 mm flat whose `tool.id` does not even match its OWN
// `key`, and a 1 mm flat) — `getTools()` (what a real CLI run's `shop.tools` is) always carries
// both, same as a real bench's registry does, and a candidate tied with one of them on diameter
// can lose the plan's tie-break to the built-in. That built-in's `id`/`key` mismatch is a separate,
// pre-existing gap this branch does not own (`cutterKeyOf` stamps `tool.id` on a posted program;
// `entryFor` resolves a posted key only by exact registry `key`, and for that one row the two
// strings differ) — this fixture simply never asks either engine to reach for it, so this spec
// stays about the #966 flag, not that gap.
const FLAT6_KEY = 'user:flat6-966';
const FLAT3175_KEY = 'user:flat3175-966';
const BALL2_KEY = 'user:ball2-966';
const FLAT6: Tool = flatEndMill(6, { number: 1, id: FLAT6_KEY, name: 'flat-6' });
const FLAT3175: Tool = flatEndMill(3.2, { number: 2, id: FLAT3175_KEY, name: 'flat-3.2' });
const BALL2: Tool = { ...flatEndMill(2, { number: 3, id: BALL2_KEY, name: 'ball-2' }), typeText: 'Ball Nose', shape: 'ball' };

function entry(key: string, tool: Tool): ToolLibraryEntry {
  return { key, tool, provenance: 'test fixture' };
}

/**
 * A bare "house" tool document — `bootstrap`'s pre-#412 shape, read off `tools`/`inventory` with no
 * `kind` field (`checkLocationImport` reads anything else as this older kind). The flats a
 * rough/finish split needs are owned here; the goal's own finishing ball rides in the job document
 * itself (`goalJob`'s `tool` snapshot), so `jobTool` never has to resolve it through this file
 * (`toolForJob`'s own rule: the job's snapshot wins over the registry).
 */
function locationDoc(): string {
  return (
    JSON.stringify(
      {
        tools: [entry(FLAT6_KEY, FLAT6), entry(FLAT3175_KEY, FLAT3175)],
        inventory: [],
      },
      null,
      2,
    ) + '\n'
  );
}

/**
 * The #964 seeded "sloped" fixture (seed 1), placed and tooled exactly as
 * `camModelSeam966.spec.ts`'s ROUND 2 `randomPartJob` builds it, so this is the SAME job already
 * proven to plan, post and verify clean through `planModelCam` directly — driven through the CLI
 * entry point instead of calling `generateGoalProgram` in process.
 */
function goalJob(): EngraveJob {
  const part = buildRandomPart(1, 'sloped', tl);
  const goal: EngraveTargetObject = {
    ...part.target,
    position: { x: part.stock.length / 2, y: part.stock.width / 2, z: 0 },
  };
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: {
      ...defaultEngraveJob().stock,
      length: part.stock.length,
      width: part.stock.width,
      thickness: part.stock.thickness,
    },
    // Tape, not the default vise: a vise's jaw faces sit AT the stock's own edges (#966 is not
    // about workholding), and this 40×40×10 fixture's rough passes legitimately reach those
    // edges — on a real vise-held part that is a tool-into-fixture stop, same as #966 — so this
    // job is held the same way `curvedOpsProperty959.spec.ts`'s own identical fixture is planned
    // against (`fixture: { mount: 'tape' }`), not a smaller, easier-to-pass stand-in.
    workholding: { kind: 'tape', tape: { width: 20, thickness: 0.1, inset: 2, where: null, squareTo: 'front', source: 'default' } },
    targetObject: goal,
    // An explicit snapshot, not a key the measured search could override (#766): this run is
    // about the FLAG, not about which cutter the search would have picked.
    toolKey: BALL2_KEY,
    tool: BALL2,
  };
}

interface CliRun {
  code: number;
  receipt: Receipt | null;
  outDir: string;
}

/**
 * Sets (or clears) `CASEMAKER_MODEL_CAM` in a child process's own environment — never this test
 * process's `process.env`, so nothing here needs resetting between tests. Two real `spawnSync`
 * calls: `modelCamFlagProbe.ts` first, proving the environment this run is about to use really
 * does reach `cam/model/plan.ts`'s module-load-time read in a brand-new process (the direct check
 * that nothing below could pass for the wrong reason), then the real `casemaker cut` CLI entry
 * point itself, both spawned exactly as `casemakerCutPrograms.spec.ts`'s own spawn-based tests are
 * (`tsxArgs()`, `process.execPath`, `cwd: APP`).
 */
function cliCut(job: EngraveJob, name: string, locationText: string, modelCam: boolean): CliRun {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (modelCam) env.CASEMAKER_MODEL_CAM = '1';
  else delete env.CASEMAKER_MODEL_CAM;

  const probe = spawnSync(process.execPath, tsxArgs(PROBE_SCRIPT), {
    cwd: APP,
    encoding: 'utf8',
    timeout: 60_000,
    env,
  });
  expect(probe.status, `probe stderr:\n${probe.stderr}`).toBe(0);
  const probed = JSON.parse(probe.stdout) as { USE_MODEL_CAM_ENGINE: boolean };
  expect(
    probed.USE_MODEL_CAM_ENGINE,
    'cam/model/plan.ts did not pick up the environment in a fresh process',
  ).toBe(modelCam);

  const dir = join(SCRATCH, name);
  mkdirSync(dir, { recursive: true });
  const jobPath = join(dir, 'job.json');
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + '\n');
  const locationPath = join(dir, 'location.json');
  writeFileSync(locationPath, locationText);
  const outDir = join(dir, 'out');

  const run = spawnSync(
    process.execPath,
    tsxArgs(CLI_SCRIPT, ['cut', jobPath, '--json', '--out', outDir, '--location', locationPath]),
    { cwd: APP, encoding: 'utf8', timeout: 180_000, env },
  );
  expect(run.stdout.trim(), `stdout was empty; stderr:\n${run.stderr}`).not.toBe('');
  const receipt = parseReceipt(JSON.parse(run.stdout));
  return { code: run.status ?? 1, receipt, outDir };
}

describe('#966 the headless CLI generate path honours CASEMAKER_MODEL_CAM end to end', () => {
  it('flag set: the CLI entry point posts the goal job through cam/model, every program verifies clean', () => {
    const { code, receipt, outDir } = cliCut(goalJob(), 'flag-on', locationDoc(), true);

    expect(code, JSON.stringify(receipt)).toBe(0);
    expect(receipt).not.toBeNull();
    const r = receipt!;
    expect(r.command).toBe('engrave');
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
    expect(r.stage).toBe('done');

    // The #966-green success criterion: every posted program's own verify carries zero
    // error-severity findings, not merely "the run did not throw".
    const verifyErrors = r.diagnostics.filter((d) => d.source === 'verify' && d.severity === 'error');
    expect(verifyErrors, verifyErrors.map((d) => d.message).join('\n')).toEqual([]);

    if (r.command !== 'engrave') throw new Error('unreachable — checked above');
    expect(r.details.programs.length).toBeGreaterThan(0);
    for (const program of r.details.programs) {
      expect(program.ok, program.name).toBe(true);
      expect(program.stage).toBe('done');
      const nc = readFileSync(join(outDir, program.ncFile), 'utf8');
      expect(nc.length, `${program.ncFile} is empty`).toBeGreaterThan(0);
      expect(program.ncLines).toBeGreaterThan(0);
    }
  }, 180_000);

  it('flag unset: the default is still off — the same job and location still post clean through the old engine', () => {
    const { code, receipt } = cliCut(goalJob(), 'flag-off', locationDoc(), false);

    expect(code, JSON.stringify(receipt)).toBe(0);
    expect(receipt).not.toBeNull();
    const r = receipt!;
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
    expect(r.stage).toBe('done');
    const verifyErrors = r.diagnostics.filter((d) => d.source === 'verify' && d.severity === 'error');
    expect(verifyErrors).toEqual([]);
  }, 180_000);
});
