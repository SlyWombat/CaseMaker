/**
 * #512 — the first-run bed wizard's DRAFT and its pure rules (`bed-profiles.md` §3, S0 → S6).
 *
 * One picture of what the operator has answered so far, and one function per step that writes the
 * field the design names (S1 → `basedOn`, S2 → `surface`, S3 → `placements`, S4 →
 * `preferredMounting`, S5 → `consumables`). S6 finalises it into a `BedProfile` and the fixture
 * records the placements need.
 *
 * NO MACHINE MOVES ARE IN THIS FILE, OR IN THIS SLICE. The design's measurement rows (a probe
 * touch at S2/S3) are not wired here: every datum is written `null`, every step is skippable, and
 * the wizard asks the operator to measure later from the Bed block. That is the manager's rule for
 * this work — the physical steps need the bench, and a UI that offered a button which moved the
 * machine without that bench run would be the wrong first version. `unmeasured` is a real answer,
 * not a blocker (design rule: a datum is never typed; every gate that needs one refuses by name).
 *
 * OPEN QUESTION A — DECIDED, AND ALREADY IN THE SCHEMA. The vise and the 4th-axis module share the
 * two locating pins and are mutually exclusive; `locationClient` refuses a profile that places
 * both, and so does the service. The wizard does not hide the second choice: choosing it while the
 * first is on the bed states the conflict and offers the one action that resolves it — remove the
 * other fixture (`resolveConflict`). Inform, don't refuse (#512's own rule).
 *
 * The draft is resumable: `draftToJson`/`draftFromJson` are its stored form, and the UI keeps it
 * per machine, so a closed window is not lost work.
 */

import { BedProfileSchema, type BedProfile, type FixtureRecord } from './locationClient';
import {
  bedTemplateById,
  fixtureRecordFor,
  templateFixtureFor,
  type AddableFixture,
  type BedTemplate,
  type MountManner,
  type TemplateFixture,
  type TemplatePlacement,
} from './bedTemplates';
import { newId } from '@/utils/id';

/** One saved placement, as the profile schema shapes it. */
type BedPlacement = BedProfile['placements'][number];

/** One fixture the operator has put on the bed in the draft, before it has a saved record. */
export interface DraftPlacement {
  /** Local to the draft; a preferred mounting names it. */
  key: string;
  fixture: TemplateFixture;
  where: TemplatePlacement['where'];
  count: number | null;
}

/** One preferred mounting row; `placementKey` null means on the surface (tape/vacuum). */
export interface DraftMounting {
  stock: string;
  placementKey: string | null;
  manner: MountManner;
}

export interface BedWizardDraft {
  machineId: string;
  /** S0…S6, zero-based. */
  step: number;
  /** The shipped template S1 chose, or `default:empty`, or null before S1 is answered. */
  templateId: string | null;
  name: string;
  surface: BedProfile['surface'];
  placements: DraftPlacement[];
  mountings: DraftMounting[];
  consumables: BedProfile['consumables'];
  /** Steps the operator skipped. S0 is a read, not an answer; S6 is the save. */
  skipped: number[];
}

export const BED_WIZARD_STEPS = [
  'Your machine',
  'Start from',
  'The surface',
  'What is on the bed',
  'How you hold stock',
  'Consumables',
  'Review and save',
] as const;

export const BED_WIZARD_FIRST_RUN_KEY = 'casemaker.bedWizard.v1';

export function bedDraftStorageKey(machineId: string): string {
  return `${BED_WIZARD_FIRST_RUN_KEY}:${machineId}`;
}

/** A new draft: S0, nothing answered, every datum null by construction (there are no datums yet). */
export function bedWizardDraft(machineId: string): BedWizardDraft {
  return {
    machineId,
    step: 0,
    templateId: null,
    name: '',
    surface: {
      kind: 'bare-bed',
      material: null,
      length: null,
      width: null,
      thickness: null,
      position: null,
      provenance: {},
      scars: [],
      lastResurfacedAt: null,
    },
    placements: [],
    mountings: [],
    consumables: null,
    skipped: [],
  };
}

