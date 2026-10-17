// The preflight COLLECTOR (#419 §2.2). One case per owner wired, and every case asserts the same
// thing: what the gate reports is the OWNER'S own `code` and its OWN `message`, byte for byte —
// not a re-wording written here. That is the rule the whole directory exists to hold, so it is
// what these tests check.
//
// Pure data: no wasm, no React, no worker, no store. Every job comes from `defaultEngraveJob` and
// every report from the real owner function, so nothing in a fixture can flatter the collector.

import { describe, it, expect } from 'vitest';
import locationDoc from './fixtures/location-doc.json';

import { collect, type PreflightInput, type PreflightRow } from '@/engine/cnc/preflight';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { dedupeFindings, validateJob, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { validateVise } from '@/engine/cnc/fixture';
import { noneSacrificial, validateSacrificial } from '@/engine/cnc/sacrificial';
import { reachabilityFor } from '@/engine/cnc/engrave/reachability';
import { stockDepthLimit, verifyProgram, type VerifyContext } from '@/engine/cnc/verify';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { stubSetup } from '@/engine/cnc/setup';
import { rectProfile } from '@/engine/compiler/profile';
import { saveBlocker, type EngraveRunView } from '@/store/engraveRunGate';
import { StockItemSchema, type StockItem } from '@/platform/stockClient';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { EngraveJob, Sacrificial } from '@/types/engraveJob';

/**
 * The gate, asked the plan's four questions (§2.2) and nothing else. The scope is setup 0 and the
 * job's own cutter — what a single-setup job IS, stated by the caller rather than defaulted by the
 * collector (#419 §3.2).
 */
function rowsFor(job: EngraveJob, over: Partial<PreflightInput> = {}): PreflightRow[] {
  return collect({
    scope: { setupIndex: 0, toolKey: job.toolKey },
    job,
    generated: null,
    calibration: null,
    shelfItem: null,
    ...over,
  });
}

/**
 * The rows carrying a code. The fixtures below pick codes that only one owner raises, which is what
 * lets `[0]` be *the* row — nothing here ENFORCES that, and the collector does not either: its
 * de-duplication key is `severity|code|labelId|message`, with no owner in it, so two owners raising
 * one code with one sentence would collapse to whichever was seen first. That is deliberate (the key
 * is `dedupeFindings`'s, and two byte-identical sentences ARE one finding), and it is why the
 * fixtures avoid codes two owners can share.
 */
const withCode = (rows: PreflightRow[], code: string): PreflightRow[] => rows.filter((r) => r.code === code);

/** A generated result whose only interesting part is a verifier report. */
function generatedWith(over: Partial<EngraveGenerated>): EngraveGenerated {
  return {
    ok: true,
    stage: 'done',
    findings: [],
    feeds: null,
    threads: null,
    cam: null,
    nc: 'G90 G21\n',
    verify: null,
    frameNc: null,
    frameVerify: null,
    facingNc: null,
    facingVerify: null,
    facingToolKey: null,
    facingError: null,
    predicted: [],
    programs: [],
    errors: [],
    ...over,
  };
}

/**
 * The run view the collector hands `saveBlocker` — real in `generated` only, everything else blank as
 * `collect.ts`'s `NO_RUN_VIEW` blanks it. Written out here so the assertions compare against the
 * GATE's own sentence reached the same way, rather than against a literal the spec made up.
 */
function viewWith(generated: EngraveGenerated | null): EngraveRunView {
  return {
    generated,
    oracle: null,
    simDiagnostics: [],
    simStatus: null,
    phase: 'idle',
    acknowledged: false,
    staleSince: null,
    error: null,
  };
}

/** The verifier's context for a 20 × 10 × 5 blank, as `cncVerify.spec.ts` builds it. */
const VERIFY_STOCK = { length: 20, width: 10, thickness: 5 };
const VERIFY_CTX: VerifyContext = {
  setup: stubSetup(
    { kind: 'prism', outline: rectProfile(VERIFY_STOCK.length, VERIFY_STOCK.width), thickness: VERIFY_STOCK.thickness },
    { kind: 'tape-down', contact: rectProfile(VERIFY_STOCK.length, VERIFY_STOCK.width) },
    { startingTool: 1 },
    Z1,
  ),
  machine: Z1,
  tool: flatEndMill(1),
  depthLimit: stockDepthLimit(VERIFY_STOCK, 1),
  minRapidZ: 1,
};

describe('preflight: the job as data (validateJob)', () => {
  it('carries every finding of the owner, with the owner`s own code and message', () => {
    const job = defaultEngraveJob();
    job.labels[0]!.depth = 100; // far past the 12 mm stock`s floor: `depth-exceeds-stock`.
    const expected = validateJob(job);
    expect(expected.some((f) => f.code === 'depth-exceeds-stock')).toBe(true);

    const rows = rowsFor(job);
    for (const finding of expected) {
      const row = rows.find(
        (r) => r.owner === 'jobSetup' && r.code === finding.code && r.message === finding.message,
      );
      expect(row, `jobSetup must surface ${finding.code} verbatim`).toBeDefined();
      expect(row!.severity).toBe(finding.severity);
    }
  });

  it('carries the item the finding points at as the cause, when the owner named one', () => {
    const job = defaultEngraveJob();
    job.labels[0]!.depth = 100;
    const expected = validateJob(job).find((f) => f.code === 'depth-exceeds-stock')!;

    const row = withCode(rowsFor(job), 'depth-exceeds-stock')[0]!;
    expect(row.cause.labelId).toBe(expected.labelId);
  });
});

describe('preflight: the work-holding', () => {
  it('surfaces `validateVise`, which `validateJob` never raises', () => {
    const job = defaultEngraveJob();
    job.workholding.vise.stockProud = 100; // ≥ the 12 mm stock: nothing is left in the jaws.
    const expected = validateVise(job.stock, job.workholding.vise, job.sacrificial).find(
      (f) => f.code === 'vise-stock-proud-exceeds-thickness',
    );
    expect(expected).toBeDefined();
    // The owner really is `validateVise`: `validateJob` does not raise this one (#353).
    expect(validateJob(job).some((f) => f.code === expected!.code)).toBe(false);

    const row = withCode(rowsFor(job), expected!.code)[0]!;
    expect(row.owner).toBe('fixture');
    expect(row.message).toBe(expected!.message);
    expect(row.severity).toBe(expected!.severity);
  });

  it('surfaces `validateSacrificial`, and reports it ONCE though `validateJob` re-emits it', () => {
    const sides = { ...noneSacrificial().sides, left: { thickness: 6, height: 20 } };
    const job: EngraveJob = { ...defaultEngraveJob(), sacrificial: { ...noneSacrificial(), sides } as Sacrificial };
    const expected = validateSacrificial(job).find((f) => f.code === 'strip-taller-than-part');
    expect(expected).toBeDefined();
    // The overlap the merge has to survive: `validateJob` pushes the SAME finding itself.
    expect(validateJob(job).some((f) => f.code === 'strip-taller-than-part')).toBe(true);

    const rows = withCode(rowsFor(job), 'strip-taller-than-part');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner).toBe('sacrificial');
    expect(rows[0]!.message).toBe(expected!.message);
  });
});

