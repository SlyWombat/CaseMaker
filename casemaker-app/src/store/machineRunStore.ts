/**
 * The run on each machine (#423) — the SINGLE SOURCE OF TRUTH for it. The run is owned here, not by
 * any panel:
 *
 *   - an upload that went through PREPARES the machine's entry (the file and its program hash);
 *     the run panel is drawn from that entry, keyed by machine, so closing and reopening the engrave
 *     panel finds the run — and its Stop — exactly where it was;
 *   - ONE RUN PER MACHINE: `start` refuses while one is running there, and the upload panel locks
 *     Upload on the same flag;
 *   - the watch keeps going with no panel attached (#423 re-review: a run nobody can see must still
 *     finish, or still be stoppable, the way it would with the panel open);
 *   - STOP is a flag the watch reads at its next poll boundary, and a pressed Stop is always sent.
 *
 * THE END OF A RUN (#414) is worked out HERE, once per run, the moment its outcome is known — never in
 * a panel, where a remount would apply it twice:
 *   - FINISHED: the program's FNV hash is recorded on this machine (#419 §4.5), the job's reserved
 *     stock is consumed, the cutting time is added to the copy recorded as in this machine, and an
 *     offcut with usable size is OFFERED (one click keeps it, dismissing skips it). Each says what it
 *     did, or why not — a run with no stock entry (#419 has not landed) skips the shelf with a note.
 *   - STOPPED: nothing is changed; the operator is asked whether the stock was used (yes consumes it,
 *     no leaves the reservation for a re-run). No runtime is counted for a stopped run, and the
 *     program is NOT recorded as finished. An unanswered question is CARRIED to the machine's next
 *     run entry, never dropped without a word.
 *   - ALARM, UNREACHABLE, REFUSED, NEVER STARTED: nothing is changed, and the end says so.
 * The runtime write is not retried: a failed one is reported, so it is never counted twice.
 */

import { create } from 'zustand';
import { attachConsole } from '@/platform/machineConsole';
import { programHash, programOwnsVacuum, runProgram, type Progress, type RunOutcome, type RunSettings, type VacuumSpan } from '@/platform/machineRun';
import { buildProgramCutMap } from '@/engine/cnc/engrave/cutMap';
import { acquireStatusPoll, noteRunStatus } from '@/platform/machineStatusPoller';
import type { PauseAction } from '@/platform/machinePause';
import { copyInMachine, offcutOffer, programCuts, runtimeOf, wearKey, weighRuntime, withRuntime } from '@/engine/cnc/runEnd';
// #1145 — the run's own clock: the elapsed time comes from our first `P:` timestamp, never `P:` field 3.
import { runClockSeconds } from '@/engine/cnc/engrave/runProgress';
import type { StockItem } from '@/platform/stockClient';
import type { InventoryItem } from '@/platform/houseClient';
import type { EngraveJob, FilamentFibre } from '@/types/engraveJob';
import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import { MACHINES } from '@/engine/cnc/machine';
import { isPlasticMaterial } from '@/engine/cnc/materials';
import { readDefault, readFlag } from '@/platform/defaultsClient';
import { createStatusLog, readStatusFields, type StatusLog } from '@/engine/cnc/engrave/runStatusLog';
import { newStockId, useStockStore } from './stockStore';
import { useToolRegistryStore } from './toolRegistryStore';
import { useHouseStore } from './houseStore';
import { machineAt, useLocationStore } from './locationStore';
import { useShopDefaultsStore } from './shopDefaultsStore';
import { useEngraveJobStore } from './engraveJobStore';
import { useMachineTranscriptStore } from './machineTranscriptStore';
import { RunTranscript, type RunTranscriptView } from './runTranscript';

/**
 * What a run knows about its job, for its end (#414). Everything but the program is OPTIONAL: the job
 * flow (#419) has not landed, so the engrave panel cannot say yet which shelf entry it reserved.
 */
export interface RunContext {
  /** The program the machine played — its cutting moves are the runtime and the footprint. */
  nc: string;
  /** The job's id, as it reserved its stock. */
  jobId?: string;
  /** The shelf entry the job reserved (#413). Absent: the shelf is not touched, with a note. */
  stockEntryId?: string;
  /** The stock's size in the job's work frame (X, Y), mm — which way round the job used it. */
  stockXY?: { x: number; y: number };
  /** The cutter's cutting radius, mm, for the footprint. */
  toolRadius?: number;
  /** The job's cutter as a registry key (`inv:<id>`), when known. */
  toolKey?: string;
  /** Where the job's part sits, work XY — which piece of a split stock is not scrap. */
  partAt?: { x: number; y: number };
  /** The material cut, for the wear weight. Default: the reserved shelf entry's. */
  material?: StockItem['material'];
  /**
   * The blank's fibre flag (#464), when its filament class was a composite (`PETG-CF`). The
   * material stays the base plastic — the feeds and catalogue answer that — and this is what makes
   * the wear weighting abrasive. Absent for an unfilled blank, and then the material's own class
   * decides.
   */
  fibre?: FilamentFibre;
  /**
   * #419 Q-E — this file belongs to a job whose PROGRAMS own the vacuum span, so the runner must
   * not bracket it. Set it for every file of such a job, the middle ones included: a middle file
   * carries no `M331`/`M332` of its own (the first file turns the vacuum on, the last turns it
   * off), so the text alone reads as "not owned" and the runner would switch the vacuum off at a
   * bit change — the one thing the maintainer said not to do. Absent: the program text decides.
   */
  vacuumOwned?: boolean;
  /**
   * #419 decision 4 / #469 — this file's share of the job's vacuum span, said by the upload that
   * wrote it: `whole`, `first`, `middle`, `last`, or `none` for an `air: false` job. The runner uses
   * it for its log and its finishing sentence; a middle file carries no words, and `none` must not
   * be mistaken for "the runner should bracket it".
   */
  vacuumSpan?: VacuumSpan;
  /** #1060 — the job's (or shop's) choice that the spindle blower follows the vacuum on this run. */
  blow?: boolean;
  /**
   * #419 §4.5 / #469 — the program's FNV hash, when the caller already has it. The finished-program
   * record uses this rather than re-hashing the text, so the key that `finishedProgramsFor` reads is
   * the same one the plan was given even if a future post changes how the hash is taken.
   */
  programHash?: string;
  /**
   * Where this file sits in the job's cut order (1-based) and how many files there are. The release
   * step sets both on every file. A run with no fields keeps the old end-of-run behaviour; a run
   * that has them consumes the job's reserved stock and offers its offcut only when the JOB's last
   * program finished, never once per file.
   */
  programIndex?: number;
  programTotal?: number;
  /**
   * #425 §6 — the setup this file cuts, as the package names it. The run end writes the program's
   * outcome into the open document's run log against this id, so a reopened job resumes at the
   * first program the document has no `finished` entry for.
   */
  setupIndex?: number;
  setupId?: string;
  // #1179 — WHAT was cut, for the restart record beside the finished hash. Optional: a caller that
  // does not know a fact leaves it out, and the record says only what is true.
  packageKey?: string;
  jobName?: string;
  programName?: string;
  stockThicknessMm?: number;
  registration?: import('@/platform/locationClient').FinishedRunRegistration;
  /**
   * #547 — the program played was a LIFTED dry-run variant. A finished dry run must not record the
   * program as finished, consume the stock, count cutter runtime or offer an offcut: it rehearsed
   * the path with the spindle off, in the air, and nothing was cut.
   */
  dryRun?: boolean;
  /**
   * #1146 — the program played is a CLEANING PASS or an AIR WALK: motion the release step generated
   * and verified like any program, but not one of the job's programs. Its end records NOTHING — no
   * finished hash, no stock, no cutter runtime, no offcut — and says which walk it was (a dry run's
   * words would be a lie: the spindle is not rehearsing anything).
   */
  maintenance?: 'airwalk' | 'clean';
  /**
   * #1170 — THIS RUN REPLAYS ONE FINISHED PROGRAM ON PURPOSE (the tab-release pass after the job
   * ended, from the end card). The motion is real, but the job's bookkeeping is already done: its
   * end records no finished hash, consumes no stock, adds no cutter runtime and offers no offcut.
   */
  rerun?: true;
}

