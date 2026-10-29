// #749 — A GEOMETRY-KERNEL CRASH IS A RECEIPT, NOT AN EMPTY STDOUT.
//
// `casemaker cut docs/bench/2026-10-28-z1-real-jobs/jobs/j24-spoke-wrench-z.json` reproduced a
// wasm `RuntimeError: memory access out of bounds` after ~90-115 s, and because the throw escaped
// `engraveJobBody` it skipped `emit()`: with `--json` stdout was 0 bytes. That breaks #478's
// contract and #733 item 3's guarantee in the same way an invalid job or a broken catalogue did.
//
// The throw is forced here rather than staged through a 150 s heap exhaustion: the two kernel
// boundaries the command owns are `engraveGenerate` (the CAM's Clipper/Manifold work) and
// `session.load` (the exact sweep). Both are mocked to raise the real wasm error, and the run's
// stdout is captured the way a `| jq` consumer reads it — one document, parsed as a whole.
//
// The tests are in process (not the spawn style of #733/#732) because a mocked boundary cannot be
// reached from a child process; the receipt is emitted through the same `commandOutput` path the
// spawn tests exercise, with `{ json: true }` and no sink, so stdout is the real channel.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import { defaultEngraveJob } from '../../src/engine/cnc/engrave/defaults';
import { parseReceipt, type Receipt } from '../../src/platform/headless/receipt';
import type { EngraveJob } from '../../src/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const LOCATION = join(APP, 'tests', 'unit', 'fixtures', 'location-doc.json');
/** The fixture location's 3.175 mm owned flat; large enough for the one label the job cuts. */
const CUTTER = 'user:6f7a8b9c0d';
const NOW = new Date('2026-10-28T12:00:00.000Z');

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-kernel-crash-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

/**
 * Which boundary the next run should crash at. The mocks below are hoisted with `vi.mock`, so
 * their state is hoisted too: one object both the test and the factories can reach.
 */
const forced = vi.hoisted(() => ({ at: null as null | 'generate' | 'load' | 'plain' }));

const WASM_CRASH = 'memory access out of bounds';
/** A plain JS bug, not a wasm fault: it must never be reported as "the geometry kernel". */
const PLAIN_BUG = 'cannot read properties of undefined (reading "cuts")';

vi.mock('../../src/workers/sim/engraveGenerate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/workers/sim/engraveGenerate')>();
  return {
    ...actual,
    engraveGenerate: (...args: Parameters<typeof actual.engraveGenerate>) => {
      if (forced.at === 'generate') throw new WebAssembly.RuntimeError(WASM_CRASH);
      if (forced.at === 'plain') throw new TypeError(PLAIN_BUG);
      return actual.engraveGenerate(...args);
    },
  };
});

vi.mock('../../src/workers/sim/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/workers/sim/session')>();
  return {
    ...actual,
    createSimSession: (...args: Parameters<typeof actual.createSimSession>) => {
      const session = actual.createSimSession(...args);
      if (forced.at !== 'load') return session;
      return {
        ...session,
        load: (): never => {
          throw new WebAssembly.RuntimeError(WASM_CRASH);
        },
      };
    },
  };
});

/**
 * A one-label job the generator really posts. The crash tests need the command to reach the
 * boundary under test, not to stop earlier for want of a cutter, stock or feed row; this is the
 * shape `restPairJob` (#733) uses, with one cutter and no setup so the run is one program.
 */
function oneLabelJob(): EngraveJob {
  const base = defaultEngraveJob();
  const label = { ...base.labels[0]!, text: 'AE', size: 24, position: { x: 50, y: 32 }, depth: 0.5 };
  return { ...base, name: 'kernel crash job', toolKey: CUTTER, labels: [label] };
}

interface CrashRun {
  code: number;
  /** Exactly what reached stdout, joined as a consumer would receive it. */
  stdout: string;
  /** The operator's channel (`casemaker cut: ...` lines and progress). */
  stderr: string[];
}

/** Run `casemaker cut --json` in process, capture its two channels, and parse its one receipt. */
async function crashRun(name: string): Promise<{ run: CrashRun; receipt: Receipt }> {
  const outDir = join(SCRATCH, name);
  mkdirSync(outDir, { recursive: true });
  const jobPath = join(outDir, 'job.json');
  writeFileSync(jobPath, JSON.stringify(oneLabelJob(), null, 2) + '\n');

  const written: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });

  const code = await engraveJobMain([jobPath, '--out', outDir, '--location', LOCATION], {
    json: true,
    now: NOW,
  });
  // stdout is exactly the receipt: JSON.parse of the whole stream, not a substring of it. A second
  // document (or a progress line leaked onto stdout) makes this throw.
  const stdout = written.join('');
  expect(stdout.trim(), `stdout was ${stdout.length} bytes`).not.toBe('');
  return { run: { code, stdout, stderr }, receipt: parseReceipt(JSON.parse(stdout)) };
}