describe('preflight: the program (the verifier, or the gate before one exists)', () => {
  it('carries the verifier report`s findings verbatim, with their line as the cause', () => {
    // The report is the OWNER`s: `verifyProgram` on the text, as a Generate would run it.
    const report = verifyProgram('G2 X0 Y0', VERIFY_CTX);
    expect(report.findings.length).toBeGreaterThan(0);

    const rows = rowsFor(defaultEngraveJob(), { generated: generatedWith({ verify: report }) }).filter(
      (r) => r.owner === 'verify',
    );
    expect(rows.map((r) => r.message)).toEqual(report.findings.map((f) => f.message));
    expect(rows.map((r) => r.code)).toEqual(report.findings.map((f) => f.code));
    expect(rows.map((r) => r.severity)).toEqual(report.findings.map((f) => f.severity));
    expect(rows.map((r) => r.cause.line)).toEqual(report.findings.map((f) => f.line));
  });

  it('reads BOTH verifier reports — the job`s and the frame file`s', () => {
    // #244: the frame is a SECOND file the machine runs, traced in the air at its own Z, and its
    // report is a second owner answer. `verifyProgram` on one malformed program is used for both
    // reports here, so the count alone says whether the frame's was read at all.
    const report = verifyProgram('G2 X0 Y0', VERIFY_CTX);
    expect(report.findings.length).toBeGreaterThan(0);

    const rows = rowsFor(defaultEngraveJob(), {
      generated: generatedWith({ verify: report, frameVerify: report }),
    }).filter((r) => r.owner === 'verify');
    expect(rows).toHaveLength(report.findings.length * 2);
  });

  it('with no Generate, reports the GATE`s own sentence rather than a re-worded one', () => {
    const rows = rowsFor(defaultEngraveJob()); // generated: null — Cut requires a Generate (§2.2).
    const row = rows.find((r) => r.owner === 'engraveRunGate')!;
    expect(row).toBeDefined();
    expect(row.message).toBe(saveBlocker(viewWith(null)));
    expect(row.code).toBe('no-generate');
  });

  it('BLOCKS a Generate that RAN and produced no program, instead of reading as clean', () => {
    // The review`s finding (2026-10-16). `generated !== null` used to be enough to skip the gate`s
    // sentence, so a Generate that stopped at the feeds, the CAM or the post — every `stop(...)` in
    // `engraveGenerate` leaves `nc` null — left Cut green with NO PROGRAM. Asserted against the
    // gate`s own sentence reached through a real view, and against the words, so a future reword is
    // a failure here rather than a silent drift.
    const stopped = generatedWith({ ok: false, stage: 'feeds', nc: null });
    const row = rowsFor(defaultEngraveJob(), { generated: stopped }).find(
      (r) => r.owner === 'engraveRunGate',
    )!;
    expect(row).toBeDefined();
    expect(row.message).toBe(saveBlocker(viewWith(stopped)));
    expect(row.message).toBe('no program was produced');
    expect(row.severity).toBe('error');
  });

  it('BLOCKS a run that produced a program but not its frame file, and says why', () => {
    // The review`s other finding (2026-10-16), and the one the gate CANNOT state: `saveBlocker` reads
    // `nc`, `findings` and `verify` and never `ok` or `errors`, so with a program in hand it says
    // nothing about the frame that was never built. The Generate states it in `errors`, and that
    // sentence is what `no-frame` carries — byte for byte, under the Generate`s own tag.
    // A program of ours that the verifier accepts, in the post's own order (#384/#396): the machine-
    // frame lift, then the spindle, then the moves. Asserted clean so the fixture cannot drift into
    // being a case this test is not about.
    const clean = verifyProgram(
      ['G90 G21', 'T1 M6', 'M331', 'G53 G0 Z-3', 'S12000 M3', 'G0 X5 Y5', 'G1 Z-1 F200', 'G1 X10', 'M5', 'M02'].join('\n'),
      VERIFY_CTX,
    );
    expect(clean.findings).toEqual([]);
    const why = 'the frame file could not be produced: the job has no extent to trace';
    const stopped = generatedWith({
      ok: false,
      stage: 'verify',
      nc: 'G90 G21\n',
      verify: clean,
      errors: [{ stage: 'verify', message: why }],
    });

    const rows = rowsFor(defaultEngraveJob(), { generated: stopped });
    const row = rows.find((r) => r.code === 'no-frame')!;
    expect(row).toBeDefined();
    expect(row.owner).toBe('generate');
    expect(row.message).toBe(why);
    expect(row.severity).toBe('error');

    // Why this had to be a row of its own: the gate is asked only when there is NO program, and
    // asking it here would put a RUN`s sentence on a job nobody has run — this blank view says the
    // simulation did not finish precisely because it holds no run.
    expect(rows.some((r) => r.owner === 'engraveRunGate')).toBe(false);
    expect(saveBlocker(viewWith(stopped))).toBe('the simulation did not finish');
  });

  it('carries the Generate`s own reason when it stopped with no program at all', () => {
    // `saveBlocker` answers "no program was produced" — true, and no help. WHY is only ever in the
    // Generate`s `errors`, which the gate never reads, so the collector carries it: the two rows
    // state two different things and both belong on the gate.
    const why = 'the post refused: G53 is not supported by this dialect';
    const stopped = generatedWith({
      ok: false,
      stage: 'post',
      nc: null,
      errors: [{ stage: 'post', message: why }],
    });

    const rows = rowsFor(defaultEngraveJob(), { generated: stopped });
    const mine = rows.filter((r) => r.owner === 'generate');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.code).toBe('generate-stopped');
    expect(mine[0]!.message).toBe(why);

    const gate = rows.find((r) => r.owner === 'engraveRunGate')!;
    expect(gate.code).toBe('no-generate');
    expect(gate.message).toBe('no program was produced');
  });

  it('does not re-state a stoppage the verifier has already spoken for', () => {
    // The one exclusion: when a report found the errors, every one of them is already a row above,
    // with its line, and the Generate`s own summary of them would be a vaguer second copy. Both
    // reports are tried, because the frame`s is a report too.
    const report = verifyProgram('G2 X0 Y0', VERIFY_CTX);
    const n = report.findings.filter((f) => f.severity === 'error').length;
    expect(n).toBeGreaterThan(0);
    const summary = `${n} verifier error(s)`;

    const job = defaultEngraveJob();
    const program = rowsFor(job, {
      generated: generatedWith({ ok: false, stage: 'verify', nc: 'G90 G21\n', verify: report, errors: [{ stage: 'verify', message: summary }] }),
    });
    expect(program.filter((r) => r.owner === 'verify')).toHaveLength(n);
    expect(program.some((r) => r.code === 'generate-stopped' || r.code === 'no-frame')).toBe(false);

    const frame = rowsFor(job, {
      generated: generatedWith({ ok: false, stage: 'verify', nc: 'G90 G21\n', frameNc: 'G90\n', frameVerify: report, errors: [{ stage: 'verify', message: summary }] }),
    });
    expect(frame.filter((r) => r.owner === 'verify')).toHaveLength(n);
    expect(frame.some((r) => r.code === 'generate-stopped' || r.code === 'no-frame')).toBe(false);
  });

  it('says nothing from the gate while a program exists', () => {
    // The other half, and the reason the two states above are the ONLY ones asked: the gate`s later
    // clauses (the sweep`s status, the prediction) are the run`s to answer and a blanked view would
    // reach them, putting "the simulation did not finish" on a run nobody asked about.
    const rows = rowsFor(defaultEngraveJob(), { generated: generatedWith({}) });
    expect(rows.some((r) => r.owner === 'engraveRunGate')).toBe(false);
  });
});

