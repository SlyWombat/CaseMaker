/**
 * The app's material vocabulary (#347), in one leaf module.
 *
 * Why this is its own file and not a corner of a module that already talks about materials:
 * `StockMaterial` was a four-member union living in `types/engraveJob.ts` with nothing that listed
 * it at runtime, so every consumer retyped it — the job schema in a `z.enum`, the flows in a
 * hand-written options array, the run sheet in a label map. #347 widened the vocabulary to the
 * metals and plastics a machine profile declares, and three modules now need the list itself:
 *
 *   - the JOB SCHEMA, which parses `stock.material` against it,
 *   - `feeds.ts`, whose table and vendor-name map are written in it,
 *   - `machine.ts`, which types `MillProfile.materials` with it and validates that field.
 *
 * And two of those cannot import each other: `feeds.ts` imports `clampToMachine` from `machine.ts`,
 * so a list living in either one and used at module-init time by the other is an initialization
 * cycle — the classic TDZ crash rather than a lint complaint. Hence a third module that imports
 * nothing but the type.
 *
 * What does NOT belong here: the vendor's own words for these materials (`CATALOGUE_MATERIALS` and
 * `catalogueMaterialFor` in `feeds.ts`) and the numbers for them (its table). This is the app's
 * vocabulary and the app's words — the half that is ours.
 */

import type { StockMaterial } from '@/types/engraveJob';

/**
 * Every material this app can name, in the order the stock shelf offers it.
 *
 * The first four are the ones the starting table has rows for — a material this app can cut with
 * numbers of its own. The rest have no starting row at all: they are the materials a machine
 * profile declares, and only the user's own synced catalogue can answer them, which is exactly why
 * `feedsFor` refuses such a job until a row for (that cutter, that material) exists (#347, Route A).
 *
 * The PRINTED-BLANK classes (#456) are the exception in how they are answered. Their names are
 * PrusaSlicer's own `filament_type` words, because the file that printed the blank is what states
 * the material; the catalogue lists no row for any of them either, and `CATALOGUE_MATERIAL_ALIASES`
 * in `feeds.ts` stands its nearest plastic rows in, labelled as a mapping. `pa-cf` and `pa-gf` are
 * separate from `pa` because fibre-filled nylon is abrasive (`runEnd.ts`'s wear class).
 *
 * TWO LISTS ARE EDITED TOGETHER, and the compiler only enforces one of them: `MATERIAL_LABELS` below
 * is `Record<StockMaterial, string>`, so a new material in the TYPE is a compile error until it has
 * a word. This tuple is checked the other way round — it is `satisfies readonly StockMaterial[]`, so
 * a typo here fails — but nothing forces a material that exists in the type to appear here. What
 * that costs is a material the schema would refuse to parse, which is why the job schema's enum is
 * this tuple and not a retyped literal.
 */
export const STOCK_MATERIALS = [
  'softwood',
  'hardwood',
  'mdf',
  'pla',
  'petg',
  'pet',
  'abs',
  'asa',
  'hips',
  'pa',
  'pa-cf',
  'pa-gf',
  'pc',
  'pp',
  'tpu',
  'pva',
  'acrylic',
  // #492 — unspecified bought plastic (the engraving laminate). Deliberately NOT in
  // PRINTED_BLANK_MATERIALS below: a laminate is purchased, not printed.
  'plastic',
  'aluminium-6061',
  'aluminium-7075',
  'brass',
  'copper',
] as const satisfies readonly StockMaterial[];

/**
 * The app's word for each material, one map so the flow's options, the run sheet and the panel's
 * `<select>` cannot spell a material three ways. Lower-case for the woods the app has always cut,
 * caps for the rest, and the two aluminium alloys spelled out in full — a label that said only
 * `Aluminium` would name the wrong number for one of them.
 */
export const MATERIAL_LABELS: Readonly<Record<StockMaterial, string>> = {
  softwood: 'softwood',
  hardwood: 'hardwood',
  mdf: 'MDF',
  pla: 'PLA',
  petg: 'PETG',
  pet: 'PET',
  abs: 'ABS',
  asa: 'ASA',
  hips: 'HIPS',
  pa: 'PA (nylon)',
  'pa-cf': 'PA-CF',
  'pa-gf': 'PA-GF',
  pc: 'PC',
  pp: 'PP',
  tpu: 'TPU',
  pva: 'PVA',
  acrylic: 'Acrylic',
  plastic: 'plastic (unspecified)',
  'aluminium-6061': 'Aluminium 6061',
  'aluminium-7075': 'Aluminium 7075',
  brass: 'Brass',
  copper: 'Copper',
};

