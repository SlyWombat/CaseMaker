/**
 * #966 — (a) an ordinary 2D job — no goal, no 3D geometry — still posts clean.
 *
 * #1180 — SPLIT from casemakerManifoldNode966.spec.ts: each case spawns its own real Node process,
 * so the three now run on three workers. The body and its rationale are moved verbatim; the
 * spawned-process plumbing lives in helpers/casemakerNode966.ts.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '../../src/engine/cnc/engrave/defaults';
import { cliCut, LOCATION } from './helpers/casemakerNode966';

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-manifold-node-966-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe('#966 casemaker cut survives ManifoldRuntime.ts being in the import graph, under plain Node', () => {
it('(a) an ordinary 2D job — no goal, no 3D geometry — still posts clean', () => {
    const job = defaultEngraveJob();
    const locationText = readFileSync(LOCATION, 'utf8');
    const { code, receipt, stderr } = cliCut(SCRATCH, job, '2d-job', locationText);

    expect(code, `stderr:\n${stderr}\nreceipt: ${JSON.stringify(receipt)}`).toBe(0);
    expect(receipt).not.toBeNull();
    expect(receipt!.ok, JSON.stringify(receipt)).toBe(true);
    // The exact crash this fix removes, named so a regression is unmistakable, not a timeout.
    expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(stderr).not.toContain("Cannot find package 'a'");
  }, 120_000);
});
