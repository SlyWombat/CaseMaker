/**
 * #510 — the bed model's four in-place migrations.
 *
 * `docs/design/bed-profiles.md` §2 puts what is physically on the machine's bed into
 * `machines[].bedFixtures[]` / `bedProfiles[]` / `activeBedProfileId`. Four things the app already
 * recorded move into the first profile, ONCE, in place, and nothing is deleted:
 *
 *   1. `machine.wasteboard` → the profile's `surface` (kind `wasteboard`, thickness, provenance,
 *      resurfacing date and EVERY scar kept). No wasteboard → `{kind: "bare-bed"}` (open question E).
 *   2. `machine.fixtures.vise` → the vise fixture record's product constants and this unit's
 *      measurements, with the legacy `source`/`measuredAt` turned into provenance words.
 *   3. the measured `bracket.seatMachineZ` shop default → `datums.bracketSeatZ`, dated by the
 *      default's own `setAt`. Absent or not measured → `null`; a datum is never typed or seeded.
 *   4. a usable vise registration outcome (#475/#495) → the vise placement's `frame`: the measured
 *      G54 X is the fixed jaw face, and the measured G54 Y plus the legacy `jawStartY` is where the
 *      bar starts. No outcome → the placement exists with a `null` frame.
 *
 * The migrated profile is named "Current bed (migrated <date>)" and made active. The PRESENCE of
 * `bedProfiles` is the marker that the migration has run — `undefined` is "not described yet",
 * `[]` is a deliberately emptied description — so a second connect changes nothing.
 *
 * WHY THIS IS ON THE CLIENT. The service owns `location.json`, but it cannot see this window's
 * registration outcomes (they are session state — `engraveRegistrationStore`) or the machine's
 * parsed `FixturesSettings`. The migration therefore reads both here and writes the result through
 * the normal guarded machine PUT. `locationStore.reconcileLocation` runs it once per connect.
 *
 * Pure: the machine record, the shop defaults, the registration records and a clock go in; the new
 * keys come out. No store, no requests, so every rule below is pinned by `bedProfiles.spec.ts`.
 */

import { LEDGE_STEP, LEDGE_WIDTH } from '@/engine/cnc/fixture';
import type { ShopDefaults } from './defaultsClient';
import type { BedProfile, FixtureRecord, MachineRecord } from './locationClient';

export interface MigratedBed {
  /** #597 — the accessories this migration creates (the house's, checked out to this machine). */
  accessories: FixtureRecord[];
  bedProfiles: NonNullable<MachineRecord['bedProfiles']>;
  activeBedProfileId: string;
}

/** A registration outcome as this migration needs it: where the edges put the work origin. */
export interface LegacyViseRegistration {
  measuredAt: string;
  correctedG54: { x: number; y: number };
}

/**
 * The parts of a stored registration the migration reads. Structural rather than importing
 * `FirstRegistration`, so the platform module stays free of the store graph (and the test can feed
 * a plain object).
 */
export interface RegistrationSource {
  target: { host: string; port: number };
  plan: { mount: string };
  outcome: { usable: boolean; correctedG54: { x: number; y: number } };
  measuredAt: string;
}

type Surface = BedProfile['surface'];
type Datum = NonNullable<BedProfile['datums']['bracketSeatZ']>;

/** True until the bed has been described: `undefined`, never `[]`, is the migration's marker. */
export function bedMigrationDue(machine: MachineRecord): boolean {
  return machine.bedProfiles === undefined;
}

/**
 * The newest USABLE vise registration measured at this machine's address, or null. A registration
 * on another machine's frame is not this bed's, and an unusable one measured nothing it can use.
 */
export function newestViseRegistration(
  records: readonly RegistrationSource[],
  target: { host: string; port: number } | null,
): LegacyViseRegistration | null {
  if (target === null) return null;
  let best: RegistrationSource | null = null;
  for (const rec of records) {
    if (rec.target.host !== target.host || rec.target.port !== target.port) continue;
    if (rec.plan.mount !== 'vise' || !rec.outcome.usable) continue;
    if (best === null || rec.measuredAt > best.measuredAt) best = rec;
  }
  if (best === null) return null;
  return {
    measuredAt: best.measuredAt,
    correctedG54: {
      x: best.outcome.correctedG54.x,
      y: best.outcome.correctedG54.y,
    },
  };
}

/**
 * #599 — the fixed-jaw frame a registration fixes: the corrected G54 X IS the fixed jaw face (the
 * stock's left edge), and the bar starts `jawStartY` from the corrected G54 Y (the legacy negative
 * offset). The one statement of this arithmetic, reused by `bedFromLegacy` and the planner's frame
 * source order.
 */