/**
 * Is this a metal? The four metals in {@link STOCK_MATERIALS}, listed rather than derived from the
 * string — a name is not a category, and `aluminium-6061` beginning with a letter that once meant
 * "metal" is a coincidence nobody should have to preserve (#405).
 *
 * It exists because ONE question needs it: a cutter ground for metal is not the cutter for a plastic
 * or a wood, which is a statement about the PAIR and so cannot live on either side alone. Makera
 * states the cutter's half in the cutter's name — `(Metal)` on a catalogue row, `for Metal` on the
 * printed label (`isMetalCutterName`) — and the printed box code adds a third statement; this is the
 * blank's half.
 */
export function isMetalMaterial(material: StockMaterial): boolean {
  return material === 'aluminium-6061' || material === 'aluminium-7075' || material === 'brass' || material === 'copper';
}

/**
 * The woods this app can name: the two timbers and MDF. Listed rather than derived, for the same
 * reason as {@link isMetalMaterial} — a name is not a category.
 *
 * It exists because ONE rule is stated in these two poles: facing is for wood and metal only
 * (#474, widened by #493), so everything that is neither is refused. A material added to
 * {@link STOCK_MATERIALS} later is therefore refused by default unless someone deliberately says it
 * is a wood — the safe direction for a rule about what a flat cutter may be pushed into.
 */
export const WOOD_MATERIALS = ['softwood', 'hardwood', 'mdf'] as const satisfies readonly StockMaterial[];

/** Is this stock a wood (softwood, hardwood or MDF)? See {@link WOOD_MATERIALS}. */
export function isWoodMaterial(material: StockMaterial): boolean {
  return WOOD_MATERIALS.some((wood) => wood === material);
}

/**
 * Is this stock a plastic — everything {@link STOCK_MATERIALS} can name that is neither a wood nor a
 * metal? The complement of the two poles the facing rule states (#474: facing is for wood and metal
 * only), so the answer is derived from those two lists rather than a third list that would have to be
 * kept in step with them.
 *
 * It exists because ONE rule needs it: the antistatic (static-removal) accessory is switched on for
 * plastic jobs only (#564) — cutting a plastic builds static charge on the swarf; a wood or a metal
 * does not, and must not get the accessory words. A material added to {@link STOCK_MATERIALS} later
 * therefore reads as plastic by default unless someone deliberately says it is a wood or a metal,
 * which is the safe direction for a rule that switches a device on.
 */
export function isPlasticMaterial(material: StockMaterial): boolean {
  return !isWoodMaterial(material) && !isMetalMaterial(material);
}

/**
 * The classes a slicer can produce: the printed-blank materials (#456), listed rather than derived
 * from the string. A name is not a category — the same reason {@link isMetalMaterial} gives — and a
 * new class must answer this question here instead of being silently under-covered by a heuristic.
 *
 * The woods, MDF and acrylic are deliberately absent: a board loaded as stock may well have been
 * cut from a sheet, and what its finish should default to is a different question with no answer
 * yet (#463). `satisfies readonly StockMaterial[]` makes a typo a compile error; the schema already
 * refuses a material outside `STOCK_MATERIALS`.
 */
export const PRINTED_BLANK_MATERIALS = [
  'pla',
  'petg',
  'pet',
  'abs',
  'asa',
  'hips',
  'pa',
  'pa-cf',
  'pa-gf',
  'pc',
  'pp',
  'tpu',
  'pva',
] as const satisfies readonly StockMaterial[];

/**
 * Is this stock a printed blank — the thing a 3D printer makes, rather than a board sawn from a
 * sheet? It exists because the start wizard asks it once: a mesh loaded as stock is usually a
 * printed blank, and the finish default follows from the material being one (#463).
 */
export function isPrintedBlankMaterial(material: StockMaterial): boolean {
  return PRINTED_BLANK_MATERIALS.some((printed) => printed === material);
}
