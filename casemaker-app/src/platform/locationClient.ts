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
import { FeedsTableSchema } from './feedClient';
import { ShopDefaultsSchema } from './defaultsClient';
import { PowerSwitchSchema } from './powerClient';
import { WasteboardSchema, ScarSchema } from '@/engine/cnc/wasteboard';

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

// ── #510: the bed — fixture records, profiles and the active one ──────────────────────────────
//
// The design is `docs/design/bed-profiles.md` §2. The model lives on the machine because the bed is
// a property of the physical unit, not of a job; many named profiles, exactly one active. The
// service's typed half is `location.rs`, and the shared specimen is `tests/unit/fixtures/location-doc.json`.
//
// WHY THE FIXTURE RECORDS ARE `bedFixtures`, NOT §2's `fixtures`: `machines[].fixtures` has held the
// `FixturesSettings` record (`{vise?, sacrificial?}`) since #412, and that record is the SOURCE of
// the vise migration. Replacing it would delete the data being migrated, so the new list lives
// beside it and `fixtures` is untouched (see `platform/bedProfiles.ts` and the completion note on
// #510). It is the one place this build differs from the design's literal key.
//
// A DATUM IS NEVER TYPED. `by: "typed"` is refused here as well as in Rust, and every datum field
// is required — an unmeasured datum is `null`, never a value with no provenance.
//
// OPEN QUESTION A, DECIDED: the vise and the 4th-axis module share the pins and are mutually
// exclusive. A profile that places both is refused at the machine level, where the fixture kinds
// are known.

const bedId = z
  .string()
  .min(1)
  .refine(
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
    (v) => v === v.trim() && !v.includes('/') && !/[\u0000-\u001f\u007f-\u009f]/.test(v),
    'cannot be an id: no slash, no control character, no space at either end',
  );
const bedText = z.string().refine((v) => v.trim().length > 0, 'is empty');
const bedNumber = z.number().finite();
const bedPositive = bedNumber.positive();
const bedProvenance = z.record(z.string(), bedText).superRefine((map, ctx) => {
  for (const key of Object.keys(map)) {
    if (key.trim().length === 0) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'a provenance entry has no key' });
    }
  }
});

/** #597 — where an accessory is right now: in the box, or checked out to a machine since a date. */
const AccessoryWhereSchema = z.union([
  z.object({ kind: z.literal('box') }).strict(),
  z.object({ kind: z.literal('machine'), machineId: bedId, since: bedText }).strict(),
]);

/** One accessory the shop owns: product constants, this unit's measurements, and provenance. */
export const FixtureRecordSchema = z
  .object({
    id: bedId,
    /** Open on purpose (`vise`, `bracket`, `top-clamp`, `rotary-module`, `probe`, …): another accessory is additive. */
    kind: bedText,
    product: bedText.nullable().default(null),
    variant: bedText.nullable().default(null),
    constants: z.record(z.string(), z.unknown()).default({}),
    unit: z.record(z.string(), z.unknown()).default({}),
    provenance: bedProvenance.default({}),
    // #597 — the house owns every accessory; a unit is in the box or checked out to one machine.
    whereabouts: AccessoryWhereSchema.default({ kind: 'box' }),
    history: z
      .array(z.object({ at: bedText, what: bedText }).strict())
      .default([]),
  })
  .strict()
  .superRefine((f, ctx) => {
    // The open maps carry dimensions and counts; the service refuses nameless keys and non-finite
    // numbers, and the client must not be the more permissive side of the same contract.
    for (const [what, map] of [['constants', f.constants], ['unit', f.unit]] as const) {
      for (const [key, value] of Object.entries(map)) {
        if (key.trim().length === 0) {
          ctx.addIssue({ code: 'custom', path: [what, key], message: `a ${what} key has no name` });
        }
        if (typeof value === 'number' && !Number.isFinite(value)) {
          ctx.addIssue({ code: 'custom', path: [what, key], message: `${what}.${key} is not a finite number` });
        }
      }
    }
  });

/** A datum measured ON this bed: value, date and instrument, never a typed number. */
export const MeasuredDatumSchema = z
  .object({
    value: bedNumber,
    measuredAt: bedText,
    by: bedText.refine((v) => v.trim().toLowerCase() !== 'typed', 'a datum is measured, never typed'),
    at: z.tuple([bedNumber, bedNumber]).nullable().default(null),
  })
  .strict();

