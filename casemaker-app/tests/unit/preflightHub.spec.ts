// The preflight HUB (#419 §3.2): one `collect()` per (setup, tool), the aggregate, and the two
// run-policy rows. The collector is tested by `preflight.spec.ts`; this spec is about the loop —
// which scopes are asked, which program each scope is judged against, and what the page order is.
//
// Pure data, like the collector: no wasm, no React, no worker, no store. Jobs come from
// `defaultEngraveJob`, so a fixture cannot quietly disagree with the document the app writes.

import { describe, it, expect } from 'vitest';

import { preflightHub, type PreflightHubInput } from '@/engine/cnc/preflight';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { freezePackage } from '@/engine/cnc/engrave/package';
import type { VerifyReport } from '@/engine/cnc/verify';
import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';
import type { EngraveJob } from '@/types/engraveJob';

const IDENTITY = {
  top: 'top',
  bottom: 'bottom',
  left: 'left',
  right: 'right',
  front: 'front',
  back: 'back',
} as const;

/** A second cutter, so a scope's tool key is visibly its own and not the job's. */
const TOOL_B = 'user:flat-1-b';

/** Two stored setups, one item and one cutter each. */
function twoSetups(job: EngraveJob, tools: readonly [string, string]): EngraveJob {
  const [a, b] = job.labels.map((l) => l.id);
  return {
    ...job,
    setups: [
      { id: 'setup-1', orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds: [a!], tools: [tools[0]] },
      { id: 'setup-2', orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds: [b!], tools: [tools[1]] },
    ],
  };
}

const CLEAN: VerifyReport = {
  ok: true,
  findings: [],
  stats: { lines: 1, cuttingMoves: 0, deepestZ: 0, bbox: { min: [0, 0, 0], max: [0, 0, 0] } },
};

function reportWith(findings: VerifyReport['findings']): VerifyReport {
  return { ...CLEAN, ok: findings.every((f) => f.severity !== 'error'), findings };
}

function program(setupIndex: number, toolKey: string, nc: string, verify: VerifyReport = CLEAN): EngraveProgram {
  return {
    setupIndex,
    setupId: `setup-${setupIndex}`,
    toolKey,
    nc,
    verify,
    frameNc: null,
    frameVerify: null,
    programHash: `hash-${setupIndex}-${toolKey}`,
    cam: null,
  };
}

function generatedWith(over: Partial<EngraveGenerated>): EngraveGenerated {
  return {
    ok: true,
    stage: 'done',
    findings: [],
    feeds: null,
    threads: null,
    cam: null,
    nc: 'G90 G21\n',
    verify: CLEAN,
    frameNc: null,
    frameVerify: null,
    facingNc: null,
    facingVerify: null,
    facingToolKey: null,
    facingError: null,
    facingCam: null,
    predicted: [],
    programs: [],
    errors: [],
    ...over,
  };
}

function hubFor(job: EngraveJob, over: Partial<PreflightHubInput> = {}) {
  return preflightHub({
    job,
    generated: null,
    staleSince: null,
    package: null,
    calibration: null,
    shelfItem: null,
    ...over,
  });
}

