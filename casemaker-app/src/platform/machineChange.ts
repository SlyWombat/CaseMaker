/**
 * #693 — the change-the-machine wizard's rules, as pure functions.
 *
 * One wizard for every physical change (§3.8 of `docs/design/first-job-flow.md`). This slice is the
 * FIXTURE change the design's station 3a draws — the vise off the pins and the 4th-axis module on
 * them, and every pair around it — because that is the one change that rewrites the active bed
 * profile. The same five steps are the shape a cutter, a probe or a wasteboard change will take; what
 * they add is their own step 3/4 words, not their own wizard.
 *
 * WHAT THE WIZARD READS, NEVER ASKS. The mount on the machine now is the active bed profile's pins
 * placement (principle 8: the machine's state is a fact the product reads). The change is written as
 * a NEW dated profile, exactly as `changedBedProfile` (#511) does for "I changed the bed": the old
 * profile stays, with its datums, and the new one becomes active. Datums that depend on the fixture
 * that moved are cleared; a datum for the incoming fixture is either carried from the newest profile
 * that measured one (the "shipped value") or left unmeasured for the registration to fill.
 *
 * THE ACCESSORIES MOVE WITH THE FIXTURE. The vise and the 4th-axis module are the house's (#597), and
 * `whereabouts` is the record of where each one is: taking the vise off the pins checks it back to
 * the box ("on its shelf" is the operator's word for the same fact); fitting the rotary checks it out
 * to this machine. Those are accessory writes, separate from the machine PUT, and the wizard makes
 * them only when the change is confirmed — never on an open or a close.
 *
 * WHY THIS MODULE IS PURE. The store write, the licence to drive a machine and the console are the
 * UI's and `machineChangeRun.ts`'s; everything here is a function of the location's records, and the
 * whole outcome is pinned by `machineChange.spec.ts` without a DOM or a socket.
 */

import type { BedProfile, FixtureRecord, MachineRecord } from './locationClient';

/** What is on the machine's locating pins — or nothing. The wizard's own subject. */
export type MachineMountKind = 'vise' | 'rotary' | 'bed';

/** The datum a fixture carries: the vise's jaw top, the rotary module's axis line. */
export type MountDatumKey = 'viseJawTopZ' | 'rotaryAxis';

type Datum = NonNullable<BedProfile['datums']['viseJawTopZ']>;

/** The mount as the screen names it: the mockup's "Vise on the pins", "Rotary on the pins". */
export const MACHINE_MOUNT_WORDS: Record<MachineMountKind, string> = {
  vise: 'Vise on the pins',
  rotary: 'Rotary on the pins',
  bed: 'Nothing on the pins',
};

/** The same word in a sentence, where the mockup writes "vise → rotary". */
const MOUNT_WORDS_LOWER: Record<MachineMountKind, string> = {
  vise: 'vise',
  rotary: 'rotary',
  bed: 'the bed',
};

/** The accessory `kind` a pins mount needs (`FixtureRecord.kind` is open; these are the two users). */
const ACCESSORY_KIND: Record<'vise' | 'rotary', string> = {
  vise: 'vise',
  rotary: 'rotary-module',
};

/** The active bed profile, or null when this machine has none described yet. */
export function activeProfileOf(machine: MachineRecord | null): BedProfile | null {
  if (machine === null || machine.bedProfiles === undefined || machine.activeBedProfileId === undefined) {
    return null;
  }
  return machine.bedProfiles.find((p) => p.id === machine.activeBedProfileId) ?? null;
}

/**
 * What is on the pins NOW, read off the active profile's placement. A pins placement names the
 * fixture whose pins it is (`vise` or `rotary`); no pins placement is the bare bed.
 */
export function activeMountOf(machine: MachineRecord | null): MachineMountKind {
  const profile = activeProfileOf(machine);
  if (profile === null) return 'bed';
  if (profile.placements.some((p) => p.where.kind === 'pins' && p.where.pins === 'vise')) return 'vise';
  if (profile.placements.some((p) => p.where.kind === 'pins' && p.where.pins === 'rotary')) return 'rotary';
  return 'bed';
}

