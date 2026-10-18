/**
 * The Setups section's pure reading of the document (#471, §5.4): what the saved list is, what has
 * gone stale underneath it, what an edit invalidates, and whether a setup can be added at all.
 *
 * THE LIST IS AUTHORITATIVE. Once `job.setups` exists, this module never rewrites it: a removed or
 * disabled item is REPORTED, not silently deleted from a setup, and the person chooses between
 * "remove from setup" and "Re-plan". The implicit reading (a job with no `setups[]`) is derived
 * fresh on every call and cannot go stale.
 *
 * The two section-level codes below are the only diagnostics this module raises. They live here
 * rather than in `validateJob` because they are about the SAVED LIST agreeing with the document,
 * not about the document's cuts: `validateJob` runs on a job whose setups this module may be in
 * the middle of helping the person edit.
 */

import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';
import { removalsFrom, isSyntheticRemovalId } from './fromJob';
import { buildSetups, planSetups } from './plan';
import type { SetupsSettings } from './settings';
import { FACES, type Face, type MountSpec, type Orientation, type Removal, type SetupsInput, type SetupsPlan } from './types';

/**
 * A section-level code: the saved setups no longer agree with the document. Registered in the
 * cnc-guide's chapter 8 (the guide gate scans this file's `code:` literals).
 */
export type SetupAuthoringCode = 'setup-no-cuts' | 'setup-item-missing';

export interface SetupAuthoringFinding {
  severity: 'error';
  code: SetupAuthoringCode;
  /** 1-based, the number the operator reads ("Setup 2"). */
  setupIndex: number;
  /** The ids in that setup the finding is about; empty when the setup names none. */
  itemIds: string[];
  message: string;
}

/** One saved setup's item list, read against the document as it is NOW. */
export interface SetupItemsReading {
  /** 1-based, matching the finding's words. */
  setupIndex: number;
  /** Every id the saved setup names, in its saved order. */
  itemIds: string[];
  /** Ids the document still cuts — the ones the planner can use. */
  cut: string[];
  /** Ids no longer in the job at all (`setup-item-missing`). */
  missing: string[];
  /**
   * Ids still in the document but no longer cut: disabled, `construction`, a label with no text,
   * or an id that is not a cutting item at all. The section says "not cut in this setup".
   */
  notCut: string[];
}

export type SetupsSource = 'implicit' | 'saved' | 'empty';

export interface SetupsReading {
  /**
   * `implicit` — no `setups[]`; one derived top-up setup. `saved` — the document's own list.
   * `empty` — no saved list and nothing to cut, so there is no setup to plan.
   */
  source: SetupsSource;
  /** The saved list, or the implicit single setup. Never a fresh greedy grouping. */
  setups: JobSetup[];
  items: SetupItemsReading[];
  /** Cut item ids in NO saved setup. Always empty for the implicit reading. */
  unassigned: string[];
  /** The two section codes; empty for the implicit reading, which cannot be stale. */
  findings: SetupAuthoringFinding[];
  /** Whether the saved list no longer matches the document (missing, not-cut or unassigned). */
  stale: boolean;
}

/** The faces a stored setup presents up: the stock face at the machine's top. */
export function faceUpOf(setup: JobSetup): Face {
  return setup.orientation.top;
}

/**
 * The ids of the cuts the document has now, in the planner's order (`removalsFrom`'s). The facing
 * pass is not a job item, so its synthetic id is excluded — `setups[].itemIds` is item ids only.
 */
export function cutItemIds(job: EngraveJob): string[] {
  return removalsFrom(job)
    .map((r) => r.id)
    .filter((id) => !isSyntheticRemovalId(id));
}

/** Every id that names something in the document, whether or not it cuts. */
function itemIdsIn(job: EngraveJob): Set<string> {
  const ids = new Set<string>();
  const lists: { id: string }[] = [
    ...job.labels,
    ...job.shapes,
    ...(job.combined ?? []),
    ...(job.traces ?? []),
    ...(job.vectors ?? []),
    ...(job.drills ?? []),
    ...(job.threads ?? []),
    // #435 — a primitive is addressable by a setup whether or not it cuts; a disabled or refused
    // form is `notCut`, not `missing`.
    ...(job.primitives ?? []),
    ...(job.keepOuts ?? []),
  ];
  for (const item of lists) ids.add(item.id);
  return ids;
}

