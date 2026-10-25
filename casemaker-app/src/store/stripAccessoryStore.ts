/**
 * #648 — what the strip's accessory indicators know, per CONNECTION.
 *
 * The machine reports no accessory mode (the vacuum has no read-back; the antistatic and the work
 * light none either), so an indicator can only show what the app last SENT on the connection it
 * sent it on — the same honest claim the card switches keep (MachineVacuum's header). A press that
 * fails leaves `null` ("unknown"): a socket that failed mid-press may or may not have delivered the
 * code. Keyed by machine address, and a fresh observation clears it (`forget`).
 */

import { create } from 'zustand';

export type AccessoryKind = 'vacuum' | 'antistatic' | 'light';

/** `true` on, `false` off, `null` unknown (nothing sent, or the last press was unsure). */
export type AccessoryMode = boolean | null;

export interface StripAccessoryState {
  modes: Record<string, Partial<Record<AccessoryKind, AccessoryMode>>>;
  /** Record what a press concluded. `null` means "we no longer know". */
  note: (target: string, kind: AccessoryKind, mode: AccessoryMode) => void;
  /** Nothing is claimed for this target any more (a new observation/connection). */
  forget: (target: string) => void;
}

export const useStripAccessoryStore = create<StripAccessoryState>()((set) => ({
  modes: {},
  note: (target, kind, mode) =>
    set((s) => ({ modes: { ...s.modes, [target]: { ...(s.modes[target] ?? {}), [kind]: mode } } })),
  forget: (target) =>
    set((s) => {
      if (!(target in s.modes)) return s;
      const modes = { ...s.modes };
      delete modes[target];
      return { modes };
    }),
}));

/** Test seam: forget everything. */
export function resetStripAccessoryStore(): void {
  useStripAccessoryStore.setState({ modes: {} });
}