/** The fixture records this location holds for a pins mount; null for the bare bed. */
export function accessoryFor(accessories: readonly FixtureRecord[], kind: MachineMountKind): FixtureRecord | null {
  if (kind === 'bed') return null;
  return accessories.find((a) => a.kind === ACCESSORY_KIND[kind]) ?? null;
}

/**
 * The mounts step 1 can offer: the bare bed always, and each fixture the house OWNS. The current
 * mount is left out — a change to what is already there is not a change — and a house that owns no
 * rotary is not offered one (there is nothing to fit).
 */
export function targetMountsFor(
  machine: MachineRecord | null,
  accessories: readonly FixtureRecord[],
): MachineMountKind[] {
  const current = activeMountOf(machine);
  const out: MachineMountKind[] = [];
  for (const kind of ['vise', 'rotary', 'bed'] as const) {
    if (kind === current) continue;
    if (kind !== 'bed' && accessoryFor(accessories, kind) === null) continue;
    out.push(kind);
  }
  return out;
}

/** The wizard's title line: the mockup's "Vise off · rotary on" / "Vise off · bracket on". */
export function changeHeadline(from: MachineMountKind, to: MachineMountKind, bracket: 1 | 2 | null = null): string {
  // #718 — a bracket-only change keeps the pins as they are; the change is the bracket.
  if (from === 'bed' && to === 'bed') return bracket === null ? 'Bed unchanged' : `Bracket at anchor ${bracket} on`;
  const on =
    bracket !== null && to === 'bed' ? `bracket at anchor ${bracket} on` : to === 'vise' ? 'vise on' : to === 'rotary' ? 'rotary on' : 'bed clear';
  if (from === 'bed') return MACHINE_MOUNT_WORDS[to].replace(' on the pins', ' on');
  const off = from === 'vise' ? 'Vise off' : from === 'rotary' ? 'Rotary off' : 'Bed clear';
  return `${off} · ${on}`;
}

/** "vise → rotary", the words step 5 writes into the record line. */
export function changeRecordWords(from: MachineMountKind, to: MachineMountKind, bracket: 1 | 2 | null = null): string {
  if (from === 'bed' && to === 'bed') return bracket === null ? 'the bed unchanged' : `bracket at anchor ${bracket} on`;
  return `${MOUNT_WORDS_LOWER[from]} → ${MOUNT_WORDS_LOWER[to]}`;
}

/** One physical step's words: the mockup's three-item lists, one action per line. */
export interface StepWords {
  /** "Take off the vise" / "Fit the rotary". */
  title: string;
  /** One line per physical action. */
  items: string[];
}

/**
 * #706/#717 — what the change does with the MDF wasteboard. Makera's vise, 4th-axis and vacuum-bed
 * pages each say **"Remove the MDF wasteboard"** before the fixture goes on, so every change TO one
 * of them takes the board off and leaves it off; the one change that puts it back is a change to a
 * bed job (nothing on the pins). The 4th-axis cable is **never plugged in with the machine
 * powered** — power is the machine's own switch throughout (#479).
 */
export interface MountStepOptions {
  /** 'off' when this change removes a wasteboard, 'back' when it restores one, null when it stays. */
  wasteboard?: 'off' | 'back' | null;
  /** #718 — the anchor a bracket is being FITTED at (the profile carries none yet), or null. */
  bracket?: 1 | 2 | null;
  /**
   * #718 — the machine was switched OFF for this change, so its fit ends by switching it on
   * (`changePowersOff`). False for a bracket-only fit — nothing on the pins already, so the machine
   * never went off. Absent reads as true: every other fit is a power-off one.
   */
  switchBackOn?: boolean;
}

/**
 * #717 — does this change take the machine's power off? Makera's low-profile-vise and 4th-axis
 * pages both begin with "Home the machine … then power it off" (and the cable is never plugged in
 * live), so ANY change that touches one of them is made with the machine off; the wizard's step 2
 * carries the switch, and the fit's last line switches it back on. Power is the machine's own
 * switch, never this app (#479).
 */
