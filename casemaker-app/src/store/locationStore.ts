/**
 * The location as this window holds it (#412), and the "my machine" half of its migration.
 *
 * WHAT THE SERVICE CAN DO AND WHAT ONLY THIS SIDE CAN. The service moves `house.json`'s tools into
 * `location.json` on its own (`location.rs`). The other half — the saved vise and sacrificial setup,
 * the depth margins and the calibration a check read back (#247, #279, #345) — lives in THIS
 * browser's `localStorage` (`settingsStore`), where the service cannot reach it. So the client does
 * it: on the first connect to a location with no machine record, it SEEDS one from those settings
 * and from `machineStore`'s last check (address, broadcast name, profile).
 *
 * DUAL HOME, ON PURPOSE, FOR PHASE 1. Every job still reads `settingsStore` — its consumers are the
 * engrave panel, its job store and the sim workers, and moving those reads belongs with a job
 * binding to a location (§3.4). So the location's machine record is the DURABLE, EXPORTED copy, and
 * the two are kept in step here:
 *   - on connect, a location that already has a machine record WINS: its sections are applied to
 *     the settings (a second browser on the LAN, or this one after an import, takes the location's
 *     numbers, not whatever its own storage last held);
 *   - after that, an edit to those settings, or a new machine check, is WRITTEN THROUGH to the record
 *     — section by section, merged three ways against the record this window last agreed with, so a
 *     section another window changed meanwhile is taken INTO these settings rather than overwritten
 *     (`mergeMachine`), and a check moves the address only when it is newer than the record and of
 *     the same machine (`observationApplies`).
 * A section the record does not carry (`null`) leaves the local one alone — the "no opinion" rule
 * the "my machine" import already follows — and the next write-through fills it in.
 *
 * NO LOCATION, NO CHANGE. A build with no house service (the hosted web build) never reaches
 * `present`, so nothing here runs and the settings behave exactly as before.
 */

import { create } from 'zustand';
import { newId } from '@/utils/id';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import type { MarginSettings } from '@/engine/cnc/engrave/depthBounds';
import type { MachineObservation } from '@/platform/machineProbe';
import {
  houseLocation,
  housePutMachine,
  type LocationView,
  type MachineRecord,
} from '@/platform/locationClient';
import { useSettingsStore, type FixturesSettings } from './settingsStore';
import { useMachineStore } from './machineStore';
import { useToolRegistryStore } from './toolRegistryStore';

export type LocationStatus = 'unknown' | 'present' | 'absent' | 'error';

export interface LocationState {
  status: LocationStatus;
  location: LocationView | null;
  /** The validator a machine write sends as `If-Match`. */
  etag: string | null;
  /** Why there is no location, when there is none — or the service's sentence for a broken file. */
  reason: string | null;
  /** What the last machine write said when it did not work — shown on the Machines card. */
  writeNote: string | null;
  refresh: () => Promise<void>;
  /** `stale` is a 412/428: the location was re-read, and the caller should merge and retry. */
  saveMachine: (record: MachineRecord) => Promise<'ok' | 'stale' | 'failed'>;
}

export const useLocationStore = create<LocationState>((set, get) => ({
  status: 'unknown',
  location: null,
  etag: null,
  reason: null,
  writeNote: null,

  refresh: async () => {
    const res = await houseLocation();
    if (res.kind === 'ok') {
      set({ status: 'present', location: res.location, etag: res.etag, reason: null });
    } else {
      set({
        status: res.kind === 'absent' ? 'absent' : 'error',
        location: null,
        etag: null,
        reason: res.kind === 'absent' ? res.reason : res.detail,
      });
    }
  },

  saveMachine: async (record) => {
    const res = await housePutMachine(record, get().etag);
    if (res.kind === 'ok') {
      set({ writeNote: null });
      await get().refresh();
      return 'ok';
    }
    const text = res.kind === 'absent' ? res.reason : res.kind === 'refused' ? res.message : res.detail;
    set({ writeNote: text });
    // A stale guard (#321) means this window's copy is not the one served: re-read, so the caller
    // can merge what changed elsewhere and retry with the current validator.
    if (res.kind === 'refused' && (res.status === 412 || res.status === 428)) {
      await get().refresh();
      return 'stale';
    }
    return 'failed';
  },
}));

/** What this window holds that belongs in the machine record. */
export interface LocalMachine {
  fixtures: FixturesSettings;
  margins: MarginSettings;
  calibration: MachineCalibration | undefined;
  observation: MachineObservation | null;
}

export function localMachine(): LocalMachine {
  const s = useSettingsStore.getState();
  return {
    fixtures: s.fixtures,
    margins: s.margins,
    calibration: s.machineCalibration,
    observation: useMachineStore.getState().machine,
  };
}

