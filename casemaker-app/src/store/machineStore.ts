/**
 * The connected machine (issue #280) — the connection INSTANCE, not the machine's numbers.
 *
 * R1's one durable refusal is that no flow owns machine facts: a flow reads and writes the stores,
 * it does not become a third home for a measurement. So the split is:
 *
 *   - `engine/cnc/machine.ts` owns the PROFILE — every machine-dependent number, in code, with its
 *     provenance (`Z1`). Nothing here duplicates a single one of them.
 *   - this store owns the INSTANCE we reached — what it called itself, where it is, what it
 *     answered, and which profile id that identity resolves to (`profileId | null`).
 *
 * `profileId: null` is the load-bearing case. Our own machine resolves to `'Z1'`; a machine we do
 * not know resolves to nothing, and every consumer that read the profile through this store then
 * has to say "unknown" instead of borrowing another machine's envelope. That is #280's rule, and
 * it is why this store holds an ID rather than a `MillProfile`.
 *
 * Persisted by hand into localStorage, exactly as `settingsStore` does, and for the same reason:
 * this is data the user configured, not a slice of a document. `observedAt` is what keeps the
 * record honest — it is a note of when we last looked, not a standing claim that the machine is
 * there now. The wizard re-runs the check on every open; it does not trust this.
 */

import { create } from 'zustand';
import type { MachineObservation, MachineProbeResult } from '@/platform/machineProbe';
import { readStatusLine } from '@/platform/desktop/protocol';

const MACHINE_KEY = 'casemaker.machine.v1';

/** What the last check concluded. `found` is the only one that leaves a machine behind. */
export type MachineCheckOutcome = MachineProbeResult['kind'];

/**
 * What the live heartbeat (#555) last concluded about the remembered machine.
 *
 * Reachability is a live claim, never a record: it is re-established by the heartbeat on every
 * open, and `null` until the first heartbeat answers. `lastSeenAt` is the heartbeat's own moment,
 * kept apart from the check's `observedAt` so a 2 s poll never moves the record the Manage card
 * keys its vacuum switch on.
 */
export interface MachineHeartbeat {
  /** Whether the last heartbeat reached the machine, or null before the first one has answered. */
  reachable: boolean | null;
  /** ISO timestamp of the last successful heartbeat, or null when none has answered. */
  lastSeenAt: string | null;
}

export interface MachineState {
  /** The machine we last reached, or null when the last check did not find one. */
  machine: MachineObservation | null;
  /** What the last check concluded, so a re-opened wizard can say what happened. */
  outcome: MachineCheckOutcome | null;
  /**
   * Why there is no machine, when the outcome was `unavailable` or `error` — the browser's refusal
   * or the socket's fault, verbatim. Never a substitute for a machine.
   */
  reason: string | null;
  /** When the check ran. Null means no check has run in this profile. */
  checkedAt: string | null;
  /** The live heartbeat's conclusion (#555) — reachable / unreachable / last-seen. */
  heartbeat: MachineHeartbeat;
  /**
   * #527 — a registration run owns the machine right now, so the viewport draws the wired probe
   * in place of the cutter. SESSION state, never persisted: it describes a run in progress, and a
   * reload has no run.
   */
  registrationActive: boolean;
  /** Record one probe result. The single write path: the probe produces, the store keeps. */
  setProbeResult: (result: MachineProbeResult) => void;
  /**
   * Fold in what the machine said when it was asked LIVE (#296) — the upload's idle check. Only
   * `busy`, `status` and `observedAt` change: the identity and the coordinate frame are still the
   * wizard's record. A no-op when no machine is remembered, because there is nothing to refresh.
   */
  noteLiveStatus: (live: { busy: boolean; status: string }) => void;
  /** Forget the machine entirely — a new check, or the user saying "not this one". */
  forget: () => void;
  /**
   * Record one heartbeat result (#555): whether the machine answered, and when it was last seen.
   * Only the heartbeat fields move — the machine's identity, status and `observedAt` are the
   * check's record, not the heartbeat's, so a 2 s poll never rewrites the record the Manage card
   * keys its vacuum switch on.
   */
  noteHeartbeat: (reachable: boolean) => void;
  /**
   * #527 — fold one live `?` answer into the record WITHOUT persisting it. The heartbeat runs every
   * 2 s and its answer is also the viewport's live position; writing localStorage on every poll
   * would churn the stored record for nothing (the same reason {@link MachineHeartbeat} is not
   * written). Identity and `observedAt` stay the check's; only what the machine just said moves.
   */
  noteLiveStatusLine: (status: string) => void;
  /** #527 — the viewport draws the probe, not the cutter, while {@link registrationActive}. */
  setRegistrationActive: (active: boolean) => void;
}

interface MachineSlice {
  machine: MachineObservation | null;
  outcome: MachineCheckOutcome | null;
  reason: string | null;
  checkedAt: string | null;
  heartbeat: MachineHeartbeat;
  /** #527 — see {@link MachineState.registrationActive}. Never persisted. */
  registrationActive: boolean;
}