/**
 * What the engrave panel can tell a run about its job (#442's #414 item, with #464's fibre): the
 * parts of `RunContext` the panel actually knows.
 *
 * `partAt` is deliberately absent. The job never states where its part sits, so the offcut logic
 * reads "the pieces that do not reach the stock's edge" — a weaker answer than a stated point, and
 * an honest one, where a point picked by the app would be a guess about which piece is the part.
 *
 * The cutter is the JOB's (`jobTool(job)`), not the registry's entry for its key: a re-collared bit
 * must not change what the run says it cut with. `toolRadius` is the cutting half-diameter, and is
 * left out when no cutter resolved rather than sent as a zero.
 */
export function runContextFor(job: EngraveJob, tool: Tool | null): Omit<RunContext, 'nc'> {
  const diameter = tool === null ? null : cuttingDiameter(tool);
  return {
    jobId: job.id,
    jobName: job.name,
    ...(job.package === undefined ? {} : { packageKey: job.package.hash }),
    ...(job.stockEntry?.shelfId ? { stockEntryId: job.stockEntry.shelfId } : {}),
    stockXY: { x: job.stock.length, y: job.stock.width },
    stockThicknessMm: job.stock.thickness,
    ...(diameter === null ? {} : { toolRadius: diameter / 2 }),
    toolKey: job.toolKey,
    material: job.stock.material,
    ...(job.stock.fibre === undefined ? {} : { fibre: job.stock.fibre }),
  };
}

export interface RunEnd {
  kind: 'finished' | 'stopped' | 'nothing';
  /** What was done, or why not, one sentence each. */
  lines: string[];
  /** The offcut question: asked, then kept or skipped. */
  offcut: { item: StockItem; text: string; state: 'asked' | 'kept' | 'skipped' | 'failed' } | null;
  /** A stopped run's question: was the stock used? */
  stockQuestion: 'ask' | 'used' | 'not-used' | null;
}

/** The reads and writes the end of a run makes — the app's stores, replaceable in a test. */
export interface RunEndIO {
  /** Re-read the shelf first: it is otherwise loaded only by Manage › Materials. */
  refreshStock: () => Promise<void>;
  stockItem: (id: string) => StockItem | null;
  consume: (entryId: string, jobId: string) => Promise<{ ok: boolean; text: string }>;
  addOffcut: (item: StockItem) => Promise<{ ok: boolean; text: string }>;
  inventory: () => readonly InventoryItem[];
  updateItem: (item: InventoryItem) => Promise<{ ok: boolean; text: string }>;
  machineIdFor: (target: { host: string; port: number }) => string | null;
  /** Record a program that FINISHED cleanly on this machine (#419 §4.5); `added: false` when it was already there. */
  recordFinishedProgram: (machineId: string, hash: string, run?: import('@/platform/locationClient').FinishedRun) => Promise<{ ok: boolean; added: boolean; text: string }>;
  minSideMm: () => number;
  /** `offcut.offer`: false turns offcut offers off entirely. */
  offerOffcuts: () => boolean;
  /** The wear weight for a `tools.wearWeight.*` key, with its source. */
  wearWeight: (key: string) => { value: number; source: string };
  newId: () => string;
  now: () => string;
}

const storeIO: RunEndIO = {
  refreshStock: () => useStockStore.getState().refresh(),
  stockItem: (id) => useStockStore.getState().items.find((i) => i.id === id) ?? null,
  consume: async (entryId, jobId) => {
    const ok = await useStockStore.getState().consume(entryId, jobId);
    return { ok, text: useStockStore.getState().notice?.text ?? '' };
  },
  addOffcut: async (item) => {
    const ok = await useStockStore.getState().add(item);
    return { ok, text: useStockStore.getState().notice?.text ?? '' };
  },
  inventory: () => useToolRegistryStore.getState().items,
  updateItem: async (item) => {
    // A busy house refuses without a notice of its own: say so, rather than show the last write's.
    const busy = useHouseStore.getState().busy;
    if (busy !== null) return { ok: false, text: `another save to the inventory (${busy}) was still in progress` };
    const ok = await useHouseStore.getState().updateItem(item);
    return { ok, text: ok ? '' : (useHouseStore.getState().notice?.text ?? 'the inventory did not take the change') };
  },
  machineIdFor: (target) => machineAt(target)?.id ?? null,
  recordFinishedProgram: (machineId, hash, run) => useLocationStore.getState().recordFinishedProgram(machineId, hash, run),
  minSideMm: () => readDefault(useShopDefaultsStore.getState().defaults, 'offcut.minSideMm').value,
  wearWeight: (key) => readDefault(useShopDefaultsStore.getState().defaults, key),
  offerOffcuts: () => readFlag(useShopDefaultsStore.getState().defaults, 'offcut.offer').value,
  newId: newStockId,
  now: () => new Date().toISOString(),
};
let io: RunEndIO = storeIO;