/** S1 — start from a shipped bed (or the empty one): every later step edits these answers. */
export function applyTemplate(draft: BedWizardDraft, template: BedTemplate): BedWizardDraft {
  return {
    ...draft,
    templateId: template.id,
    name: template.name,
    surface: structuredClone(template.surface),
    placements: template.placements.map((p) => ({
      key: p.key,
      fixture: structuredClone(p.fixture),
      where: { ...p.where },
      count: p.count,
    })),
    mountings: template.mountings.map((m) => ({ stock: m.stock, placementKey: m.placementKey, manner: m.manner })),
    consumables: template.consumables === null ? null : structuredClone(template.consumables),
    skipped: draft.skipped.filter((s) => s !== 1),
  };
}

/** S2 — the surface the stock or fixtures stand on. */
export function answerSurface(draft: BedWizardDraft, surface: BedProfile['surface']): BedWizardDraft {
  return { ...draft, surface: structuredClone(surface) };
}

/**
 * S3 — what is on the bed. A mounting that named a placement which is no longer on the bed is
 * DROPPED rather than silently repointed: a jaws row with no vise would be a claim the bed cannot
 * keep, and the row re-defaults when the fixture is placed again.
 */
export function answerPlacements(draft: BedWizardDraft, placements: readonly DraftPlacement[]): BedWizardDraft {
  const keys = new Set(placements.map((p) => p.key));
  return {
    ...draft,
    placements: placements.map((p) => ({ ...p, fixture: structuredClone(p.fixture), where: { ...p.where } })),
    mountings: draft.mountings.filter((m) => m.placementKey === null || keys.has(m.placementKey)),
  };
}

/** S4 — how this shop prefers to hold each stock class on this bed. */
export function answerMountings(draft: BedWizardDraft, mountings: readonly DraftMounting[]): BedWizardDraft {
  return { ...draft, mountings: mountings.map((m) => ({ ...m })) };
}

/** S5 — tape and boards on hand. `null` is "not stated", which the schema allows. */
export function answerConsumables(draft: BedWizardDraft, consumables: BedProfile['consumables']): BedWizardDraft {
  return { ...draft, consumables: consumables === null ? null : structuredClone(consumables) };
}

/** S6's name field. */
export function answerName(draft: BedWizardDraft, name: string): BedWizardDraft {
  return { ...draft, name };
}

/** Any step — next. The draft keeps every answer made along the way. */
export function goToStep(draft: BedWizardDraft, step: number): BedWizardDraft {
  return { ...draft, step: Math.max(0, Math.min(BED_WIZARD_STEPS.length - 1, Math.trunc(step))) };
}

/**
 * Skip: advance without writing this step's field; recorded so the review can say what was skipped.
 * S0 is a read and S6 is the save, so neither is an answer that can be skipped — only S1…S5 count.
 */
export function skipStep(draft: BedWizardDraft, step: number): BedWizardDraft {
  const answerable = step >= 1 && step <= 5;
  const skipped = !answerable || draft.skipped.includes(step) ? draft.skipped : [...draft.skipped, step];
  return goToStep({ ...draft, skipped }, step + 1);
}

/** The pin-using fixtures, by their `where.pins` label. */
export type PinsOwner = 'vise' | 'rotary';

export interface PlacementConflict {
  code: 'pins-shared' | 'pins-twice';
  /** What is wrong, in the operator's words. */
  sentence: string;
  /** The one action that resolves it. */
  fix: string;
  /** The placements that cannot both stay; removing either resolves the conflict. */
  keys: string[];
}

/** The fixture an Add button makes: its pins/seat, and the count a group of clamps carries. */
export function addablePlacement(kind: AddableFixture, key: string): DraftPlacement {
  const where: TemplatePlacement['where'] =
    kind === 'vise'
      ? { kind: 'pins', pins: 'vise' }
      : kind === 'rotary-module'
        ? { kind: 'pins', pins: 'rotary' }
        : kind === 'bracket-thin' || kind === 'bracket-thick'
          ? { kind: 'anchor', anchor: 1 }
          : { kind: 'free' };
  return {
    key,
    fixture: templateFixtureFor(kind),
    where,
    count: kind === 'top-clamp' ? 2 : null,
  };
}