describe('preflight: the Generate`s own findings (the worker-only families)', () => {
  it('surfaces a geometry finding no engine owner can compute, so it is not a clean gate', () => {
    // `item-over-void` needs a CrossSection opened in wasm, so no engine call can raise it: the ONLY
    // place it exists is the Generate's own list. Before this merge the collector refused to read
    // that list, so a job whose sole error was this one read as a clean gate (review, 2026-10-16).
    const job = defaultEngraveJob();
    const geometry: JobFinding = {
      severity: 'error',
      code: 'item-over-void',
      labelId: job.labels[0]!.id,
      message: 'The item crosses a void in the stock.',
    };
    const rows = rowsFor(job, {
      generated: generatedWith({ ok: false, stage: 'findings', nc: null, findings: [geometry] }),
    });

    const row = rows.find((r) => r.owner === 'generate')!;
    expect(row).toBeDefined();
    expect(row.code).toBe('item-over-void');
    expect(row.message).toBe(geometry.message);
    expect(row.severity).toBe('error');
    expect(row.cause.labelId).toBe(job.labels[0]!.id);

    // …and the gate states its own verdict for the same state, which is exactly why the row above
    // has to exist: the gate COUNTS the stoppage, it does not name it. (`stop('findings')` pushes no
    // sentence of its own — the findings ARE the reason — so there is no `generate-stopped` row.)
    const gate = rows.find((r) => r.owner === 'engraveRunGate')!;
    expect(gate.code).toBe('no-generate');
    expect(gate.message).toBe('1 error outstanding');
    expect(gate.message).toBe(saveBlocker(viewWith(generatedWith({ ok: false, stage: 'findings', nc: null, findings: [geometry] }))));
    expect(rows.some((r) => r.code === 'generate-stopped')).toBe(false);
  });

  it('does NOT re-report the job`s own findings through the list the Generate carries them in', () => {
    // The list the Generate hands over is the WORKER'S REAL ONE (`engraveGenerate.ts`):
    // `dedupeFindings([...validateJob, ...validateVise, ...the geometry families])` — so a copy of
    // `validateJob`'s and `validateVise`'s findings arrives here beside the owners that state them.
    // The engine owners are asked first and the merge key is byte-exact, so those copies must
    // collapse onto their owners — one row each, keeping the ENGINE owner's tag — and only the
    // families no owner states may survive carrying `generate`. Both owners are exercised, because
    // `validateVise` is the one whose findings ride in that list while being nobody else's.
    const job = defaultEngraveJob();
    job.labels[0]!.depth = 100; // `depth-exceeds-stock`, raised by `validateJob`.
    job.workholding.vise.stockProud = 100; // `vise-stock-proud-exceeds-thickness`, `validateVise`'s.
    const worker = dedupeFindings([
      ...validateJob(job),
      ...validateVise(job.stock, job.workholding.vise, job.sacrificial),
    ]);
    expect(worker.some((f) => f.code === 'depth-exceeds-stock')).toBe(true);
    expect(worker.some((f) => f.code === 'vise-stock-proud-exceeds-thickness')).toBe(true);

    const rows = rowsFor(job, {
      generated: generatedWith({ ok: false, stage: 'findings', nc: null, findings: worker }),
    });

    const deep = withCode(rows, 'depth-exceeds-stock');
    expect(deep).toHaveLength(1);
    expect(deep[0]!.owner).toBe('jobSetup');
    const proud = withCode(rows, 'vise-stock-proud-exceeds-thickness');
    expect(proud).toHaveLength(1);
    expect(proud[0]!.owner).toBe('fixture');
    expect(rows.some((r) => r.owner === 'generate')).toBe(false);
  });
});