function readItems(setup: JobSetup, index: number, cut: Set<string>, present: Set<string>): SetupItemsReading {
  const missing: string[] = [];
  const notCut: string[] = [];
  const usable: string[] = [];
  for (const id of setup.itemIds) {
    if (!present.has(id)) missing.push(id);
    else if (cut.has(id)) usable.push(id);
    else notCut.push(id);
  }
  return { setupIndex: index + 1, itemIds: [...setup.itemIds], cut: usable, missing, notCut };
}

/** A comma list for a finding's message: `a`, `a and b`, `a, b and c`. */
function words(ids: string[]): string {
  if (ids.length <= 1) return ids.join('');
  return `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`;
}

/**
 * Read the document's setups: the saved list (or the implicit one), each setup's items classified
 * against the cuts the job has now, and the section-level findings.
 *
 * A setup whose item list is left with NO cut item is `setup-no-cuts`; a setup naming an id the
 * document no longer has is `setup-item-missing`. Both can fire for one setup — the second says
 * what went, the first says the setup is now empty. Cut items in no setup are reported as
 * `unassigned`; they make the list stale but are not a finding, because the answer is to assign
 * them (or re-plan), not to remove something.
 */
export function readSetups(job: EngraveJob): SetupsReading {
  const saved = job.setups !== undefined;
  const setups = jobSetups(job);
  const cutIds = cutItemIds(job);
  const cut = new Set(cutIds);
  const present = itemIdsIn(job);
  const items = setups.map((setup, i) => readItems(setup, i, cut, present));

  if (!saved) {
    return {
      source: cutIds.length === 0 ? 'empty' : 'implicit',
      setups,
      items,
      unassigned: [],
      findings: [],
      stale: false,
    };
  }

  const assigned = new Set(items.flatMap((r) => r.cut));
  const unassigned = cutIds.filter((id) => !assigned.has(id));
  const findings: SetupAuthoringFinding[] = [];
  for (const r of items) {
    if (r.missing.length > 0) {
      findings.push({
        severity: 'error',
        code: 'setup-item-missing',
        setupIndex: r.setupIndex,
        itemIds: r.missing,
        message:
          `Setup ${r.setupIndex} names ${r.missing.length === 1 ? 'an item' : `${r.missing.length} items`} ` +
          `that ${r.missing.length === 1 ? 'is' : 'are'} no longer in the job (${words(r.missing)}). ` +
          `Remove ${r.missing.length === 1 ? 'it' : 'them'} from the setup, or re-plan.`,
      });
    }
    if (r.cut.length === 0) {
      findings.push({
        severity: 'error',
        code: 'setup-no-cuts',
        setupIndex: r.setupIndex,
        itemIds: [...r.itemIds],
        message:
          r.itemIds.length === 0
            ? `Setup ${r.setupIndex} names no items, so it has nothing to cut. Remove the setup, or re-plan.`
            : `Setup ${r.setupIndex} has no cut items left: ${words(r.itemIds)} ${r.itemIds.length === 1 ? 'is' : 'are'} ` +
              `missing, disabled or not cut. Remove the setup, or re-plan.`,
      });
    }
  }

  return {
    source: 'saved',
    setups,
    items,
    unassigned,
    findings,
    stale: findings.length > 0 || unassigned.length > 0 || items.some((r) => r.notCut.length > 0),
  };
}

/**
 * The implicit reading, copied into the stored form the first time the person edits setups.
 *
 * A SAVED list is returned untouched — this is the "Edit setups" transition only, never a
 * normalisation pass. The implicit setup's id is stable (`setup-implicit`) and cannot collide with
 * a minted `setup-…` id, so materialising mints nothing.
 */