/** The four datums a profile describes; each `null` until measured. */
export const BedDatumsSchema = z
  .object({
    surfaceTopZ: MeasuredDatumSchema.nullable().default(null),
    viseJawTopZ: MeasuredDatumSchema.nullable().default(null),
    bracketSeatZ: MeasuredDatumSchema.nullable().default(null),
    rotaryAxis: MeasuredDatumSchema.nullable().default(null),
  })
  .strict();

const BedPositionSchema = z
  .object({
    frontLeft: z.tuple([bedNumber, bedNumber]),
    frame: z.literal('machine'),
  })
  .strict();

/** What the stock or the fixtures stand on (open question E: the bare bed has no size or scars). */
export const BedSurfaceSchema = z
  .object({
    kind: z.enum(['bare-bed', 'wasteboard', 'fixture-plate', 'vacuum-bed']),
    material: bedText.nullable().default(null),
    length: bedPositive.nullable().default(null),
    width: bedPositive.nullable().default(null),
    thickness: bedPositive.nullable().default(null),
    position: BedPositionSchema.nullable().default(null),
    provenance: bedProvenance.default({}),
    scars: z.array(ScarSchema).max(500).default([]),
    lastResurfacedAt: bedText.nullable().default(null),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.kind === 'bare-bed') {
      if (
        s.material !== null ||
        s.length !== null ||
        s.width !== null ||
        s.thickness !== null ||
        s.position !== null ||
        s.lastResurfacedAt !== null ||
        s.scars.length > 0
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['kind'],
          message: 'the bare bed has no size, position, scars or resurfacing (open question E)',
        });
      }
    }
    if (s.kind === 'wasteboard' && s.thickness === null) {
      ctx.addIssue({ code: 'custom', path: ['thickness'], message: 'a wasteboard says how thick it is' });
    }
  });

const PlacementWhereSchema = z
  .object({
    kind: z.enum(['pins', 'anchor', 'free']),
    /** Open question A: the two pin users are `vise` and `rotary`. */
    pins: z.enum(['vise', 'rotary']).nullable().default(null),
    anchor: z.number().int().min(1).max(2).nullable().default(null),
  })
  .strict()
  .superRefine((w, ctx) => {
    if (w.kind === 'pins' && w.pins === null) {
      ctx.addIssue({ code: 'custom', path: ['pins'], message: "a pins placement says whose pins" });
    }
    if (w.kind !== 'pins' && w.pins !== null) {
      ctx.addIssue({ code: 'custom', path: ['pins'], message: 'only a pins placement names the pins' });
    }
    if (w.kind === 'anchor' && w.anchor === null) {
      ctx.addIssue({ code: 'custom', path: ['anchor'], message: 'an anchor placement says which anchor (1 or 2)' });
    }
    if (w.kind !== 'anchor' && w.anchor !== null) {
      ctx.addIssue({ code: 'custom', path: ['anchor'], message: 'only an anchor placement names an anchor' });
    }
  });

const PlacementFrameSchema = z
  .object({
    fixedJawFaceX: bedNumber.nullable().default(null),
    jawStartY: bedNumber.nullable().default(null),
  })
  .strict();

/** One fixture put on the bed: position and orientation only; the shape is the fixture's. */
export const BedPlacementSchema = z
  .object({
    id: bedId,
    fixture: bedId,
    where: PlacementWhereSchema,
    count: z.number().int().positive().nullable().default(null),
    frame: PlacementFrameSchema.nullable().default(null),
    provenance: bedProvenance.default({}),
  })
  .strict();

const MountingChoiceSchema = z
  .object({
    placement: bedId.nullable().default(null),
    manner: z.enum(['jaws', 'corner+clamps', 'tape', 'vacuum', 'chuck']),
  })
  .strict();

const PreferredMountingSchema = z
  .object({
    stock: bedText,
    mount: MountingChoiceSchema,
  })
  .strict();

const ConsumableTapeSchema = z
  .object({
    widthMm: bedPositive,
    thicknessMm: bedPositive,
    provenance: bedText,
  })
  .strict();