/** JSON with sorted keys, so two records compare by content and not by key order (`serde_json`
 * sorts an object's keys; the client's parsers do not). */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * Whether this window has anything worth a machine record. A fresh install with no machine ever
 * checked, nothing saved and the shipped margins has nothing to migrate — and the app is a case
 * designer first, so a user with no CNC is not given a machine they do not have.
 */
export function hasAnythingToSeed(local: LocalMachine): boolean {
  return (
    local.observation !== null ||
    local.calibration !== undefined ||
    Object.keys(local.fixtures).length > 0 ||
    local.margins.source !== 'default'
  );
}

/**
 * Whether a machine check may write the record's address, name and profile (#412 review).
 *
 *   - Not when it is OLDER than the record: a second computer holding a check from last week must
 *     not put last week's address back over the one written since.
 *   - Not when it is a DIFFERENT machine: the broadcast names must agree when both have one; with no
 *     name to compare (a typed address), the profiles must agree.
 * A record that names no machine yet (no name, no profile) takes any current check.
 */
export function observationApplies(obs: MachineObservation | null, existing: MachineRecord | null): boolean {
  if (obs === null) return false;
  if (existing === null) return true;
  const seen = Date.parse(obs.observedAt);
  const recorded = Date.parse(existing.updatedAt);
  if (!Number.isFinite(seen) || (Number.isFinite(recorded) && seen <= recorded)) return false;
  if (obs.name !== null && existing.name !== null) return obs.name === existing.name;
  if (existing.profileId === null && existing.name === null) return true;
  return obs.profileId !== null && obs.profileId === existing.profileId;
}

/** The three sections a window holds, by their record key. */
const SECTIONS = ['fixtures', 'margins', 'calibration'] as const;
type Section = (typeof SECTIONS)[number];

function localSection(local: LocalMachine, k: Section): unknown {
  return k === 'calibration' ? (local.calibration ?? null) : local[k];
}

/**
 * The record this window would write, and what it should take FROM the location (#412 review).
 *
 * A THREE-WAY MERGE, PER SECTION, against `base` — the record this window's settings last agreed
 * with. A section this window changed since `base` is written; a section only the LOCATION changed
 * (another window, the LAN browser) is kept, and handed back in `fromLocation` so the caller puts it
 * into this window's settings. Writing the whole record from local settings instead is how a stale
 * window put back margins somebody else had just saved. With no `base` (the first write, a seed)
 * every section is this window's.
 *
 * Identity (address, name, profile) moves only on a check {@link observationApplies} accepts.
 * `serial` and `firmware` are never set here; only a read of the machine may set them.
 */
export function mergeMachine(
  local: LocalMachine,
  server: MachineRecord | null,
  base: MachineRecord | null,
  now: string,
): { record: MachineRecord; fromLocation: Partial<Pick<MachineRecord, Section>> } {
  const fromLocation: Partial<Pick<MachineRecord, Section>> = {};
  const sections = {} as Pick<MachineRecord, Section>;
  for (const k of SECTIONS) {
    const mine = localSection(local, k);
    const localChanged = base === null || server === null || stableJson(mine) !== stableJson(base[k]);
    if (localChanged) {
      (sections as Record<Section, unknown>)[k] = mine;
    } else {
      (sections as Record<Section, unknown>)[k] = server[k];
      if (server[k] !== null && stableJson(server[k]) !== stableJson(mine)) {
        (fromLocation as Record<Section, unknown>)[k] = server[k];
      }
    }
  }
  const obs = observationApplies(local.observation, server) ? local.observation : null;
  const sameHost = obs !== null && server?.address?.host === obs.host;
  return {
    record: {
      id: server?.id ?? newId('machine'),
      profileId: obs?.profileId ?? server?.profileId ?? local.calibration?.machineId ?? null,
      // A typed address announces no name: the old one is kept only for the same host.
      name: obs ? (obs.name ?? (sameHost ? (server?.name ?? null) : null)) : (server?.name ?? null),
      serial: server?.serial ?? null,
      firmware: server?.firmware ?? null,
      address: obs ? { host: obs.host, port: obs.port } : (server?.address ?? null),
      ...sections,
      updatedAt: now,
    },
    fromLocation,
  };
}

/** Two records with the same content, `updatedAt` aside. */
export function sameRecord(a: MachineRecord, b: MachineRecord): boolean {
  return stableJson({ ...a, updatedAt: '' }) === stableJson({ ...b, updatedAt: '' });
}

