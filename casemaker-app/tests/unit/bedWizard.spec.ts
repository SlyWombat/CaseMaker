// #512 — the first-run bed wizard's draft and its rules, pinned without a browser.
//
// The platform half (`platform/bedWizard.ts`) is pure: a draft in, a draft out, and at S6 a
// `BedProfile` the location can read back. The tests walk the design's own shape (S0 → S6) and the
// rules this slice is built under: every step skippable, measurements left unmeasured (a datum is
// measured, never typed), the vise/4th-axis pin conflict stated with its fix (open question A), and
// a draft that resumes or is dropped, never half-applied.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BED_WIZARD_STEPS,
  addPlacement,
  answerConsumables,
  answerMountings,
  answerName,
  answerPlacements,
  answerSurface,
  applyTemplate,
  bedWizardDraft,
  draftFromJson,
  draftToJson,
  finalizeDraft,
  goToStep,
  placementConflict,
  provenanceTally,
  resolveConflict,
  skipStep,
  unmeasuredList,
  type BedWizardDraft,
} from '@/platform/bedWizard';
import {
  ALL_TEMPLATES,
  STANDARD_MOUNTINGS,
  bedTemplateById,
  shippedBareBed,
  shippedWasteboard,
  type BedTemplate,
} from '@/platform/bedTemplates';
import {
  BedProfileSchema,
  FixtureRecordSchema,
  MachineRecordSchema,
  type FixtureRecord,
  type MachineRecord,
} from '@/platform/locationClient';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'location-doc.json');
const NOW = '2026-10-30T10:00:00.000Z';

/** The shared fixture's machine without its bed keys: a machine whose bed has never been described. */
function machineRecord(): MachineRecord {
  const raw = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    machines: Array<Record<string, unknown>>;
  }).machines[0]!;
  const { bedFixtures: _bf, bedProfiles: _bp, activeBedProfileId: _a, ...plain } = raw;
  const parsed = MachineRecordSchema.safeParse(plain);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return parsed.data!;
}

const MACHINE = machineRecord();

function draftFrom(template: BedTemplate | string): BedWizardDraft {
  const t = typeof template === 'string' ? bedTemplateById(template) : template;
  expect(t).not.toBeNull();
  return applyTemplate(bedWizardDraft(MACHINE.id), t!);
}

function finalize(draft: BedWizardDraft, existing: readonly FixtureRecord[] = []) {
  return finalizeDraft(draft, { now: NOW, id: 'bp-test', existing });
}

describe('#512 bed wizard — S1 to S6, one field per step', () => {
  it('every shipped template saves a profile the location can read back, with no datum invented', () => {
    for (const template of ALL_TEMPLATES) {
      const res = finalize(draftFrom(template));
      expect(res.ok, `${template.id}: ${res.ok ? '' : res.reason}`).toBe(true);
      if (!res.ok) continue;
      const profile = res.bed.profile;

      expect(BedProfileSchema.safeParse(profile).success).toBe(true);
      expect(profile.basedOn).toBe(template.id);
      expect(profile.name).toBe(template.name);
      // The wizard measures nothing: every datum stays null, as the schema requires of the unknown.
      expect(Object.values(profile.datums)).toEqual([null, null, null, null]);
      // Every placement names a fixture record the save creates (or reuses).
      for (const placement of profile.placements) {
        expect(res.bed.accessories.some((a) => a.id === placement.fixture)).toBe(true);
      }
      // And the machine record that will carry it parses under the service's own schema.
      const machine = MachineRecordSchema.safeParse({
        ...MACHINE,
        bedProfiles: [profile],
        activeBedProfileId: profile.id,
      });
      expect(machine.success, JSON.stringify(machine.error?.issues)).toBe(true);
    }
  });

  it('a template copies its surface, placements, mountings and consumables; a step answer writes only its own', () => {
    const template = bedTemplateById('default:z1-vise')!;
    const applied = draftFrom(template);

    expect(applied.surface).toEqual(template.surface);
    expect(applied.surface).not.toBe(template.surface); // a copy, not a shared object
    expect(applied.placements.map((p) => p.fixture.kind)).toEqual(['vise']);
    expect(applied.mountings).toEqual(template.mountings);
    expect(applied.consumables).toEqual(template.consumables);

    const surface = { ...shippedWasteboard(), length: 300, width: 200 };
    const named = answerName(answerSurface(applyTemplate(applied, template), surface), 'Bench bed');
    expect(named.name).toBe('Bench bed');
    expect(named.surface.length).toBe(300);
    expect(named.placements).toHaveLength(1); // S3 untouched
    expect(named.mountings).toHaveLength(4); // S4 untouched
    expect(named.consumables?.tape?.widthMm).toBe(20); // S5 untouched
    // Editing the draft surface does not edit the shipped template.
    named.surface.length = 999;
    expect(template.surface.length).toBeNull();
  });

  it('S0 is a read, every other step skips, and S6 still saves with the datums unmeasured', () => {
    let draft = draftFrom('default:z1-vise');
    expect(draft.step).toBe(0);
    draft = skipStep(draft, 0); // S0 has no answer; skipping it is just Next
    expect(draft.step).toBe(1);
    expect(draft.skipped).not.toContain(0);
    draft = goToStep(draft, 2);
    for (const step of [2, 3, 4, 5]) draft = skipStep(draft, step);
    expect(draft.step).toBe(6);
    expect(draft.skipped).toEqual([2, 3, 4, 5]);
    // Skipping keeps the template's answers: nothing is wiped by advancing past it.
    expect(draft.surface.kind).toBe('bare-bed');
    expect(draft.placements).toHaveLength(1);

    const res = finalize(draft);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.values(res.bed.profile.datums).every((d) => d === null)).toBe(true);
    expect(unmeasuredList(res.bed.profile, res.bed.accessories)).toContain('the jaw top');
  });

  it('the step list is the design’s seven, in order', () => {
    expect(BED_WIZARD_STEPS).toHaveLength(7);
    expect(BED_WIZARD_STEPS[0]).toBe('Your machine');
    expect(BED_WIZARD_STEPS[6]).toBe('Review and save');
  });
});

