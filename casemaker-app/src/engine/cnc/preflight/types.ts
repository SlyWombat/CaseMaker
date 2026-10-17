/**
 * The PREFLIGHT row (#419 §2.2) — the one shape the Cut gate reads.
 *
 * This module is the vocabulary only; the aggregation lives in `collect.ts`. It exists so the hub
 * (the Design/Cut switch and the preflight page, #419 §2.5) can type its props without importing
 * the collector, and so the row shape has ONE statement rather than one per consumer.
 *
 * THE RULE THIS WHOLE DIRECTORY SERVES (#419 §2.2): preflight adds NO new rule. Every row it
 * reports was computed by an owner — `validateJob`, `validateVise`, `validateSacrificial`,
 * `recommendTool`, `verifyProgram`, `stockFromShelf`, `saveBlocker` — and the collector's whole job
 * is to call those owners and normalise their answers into this shape. A rule re-implemented here
 * would drift from the rule the Design surface enforces, and the operator would be told two
 * different things about one job.
 *
 * Concretely, that is why this file holds no predicate: there is no `isBlocking`, no threshold, no
 * comparison. `severity` is copied from the owner wherever the owner states one.
 */

/** The two levels every owner already speaks (#419 §2.2). */
export type PreflightSeverity = 'error' | 'warning';

/**
 * WHICH OWNER produced a row, named by the module the collector called.
 *
 * The plan's §2.2 table gives one owner per check; this is that table as a union. It is carried on
 * every row because the page has to say WHERE a finding came from — two owners can raise the same
 * `code` for different reasons, and "the tool list has no flat mill" reads very differently whether
 * `recommendTool` or `validateJob` said it.
 *
 * DELIBERATELY ABSENT, and why (both are §2.2 owners the collector cannot CALL — see `collect.ts`'s
 * header and this slice's report to the maintainer):
 *  - `engraveGeometry` — `workers/sim/engraveGeometry.ts` is worker-only; nothing in the engine can
 *    invoke it synchronously. Its findings are not lost, though: they ride back on the Generate's
 *    answer and the collector copies them under `'generate'` below.
 *  - the reach TABLE (`reachability.ts`'s `ReachRow`) — it is a measurement, not a finding: it
 *    carries no `severity`, no `code` and no `message`, and the reach findings an operator reads
 *    (`item-empty`, `item-detail-lost`) are `engravabilityFindings`'s, i.e. the worker's, so they
 *    arrive under `'generate'`. `'reach'` below is `recommendTool`'s own VERDICT sentence, which is a
 *    different thing from a `ReachRow`.
 */
export type PreflightOwner =
  /** `validateJob` (`engine/cnc/engrave/jobSetup.ts`) — the job as data: depth, drills, items, tool. */
  | 'jobSetup'
  /**
   * THE GENERATE'S OWN findings — the families no engine owner can compute from a keystroke, because
   * they need a `CrossSection` opened in wasm: `engraveGeometry.ts`'s `engravabilityFindings`,
   * `keepOutFindings` and `itemDepthBoundFindings` (`item-empty`, `item-detail-lost`,
   * `item-chars-lost`, `item-outside-stock`, `item-over-void`, `item-depth-bound`), plus the V-cutter
   * findings `engraveGenerate.ts` raises itself (#405).
   *
   * It is ALSO this owner that states WHY a Generate stopped: `errors` carries one sentence per
   * stoppage, and the gate never reads it (`saveBlocker` looks at `nc`, `findings` and `verify`
   * only), so the collector copies the stoppage's sentence onto a row — `no-frame` when the run
   * stopped holding a program but with no frame file to trace, `generate-stopped` otherwise.
   *
   * A READING, NOT A CALL: the collector never invokes the worker — it copies the findings the
   * Generate has already returned. That list also carries `validateJob`'s and `validateVise`'s own
   * findings (the worker merges them before returning, so a failed Generate still says WHY), which is
   * why the collector merges this batch LAST and under the same byte-exact key: those copies collapse
   * onto the owners above, and only the families no engine owner states survive carrying this tag.
   */
  | 'generate'
  /** `validateVise` (`engine/cnc/fixture.ts`) — the vise as data, judged on what the jaws grip. */
  | 'fixture'
  /** `validateSacrificial` (`engine/cnc/sacrificial.ts`) — the sacrificial stack. */
  | 'sacrificial'
  /** `recommendTool` / `reachabilityFor` (`engine/cnc/engrave/`) — whether ANY cutter can do this job. */
  | 'reach'
  /** `verifyProgram` (`engine/cnc/verify.ts`) — the posted program, on the text. */
  | 'verify'
  /** `saveBlocker` (`store/engraveRunGate.ts`) — why the run cannot proceed at all (no program yet). */
  | 'engraveRunGate'
  /** `stockFromShelf` (`engine/cnc/stockStart.ts`) — the shelf entry as this job's stock. */
  | 'stockStart';

