/**
 * The PREFLIGHT HUB (#419 §3) — the Cut gate's aggregate.
 *
 * `collect.ts` answers for ONE `(setupIndex, tool)` scope and deliberately adds no rule. This module
 * owns everything that is a property of the JOB rather than of one scope:
 *
 *  - **the loop.** One `collect()` per `(setupIndex, tool)`, setups in the job's order and each
 *    setup's tools in their order. The scopes come from `jobSetups`, the same reader the generator
 *    and the package use, so the gate asks about the programs the run would actually have.
 *  - **the scope's own program.** The Generate returns the job's programs as a list; each scope is
 *    judged against the program written for it, not against the top-level adapter (which always
 *    describes program 1). A scope with no program is asked with `nc: null`, so the collector's
 *    `no-generate` / `generate-stopped` rows fire where a file is actually missing.
 *  - **the two RUN-policy rows.** Whether the generated result still describes the job
 *    (`staleSince`) and whether the frozen package still does (`packageStaleness`) are facts about
 *    the run, not the job. The collector takes neither, so the hub states them — under owner
 *    `'run'`, as policy, not as a new check.
 *  - **the first blocking reason.** The collector returns rows in a stable owner order and leaves
 *    "which one leads" to the consumer (§5.6). The hub takes the first `error` in page order; it
 *    never re-sorts, so the answer does not move between keystrokes.
 *
 * PURE and synchronous, like the collector: the panel runs it on render, so pressing Cut always
 * asks the owners again rather than replaying a stored verdict.
 *
 * WHAT IT DOES NOT DO. It does not freeze a package, take stock, plan a run, or read a store. Its
 * inputs are the data those operations produce, handed in by the Cut surface. That keeps the gate
 * testable without wasm, a service or a machine.
 */

import type { EngraveJob } from '@/types/engraveJob';
import { staleSentence, type EngraveInputKey } from '@/engine/cnc/engrave/runInputs';
import type { BedUnderFacts } from '@/engine/cnc/engrave/jobSetup';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import type { StockItem } from '@/platform/stockClient';
import type { Reachability } from '@/engine/cnc/engrave/reachability';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import { packageStaleness, type FrozenPackage } from '@/engine/cnc/engrave/package';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { collect } from './collect';
import type { PreflightCause, PreflightRow, PreflightScope } from './types';

/** Everything the hub's loop and its two policy rows are asked about. */
export interface PreflightHubInput {
  /** The job as the Design surface holds it. */
  job: EngraveJob;
  /** The last Generate's result, or null before one has run. */
  generated: EngraveGenerated | null;
  /**
   * The run store's stale mark (`EngraveRunView.staleSince`) — non-null when the job or the machine
   * frame changed after the Generate. It is in-memory by design; the hub reads it, it does not own it.
   */
  staleSince: number | null;
  /**
   * #581 — which input moved under the result (`EngraveRunView.staleReason`), when the caller knows.
   * Absent keeps the generic sentence: the row is still true, just less specific.
   */
  staleReason?: EngraveInputKey | null;
  /**
   * The frozen package for this job, or null when nothing has been frozen. A stale package is an
   * error row here **and keeps its blank**: the hub only says so, it never releases anything
   * (decision 2).
   */
  package: FrozenPackage | null;
  /** The saved machine calibration; the stock owner and the gate both resolve the job's profile through it. */
  calibration: MachineCalibration | null;
  /**
   * The shelf entry the job's stock came from, or null (not a shelf pick, or not resolved yet).
   * The Cut surface resolves `job.stockEntry.shelfId` against the shelf; the hub does not read stores.
   */
  shelfItem: StockItem | null;
  /**
   * The reachability table, when the caller has measured one. Null leaves `recommendTool`'s verdict
   * unstated rather than guessing it (see `collect.ts`'s OWNERS NOT WIRED).
   */
  reach?: Reachability | null;
  /**
   * #735 — what the machine's bed carries under the stock, read by the Cut surface from the active
   * bed profile (`bedUnderFacts`, #712). It is handed to every scope's collector, so the through-cut
   * owner judges a taped job by the bed it is taped to; absent (`null`/`undefined`) keeps the
   * pre-#712 sentences. The hub reads no store, so this arrives as data like the rest.
   */
  bed?: BedUnderFacts | null;
}

/** One scope's rows, in the collector's own order. */
export interface PreflightScopeRows {
  scope: PreflightScope;
  rows: PreflightRow[];
}

/** The gate as the preflight page and the switch read it. */
export interface PreflightHubReport {
  /**
   * The hub's own run-policy rows (`generated-stale`, `package-stale`), before any scope. They are
   * job-wide, so the page draws them outside the per-scope groups; their `cause` carries the first
   * scope's address only because {@link PreflightCause} requires one.
   */
  policyRows: PreflightRow[];
  /** One group per `(setupIndex, tool)`, in the job's setup and tool order. */
  scopes: PreflightScopeRows[];
  /** Page order: the policy rows, then every scope's rows in scope order. */
  rows: PreflightRow[];
  /** The first `error` in {@link PreflightHubReport.rows}, or null when nothing blocks. */
  firstBlocking: PreflightRow | null;
  errorCount: number;
  warningCount: number;
}