export function materializeSetups(job: EngraveJob): JobSetup[] {
  if (job.setups !== undefined) return job.setups;
  return jobSetups(job).map((setup) => ({
    ...setup,
    orientation: { ...setup.orientation },
    itemIds: [...setup.itemIds],
    tools: [...setup.tools],
  }));
}

/**
 * The planner's input for the document: the stock, the cuts, and each stored setup's own mount
 * keyed by its up face. The first stored setup supplies the default mount and `firstUp`, so a
 * fresh suggestion agrees with where the operator already starts.
 */
export function setupsInput(job: EngraveJob, setups: readonly JobSetup[] = jobSetups(job)): SetupsInput {
  const mounts: Partial<Record<Face, MountSpec>> = {};
  for (const setup of setups) mounts[faceUpOf(setup)] = setup.mount;
  const first = setups[0];
  return {
    stock: { x: job.stock.length, y: job.stock.width, z: job.stock.thickness },
    removals: removalsFrom(job),
    mount: first?.mount ?? { kind: job.workholding.kind },
    mounts,
    ...(first ? { firstUp: faceUpOf(first) } : {}),
  };
}

/**
 * Build the SAVED list as a plan: each stored setup in its saved order, facing its stored face,
 * holding its stored mount, with its stored items. This is deliberately NOT `planSetups`' fresh
 * greedy grouping — a saved list is the person's decision, and a suggestion belongs behind
 * "Re-plan".
 *
 * An id the document no longer cuts is dropped from this DERIVED plan (the planner cannot weigh a
 * removal that does not exist) but never from the document; `readSetups` reports it. A duplicate
 * assignment is likewise cut once, in the first setup that names it, without rewriting the list.
 */
export function planFromSetups(job: EngraveJob, settings: SetupsSettings): SetupsPlan {
  const input = setupsInput(job);
  const byId = new Map(input.removals.map((r) => [r.id, r]));
  const used = new Set<string>();
  const ordered = jobSetups(job).map((setup) => {
    const items: Removal[] = [];
    for (const id of setup.itemIds) {
      const removal = byId.get(id);
      if (!removal || used.has(id)) continue;
      used.add(id);
      items.push(removal);
    }
    return { face: faceUpOf(setup), items };
  });
  return buildSetups(
    input,
    ordered.filter((group) => group.items.length > 0),
    settings,
  );
}

/** The plan a fresh, unsaved job would get: the engine's greedy suggestion. */
export function suggestedPlan(job: EngraveJob, settings: SetupsSettings): SetupsPlan {
  return planSetups(setupsInput(job), settings);
}

/**
 * Where a new setup could face, or the engine's answer to why none can be added.
 *
 * The candidate faces are the removals' own `opensTo`, less the faces the saved list already holds
 * and the directions the mount cannot hold. When there are none, the reason is the ENGINE's words:
 * an `unholdable` direction's `orient` refusal, or a lost removal's reason, verbatim. Only when the
 * document itself has no unheld direction is a sentence composed here, and it says only what the
 * document's `opensTo` already says.
 */
export function addSetupOffer(
  job: EngraveJob,
  settings: SetupsSettings,
): { face: Face | null; reason: string | null } {
  const input = setupsInput(job);
  const plan = planSetups(input, settings);
  const held = new Set(jobSetups(job).map((setup) => faceUpOf(setup)));
  const unholdable = new Set(plan.unholdable.map((u) => u.face));

  const open = new Set<Face>();
  for (const removal of input.removals) for (const face of removal.opensTo) open.add(face);
  const free = FACES.filter((face) => open.has(face) && !held.has(face) && !unholdable.has(face));
  if (free.length > 0) return { face: free[0]!, reason: null };

  if (plan.unholdable.length > 0) return { face: null, reason: plan.unholdable[0]!.reason };
  if (plan.lost.length > 0) return { face: null, reason: plan.lost[0]!.reason };
  if (input.removals.length === 0) return { face: null, reason: 'the job has no cuts to plan' };

  const opened = FACES.filter((face) => open.has(face));
  return {
    face: null,
    reason:
      opened.length === 1
        ? `every cut opens to the ${opened[0]} face, which is already a setup`
        : `every cut opens to ${opened.slice(0, -1).join(', ')} or ${opened.at(-1)}, which are already setups`,
  };
}