/**
 * Applying the location's numbers to the settings must not echo back as a write-through: each setter
 * fires the subscription while the others have not landed yet, and a write in that gap would push a
 * half-applied record.
 */
let applying = false;
/** The record this window's settings last agreed with — the merge's base. */
let baseline: MachineRecord | null = null;
/** Set when an import put a location with NO machine in place: not re-seeded from this window. */
let seedSuppressed = false;

function applySections(sections: Partial<Pick<MachineRecord, Section>>): void {
  const s = useSettingsStore.getState();
  applying = true;
  try {
    if (sections.fixtures != null) s.replaceFixtures(sections.fixtures);
    if (sections.margins != null) s.setMargins(sections.margins);
    if (sections.calibration != null) s.setMachineCalibration(sections.calibration);
  } finally {
    applying = false;
  }
}

/**
 * Put a machine record's sections into this window's settings, and take it as the merge's base. A
 * `null` section is no opinion: the local one stays, and the next write-through fills it in.
 */
export function applyMachineToSettings(record: MachineRecord): void {
  applySections(record);
  baseline = record;
}

/** An import put a location with no machine in place: do not re-seed it from this window (#412 review). */
export function suppressSeeding(): void {
  seedSuppressed = true;
}

/** One write-through at a time; a change that lands mid-write is picked up by the re-check after. */
let pushing: Promise<void> | null = null;
let again = false;

/**
 * Write this window's changed machine sections to the location — or seed the record, if the
 * location has none and there is something to seed. Safe to call on every change.
 */
export async function pushMachine(now: () => string = () => new Date().toISOString()): Promise<void> {
  if (pushing) {
    again = true;
    return pushing;
  }
  pushing = (async () => {
    let staleRetries = 1;
    do {
      again = false;
      const { status, location } = useLocationStore.getState();
      if (status !== 'present' || location === null) return;
      const server = location.machines[0] ?? null;
      if (server === null) {
        // A machine this build could not read is not replaced by a seed: that would overwrite it.
        if (location.unreadableMachines.length > 0 || seedSuppressed) return;
        if (!hasAnythingToSeed(localMachine())) return;
      }
      const { record, fromLocation } = mergeMachine(localMachine(), server, baseline, now());
      applySections(fromLocation);
      if (server !== null && sameRecord(record, server)) {
        baseline = server;
        continue;
      }
      const outcome = await useLocationStore.getState().saveMachine(record);
      if (outcome === 'ok') {
        // The merge's base is the record THIS window wrote (re-review), not the re-read: a re-read
        // that already carries another window's next change would otherwise become the base, and
        // that change would read as "unchanged here" and never reach these settings.
        baseline = record;
      } else if (outcome === 'stale' && staleRetries-- > 0) {
        // Re-read already happened: merge against what the other window wrote, and try once more.
        again = true;
      } else {
        // A refused write is not retried in a loop: the note on the card says why.
        return;
      }
    } while (again);
  })().finally(() => {
    pushing = null;
  });
  return pushing;
}

/**
 * Connect: read the location, then reconcile (see the module doc) — the location's record wins
 * where it has one, and this window seeds it where it does not.
 */
export async function reconcileLocation(): Promise<void> {
  await useLocationStore.getState().refresh();
  const { status, location } = useLocationStore.getState();
  if (status !== 'present' || location === null) return;
  const existing = location.machines[0];
  if (existing !== undefined) applyMachineToSettings(existing);
  await pushMachine();
}

/**
 * Start keeping the location in step with this window: reconcile when the house service answers,
 * then write settings and machine-check changes through. Returns the unsubscribe.
 */
export function startLocationSync(): () => void {
  let started = false;
  const begin = () => {
    if (started || useToolRegistryStore.getState().status !== 'present') return;
    started = true;
    void reconcileLocation();
  };
  begin();
  const offRegistry = useToolRegistryStore.subscribe(begin);
  const onChange = () => {
    if (applying || useLocationStore.getState().status !== 'present') return;
    void pushMachine();
  };
  const offSettings = useSettingsStore.subscribe((s, prev) => {
    if (s.fixtures !== prev.fixtures || s.margins !== prev.margins || s.machineCalibration !== prev.machineCalibration) {
      onChange();
    }
  });
  const offMachine = useMachineStore.subscribe((s, prev) => {
    if (s.machine !== prev.machine) onChange();
  });
  return () => {
    offRegistry();
    offSettings();
    offMachine();
  };
}

/** Test seam. */
export function resetLocationStore(): void {
  useLocationStore.setState({ status: 'unknown', location: null, etag: null, reason: null, writeNote: null });
  pushing = null;
  again = false;
  applying = false;
  baseline = null;
  seedSuppressed = false;
}