describe('preflight: reach (recommendTool`s verdict)', () => {
  it('surfaces the owner`s reason when no cutter on the bench can take the job', () => {
    const job = defaultEngraveJob();
    // The real owner, given a bench with nothing on it — `recommendTool` answers with `key: null`.
    const reach = reachabilityFor(job, [], [], () => []);
    expect(reach.recommendation.key).toBeNull();

    const row = rowsFor(job, { reach }).find((r) => r.owner === 'reach')!;
    expect(row).toBeDefined();
    expect(row.message).toBe(reach.recommendation.reason);
    expect(row.severity).toBe('error');
  });
});

describe('preflight: the stock (the shelf entry)', () => {
  const SHELF: StockItem[] = (locationDoc as { stock: unknown[] }).stock.map((s) => StockItemSchema.parse(s));
  const CONSUMED = SHELF.find((s) => s.id === 'stock-blank1')!;

  it('surfaces `stockFromShelf` refusal verbatim', () => {
    const row = rowsFor(defaultEngraveJob(), { shelfItem: CONSUMED }).find((r) => r.owner === 'stockStart')!;
    expect(row).toBeDefined();
    expect(row.message).toBe('none left — consumed by job-12');
    expect(row.code).toBe('stock-refusal');
  });

  it('says nothing about the stock when the job`s stock did not come from the shelf', () => {
    expect(rowsFor(defaultEngraveJob()).some((r) => r.owner === 'stockStart')).toBe(false);
  });
});

