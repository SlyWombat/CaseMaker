// The preflight HUB (#419 §3.2): one `collect()` per (setup, tool), the aggregate, and the two
// run-policy rows. The collector is tested by `preflight.spec.ts`; this spec is about the loop —
// which scopes are asked, which program each scope is judged against, and what the page order is.
//
// Pure data, like the collector: no wasm, no React, no worker, no store. Jobs come from
// `defaultEngraveJob`, so a fixture cannot quietly disagree with the document the app writes.

import { describe, it, expect } from 'vitest';

import { preflightHub, type PreflightHubInput } from '@/engine/cnc/preflight';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';

// #516 item 5 — the default job no longer seeds a cutter; the recommendation names `flat-1.0`.
// These engine tests need the job to name its cutter, so `dj()` applies that recommendation.
function dj(...args: Parameters<typeof defaultEngraveJob>): ReturnType<typeof defaultEngraveJob> {
  const job = defaultEngraveJob(...args);
  job.toolKey = 'flat-1.0';
  return job;
}
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
    designItems: [],
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

describe('#513 the bed moved under the job — the Cut gate’s error', () => {
  it('is a run-policy row, an error, and says the presses are back in Design', () => {
    const job = dj();
    const report = hubFor(job, { bedChanged: 'This job was set up on the bed “Vise on the pins”, and the bed has changed since: the jaw top moved from -56.8 mm to -56.65 mm.' });
    const row = report.policyRows.find((r) => r.code === 'bed-changed');
    expect(row).toMatchObject({ severity: 'error', owner: 'run' });
    expect(row!.message).toContain('Go back to Design (‹ Design) and press Re-plan on the current bed, or switch the bed back.');
    // It leads the page: this is about the SETUP, and a re-generate cannot clear it.
    expect(report.firstBlocking?.code).toBe('bed-changed');
    expect(report.errorCount).toBeGreaterThan(0);
  });

  it('says nothing when the beds agree (the caller passes no sentence)', () => {
    const report = hubFor(dj());
    expect(report.policyRows.some((r) => r.code === 'bed-changed')).toBe(false);
  });
});

describe('preflightHub: the (setup, tool) loop', () => {
  it('asks once per scope, in the job`s setup and tool order, and stamps every row with its scope', () => {
    const job = twoSetups(dj(), ['user:flat-1-a', TOOL_B]);
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
    const job = dj();
    const report = hubFor(job);
    expect(report.scopes).toHaveLength(1);
    expect(report.scopes[0]!.scope).toEqual({ setupIndex: 0, toolKey: job.toolKey });
  });

  it('gives a tool-less default job the single scope, so the gate is not green for want of a cutter (#516 item 5)', () => {
    const job = defaultEngraveJob(); // no cutter named yet
    const report = hubFor(job);

    expect(report.scopes).toHaveLength(1);
    expect(report.scopes[0]!.scope).toEqual({ setupIndex: 0, toolKey: '' });
    // The gate was genuinely asked: the missing program is the run gate's own sentence, and the
    // tool-less state itself is not reported as a finding (`setup-no-tool` is for SAVED setups).
    expect(report.scopes[0]!.rows.some((r) => r.code === 'no-generate')).toBe(true);
    expect(report.scopes[0]!.rows.some((r) => r.code === 'setup-no-tool')).toBe(false);
    expect(report.firstBlocking?.code).toBe('no-generate');
    expect(report.firstBlocking?.message).toBe('Generate first.');
  });

  it('judges each scope against ITS program, not against the top-level adapter', () => {
    const job = twoSetups(dj(), ['user:flat-1-a', TOOL_B]);
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
    const job = twoSetups(dj(), ['user:flat-1-a', TOOL_B]);
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
    // ...and the scope with no program says WHY, once, in the Generate's own row. #949 — the gate
    // reads the Generate's errors too, so its generic `no-generate` row is skipped for a block from
    // that source rather than stating the same failure under a second code.
    expect(second!.rows.some((r) => r.code === 'no-generate')).toBe(false);
    const stopped = second!.rows.find((r) => r.code === 'generate-stopped');
    expect(stopped?.owner).toBe('generate');
    expect(stopped?.message).toBe('the feeds refused the second setup');
  });
});

