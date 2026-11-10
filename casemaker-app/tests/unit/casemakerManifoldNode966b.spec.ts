/**
 * #966 — (b) a goal job — real 3D target, planned through getToplevel’s wasm ops for real.
 *
 * #1180 — SPLIT from casemakerManifoldNode966.spec.ts: each case spawns its own real Node process,
 * so the three now run on three workers. The body and its rationale are moved verbatim; the
 * spawned-process plumbing lives in helpers/casemakerNode966.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '../../src/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { ToolLibraryEntry } from '../../src/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '../../src/types/engraveJob';
import { buildRandomPart } from '../tools/randomParts';
import { tl } from './helpers/manifoldExec';
import { cliCut } from './helpers/casemakerNode966';

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-manifold-node-966-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe('#966 casemaker cut survives ManifoldRuntime.ts being in the import graph, under plain Node', () => {
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

    const { code, receipt, stderr } = cliCut(SCRATCH, job, 'goal-job', locationText);

    expect(code, `stderr:\n${stderr}\nreceipt: ${JSON.stringify(receipt)}`).toBe(0);
    expect(receipt).not.toBeNull();
    expect(receipt!.ok, JSON.stringify(receipt)).toBe(true);
    expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(stderr).not.toContain("Cannot find package 'a'");
  }, 180_000);
});
