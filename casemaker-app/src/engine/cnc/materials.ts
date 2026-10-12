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
 * Every material this app can name, in the order the setup flow offers it.
 *
 * The first four are the ones the starting table has rows for — a material this app can cut with
 * numbers of its own. The rest have no starting row at all: they are the materials a machine
 * profile declares, and only the user's own synced catalogue can answer them, which is exactly why
 * `feedsFor` refuses such a job until a row for (that cutter, that material) exists (#347, Route A).
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
  'abs',
  'acrylic',
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
  abs: 'ABS',
  acrylic: 'Acrylic',
  'aluminium-6061': 'Aluminium 6061',
  'aluminium-7075': 'Aluminium 7075',
  brass: 'Brass',
  copper: 'Copper',
};