describe('#512 bed wizard — the pins are shared (open question A)', () => {
  it('the vise and the 4th-axis module on the pins are stated together with the one fix', () => {
    const draft = addPlacement(draftFrom('default:z1-vise'), 'rotary-module');
    const conflict = placementConflict(draft.placements);
    expect(conflict).not.toBeNull();
    expect(conflict!.code).toBe('pins-shared');
    expect(conflict!.sentence).toContain('same two pins');
    expect(conflict!.sentence).toContain('one bed carries one of them at a time');
    expect(conflict!.fix).toContain('Remove the low-profile vise');
    expect(conflict!.keys).toHaveLength(2);

    // S6 refuses the contradictory profile with the conflict's own words…
    const refused = finalize(draft);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain('same two pins');

    // …and the named fix resolves it: one pin user stays, the other goes.
    const fixed = resolveConflict(draft, draft.placements.find((p) => p.fixture.kind === 'rotary-module')!.key);
    expect(placementConflict(fixed.placements)).toBeNull();
    const res = finalize(fixed);
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
    if (!res.ok) return;
    expect(res.bed.profile.placements).toHaveLength(1);
    expect(res.bed.profile.placements[0]!.where.pins).toBe('vise');
  });

  it('the same pin fixture listed twice is a conflict too', () => {
    const draft = addPlacement(draftFrom('default:z1-vise'), 'vise');
    const conflict = placementConflict(draft.placements);
    expect(conflict?.code).toBe('pins-twice');
    expect(conflict?.sentence).toContain('one vise');
  });

  it('an added placement gets a fresh key and the template’s own fixture numbers', () => {
    let draft = draftFrom('default:z1-vise');
    const before = new Set(draft.placements.map((p) => p.key));
    draft = addPlacement(draft, 'bracket-thin');
    draft = addPlacement(draft, 'top-clamp');
    const added = draft.placements.filter((p) => !before.has(p.key));
    expect(added).toHaveLength(2);
    expect(new Set(draft.placements.map((p) => p.key)).size).toBe(draft.placements.length);
    const bracket = added.find((p) => p.fixture.kind === 'bracket')!;
    expect(bracket.fixture.variant).toBe('thin');
    expect(bracket.where).toEqual({ kind: 'anchor', anchor: 1 });
    const clamps = added.find((p) => p.fixture.kind === 'top-clamp')!;
    expect(clamps.count).toBe(2);
  });

  it('a mounting that named a removed placement is dropped, not repointed', () => {
    const draft = draftFrom('default:z1-4th-axis');
    expect(draft.mountings.some((m) => m.placementKey === 'rotary')).toBe(true);
    const cleared = answerPlacements(draft, []);
    expect(cleared.mountings.some((m) => m.placementKey === 'rotary')).toBe(false);
    expect(cleared.mountings.filter((m) => m.placementKey === null)).toHaveLength(3);
    const res = finalize(cleared);
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
  });
});

