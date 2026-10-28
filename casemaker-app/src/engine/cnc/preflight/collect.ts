/**
 * The preflight COLLECTOR (#419 §2.2) — the Cut gate's rows.
 *
 * **It adds no rule.** Every row it returns was computed by an owner: `validateJob`,
 * `validateVise`, `validateSacrificial`, `recommendTool`, `verifyProgram`, `stockFromShelf`,
 * `saveBlocker`, and — for the families only the worker can compute — the findings the Generate has
 * already returned ({@link PreflightOwner}'s `'generate'`). `collect()` calls each one (or copies the
 * Generate's answer) and normalises it into a {@link PreflightRow}, keeping the owner's own `code`
 * and its own `message` byte for byte. There is deliberately not one `if` in this file that decides
 * whether something is wrong — every such decision is `if (the owner said so)`. If a new check is
 * wanted it belongs in the owner, not here.
 *
 * PURE and synchronous: no wasm, no store state, no worker. That is what lets the hub run the gate on
 * a keystroke. The two worker-bound owners reach it as DATA and never as calls — the reach TABLE as
 * `PreflightInput.reach`, the geometry findings on the Generate's own result — so see OWNERS NOT
 * WIRED at the bottom for what each one costs and what remains out of reach.
 *
 * ONE SETUP-AND-TOOL SCOPE, and the hub loops. Cut is being built on a MULTI-SETUP job — several
 * setups (#428's planner, #429/#430's remount registration) each carrying one program per tool
 * (#410) — not on the plan's rejected 1-setup v1. `collect()` answers for the scope it is handed:
 * one job, one cutter, one setup. The hub's gate runs it ONCE PER `(setupIndex, tool)` and keys the
 * aggregate on that pair (§5.6's "runs the gate for every (setup, tool) in order, each later sweep
 * on the earlier result"). Nothing here aggregates: mounting the setups engine later is a caller's
 * loop over this function, not a rewrite of it, and {@link PreflightCause.setupIndex} /
 * {@link PreflightCause.toolKey} are the row-level address that carries which scope an answer came
 * from.
 *
 * THE SCOPE IS THE CALLER'S. `PreflightInput.scope` ({@link PreflightScope}) names the setup index
 * and cutter key this call answers for, and every row comes back carrying that pair in its `cause`.
 * The collector reads no `setups[]` of its own — a collector that parsed the job's setup list would
 * be a second planner. A job that carries no setups is not a special case: its caller states
 * `{ setupIndex: 0, toolKey: job.toolKey }`, which is the scope such a job has. The loop, the
 * aggregate and "each later sweep on the earlier result" (§5.6) are the hub's.
 */

