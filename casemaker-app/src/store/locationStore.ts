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
 * THE MERGE'S BASE IS PERSISTED (#439). It is kept beside the settings in `localStorage`, so an edit
 * whose write failed (a service error, a second 412) survives a restart: on the next connect a stored
 * base for the same machine is the merge's base, and the edit — changed since that base — is written
 * instead of being overwritten by the location's record. With no stored base (or one for another
 * machine) the location's record wins, as above.
 *
 * NO LOCATION, NO CHANGE. A build with no house service (the hosted web build) never reaches
 * `present`, so nothing here runs and the settings behave exactly as before.
 *
 * THE DEPTH MARGINS LEFT THE MACHINE RECORD (#447). They are shop defaults now — the `margins.*` keys
 * of the location's `defaults` section (`shopMargins.ts`) — and `settingsStore.margins` is a
 * projection of them. On connect, {@link settleMargins} moves the old copy in ONE WAY: the machine
 * record's `margins` (or, for a location with no machine yet, this browser's), written `chosen` with a
 * note; only once every write is in does the record's `margins` go to `null` and this browser get
 * its marker, so a failed move loses nothing and a later reset to the seed is never undone by an old
 * copy. Until then — and against a service that serves no defaults section — the margins keep #412's
 * record path (`marginsHome: 'record'`). The vise, the sacrificial setup and the calibration stay on
 * the machine record, where #412 put them.
 */

import { create } from 'zustand';
import { newId } from '@/utils/id';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import type { MarginSettings } from '@/engine/cnc/engrave/depthBounds';
import type { MachineObservation } from '@/platform/machineProbe';
import {
  MachineRecordSchema,
  houseDeleteAccessory,
  houseLocation,
  housePutAccessory,
  housePutMachine,
  type FixtureRecord,
  type LocationView,
  type MachineRecord,
} from '@/platform/locationClient';
import { houseAddFinishedProgram } from '@/platform/finishedProgramsClient';
import { bedFromLegacy, bedMigrationDue, ensureFirstRegistrationBed, firstRegistrationBed, newestViseRegistration, type LegacyViseRegistration } from '@/platform/bedProfiles';
import { parseMarginsStrict, useSettingsStore, type FixturesSettings } from './settingsStore';
import { useMachineStore } from './machineStore';
import { useToolRegistryStore } from './toolRegistryStore';
import type { InventoryItem } from '@/platform/houseClient';
import type { ToolCopy } from '@/engine/cnc/toolCondition';
import { useShopDefaultsStore } from './shopDefaultsStore';
import { useFeedTableStore } from './feedTableStore';
import { useEngraveRegistrationStore } from './engraveRegistrationStore';
import {
  legacyMargins,
  marginWrites,
  marginsFromDefaults,
  marginsMovedFor,
  markMarginsMoved,
  migrationNote,
  pendingMargins,
  setPendingMargins,
} from './shopMargins';

export type LocationStatus = 'unknown' | 'present' | 'absent' | 'error';

/**
 * Where the house depth margins live in this window (#447): `browser` with no location (the web
 * build: browser storage, labelled), `record` on the machine record (#412's path — a service with no
 * defaults section, or a move that has not gone in yet), `defaults` in the shop defaults.
 */
export type MarginsHome = 'browser' | 'record' | 'defaults';