export function viseFrameFromRegistration(
  registration: LegacyViseRegistration,
  jawStartY: number,
): { fixedJawFaceX: number; jawStartY: number } {
  return {
    fixedJawFaceX: round3(registration.correctedG54.x),
    jawStartY: round3(registration.correctedG54.y + jawStartY),
  };
}

/**
 * The new keys for a machine that has not been migrated, or null when there is nothing to migrate
 * (no wasteboard, no vise, no measured bracket seat) or the bed is already described. Nothing is
 * deleted: every legacy key stays exactly where it was.
 */
export function bedFromLegacy(
  machine: MachineRecord,
  defaults: ShopDefaults | null,
  registration: LegacyViseRegistration | null,
  now: string,
): MigratedBed | null {
  if (!bedMigrationDue(machine)) return null;

  const vise = machine.fixtures?.vise ?? null;
  const wasteboard = machine.wasteboard;
  const seat = measuredBracketSeat(defaults);
  if (vise === null && wasteboard === null && seat === null) return null;

  const day = dayOf(now);
  const profileId = `bp-migrated-${day}`;
  const sources: string[] = [];

  const accessories: FixtureRecord[] = [];
  const placements: BedProfile['placements'] = [];

  if (wasteboard !== null) sources.push('the wasteboard');

  if (vise !== null) {
    sources.push('the vise settings');
    // The legacy record is one unit's setup: its source and measuredAt are the provenance for
    // every measurement it carries. `saved` was the user's own entry, so it reads as `typed`.
    const source =
      vise.source === 'measured'
        ? vise.measuredAt !== undefined
          ? `measured:${vise.measuredAt}`
          : 'measured'
        : vise.source === 'saved'
          ? vise.measuredAt !== undefined
            ? `typed:${vise.measuredAt}`
            : 'typed'
          : 'default';

    const unit: Record<string, number | null> = {
      // Everything the settings record stored, so nothing is lost (the unit map is open).
      stockProud: vise.stockProud,
      fixedJawThickness: vise.fixedJawThickness,
      movingJawThickness: vise.movingJawThickness,
      jawLength: vise.jawLength,
      jawStartY: vise.jawStartY,
      uncertainty: vise.uncertainty,
      // The design's unmeasured body dimensions: present as explicitly unmeasured, not guessed.
      jawBarHeight: null,
      bodyHeight: null,
      maxOpening: null,
    };
    const provenance: Record<string, string> = {};
    for (const [key, value] of Object.entries(unit)) {
      provenance[key] = value === null ? 'unmeasured' : source;
    }

    accessories.push({
      id: 'fx-vise-1',
      kind: 'vise',
      product: 'makera-z1-low-profile-vise',
      variant: null,
      constants: {
        // The bar width is the fixed jaw's measured thickness; the ledges are #208's caliper
        // readings (fixture.ts), not new claims.
        jawBarWidth: vise.fixedJawThickness,
        jawLength: vise.jawLength,
        ledgeStep: LEDGE_STEP,
        ledgeWidth: LEDGE_WIDTH,
      },
      unit,
      provenance: {
        ...provenance,
        jawBarWidth: source,
        jawLength: source,
        ledgeStep: 'measured',
        ledgeWidth: 'measured',
      },
      // #597 — the accessory belongs to the house and is checked out to the machine it migrates.
      whereabouts: { kind: 'machine', machineId: machine.id, since: now },
      history: [{ at: now, what: 'created by migrating the legacy vise settings' }],
    });

    const frame =
      registration === null
        ? null
        : // The registration's corrected G54 IS the stock's front-left corner in machine XY: its X is
          // against the fixed jaw face, its Y is the stock's front edge, and the bar starts `jawStartY`
          // from there (the legacy negative offset) — `viseFrameFromRegistration` is the one statement.
          viseFrameFromRegistration(registration, vise.jawStartY);

    placements.push({
      id: 'pl-vise',
      fixture: 'fx-vise-1',
      where: { kind: 'pins', pins: 'vise', anchor: null },
      count: null,
      frame,
      provenance:
        registration === null
          ? {}
          : {
              fixedJawFaceX: `measured:${registration.measuredAt}`,
              // The origin is measured; where the bar starts along it is the legacy setting.
              jawStartY: 'typed',
            },
    });
  }

  if (seat !== null) sources.push('the bracket seat');

  const surface: Surface =
    wasteboard === null
      ? {
          // Open question E: the bare bed is a surface kind with no size and no scars.
          kind: 'bare-bed',
          material: null,
          length: null,
          width: null,
          thickness: null,
          position: null,
          provenance: {},
          scars: [],
          lastResurfacedAt: null,
        }
      : {
          kind: 'wasteboard',
          // The #417 record never recorded these; they stay unknown rather than invented.
          material: null,
          length: null,
          width: null,
          thickness: wasteboard.thickness,
          position: null,
          provenance: {
            thickness:
              wasteboard.thicknessSource === 'measured'
                ? wasteboard.measuredAt !== null
                  ? `measured:${wasteboard.measuredAt}`
                  : 'measured'
                : 'typed',
          },
          // The same scar records, in the same machine-XY frame, copied so the old key and the
          // new profile never share a mutable object.
          scars: wasteboard.scars.map((s) => ({ ...s })),
          lastResurfacedAt: wasteboard.lastResurfacedAt,
        };

  const profile: BedProfile = {
    id: profileId,
    name: `Current bed (migrated ${day})`,
    createdAt: now,
    basedOn: null,
    surface,
    datums: {
      // No migration writes a surface or jaw-top reading: #475's surface spread is session state
      // and the four migrations name only the bracket seat.
      surfaceTopZ: null,
      viseJawTopZ: null,
      bracketSeatZ: seat,
      rotaryAxis: null,
    },
    placements,
    // No source records a preferred mounting; an empty list is the honest answer, not a guess.
    preferredMounting: [],
    consumables: null,
    history: [{ at: now, what: `created by migrating ${sources.join(', ')}` }],
  };

  return {
    accessories,
    bedProfiles: [profile],
    activeBedProfileId: profileId,
  };
}

