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
import { copyInMachine, offcutOffer, programCuts, runtimeOf, wearKey, weighRuntime, withRuntime } from '@/engine/cnc/runEnd';
import type { StockItem } from '@/platform/stockClient';
import type { InventoryItem } from '@/platform/houseClient';
import type { EngraveJob, FilamentFibre } from '@/types/engraveJob';
import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import { readDefault, readFlag } from '@/platform/defaultsClient';
import { newStockId, useStockStore } from './stockStore';
import { useToolRegistryStore } from './toolRegistryStore';
import { useHouseStore } from './houseStore';
import { machineAt, useLocationStore } from './locationStore';
import { useShopDefaultsStore } from './shopDefaultsStore';

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
    ...(job.stockEntry?.shelfId ? { stockEntryId: job.stockEntry.shelfId } : {}),
    stockXY: { x: job.stock.length, y: job.stock.width },
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
  recordFinishedProgram: (machineId: string, hash: string) => Promise<{ ok: boolean; added: boolean; text: string }>;
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
  recordFinishedProgram: (machineId, hash) => useLocationStore.getState().recordFinishedProgram(machineId, hash),
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
      const r = await io.recordFinishedProgram(machineId, hash);
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
    lines.push('No shelf entry is recorded for this job, so the shelf is unchanged (the job flow, #419, will say which stock it reserved).');
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
  else if (cuts && cuts.tools.length > 1) lines.push('No runtime was counted: the program changes between tools, and one program per tool is the rule (Q15).');
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

export interface RunEntry {
  running: boolean;
  filename: string;
  /** The hash of the program that was uploaded — the once-per-program confirmation's key (Q17). */
  programHash: string;
  progress: Progress | null;
  lines: string[];
  outcome: RunOutcome | null;
  stopAsked: boolean;
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

/** The Stop flag a watch reads at its boundaries — outside zustand, so reading it never re-renders. */
const flags = new Map<string, { stop: boolean }>();

export const useMachineRunStore = create<MachineRunState>((set, get) => {
  const patch = (machine: string, p: Partial<RunEntry>) =>
    set((s) => ({ runs: { ...s.runs, [machine]: { ...(s.runs[machine] as RunEntry), ...p } } }));

  return {
    runs: {},
    prepare: (target, filename, programHash, context) => {
      const machine = machineKey(target);
      if (get().runs[machine]?.running) return false;
      set((s) => ({
        runs: {
          ...s.runs,
          [machine]: {
            running: false,
            filename,
            programHash,
            progress: null,
            lines: [],
            outcome: null,
            stopAsked: false,
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
      const f = { stop: false };
      flags.set(machine, f);
      patch(machine, { running: true, progress: null, lines: [], outcome: null, stopAsked: false, end: null });
      const session = attachConsole(target);
      void (async () => {
        try {
          const outcome = await runProgram(prepared.filename, {
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
            stopRequested: () => f.stop,
            onEvent: (e) => {
              const entry = get().runs[machine];
              if (!entry) return;
              if (e.kind === 'poll') patch(machine, { progress: e.progress });
              else if (e.kind === 'note') patch(machine, { lines: [...entry.lines, `(${e.text})`] });
              else if (e.kind === 'sent' && e.line !== '?') {
                patch(machine, { lines: [...entry.lines, `> ${e.line}  ${e.reply.trim().split('\n')[0] ?? ''}`] });
              } else if (e.kind === 'missed') patch(machine, { lines: [...entry.lines, `(no status reply ${e.misses})`] });
            },
          });
          patch(machine, { outcome });
        } catch (e) {
          patch(machine, { outcome: { kind: 'refused', reason: e instanceof Error ? e.message : String(e) } });
        } finally {
          // The run is over BEFORE the end-of-run saves: the console is closed and the panel stops
          // reading "Running…" while the shelf and the inventory are written (#414 review).
          await session.close();
          patch(machine, { running: false });
        }
        // Once per run: this runs once per `start`, and `end` is cleared only by the next one.
        const outcome = get().runs[machine]?.outcome ?? null;
        if (outcome === null) return;
        let end: RunEnd;
        try {
          end = await endOfRun(target, outcome, prepared.context ?? null);
        } catch (e) {
          end = { kind: 'nothing', lines: [`The end of the run could not be worked out: ${e instanceof Error ? e.message : String(e)}`], offcut: null, stockQuestion: null };
        }
        const ctx = prepared.context;
        const open = get().runs[machine]?.pendingStock ?? null;
        if (end.stockQuestion === 'ask' && ctx?.stockEntryId && ctx.jobId) {
          if (open === null || (open.entryId === ctx.stockEntryId && open.jobId === ctx.jobId)) {
            patch(machine, { end, pendingStock: { entryId: ctx.stockEntryId, jobId: ctx.jobId } });
          } else {
            // One question at a time: the older one stays open, and this run says it is waiting behind it.
            patch(machine, {
              end: { ...end, lines: [...end.lines, `An earlier stopped run's question (was ${open.entryId} used by ${open.jobId}?) is still open: answer it first, then this run's stock (${ctx.stockEntryId}) stays reserved until you mark it.`] },
            });
          }
        } else patch(machine, { end });
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
  useMachineRunStore.setState({ runs: {} });
}