export function changePowersOff(from: MachineMountKind, to: MachineMountKind): boolean {
  return from !== 'bed' || to !== 'bed';
}

/** The outgoing fixture's steps. Null when nothing is on the pins. */
export function takeOffSteps(from: MachineMountKind, opts: MountStepOptions = {}): StepWords | null {
  switch (from) {
    case 'vise': {
      // #717 — Makera's install, reversed (the removal itself is inferred: Makera publishes none):
      // the fixed jaw comes off to reach the six screws, then the vise lifts off the two pins. The
      // machine is already switched off in step 2, at its own switch (#479).
      const items = [
        'the left fixed jaw off',
        'the six M5 × 20 screws',
        'lift it straight up off the two pins',
        'on its shelf',
      ];
      // A record from before #717 can still show the vise over a wasteboard; if this change takes
      // the board off, it comes after the vise.
      if (opts.wasteboard === 'off') items.push('the wasteboard’s screws', 'the wasteboard on its shelf');
      return { title: 'Take off the vise', items };
    }
    case 'rotary':
      return {
        title: 'Take off the rotary',
        items: [
          // #706/#717 — the cable is never unplugged live; the switch itself is step 2's line
          // (the machine's own switch, never this app's — #479).
          'the 4th-axis cable, rear left',
          'the three M5 × 10 screws',
          'lift it straight up',
          'on its shelf',
        ],
      };
    case 'bed':
      // #706 — nothing is on the pins, but a wasteboard can still be on the bed and must come off
      // before the rotary mounts. Without one, there is no take-off step at all.
      return opts.wasteboard === 'off'
        ? { title: 'Take off the wasteboard', items: ['the wasteboard’s screws', 'the wasteboard on its shelf'] }
        : null;
  }
}

/** The incoming fixture's steps. Null when the bed is left clear. */
export function fitSteps(to: MachineMountKind, opts: MountStepOptions = {}): StepWords | null {
  switch (to) {
    case 'vise': {
      // #717 — Makera's Low-Profile Vise page, in its own order: the machine switched off at its
      // own switch (step 2's line), the two 4 × 11 mm locating pins, the vise on them, the fixed jaw
      // off to reach the screws, six M5 × 20, the jaw back with its locating key seated, power on.
      // The wasteboard is NOT put back under the vise: Makera's first step is to remove it.
      return {
        title: 'Fit the vise',
        items: [
          'the two 4 × 11 mm locating pins',
          'the vise onto the pins',
          'the left fixed jaw off',
          'the six M5 × 20 screws',
          'the fixed jaw back on, its locating key seated',
          'switch the machine on',
        ],
      };
    }
    case 'rotary':
      return {
        title: 'Fit the rotary',
        items: [
          // #706 — Makera's order: the cable is last, never plugged in live, and the machine is
          // switched on again before the wait (the switch itself is step 2's line).
          'the 4th-axis cable is never plugged in live',
          'onto the two pins',
          'the three M5 × 10 screws',
          'the 4th-axis cable, rear left',
          'switch the machine on',
          'wait for it to answer',
          'chuck key in the tray',
        ],
      };
    case 'bed': {
      // #717 — the ONE change that puts the MDF wasteboard back on: a bed job needs the surface
      // under it. Makera publishes no removal steps, so the screws are the figure's four
      // (inferred); the board is the newest saved wasteboard profile's (surfaceChangeFor).
      // #718 — the bracket is fitted onto that surface (Makera's pictures keep the MDF under it):
      // the QuickStart's two 4 mm dowels and three M5×20 screws (longer for the thick bracket),
      // with the clamps in the tray — they go on the plate, after the stock.
      const items: string[] = [];
      if (opts.wasteboard === 'back') items.push('the wasteboard back on', 'its screws');
      if (opts.bracket !== undefined && opts.bracket !== null) {
        items.push(
          `the thin L-bracket into anchor ${opts.bracket}'s corner`,
          'its two 4 mm dowels',
          'its three M5 × 20 screws',
          'two top clamps in the tray',
        );
      }
      if (items.length === 0) return null;
      // #718 — only a change that POWERED OFF ends by switching the machine on: a bracket fitted
      // while nothing moved on the pins leaves a machine that was never off.
      if (opts.switchBackOn !== false) items.push('switch the machine on');
      return { title: opts.bracket !== undefined && opts.bracket !== null ? 'Fit the bracket' : 'Put the wasteboard back on', items };
    }
  }
}