describe('preflight: the shape of the gate (not a rule, just its contract)', () => {
  it('returns every row carrying an owner, a code and a message', () => {
    const job = defaultEngraveJob();
    job.labels[0]!.depth = 100;
    const rows = rowsFor(job);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.owner).toBeTruthy();
      expect(row.code).toBeTruthy();
      expect(row.message.length).toBeGreaterThan(0);
      expect(['error', 'warning']).toContain(row.severity);
      // §2.2/§7: the hub`s scroll target is deliberately unresolved, so it is always null here.
      expect(row.cause.hubTarget).toBeNull();
      // The scope the call was made for, copied onto every row — this call asked about setup 0 and
      // the job`s own cutter.
      expect(row.cause.setupIndex).toBe(0);
      expect(row.cause.toolKey).toBe(job.toolKey);
    }
  });

  it('stamps the scope it is handed, and changes nothing else about the answer (#419 §3.2)', () => {
    // The hub loops `(setupIndex, tool)` and owns the aggregate; the collector`s one job is to say
    // which iteration a row came from. So the same job asked about two scopes must return the same
    // rows with only the pair changed — anything else would mean the scope reached into a rule.
    const job = defaultEngraveJob();
    job.labels[0]!.depth = 100;
    const first = rowsFor(job);
    const second = collect({
      scope: { setupIndex: 1, toolKey: 'v-bit-0.3-30' },
      job,
      generated: null,
      calibration: null,
      shelfItem: null,
    });
    expect(second.length).toBe(first.length);
    for (const row of second) {
      expect(row.cause.setupIndex).toBe(1);
      expect(row.cause.toolKey).toBe('v-bit-0.3-30');
    }
    const withoutScope = (rows: PreflightRow[]) =>
      rows.map(({ cause, ...row }) => ({ ...row, cause: { ...cause, setupIndex: undefined, toolKey: undefined } }));
    expect(withoutScope(second)).toEqual(withoutScope(first));
    // A rebuild of one scope is still deterministic.
    expect(rowsFor(job)).toEqual(first);
  });

  it('is deterministic: one job, one answer, twice', () => {
    const job = defaultEngraveJob();
    job.labels[0]!.depth = 100;
    expect(rowsFor(job)).toEqual(rowsFor(job));
  });
});