/** S3's Add: one more fixture on the bed, with a fresh draft key. */
export function addPlacement(draft: BedWizardDraft, kind: AddableFixture): BedWizardDraft {
  return answerPlacements(draft, [...draft.placements, addablePlacement(kind, newId('dp'))]);
}

const PIN_WORDS: Record<PinsOwner, string> = {
  vise: 'the low-profile vise',
  rotary: 'the 4th-axis module',
};

/**
 * Open question A, stated where the operator meets it: the two pin users are exclusive. The
 * conflicting choice is never hidden or silently disabled — the wizard lets it be made and answers
 * with this sentence and fix.
 */
export function placementConflict(placements: readonly DraftPlacement[]): PlacementConflict | null {
  const pinned = placements.filter(
    (p): p is DraftPlacement & { where: { kind: 'pins'; pins: PinsOwner } } => p.where.kind === 'pins',
  );
  const vises = pinned.filter((p) => p.where.pins === 'vise');
  const rotaries = pinned.filter((p) => p.where.pins === 'rotary');
  if (vises.length > 0 && rotaries.length > 0) {
    return {
      code: 'pins-shared',
      sentence: `The low-profile vise and the 4th-axis module both mount on the same two pins: one bed carries one of them at a time.`,
      fix: `Remove ${PIN_WORDS.vise} to fit ${PIN_WORDS.rotary}, or remove ${PIN_WORDS.rotary} to fit ${PIN_WORDS.vise}.`,
      keys: [vises[0]!.key, rotaries[0]!.key],
    };
  }
  if (vises.length > 1) {
    return {
      code: 'pins-twice',
      sentence: 'The bed lists the low-profile vise twice, and the two pins carry one vise.',
      fix: 'Remove the second vise.',
      keys: [vises[0]!.key, vises[1]!.key],
    };
  }
  if (rotaries.length > 1) {
    return {
      code: 'pins-twice',
      sentence: 'The bed lists the 4th-axis module twice, and the two pins carry one module.',
      fix: 'Remove the second module.',
      keys: [rotaries[0]!.key, rotaries[1]!.key],
    };
  }
  return null;
}

/** The fix the conflict names: put the bed back to one pin user by removing one placement. */
export function resolveConflict(draft: BedWizardDraft, removeKey: string): BedWizardDraft {
  return answerPlacements(
    draft,
    draft.placements.filter((p) => p.key !== removeKey),
  );
}

export interface FinalizedBed {
  profile: BedProfile;
  /** Fixture records the placements refer to whose records do not exist yet — write them first. */
  accessories: FixtureRecord[];
}

/** A draft's placement position, in the saved profile's schema shape (both optional keys stated). */
function savedWhere(where: TemplatePlacement['where']): BedPlacement['where'] {
  switch (where.kind) {
    case 'pins':
      return { kind: 'pins', pins: where.pins, anchor: null };
    case 'anchor':
      return { kind: 'anchor', pins: null, anchor: where.anchor };
    case 'free':
      return { kind: 'free', pins: null, anchor: null };
  }
}

export type FinalizeResult = { ok: true; bed: FinalizedBed } | { ok: false; reason: string };

/**
 * S6 — the profile, ready to save and make active. The fixture records are created for any
 * placement whose kind is not already checked out to this machine; an existing matching record is
 * REUSED, so a second profile for the same vise does not mint a second vise.
 *
 * Refused, with the reason: no name, a placement conflict (open question A), or a mounting naming a
 * placement that is not on the bed. The wizard shows the reason; it does not save a profile the
 * schema or the service would refuse.
 */