const ConsumableBoardSchema = z
  .object({
    material: bedText,
    /** `[length, width, thickness]`, mm. */
    size: z.tuple([bedPositive, bedPositive, bedPositive]),
    count: z.number().int().min(0),
  })
  .strict();

const ConsumablesSchema = z
  .object({
    tape: ConsumableTapeSchema.nullable().default(null),
    boards: z.array(ConsumableBoardSchema).default([]),
  })
  .strict();

const ProfileHistoryEntrySchema = z
  .object({
    at: bedText,
    what: bedText,
  })
  .strict();

/** One named description of the machine's bed. */
export const BedProfileSchema = z
  .object({
    id: bedId,
    name: bedText,
    createdAt: bedText,
    /** The shipped profile it started from, or null. */
    basedOn: bedText.nullable().default(null),
    surface: BedSurfaceSchema,
    datums: BedDatumsSchema,
    placements: z.array(BedPlacementSchema).default([]),
    preferredMounting: z.array(PreferredMountingSchema).default([]),
    consumables: ConsumablesSchema.nullable().default(null),
    history: z.array(ProfileHistoryEntrySchema).default([]),
  })
  .strict()
  .superRefine((p, ctx) => {
    const placementIds = new Set<string>();
    p.placements.forEach((pl, i) => {
      if (placementIds.has(pl.id)) {
        ctx.addIssue({ code: 'custom', path: ['placements', i, 'id'], message: `two placements called "${pl.id}"` });
      }
      placementIds.add(pl.id);
    });
    // Open question A, decided: the pin labels alone may not name both accessories, even where a
    // fixture's `kind` does not (the service refuses the same conflict).
    const pinKinds = new Set(p.placements.flatMap((pl) => (pl.where.pins === null ? [] : [pl.where.pins])));
    if (pinKinds.has('vise') && pinKinds.has('rotary')) {
      ctx.addIssue({
        code: 'custom',
        path: ['placements'],
        message: 'places the vise and the 4th-axis module on the pins: they are mutually exclusive',
      });
    }
    const stocks = new Set<string>();
    p.preferredMounting.forEach((m, i) => {
      if (stocks.has(m.stock)) {
        ctx.addIssue({ code: 'custom', path: ['preferredMounting', i, 'stock'], message: `two mountings for "${m.stock}"` });
      }
      stocks.add(m.stock);
      if (m.mount.placement !== null && !placementIds.has(m.mount.placement)) {
        ctx.addIssue({
          code: 'custom',
          path: ['preferredMounting', i, 'mount', 'placement'],
          message: `prefers placement "${m.mount.placement}", which this profile does not have`,
        });
      }
    });
  });

