/**
 * #1128 follow-up — WHAT A DO ROW'S BUTTON DOES.
 *
 * A Do row is an act. The preflight page is deliberately a reader (it freezes, reserves, plans,
 * uploads and starts nothing), so this module names the act — a small table beside the bands —
 * and the Cut surface supplies the handler. The handler is ALWAYS the one the original control
 * already calls: the machine-record banner's wizard, the cutter list's own fix, the clearance
 * statement's tick. Nothing here re-implements a fix, and the band table stays the only place a
 * code's grading lives.
 *
 * A Do code with no in-app control (for example "a through cut needs a board — fit one") has no
 * entry: the row still says what to do, without a button that pretends the app can do it.
 *
 * THE CLEARANCE ACTION NEVER TICKS THE STATEMENT. The tick is the operator's own statement that
 * they checked the vise and the tool's reach themselves; a one-click "acknowledge" in the
 * findings list would let them tick it without reading it. The action reveals the statement (opens
 * step 1, scrolls to it) and focuses its checkbox — the tick stays theirs.
 */

import type { PreflightRow } from './types';

/** The acts a Do row can offer, named for the surface that owns the handler. */
export type FindingAction = 'change-machine' | 'choose-cutter' | 'clearance' | 'set-feeds';

export interface FindingActionDef {
  action: FindingAction;
  /** The words the original control uses, so the row and the banner cannot read as two fixes. */
  label: string;
}

/**
 * The codes with an in-app act. The machine record and the missing cutter open the same surfaces
 * their banners/cards open; the clearance codes are the one statement step 1 asks, and they are Do
 * by band because that statement is a physical check before the run.
 */
export const FINDING_ACTIONS: Readonly<Partial<Record<string, FindingActionDef>>> = {
  'mount-not-on-bed': { action: 'change-machine', label: 'Change the machine…' },
  'tool-missing': { action: 'choose-cutter', label: 'Choose a cutter' },
  'vise-default': { action: 'clearance', label: 'Read the clearance statement' },
  'holder-vs-fixture-unproven': { action: 'clearance', label: 'Read the clearance statement' },
  'holder-unproven': { action: 'clearance', label: 'Read the clearance statement' },
  'released-onto-board': { action: 'clearance', label: 'Read the clearance statement' },
};

/**
 * The action a row offers, or null when its act has no in-app control.
 *
 * #1123 item 56(a) — the borrowed-feeds row is the one act that is not a fixed code: the same
 * `goal-cutter-substituted` code is a Know when a cutter was swapped, and the feeds row only when
 * a feed row was borrowed. Its act opens the house's feeds table (Manage › Tools › feeds).
 */
export function findingActionFor(
  row: Pick<PreflightRow, 'code' | 'feedsProxyMm'>,
): FindingActionDef | null {
  if (row.code === 'goal-cutter-substituted' && row.feedsProxyMm !== undefined) {
    return { action: 'set-feeds', label: 'Set their feeds' };
  }
  return FINDING_ACTIONS[row.code] ?? null;
}

/** The handlers the Cut surface already owns — one per act, never a second implementation. */
export interface FindingActionHooks {
  /** The machine-record banner's own press (`changeMachineForMount`). */
  changeMachine: () => void;
  /** The Design cutter group's own fix (`applyFix({ group: 'engrave-group-cutter', … })`). */
  openCutters: () => void;
  /** Reveal the clearance statement and focus its checkbox — never write the tick. */
  showClearance: () => void;
  /** #1123 item 56(a) — open the house's feeds table (Manage › Tools › feeds). */
  openFeeds: () => void;
}

/** Run one act through the surface's own handler. */
export function runFindingAction(action: FindingAction, hooks: FindingActionHooks): void {
  if (action === 'change-machine') hooks.changeMachine();
  else if (action === 'choose-cutter') hooks.openCutters();
  else if (action === 'set-feeds') hooks.openFeeds();
  else hooks.showClearance();
}