/** What step 4's datum row is about, for a fixture that carries one. */
export interface MountDatumDescriptor {
  key: MountDatumKey;
  /** The mockup's "axis datum" / the vise's "jaw datum". */
  word: string;
}

export function datumDescriptorFor(to: MachineMountKind): MountDatumDescriptor | null {
  if (to === 'vise') return { key: 'viseJawTopZ', word: 'jaw datum' };
  if (to === 'rotary') return { key: 'rotaryAxis', word: 'axis datum' };
  return null;
}

/**
 * The newest datum this machine has measured for `key`, across EVERY saved profile — the value the
 * fixture "ships with" here. A profile that had the vise on it measured its jaw top; a later rotary
 * profile does not erase that measurement, and re-fitting the vise on the same pins is exactly the
 * case where the operator may use it again instead of probing.
 */
export function shippedDatumFor(machine: MachineRecord | null, key: MountDatumKey): Datum | null {
  if (machine === null || machine.bedProfiles === undefined) return null;
  let best: Datum | null = null;
  for (const profile of machine.bedProfiles) {
    const datum = profile.datums[key];
    if (datum === null) continue;
    if (best === null || datum.measuredAt > best.measuredAt) best = datum;
  }
  return best;
}

/** The profile whose reading `shippedDatumFor` found — named in the Technical fold. */
export function shippedDatumProfileName(machine: MachineRecord | null, key: MountDatumKey): string | null {
  if (machine === null || machine.bedProfiles === undefined) return null;
  let best: { measuredAt: string; name: string } | null = null;
  for (const profile of machine.bedProfiles) {
    const datum = profile.datums[key];
    if (datum === null) continue;
    if (best === null || datum.measuredAt > best.measuredAt) best = { measuredAt: datum.measuredAt, name: profile.name };
  }
  return best?.name ?? null;
}

/** The surface of the bed, in the mockup's step-5 words ("wasteboard under"). */
export function surfaceWords(surface: BedProfile['surface']): string {
  switch (surface.kind) {
    case 'bare-bed':
      return 'bare bed';
    case 'wasteboard':
      // The mockup's own words. What the board is made of is the Bed block's line, not this one.
      return 'wasteboard under';
    case 'fixture-plate':
      return 'fixture plate';
    case 'vacuum-bed':
      return 'vacuum bed';
  }
}

/** The bed with nothing on it — the schema's bare-bed row, every measurement empty (#706). */
export function bareBedSurface(): BedProfile['surface'] {
  return {
    kind: 'bare-bed',
    material: null,
    length: null,
    width: null,
    thickness: null,
    position: null,
    provenance: {},
    scars: [],
    lastResurfacedAt: null,
  };
}

/** What a mount change leaves on the bed, and the words step 5 uses for it (#706). */
export interface SurfaceChange {
  surface: BedProfile['surface'];
  /** "wasteboard off" / "wasteboard under" — the words the change leaves on the bed. */
  words: string;
  /** What happened to the wasteboard, or null when it stayed. */
  wasteboard: 'off' | 'back' | null;
}

/** The newest saved wasteboard surface other than the active profile's, mm-accurate and cloned. */
function newestSavedWasteboard(machine: MachineRecord, activeId: string | undefined): BedProfile['surface'] | null {
  const profiles = machine.bedProfiles ?? [];
  const board = [...profiles]
    .filter((p) => p.id !== activeId && p.surface.kind === 'wasteboard')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
  return board === undefined ? null : (JSON.parse(JSON.stringify(board.surface)) as BedProfile['surface']);
}