export function finalizeDraft(
  draft: BedWizardDraft,
  opts: { now: string; id: string; existing: readonly FixtureRecord[] },
): FinalizeResult {
  const name = draft.name.trim();
  if (name.length === 0) return { ok: false, reason: 'give the bed a name before saving it' };
  const conflict = placementConflict(draft.placements);
  if (conflict !== null) return { ok: false, reason: `${conflict.sentence} ${conflict.fix}` };

  const placementIds = new Map<string, string>();
  const placements: BedPlacement[] = [];
  const accessories: FixtureRecord[] = [];
  for (const placement of draft.placements) {
    const existing = opts.existing.find(
      (f) => f.whereabouts.kind === 'machine' && f.whereabouts.machineId === draft.machineId && f.kind === placement.fixture.kind && f.variant === placement.fixture.variant,
    );
    const fixtureId = existing?.id ?? newId('fx');
    if (existing === undefined) accessories.push(fixtureRecordFor(placement.fixture, fixtureId, draft.machineId, opts.now));
    const placementId = newId('pl');
    placementIds.set(placement.key, placementId);
    placements.push({
      id: placementId,
      fixture: fixtureId,
      where: savedWhere(placement.where),
      count: placement.count,
      frame: null,
      provenance: {},
    });
  }

  const preferredMounting: BedProfile['preferredMounting'] = [];
  for (const mounting of draft.mountings) {
    const placementId = mounting.placementKey === null ? null : (placementIds.get(mounting.placementKey) ?? null);
    if (mounting.placementKey !== null && placementId === null) {
      return { ok: false, reason: `the preferred mounting for "${mounting.stock}" names a fixture that is not on the bed` };
    }
    preferredMounting.push({ stock: mounting.stock, mount: { placement: placementId, manner: mounting.manner } });
  }

  const template = bedTemplateById(draft.templateId);
  const raw: BedProfile = {
    id: opts.id,
    name,
    createdAt: opts.now,
    basedOn: draft.templateId,
    surface: structuredClone(draft.surface),
    datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null },
    placements,
    preferredMounting,
    consumables: draft.consumables === null ? null : structuredClone(draft.consumables),
    history: [
      {
        at: opts.now,
        what: template === null ? 'created by the bed wizard' : `created from ${template.name}`,
      },
    ],
  };
  // The profile must be one the location can read back — the same schema `housePutMachine` holds it
  // to. The wizard refuses with the schema's own reason rather than sending a record the service
  // would store and every window would then set aside.
  const checked = BedProfileSchema.safeParse(raw);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const at = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
    return { ok: false, reason: `the bed would not read back — ${at}${issue?.message ?? 'unrecognised shape'}` };
  }
  return { ok: true, bed: { accessories, profile: checked.data } };
}

/** The four provenance words plus "unmeasured", as the review counts them (§1). */
export type ProvenanceWord = 'measured' | 'vendor' | 'default' | 'typed' | 'unmeasured';

export type ProvenanceTally = Record<ProvenanceWord, number>;

function wordOf(provenance: string | undefined, fallback: ProvenanceWord): ProvenanceWord {
  if (provenance === undefined) return fallback;
  const bare = provenance.split(':')[0] ?? '';
  if (bare === 'measured' || bare === 'vendor' || bare === 'default' || bare === 'typed') return bare;
  if (bare === 'unmeasured') return 'unmeasured';
  return 'typed';
}

const SURFACE_FIELDS = ['material', 'length', 'width', 'thickness', 'position'] as const;

/**
 * Every number the profile states, counted by where it came from — S6's provenance line. A datum
 * is `measured` or `unmeasured` and nothing else (the schema refuses a typed datum); a fixture's
 * constants and unit values read their own provenance map; the mountings are the shop's defaults.
 */