export type FixtureRecord = z.infer<typeof FixtureRecordSchema>;
export type BedProfile = z.infer<typeof BedProfileSchema>;


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
  /** An optional power switch (#416). Never a token: that is in the desktop's secure store. */
  power: PowerSwitchSchema.nullable().default(null),
  /** The machine's wasteboard (#417). */
  wasteboard: WasteboardSchema.nullable().default(null),
  /**
   * The FNV program hashes this machine has FINISHED cleanly (#419 §4.5) — `RunPlanInput.finishedHashes`
   * (Q14). Its own append endpoint (`finishedProgramsClient.ts`), never a machine write. Defaulted:
   * a record written before the section existed has no key, and an empty list is its absence.
   */
  finishedPrograms: z
    .array(z.string().min(1).refine((h) => h === h.trim(), 'a hash has no space at either end'))
    .default([]),
  /** The machine's bed profiles, same presence rule; `[]` is a deliberately emptied description. */
  bedProfiles: z.array(BedProfileSchema).optional(),
  /** The one active profile; present exactly when `bedProfiles` holds at least one. */
  activeBedProfileId: bedId.optional(),
  updatedAt: z.string().min(1),
}).superRefine((m, ctx) => {
  const profiles = m.bedProfiles;
  if (profiles !== undefined) {
    const ids = new Set<string>();
    profiles.forEach((p, i) => {
      if (ids.has(p.id)) {
        ctx.addIssue({ code: 'custom', path: ['bedProfiles', i, 'id'], message: `machine has two bed profiles called "${p.id}"` });
      }
      ids.add(p.id);
    });
  }

  // Exactly one active profile once there is a profile; no active id without one.
  if (profiles === undefined) {
    if (m.activeBedProfileId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['activeBedProfileId'],
        message: 'names an active bed profile but the machine has no profiles',
      });
    }
  } else if (profiles.length === 0) {
    if (m.activeBedProfileId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['activeBedProfileId'],
        message: 'names an active bed profile but the machine has no profiles',
      });
    }
  } else {
    if (m.activeBedProfileId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['activeBedProfileId'], message: 'the machine has bed profiles but names no active one' });
    } else if (!profiles.some((p) => p.id === m.activeBedProfileId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['activeBedProfileId'],
        message: `names "${m.activeBedProfileId}", which is not one of this machine's profiles`,
      });
    }
  }
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
  .object({ ...locationIdentity, machines: lenientMachinesSchema, accessories: z.array(FixtureRecordSchema).optional() })
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
  /**
   * #597 — the accessories the house owns (mounts and probes). A machine's bed profile places one by
   * id; `whereabouts` on each record says whether it is in the box or checked out to a machine.
   * `.optional()` so a location written before the hoist round-trips without gaining a key.
   */
  accessories: z.array(FixtureRecordSchema).optional(),
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
  /**
   * The feeds table (#450 slice 2), strict like the rest. Defaulted: a location exported before the
   * table existed has no key, and an empty table is the absence of the key rather than a claim.
   */
  feeds: FeedsTableSchema.default([]),
  /** The shop's tunable defaults, with provenance (`defaultsClient.ts`). */
  defaults: ShopDefaultsSchema.default({}),
}).superRefine((doc, ctx) => {
  // #597 — the accessories are the house's, so the placement checks move here from the machine level:
  // unique ids, every placement names an accessory the location owns, and the vise/rotary exclusion.
  const accessories = doc.accessories ?? [];
  const ids = new Set<string>();
  accessories.forEach((a, i) => {
    if (ids.has(a.id)) {
      ctx.addIssue({ code: 'custom', path: ['accessories', i, 'id'], message: `two accessories are called "${a.id}"` });
    }
    ids.add(a.id);
  });
  doc.machines.forEach((m, mi) => {
    (m.bedProfiles ?? []).forEach((p, pi) => {
      const placedKinds = new Set<string>();
      p.placements.forEach((pl, pj) => {
        const accessory = accessories.find((a) => a.id === pl.fixture);
        if (accessory === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['machines', mi, 'bedProfiles', pi, 'placements', pj, 'fixture'],
            message: `places fixture "${pl.fixture}", which the location does not own`,
          });
        } else {
          placedKinds.add(accessory.kind);
        }
      });
      if (placedKinds.has('vise') && placedKinds.has('rotary-module')) {
        ctx.addIssue({
          code: 'custom',
          path: ['machines', mi, 'bedProfiles', pi, 'placements'],
          message: 'places the vise and the 4th-axis module: they share the pins, so one at a time',
        });
      }
    });
  });
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
 * Create or replace one accessory record (#601) — a register, an edit, a measurement, a check-out.
 * GUARDED (#321) on the location's `ETag`, the same way a machine write is. Held to this build's
 * schema before it is sent, so a record this build could not read back is refused, not stored.
 */
export async function housePutAccessory(
  record: FixtureRecord,
  ifMatch: string | null,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  const checked = FixtureRecordSchema.safeParse(record);
  if (!checked.success) {
    return { kind: 'refused', status: 400, message: `this accessory would not read back: ${firstIssue(checked.error)}` };
  }
  const res = await houseRequest('PUT', `/location/accessories/${encodeURIComponent(record.id)}`, record, {
    ...opts,
    ifMatch,
  });
  return res.kind === 'ok' ? { kind: 'ok' } : (res as HouseFailure);
}

/** Retire one accessory (#601): take it off the location's list. Guarded as {@link housePutAccessory}. */
export async function houseDeleteAccessory(id: string, ifMatch: string | null, opts?: HouseRequestOptions): Promise<HouseWrite> {
  const res = await houseRequest('DELETE', `/location/accessories/${encodeURIComponent(id)}`, undefined, {
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
