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

const MACHINE_KEY = 'casemaker.machine.v1';

/** What the last check concluded. `found` is the only one that leaves a machine behind. */
export type MachineCheckOutcome = MachineProbeResult['kind'];

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
}

interface MachineSlice {
  machine: MachineObservation | null;
  outcome: MachineCheckOutcome | null;
  reason: string | null;
  checkedAt: string | null;
}

const EMPTY: MachineSlice = { machine: null, outcome: null, reason: null, checkedAt: null };

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
    };
  } catch {
    return { ...EMPTY };
  }
}

function persist(s: MachineSlice): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(MACHINE_KEY, JSON.stringify(s));
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
    };
    set(slice);
    persist(slice);
  },

  noteLiveStatus: ({ busy, status }) => {
    const current = get().machine;
    if (current === null) return;
    const slice: MachineSlice = {
      machine: { ...current, busy, status, observedAt: new Date().toISOString() },
      outcome: get().outcome,
      reason: get().reason,
      checkedAt: get().checkedAt,
    };
    set(slice);
    persist(slice);
  },

  forget: () => {
    const slice: MachineSlice = { ...EMPTY, checkedAt: get().checkedAt };
    set(slice);
    persist(slice);
  },
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