export function provenanceTally(profile: BedProfile, fixtures: readonly FixtureRecord[]): ProvenanceTally {
  const tally: ProvenanceTally = { measured: 0, vendor: 0, default: 0, typed: 0, unmeasured: 0 };
  for (const field of SURFACE_FIELDS) {
    const value = profile.surface[field];
    if (value === null) tally.unmeasured += 1;
    else tally[wordOf(profile.surface.provenance[field], 'default')] += 1;
  }
  for (const datum of Object.values(profile.datums)) tally[datum === null ? 'unmeasured' : 'measured'] += 1;
  for (const placement of profile.placements) {
    const fixture = fixtures.find((f) => f.id === placement.fixture);
    if (fixture === undefined) {
      tally.unmeasured += 1;
      continue;
    }
    for (const [key, value] of Object.entries(fixture.constants)) {
      tally[value === null ? 'unmeasured' : wordOf(fixture.provenance[key], 'default')] += 1;
    }
    for (const [key, value] of Object.entries(fixture.unit)) {
      tally[value === null ? 'unmeasured' : wordOf(fixture.provenance[key], 'unmeasured')] += 1;
    }
  }
  for (const _row of profile.preferredMounting) {
    void _row;
    tally.default += 1;
  }
  if (profile.consumables !== null) {
    if (profile.consumables.tape !== null) {
      tally[wordOf(profile.consumables.tape.provenance, 'typed')] += 2;
    }
    tally.typed += profile.consumables.boards.length;
  }
  return tally;
}

/** S6's "to measure" list: what is null in this profile, in words an operator can take to the bench. */
export function unmeasuredList(profile: BedProfile, fixtures: readonly FixtureRecord[]): string[] {
  const out: string[] = [];
  const datumWords: Record<keyof BedProfile['datums'], string> = {
    surfaceTopZ: 'the surface top',
    viseJawTopZ: 'the jaw top',
    bracketSeatZ: 'the bracket seat',
    rotaryAxis: 'the rotary axis',
  };
  for (const key of Object.keys(profile.datums) as Array<keyof BedProfile['datums']>) {
    if (profile.datums[key] === null) out.push(datumWords[key]);
  }
  if (profile.surface.kind !== 'bare-bed') {
    for (const field of ['length', 'width', 'thickness'] as const) {
      if (profile.surface[field] === null) out.push(`the surface ${field}`);
    }
    if (profile.surface.material === null) out.push('the surface material');
    if (profile.surface.position === null) out.push('where the surface sits');
  }
  for (const placement of profile.placements) {
    const fixture = fixtures.find((f) => f.id === placement.fixture);
    if (fixture === undefined) continue;
    for (const [key, value] of Object.entries(fixture.unit)) {
      if (value === null) out.push(`the ${fixture.kind}'s ${key}`);
    }
  }
  return out;
}

/** The draft's stored form. A version marker so an older draft is dropped rather than misread. */
export function draftToJson(draft: BedWizardDraft): string {
  return JSON.stringify({ schemaVersion: 1, draft });
}

/**
 * A draft read back, or null. Loose by design: the DRAFT is our own working state, and the thing
 * that must never be wrong is the saved profile, which `finalizeDraft` + the schema check. A
 * corrupted draft is dropped, so the wizard starts again rather than resuming half a sentence.
 */
export function draftFromJson(text: string): BedWizardDraft | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const holder = parsed as { schemaVersion?: unknown; draft?: unknown };
    if (holder.schemaVersion !== 1) return null;
    const draft = holder.draft as Partial<BedWizardDraft> | undefined;
    if (draft === undefined || typeof draft.machineId !== 'string') return null;
    if (!Number.isInteger(draft.step) || (draft.step as number) < 0 || (draft.step as number) >= BED_WIZARD_STEPS.length) return null;
    if (typeof draft.surface !== 'object' || draft.surface === null) return null;
    if (!Array.isArray(draft.placements) || !Array.isArray(draft.mountings) || !Array.isArray(draft.skipped)) return null;
    return {
      machineId: draft.machineId,
      step: draft.step as number,
      templateId: typeof draft.templateId === 'string' ? draft.templateId : null,
      name: typeof draft.name === 'string' ? draft.name : '',
      surface: draft.surface as BedProfile['surface'],
      placements: draft.placements as DraftPlacement[],
      mountings: draft.mountings as DraftMounting[],
      consumables: (draft.consumables ?? null) as BedProfile['consumables'],
      skipped: (draft.skipped as unknown[]).filter((n): n is number => typeof n === 'number'),
    };
  } catch {
    return null;
  }
}
