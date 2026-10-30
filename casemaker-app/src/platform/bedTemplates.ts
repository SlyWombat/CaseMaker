/**
 * #512 (design `bed-profiles.md` §7) — the bed profiles the app SHIPS, as wizard templates.
 *
 * These are not saved profiles: a saved `BedProfile` must be answerable (a wasteboard states its
 * thickness, every datum is a measurement or null), while a template is the picture and the
 * starting point S1 offers before the operator has answered S2–S5. Applying one puts its surface,
 * placements and mountings into the wizard's draft, and the operator edits them from there.
 *
 * PROVENANCE IS STATED, NOT IMPLIED. The vendor's numbers carry `vendor:<key>` naming where the
 * controller states them; our chosen numbers say `default`; the product dimensions measured on the
 * maintainer's unit keep their measured date. Nothing here is marked measured that nobody measured.
 *
 * The five profiles are §7's table. They are additions to it only in the detail the schema needs:
 * a template surface must name a thickness for a wasteboard (2.0 mm, chosen, labelled `default`),
 * and each placement carries the fixture record its kind is registered with (#508/#597).
 */

import type { BedProfile, FixtureRecord } from './locationClient';

/** The manner a stock class is held: the schema's five. */
export type MountManner = BedProfile['preferredMounting'][number]['mount']['manner'];

/** A fixture a template places, before it is a saved accessory record. */
export interface TemplateFixture {
  /** `vise` / `bracket` / `top-clamp` / `rotary-module` — the accessory's open `kind`. */
  kind: string;
  variant: string | null;
  product: string | null;
  constants: Record<string, string | number | null>;
  unit: Record<string, string | number | null>;
  provenance: Record<string, string>;
}

/** One placement a template starts with. `key` is local to the template (mountings name it). */
export interface TemplatePlacement {
  key: string;
  fixture: TemplateFixture;
  where: { kind: 'pins'; pins: 'vise' | 'rotary' } | { kind: 'anchor'; anchor: 1 | 2 } | { kind: 'free' };
  count: number | null;
}

/** A stock class's preferred mounting. `placementKey` is the template's placement, or null (tape). */
export interface TemplateMounting {
  stock: string;
  manner: MountManner;
  placementKey: string | null;
}

/** One shipped bed, as S1 offers it. */
export interface BedTemplate {
  /** Stable id; a saved profile's `basedOn` names it. */
  id: string;
  name: string;
  /** One sentence for the radio row. */
  words: string;
  surface: BedProfile['surface'];
  placements: TemplatePlacement[];
  mountings: TemplateMounting[];
  consumables: BedProfile['consumables'];
  /** What must be measured before the gates that need it stop refusing — S1's list. */
  toMeasure: string[];
}

const defaultProvenance = (keys: readonly string[]): Record<string, string> =>
  Object.fromEntries(keys.map((k) => [k, 'default']));

/** The wasteboard surface every shipped wasteboard starts as: 200 × 200 × 2.0, all `default`. */
export function shippedWasteboard(): BedProfile['surface'] {
  return {
    kind: 'wasteboard',
    material: 'MDF',
    length: 200,
    width: 200,
    thickness: 2,
    position: null,
    provenance: defaultProvenance(['material', 'length', 'width', 'thickness']),
    scars: [],
    lastResurfacedAt: null,
  };
}