/**
 * The bracket's seat, only when the shop default says it was MEASURED. `bracket.seatMachineZ` is
 * the one measured-only key in `defaults.rs`; a chosen or unset value is not a datum, and a datum
 * with no date is not written. `by: "wired-probe"` is the instrument the key's own definition names
 * ("one probe touch beside the bracket").
 */
function measuredBracketSeat(defaults: ShopDefaults | null): Datum | null {
  const d = defaults?.['bracket.seatMachineZ'];
  if (d === undefined || d.source !== 'measured') return null;
  if (typeof d.value !== 'number' || !Number.isFinite(d.value) || d.setAt === null) return null;
  return { value: d.value, measuredAt: d.setAt, by: 'wired-probe', at: null };
}

function dayOf(now: string): string {
  const day = now.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : 'undated';
}

/** The measurements are already 0.001 mm readings (registration rounds the same way). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── #511: the Bed block's actions ───────────────────────────────────────────────────────────────
//
// "I changed the bed" and "Measure…" both save a NEW dated profile and never move the machine; the
// pure shapes live here (beside the migration) so the Bed block and, later, the wizard (S3) share
// them, and so they can be pinned without a store.

/** The datums a profile describes, by their `BedProfile['datums']` key. */
export const BED_DATUM_KEYS = ['surfaceTopZ', 'viseJawTopZ', 'bracketSeatZ', 'rotaryAxis'] as const;
export type BedDatumKey = (typeof BED_DATUM_KEYS)[number];

/** A human sentence for each datum, for the "to measure" list. */
export const BED_DATUM_WORDS: Record<BedDatumKey, string> = {
  surfaceTopZ: 'surface top',
  viseJawTopZ: 'jaw top',
  bracketSeatZ: 'bracket seat',
  rotaryAxis: 'rotary axis',
};

/**
 * "I changed the bed" (#511, `bed-profiles.md` §5): the ACTIVE profile copied into a NEW dated
 * profile, every datum cleared (whatever changed, nothing measured on the old bed still describes
 * the new one) and the surface's scars dropped with the surface's datum. The old profile stays in
 * `bedProfiles` untouched, with its scars and datums.
 *
 * Returns the new profile and the list of what was cleared, so the card can say "to measure" by
 * name. `nextId` is the caller's new profile id (a fresh `newId('bp')`).
 */
export function changedBedProfile(
  active: BedProfile,
  nextId: string,
  now: string,
): { profile: BedProfile; cleared: string[] } {
  const cleared: string[] = [];
  for (const key of BED_DATUM_KEYS) {
    if (active.datums[key] !== null) cleared.push(BED_DATUM_WORDS[key]);
  }
  if (active.surface.scars.length > 0) cleared.push('surface scars');

  const day = dayOf(now);
  const profile: BedProfile = {
    ...active,
    id: nextId,
    name: `Bed changed ${day}`,
    createdAt: now,
    basedOn: active.id,
    datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null },
    // Scars belong to the surface instance; a changed bed's surface is a new instance.
    surface: { ...active.surface, scars: [] },
    // Placements stay (the fixtures are still on the bed), their frames re-measured in the wizard.
    placements: active.placements.map((p) => ({ ...p })),
    preferredMounting: active.preferredMounting.map((m) => ({ ...m })),
    history: [...active.history, { at: now, what: `created from "${active.name}" after the bed changed` }],
  };
  return { profile, cleared };
}

/** "Switch" (#511): never moves the machine — it only re-names which saved profile is active. */
export function switchActiveProfile(
  machine: MachineRecord,
  activeBedProfileId: string,
  now: string,
): MachineRecord {
  return { ...machine, activeBedProfileId, updatedAt: now };
}