/** An edit the section makes to one setup. `tools` does not move any approved fact. */
export interface SetupChange {
  mount?: MountSpec;
  orientation?: Orientation;
  itemIds?: readonly string[];
  tools?: readonly string[];
}

function sameMount(a: MountSpec, b: MountSpec): boolean {
  return a.kind === b.kind && a.viseOpeningMm === b.viseOpeningMm && a.board === b.board;
}

function sameOrientation(a: Orientation, b: Orientation): boolean {
  return FACES.every((face) => a[face] === b[face]);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function withoutRegistration(setup: JobSetup): JobSetup {
  if (setup.registration === undefined) return setup;
  const { registration: _dropped, ...rest } = setup;
  return rest;
}

function withoutRemount(setup: JobSetup): JobSetup {
  if (setup.remount === undefined) return setup;
  const { remount: _dropped, ...rest } = setup;
  return rest;
}

/**
 * Apply one setup's edit and drop the approvals the change invalidates (#471 decision 5).
 *
 * The rule follows what an approval WAS ABOUT. A registration plan was approved against the
 * setup's mount, its orientation and the cuts already in the stock — so a mount, orientation or
 * item change clears it. A remount instruction was approved against where the stock comes FROM —
 * so those same changes clear it.
 *
 * Later setups inherit the consequence, because their stock entering is built from the earlier
 * setups: an item change there can change a registration's reference features and a remount's
 * landmark question, so both are cleared; a mount/orientation change moves the stock the next
 * remount turns from, so that remount is cleared. Nothing is ever re-derived here — clearing is
 * the whole write, and the section marks what needs planning.
 *
 * A `tools` edit changes no approved fact. An edit that states the value already stored is a
 * no-op for approvals, so a re-render that sends the same list cannot quietly discard them.
 */
export function applySetupChange(setups: readonly JobSetup[], index: number, change: SetupChange): JobSetup[] {
  const target = setups[index];
  if (!target) return [...setups];

  const mount = change.mount !== undefined && !sameMount(target.mount, change.mount);
  const orientation = change.orientation !== undefined && !sameOrientation(target.orientation, change.orientation);
  const itemIds = change.itemIds !== undefined && !sameIds(target.itemIds, change.itemIds);
  const approvals = mount || orientation || itemIds;

  return setups.map((setup, i) => {
    if (i === index) {
      let next: JobSetup = { ...setup };
      if (change.mount !== undefined) next.mount = change.mount;
      if (change.orientation !== undefined) next.orientation = change.orientation;
      if (change.itemIds !== undefined) {
        next.itemIds = [...change.itemIds];
        // #472 — an assignment is about the setup's items; one that left the setup cannot stay.
        if (next.toolItems !== undefined) {
          const kept = new Set(next.itemIds);
          next.toolItems = Object.fromEntries(
            Object.entries(next.toolItems)
              .map(([key, ids]) => [key, ids.filter((id) => kept.has(id))] as const)
              .filter(([, ids]) => ids.length > 0),
          );
        }
      }
      if (change.tools !== undefined) {
        next.tools = [...change.tools];
        // A cutter that left the setup takes its assignment with it; a one-cutter setup needs no
        // map at all (every item is that cutter's), and an empty map would read as "assigned
        // nothing" rather than "no assignment".
        if (next.tools.length <= 1) delete next.toolItems;
        else if (next.toolItems !== undefined) {
          const kept = new Set(next.tools);
          next.toolItems = Object.fromEntries(
            Object.entries(next.toolItems).filter(([key]) => kept.has(key)),
          );
        }
      }
      if (approvals) next = withoutRemount(withoutRegistration(next));
      return next;
    }
    if (i > index) {
      let next = setup;
      if (itemIds) next = withoutRegistration(next);
      if (mount || orientation || itemIds) next = withoutRemount(next);
      return next;
    }
    return setup;
  });
}