/**
 * The gate for the whole job: one collector call per `(setupIndex, tool)`, plus the hub's policy.
 *
 * `setupIndex` is ZERO-based here (the collector's `PreflightScope` contract), while a generated
 * program's own `setupIndex` is one-based (the operator's "Setup 2"). The conversion happens once,
 * below, at the match.
 */
export function preflightHub(input: PreflightHubInput): PreflightHubReport {
  const setups = jobSetups(input.job);

  // The scopes, in the order §5.6 asks for: setups in the job's order, then each setup's tools.
  //
  // A setup naming no cutter contributes no scope — there is no `(setup, tool)` to ask about — but
  // its `setup-no-tool` finding is not lost: `validateJob` carries it into every scope's rows as
  // job-as-data. A job that yields NO scope at all — no stored setups, or only setups that name no
  // cutter (the tool-less default of #516 item 5) — falls back to the single scope such a job would
  // have, so the gate is never vacuously green for want of anything to iterate.
  const namedScopes: PreflightScope[] = setups.flatMap((setup, i) =>
    setup.tools.map((toolKey) => ({ setupIndex: i, toolKey })),
  );
  const scopes: PreflightScope[] =
    namedScopes.length === 0 ? [{ setupIndex: 0, toolKey: input.job.toolKey }] : namedScopes;

  const groups: PreflightScopeRows[] = scopes.map((scope) => ({
    scope,
    rows: collect({
      scope,
      job: input.job,
      generated: generatedForScope(input.generated, scope),
      calibration: input.calibration,
      shelfItem: input.shelfItem,
      reach: input.reach ?? null,
      bed: input.bed ?? null,
    }),
  }));

  const policyRows = runPolicyRows(input, scopes[0] ?? { setupIndex: 0, toolKey: input.job.toolKey });
  const rows = [...policyRows, ...groups.flatMap((g) => g.rows)];

  return {
    policyRows,
    scopes: groups,
    rows,
    firstBlocking: rows.find((r) => r.severity === 'error') ?? null,
    errorCount: rows.filter((r) => r.severity === 'error').length,
    warningCount: rows.filter((r) => r.severity === 'warning').length,
  };
}

/**
 * The Generate's answer as ONE scope sees it.
 *
 * A scope with a program is judged on that program: its own text, verifier report, frame and frame
 * report, and `ok: true` — the scope's file exists and verified, whatever another setup did. Its
 * job-wide `findings` stay (the result does not attribute them to a setup, so the hub does not
 * invent an address for them); they are de-duplicated against the engine owners by `collect()`
 * itself.
 *
 * A scope with NO program is asked with no file. `ok` and `errors` stay the Generate's, so the
 * collector can say WHY the file is missing (`generate-stopped`) as well as that it is
 * (`no-generate`). This is the distinction the 2026-10-16 review made blocking: a Generate that
 * ran and stopped must not read as a clean gate.
 */
function generatedForScope(generated: EngraveGenerated | null, scope: PreflightScope): EngraveGenerated | null {
  if (generated === null) return null;
  const program = generated.programs.find(
    (p) => p.setupIndex === scope.setupIndex + 1 && p.toolKey === scope.toolKey,
  );
  if (program === undefined) {
    return { ...generated, nc: null, verify: null, frameNc: null, frameVerify: null, frameZ: null, frameError: null };
  }
  return {
    ...generated,
    ok: true,
    errors: [],
    nc: program.nc,
    verify: program.verify,
    frameNc: program.frameNc,
    frameVerify: program.frameVerify,
    // #747 — the frame facts are PROGRAM facts, like the file and its report; a scope must not
    // report program 1's withheld frame against setup 2.
    frameZ: program.frameZ ?? null,
    frameError: program.frameError ?? null,
  };
}

/**
 * The two rows that are about the RUN rather than the job, in the order they are decided: a stale
 * Generate first (everything below it describes a job that no longer exists), then a stale package.
 *
 * Neither is a rule this module invented. `staleSince` is the run store's own mark, set when the
 * job changes after a Generate; `packageStaleness` is `package.ts`'s by-value comparison. The hub
 * only puts them on the same page as the collector's rows.
 */
function runPolicyRows(input: PreflightHubInput, firstScope: PreflightScope): PreflightRow[] {
  const rows: PreflightRow[] = [];
  const cause = (): PreflightCause => ({
    setupIndex: firstScope.setupIndex,
    toolKey: firstScope.toolKey,
    hubTarget: null,
  });

  if (input.generated !== null && input.staleSince !== null) {
    rows.push({
      severity: 'error',
      code: 'generated-stale',
      message: `${staleSentence(input.staleReason).replace(/^the /, 'The ')}. Generate again before cutting.`,
      owner: 'run',
      cause: cause(),
    });
  }

  if (input.package !== null) {
    const staleness = packageStaleness(input.package, input.job);
    if (staleness.stale) {
      rows.push({
        severity: 'error',
        code: 'package-stale',
        message:
          `The frozen plan from ${clockOf(input.package.frozenAt)} is out of date — ${staleness.reason ?? 'the job changed since it was frozen.'} ` +
          'Its blank stays held for this job.',
        owner: 'run',
        cause: cause(),
      });
    }
  }

  return rows;
}

/**
 * "14:02" from the package's ISO timestamp, without a locale: the sentence the operator reads is
 * the same on every machine, and a spec can pin it. The full date and zone remain in the package.
 */
function clockOf(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m?.[1] ?? iso;
}