const EMPTY: MachineSlice = {
  machine: null,
  outcome: null,
  reason: null,
  checkedAt: null,
  heartbeat: { reachable: null, lastSeenAt: null },
  registrationActive: false,
};

/** The four outcomes, stated once so a corrupted or older payload cannot invent a fifth. */
const OUTCOMES: ReadonlySet<MachineCheckOutcome> = new Set(['found', 'not-found', 'unavailable', 'error']);

/**
 * Read one persisted machine record, or drop it.
 *
 * Whole-or-nothing, like `parseFixtures`: a half-read observation would let the wizard print an
 * envelope next to a machine whose identity it did not actually establish. Anything missing or of
 * the wrong type means this profile has no remembered machine, which is a state the wizard already
 * handles — it is what a first run looks like.
 */
function parseMachine(raw: unknown): MachineObservation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const host = str(o.host);
  const observedAt = str(o.observedAt);
  if (host === null || observedAt === null) return null;
  if (typeof o.port !== 'number' || !Number.isInteger(o.port)) return null;
  if (typeof o.busy !== 'boolean' && o.busy !== null) return null;
  return {
    name: str(o.name),
    host,
    port: o.port,
    busy: o.busy as boolean | null,
    ip: str(o.ip),
    mac: str(o.mac),
    status: str(o.status),
    // #526 — the parsed status line is derived, never persisted: re-derived from the raw line on load.
    statusLine: str(o.status) === null ? null : readStatusLine(str(o.status)!),
    profileId: str(o.profileId),
    observedAt,
    notes: Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === 'string') : [],
  };
}

function loadMachine(): MachineSlice {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return { ...EMPTY };
  try {
    const raw = localStorage.getItem(MACHINE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const outcome =
      typeof parsed.outcome === 'string' && OUTCOMES.has(parsed.outcome as MachineCheckOutcome)
        ? (parsed.outcome as MachineCheckOutcome)
        : null;
    return {
      machine: parseMachine(parsed.machine),
      outcome,
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
      checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : null,
      // Reachability is a live claim, never a record: the heartbeat re-establishes it on open.
      heartbeat: { reachable: null, lastSeenAt: null },
      registrationActive: false,
    };
  } catch {
    return { ...EMPTY };
  }
}

function persist(s: MachineSlice): void {
  if (typeof localStorage === 'undefined') return;
  try {
    // The heartbeat is deliberately NOT written: reachability and last-seen are re-established by
    // the heartbeat on every open, and storing a 2 s poll would churn the record for nothing.
    localStorage.setItem(
      MACHINE_KEY,
      JSON.stringify({ machine: s.machine, outcome: s.outcome, reason: s.reason, checkedAt: s.checkedAt }),
    );
  } catch {
    // ignore quota errors
  }
}

export const useMachineStore = create<MachineState>()((set, get) => ({
  ...loadMachine(),

  setProbeResult: (result) => {
    const slice: MachineSlice = {
      machine: result.kind === 'found' ? result.observation : null,
      outcome: result.kind,
      reason: result.kind === 'unavailable' ? result.reason : result.kind === 'error' ? result.detail : null,
      checkedAt: new Date().toISOString(),
      // A fresh check is a fresh record: reachability is re-established by the heartbeat, not kept.
      heartbeat: { reachable: null, lastSeenAt: null },
      // A check is not a registration run; a stale "registering" claim must not outlive one.
      registrationActive: false,
    };
    set(slice);
    persist(slice);
  },

  noteLiveStatus: ({ busy, status }) => {
    const current = get().machine;
    if (current === null) return;
    const slice: MachineSlice = {
      machine: { ...current, busy, status, statusLine: readStatusLine(status), observedAt: new Date().toISOString() },
      outcome: get().outcome,
      reason: get().reason,
      checkedAt: get().checkedAt,
      heartbeat: get().heartbeat,
      registrationActive: get().registrationActive,
    };
    set(slice);
    persist(slice);
  },

  forget: () => {
    const slice: MachineSlice = { ...EMPTY, checkedAt: get().checkedAt };
    set(slice);
    persist(slice);
  },

  noteHeartbeat: (reachable) => {
    const current = get().machine;
    if (current === null) return;
    const now = new Date().toISOString();
    set({
      heartbeat: { reachable, lastSeenAt: reachable ? now : get().heartbeat.lastSeenAt },
    });
  },

  noteLiveStatusLine: (status) => {
    // No machine, nothing to fold into — the heartbeat only runs for a remembered one anyway.
    const current = get().machine;
    if (current === null) return;
    // NOT persisted and `observedAt` untouched: the heartbeat runs every 2 s, and the record's
    // stamp is the CHECK's moment, not the poll's (see the interface notes).
    set({ machine: { ...current, status, statusLine: readStatusLine(status) } });
  },

  setRegistrationActive: (active) => set({ registrationActive: active }),
}));

export const MACHINE_STORAGE_KEY = MACHINE_KEY;

/** Test seam: clear the remembered machine without touching anything else. */
export function resetMachineStore(): void {
  useMachineStore.setState({ ...EMPTY });
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(MACHINE_KEY);
    } catch {
      // ignore
    }
  }
}
