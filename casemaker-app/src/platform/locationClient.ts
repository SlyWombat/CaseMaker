/**
 * The location (#412, `docs/design/cnc-job-workflow.md` §3): its schemas, and the two requests that
 * read it and write a machine record. The service's half is `src-tauri/src/location.rs`.
 *
 * ONE DOCUMENT, TWO IMPLEMENTATIONS, AS FOR THE HOUSE (#320). The service stores `location.json` and
 * refuses unknown keys; this side parses what it serves with the schemas below, and the specimen
 * both sides are tested against is `tests/unit/fixtures/location-doc.json`.
 *
 * THE MACHINE'S SECTIONS ARE VALIDATED HERE, NOT THERE. `fixtures`, `margins` and `calibration` are
 * this app's own records, and the strict parsers the "my machine" import already uses
 * (`parseFixturesStrict`, `parseMarginsStrict`, `parseMachineCalibration`) are their one shape
 * authority. The service checks only that each is an object and keeps it verbatim; a section that is
 * present but malformed fails THIS parse, with the parser's own reason.
 *
 * THE TOOL TIERS ARE NOT ON `GET /location`. They have their own endpoints, validators and store
 * (`toolRegistryStore`), so the location's own body is its identity and machines; only the whole
 * exported document (`LocationDocSchema`) carries them, and that is what an import is checked
 * against before it is sent.
 */

import { z } from 'zod';
import { ToolSchema } from '@/engine/cnc/toolLibrary';
import { parseMachineCalibration, type MachineCalibration } from '@/engine/cnc/calibration';
import type { MarginSettings } from '@/engine/cnc/engrave/depthBounds';
import { parseFixturesStrict, parseMarginsStrict, type FixturesSettings } from '@/store/settingsStore';
import {
  InventorySchema,
  OriginSchema,
  houseRequest,
  type HouseFailure,
  type HouseReadFailure,
  type HouseRequestOptions,
  type HouseWrite,
} from './houseClient';
import { StockShelfSchema } from './stockClient';

/** Magic string that says "this is a Case Maker location file". Equal to `location.rs`'s. */
export const LOCATION_KIND = 'casemaker-location';
/** The location document's own version — independent of the wire's `HOUSE_SCHEMA_VERSION`. */
export const LOCATION_SCHEMA_VERSION = 1;
/** What the exported location is saved as. */
export const LOCATION_FILENAME = 'location.json';

/**
 * A section that must be a record the strict parser accepts, or null — and what comes out is the
 * PARSER'S value, not the raw one, so a record read back from the service compares equal to the same
 * section as `settingsStore` holds it (a defaulted key filled the same way on both sides).
 */
function section<T>(
  what: string,
  parse: (raw: unknown) => { ok: true; value: T } | { ok: false; reason: string },
) {
  return z.unknown().transform((raw, ctx): T | null => {
    if (raw === null || raw === undefined) return null;
    const res = parse(raw);
    if (!res.ok) {
      ctx.addIssue({ code: 'custom', message: `${what}: ${res.reason}` });
      return z.NEVER;
    }
    return res.value;
  });
}

export const MachineAddressSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
});

/**
 * One machine at the location (§3.1). `serial` and `firmware` are null until something READS them
 * from the machine; nothing here types them in.
 */
export const MachineRecordSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  serial: z.string().nullable().default(null),
  firmware: z.string().nullable().default(null),
  address: MachineAddressSchema.nullable().default(null),
  calibration: section<MachineCalibration>('calibration', (raw) => {
    const r = parseMachineCalibration(raw);
    return r.ok ? { ok: true, value: r.calibration } : { ok: false, reason: r.reason };
  }),
  fixtures: section<FixturesSettings>('fixtures', (raw) => {
    const r = parseFixturesStrict(raw);
    return r.ok ? { ok: true, value: r.fixtures } : r;
  }),
  margins: section<MarginSettings>('margins', (raw) => {
    const r = parseMarginsStrict(raw);
    return r.ok ? { ok: true, value: r.margins } : r;
  }),
  updatedAt: z.string().min(1),
});

export type MachineAddress = z.infer<typeof MachineAddressSchema>;
export type MachineRecord = z.infer<typeof MachineRecordSchema>;

const machinesSchema = z.array(MachineRecordSchema).superRefine((list, ctx) => {
  const ids = new Set<string>();
  list.forEach((m, i) => {
    if (ids.has(m.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `machine ${m.id} appears twice` });
    ids.add(m.id);
  });
});

/** A machine record this build could not read, kept by name so the card can say which. */
export interface UnreadableMachine {
  id: string | null;
  reason: string;
}

/**
 * The served machine list, read ONE MACHINE AT A TIME (#412 review). The service stores a machine's
 * sections without reading them, so one malformed record — written by a newer build, or by hand —
 * must cost that machine and not the whole location for every window. A record that does not parse
 * (or repeats an id) is set aside with its reason; the rest are served as usual.
 */
const lenientMachinesSchema = z.array(z.unknown()).transform((list) => {
  const machines: MachineRecord[] = [];
  const unreadableMachines: UnreadableMachine[] = [];
  const ids = new Set<string>();
  for (const raw of list) {
    const rawId = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
    const id = typeof rawId === 'string' ? rawId : null;
    const parsed = MachineRecordSchema.safeParse(raw);
    if (!parsed.success) {
      unreadableMachines.push({ id, reason: firstIssue(parsed.error) });
    } else if (ids.has(parsed.data.id)) {
      unreadableMachines.push({ id, reason: `machine ${parsed.data.id} appears twice` });
    } else {
      ids.add(parsed.data.id);
      machines.push(parsed.data);
    }
  }
  return { machines, unreadableMachines };
});

