/**
 * #662 — THE OPERATION TYPES, in one table.
 *
 * The rail entry is the job; the job is an ordered list of OPERATIONS, and every operation has a
 * TYPE. This module is the one place the types are named, ordered and mapped onto what the engine
 * can post — the wizard's first question, the "Add operation" picker and every row's type chip all
 * read it, so the three cannot drift. The set and the wording follow
 * `docs/market-research/OPERATIONS-MATRIX.md` (#663): the UI-reachable operations, plus the one row
 * the engine posts and the UI could not reach (Surface a mesh).
 *
 * WHAT EACH TYPE IS, in the engine's terms:
 *  - `engrave` — text (outline fonts) or single-stroke lines, cut with the job's cutter: labels and
 *    traces, the two sources the maintainer put under one type;
 *  - `v-carve` and `pocket` — one region item, named by the cutter: a V-bit turns a region into a
 *    V-carve (constant-floor V region), any other cutter pockets it flat. Both are OFFERED (the
 *    matrix's UI holds both) and the row's chip states what the job's cutter makes of the item;
 *  - `v-carve-variable` — the same region cut to the MEDIAL-AXIS depth map (#665): the V follows
 *    the design's width down, level by level; where its width runs out the core stands and the
 *    setup's flat end mill pockets it flat in its own program after the V-carve (#677). The
 *    picker adds a rect with the flag; the shape row's fold switches it;
 *  - `inlay` — a V-carve inlay half (#673): the female pocket (the region at its own depth, with
 *    the glue gap on the row) or the male plug's job, which is GENERATED from the female's — the
 *    design mirrored, the complement cut around it (the picker adds the female; the row saves the
 *    male as its own job);
 *  - `profile` — a cut-out through the blank, held with tabs (a cutout item or a through shape);
 *  - `chamfer` — one flat bevel along a profile's part edge or a pocket's rim, cut by the cone's
 *    flank (#669): a `chamfer` item naming its rim, so the bevel follows an edge the job cuts;
 *  - `hole` — a plunge hole or a grid of them (the `drill` / `drill-array` items);
 *  - `bore` — a hole to size, helixed down its wall by the job's end mill (#668): the same
 *    `drill` / `drill-array` items with `mode: 'bore'` and a stated diameter, so a clearance
 *    hole wider than any bit in the box is one operation, not a circle pocket;
 *  - `thread` — a milled internal thread;
 *  - `surface` — a goal mesh or a PNG relief (#672), roughed and ball-finished in 3D (#534). The
 *    engine posts it for a PURE goal job, so the picker offers it only while the list is empty,
 *    and picking it sets the imported object's `role: 'goal'` — the control the UI did not have
 *    (matrix gap A1);
 *  - `texture` — a seeded pattern of short strokes over a region, cut as traces by a V-bit or a
 *    flat end mill (#670): the picker adds a rect carrying a `texture` marker, and the row states
 *    the pattern, pitch, stroke length and seed;
 *  - `flute` — a line whose groove ramps in and out along its ends instead of plunging (#674): the
 *    picker adds a line carrying a `flute` marker, and the row states the ramp;
 *  - `prism` — a shape raised by a V-carve ring around it (#674): the picker adds a rect carrying a
 *    `prism` marker, and the row states the flat base it stands on.
 *
 * NOT offered here, per the matrix (gaps, not omissions): open-path lines from SVG/DXF (#B2),
 * rotary wrap (#B1). Facing is a job option, not an operation type, and stays where it is.
 *
 * Internal names (item kinds, stores, testids) are untouched; this is the operator-facing layer.
 */

import { useEngraveJobStore } from '@/store/engraveJobStore';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { isVShape } from '@/engine/cnc/vProfile';

/** The operation types the wizard, the picker and the row chips share. */
export type OperationTypeId =
  | 'engrave'
  | 'v-carve'
  | 'v-carve-variable'
  | 'inlay'
  | 'pocket'
  | 'profile'
  | 'chamfer'
  | 'hole'
  | 'bore'
  | 'thread'
  | 'surface'
  | 'texture'
  | 'flute'
  | 'prism';

/**
 * #681 — the four groups the wizard's step 4 draws the operations in, in the mockup's order and
 * words (`docs/design/first-job-flow-mockups.html`, station 4). The panel's "Add operation" will
 * read the same table (#685), so the picker has one shape wherever it appears.
 */
export type OperationGroupId = 'engrave-carve' | 'cut-away' | 'holes' | '3d';

export const OPERATION_GROUPS: readonly { id: OperationGroupId; label: string }[] = [
  { id: 'engrave-carve', label: 'Engrave & carve' },
  { id: 'cut-away', label: 'Cut away' },
  { id: 'holes', label: 'Holes' },
  { id: '3d', label: '3D' },
];