describe('#512 bed wizard — S6 refuses only what cannot be saved', () => {
  it('a bed with no name is refused by name', () => {
    const res = finalize({ ...draftFrom('default:z1-vise'), name: '   ' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('give the bed a name before saving it');
  });

  it('a wasteboard without a thickness is refused with the schema’s own sentence', () => {
    const draft = answerSurface(draftFrom('default:z1-vise'), {
      ...shippedWasteboard(),
      thickness: null,
      provenance: { material: 'default', length: 'default', width: 'default' },
    });
    const res = finalize(draft);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('a wasteboard says how thick it is');
  });

  it('a mounting naming a placement that is not on the bed is refused', () => {
    const draft = answerMountings(draftFrom('default:z1-vise'), [
      { stock: 'plate|block', placementKey: 'ghost', manner: 'jaws' },
    ]);
    const res = finalize(draft);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('names a fixture that is not on the bed');
  });

  it('an accessory already checked out to the machine is REUSED, so a second profile does not mint a second vise', () => {
    const existing: FixtureRecord = FixtureRecordSchema.parse({
      id: 'fx-existing-vise',
      kind: 'vise',
      product: 'makera-z1-low-profile-vise',
      whereabouts: { kind: 'machine', machineId: MACHINE.id, since: NOW },
    });
    const res = finalize(draftFrom('default:z1-vise'), [existing]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bed.accessories).toEqual([]);
    expect(res.bed.profile.placements[0]!.fixture).toBe('fx-existing-vise');
  });
});

describe('#512 bed wizard — provenance and the measurement list', () => {
  it('counts every number by where it came from, with unmeasured counted apart', () => {
    const vise = finalize(draftFrom('default:z1-vise'));
    expect(vise.ok).toBe(true);
    if (!vise.ok) return;
    // The vise template: 4 measured product constants; the 3 body dimensions and all four datums
    // and the five bare-bed surface fields unmeasured; 4 standard mountings and 2 tape numbers
    // defaulted.
    expect(provenanceTally(vise.bed.profile, vise.bed.accessories)).toEqual({
      measured: 4,
      vendor: 0,
      default: 6,
      typed: 0,
      unmeasured: 12,
    });

    const kit = finalize(draftFrom('default:z1-makera-kit'));
    expect(kit.ok).toBe(true);
    if (!kit.ok) return;
    // The Makera kit: the bracket's two arm numbers are the vendor's; everything else is the
    // wizard's default or unmeasured (the bracket height, the position and the four datums).
    expect(provenanceTally(kit.bed.profile, kit.bed.accessories)).toEqual({
      measured: 0,
      vendor: 2,
      default: 14,
      typed: 0,
      unmeasured: 6,
    });
  });

  it('the "to measure" list names the datums and the fixture dimensions that are still unknown', () => {
    const res = finalize(draftFrom('default:z1-vise'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const words = unmeasuredList(res.bed.profile, res.bed.accessories);
    expect(words).toContain('the surface top');
    expect(words).toContain('the jaw top');
    expect(words).toContain('the bracket seat');
    expect(words).toContain('the rotary axis');
    expect(words).toContain("the vise's jawBarHeight");
    // A measured constant is not on the list.
    expect(words).not.toContain("the vise's jawBarWidth");
  });
});

describe('#512 bed wizard — S5 and the draft’s stored form', () => {
  it('S4 and S5 answers are written as answered, and clearing the tape is an answer too', () => {
    let draft = draftFrom('default:z1-vise');
    draft = answerMountings(draft, STANDARD_MOUNTINGS);
    expect(draft.mountings).toEqual(STANDARD_MOUNTINGS);
    expect(draft.mountings).not.toBe(STANDARD_MOUNTINGS);

    draft = answerConsumables(draft, { tape: { widthMm: 25, thicknessMm: 0.15, provenance: 'typed' }, boards: [{ material: 'MDF', size: [200, 200, 2], count: 4 }] });
    expect(draft.consumables?.tape?.widthMm).toBe(25);
    draft = answerConsumables(draft, { tape: null, boards: [] });
    expect(draft.consumables).toEqual({ tape: null, boards: [] });
  });

  it('a draft round-trips through its stored form; a broken, foreign or older one is dropped', () => {
    const draft = goToStep(draftFrom('default:z1-4th-axis'), 6);
    const back = draftFromJson(draftToJson(draft));
    expect(back).toEqual(draft);

    expect(draftFromJson('{')).toBeNull();
    expect(draftFromJson(JSON.stringify({ schemaVersion: 2, draft }))).toBeNull();
    expect(draftFromJson(JSON.stringify({ schemaVersion: 1, draft: { ...draft, step: 99 } }))).toBeNull();
    expect(draftFromJson(JSON.stringify({ schemaVersion: 1, draft: { ...draft, machineId: 7 } }))).toBeNull();
    expect(draftFromJson(JSON.stringify({ schemaVersion: 1, draft: { ...draft, placements: 'none' } }))).toBeNull();
  });

  it('the empty template is a bare bed with nothing stated, and it saves', () => {
    const draft = draftFrom('default:empty');
    expect(draft.surface).toEqual(shippedBareBed());
    expect(draft.placements).toEqual([]);
    expect(draft.mountings).toEqual([]);
    expect(draft.consumables).toBeNull();
    const res = finalize(draft);
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
    if (!res.ok) return;
    expect(res.bed.profile.placements).toEqual([]);
    expect(res.bed.profile.preferredMounting).toEqual([]);
  });
});
