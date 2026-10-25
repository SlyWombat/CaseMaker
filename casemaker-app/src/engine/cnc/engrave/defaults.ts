import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { DEFAULT_VISE } from '@/engine/cnc/fixture';
import { Z1 } from '@/engine/cnc/machine';
import { noneSacrificial } from '@/engine/cnc/sacrificial';
import { MARGIN_DEFAULTS, type MarginSettings } from '@/engine/cnc/engrave/depthBounds';
import { newId } from '@/utils/id';
import { NO_TOOL_KEY } from '@/engine/cnc/toolRegistry';
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

/** Fresh thread id (#445). A thread is its own kind of item, so it gets its own prefix. */
export function newEngraveThreadId(): string {
  return newId('thr');
}

/** Fresh 3D primitive id (#435). A primitive is its own kind of item, so it gets its own prefix. */
export function newEngravePrimitiveId(): string {
  return newId('prm');
}

/** Fresh target-object id (#435). There is at most one, but it is an addressable row. */
export function newEngraveTargetObjectId(): string {
  return newId('tgt');
}

/** Fresh profile cut-out id (#218). A cut-out removes a kerf, not a region, and is its own list. */
export function newEngraveCutoutId(): string {
  return newId('cut');
}

/**
 * Fresh under-surface void id (#271). A void is NOT an item — it is a fact about the blank, so it
 * lives in its own list with its own prefix and never reaches the `engraves` pipeline.
 */
export function newEngraveKeepOutId(): string {
  return newId('ko');
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
 *
 * `margins` (#345) is the house's threshold set, and it SEEDS the four per-job fields below —
 * `minFloor`, `edgeMargin`, `breakthrough`, `jawClearance` — which stay the document's own numbers
 * once written. They are a different quantity from the Z-error margins (material that must remain,
 * clearance to an edge, travel into the board, room over the jaws), so they are seeded rather than
 * copied into `job.margins`, which is left ABSENT so the job follows the house setting until
 * someone overrides it.
 */
export function defaultEngraveJob(
  vise: ViseParams = DEFAULT_VISE,
  margins: MarginSettings = MARGIN_DEFAULTS,
): EngraveJob {
  return {
    schemaVersion: 3,
    // #419 — the job's own identity, minted here so a fresh job is a complete document rather than
    // one whose id appears only after a parse. Like the label ids below it, a copy gets its own id.
    id: newId('job'),
    name: 'Untitled job',
    // #347 — the one mill this app models, READ from the profile rather than typed. A job's
    // machine decides which materials the setup offers and which envelope the stock is bounded by,
    // so it has to be stated in the document like every other fact the job runs on.
    machineId: Z1.id,
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
    // #516 item 5 — a fresh job starts with NO cutter: the recommendation is made once the work is
    // in (first Generate / first visit to Tools), so nothing here names `flat-1.0` any more. The
    // empty key is the same "no cutter chosen yet" the `--from-3mf` / badge routes begin from.
    toolKey: NO_TOOL_KEY,
    workholding: {
      kind: 'vise',
      vise: { ...vise },
    },
    // #345 — seeded from the house thresholds rather than from constants. The shipped set is the
    // same 1.0 / 1.0 / 0.3 these lines used to carry, so a fresh install builds the same job.
    minFloor: margins.minFloor,
    edgeMargin: margins.edgeMargin,
    // No sacrificial material: a job that does not use it behaves exactly as before (#213).
    sacrificial: noneSacrificial(),
    breakthrough: margins.breakthrough,
    // #362 — the same 1.0 the check used to hard-code, now a number the job can state.
    jawClearance: margins.jawClearance,
    customFonts: [],
  };
}