export interface LocationState {
  status: LocationStatus;
  location: LocationView | null;
  /** The validator a machine write sends as `If-Match`. */
  etag: string | null;
  /** Why there is no location, when there is none — or the service's sentence for a broken file. */
  reason: string | null;
  /** What the last machine write said when it did not work — shown on the Machines card. */
  writeNote: string | null;
  /** What the last accessory write said when it did not work (#601) — shown on the Accessories scope. */
  accessoryNote: string | null;
  /** Where the depth margins live (#447). */
  marginsHome: MarginsHome;
  refresh: () => Promise<void>;
  /** `stale` is a 412/428: the location was re-read, and the caller should merge and retry. */
  saveMachine: (record: MachineRecord) => Promise<'ok' | 'stale' | 'failed'>;
  /** #601 — create or replace one accessory record. `stale` is a 412/428, as `saveMachine`'s is. */
  saveAccessory: (record: FixtureRecord) => Promise<'ok' | 'stale' | 'failed'>;
  /** #601 — retire one accessory record. `stale` is a 412/428, as `saveMachine`'s is. */
  removeAccessory: (id: string) => Promise<'ok' | 'stale' | 'failed'>;
  /** Dismiss the accessory write's refusal sentence. */
  clearAccessoryNote: () => void;
  /**
   * Append a finished program's FNV hash to a machine's persisted list (#419 §4.5). `added: false`
   * with `ok: true` means the machine already had it — a repeated finish, with no request sent.
   */
  recordFinishedProgram: (machineId: string, hash: string) => Promise<{ ok: boolean; added: boolean; text: string }>;
}

