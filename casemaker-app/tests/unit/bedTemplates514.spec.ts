// #514 — THE FIVE SHIPPED BEDS: what each one is (§7's table) and what it asks you to measure.
//
// The templates live in `platform/bedTemplates.ts` and #512's spec already proves each one saves a
// profile the location can read back. This spec pins the slice-5 content the design's §7 table
// states, and the one rule the to-measure lists exist for: every item names something that really
// is unmeasured on that bed (a datum, a null constant, or a default this shop has not calipered),
// and every unmeasured datum the bed's own mounts need is on the list. It also holds the C15
// correction (the rotary chuck is four-jaw, self-centring) so the old wording cannot come back.

import { describe, expect, it } from 'vitest';

import {
  BED_TEMPLATES,
  CALIPERS_LIST_URL,
  bedTemplateById,
  templateFixtureFor,
  type BedTemplate,
} from '@/platform/bedTemplates';
import {
  applyTemplate,
  bedWizardDraft,
  finalizeDraft,
  type FinalizedBed,
} from '@/platform/bedWizard';

const NOW = '2026-11-01T10:00:00.000Z';
const MACHINE_ID = 'machine-1a2b3c';

function saved(template: BedTemplate): FinalizedBed {
  const draft = applyTemplate(bedWizardDraft(MACHINE_ID), template);
  const res = finalizeDraft(draft, { now: NOW, id: 'bp-test', existing: [] });
  if (!res.ok) throw new Error(`${template.id}: ${res.reason}`);
  return res.bed;
}