const locationIdentity = {
  kind: z.literal(LOCATION_KIND),
  schemaVersion: z.literal(LOCATION_SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string().min(1),
  migratedFrom: z.string().nullable().default(null),
};

/** `GET /api/v1/location`: the location without its tool tiers, machines read one at a time. */
export const LocationViewSchema = z
  .object({ ...locationIdentity, machines: lenientMachinesSchema })
  .transform(({ machines, ...rest }) => ({
    ...rest,
    machines: machines.machines,
    unreadableMachines: machines.unreadableMachines,
  }));

export type LocationView = z.infer<typeof LocationViewSchema>;

/** A user tool as stored in the location: the wire's `ToolLibraryEntry` plus its `origin`. */
const StoredUserToolSchema = z.object({
  key: z.string().min(1),
  tool: ToolSchema,
  provenance: z.string().min(1),
  origin: OriginSchema.nullable().default(null),
});

/** The whole exported `location.json`. */
export const LocationDocSchema = z.object({
  ...locationIdentity,
  // STRICT here, unlike the served view: an import is a whole document the user is choosing to put
  // in place, and one this build could not read back is refused before it is sent.
  machines: machinesSchema,
  tools: z.array(StoredUserToolSchema).default([]).superRefine((list, ctx) => {
    const keys = new Set<string>();
    list.forEach((t, i) => {
      if (keys.has(t.key)) ctx.addIssue({ code: 'custom', path: [i, 'key'], message: `duplicate key "${t.key}"` });
      keys.add(t.key);
    });
  }),
  inventory: InventorySchema.default([]),
  /** The stock shelf (#413), strict like the rest of an import. */
  stock: StockShelfSchema.default([]),
});

export type LocationDoc = z.infer<typeof LocationDocSchema>;

/** What a location read concluded. */
export type LocationRead =
  | { kind: 'ok'; etag: string | null; location: LocationView }
  | HouseReadFailure;

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unrecognised shape';
  const at = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${at}${issue.message}`;
}

/**
 * Read the location. A service from before #412 answers this path with its JSON 404, which arrives
 * as a refusal; that is reported as `absent` — there is no location there, which is a normal answer.
 */
export async function houseLocation(opts?: HouseRequestOptions): Promise<LocationRead> {
  const res = await houseRequest('GET', '/location', undefined, opts);
  // A 404 is a service from before #412: no location there, a normal answer. Any other refusal is
  // the service saying its location file cannot be read (#412 review) — an ERROR with the service's
  // own sentence, so the card can say so instead of showing nothing.
  if (res.kind === 'refused') {
    return res.status === 404 ? { kind: 'absent', reason: res.message } : { kind: 'error', detail: res.message };
  }
  if (res.kind !== 'ok') return res;
  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    return { kind: 'error', detail: 'the location is not readable JSON' };
  }
  const parsed = LocationViewSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: 'error', detail: `the location does not match this build: ${firstIssue(parsed.error)}` };
  }
  return { kind: 'ok', etag: res.etag ?? null, location: parsed.data };
}

/**
 * Create or replace one machine record. GUARDED (#321): `ifMatch` is the `ETag` of the location as
 * last read, and a stale one is refused with 412.
 */
export async function housePutMachine(
  record: MachineRecord,
  ifMatch: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  // Held to the schema the read uses BEFORE it is sent (#412 review): the service keeps a section
  // without reading it, so a record this build could not read back would otherwise be stored and
  // then set aside by every window's read.
  const checked = MachineRecordSchema.safeParse(record);
  if (!checked.success) {
    return { kind: 'refused', status: 400, message: `this machine record would not read back: ${firstIssue(checked.error)}` };
  }
  const res = await houseRequest('PUT', `/location/machines/${encodeURIComponent(record.id)}`, record, {
    ...opts,
    ifMatch,
  });
  return res.kind === 'ok' ? { kind: 'ok' } : (res as HouseFailure);
}

/**
 * Check an import's text BEFORE it is sent (#412). A location file is held to this build's schemas
 * — machine sections included, which the service stores without reading — so a file the app could
 * not read back is refused here with a reason rather than accepted there and then failing every
 * location read. Returns the parsed location, `null` for a document of another kind (a house file
 * goes to the service as it always has, and the service judges it), or the reason it is refused.
 */
export function checkLocationImport(
  text: string,
): { kind: 'location'; doc: LocationDoc } | { kind: 'other' } | { kind: 'refused'; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'other' };
  }
  if (typeof json !== 'object' || json === null || (json as { kind?: unknown }).kind !== LOCATION_KIND) {
    return { kind: 'other' };
  }
  const parsed = LocationDocSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: 'refused', reason: `this location file does not match this build: ${firstIssue(parsed.error)}` };
  }
  return { kind: 'location', doc: parsed.data };
}

/**
 * Dismiss the "house.json changed after location.json" warning (#412 re-review). The service records
 * it against that file's modification time, so only a later change to it raises the warning again.
 */
export async function houseDismissHouseWarning(opts?: HouseRequestOptions): Promise<HouseWrite> {
  const res = await houseRequest('POST', '/location/house-warning/dismiss', undefined, opts);
  return res.kind === 'ok' ? { kind: 'ok' } : (res as HouseFailure);
}
