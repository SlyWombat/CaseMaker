// The eight catalogue type names, and the shape each one has to mean (#308, tracking #212).
//
// WHY THIS EXISTS. Makera's database stores a cutter's kind as an INTEGER (`cutterCategoryId`) and
// keeps no name for it — `t_CutterCategory` is empty in the real install — so the reader has its own
// id→name→shape table (`src-tauri/src/catalogue.rs`, `category()`), taken from `/Makera-Parity.md`
// §3. The name it puts in `typeText` is DERIVED from that table, but `typeText` is not just a label:
// `restart.ts` writes it into the job's `;@MKR|TOOL|...|type=` field, and reading that job back runs
// it through `shapeFromType` here in TS. So a `cat:` cutter's shape goes out of Rust and comes back
// through this function, and if the two tables disagree the shape changes silently — or, worse, the
// cutter is refused by the sweep (`cuttingRadiusForSweep`) for a reason that has nothing to do with
// the cutter. A cutter that imports cleanly and then cannot be simulated is the exact failure this
// spec is here to prevent.
//
// The Rust table cannot import this one and this one cannot import it, so the two copies must agree
// by convention. Each says so at its own definition; this is the pair of them held together, and the
// place to edit if either moves.
//
// Pure: one imported function, no wasm, no React, no service.

import { describe, it, expect } from 'vitest';

import { shapeFromType, type ToolShape } from '@/engine/cnc/tool';

/**
 * The eight rows of the reader's table, in its own order: `cutterCategoryId` → the name that goes
 * into `typeText` → the shape the Rust side serves. Kept in this order so a diff against
 * `catalogue.rs`'s `category()` reads down both lists at once.
 */
const CATALOGUE_TYPES: ReadonlyArray<readonly [id: number, typeText: string, shape: ToolShape]> = [
  [0, 'Ball Nose', 'ball'],
  [1, 'Flat End', 'flat'],
  [2, 'Chamfer', 'chamfer'],
  [3, 'Engraving', 'engraving'],
  [4, 'Bull Nose', 'bull'],
  [5, 'Drill', 'drill'],
  [6, 'Thread', 'thread'],
  // 7 is a ball nose that cuts (a 0.5 mm ball on a 6 mm shank, in the real install) — `ball`, not a
  // shape of its own, because the ball IS the geometry and the name says how it is used.
  [7, 'Ball Nose Engraving', 'ball'],
];

describe('the catalogue type names round-trip through shapeFromType', () => {
  it.each(CATALOGUE_TYPES)('category %i, "%s" -> %s', (_id, typeText, shape) => {
    expect(shapeFromType(typeText)).toBe(shape);
  });

  it('names eight distinct categories and no name is served by two of them', () => {
    expect(new Set(CATALOGUE_TYPES.map(([id]) => id)).size).toBe(CATALOGUE_TYPES.length);
    expect(new Set(CATALOGUE_TYPES.map(([, name]) => name)).size).toBe(CATALOGUE_TYPES.length);
  });

  it('covers every shape a cutter can be served as, except the one that means "we do not know"', () => {
    // `unknown` is deliberately absent: an id the reader has no row for is served as
    // `Category <id>` with shape `unknown`, and that string reaches `shapeFromType` as `unknown`
    // — which is what makes the sync's note ("N cutters are in a category this build does not
    // know") and the served shape agree rather than contradict.
    expect(new Set(CATALOGUE_TYPES.map(([, , shape]) => shape))).toEqual(
      new Set(['ball', 'flat', 'chamfer', 'engraving', 'bull', 'drill', 'thread']),
    );
    expect(shapeFromType('Category 9')).toBe('unknown');
  });
});