export interface OperationTypeDef {
  id: OperationTypeId;
  /** The word a row's chip shows and a picker button reads. */
  label: string;
  /** One line saying what the operation makes. */
  blurb: string;
  /** The historic/host testid its picker button carries. */
  addTestId: string;
  /** Which group of the grouped picker lists it in (#681). */
  group: OperationGroupId;
}

/** The order every picker lists them in — the matrix's own order, the text operation first. */
export const OPERATION_TYPES: readonly OperationTypeDef[] = [
  { id: 'engrave', label: 'Engrave text', blurb: 'Text, or single-stroke lines', addTestId: 'engrave-add-label', group: 'engrave-carve' },
  { id: 'v-carve', label: 'V-carve', blurb: 'A region cut by the job’s V-bit', addTestId: 'engrave-add-v-carve', group: 'engrave-carve' },
  { id: 'v-carve-variable', label: 'V-carve (variable depth)', blurb: 'The V follows the design’s width down to its centre', addTestId: 'engrave-add-v-carve-variable', group: 'engrave-carve' },
  { id: 'inlay', label: 'Inlay', blurb: 'A female pocket, and the male plug to glue into it', addTestId: 'engrave-add-inlay', group: 'engrave-carve' },
  { id: 'pocket', label: 'Pocket', blurb: 'A flat-bottomed region', addTestId: 'engrave-add-rect', group: 'cut-away' },
  { id: 'profile', label: 'Profile', blurb: 'A cut-out through the blank, held with tabs', addTestId: 'engrave-add-profile', group: 'cut-away' },
  { id: 'chamfer', label: 'Chamfer the edge', blurb: 'Break a profile’s or pocket’s edge at an angle', addTestId: 'engrave-add-chamfer', group: 'cut-away' },
  { id: 'hole', label: 'Hole', blurb: 'A hole, or a grid of them', addTestId: 'engrave-add-drill', group: 'holes' },
  { id: 'bore', label: 'Bore to size', blurb: 'A hole wider than the cutter, helixed down its wall', addTestId: 'engrave-add-bore', group: 'holes' },
  { id: 'thread', label: 'Thread', blurb: 'A milled internal thread', addTestId: 'engrave-add-thread', group: 'holes' },
  { id: 'surface', label: 'Surface a mesh', blurb: 'Rough and finish a goal mesh or picture', addTestId: 'engrave-add-surface', group: '3d' },
  { id: 'texture', label: 'Texture a surface', blurb: 'A seeded pattern of short strokes over a region', addTestId: 'engrave-add-texture', group: 'engrave-carve' },
  { id: 'flute', label: 'Flute along a line', blurb: 'A groove that ramps in and out along its ends', addTestId: 'engrave-add-flute', group: 'engrave-carve' },
  { id: 'prism', label: 'Raise a prism', blurb: 'A shape standing on sloped sides, cut by the V-bit', addTestId: 'engrave-add-prism', group: 'engrave-carve' },
];

/** The types in one group, in the table's order. */
export function operationTypesInGroup(group: OperationGroupId): readonly OperationTypeDef[] {
  return OPERATION_TYPES.filter((t) => t.group === group);
}

const BY_ID = new Map(OPERATION_TYPES.map((t) => [t.id, t]));

export function operationType(id: OperationTypeId): OperationTypeDef {
  const found = BY_ID.get(id);
  if (found === undefined) throw new Error(`unknown operation type ${id}`);
  return found;
}

/** The region operation the job's cutter makes: a V-bit carves, anything else pockets. */
export function regionOperationType(cutterIsV: boolean): 'v-carve' | 'pocket' {
  return cutterIsV ? 'v-carve' : 'pocket';
}

/**
 * The operation type of one job item — what its row's chip says. `region` is the one the job's
 * cutter makes ({@link regionOperationType}); `null` for an item that is not an operation (a
 * construction/reference item, a kept-out void, or a mesh used as a reference).
 */
