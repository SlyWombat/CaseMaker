import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { DEFAULT_VISE } from '@/engine/cnc/fixture';
import { DEFAULT_BREAKTHROUGH, noneSacrificial } from '@/engine/cnc/sacrificial';
import { newId } from '@/utils/id';
import type { EngraveJob, ViseParams } from '@/types/engraveJob';

/**
 * The default `EngraveJob` and its label-id helper (#200).
 *
 * These live here, not in `src/types/engraveJob.ts`, so that types module stays types-only:
 * a default job needs the font registry and the id generator at runtime, and importing a
 * type should not drag either in.
 */

/**
 * Fresh label id. Same helper the project store uses for `TextLabel` ids
 * (`text-${newId()}`); the prefix differs because the types differ (#200 "Do not").
 */
export function newEngraveLabelId(): string {
  return newId('lbl');
}

/** Fresh shape id (#214), a sibling of `newEngraveLabelId`; both are items downstream. */
export function newEngraveShapeId(): string {
  return newId('shp');
}

/** Fresh trace id (#219). A trace is its own kind of item, so it gets its own prefix. */
export function newEngraveTraceId(): string {
  return newId('trc');
}

/** Fresh drill id (#220). A drill is its own kind of item, so it gets its own prefix. */
export function newEngraveDrillId(): string {
  return newId('drl');
}

/**
 * The CNC-2 acceptance job (#209): three labels at three depths on a softwood blank.
 *
 * Every number carries its reason:
 *
 * - **Stock 100 × 60 × 12, softwood.** The default three-label job has to fit the Z1's
 *   200 × 200 × 100 envelope with room for the vise; 100 × 60 is a common hobby blank and
 *   leaves the 12 mm thickness that makes a 2 mm-deep label land well clear of breakthrough.
 * - **Barlow Bold at every size.** #191 measured what a 1 mm flat end mill leaves of a Barlow
 *   face: 3.9 % of the glyph area at a 4 mm cap height, 88.9 % at 6 mm, 98.8 % at 10 mm. So
 *   8 mm and up survive; a light or serif face at these sizes would lose its thin strokes.
 *   The default job must be one the default cutter can actually make.
 * - **Depths 2.0 / 1.0 / 0.5.** The three-label variable-depth acceptance case. The deepest
 *   is 2.0, leaving 10 mm of floor on a 12 mm blank — far above `minFloor`.
 * - **Positions (50, 43), (50, 26), (50, 10).** Centred in X on the blank; spread front-to-back
 *   in Y so the three cuts do not overlap, the deepest toward the back and the shallowest
 *   toward the operator.
 *
 * PROVISIONAL, awaiting #208: the vise dimensions are published nowhere (/Fabrication.md
 * §7.3), so `vise` defaults to `DEFAULT_VISE` from `fixture.ts` — the one place the five
 * placeholder numbers live. `source: 'default'` says so and `validateJob` warns.
 *
 * `vise` is an OPTIONAL argument so this stays pure: `engraveJobStore` reads the saved
 * measurement from settings and passes `viseForNewJob(settings.fixtures.vise)` in, and a
 * caller with no saved measurement gets the shipped default. A copy is stored so patching the
 * job cannot mutate `DEFAULT_VISE` (or the caller's object).
 */
export function defaultEngraveJob(vise: ViseParams = DEFAULT_VISE): EngraveJob {
  return {
    schemaVersion: 2,
    name: 'Untitled engrave job',
    stock: {
      length: 100, // X — a common hobby blank, fits the Z1's 200 mm X with vise room.
      width: 60, // Y
      thickness: 12, // Z
      material: 'softwood',
    },
    labels: [
      {
        id: newEngraveLabelId(),
        text: 'CASE',
        font: DEFAULT_FONT_ID,
        weight: 'bold',
        size: 14,
        position: { x: 50, y: 43 },
        rotation: 0,
        depth: 2.0,
        enabled: true,
      },
      {
        id: newEngraveLabelId(),
        text: 'MAKER',
        font: DEFAULT_FONT_ID,
        weight: 'bold',
        size: 12,
        position: { x: 50, y: 26 },
        rotation: 0,
        depth: 1.0,
        enabled: true,
      },
      {
        id: newEngraveLabelId(),
        text: 'first chips',
        font: DEFAULT_FONT_ID,
        weight: 'bold',
        size: 8,
        position: { x: 50, y: 10 },
        rotation: 0,
        depth: 0.5,
        enabled: true,
      },
    ],
    // No shape pockets (#214): the shipped acceptance job is the three-label one (#209).
    shapes: [],
    // The 1.0 mm flat end mill in TOOL_LIBRARY. Its lengths are `null` (unknown), so the
    // holder gate will say "cannot be proven" — #208 records the owned cutters' real lengths.
    toolKey: 'flat-1.0',
    workholding: {
      kind: 'vise',
      vise: { ...vise },
    },
    minFloor: 1.0,
    edgeMargin: 1.0,
    // No sacrificial material: a job that does not use it behaves exactly as before (#213).
    sacrificial: noneSacrificial(),
    breakthrough: DEFAULT_BREAKTHROUGH,
    customFonts: [],
  };
}