describe('preflightHub: the (setup, tool) loop', () => {
  it('asks once per scope, in the job`s setup and tool order, and stamps every row with its scope', () => {
    const job = twoSetups(defaultEngraveJob(), ['user:flat-1-a', TOOL_B]);
    const report = hubFor(job);

    expect(report.scopes.map((g) => g.scope)).toEqual([
      { setupIndex: 0, toolKey: 'user:flat-1-a' },
      { setupIndex: 1, toolKey: TOOL_B },
    ]);

    // Both scopes were genuinely asked: with nothing generated, each carries the gate's own
    // "Generate first." rather than the loop stopping after the first scope.
    for (const group of report.scopes) {
      expect(group.rows.some((r) => r.code === 'no-generate')).toBe(true);
      for (const row of group.rows) {
        expect(row.cause.setupIndex).toBe(group.scope.setupIndex);
        expect(row.cause.toolKey).toBe(group.scope.toolKey);
      }
    }
  });

  it('gives a job with no stored setups the single scope that job has', () => {
    const job = defaultEngraveJob();
    const report = hubFor(job);
    expect(report.scopes).toHaveLength(1);
    expect(report.scopes[0]!.scope).toEqual({ setupIndex: 0, toolKey: job.toolKey });
  });

  it('judges each scope against ITS program, not against the top-level adapter', () => {
    const job = twoSetups(defaultEngraveJob(), ['user:flat-1-a', TOOL_B]);
    const a = program(1, 'user:flat-1-a', 'A\n', reportWith([
      { severity: 'error', code: 'bad-ending', line: null, message: 'program A is the one at fault' },
    ]));
    const b = program(2, TOOL_B, 'B\n');
    const generated = generatedWith({ nc: a.nc, verify: a.verify, programs: [a, b] });

    const [first, second] = hubFor(job, { generated }).scopes;
    expect(first!.rows.some((r) => r.code === 'bad-ending')).toBe(true);
    expect(second!.rows.some((r) => r.code === 'bad-ending')).toBe(false);
    // The adapter still describes program 1; the second scope must not inherit it.
    expect(second!.rows.some((r) => r.code === 'no-generate')).toBe(false);
  });

  it('asks a scope with no program with no file, so a stopped Generate cannot read clean', () => {
    const job = twoSetups(defaultEngraveJob(), ['user:flat-1-a', TOOL_B]);
    const a = program(1, 'user:flat-1-a', 'A\n');
    const generated = generatedWith({
      ok: false,
      stage: 'feeds',
      nc: a.nc,
      verify: a.verify,
      programs: [a],
      errors: [{ stage: 'feeds', message: 'the feeds refused the second setup' }],
    });

    const [first, second] = hubFor(job, { generated }).scopes;
    // The scope with a program is not told its run stopped...
    expect(first!.rows.some((r) => r.code === 'generate-stopped')).toBe(false);
    // ...but the scope with no program says both that it is missing and why.
    expect(second!.rows.some((r) => r.code === 'no-generate')).toBe(true);
    const stopped = second!.rows.find((r) => r.code === 'generate-stopped');
    expect(stopped?.owner).toBe('generate');
    expect(stopped?.message).toBe('the feeds refused the second setup');
  });
});

describe('preflightHub: the run-policy rows', () => {
  it('states a stale Generate first, before any scope row', () => {
    const job = defaultEngraveJob();
    const report = hubFor(job, { generated: generatedWith({}), staleSince: Date.parse('2026-10-17T14:02:00Z') });
    expect(report.policyRows.map((r) => r.code)).toEqual(['generated-stale']);
    expect(report.rows[0]!.code).toBe('generated-stale');
    expect(report.firstBlocking?.code).toBe('generated-stale');
    expect(report.policyRows[0]!.owner).toBe('run');
  });

  it('states a stale package with the freeze time and the package owner`s reason, holding the blank', () => {
    const job = defaultEngraveJob();
    const frozen = freezePackage(
      job,
      [{ setupIndex: 1, setupId: 'setup-1', toolKey: job.toolKey, nc: 'G90\n', programHash: 'h', frameNc: null }],
      '2026-10-17T14:02:00.000Z',
    );
    expect(frozen.ok).toBe(true);
    // A current package is not a row.
    expect(hubFor(job, { package: frozen.ok ? frozen.package : null }).policyRows).toEqual([]);

    const changed: EngraveJob = { ...job, name: `${job.name} (edited)` };
    const report = hubFor(changed, { package: frozen.ok ? frozen.package : null });
    expect(report.policyRows.map((r) => r.code)).toEqual(['package-stale']);
    expect(report.policyRows[0]!.owner).toBe('run');
    expect(report.policyRows[0]!.message).toContain('The package of 14:02 is stale');
    expect(report.policyRows[0]!.message).toContain('Its blank stays held for this job.');
    expect(report.firstBlocking?.code).toBe('package-stale');
  });

  it('does not call a run stale when no Generate has produced anything', () => {
    const report = hubFor(defaultEngraveJob(), { staleSince: Date.now() });
    expect(report.policyRows).toEqual([]);
  });
});

describe('preflightHub: the page order and the first block', () => {
  it('keeps the hub`s order: policy rows, then every scope`s rows, never re-sorted', () => {
    const job = twoSetups(defaultEngraveJob(), ['user:flat-1-a', TOOL_B]);
    const report = hubFor(job);
    expect(report.rows).toEqual([
      ...report.policyRows,
      ...report.scopes.flatMap((g) => g.rows),
    ]);
    expect(report.firstBlocking).toBe(report.rows.find((r) => r.severity === 'error'));
  });

  it('counts a warning without treating it as blocking', () => {
    const job = defaultEngraveJob();
    const nc = 'G90 G21\n';
    const generated = generatedWith({
      nc,
      programs: [program(1, job.toolKey, nc)],
      findings: [{ severity: 'warning', code: 'vise-default', message: 'the vise is the shop default' }],
    });
    const report = hubFor(job, { generated });
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBeGreaterThanOrEqual(1);
    expect(report.firstBlocking).toBeNull();
  });
});