/**
 * WHAT TO FIX, as far as the owner that raised the row already knows.
 *
 * This is the point of the page (§2.2): a red row is not just a sentence, it is a pointer, so
 * "Back to Design" can land on the field that caused it. The collector carries through only what an
 * owner already attached — nothing is inferred here.
 *
 * THE SCROLL/ADDRESSING SCHEME IS NOT OURS TO INVENT. §2.2 sketches `cause` as "a row id plus a
 * section", and §7 leaves the shape of that open with the maintainer; #411 only just gave the panel
 * per-row ids and `expandEngraveRow`. So this file states {@link PreflightCause.hubTarget} as an
 * explicit, always-null PLACEHOLDER and wires nothing to it: the hub fills it when §7 is answered,
 * and until then the collector must not grow a second addressing scheme beside #411's.
 *
 * WHICH SETUP, WHICH TOOL. Cut is being built on a MULTI-SETUP job — several setups (#428's planner,
 * #429/#430's remount registration) and, within a setup, ONE PROGRAM PER TOOL (#410's route); the
 * maintainer ruled out the plan's 1-setup v1. Preflight answers for ONE setup-and-tool scope at a
 * time (`collect.ts`), so a row has to be able to say which scope it came from. {@link
 * PreflightCause.setupIndex} and {@link PreflightCause.toolKey} are that address; both are UNSET
 * today, because `EngraveJob` still carries one `workholding` and one `toolKey` and has no
 * `setups[]` — there is exactly one scope to be in.
 */
export interface PreflightCause {
  /** The item the finding points at, when the owner named one (`JobFinding.labelId`). */
  labelId?: string;
  /**
   * The program line the finding points at, when the verifier named one (`VerifyFinding.line`).
   * `null` is the verifier's own "no single line" and is carried through as such, not dropped.
   */
  line?: number | null;
  /**
   * Which setup of a multi-setup job the row came from — the setup index the hub keys its aggregate
   * on (§5.6's `(setupIndex, tool)`).
   *
   * UNSET TODAY, and deliberately so: `EngraveJob` has no `setups[]` yet, so `collect()` is always
   * called for setup 0 and there is no value to carry. It stays `undefined` rather than being
   * defaulted to `0` — a fabricated index would read as a statement about a job that does not have
   * setups, and would survive the job model landing as a wrong answer rather than an absent one.
   * The setups planner (#428) is what fills it.
   */
  setupIndex?: number;
  /**
   * Which tool of the setup the row came from — the job's `toolKey` for the scope this answer is
   * for, once a setup carries several (#410's one-program-per-tool).
   *
   * UNSET TODAY for the same reason as {@link PreflightCause.setupIndex}: one job names one
   * `toolKey`, so the scope is implicit and the collector has nothing to state. Never invented.
   */
  toolKey?: string;
  /**
   * PLACEHOLDER — the hub's scroll/addressing target, deliberately unresolved (§2.2, §7).
   *
   * Always `null` from the collector. It is a named field rather than an omission so that adding
   * the scheme later is a fill-in at one place, and so that nothing downstream mistakes the
   * owner-known keys above for a complete address.
   */
  hubTarget: null;
}

/** One row of the preflight gate (§2.2): `{ severity, code, message, owner, cause }`. */
export interface PreflightRow {
  /** The owner's own severity. The collector never re-grades a finding. */
  severity: PreflightSeverity;
  /**
   * The owner's own code, verbatim, wherever the owner states one (`JobFindingCode`,
   * `VerifyFinding['code']`). Where an owner states its verdict as a bare sentence with no code —
   * `stockFromShelf`'s refusal, `saveBlocker`'s block, `recommendTool`'s "nothing eligible" — the
   * collector supplies the ONE code that names that verdict, and says so at the call site; it never
   * invents a check.
   */
  code: string;
  /** The owner's OWN message, verbatim and un-reworded. This is the field the page prints. */
  message: string;
  /** Which owner produced the row — see {@link PreflightOwner}. */
  owner: PreflightOwner;
  /** Where to go to fix it, as far as the owner already knows — see {@link PreflightCause}. */
  cause: PreflightCause;
}
