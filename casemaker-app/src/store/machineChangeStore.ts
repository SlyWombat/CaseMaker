/**
 * #693 — whether the change-the-machine wizard is up, and what asked for it.
 *
 * A STORE, NOT A PROP. The opener is called from surfaces that are not its parent — Manage's bed
 * block now, the Holding step and Cut's re-freeze path when those slices land — and the wizard has
 * to outlive whatever screen sits under it (the Manage pane is replaced, not covered). The startup
 * wizard (`startWizardStore`) settled the same shape for the same reason.
 *
 * THE REQUEST IS THE CALLER'S CONTRACT. `target` is the mount the caller needs on the machine (the
 * Holding step's "needs the vise off the pins", Cut's frozen mount); when it is absent the wizard's
 * step 1 offers the mounts this house can give, which is Manage's entry. `forJob` is the job that
 * asked: its name is in step 1 and in the record line, and its frozen mount is re-checked against
 * the new bed so a frozen package whose hold has gone is flagged rather than silently re-run.
 * `onDone` is how the caller gets the outcome when the operator presses the final button.
 *
 * SESSION ONLY. Like the startup wizard, this is a thing you open, not a mode restored on launch: a
 * physical change the app cannot verify it happened must not reopen on its own.
 */

import { create } from 'zustand';
import type { MachineMountKind } from '@/platform/machineChange';

/** The job that asked for the change, as the wizard names it. */
export interface MachineChangeJob {
  /** The job's name, as the operator knows it: "Zoomba badge". */
  name: string;
  /** How the job holds its stock, in the caller's words: "held in the rotary chuck". */
  holding?: string;
  /** True when the job has a frozen package — the only case where a mount change earns a re-freeze. */
  frozen?: boolean;
  /** The mount the frozen package was made for (`vise`, `bracket`, `tape`, `rotary`). */
  frozenMount?: string | null;
}

/** What the wizard tells the caller when the change is written and the operator leaves. */
export interface MachineChangeResult {
  profileId: string;
  profileName: string;
  from: MachineMountKind;
  to: MachineMountKind;
  /** True when a frozen job's mount is no longer on the machine — generate it again. */
  refreeze: boolean;
  jobName: string | null;
}

export interface MachineChangeRequest {
  /** The mount the caller needs; omitted when the wizard should offer the house's mounts (Manage). */
  target?: MachineMountKind;
  /** The job that asked, or null for a change made from Manage. */
  forJob?: MachineChangeJob | null;
  /** Called once, on the operator's final press, with what changed. */
  onDone?: (result: MachineChangeResult) => void;
}

export interface MachineChangeState {
  open: boolean;
  request: MachineChangeRequest;
  /** Bumped on every open so a new request remounts the wizard's own state. */
  session: number;
  close: () => void;
}

export const useMachineChangeStore = create<MachineChangeState>()((set) => ({
  open: false,
  request: {},
  session: 0,
  close: () => set({ open: false }),
}));

/**
 * Open the wizard. This is the entry every caller uses — the Holding step's `Change the machine…`
 * (a target and a job), Manage's bed block (no target), and Cut's re-freeze path (the frozen job's
 * mount). Calling it while the wizard is already open starts the new request from step 1.
 */
export function openMachineChange(request: MachineChangeRequest = {}): void {
  useMachineChangeStore.setState((s) => ({ open: true, request, session: s.session + 1 }));
}

/** Test seam: closed, with no request left behind. */
export function resetMachineChange(): void {
  useMachineChangeStore.setState({ open: false, request: {}, session: 0 });
}