describe('#1036 the run, not the document, defines the scopes once a run exists', () => {
  it('a program posted under a substituted cutter blocks nothing and states the substitution', () => {
    // The stamp: the job states the ⌀1 flat-1.0, the plan substitutes flat-3.175x12-metal, and the
    // run is healthy. Scoped by the job's stated tool, the posted program matched nothing and the
    // Cut gate refused a run its own save gate calls clean.
    const job = dj();
    const generated = generatedWith({ programs: [program(1, 'flat-3.175x12-metal', 'G0 X0\n')] });
    const report = hubFor(job, { generated });

    expect(report.rows.filter((r) => r.code === 'no-generate')).toEqual([]);
    expect(report.firstBlocking).toBeNull();
    // The substitution is stated, naming the job's cutter and the plan's.
    const stated = report.scopes.flatMap((g) => g.rows).find((r) => r.code === 'cutter-substituted');
    expect(stated, 'the substitution must be stated on the run it changed').toBeDefined();
    expect(stated!.severity).toBe('info');
    expect(stated!.message).toContain('flat-1.0');
    expect(stated!.message).toContain('flat-3.175x12-metal');
  });

  it('asks the scope of the program that posted, so its own report is the one judged', () => {
    const job = dj();
    const a = program(1, 'flat-3.175x12-metal', 'G0 X0\n', reportWith([
      { severity: 'error', code: 'bad-ending', line: null, message: 'the substituted program is the one at fault' },
    ]));
    const report = hubFor(job, { generated: generatedWith({ nc: a.nc, verify: a.verify, programs: [a] }) });
    expect(report.scopes.map((g) => g.scope.toolKey)).toEqual(['flat-3.175x12-metal']);
    expect(report.scopes[0]!.rows.some((r) => r.code === 'bad-ending')).toBe(true);
    expect(report.firstBlocking?.code).toBe('bad-ending');
  });

  it('keeps the stated tool’s scope when its setup posted NO program at all (a stopped Generate)', () => {
    // The other side of the rule: a run that stopped before a setup posted must still say so —
    // that is a missing program, not a substitution.
    const job = twoSetups(dj(), ['user:flat-1-a', TOOL_B]);
    const a = program(1, 'user:flat-1-a', 'A\n');
    const generated = generatedWith({ ok: false, stage: 'feeds', nc: a.nc, verify: a.verify, programs: [a] });
    const report = hubFor(job, { generated });
    expect(report.scopes.map((g) => g.scope.toolKey)).toEqual(['user:flat-1-a', TOOL_B]);
    expect(report.scopes[1]!.rows.some((r) => r.code === 'generate-stopped' || r.code === 'no-generate')).toBe(true);
  });
});

describe('preflightHub: the run-policy rows', () => {
  it('states a stale Generate first, before any scope row', () => {
    const job = dj();
    const report = hubFor(job, { generated: generatedWith({}), staleSince: Date.parse('2026-10-17T14:02:00Z') });
    expect(report.policyRows.map((r) => r.code)).toEqual(['generated-stale']);
    expect(report.rows[0]!.code).toBe('generated-stale');
    expect(report.firstBlocking?.code).toBe('generated-stale');
    expect(report.policyRows[0]!.owner).toBe('run');
    // #581 — with no reason known the row keeps the generic sentence...
    expect(report.policyRows[0]!.message).toBe('The job or the machine frame changed since it was generated. Generate again before cutting.');
    // ...and names the input when the run recorded one.
    const named = hubFor(job, { generated: generatedWith({}), staleSince: 1, staleReason: 'machine' });
    expect(named.policyRows[0]!.message).toBe('The machine frame changed since it was generated. Generate again before cutting.');
  });

  it('states a stale package with the freeze time and the package owner`s reason, holding the blank', () => {
    const job = dj();
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
    expect(report.policyRows[0]!.message).toContain('The frozen plan from 14:02 is out of date');
    expect(report.policyRows[0]!.message).toContain('Its blank stays held for this job.');
    expect(report.firstBlocking?.code).toBe('package-stale');
  });

  it('does not call a run stale when no Generate has produced anything', () => {
    const report = hubFor(dj(), { staleSince: Date.now() });
    expect(report.policyRows).toEqual([]);
  });
});

describe('preflightHub: the page order and the first block', () => {
  it('keeps the hub`s order: policy rows, then every scope`s rows, never re-sorted', () => {
    const job = twoSetups(dj(), ['user:flat-1-a', TOOL_B]);
    const report = hubFor(job);
    expect(report.rows).toEqual([
      ...report.policyRows,
      ...report.scopes.flatMap((g) => g.rows),
    ]);
    expect(report.firstBlocking).toBe(report.rows.find((r) => r.severity === 'error'));
  });

  it('counts a warning without treating it as blocking', () => {
    const job = dj();
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