import type { EngraveJob } from '@/types/engraveJob';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import { jobMachine } from '@/engine/cnc/calibration';
import { validateJob, type BedUnderFacts, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { validateVise } from '@/engine/cnc/fixture';
import { validateSacrificial } from '@/engine/cnc/sacrificial';
import { stockFromShelf } from '@/engine/cnc/stockStart';
import type { Reachability } from '@/engine/cnc/engrave/reachability';
import type { VerifyReport } from '@/engine/cnc/verify';
import { gateViewFor, saveBlocker, type EngraveRunView } from '@/store/engraveRunGate';
import type { StockItem } from '@/platform/stockClient';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { PreflightCause, PreflightOwner, PreflightRow, PreflightScope } from './types';

/**
 * Everything the gate is asked about (#419 §2.2).
 *
 * The first four fields are the plan's: the job, the generated program (or `null`), the machine
 * calibration and the stock entry. `reach` is an addition — see its own note and 'OWNERS NOT
 * WIRED' below; it is optional, and its absence costs the gate exactly the rows it could not have
 * computed anyway.
 *
 * THIS IS ONE SCOPE, NOT THE WHOLE JOB. Every field describes a single setup-and-tool scope — the
 * one whose program `generated` holds and whose cutter `reach` measured — so the type is the input
 * to ONE iteration of the hub's `(setupIndex, tool)` loop, not to the aggregate. `scope` is what
 * makes that explicit: the caller states which setup and cutter it is asking about, and the
 * collector stamps that pair onto every row it returns.
 */
export interface PreflightInput {
  /** The setup-and-tool scope this answer is for; every returned row carries it in `cause`. */
  scope: PreflightScope;
  /**
   * The job, as the Design surface holds it. The same job object may be handed to every iteration —
   * `scope`, not this field, says which of its setups is under test — so the collector never has to
   * decide how a setup narrows the job.
   */
  job: EngraveJob;
  /**
   * The last Generate's result, or `null` before any Generate has run (§2.2: Cut requires a
   * Generate). Three things are read off it: its verifier reports (`verify` and `frameVerify`), its
   * own `findings` (see below), and whether it produced a program at all (`nc`).
   *
   * **ITS `findings` ARE READ, and merged LAST.** They are the families no engine owner can compute —
   * `engraveGeometry.ts`'s geometry findings (`item-over-void`, `item-outside-stock`,
   * `item-depth-bound`, …) — but the list ALSO carries `validateJob`'s and `validateVise`'s findings,
   * which `engraveGenerate` merges in before returning. Merging it under the byte-exact key the
   * engine owners' rows already use collapses those copies onto their real owners and leaves only the
   * families nothing else states. An earlier revision refused to read the list at all, to avoid that
   * re-report; the cost was that a job whose only errors were geometry ones read as a CLEAN gate,
   * which is the one thing a gate may not do (review, 2026-10-16).
   *
   * **STALENESS IS NOT VISIBLE HERE.** Whether this result still describes the job — the run store's
   * `staleSince` — is the RUN's to answer, and this input carries no run: a report from an edit ago
   * arrives looking exactly like a fresh one. `collect()` therefore cannot say "this is stale", and a
   * caller must not read the ABSENCE of such a row as "this is current". The hub, which owns the run
   * view, is where that statement belongs; it is not invented here.
   */
  generated: EngraveGenerated | null;
  /** The saved machine calibration; the stock owner and the gate both resolve the job's profile through it. */
  calibration: MachineCalibration | null;
  /**
   * The SHELF ENTRY the job's stock came from — `job.stockEntry.shelfId` resolved against the
   * location's shelf by the caller. `null` when the job's stock did not come from the shelf (or the
   * caller has not resolved it), in which case `shelfPickProblem` has no subject and is not asked.
   */
  shelfItem: StockItem | null;
  /**
   * The reachability table (#410), when the caller has measured one — `reachabilityFor(...)` bound
   * to the worker's `measureLabels` is the only thing that can build it, so it arrives here as
   * data. `null`/absent leaves `recommendTool`'s verdict unstated, which is honest: nothing has
   * been asked of the bench yet.
   */
  reach?: Reachability | null;
  /**
   * #735 — what the machine's bed carries under the stock (`BedUnderFacts`), built by the caller
   * from the active bed profile exactly as the panel's fallback and the Generate build it (#712,
   * #725 B7). It is DATA for the same reason `bedUnderFacts` lives outside the engine: the active
   * profile is in the location, which the collector must not read. Absent (`null`/`undefined`):
   * no location, and the through sentences are the pre-#712 ones — the vise's.
   *
   * Without it a taped through cut with no under-board of its own was refused in the vise's words
   * even over a wasteboard deep enough to take the cut, on a job the Generate accepts.
   */
  bed?: BedUnderFacts | null;
}

/**
 * The gate's rows, in a fixed order (§2.2's own check table).
 *
 * ONE SCOPE PER CALL: this answers for the setup-and-tool scope `input` describes (see the module
 * doc — the hub calls it once per `(setupIndex, tool)` and owns the aggregate). It does not and
 * cannot loop over setups: the job model does not carry them yet.
 *
 * ORDER: grouped by owner — the job as data, what the bench can reach, the work-holding, then the
 * program, then the stock — and within an owner in the owner's own emission order. Two reasons for
 * that and not severity: (a) it is stable across runs, so the page does not reshuffle between
 * keystrokes, and (b) "the first blocking reason" (§5.6) is a question for the CONSUMER, which
 * filters on `severity`; if the collector sorted by severity it would be quietly deciding which
 * owner's finding leads, which is a policy this module has no business setting. `sort` is
 * deliberately not used at all — the order is the order rows are pushed.
 */
export function collect(input: PreflightInput): PreflightRow[] {
  const { job, scope } = input;
  const rows: PreflightRow[] = [];

  // ---- 1. The job as data, and the work-holding (owners that speak `JobFinding[]`) ------------
  //
  // ONE MERGE, FOUR OWNERS, AND TWO KNOWN OVERLAPS. `validateJob` already calls
  // `validateSacrificial` itself and pushes its findings (`jobSetup.ts`, the
  // `findings.push(...validateSacrificial(job))` line), so the sacrificial findings arrive from BOTH
  // calls. They are byte-identical (the validators are pure), so they collapse — but only if the
  // sacrificial copy is seen FIRST, which is why it is pushed first here, and only if the
  // de-duplication key is the owner's own.
  //
  // The SECOND overlap is the Generate's `findings`, which carry `validateJob`'s and `validateVise`'s
  // own findings alongside the geometry ones (see `PreflightInput.generated`). That batch is pushed
  // LAST for the same reason: the byte-exact key means the copies lose to the owners that state them,
  // and only the worker-only families survive under `'generate'`.
  //
  // The key below IS `dedupeFindings`'s key (`jobSetup.ts`), character for character, for the same
  // stated reason: two findings that share a code and an item but say DIFFERENT things are two
  // findings, and only byte-identical duplication is meant to collapse. `dedupeFindings` itself is
  // not called because it takes `JobFinding[]` and cannot carry the `owner` tag through; the key is
  // restated rather than the function reused so ownership survives the merge.
  //
  // Why `validateSacrificial` is called at all rather than letting `validateJob`'s copy stand: the
  // owner of a finding is what the page shows, and a sacrificial finding is `validateSacrificial`'s,
  // not `validateJob`'s. The alternative — the app's own seam, `dedupeFindings([...validateJob,
  // ...validateVise])` (`EngravePanel.tsx`) — loses that attribution. Reported to the maintainer.
  const tagged: { owner: PreflightOwner; finding: JobFinding }[] = [
    ...validateSacrificial(job).map((finding) => ({ owner: 'sacrificial' as const, finding })),
    // #735 — the bed's facts ride to their owner (`validateJob`, #712); the collector still decides
    // nothing, it only hands the owner the data the caller read from the location.
    ...validateJob(job, null, { bed: input.bed ?? null }).map((finding) => ({ owner: 'jobSetup' as const, finding })),
    // #240 — the fixture's own findings are the VISE's. A rotary job's holding checks are slice 3's.
    ...(job.workholding.kind === 'vise'
      ? validateVise(job.stock, job.workholding.vise, job.sacrificial).map((finding) => ({
          owner: 'fixture' as const,
          finding,
        }))
      : []),
    // LAST — the Generate's own list, whose `validateJob` / `validateVise` members must lose to the
    // owners above (see the note over this merge). What survives is the worker's geometry families.
    ...(input.generated?.findings ?? []).map((finding) => ({ owner: 'generate' as const, finding })),
  ];

  const seen = new Set<string>();
  const merged = tagged.filter(({ finding }) => {
    const key = `${finding.severity}|${finding.code}|${finding.labelId ?? ''}|${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Emitted in §2.2's table order — the job as data, then the same items judged against the solid
  // (the Generate's own families), then the work-holding — not in the order the owners above were
  // called (which exists only to make the sacrificial copy win the de-dupe).
  for (const owner of ['jobSetup', 'generate', 'fixture', 'sacrificial'] as const) {
    for (const row of merged) {
      if (row.owner !== owner) continue;
      rows.push({
        severity: row.finding.severity,
        code: row.finding.code,
        message: row.finding.message,
        owner,
        cause: causeFor(scope, { labelId: row.finding.labelId }),
      });
    }
  }

  // ---- 2. Reach: `recommendTool`'s own verdict (§2.2 "reach"), when a table was measured --------
  //
  // `recommendTool` states its answer as `ToolRecommendation`: a `key` that is `null` when nothing
  // on the bench is eligible, a `compromise` flag, and a `reason` sentence written for a human. Only
  // the `key === null` case is surfaced. The `compromise` case would be a SECOND statement of the
  // same fact the worker's `item-detail-lost` already makes ("no cutter you have can cut X without
  // losing detail"), and `reachability.ts`'s `ReachRow` has no severity, code or message at all, so
  // it cannot be a row on its own — see the report to the maintainer.
  //
  // The owner carries no code for this verdict; `no-cutter` names this one sentence and nothing more.
  if (input.reach && input.reach.recommendation.key === null) {
    rows.push({
      severity: 'error',
      code: 'no-cutter',
      message: input.reach.recommendation.reason,
      owner: 'reach',
      cause: causeFor(scope),
    });
  }

  // ---- 3. The program: the verifier, the Generate's own refusal, the gate (§2.2) ----------------
  //
  // The whole of this section reads the same value, so it is named once here.
  const gen = input.generated;
  //
  // The verifier's report is the OWNER's (`verifyProgram`), carried on the generated result: the
  // collector reads it, it does not call `verifyProgram` (that needs the text, the setup, the depth
  // limit and the tool — a Generate's work, not a keystroke's). Both reports are read: `verify` is
  // the job's program, `frameVerify` the frame file's (#244), and both are files the machine runs.
  //
  // #747 — UNLESS THE FRAME WAS WITHHELD. A withheld frame is not a file the machine runs; its
  // report is kept on the generated result so the receipt can carry every finding, but it is not a
  // gate answer. The program it belongs to passed verification, so its findings must not block the
  // cut; the absence is stated once, in the worker's own words, by the `no-frame` warning below.
  const withheldFrame = gen !== null && gen.frameNc === null && gen.frameError != null;
  const reports: (VerifyReport | null | undefined)[] = [gen?.verify, withheldFrame ? null : gen?.frameVerify];
  for (const report of reports) {
    for (const finding of report?.findings ?? []) {
      rows.push({
        severity: finding.severity,
        code: finding.code,
        message: finding.message,
        owner: 'verify',
        cause: causeFor(scope, { line: finding.line }),
      });
    }
  }

  // #747 — A FRAME WITHHELD FROM A VERIFIED PROGRAM IS NOT A REFUSAL. The program above passed,
  // so the run is still savable and runnable; the frame is absent and the Generate says why (it
  // could not be traced at a reachable height, the post refused it, or its verifier did). That
  // sentence is nowhere else: with a good program the `!gen.ok` branch below does not fire, and a
  // withheld frame with a report has had its findings routed to the receipt instead of here.
  // Warning, because the CUT never depended on the trace — only the dry-run confirmation of the
  // work origin did.
  if (gen !== null && gen.ok && gen.nc !== null && gen.frameNc === null && gen.frameError != null) {
    rows.push({
      severity: 'warning',
      code: 'no-frame',
      message: gen.frameError,
      owner: 'verify',
      cause: causeFor(scope),
    });
  }

  // THE GENERATE'S OWN REFUSAL, under its own owner. `saveBlocker` reads `nc`, `findings` and
  // `verify` and NOTHING ELSE of the generated result — never `ok`, never `errors` — so a Generate
  // that stopped without producing a program is on the gate only as an error COUNT ("N errors
  // outstanding") or as the bare "no program was produced", and WHY it stopped is nowhere. The
  // Generate states it itself in `errors`, one sentence per stoppage, so it is carried here verbatim.
  //
  // A FRAME THAT COULD NOT BE BUILT while the GENERATE stopped for its own reason is the case that
  // made this a code (review, 2026-10-16): the Generate keeps `nc`, leaves `frameVerify` null and
  // says why only in `errors`. With a program in hand the gate's `no program was produced` clause
  // does not fire, so `no-frame` names the absent trace instead of leaving the job reading CLEAN.
  // Since #747 a frame fault alone never makes `ok` false — the program is verified and the frame
  // is withheld as a warning (see the block above) — so this branch is reached only when a program
  // was refused before or alongside the frame, or for a result stored by an older build.
  //
  // WHY THE TWO VERIFIER STOPPAGES ARE NOT RE-STATED HERE: when the program's own report found
  // errors, or the frame's did, the rows above already carry every one of them, each with its line,
  // and the Generate's summary of them ("3 verifier error(s)") would be a vaguer second copy of a
  // fact already stated twice over. That is the whole of the exclusion — nothing here compares,
  // matches or re-words a message; it asks whether an owner has already spoken, which is a fact about
  // the answer, not a rule about the job.
  if (gen !== null && !gen.ok) {
    const verifyClean = !(gen.verify?.findings ?? []).some((f) => f.severity === 'error');
    const frameClean = !(gen.frameVerify?.findings ?? []).some((f) => f.severity === 'error');
    // The Generate's last word before returning is the reason it returned: each `stop(...)` pushes
    // one sentence and returns at once, so the tail of `errors` IS the stoppage's own sentence.
    const why = gen.errors.at(-1)?.message;
    // A program in hand with no frame report: the frame was never built. The Generate's only such
    // return is the `'error' in frame` one — a frame whose own verifier found errors comes back WITH
    // that report, and is excluded by `frameClean` above.
    const noFrame = gen.nc !== null && gen.frameVerify === null;
    if (why !== undefined && verifyClean && frameClean) {
      const refusal = { severity: 'error' as const, message: why, owner: 'generate' as const, cause: causeFor(scope) };
      // TWO LITERALS rather than a ternary, because `cncGuide.spec.ts` harvests codes by scanning
      // the source for a `code:` field written as a quoted kebab-case literal — and a ternary in
      // that position would hide BOTH rows from the guide gate, leaving two codes the guide is never
      // checked against. (Which is a silent hole, not a failure: the gate only asks that every code
      // it found has a row.)
      if (noFrame) rows.push({ ...refusal, code: 'no-frame' });
      else rows.push({ ...refusal, code: 'generate-stopped' });
    }
  }

  // NO PROGRAM IS THE GATE'S OWN STATEMENT, and it has two causes. §2.2 is explicit that the verifier
  // must not be silently skipped: Cut's first blocking reason with nothing generated is "generate the
  // programs first". That sentence is `saveBlocker`'s, not ours — the gate owns "why this run may not
  // proceed", and restating it here is exactly the duplication this module exists to avoid.
  //
  // ASKED IN TWO STATES AND NO OTHERS, because `saveBlocker` returns the FIRST reason it finds and the
  // reasons after `nc === null` in its list — the sweep's status, the prediction, the clearance tick —
  // are the RUN's to answer and are not in `PreflightInput` at all. Asking in a state where one of
  // those is the answer would put "the simulation did not finish" on a run nobody asked about. So:
  //
  //   no Generate yet                          → "Generate first."
  //   a Generate that produced no program (`nc === null`) → the gate's own sentence: "N errors
  //                                             outstanding" when an owner's rows carry errors,
  //                                             otherwise "no program was produced"
  //
  // The REASON it produced none is not in that sentence — the gate does not read the Generate's
  // `errors` — and is not claimed to be: it is the row above, in the Generate's own words.
  //
  // THE SECOND IS THE REVIEW'S FINDING (2026-10-16): a Generate that RAN and stopped — at the
  // findings, the feeds, the CAM, the post — leaves `nc` null and used to read as a clean gate. Every
  // `stop(...)` in `engraveGenerate` leaves `nc` null; the one failure that KEEPS a program (verifier
  // errors on a program that was posted) is already on the gate as the verifier's own rows above. So
  // `nc === null` is exactly "there is no program", which is what `no-generate` means either way.
  if (gen === null || gen.nc === null) {
    // `saveBlocker` answers `null` when the run may proceed and a sentence when it may not; the null
    // case is the gate saying "nothing blocks this", which is not a row. The view is real only in its
    // `generated` field — see `NO_RUN_VIEW` for why that is safe in exactly these two states.
    // #724 W5 — the view carries the machine and the holding, so a rotary job's gate row says the
    // bench sentence rather than "no rotary module" about a profile that has one.
    const block = saveBlocker(
      gateViewFor(
        gen === null ? NO_RUN_VIEW : { ...NO_RUN_VIEW, generated: gen },
        jobMachine(input.job, input.calibration),
        input.job.workholding.kind === 'rotary-chuck',
      ),
    );
    if (block !== null) {
      rows.push({
        severity: 'error',
        // The gate states its block as a sentence and carries no code; this names that one block.
        code: 'no-generate',
        message: block,
        owner: 'engraveRunGate',
        cause: causeFor(scope),
      });
    }
  }

  // ---- 4. The stock: the shelf entry as this job's stock (§2.2 "stock") -------------------------
  //
  // `stockFromShelf` is the owner: it answers `{ ok: false, reason }` when the entry cannot start
  // this job, and the `reason` is its own sentence — carried verbatim. A refusal is the owner
  // saying "this cannot be cut from that", which is an error; the owner does not carry a severity
  // because it was written for a picker, where a refused entry simply stays listed.
  if (input.shelfItem !== null) {
    const picked = stockFromShelf(input.shelfItem, jobMachine(job, input.calibration));
    if (!picked.ok) {
      rows.push({
        severity: 'error',
        // The owner states its refusal as a sentence with no code; this names that one refusal.
        code: 'stock-refusal',
        message: picked.reason,
        owner: 'stockStart',
        cause: causeFor(scope),
      });
    }
  }

  return rows;
}

/**
 * The `cause` for a row: the scope this call answers for (copied, never inferred) plus whatever the
 * owner already said — the item it named, the program line it pointed at. A key the owner did not
 * state is absent, not `undefined`: `cause` is read by `toEqual` in the suite and by the page, and
 * "the owner named no item" is a different fact from "the owner named this item and it was blank".
 */
function causeFor(
  scope: PreflightScope,
  said: { labelId?: string; line?: number | null } = {},
): PreflightCause {
  const cause: PreflightCause = {
    setupIndex: scope.setupIndex,
    toolKey: scope.toolKey,
    hubTarget: null,
  };
  if (said.labelId !== undefined) cause.labelId = said.labelId;
  if (said.line !== undefined) cause.line = said.line;
  return cause;
}

/**
 * A run view with no run in it, and the base for the one-with-a-generate at the call site above.
 *
 * `saveBlocker` reads the run in a fixed order and returns the FIRST reason it finds. The fields that
 * are genuinely the RUN's — the stale mark, the phase, the sweep's status, the prediction, the
 * acknowledgement — are blanked here because `collect()` has no run to state them from; that is safe
 * only because it asks in the two states where the verdict is decided before any of them is read (see
 * the call site). Of the blanked fields exactly one could disagree with a live run: `phase`, which can
 * only make the gate say "no program" where the run store would say "still going" for that same
 * keystroke — a transient, and in the safe direction, since both say the job is not ready.
 *
 * Spelled out rather than `as`-cast so that a future field added to `EngraveRunView` is a typecheck
 * error here instead of a silent default.
 */
const NO_RUN_VIEW: EngraveRunView = {
  generated: null,
  oracle: null,
  simDiagnostics: [],
  simStatus: null,
  phase: 'idle',
  acknowledged: false,
  staleSince: null,
  error: null,
};

/**
 * OWNERS NOT WIRED, and why (both are §2.2 owners the module cannot call from a keystroke).
 *
 * - **the reach TABLE** (`reachability.ts`'s `reachabilityFor`, returning `ReachRow[]`) — the wasm
 *   `measure` seam (`measureLabels`) stands between the engine and it, so it can only arrive as data
 *   (`PreflightInput.reach`), and only `recommendTool`'s VERDICT sentence is read off it. A `ReachRow`
 *   is a MEASUREMENT and not a finding besides: it holds no severity, no code and no message, so
 *   re-formatting one into a row would mean WRITING a sentence here — a rule, which §2.2 forbids.
 *
 * - **`workers/sim/engraveGeometry.ts`** (`engravabilityFindings`, `keepOutFindings`,
 *   `itemDepthBoundFindings`) — worker-only, for the same wasm `CrossSection` reason, and NO LONGER A
 *   GAP: `collect()` reads the findings the Generate already returned and merges them under
 *   `'generate'` (see `PreflightInput.generated`). The one thing still out of reach is their EXISTENCE
 *   before a Generate has run, when there is nothing to read — which is precisely what `no-generate`
 *   is for.
 */