const byName = (name: string): BedTemplate => {
  const t = BED_TEMPLATES.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no template named ${name}`);
  return t;
};

/** What each to-measure phrase must actually name on the bed it is on. */
const PHRASE_MEANS: Record<string, (bed: FinalizedBed) => boolean> = {
  'surface top': (b) => b.profile.datums.surfaceTopZ === null,
  'jaw top': (b) => b.profile.datums.viseJawTopZ === null,
  'bracket seat': (b) => b.profile.datums.bracketSeatZ === null,
  'rotary axis': (b) => b.profile.datums.rotaryAxis === null,
  'arm height': (b) => b.accessories.some((f) => f.kind === 'bracket' && f.constants.height === null),
  // The clamps' sizes are this app's defaults, not the product's: to be calipered, not trusted.
  'clamp sizes': (b) => b.accessories.some((f) => f.kind === 'top-clamp' && f.provenance.length === 'default'),
  'jaw bar height': (b) => b.accessories.some((f) => f.kind === 'vise' && f.unit.jawBarHeight === null),
  'body height': (b) => b.accessories.some((f) => f.kind === 'vise' && f.unit.bodyHeight === null),
  'max opening': (b) => b.accessories.some((f) => f.kind === 'vise' && f.unit.maxOpening === null),
  // The shipped board is 2.0 mm by default; the board in hand is calipered.
  'board thickness': (b) => b.profile.surface.thickness !== null && b.profile.surface.provenance.thickness === 'default',
  'chuck body': (b) =>
    b.accessories.some((f) => f.kind === 'rotary-module' && f.constants.chuck !== null && f.provenance.chuck === 'default'),
  'jaw reach': (b) => b.accessories.some((f) => f.kind === 'rotary-module' && f.unit.jawReach === null),
};

describe('#514 the five shipped beds are §7’s table', () => {
  it('ships exactly the five beds the design names, in its order', () => {
    expect(BED_TEMPLATES.map((t) => t.name)).toEqual([
      'Makera kit',
      'Low-profile vise on its pins, bare bed',
      'Wasteboard with tape',
      '4th-axis module on its pins',
      'Vacuum bed',
    ]);
  });

  it('the Makera kit is the wasteboard with the thin bracket at anchor 1 and two clamps', () => {
    const bed = saved(byName('Makera kit'));
    expect(bed.profile.surface).toMatchObject({ kind: 'wasteboard', material: 'MDF', thickness: 2 });
    expect(bed.profile.placements.map((p) => p.where)).toEqual([
      { kind: 'anchor', anchor: 1, pins: null },
      { kind: 'free', anchor: null, pins: null },
    ]);
    expect(bed.profile.placements[1]!.count).toBe(2);
    expect(bed.accessories.find((f) => f.kind === 'bracket')).toMatchObject({
      variant: 'thin',
      // The arms are the controller's own numbers, and their provenance says which keys.
      constants: { armLength: 100, armWidth: 15 },
      provenance: { armLength: 'vendor:config.anchor_length', armWidth: 'vendor:config.anchor_width' },
    });
  });

  it('the low-profile vise sits on the bare bed with the product numbers measured on the unit', () => {
    const bed = saved(byName('Low-profile vise on its pins, bare bed'));
    expect(bed.profile.surface.kind).toBe('bare-bed');
    expect(bed.profile.placements[0]!.where).toEqual({ kind: 'pins', anchor: null, pins: 'vise' });
    const vise = bed.accessories.find((f) => f.kind === 'vise')!;
    expect(vise.constants).toMatchObject({ jawBarWidth: 10, jawLength: 100, ledgeStep: 3.1, ledgeWidth: 1.9 });
    // The jaw bar and the ledge are the product's, measured on this unit — the only numbers the
    // shipped beds carry as measured.
    expect(vise.provenance.jawBarWidth).toMatch(/^measured:/);
    expect(vise.provenance.ledgeStep).toMatch(/^measured:/);
  });

  it('the wasteboard-with-tape bed carries no fixtures, and the vacuum bed is listed only', () => {
    expect(saved(byName('Wasteboard with tape')).profile.placements).toEqual([]);
    const vacuum = saved(byName('Vacuum bed'));
    expect(vacuum.profile.surface.kind).toBe('vacuum-bed');
    expect(vacuum.profile.placements).toEqual([]);
    expect(vacuum.accessories).toEqual([]);
  });

  it('the rotary module is C15’s four-jaw self-centring chuck, never the old three-jaw wording', () => {
    expect(String(templateFixtureFor('rotary-module').constants.chuck)).toContain('4-jaw');
    for (const t of BED_TEMPLATES) expect(JSON.stringify(t)).not.toMatch(/3-jaw|three-jaw/i);
  });
});

describe('#514 every bed’s to-measure list is exactly what is unmeasured on it', () => {
  it('each item names something that really is unmeasured — and each unmeasured datum is listed', () => {
    for (const template of BED_TEMPLATES) {
      const bed = saved(template);
      for (const phrase of template.toMeasure) {
        const means = PHRASE_MEANS[phrase];
        if (means === undefined) throw new Error(`${template.id}: "${phrase}" has no pinning check`);
        expect(means(bed), `${template.id}: "${phrase}" must name a real unmeasured fact`).toBe(true);
      }
      // Every datum is null on a fresh bed, so every bed names the datum its own mounting reads:
      // the vise's jaw top, the rotary's axis, the surface top for a bed worked on directly.
      expect(template.toMeasure).toContain(
        template.placements.some((p) => p.where.kind === 'pins' && p.where.pins === 'vise')
          ? 'jaw top'
          : template.placements.some((p) => p.where.kind === 'pins' && p.where.pins === 'rotary')
            ? 'rotary axis'
            : 'surface top',
      );
    }
  });

  it('pins the five lists themselves', () => {
    const lists = Object.fromEntries(BED_TEMPLATES.map((t) => [t.id, t.toMeasure]));
    expect(lists).toEqual({
      'default:z1-makera-kit': ['surface top', 'bracket seat', 'arm height', 'clamp sizes'],
      'default:z1-vise': ['surface top', 'jaw top', 'jaw bar height', 'body height', 'max opening'],
      'default:z1-wasteboard-tape': ['surface top', 'board thickness'],
      'default:z1-4th-axis': ['rotary axis', 'chuck body', 'jaw reach'],
      'default:z1-vacuum': ['surface top'],
    });
  });

  it('the to-measure list links to #444’s calipers list, from one constant', () => {
    expect(CALIPERS_LIST_URL).toBe('https://github.com/SlyWombat/CaseMaker/issues/444');
    expect(bedTemplateById('default:z1-vacuum')!.toMeasure.length).toBeGreaterThan(0);
  });
});