/**
 * #717 — the surface a change to `to` leaves, as Makera installs each accessory
 * (`docs/design/z1-accessory-install.md`, "What sits on what"): the low-profile vise and the 4th
 * axis each begin with **"Remove the MDF wasteboard"**, so a change TO either leaves the BARE bed
 * and says "wasteboard off" — and neither ever puts the board back. The one change that restores
 * it is a change to a bed job (`bed`: nothing on the pins), which puts the newest saved wasteboard
 * profile back on ("wasteboard back on"); that surface's material, size and scars come with it.
 * Every other surface (a user-made fixture plate, a vacuum bed) is kept exactly as it was.
 */
export function surfaceChangeFor(machine: MachineRecord, to: MachineMountKind): SurfaceChange {
  const active = activeProfileOf(machine);
  const surface = active?.surface ?? null;
  if (to === 'bed' && surface !== null && surface.kind === 'bare-bed') {
    const restored = newestSavedWasteboard(machine, active?.id);
    if (restored !== null) return { surface: restored, words: surfaceWords(restored), wasteboard: 'back' };
  }
  if (to !== 'bed' && surface !== null && surface.kind === 'wasteboard') {
    return { surface: bareBedSurface(), words: 'wasteboard off', wasteboard: 'off' };
  }
  const kept = surface === null ? bareBedSurface() : (JSON.parse(JSON.stringify(surface)) as BedProfile['surface']);
  return { surface: kept, words: surfaceWords(kept), wasteboard: null };
}

// ── The outcome ─────────────────────────────────────────────────────────────────────────────────

export interface MountChangeArgs {
  machine: MachineRecord;
  /** The mount the operator is fitting. */
  to: MachineMountKind;
  /** The incoming fixture's datum, or null to leave it unmeasured. */
  datum: Datum | null;
  /** The new profile's id (the caller's `newId('bp')`, kept across a stale retry). */
  profileId: string;
  /** ISO timestamp, one for the profile, the history line and the accessory moves. */
  at: string;
  /** The job that asked, named in the history line, or null. */
  jobName?: string | null;
  /** Every accessory the location holds — the outgoing and incoming fixtures are found here. */
  accessories: readonly FixtureRecord[];
  /**
   * #718 — fit the thin L-bracket at this anchor. The step appears only when the active profile
   * carries no bracket at an anchor; the plan writes the placement and the fixture's record.
   */
  bracket?: { anchor: 1 | 2 } | null;
}

export interface MountChangePlan {
  from: MachineMountKind;
  to: MachineMountKind;
  /** "Vise off · rotary on". */
  headline: string;
  /** #718 — the anchor the bracket was fitted at, or null when this change fitted none. */
  bracket: 1 | 2 | null;
  /** The new profile, not yet saved. */
  profile: BedProfile;
  /** What the change did with the MDF wasteboard (#706): removed it, restored it, or left it. */
  wasteboard: SurfaceChange['wasteboard'];
  /** The machine record carrying it as active. */
  machine: MachineRecord;
  /** The accessory records to write after the machine PUT: the outgoing one back to the box, the incoming one checked out. */
  accessoryWrites: FixtureRecord[];
}

export type MountChangeOutcome = MountChangePlan | { error: string };

/** The Makera kit's thin L-bracket (#718): its record is created on the first fit if the house has none. */
const BRACKET_FIXTURE_ID = 'fx-bracket-thin';
const BRACKET_PRODUCT = 'makera-z1-l-bracket';

/** The bracket's fixture record as the fit leaves it: checked out to this machine, at this anchor. */
function bracketFixture(args: MountChangeArgs, anchor: 1 | 2): FixtureRecord {
  const existing = args.accessories.find((a) => a.kind === 'bracket');
  if (existing !== undefined) {
    return {
      ...existing,
      whereabouts: { kind: 'machine', machineId: args.machine.id, since: args.at },
      history: [...existing.history, { at: args.at, what: `fitted at anchor ${anchor}` }],
    };
  }
  return {
    id: BRACKET_FIXTURE_ID,
    kind: 'bracket',
    product: BRACKET_PRODUCT,
    variant: 'thin',
    constants: {},
    unit: {},
    provenance: {},
    whereabouts: { kind: 'machine', machineId: args.machine.id, since: args.at },
    history: [{ at: args.at, what: `created and fitted at anchor ${anchor}` }],
  };
}