export const useLocationStore = create<LocationState>((set, get) => ({
  status: 'unknown',
  location: null,
  etag: null,
  reason: null,
  writeNote: null,
  accessoryNote: null,
  marginsHome: 'browser',

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

  saveAccessory: async (record) => {
    const res = await housePutAccessory(record, get().etag);
    if (res.kind === 'ok') {
      set({ accessoryNote: null });
      await get().refresh();
      return 'ok';
    }
    const text = res.kind === 'absent' ? res.reason : res.kind === 'refused' ? res.message : res.detail;
    set({ accessoryNote: text });
    if (res.kind === 'refused' && (res.status === 412 || res.status === 428)) {
      await get().refresh();
      return 'stale';
    }
    return 'failed';
  },

  removeAccessory: async (id) => {
    const res = await houseDeleteAccessory(id, get().etag);
    if (res.kind === 'ok') {
      set({ accessoryNote: null });
      await get().refresh();
      return 'ok';
    }
    const text = res.kind === 'absent' ? res.reason : res.kind === 'refused' ? res.message : res.detail;
    set({ accessoryNote: text });
    if (res.kind === 'refused' && (res.status === 412 || res.status === 428)) {
      await get().refresh();
      return 'stale';
    }
    return 'failed';
  },

  clearAccessoryNote: () => set({ accessoryNote: null }),

  recordFinishedProgram: async (machineId, hash) => {
    const machine = get().location?.machines.find((m) => m.id === machineId) ?? null;
    if (machine === null) {
      return { ok: false, added: false, text: `machine ${machineId} is not in the location` };
    }
    // Already on the list this window has read: nothing to send. The service dedupes as well, so a
    // second window racing this one cannot duplicate it.
    if (machine.finishedPrograms.includes(hash)) return { ok: true, added: false, text: '' };
    const res = await houseAddFinishedProgram(machineId, hash);
    if (res.kind !== 'ok') {
      const text = res.kind === 'absent' ? res.reason : res.kind === 'refused' ? res.message : res.detail;
      set({ writeNote: text });
      return { ok: false, added: false, text };
    }
    // Re-read so this window's copy is the list the service now holds, and the next finish's dedupe
    // check is against it. A failed re-read leaves the append recorded but this copy stale; the
    // service's own dedupe still keeps the next append honest.
    await get().refresh();
    return { ok: true, added: true, text: '' };
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
export function hasAnythingToSeed(local: LocalMachine, marginsInRecord = true): boolean {
  return (
    local.observation !== null ||
    local.calibration !== undefined ||
    Object.keys(local.fixtures).length > 0 ||
    // #447: margins kept in the shop defaults are no reason to record a machine.
    (marginsInRecord && local.margins.source !== 'default')
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
/** #447: the sections once the margins live in the shop defaults. */
const SECTIONS_WITHOUT_MARGINS: readonly Section[] = ['fixtures', 'calibration'];

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
  // #447: false once the margins live in the shop defaults — the record's `margins` is then written
  // `null` (the move is done) and never merged or taken into the settings.
  marginsInRecord = true,
): { record: MachineRecord; fromLocation: Partial<Pick<MachineRecord, Section>> } {
  const fromLocation: Partial<Pick<MachineRecord, Section>> = {};
  const sections = { margins: null } as Pick<MachineRecord, Section>;
  for (const k of marginsInRecord ? SECTIONS : SECTIONS_WITHOUT_MARGINS) {
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
      // #596 — the nickname is the person's, set on the machine card (#602), never by a check or a
      // settings edit: the write-through carries the served one unchanged, like power and the bed.
      nickname: server?.nickname ?? null,
      serial: server?.serial ?? null,
      firmware: server?.firmware ?? null,
      address: obs ? { host: obs.host, port: obs.port } : (server?.address ?? null),
      ...sections,
      // LOCATION-ONLY fields (#416, #417, #419 §4.5): written through their own endpoints, never by
      // this write-through — copied from the served record so a settings write cannot wipe them (the
      // service keeps them on a machine PUT anyway) and `sameRecord` does not flap on them.
      power: server?.power ?? null,
      wasteboard: server?.wasteboard ?? null,
      finishedPrograms: server?.finishedPrograms ?? [],
      // The bed (#510) is written by the one-time migration and, later, by the profile UI. Until
      // then this write-through carries the served keys unchanged — `undefined` when the machine
      // has never been migrated, so a settings save does not add empty keys or reset the marker.
      bedProfiles: server?.bedProfiles,
      activeBedProfileId: server?.activeBedProfileId,
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
 * The machine whose last-known address is this run target, or null. The address match is how a run
 * (`host:port`, as the console reaches it) is tied to the location's durable record.
 */
export function machineAt(target: { host: string; port: number }): MachineRecord | null {
  return (
    useLocationStore.getState().location?.machines.find(
      (m) => m.address?.host === target.host && m.address.port === target.port,
    ) ?? null
  );
}

/**
 * #596 — the location's machine record whose `profileId` is `profileId`, or null. A job names its
 * machine by profile id, so the run sheet and the cut header resolve the nickname this way — the
 * rename never touches the job.
 */
export function machineRecordByProfile(profileId: string | null): MachineRecord | null {
  if (profileId === null) return null;
  return useLocationStore.getState().location?.machines.find((m) => m.profileId === profileId) ?? null;
}

/**
 * #596 — the location's machine record for a live check, reactively: the record at the address the
 * check reached. Null with no location, or for an address no machine matches (a check not yet
 * written through). The hook form, for components that draw the machine's name.
 */
export function useMachineRecord(target: { host: string; port: number } | null): MachineRecord | null {
  const machines = useLocationStore((s) => (s.status === 'present' ? s.location?.machines : undefined));
  if (target === null || machines === undefined) return null;
  return machines.find((m) => m.address?.host === target.host && m.address.port === target.port) ?? null;
}

/**
 * #597 — the accessories checked out to a machine: the house's `accessories[]`, filtered by the
 * `whereabouts` each record carries. This is the per-machine view that used to be `machine.bedFixtures`.
 */
export function accessoriesFor(machine: MachineRecord): FixtureRecord[] {
  const accessories = useLocationStore.getState().location?.accessories ?? [];
  return accessories.filter((a) => a.whereabouts.kind === 'machine' && a.whereabouts.machineId === machine.id);
}

/** #602 — a cutter copy, addressed by the item that owns it and its index within `copies`. */
export interface HeldCopy {
  item: InventoryItem;
  index: number;
  copy: ToolCopy;
}

/**
 * #602 — the cutter copies held by one machine: the inventory's `copies[]`, filtered by the
 * `whereabouts` each copy carries. The spindle's cutters, the way {@link accessoriesFor} is the
 * bed's mounts. The `index` is the copy's identity within its item, so a return or check-out
 * rewrites exactly that copy.
 */
export function copiesHeldBy(items: readonly InventoryItem[], machineId: string): HeldCopy[] {
  const out: HeldCopy[] = [];
  for (const item of items) {
    item.copies.forEach((copy, index) => {
      if (copy.whereabouts.kind === 'machine' && copy.whereabouts.machineId === machineId) {
        out.push({ item, index, copy });
      }
    });
  }
  return out;
}

/** #602 — the cutter copies still in their box: the `copies[]` whose `whereabouts` is `box`. */
export function copiesInBox(items: readonly InventoryItem[]): HeldCopy[] {
  const out: HeldCopy[] = [];
  for (const item of items) {
    item.copies.forEach((copy, index) => {
      if (copy.whereabouts.kind === 'box') out.push({ item, index, copy });
    });
  }
  return out;
}

/** #602 — a copy's whereabouts moved to its box (no case: the machine's copy carried none). */
export function copyInBox(copy: ToolCopy): ToolCopy {
  return { ...copy, whereabouts: { kind: 'box', case: null } };
}

/** #602 — a copy's whereabouts moved to a machine. */
export function copyAtMachine(copy: ToolCopy, machineId: string): ToolCopy {
  return { ...copy, whereabouts: { kind: 'machine', machineId } };
}

/**
 * The FNV hashes the machine at `target` has finished cleanly — exactly `RunPlanInput.finishedHashes`
 * (#419 §4.5, Q14), so the plan stops treating an already-cut program as new. Empty with no location,
 * or for an address no machine matches.
 */
export function finishedProgramsFor(target: { host: string; port: number }): readonly string[] {
  return machineAt(target)?.finishedPrograms ?? [];
}

/**
 * #650 — a machine write as a RECIPE, not a finished record: the update is applied to the record
 * the service holds, and re-applied to the re-read record after a stale guard. `withViseJawTopDatum`
 * and `withVisePlacementFrame` are already shaped for this — they take a machine and answer one.
 */
export type MachineUpdate = (current: MachineRecord) => MachineRecord;

/** The machine the location now describes, by id — the record a stale retry applies its update to. */
function machineById(id: string): MachineRecord | null {
  return useLocationStore.getState().location?.machines.find((m) => m.id === id) ?? null;
}

/**
 * #636 — a machine write with the one retry a stale guard earns: `saveMachine` re-reads the location
 * on a 412/428 (another window or a CLI wrote it), so the write is retried ONCE against what is
 * served now. Every datum/frame write goes through this, and every caller must READ the answer:
 * 'stale' twice and 'failed' are not "recorded".
 *
 * #650 — THE RETRY RE-APPLIES THE UPDATE. Re-sending the record built from the pre-read snapshot
 * would overwrite the other writer's change (a CLI's datum, a second window's accessory edit) with
 * this window's stale copy, while both sides were told ok — the If-Match guard defeated by its own
 * retry. `update` runs against the refreshed record instead; only the change this caller makes is
 * re-applied, so everything else the service holds survives.
 */
export async function saveMachineWithRetry(machine: MachineRecord, update: MachineUpdate): Promise<'ok' | 'stale' | 'failed'> {
  const first = await useLocationStore.getState().saveMachine(update(machine));
  if (first !== 'stale') return first;
  const fresh = machineById(machine.id);
  if (fresh === null) {
    // The other writer removed the machine: there is no record to apply the update to, and
    // re-creating it from a stale copy would resurrect what they deleted.
    useLocationStore.setState({ writeNote: 'the machine is no longer in the location' });
    return 'failed';
  }
  return useLocationStore.getState().saveMachine(update(fresh));
}

/**
 * #613 — the first registration on a machine with no bed profile creates the bed: the vise accessory
 * is written to the house's `accessories[]` (skipped when it already exists, so the action is
 * idempotent), and the machine is returned with the new profile + active id folded in, ready for the
 * caller's `saveMachine` with the frame/datum. Returns the machine unchanged when the bed is already
 * described. The accessory write retries once on a stale guard; a refused write does not block the
 * registration.
 */
export async function createFirstBed(
  machine: MachineRecord,
  registration: LegacyViseRegistration | null,
  now: string,
): Promise<MachineUpdate> {
  const migrated = firstRegistrationBed(machine, registration, now);
  // #650 — the bed is folded onto whatever record the SAVE is applied to, not onto this snapshot:
  // `saveMachineWithRetry` re-applies the update to the re-read record when another window wrote
  // first, so their change to a datum or a placement survives this first bed's creation.
  const bed: MachineUpdate = (current) => ensureFirstRegistrationBed(current, registration, now);
  if (migrated === null) return (current) => current;
  const store = useLocationStore.getState();
  const acc = migrated.accessories[0]!;
  const exists = store.location?.accessories?.some((a) => a.id === acc.id) ?? false;
  if (!exists) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ok = await store.saveAccessory(acc);
      if (ok === 'ok') break;
      // A refused accessory write must not block the registration — and without the accessory a
      // newly created bed would reference a fixture the location does not hold, so it does not
      // happen either (the same answer this had before the update shape).
      if (ok !== 'stale') return (current) => current;
      // stale: `saveAccessory` already re-read the location; retry once with the fresh ETag.
    }
  }
  return bed;
}

/**
 * Applying the location's numbers to the settings must not echo back as a write-through: each setter
 * fires the subscription while the others have not landed yet, and a write in that gap would push a
 * half-applied record.
 */
let applying = false;
/** The record this window's settings last agreed with — the merge's base. Persisted (#439): see {@link setBaseline}. */
let baseline: MachineRecord | null = null;

/** Where the base is kept beside the settings, so a failed write is merged — not overwritten — on the next start. */
export const BASELINE_KEY = 'casemaker.location.baseline.v1';

/** Set the merge's base, in memory and in this browser's storage. */
function setBaseline(record: MachineRecord): void {
  baseline = record;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(BASELINE_KEY, JSON.stringify(record));
  } catch {
    // Storage full or blocked: the base lives in memory only, as before #439.
  }
}

/** The stored base, when there is one this build can read. */
export function storedBaseline(): MachineRecord | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(BASELINE_KEY);
    if (raw === null) return null;
    const parsed = MachineRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
/** Set when an import put a location with NO machine in place: not re-seeded from this window. */
let seedSuppressed = false;

function applySections(sections: Partial<Pick<MachineRecord, Section>>): void {
  const s = useSettingsStore.getState();
  applying = true;
  try {
    if (sections.fixtures != null) s.replaceFixtures(sections.fixtures);
    // #447: margins in the shop defaults are projected from there, never from a record's old copy.
    if (sections.margins != null && marginsInRecord()) s.setMargins(sections.margins);
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
  setBaseline(record);
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
      const withMargins = marginsInRecord();
      if (server === null) {
        // A machine this build could not read is not replaced by a seed: that would overwrite it.
        if (location.unreadableMachines.length > 0 || seedSuppressed) return;
        if (!hasAnythingToSeed(localMachine(), withMargins)) return;
      }
      const { record, fromLocation } = mergeMachine(localMachine(), server, baseline, now(), withMargins);
      applySections(fromLocation);
      if (server !== null && sameRecord(record, server)) {
        setBaseline(server);
        continue;
      }
      const outcome = await useLocationStore.getState().saveMachine(record);
      if (outcome === 'ok') {
        // The merge's base is the record THIS window wrote (re-review), not the re-read: a re-read
        // that already carries another window's next change would otherwise become the base, and
        // that change would read as "unchanged here" and never reach these settings.
        setBaseline(record);
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
 * #510 — run the bed migration ONCE per machine, in place. The pure mapping is
 * `platform/bedProfiles.ts`; this is the wiring that supplies its two client-only inputs (the
 * parsed legacy `fixtures` section and this window's registration outcomes) and writes the result
 * through the normal guarded machine PUT.
 *
 * `bedProfiles === undefined` is the marker. A machine whose description was deliberately emptied
 * (`[]`) is left alone, so a second connect — or a second window — changes nothing. A refused or
 * stale write is retried once against a fresh read; a failed one waits for the next connect rather
 * than looping on the card.
 */
async function migrateBedOnce(now: () => string = () => new Date().toISOString()): Promise<void> {
  const first = useLocationStore.getState().location?.machines[0];
  if (first === undefined || !bedMigrationDue(first)) return;
  // A successful machine PUT clears `writeNote` (the card's message). The margins move that ran
  // just before this may have left a refusal note that is still true; the bed migration must not
  // erase it, so the note from before the migration is carried across a successful write.
  const carriedNote = useLocationStore.getState().writeNote;
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = useLocationStore.getState();
    const machine = state.location?.machines.find((m) => m.id === first.id);
    if (machine === undefined || !bedMigrationDue(machine)) return;
    const registration = newestViseRegistration(
      Object.values(useEngraveRegistrationStore.getState().records),
      machine.address,
    );
    // One timestamp for the profile's birth and the record's `updatedAt`, so a migration that
    // straddles midnight cannot date its profile a day before the write that carried it.
    const at = now();
    const migrated = bedFromLegacy(
      machine,
      useShopDefaultsStore.getState().defaults,
      registration,
      at,
    );
    if (migrated === null) return;
    // #597 — the accessories are the house's, not the machine's; writing them back to the location
    // is #600. The bed profiles (which name them by id) still land on the machine as before.
    const outcome = await state.saveMachine({
      ...machine,
      bedProfiles: migrated.bedProfiles,
      activeBedProfileId: migrated.activeBedProfileId,
      updatedAt: at,
    });
    if (outcome === 'ok' && carriedNote !== null) useLocationStore.setState({ writeNote: carriedNote });
    if (outcome !== 'stale') return;
    // `saveMachine` re-read the location on a stale guard: try once against what was served.
  }
}

/**
 * Connect: read the location, then reconcile (see the module doc) — the location's record wins
 * where it has one, and this window seeds it where it does not.
 */
export async function reconcileLocation(): Promise<void> {
  // The shop's defaults are read on the same connect: thresholds and waits come from the location —
  // and, since #447, the depth margins, so the read is awaited before the margins are settled. The
  // feeds table is read here too (#450 slice 3): `feedsFor` resolves against it, and a machine
  // whose table arrived after startup must not keep cutting the compiled starting values.
  await Promise.all([
    useShopDefaultsStore.getState().refresh(),
    useLocationStore.getState().refresh(),
    useFeedTableStore.getState().refresh(),
  ]);
  const { status, location } = useLocationStore.getState();
  if (status !== 'present' || location === null) return;
  const existing = location.machines[0];
  const stored = storedBaseline();
  await settleMargins(existing ?? null, stored);
  // #510: the bed is migrated BEFORE the record is applied or written through, so this window's
  // base and the next write-through already carry it. It needs the defaults read above and the
  // session's registration outcomes; both are client-only, which is why the service cannot do it.
  await migrateBedOnce();
  const machine = useLocationStore.getState().location?.machines[0] ?? existing;
  if (machine !== undefined) {
    // #439: a base this window stored for the SAME machine is merged against — so an edit whose write
    // failed before the restart is written, and a section only the location changed is still taken in.
    // Without one, the location's record wins.
    if (stored !== null && stored.id === machine.id) baseline = stored;
    else applyMachineToSettings(machine);
  }
  await pushMachine();
  confirmMarginsMoved();
}

// ── #447: the depth margins in the shop defaults ────────────────────────────────────────────────

/** Whether the margins still travel on the machine record (anything but `defaults`). */
function marginsInRecord(): boolean {
  return useLocationStore.getState().marginsHome !== 'defaults';
}

/** True while this window writes margins: the section changes under it, and is projected after. */
let writingMargins = false;
/** One margins write-through at a time, in order. */
let marginChain: Promise<void> = Promise.resolve();

/** Make the shop defaults say what `want` says; one retry against a fresh read on a refusal. */
async function writeMargins(
  want: MarginSettings,
  opts: { migrate: boolean; note?: string | null; asOf?: string | null },
): Promise<boolean> {
  writingMargins = true;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const shop = useShopDefaultsStore.getState();
      const writes = marginWrites(want, shop.defaults, new Date().toISOString(), opts);
      let ok = true;
      for (const w of writes) {
        ok = w.op === 'set' ? await shop.set(w.key, w.value) : await shop.reset(w.key);
        if (!ok) break;
      }
      if (ok) return true;
    }
    return false;
  } finally {
    writingMargins = false;
  }
}

/** Rebuild `settingsStore.margins` from the shop defaults, when they are the margins' home. */
export function projectMargins(): void {
  if (writingMargins || useLocationStore.getState().marginsHome !== 'defaults') return;
  // A section that could not be read projects nothing: the fallbacks are not the shop's numbers.
  if (useShopDefaultsStore.getState().status !== 'present') return;
  // An edit the shop has not taken yet stays in this window until it is written (#447 review).
  const loc = useLocationStore.getState().location;
  if (loc !== null && pendingMargins(loc.id) !== null) return;
  const next = marginsFromDefaults(useShopDefaultsStore.getState().defaults);
  if (stableJson(next) === stableJson(useSettingsStore.getState().margins)) return;
  applying = true;
  try {
    useSettingsStore.getState().setMargins(next);
  } finally {
    applying = false;
  }
}

/**
 * An edit to the margins (the Settings menu, Restore, a "my machine" import), written to the shop
 * defaults. A refused write keeps the edit — in this window, and in this browser's storage as a
 * pending write (#447 review, the #439 way) that the next connect sends — and says so on the Machines
 * card.
 */
export function writeMarginsThrough(): Promise<void> {
  marginChain = marginChain.then(async () => {
    if (marginsInRecord()) return;
    const loc = useLocationStore.getState().location;
    const want = useSettingsStore.getState().margins;
    const at = new Date().toISOString();
    const ok = await writeMargins(want, { migrate: false });
    if (ok) {
      setPendingMargins(null);
      projectMargins();
    } else {
      if (loc !== null) setPendingMargins({ locationId: loc.id, margins: want, at });
      useLocationStore.setState({
        writeNote: `The depth margins were not saved to the shop defaults: ${useShopDefaultsStore.getState().reason ?? 'the write was refused'}. They are kept here and sent on the next connect.`,
      });
    }
  });
  return marginChain;
}

/**
 * Send a pending margins edit left by an earlier session (#447 review). A shop key set by hand AFTER
 * the edit is newer and kept. Still refused: the edit stays pending, and in this window's settings.
 */
async function flushPendingMargins(locationId: string): Promise<void> {
  const pending = pendingMargins(locationId);
  if (pending === null) return;
  const parsed = parseMarginsStrict(pending.margins);
  if (!parsed.ok) {
    setPendingMargins(null);
    return;
  }
  const ok = await writeMargins(parsed.margins, { migrate: false, asOf: pending.at });
  if (ok) {
    setPendingMargins(null);
    return;
  }
  applying = true;
  try {
    useSettingsStore.getState().setMargins(parsed.margins);
  } finally {
    applying = false;
  }
  useLocationStore.setState({
    writeNote: `A depth-margin edit from an earlier session is still not saved to the shop defaults: ${useShopDefaultsStore.getState().reason ?? 'the write was refused'}.`,
  });
}

/**
 * The move is DONE only once the location no longer carries the old copy (#447 review): no machine
 * record, or one whose `margins` the write-through has already emptied. Only then is this browser's
 * marker set — a failed null-out leaves it unset, and the next connect tries again.
 */
function confirmMarginsMoved(): void {
  const { status, location, marginsHome } = useLocationStore.getState();
  if (status !== 'present' || location === null || marginsHome !== 'defaults') return;
  const record = location.machines[0];
  if (record === undefined || record.margins === null) markMarginsMoved(location.id);
}

/**
 * Decide where the margins live, and move the old copy in — once (see the module doc). `storedBase` is
 * #439's stored merge base, which tells an unsent local edit from a stale one; an import passes null,
 * because the record it just put in place is the newer intent.
 */
export async function settleMargins(record: MachineRecord | null, storedBase: MachineRecord | null): Promise<void> {
  const { status, location } = useLocationStore.getState();
  if (status !== 'present' || location === null) return;
  const shop = useShopDefaultsStore.getState();
  // The location has MOVED when its record's margins are already null or this browser moved them:
  // whatever the section read says now, margins never go back onto the record from a cache.
  const moved = marginsMovedFor(location.id) || (record !== null && record.margins === null);
  if (shop.status !== 'present' || shop.defaults === null) {
    // A location that has not moved keeps #412's record path (an older service with no section, or
    // a read that failed before the move). One that HAS moved keeps the shop defaults as the home and
    // projects nothing until the section reads again (`projectMargins`).
    useLocationStore.setState({ marginsHome: moved ? 'defaults' : 'record' });
    return;
  }
  const legacy = legacyMargins({
    record,
    local: useSettingsStore.getState().margins,
    storedBase,
    migrated: marginsMovedFor(location.id),
    defaults: shop.defaults,
    same: sameMargins,
  });
  if (legacy !== null) {
    const ok = await writeMargins(legacy.margins, {
      migrate: true,
      note: migrationNote(legacy.from),
      asOf: legacy.asOf,
    });
    if (!ok) {
      useLocationStore.setState({
        marginsHome: 'record',
        writeNote: `The depth margins could not be moved into the shop defaults, so they stay on the machine record: ${useShopDefaultsStore.getState().reason ?? 'the write was refused'}.`,
      });
      return;
    }
  }
  // The marker waits for the record's copy to be emptied (`confirmMarginsMoved`, after the push).
  useLocationStore.setState({ marginsHome: 'defaults' });
  await flushPendingMargins(location.id);
  projectMargins();
}

/** Two margin records alike, the #447 thickness ± aside (a projected cache carries it, a record does not). */
function sameMargins(a: unknown, b: unknown): boolean {
  const strip = (m: unknown) => {
    if (m === null || typeof m !== 'object') return m;
    const { measuredThicknessTolerance: _drop, ...rest } = m as Record<string, unknown>;
    void _drop;
    return rest;
  };
  return stableJson(strip(a)) === stableJson(strip(b));
}

/**
 * After a location import (#447): the imported document brought its own defaults section, and maybe
 * a machine record that still carries margins — re-read the section, and move them in.
 */
export async function settleMarginsAfterImport(): Promise<void> {
  // The imported document brought its own feeds table too (#450 slice 3): re-read it, or the
  // window keeps resolving against the pre-import rows.
  await Promise.all([useShopDefaultsStore.getState().refresh(), useFeedTableStore.getState().refresh()]);
  const { status, location } = useLocationStore.getState();
  if (status !== 'present' || location === null) return;
  const record = location.machines[0] ?? null;
  // The import is the newer intent: no unsent-edit check, and a browser copy is not brought back.
  if (record !== null && record.margins !== null) await settleMargins(record, null);
  else if (useLocationStore.getState().marginsHome === 'defaults') projectMargins();
  await pushMachine();
  confirmMarginsMoved();
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
    // #447: a margins edit goes to the shop defaults once they are its home, not to the record.
    const marginsMoved = s.margins !== prev.margins && !applying && !marginsInRecord();
    if (marginsMoved) void writeMarginsThrough();
    if (
      s.fixtures !== prev.fixtures ||
      (s.margins !== prev.margins && !marginsMoved) ||
      s.machineCalibration !== prev.machineCalibration
    ) {
      onChange();
    }
  });
  // #447: another window's margin, a reset, or an import changes the section: project it.
  const offDefaults = useShopDefaultsStore.subscribe((s, prev) => {
    if (s.defaults !== prev.defaults) projectMargins();
  });
  const offMachine = useMachineStore.subscribe((s, prev) => {
    if (s.machine !== prev.machine) onChange();
  });
  return () => {
    offRegistry();
    offSettings();
    offDefaults();
    offMachine();
  };
}

/** Test seam. */
export function resetLocationStore(): void {
  useLocationStore.setState({
    status: 'unknown',
    location: null,
    etag: null,
    reason: null,
    writeNote: null,
    accessoryNote: null,
    marginsHome: 'browser',
  });
  pushing = null;
  writingMargins = false;
  marginChain = Promise.resolve();
  again = false;
  applying = false;
  baseline = null;
  seedSuppressed = false;
}

/** Test seam: forget the stored base too (a fresh browser). */
export function clearStoredBaseline(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(BASELINE_KEY);
  } catch {
    // nothing stored
  }
}