/** Test seam: the end of a run's reads and writes. `null` restores the app's stores. */
export function setRunEndIO(next: RunEndIO | null): void {
  io = next ?? storeIO;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Work out — and, for a finished run, apply — the end of a run. Called once, when the outcome is known. */
export async function endOfRun(target: { host: string; port: number }, outcome: RunOutcome, ctx: RunContext | null): Promise<RunEnd> {
  const hasStock = ctx?.stockEntryId !== undefined && ctx.jobId !== undefined;
  // #469 — a multi-program job consumes its blank ONCE, when the job's last program finishes. The
  // release step says which file this is; a caller that does not (a single-file upload) is the job.
  const lastProgram =
    ctx?.programIndex === undefined || ctx?.programTotal === undefined || ctx.programIndex >= ctx.programTotal;
  const programWord =
    ctx?.programIndex !== undefined && ctx?.programTotal !== undefined
      ? `program ${ctx.programIndex} of ${ctx.programTotal}`
      : 'the program';
  // #1146 — a maintenance walk is not one of the job's programs: its end records nothing at all,
  // and it says which walk it was rather than borrowing the dry run's words.
  if (ctx?.maintenance !== undefined) {
    const what = ctx.maintenance === 'clean' ? 'The cleaning pass' : 'The air walk';
    if (outcome.kind === 'finished') {
      return {
        kind: 'finished',
        lines: [`${what} finished: nothing was recorded — no program marked finished, no stock consumed, no cutter runtime counted.`],
        offcut: null,
        stockQuestion: null,
      };
    }
    if (outcome.kind === 'aborted' || outcome.kind === 'stopped-unconfirmed') {
      return { kind: 'stopped', lines: [`${what} was stopped: nothing was recorded.`], offcut: null, stockQuestion: null };
    }
    return { kind: 'nothing', lines: [`${what} did not finish: nothing was recorded.`], offcut: null, stockQuestion: null };
  }
  // #1170 — a deliberate replay of one finished program (the tab-release pass) is real motion, but
  // the job's end has already been recorded: do not record the hash again, consume the blank a
  // second time, count the cutter's runtime twice or offer the offcut a second time.
  if (ctx?.rerun === true) {
    if (outcome.kind === 'finished') {
      return {
        kind: 'finished',
        lines: ['The tab release was cut again: nothing was recorded — the part was already finished.'],
        offcut: null,
        stockQuestion: null,
      };
    }
    if (outcome.kind === 'aborted' || outcome.kind === 'stopped-unconfirmed') {
      return { kind: 'stopped', lines: ['The tab-release replay was stopped: nothing was recorded.'], offcut: null, stockQuestion: null };
    }
    return { kind: 'nothing', lines: ['The tab-release replay did not finish: nothing was recorded.'], offcut: null, stockQuestion: null };
  }
  // #547 — a dry run rehearses the path with the spindle off and nothing clamped. Its end must not
  // touch the finished-program record, the shelf, the cutter runtime or the offcut: nothing was cut.
  if (ctx?.dryRun === true) {
    if (outcome.kind === 'finished') {
      return {
        kind: 'finished',
        lines: ['The dry run finished: nothing was recorded — no program marked finished, no stock consumed, no cutter runtime counted.'],
        offcut: null,
        stockQuestion: null,
      };
    }
    if (outcome.kind === 'aborted' || outcome.kind === 'stopped-unconfirmed') {
      return { kind: 'stopped', lines: ['The dry run was stopped: nothing was recorded.'], offcut: null, stockQuestion: null };
    }
    return { kind: 'nothing', lines: ['The dry run did not finish: nothing was recorded.'], offcut: null, stockQuestion: null };
  }
  if (outcome.kind === 'aborted' || outcome.kind === 'stopped-unconfirmed') {
    return {
      kind: 'stopped',
      lines: [
        hasStock
          ? lastProgram
            ? 'The run was stopped: nothing was taken off the shelf yet.'
            : `The run was stopped at ${programWord}: the stock stays reserved for the rest of the job.`
          : 'The run was stopped: nothing was changed.',
        'No cutter runtime is counted for a stopped run.',
      ],
      offcut: null,
      // Asked only when this was the job's last file: a stop at program 1 of 3 does not mean the
      // blank is spent, and consuming it would end the reservation a resumed run still needs.
      stockQuestion: hasStock && lastProgram ? 'ask' : null,
    };
  }
  if (outcome.kind !== 'finished') {
    return { kind: 'nothing', lines: ['The run did not finish: the shelf and the cutters are unchanged.'], offcut: null, stockQuestion: null };
  }
  const lines: string[] = [];
  const cuts = ctx ? programCuts(ctx.nc) : null;
  const machineId = io.machineIdFor(target);
  // The program FINISHED cleanly (#419 §4.5): remember its FNV hash on this machine, so the plan
  // stops offering it the air run (Q14). ONLY this branch records — a stopped run may have cut part
  // way, and its program is still "new". The key is `programHash`, the run confirmation's key
  // (decision 3), never #277's SHA-256 `ncHash`.
  if (ctx !== null) {
    const hash = ctx.programHash ?? programHash(ctx.nc);
    if (machineId === null) {
      lines.push('The finished program was not recorded: this machine is not one of the location’s.');
    } else {
      // #1179 — the record beside the hash: what was cut, under which package and registration.
      // The cut-map entry is built first (synchronously, from the run's own NC and face facts).
      const cutEntry: import('@/platform/locationClient').FinishedSetupCutMap | null =
        ctx.stockXY === undefined || ctx.setupIndex === undefined
          ? null
          : (() => {
              const fit = buildProgramCutMap({
                nc: ctx.nc,
                stock: { x: ctx.stockXY!.x, y: ctx.stockXY!.y },
                ...(ctx.toolRadius === undefined ? {} : { toolRadius: ctx.toolRadius }),
              });
              return fit.kind === 'map'
                ? { setupIndex: ctx.setupIndex!, state: 'complete' as const, map: fit.map }
                : { setupIndex: ctx.setupIndex!, state: 'unknown' as const, unknownReason: fit.reason };
            })();
      const run: import('@/platform/locationClient').FinishedRun = {
        hash,
        ...(ctx.jobId === undefined ? {} : { jobId: ctx.jobId }),
        ...(ctx.jobName === undefined ? {} : { jobName: ctx.jobName }),
        ...(ctx.packageKey === undefined ? {} : { packageKey: ctx.packageKey, key8: ctx.packageKey.slice(0, 8) }),
        ...(ctx.programIndex === undefined ? {} : { programIndex: ctx.programIndex }),
        ...(ctx.programTotal === undefined ? {} : { programCount: ctx.programTotal }),
        ...(ctx.programName === undefined ? {} : { programName: ctx.programName }),
        ...(ctx.toolKey === undefined ? {} : { cutterKey: ctx.toolKey }),
        ...(ctx.setupIndex === undefined ? {} : { setupIndex: ctx.setupIndex }),
        finishedAt: io.now(),
        ...(ctx.stockXY === undefined && ctx.stockThicknessMm === undefined
          ? {}
          : {
              stock: {
                ...(ctx.stockXY === undefined ? {} : { lengthMm: ctx.stockXY.x, widthMm: ctx.stockXY.y }),
                ...(ctx.stockThicknessMm === undefined ? {} : { thicknessMm: ctx.stockThicknessMm }),
              },
            }),
        ...(ctx.registration === undefined ? {} : { registration: ctx.registration }),
        // #1179 step 3 — what this program cut on ITS OWN face. One entry per setup (#1179's
        // ruling, comment 6775024844); the store merges it with the same setup's entry on the
        // newest record for this blank. A run that states no setup has no face to key a map to.
        ...(cutEntry === null ? {} : { cutMaps: [cutEntry] }),
      };
      const r = await io.recordFinishedProgram(machineId, hash, run);
      lines.push(
        r.ok
          ? r.added
            ? `The program is recorded as finished on this machine (${hash}), so it will not be offered the air run again.`
            : `The program was already recorded as finished on this machine (${hash}).`
          : `The finished program was NOT recorded (${hash}), so it will be offered the air run again: ${r.text}`,
      );
    }
  }
  // The shelf as it is NOW: its store is otherwise loaded only by Manage › Materials.
  if (hasStock) await io.refreshStock();
  const parent = hasStock && ctx ? io.stockItem(ctx.stockEntryId!) : null;

  // The stock.
  if (!hasStock || !ctx) {
    lines.push('No shelf entry is recorded for this job, so the shelf is unchanged (the job flow will say which stock it reserved).');
  } else if (!lastProgram) {
    lines.push(
      `${programWord} finished cleanly: the stock stays reserved until the job's last program finishes.`,
    );
  } else {
    const r = await io.consume(ctx.stockEntryId!, ctx.jobId!);
    lines.push(r.ok ? `Stock used: ${ctx.stockEntryId} is taken off the shelf.` : `The stock was not taken off the shelf: ${r.text}`);
  }

  // The runtime — written once, never retried.
  const reading = cuts ? runtimeOf(cuts, outcome.last.elapsedS) : null;
  if (reading === null) lines.push('No runtime was counted: neither the program nor the run says how long it cut.');
  else if (cuts && cuts.tools.length > 1) lines.push('No runtime was counted: the program changes between tools, and one program per tool is the rule.');
  else if (machineId === null) lines.push('No runtime was counted: this machine is not one of the location’s.');
  else {
    const items = io.inventory();
    const who = copyInMachine(items, machineId, ctx?.toolKey ?? null);
    if (!who.ok) lines.push(`No runtime was counted: ${who.reason}.`);
    else {
      const item = items.find((i) => i.id === who.itemId)!;
      const material = ctx?.material ?? parent?.material ?? null;
      const fibre = ctx?.fibre ?? null;
      const weighed = weighRuntime(reading, material, material === null ? null : io.wearWeight(wearKey(material, fibre)), fibre);
      const w = await io.updateItem(withRuntime(item, who.copyId, weighed.minutes));
      lines.push(
        w.ok
          ? `Runtime added to ${item.tool.name} (copy ${who.copyId}): ${weighed.note}.`
          : `The runtime (${r2(weighed.minutes)} wear-minutes) was NOT added — the write failed, and it is not retried so it cannot count twice: ${w.text}`,
      );
    }
  }

  // The offcut.
  let offcut: RunEnd['offcut'] = null;
  if (!ctx || !hasStock) {
    // Said above.
  } else if (!lastProgram) {
    // The job is not finished, so its blank is not scrap yet; the last program offers one.
  } else if (!io.offerOffcuts()) lines.push('No offcut is offered: the shop has offcut offers turned off (offcut.offer).');
  else if (parent === null) lines.push('No offcut is offered: the shelf entry is not loaded.');
  else if (!ctx.stockXY || ctx.toolRadius === undefined) lines.push('No offcut is offered: the job did not say the stock’s size as cut, or the cutter’s radius.');
  else {
    const offer = offcutOffer({
      parent,
      stockXY: ctx.stockXY,
      cuts: cuts!,
      toolRadius: ctx.toolRadius,
      minSideMm: io.minSideMm(),
      ...(ctx.partAt ? { partAt: ctx.partAt } : {}),
      jobId: ctx.jobId!,
      id: io.newId(),
      at: io.now(),
    });
    if (offer.kind === 'offer') offcut = { item: offer.item, text: offer.text, state: 'asked' };
    else lines.push(`No offcut is offered: ${offer.reason}.`);
  }
  return { kind: 'finished', lines, offcut, stockQuestion: null };
}

/**
 * #425 §6 — the ONE write a run end makes to the document's run log.
 *
 * The machine entry records what the controller did; the document records what happened to the
 * program it froze, so Save/Open carries the resume point. It is written only when all three hold:
 *
 *  - the run's context names its job, program and setup (a run prepared outside the job flow does
 *    not — there is no document fact to invent);
 *  - that job is the OPEN document (an outcome for another job id is not this document's);
 *  - the document's frozen package still carries this exact program hash. A re-freeze prunes the
 *    old programs, and an outcome for a program that no longer exists is not a resume fact.
 *
 * `finished` is the only outcome that means done; `stopped` and `failed` both resume by playing
 * the program again from its beginning (#425 §6).
 */
function recordProgramOutcome(
  context: RunContext | null,
  outcome: RunOutcome,
  /** #1154 — the program's kept `?` status lines, when the watch collected any. */
  statusLog: StatusLog | null = null,
): void {
  if (
    context?.jobId === undefined ||
    context.programHash === undefined ||
    context.setupIndex === undefined ||
    context.setupId === undefined
  ) {
    return;
  }
  const document = useEngraveJobStore.getState();
  if (document.job.id !== context.jobId) return;
  const frozen = document.job.package?.programs.some((program) => program.hash === context.programHash) === true;
  if (!frozen) return;
  document.appendRunLog({
    programHash: context.programHash,
    setupIndex: context.setupIndex,
    setupId: context.setupId,
    toolKey: context.toolKey ?? document.job.toolKey,
    at: new Date().toISOString(),
    outcome:
      outcome.kind === 'finished'
        ? 'finished'
        : outcome.kind === 'aborted' || outcome.kind === 'stopped-unconfirmed'
          ? 'stopped'
          : 'failed',
    // #604 — the run transcript is store-only otherwise and lost on reload; keep it with the run record.
    transcript: useMachineTranscriptStore.getState().runLines ?? undefined,
    // #1154 — THE HOUSE COPY of the run's own heartbeat: kept with the finished-program record, so
    // Save / Save all can write `<program>-status.log` beside the run record, even after a reload.
    ...(statusLog === null || statusLog.seen === 0
      ? {}
      : {
          statusLog: statusLog.text({
            jobName: document.job.name,
            programIndex: context.programIndex ?? 1,
            programTotal: context.programTotal ?? 1,
          }),
        }),
  });
}

export interface RunEntry {
  running: boolean;
  /**
   * #1153 — THE RUN'S OWN IDENTITY. A run's asynchronous tail (its outcome and its end-of-run write)
   * must write only onto the entry it belongs to: `prepare` issues a fresh id, and a late write from
   * a run whose entry has since been replaced is DROPPED — never merged into the run now on the
   * machine. The bench shape is Stop, then Try again quickly: the stopped run's end-of-run write is
   * still in flight (it runs after the console is closed) when the retry is prepared under the same
   * machine key, and without this it landed on the retry's entry.
   */
  runId: number;
  filename: string;
  /** The hash of the program that was uploaded — the once-per-program confirmation's key (Q17). */
  programHash: string;
  progress: Progress | null;
  lines: string[];
  outcome: RunOutcome | null;
  stopAsked: boolean;
  /**
   * #618 — the job is suspended at the machine (or a suspend went out unanswered). The panel offers
   * Resume instead of Pause while this is true; the run watch treats it as "not finished".
   */
  paused: boolean;
  /**
   * #1145 — THE RUN'S OWN CLOCK: wall-clock ms when the watch first saw a `P:` reading, or null
   * before one. The Cut step's time left and the run's recorded runtime read THIS, never `P:`'s
   * third field: the 2026-11-09 bench samples showed that field is not seconds on a real program
   * (1,776 at ~25 s in and 4,641 at ~4 min of the same ~5-minute run). Absent on an entry written
   * before the field existed, which reads as "no clock".
   */
  firstProgressAt?: number | null;
  /** #1145 — suspended (or operator tool-change) time already completed, ms. */
  pausedMs?: number;
  /** #1145 — wall-clock ms the current suspension began, or null when the job is not suspended. */
  pausedAt?: number | null;
  /**
   * #655 — the machine is stopped in the firmware's `Tool` state after a `T<n> M6`, waiting for the
   * operator's `M490.2`. Non-null while it waits; `awaited` is the tool the controller names (the
   * T field's third value), null when the line did not say. Absent (an entry written before #655)
   * reads as "not waiting".
   */
  toolWaiting?: { awaited: number | null } | null;
  /** What the job told the run (#414), or null. */
  context: RunContext | null;
  /** The end of the run, once its outcome is known (#414). */
  end: RunEnd | null;
  /**
   * A stopped run's "was the stock used?" that nobody has answered yet — kept across the next upload
   * and run on this machine, so it is never dropped without a word (#414 review).
   */
  pendingStock: { entryId: string; jobId: string } | null;
}

export interface MachineRunState {
  runs: Record<string, RunEntry>;
  /** An upload went through: this file is what "Run it" will play. Refused while a run is going. */
  prepare: (target: { host: string; port: number }, filename: string, programHash: string, context?: RunContext) => boolean;
  /** Start the prepared program; false when one is already running there, or nothing is prepared. */
  start: (target: { host: string; port: number }, settings: RunSettings) => boolean;
  requestStop: (machine: string) => void;
  /**
   * #618 — ask the watching run to suspend the job. The line goes out at the next poll boundary (the
   * run owns the console); a no-op when nothing is running, when a stop is already asked, or when the
   * job is already paused.
   */
  requestPause: (machine: string) => void;
  /** #618 — ask a suspended run to resume. A no-op unless the job is paused and still running. */
  requestResume: (machine: string) => void;
  /**
   * #655 — carry a program on past the firmware's `Tool` stop: the run sends `M490.2` at its next
   * poll boundary (the machine measures the tool and resumes). A no-op when no run is going.
   */
  requestToolContinue: (machine: string) => void;
  /** The offcut question: one click keeps it on the shelf. */
  keepOffcut: (machine: string) => Promise<void>;
  /** "Ignore scrap" on this run: the offcut is skipped, nothing reaches the shelf. */
  skipOffcut: (machine: string) => void;
  /** A stopped run: was the stock used? Yes consumes it; no leaves the reservation. */
  answerStockUsed: (machine: string, used: boolean) => Promise<void>;
}

export function machineKey(target: { host: string; port: number }): string {
  return `${target.host}:${target.port}`;
}

/** The Stop/Pause flags a watch reads at its boundaries — outside zustand, so reading never re-renders. */
const flags = new Map<string, { stop: boolean; pauseAsk: PauseAction | null }>();

/** The next run's identity, issued by `prepare` (#1153). Never reused within a session. */
let runSeq = 0;
/**
 * #1154 — THE RUN'S HEARTBEAT LOG, one per machine (one run at a time). It lives outside the
 * zustand entry for the reason `flags` does: it changes on every poll and nothing renders it. The
 * thinning rule and the text are `runStatusLog.ts`'s; this map only carries the collector from the
 * first poll to the run's end, where it is handed to `recordProgramOutcome`.
 */
const statusLogs = new Map<string, StatusLog>();
/**
 * #1208 (bounded) — THE RUN'S CONVERSATION FOR ITS STOP REPORT, one per machine, outside zustand
 * for the same reason `statusLogs` is: it changes on every poll and nothing renders it. A fixed
 * ring for the `?` status exchanges (sized by `report.statusPollsKept`), every command kept whole
 * — never the whole-array copy per poll that grew a 3 h run to thousands of entries.
 */
const transcripts = new Map<string, RunTranscript>();

/** The conversation a stop report carries for this machine's current run (#1208), or empty. */
export function runTranscriptFor(machine: string): RunTranscriptView {
  return transcripts.get(machine)?.view() ?? { entries: [], droppedPolls: 0 };
}

export const useMachineRunStore = create<MachineRunState>((set, get) => {
  const patch = (machine: string, p: Partial<RunEntry>) =>
    set((s) => {
      const current = s.runs[machine];
      // A late callback from a run whose entry was forgotten — a reset while an `endOfRun` or
      // offcut write was still in flight — must not resurrect a HALF entry. `prepare` is the only
      // writer of `filename`, `programHash` and `lines`; a patch alone carries none of them, and
      // `EngraveMachineRun` renders `entry.lines`, so a resurrected fragment would crash the panel.
      // Dropping the patch is right: there is no run left for it to describe.
      if (current === undefined) return s;
      return { runs: { ...s.runs, [machine]: { ...current, ...p } } };
    });

  return {
    runs: {},
    prepare: (target, filename, programHash, context) => {
      const machine = machineKey(target);
      if (get().runs[machine]?.running) return false;
      // #1154 — a prepare starts a new program: an abandoned watch's collector is not this one's.
      statusLogs.delete(machine);
      transcripts.delete(machine);
      set((s) => ({
        runs: {
          ...s.runs,
          [machine]: {
            runId: ++runSeq,
            running: false,
            filename,
            programHash,
            progress: null,
            lines: [],
            outcome: null,
            stopAsked: false,
            paused: false,
            firstProgressAt: null,
            pausedMs: 0,
            pausedAt: null,
            toolWaiting: null,
            context: context ?? null,
            end: null,
            pendingStock: s.runs[machine]?.pendingStock ?? null,
          },
        },
      }));
      return true;
    },
    start: (target, settings) => {
      const machine = machineKey(target);
      const prepared = get().runs[machine];
      if (!prepared || prepared.running) return false;
      const runId = prepared.runId;
      /**
       * #1153 — A WRITE FROM THIS RUN. Dropped the moment the entry belongs to another run (a retry
       * prepared while this run's tail is in flight) or to nothing (a reset). The run's own outcome
       * and end-of-run write go through here; nothing a dead run learns may surface under the run
       * now on the machine.
       */
      const patchRun = (p: Partial<RunEntry>) => {
        if (get().runs[machine]?.runId !== runId) return;
        patch(machine, p);
      };
      const f: { stop: boolean; pauseAsk: PauseAction | null } = { stop: false, pauseAsk: null };
      flags.set(machine, f);
      // #1154 — the heartbeat log's clock starts where the program does: "the first 5 min" is the
      // run's, not the first reply's.
      statusLogs.set(machine, createStatusLog(Date.now()));
      // #1208 (bounded) — the report's conversation starts here too. Commands are kept whole; the
      // status exchanges are a fixed ring sized by the shop's `report.statusPollsKept` (#1207).
      transcripts.set(
        machine,
        new RunTranscript(readDefault(useShopDefaultsStore.getState().defaults, 'report.statusPollsKept').value),
      );
      patch(machine, { running: true, progress: null, lines: [], outcome: null, stopAsked: false, paused: false, firstProgressAt: null, pausedMs: 0, pausedAt: null, toolWaiting: null, end: null });
      const session = attachConsole(target);
      // #1173 — THE RUN IS THE STATUS POLLER while it lasts. Its hold says so, so the machine
      // store's shared timer stays off for this machine; a page that opens during the run adds a
      // hold and no second `?` stream. Each poll below feeds the store the way a tick would.
      const releaseStatusPoll = acquireStatusPoll(target, 'run', { pollsItself: true });
      // #1060 — the job's/shop's choice, gated on this machine's own capability (where the target
      // maps to a known machine; an unknown target keeps the choice, as the antistatic does).
      const targetMachineId2 = io.machineIdFor(target);
      const blow =
        prepared.context?.blow === true &&
        (targetMachineId2 === null || MACHINES[targetMachineId2]?.capabilities.blow === true);
      void (async () => {
        /** This run's outcome, whether or not the entry still belongs to it (#1153). */
        let outcome: RunOutcome | null = null;
        try {
          outcome = await runProgram(prepared.filename, {
            session,
            settings,
            // #419 Q-E — a file that carries its own words owns the vacuum; a middle file of a
            // multi-file job carries none, so its context says so explicitly. A run prepared
            // without either (anything not uploaded through the job flow) keeps the fallback.
            programOwnsVacuum:
              prepared.context?.vacuumOwned === true ||
              prepared.context?.vacuumSpan !== undefined ||
              programOwnsVacuum(prepared.context?.nc),
            ...(prepared.context?.vacuumSpan === undefined ? {} : { vacuumSpan: prepared.context.vacuumSpan }),
            // #564 — the antistatic runs for plastic jobs only. The run's context carries the job's
            // stock material (runContextFor); a run prepared without one (a file uploaded outside the
            // job flow) has no material to gate on, so the antistatic stays off.
            antistatic:
              prepared.context?.material !== undefined && isPlasticMaterial(prepared.context.material),
            // #1060 — the blower, on the same footing as the antistatic: the run switches it, the
            // file never carries it. Gated on the machine's own capability where the id is known.
            blow,
            stopRequested: () => f.stop,
            // #618 — the ask is TAKEN (cleared) at the boundary it is sent on, so one press is one
            // suspend/resume and a later boundary cannot send it again.
            takePauseRequest: () => {
              const ask = f.pauseAsk;
              f.pauseAsk = null;
              return ask;
            },
            onEvent: (e) => {
              const entry = get().runs[machine];
              if (entry === undefined || entry.runId !== runId) return;
              if (e.kind === 'poll') {
                // #1173 — the run's own answer is the store's live status too, so Manage's state
                // card follows the run without polling the controller itself.
                noteRunStatus(e.raw);
                // #1145 — THE FIRST `P:` IS THE CLOCK'S ANCHOR. A poll before the program reports
                // progress has no `P:` field: nothing to start a program clock from yet.
                const first =
                  entry.firstProgressAt ??
                  (e.progress.percent !== null || e.progress.line !== null ? Date.now() : null);
                patch(machine, {
                  progress: e.progress,
                  ...(first === null ? {} : { firstProgressAt: first }),
                });
                // #1154 — keep the heartbeat line (the collector applies the thinning rule).
                statusLogs.get(machine)?.push({ atMs: e.atMs, ...readStatusFields(e.raw) });
              }
              else if (e.kind === 'note') patch(machine, { lines: [...entry.lines, `(${e.text})`] });
              else if (e.kind === 'sent') {
                // #1208 (bounded) — THE REPORT'S CONVERSATION. Every COMMAND is kept whole; the `?`
                // status exchanges go into the fixed ring, so a report carries the run's tail and
                // the store neither grows nor copies per poll (#1147's class). `lines` stays the
                // display's: a `?` has no display line, and a reply there is flattened to one. A
                // `poll` event needs no entry of its own: it follows the `sent` '?' carrying the
                // same raw text, while the opening poll (and the stop's polls) produce none at all.
                transcripts.get(machine)?.push(e.line, e.reply, e.line === '?');
                if (e.line !== '?') {
                  patchRun({ lines: [...entry.lines, `> ${e.line}  ${e.reply.trim().split('\n')[0] ?? ''}`] });
                }
              } else if (e.kind === 'missed') {
                // A missed status poll is a result, not an error: the page reads "not answering".
                noteRunStatus(null);
                patchRun({ lines: [...entry.lines, `(no status reply ${e.misses})`] });
              } else if (e.kind === 'paused') {
                patchRun({
                  paused: true,
                  // #1145 — the clock stops at a suspension: no cutting happens while it is on.
                  ...(entry.firstProgressAt == null ? {} : { pausedAt: entry.pausedAt ?? Date.now() }),
                  lines: [
                    ...entry.lines,
                    e.unconfirmed
                      ? `(Paused at line ${e.at.line ?? '—'} — the controller did not answer the suspend. It may be suspended; Resume or Stop.)`
                      : `(Paused at line ${e.at.line ?? '—'} — the job is suspended. Resume to continue.)`,
                  ],
                });
              } else if (e.kind === 'tool-waiting') {
                patchRun({
                  toolWaiting: { awaited: e.awaited },
                  // #1145 — a tool change is hands-on time, not cutting time: the clock stops too.
                  ...(entry.firstProgressAt == null ? {} : { pausedAt: entry.pausedAt ?? Date.now() }),
                  lines: [
                    ...entry.lines,
                    `(The machine is waiting for the tool change${
                      e.awaited === null ? '' : ` (tool ${e.awaited})`
                    } — the program resumes on Continue.)`,
                  ],
                });
              } else if (e.kind === 'tool-continued') {
                patch(machine, {
                  toolWaiting: null,
                  ...(entry.pausedAt == null
                    ? {}
                    : { pausedMs: (entry.pausedMs ?? 0) + Math.max(0, Date.now() - entry.pausedAt), pausedAt: null }),
                });
              } else if (e.kind === 'resumed') {
                patchRun({
                  paused: false,
                  ...(entry.pausedAt == null
                    ? {}
                    : { pausedMs: (entry.pausedMs ?? 0) + Math.max(0, Date.now() - entry.pausedAt), pausedAt: null }),
                  lines: [
                    ...entry.lines,
                    e.unconfirmed
                      ? `(Resume sent without an answer — watching; the job is at line ${e.at.line ?? '—'}.)`
                      : `(Resumed at line ${e.at.line ?? '—'}.)`,
                  ],
                });
              }
            },
          });
          // #1145 — THE RECORDED ELAPSED IS OURS. The run's clock (first `P:` to now, less the
          // suspended stretches) replaces `P:`'s third field before anything reads the outcome: the
          // runtime write, the panel's finished line and the estimate comparison all get our
          // seconds, whatever the controller's field 3 meant.
          const clock = runClockSeconds(get().runs[machine] ?? null, Date.now());
          const withClock =
            clock === null || !('last' in outcome)
              ? outcome
              : { ...outcome, last: { ...outcome.last, elapsedS: clock } };
          patch(machine, { outcome: withClock });
        } catch (e) {
          outcome = { kind: 'refused', reason: e instanceof Error ? e.message : String(e) };
          patchRun({ outcome });
        } finally {
          // The run is over BEFORE the end-of-run saves: the console is closed and the panel stops
          // reading "Running…" while the shelf and the inventory are written (#414 review).
          // #618 — a run stopped WHILE PAUSED ends with `paused` cleared too: the strip's Paused
          // word is the suspended RUN's, and nothing is suspended once the run is over (the
          // machine's own state, Idle, is what it reads then).
          try {
            await session.close();
          } finally {
            // #1173 — hand the status polling back to the store's timer, whatever happened to the
            // socket, so a page still open resumes live status rather than staying frozen.
            releaseStatusPoll();
          }
          patchRun({ running: false, paused: false });
        }
        // Once per run: this runs once per `start`, and `end` is cleared only by the next one.
        // #1153 — the outcome is the RUN's, not whatever entry exists now; the shelf and inventory
        // writes below are what the machine did and stand even if a retry has been prepared. The
        // entry still carries this run's own (#1145 clocked) outcome while the identity matches;
        // after that, the run's local copy is the one to write.
        const statusLog = statusLogs.get(machine) ?? null;
        statusLogs.delete(machine);
        const entryNow = get().runs[machine];
        const runOutcome = entryNow !== undefined && entryNow.runId === runId ? entryNow.outcome : outcome;
        if (runOutcome === null) return;
        // #425 §6 — the document's resume fact, written once per run end, before the shelf writes.
        // #1154 — and the kept heartbeat lines, with it.
        recordProgramOutcome(prepared.context ?? null, runOutcome, statusLog);
        let end: RunEnd;
        try {
          end = await endOfRun(target, runOutcome, prepared.context ?? null);
        } catch (e) {
          end = { kind: 'nothing', lines: [`The end of the run could not be worked out: ${e instanceof Error ? e.message : String(e)}`], offcut: null, stockQuestion: null };
        }
        // #1153 — THE END-OF-RUN WRITE IS THE RUN'S TOO. If the entry now belongs to another run (a
        // retry prepared under the same machine key while this end was being worked out), drop it:
        // the retry's panel must not show this run's offcut or stock question.
        const still = get().runs[machine];
        if (still === undefined || still.runId !== runId) return;
        const ctx = prepared.context;
        const open = still.pendingStock ?? null;
        if (end.stockQuestion === 'ask' && ctx?.stockEntryId && ctx.jobId) {
          if (open === null || (open.entryId === ctx.stockEntryId && open.jobId === ctx.jobId)) {
            patchRun({ end, pendingStock: { entryId: ctx.stockEntryId, jobId: ctx.jobId } });
          } else {
            // One question at a time: the older one stays open, and this run says it is waiting behind it.
            patchRun({
              end: { ...end, lines: [...end.lines, `An earlier stopped run's question (was ${open.entryId} used by ${open.jobId}?) is still open: answer it first, then this run's stock (${ctx.stockEntryId}) stays reserved until you mark it.`] },
            });
          }
        } else patchRun({ end });
      })();
      return true;
    },
    requestStop: (machine) => {
      const f = flags.get(machine);
      const entry = get().runs[machine];
      if (!f || !entry?.running) return;
      f.stop = true;
      patch(machine, { stopAsked: true, lines: [...entry.lines, '(Stop pressed — abort goes out at the next poll)'] });
    },
    requestPause: (machine) => {
      const f = flags.get(machine);
      const entry = get().runs[machine];
      if (!f || !entry?.running || entry.paused || entry.stopAsked) return;
      f.pauseAsk = 'suspend';
      patch(machine, { lines: [...entry.lines, '(Pause pressed — suspend goes out at the next poll)'] });
    },
    requestResume: (machine) => {
      const f = flags.get(machine);
      const entry = get().runs[machine];
      if (!f || !entry?.running || !entry.paused || entry.stopAsked) return;
      f.pauseAsk = 'resume';
      patch(machine, { lines: [...entry.lines, '(Resume pressed — resume goes out at the next poll)'] });
    },
    requestToolContinue: (machine) => {
      const f = flags.get(machine);
      const entry = get().runs[machine];
      if (!f || !entry?.running || entry.toolWaiting == null || entry.stopAsked) return;
      f.pauseAsk = 'continue-tool';
      patch(machine, { lines: [...entry.lines, '(Continue pressed — M490.2 goes out at the next poll)'] });
    },
    keepOffcut: async (machine) => {
      const end = get().runs[machine]?.end;
      if (!end?.offcut || end.offcut.state !== 'asked') return;
      const offcut = end.offcut;
      patch(machine, { end: { ...end, offcut: { ...offcut, state: 'kept' } } });
      const r = await io.addOffcut(offcut.item);
      const now = get().runs[machine]?.end ?? end;
      patch(machine, {
        end: {
          ...now,
          offcut: { ...offcut, state: r.ok ? 'kept' : 'failed' },
          lines: [...now.lines, r.ok ? `Offcut kept: ${offcut.item.id} is on the shelf.` : `The offcut was not added: ${r.text}`],
        },
      });
    },
    skipOffcut: (machine) => {
      const end = get().runs[machine]?.end;
      if (!end?.offcut || end.offcut.state !== 'asked') return;
      patch(machine, { end: { ...end, offcut: { ...end.offcut, state: 'skipped' }, lines: [...end.lines, 'Scrap ignored: nothing was added to the shelf.'] } });
    },
    answerStockUsed: async (machine, used) => {
      const entry = get().runs[machine];
      const pending = entry?.pendingStock;
      if (!entry || !pending) return;
      const say = (line: string, answer: 'used' | 'not-used') => {
        const now = get().runs[machine]!;
        const base: RunEnd = now.end ?? { kind: 'stopped', lines: [], offcut: null, stockQuestion: null };
        patch(machine, { end: { ...base, stockQuestion: answer, lines: [...base.lines, line] } });
      };
      // Answered once: the question is cleared before the write, so a second click does nothing.
      patch(machine, { pendingStock: null });
      if (!used) {
        say(`The stock stays reserved for ${pending.jobId}.`, 'not-used');
        return;
      }
      const r = await io.consume(pending.entryId, pending.jobId);
      say(r.ok ? `Stock used: ${pending.entryId} is taken off the shelf.` : `The stock was not taken off the shelf: ${r.text}`, 'used');
    },
  };
});

/** Test seam. */
export function resetMachineRunStore(): void {
  flags.clear();
  statusLogs.clear();
  transcripts.clear();
  useMachineRunStore.setState({ runs: {} });
}