describe('#749 a kernel crash answers --json with one receipt', () => {
  it('a crash in the generator is a `cam` stop, and stdout still parses', async () => {
    forced.at = 'generate';
    const { run, receipt } = await crashRun('generate');

    expect(run.code, 'a crashed run exits non-zero').toBe(1);
    expect(receipt.ok).toBe(false);
    expect(receipt.command).toBe('engrave');
    // The stage is NAMED, not null: the caller can tell which part of the pipeline died.
    expect(receipt.stage).toBe('cam');
    expect(receipt.gate).toBe('generated');
    expect(receipt.refusals.map((r) => r.code)).toEqual(['stage-error']);
    expect(receipt.refusals[0]!.reason).toContain('geometry kernel');
    expect(receipt.refusals[0]!.reason).toContain('cam');
    expect(receipt.refusals[0]!.reason).toContain(WASM_CRASH);
    expect(receipt.refusals[0]!.reason).toContain('Nothing was written');
    expect(receipt.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'stage-error',
        severity: 'error',
        source: 'findings',
        program: 'kernel crash job',
      }),
    );
    // The operator reads the same sentence on stderr, not a bare wasm stack.
    expect(run.stderr.join('\n')).toContain('casemaker cut:');
    expect(run.stderr.join('\n')).toContain(WASM_CRASH);
    // Nothing reached the writer.
    expect(receipt.outputs).toEqual([]);
  });

  it('a crash in the sweep is a `simulated` stop naming the program, and stdout still parses', async () => {
    forced.at = 'load';
    const { run, receipt } = await crashRun('load');

    expect(run.code, 'a crashed run exits non-zero').toBe(1);
    expect(receipt.ok).toBe(false);
    expect(receipt.stage).toBe('simulated');
    expect(receipt.gate).toBe('simulated');
    expect(receipt.refusals.map((r) => r.code)).toEqual(['stage-error']);
    expect(receipt.refusals[0]!.reason).toContain('geometry kernel');
    expect(receipt.refusals[0]!.reason).toContain('simulating program 1');
    expect(receipt.refusals[0]!.reason).toContain(WASM_CRASH);
    expect(receipt.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'stage-error',
        severity: 'error',
        source: 'simulation',
        program: 'kernel crash job',
      }),
    );
    expect(run.stderr.join('\n')).toContain(WASM_CRASH);
    expect(receipt.outputs).toEqual([]);
  });

  it('a plain TypeError is reported as itself, with its stack — never as the kernel', async () => {
    // The guard must not tell the operator the geometry kernel is at fault for a bug in this
    // build. It also must not eat the one thing that locates the bug: the JS stack.
    forced.at = 'plain';
    const { run, receipt } = await crashRun('plain');

    expect(run.code, 'a crashed run exits non-zero').toBe(1);
    expect(receipt.ok).toBe(false);
    expect(receipt.stage).toBe('cam');
    expect(receipt.gate).toBe('generated');
    expect(receipt.refusals.map((r) => r.code)).toEqual(['stage-error']);
    const reason = receipt.refusals[0]!.reason;
    expect(reason).toContain(`TypeError: ${PLAIN_BUG}`);
    expect(reason).toContain('cam');
    expect(reason).toContain('Nothing was written');
    expect(reason, 'a plain TypeError is not a geometry-kernel fault').not.toContain('geometry kernel');
    // The stack is printed for the operator; the receipt's message stays a sentence.
    const stderr = run.stderr.join('\n');
    expect(stderr).toContain(`TypeError: ${PLAIN_BUG}`);
    expect(stderr).toMatch(/\n\s+at /);
    expect(receipt.outputs).toEqual([]);
  });

  it('an ordinary refusal still has its own code, not the crash vocabulary', async () => {
    // The boundary does not swallow stops the command already knows how to report. An invalid
    // job stops before any stage, exactly as #733 item 3 pins; this asserts the crash guard is
    // narrow — it does not relabel a document refusal as a kernel fault.
    forced.at = null;
    const dir = join(SCRATCH, 'invalid');
    mkdirSync(dir, { recursive: true });
    const jobPath = join(dir, 'job.json');
    writeFileSync(jobPath, JSON.stringify({ schemaVersion: 3, name: '' }) + '\n');
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await engraveJobMain([jobPath, '--out', dir, '--location', LOCATION], {
      json: true,
      now: NOW,
    });
    expect(code).toBe(1);
    const receipt = parseReceipt(JSON.parse(written.join('')));
    expect(receipt.stage).toBeNull();
    expect(receipt.refusals.map((r) => r.code)).toEqual(['invalid-job']);
    expect(receipt.refusals.map((r) => r.code)).not.toContain('stage-error');
  });
});
