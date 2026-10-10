/**
 * Whether the Manage surface (#311, tracking #212) is up, and what it is showing.
 *
 * A STORE RATHER THAN COMPONENT STATE, for the same structural reason the wizard has one: the mode
 * is entered from the toolbar, which is a sibling of the main area rather than a parent of it, and
 * it sits BESIDE `WelcomeOverlay` — the whole point is that it opens with no project. `AppShell`
 * branches on `open` here and mounts `ManageMode`.
 *
 * Session-scoped and deliberately NOT persisted, like the wizard and the registry: this is a place
 * the user went, not a mode the app restores on launch. A toolbar button that came back pressed
 * after a reload would be a state the user never set.
 *
 * The filter and the selection live here rather than inside the list because the rail's detail pane
 * and the list itself are two components: `selectedKey` is what they agree on.
 */

import { create } from 'zustand';

/** The two scopes the rail offers. `materials` is reserved in the rail and deliberately not one. */
export type ManageScope = 'tools' | 'machines';

/** The filter chips. `all` is the one that shows the list as the tier grouping draws it. */
export type TierFilter = 'all' | 'owned' | 'yours' | 'catalogue' | 'builtin';

/** The three ways into the register frame — the doors, whose panels are #309's. */
export type RegisterDoor = 'scan' | 'catalogue' | 'type';

export interface ManageModeState {
  open: boolean;
  scope: ManageScope;
  /** The row whose detail the rail shows, by registry key, or null. */
  selectedKey: string | null;
  /** What the search field holds. */
  search: string;
  tier: TierFilter;
  /** Whether the rail is showing the register frame instead of a row's detail. */
  registerOpen: boolean;
  door: RegisterDoor;

  /** Enter the mode, optionally straight into a scope. Always starts at the top of that scope. */
  openManage: (scope?: ManageScope) => void;
  closeManage: () => void;
  setScope: (scope: ManageScope) => void;
  select: (key: string | null) => void;
  setSearch: (search: string) => void;
  setTier: (tier: TierFilter) => void;
  /** Open the register frame in the rail. */
  openRegister: () => void;
  closeRegister: () => void;
  setDoor: (door: RegisterDoor) => void;
}

const CLOSED = {
  open: false,
  scope: 'tools' as ManageScope,
  selectedKey: null,
  search: '',
  tier: 'all' as TierFilter,
  registerOpen: false,
  door: 'scan' as RegisterDoor,
};

export const useManageModeStore = create<ManageModeState>()((set) => ({
  ...CLOSED,

  openManage: (scope) => set({ ...CLOSED, open: true, scope: scope ?? 'tools' }),
  // Closing keeps nothing: re-entering the mode is a fresh look at the house, not a resumed place.
  closeManage: () => set({ ...CLOSED }),
  setScope: (scope) =>
    // The selection belongs to the list it was made in, and the register frame to the Tools scope:
    // carrying either across a scope change would show a detail for something not on screen.
    set({ scope, selectedKey: null, registerOpen: false }),
  select: (selectedKey) => set({ selectedKey, registerOpen: false }),
  setSearch: (search) => set({ search }),
  setTier: (tier) => set({ tier }),
  openRegister: () => set({ registerOpen: true, selectedKey: null }),
  closeRegister: () => set({ registerOpen: false }),
  setDoor: (door) => set({ door }),
}));

/** Test seam: back to closed, with no other state to unwind. */
export function resetManageMode(): void {
  useManageModeStore.setState({ ...CLOSED });
}