export function operationTypeOfItem(
  item:
    | {
        kind: string;
        through?: boolean;
        construction?: boolean;
        mode?: 'drill' | 'bore';
        vCarveDepth?: 'plane' | 'variable';
        inlay?: { role: 'female' | 'male' };
        texture?: { pattern: string };
        prism?: { baseMm?: number };
        flute?: { rampMm?: number };
      }
    | null
    | undefined,
  region: 'v-carve' | 'pocket',
): OperationTypeId | null {
  if (item === null || item === undefined) return null;
  if (item.construction === true) return null;
  // #674 — a prism reads first (the plan gives its marker precedence), then a texture, then an
  // inlay half; `prism-shape` and `texture-shape` refuse a region carrying two of them.
  if (item.prism !== undefined) return 'prism';
  // #670 — a texture region is cut as a pattern of strokes, not pocketed.
  if (item.texture !== undefined) return 'texture';
  // #673 — an inlay half is its own operation type whatever its role; the row says which half.
  if (item.inlay !== undefined) return 'inlay';
  // #674 — a fluted line is a groove with a ramp, not a plain trace.
  if (item.flute !== undefined) return 'flute';
  switch (item.kind) {
    case 'label':
    case 'trace':
    case 'line':
    case 'stroke-label':
      return 'engrave';
    case 'drill':
    case 'drill-array':
      return item.mode === 'bore' ? 'bore' : 'hole';
    case 'thread':
      return 'thread';
    case 'cutout':
      return 'profile';
    case 'chamfer':
      return 'chamfer';
    case 'rect':
    case 'circle':
    case 'slot':
    case 'polygon':
    case 'vector':
    case 'box':
    case 'cylinder':
    case 'cone':
    case 'sphere':
      if (item.through === true) return 'profile';
      // #665 — a region asking for the medial-axis carve is its own operation, and only a cone
      // makes it a V-carve at all.
      return item.vCarveDepth === 'variable' && region === 'v-carve' ? 'v-carve-variable' : region;
    default:
      return null;
  }
}

/**
 * The region operation THIS job's cutter makes. A row reads it so its chip names what the machine
 * will actually do — a V-bit carves, anything else pockets — rather than what was pressed when the
 * item was added.
 */
export function useRegionOperationType(): 'v-carve' | 'pocket' {
  const job = useEngraveJobStore((s) => s.job);
  const tool = jobTool(job);
  return regionOperationType(tool !== null && isVShape(tool));
}

/** The chip word for a region row: a through region is a profile whatever the cutter. */
export function regionChipLabel(through: boolean | undefined, region: 'v-carve' | 'pocket'): string {
  return through === true ? operationType('profile').label : operationType(region).label;
}

/**
 * Add one operation of `type` to the open job and return its id. Surface a mesh is not here: it
 * needs a FILE, so the caller with the file input handles it (the panel's goal import, #662).
 *
 * The defaults are the store's own add actions — this only says which action a type means, once,
 * for every entry point (the wizard's first step and the panel's Add operation).
 */
export function addOperationOfType(type: Exclude<OperationTypeId, 'surface'>): string {
  const store = useEngraveJobStore.getState();
  switch (type) {
    case 'engrave':
      return store.addLabel();
    case 'v-carve':
    case 'pocket':
      return store.addShape('rect');
    case 'v-carve-variable': {
      // #665 — the same region item with the depth model switched; the row's fold can switch it
      // back to the plane cut.
      const id = store.addShape('rect');
      store.updateShape(id, { vCarveDepth: 'variable' });
      return id;
    }
    case 'inlay': {
      // #673 — a plane V region marked as a FEMALE inlay half; the row states the glue gap and
      // saves the matching male blank as its own job.
      const id = store.addShape('rect');
      store.updateShape(id, { inlay: { role: 'female' } });
      return id;
    }
    case 'texture': {
      // #670 — a rect carrying a STIPPLE marker; the row's fold states the pattern and its
      // numbers, and the depth field is the pattern's floor.
      const id = store.addShape('rect');
      store.updateShape(id, { texture: { pattern: 'stipple' } });
      return id;
    }
    case 'flute': {
      // #674 — a line carrying a FLUTE marker; the row states the ramp, and the depth field is the
      // groove's deepest point.
      const id = store.addTrace('line');
      store.updateTrace(id, { flute: {} });
      return id;
    }
    case 'prism': {
      // #674 — a rect carrying a PRISM marker; the row states the flat base, and the depth field
      // is the shape's standing height.
      const id = store.addShape('rect');
      store.updateShape(id, { prism: {} });
      return id;
    }
    case 'profile':
      return store.addCutout();
    case 'chamfer':
      return store.addChamfer();
    case 'hole':
      return store.addDrill('drill');
    case 'bore':
      return store.addDrill('drill', { mode: 'bore' });
    case 'thread':
      return store.addThread();
  }
}

/**
 * Whether the job carries any operation yet. The wizard asks "What are you cutting?" only when
 * there is nothing to cut: an established job opens straight on its setup questions, and
 * "Edit setup" never re-asks what the work is.
 */
export function jobHasOperations(job: {
  labels?: readonly unknown[];
  shapes?: readonly unknown[];
  traces?: readonly unknown[];
  drills?: readonly unknown[];
  threads?: readonly unknown[];
  primitives?: readonly unknown[];
  cutouts?: readonly unknown[];
  vectors?: readonly unknown[];
  chamfers?: readonly unknown[];
  targetObject?: { role?: 'reference' | 'goal' } | null;
}): boolean {
  const lists = [job.labels, job.shapes, job.traces, job.drills, job.threads, job.primitives, job.cutouts, job.vectors, job.chamfers];
  if (lists.some((list) => (list?.length ?? 0) > 0)) return true;
  return job.targetObject?.role === 'goal';
}