export function shippedBareBed(): BedProfile['surface'] {
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

/** The low-profile vise's product constants (measured on the unit, design §2's own example). */
function viseFixture(): TemplateFixture {
  return {
    kind: 'vise',
    variant: null,
    product: 'makera-z1-low-profile-vise',
    constants: { jawBarWidth: 10, jawLength: 100, ledgeStep: 3.1, ledgeWidth: 1.9 },
    unit: { jawBarHeight: null, bodyHeight: null, maxOpening: null },
    provenance: { jawBarWidth: 'measured:2026-10-13', jawLength: 'measured:2026-10-13', ledgeStep: 'measured:2026-10-15', ledgeWidth: 'measured:2026-10-15', jawBarHeight: 'unmeasured', bodyHeight: 'unmeasured', maxOpening: 'unmeasured' },
  };
}

function bracketFixture(variant: 'thin' | 'thick'): TemplateFixture {
  return {
    kind: 'bracket',
    variant,
    product: null,
    constants: { armLength: 100, armWidth: 15, height: null },
    unit: {},
    provenance: { armLength: 'vendor:config.anchor_length', armWidth: 'vendor:config.anchor_width', height: 'unmeasured' },
  };
}

function clampFixture(): TemplateFixture {
  return {
    kind: 'top-clamp',
    variant: null,
    product: null,
    constants: { length: 30, width: 15, noseReach: 8, heightAbovePlate: 12 },
    unit: {},
    provenance: defaultProvenance(['length', 'width', 'noseReach', 'heightAbovePlate']),
  };
}

function rotaryFixture(): TemplateFixture {
  return {
    kind: 'rotary-module',
    variant: null,
    product: null,
    constants: { chuck: '3-jaw, reverse jaws' },
    unit: { jawReach: null },
    provenance: { chuck: 'default', jawReach: 'unmeasured' },
  };
}

const SHEET = 'sheet<=3mm';
const PLATE = 'plate|block';
const BLANK = 'blank<opening&taller-than-ledge';
const ROD = 'rod|tube';

/** The four stock classes every shipped bed answers (design §5.2). */
export const STOCK_CLASSES = { sheet: SHEET, plate: PLATE, blank: BLANK, rod: ROD } as const;

/**
 * S4's standard rows, when a draft carries none: each stock class taped on the surface. They are the
 * design's defaults, editable like any answer.
 */
export const STANDARD_MOUNTINGS: readonly TemplateMounting[] = [
  { stock: SHEET, manner: 'tape', placementKey: null },
  { stock: PLATE, manner: 'tape', placementKey: null },
  { stock: BLANK, manner: 'tape', placementKey: null },
  { stock: ROD, manner: 'tape', placementKey: null },
];

/** The fixtures S3 offers to put on the bed, by the name the Add buttons use. */
export type AddableFixture = 'vise' | 'rotary-module' | 'bracket-thin' | 'bracket-thick' | 'top-clamp';

/** The template fixture an S3 "Add" makes, before it has a draft key or a saved record. */
export function templateFixtureFor(kind: AddableFixture): TemplateFixture {
  switch (kind) {
    case 'vise':
      return viseFixture();
    case 'rotary-module':
      return rotaryFixture();
    case 'bracket-thin':
      return bracketFixture('thin');
    case 'bracket-thick':
      return bracketFixture('thick');
    case 'top-clamp':
      return clampFixture();
  }
}

export const BED_TEMPLATES: readonly BedTemplate[] = [
  {
    id: 'default:z1-makera-kit',
    name: 'Makera kit',
    words: 'Wasteboard, L-bracket (thin) at anchor 1, two top clamps — what Makera ships',
    surface: shippedWasteboard(),
    placements: [
      { key: 'bracket', fixture: bracketFixture('thin'), where: { kind: 'anchor', anchor: 1 }, count: null },
      { key: 'clamps', fixture: clampFixture(), where: { kind: 'free' }, count: 2 },
    ],
    mountings: [
      { stock: SHEET, manner: 'tape', placementKey: null },
      { stock: PLATE, manner: 'corner+clamps', placementKey: 'bracket' },
      { stock: BLANK, manner: 'tape', placementKey: null },
      { stock: ROD, manner: 'tape', placementKey: null },
    ],
    consumables: { tape: { widthMm: 20, thicknessMm: 0.1, provenance: 'default' }, boards: [] },
    toMeasure: ['surface top', 'bracket seat', 'arm height', 'clamp sizes'],
  },
  {
    id: 'default:z1-vise',
    name: 'Low-profile vise on its pins, bare bed',
    words: 'The Makera low-profile vise on its two pins, with the bare aluminium bed to work on',
    surface: shippedBareBed(),
    placements: [{ key: 'vise', fixture: viseFixture(), where: { kind: 'pins', pins: 'vise' }, count: null }],
    mountings: [
      { stock: SHEET, manner: 'tape', placementKey: null },
      { stock: PLATE, manner: 'tape', placementKey: null },
      { stock: BLANK, manner: 'jaws', placementKey: 'vise' },
      { stock: ROD, manner: 'tape', placementKey: null },
    ],
    consumables: { tape: { widthMm: 20, thicknessMm: 0.1, provenance: 'default' }, boards: [] },
    toMeasure: ['surface top', 'jaw top', 'jaw bar height', 'body height', 'max opening'],
  },
  {
    id: 'default:z1-wasteboard-tape',
    name: 'Wasteboard with tape',
    words: 'A wasteboard to cut into, stock taped down — no fixtures on the bed',
    surface: shippedWasteboard(),
    placements: [],
    mountings: [
      { stock: SHEET, manner: 'tape', placementKey: null },
      { stock: PLATE, manner: 'tape', placementKey: null },
      { stock: BLANK, manner: 'tape', placementKey: null },
      { stock: ROD, manner: 'tape', placementKey: null },
    ],
    consumables: { tape: { widthMm: 20, thicknessMm: 0.1, provenance: 'default' }, boards: [] },
    toMeasure: ['surface top', 'board thickness'],
  },
  {
    id: 'default:z1-4th-axis',
    name: '4th-axis module on its pins',
    words: 'The rotary module on its two pins, for rods and tubes',
    surface: shippedBareBed(),
    placements: [{ key: 'rotary', fixture: rotaryFixture(), where: { kind: 'pins', pins: 'rotary' }, count: null }],
    mountings: [
      { stock: SHEET, manner: 'tape', placementKey: null },
      { stock: PLATE, manner: 'tape', placementKey: null },
      { stock: BLANK, manner: 'tape', placementKey: null },
      { stock: ROD, manner: 'chuck', placementKey: 'rotary' },
    ],
    consumables: { tape: { widthMm: 20, thicknessMm: 0.1, provenance: 'default' }, boards: [] },
    toMeasure: ['rotary axis', 'chuck body', 'jaw reach'],
  },
  {
    id: 'default:z1-vacuum',
    name: 'Vacuum bed',
    words: 'A vacuum bed — listed only; the shop does not own one',
    surface: {
      kind: 'vacuum-bed',
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
    mountings: [
      { stock: SHEET, manner: 'vacuum', placementKey: null },
      { stock: PLATE, manner: 'vacuum', placementKey: null },
      { stock: BLANK, manner: 'vacuum', placementKey: null },
      { stock: ROD, manner: 'vacuum', placementKey: null },
    ],
    consumables: null,
    toMeasure: ['surface top'],
  },
];

/** S1's last radio: describe the bed yourself. It is not a profile; nothing is pre-filled. */
export const EMPTY_TEMPLATE: BedTemplate = {
  id: 'default:empty',
  name: 'Empty — I will describe it',
  words: 'Start with nothing on the bed and answer each step yourself',
  surface: shippedBareBed(),
  placements: [],
  mountings: [],
  consumables: null,
  toMeasure: [],
};

export const ALL_TEMPLATES: readonly BedTemplate[] = [...BED_TEMPLATES, EMPTY_TEMPLATE];

export function bedTemplateById(id: string | null): BedTemplate | null {
  return id === null ? null : (ALL_TEMPLATES.find((t) => t.id === id) ?? null);
}

/** The fixture record a template placement becomes at save. Pure; the caller supplies id/where. */
export function fixtureRecordFor(
  fixture: TemplateFixture,
  id: string,
  machineId: string,
  now: string,
): FixtureRecord {
  return {
    id,
    kind: fixture.kind,
    product: fixture.product,
    variant: fixture.variant,
    constants: { ...fixture.constants },
    unit: { ...fixture.unit },
    provenance: { ...fixture.provenance },
    whereabouts: { kind: 'machine', machineId, since: now },
    history: [{ at: now, what: 'registered by the bed wizard' }],
  };
}