/**
 * The one write the wizard's Confirm makes, as a pure function: the active profile copied into a
 * NEW dated profile with the pins placement replaced, the moved fixture's datum cleared or carried,
 * the mountings that no longer name a placement dropped, and a history line saying what changed and
 * for which job. Nothing is deleted: every earlier profile keeps its datums and its picture.
 *
 * #718 — a change that only FITS the bracket (nothing on the pins already, and the bed carries no
 * bracket at an anchor) is the same write with `to === from === 'bed'`: no pins move, and the new
 * profile gains the bracket's placement and its fixture record.
 */
export function planMountChange(args: MountChangeArgs): MountChangeOutcome {
  const { machine, to, at } = args;
  const active = activeProfileOf(machine);
  if (active === null) {
    return { error: 'This machine has no bed described yet — set the bed up in Manage first.' };
  }
  const from = activeMountOf(machine);
  const bracketAnchor = args.bracket?.anchor ?? null;
  const bracketOnly = bracketAnchor !== null && to === 'bed' && from === 'bed';
  if (to === from && !bracketOnly) {
    return { error: `${MACHINE_MOUNT_WORDS[to]} is already on the machine.` };
  }
  const incoming = accessoryFor(args.accessories, to);
  if (to !== 'bed' && incoming === null) {
    const what = to === 'vise' ? 'a vise' : 'a rotary module';
    return { error: `The house does not own ${what}, so there is nothing to fit.` };
  }

  // The pins placement is replaced; everything else on the bed (a bracket at an anchor, clamps)
  // stays exactly where it was.
  const placements: BedProfile['placements'] = active.placements
    .filter((p) => p.where.kind !== 'pins')
    .map((p) => ({ ...p, where: { ...p.where }, frame: p.frame === null ? null : { ...p.frame }, provenance: { ...p.provenance } }));
  if (incoming !== null && to !== 'bed') {
    // A re-fit is a new seating: its frame (the fixed jaw's measured face, or the axis' line) is not
    // carried, because the registration that measures it has not run against this seating yet. The
    // datum the operator chose is the separate value step 4 lets them carry.
    placements.push({
      id: `pl-${to}`,
      fixture: incoming.id,
      where: { kind: 'pins', pins: to, anchor: null },
      count: null,
      frame: null,
      provenance: {},
    });
  }

  // The datums the moved fixtures carried go with them; the surface's and the bracket's stay, because
  // neither moved.
  const datums: BedProfile['datums'] = { ...active.datums };
  if (from === 'vise' || to === 'vise') datums.viseJawTopZ = to === 'vise' ? args.datum : null;
  if (from === 'rotary' || to === 'rotary') datums.rotaryAxis = to === 'rotary' ? args.datum : null;

  // #718 — the bracket, only when the bed carries none: the step is offered exactly then.
  const bracketFitted =
    bracketAnchor !== null && to === 'bed' && !placements.some((p) => p.where.kind === 'anchor');
  let bracketRecord: FixtureRecord | null = null;
  if (bracketFitted) {
    bracketRecord = bracketFixture(args, bracketAnchor);
    placements.push({
      id: 'pl-bracket',
      fixture: bracketRecord.id,
      where: { kind: 'anchor', anchor: bracketAnchor, pins: null },
      count: null,
      frame: null,
      provenance: {},
    });
  }

  const placementIds = new Set(placements.map((p) => p.id));
  const preferredMounting = active.preferredMounting
    .filter((m) => m.mount.placement === null || placementIds.has(m.mount.placement))
    .map((m) => ({ ...m, mount: { ...m.mount } }));

  const headline = changeHeadline(from, to, bracketFitted ? bracketAnchor : null);
  const day = at.slice(0, 10);
  const changeWords = bracketOnly
    ? 'nothing on the pins'
    : from === 'bed'
      ? `${to} on`
      : to === 'bed'
        ? `${from} off`
        : `${from} off, ${to} on`;
  const bracketWords = bracketFitted ? `, bracket at anchor ${bracketAnchor}` : '';
  // #706/#717 — the wasteboard's move is part of the change the record keeps: the vise and the
  // rotary mount on the bare bed, and only a change to a bed job puts the board back on.
  const surfaceChange = surfaceChangeFor(machine, to);
  const wasteboardWords =
    surfaceChange.wasteboard === 'off'
      ? ', wasteboard off'
      : surfaceChange.wasteboard === 'back'
        ? ', wasteboard back on'
        : '';
  const historyWhat =
    `created from "${active.name}": ${changeWords}${wasteboardWords}${bracketWords}` +
    (args.jobName ? `, for ${args.jobName}` : '');

  const profile: BedProfile = {
    id: args.profileId,
    name: /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${headline} — ${day}` : headline,
    createdAt: at,
    basedOn: active.id,
    surface: surfaceChange.surface,
    datums,
    placements,
    preferredMounting,
    consumables: active.consumables === null ? null : JSON.parse(JSON.stringify(active.consumables)),
    history: [...active.history, { at, what: historyWhat }],
  };

  const accessoryWrites: FixtureRecord[] = [];
  if (bracketRecord !== null) accessoryWrites.push(bracketRecord);
  const outgoing = from === 'bed' ? null : accessoryFor(args.accessories, from);
  if (outgoing !== null) {
    accessoryWrites.push({
      ...outgoing,
      whereabouts: { kind: 'box' },
      history: [...outgoing.history, { at, what: 'taken off the pins and put on its shelf' }],
    });
  }
  if (incoming !== null && to !== 'bed') {
    accessoryWrites.push({
      ...incoming,
      whereabouts: { kind: 'machine', machineId: machine.id, since: at },
      history: [...incoming.history, { at, what: from === 'bed' ? 'fitted on the pins' : `fitted on the pins (${from} off)` }],
    });
  }

  return {
    from,
    to,
    headline,
    bracket: bracketFitted ? bracketAnchor : null,
    profile,
    wasteboard: surfaceChange.wasteboard,
    machine: {
      ...machine,
      bedProfiles: [...(machine.bedProfiles ?? []), profile],
      activeBedProfileId: profile.id,
      updatedAt: at,
    },
    accessoryWrites,
  };
}

// ── The frozen job's mount ──────────────────────────────────────────────────────────────────────

/**
 * Whether a profile can hold stock the way a job's mount names it. The job vocabulary is
 * `vise | bracket | tape`; a rotary job is a later slice, and a mount this build does not know is
 * not called a disagreement (an unknown word is not evidence of a broken hold).
 */
export function profileHolds(profile: BedProfile, mountKind: string | null | undefined): boolean {
  switch (mountKind) {
    case 'vise':
      return profile.placements.some((p) => p.where.kind === 'pins' && p.where.pins === 'vise');
    case 'rotary':
      return profile.placements.some((p) => p.where.kind === 'pins' && p.where.pins === 'rotary');
    case 'bracket':
      return profile.placements.some((p) => p.where.kind === 'anchor');
    case 'tape':
    case 'bed':
      return true;
    default:
      return true;
  }
}

/** The sentence step 5 shows when a frozen job's mount is no longer on the machine. */
export function refreezeSentence(jobName: string | null, mountKind: string | null | undefined): string {
  const job = jobName === null ? 'This job' : `“${jobName}”`;
  const mount = mountKind === 'vise' ? 'vise' : mountKind === 'bracket' ? 'bracket and clamps' : mountKind === 'rotary' ? 'rotary' : 'mount';
  return `${job} is frozen for the ${mount}, and the ${mount} is no longer on the machine — Generate it again before cutting.`;
}
