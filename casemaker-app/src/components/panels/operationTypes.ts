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
 *  - `profile` — a cut-out through the blank, held with tabs (a cutout item or a through shape);
 *  - `hole` — a plunge hole or a grid of them (the `drill` / `drill-array` items);
 *  - `bore` — a hole to size, helixed down its wall by the job's end mill (#668): the same
 *    `drill` / `drill-array` items with `mode: 'bore'` and a stated diameter, so a clearance
 *    hole wider than any bit in the box is one operation, not a circle pocket;
 *  - `thread` — a milled internal thread;
 *  - `surface` — a goal STL/3MF, roughed and ball-finished in 3D (#534). The engine posts it for a
 *    PURE goal job, so the picker offers it only while the list is empty, and picking it sets the
 *    imported mesh's `role: 'goal'` — the control the UI did not have (matrix gap A1).
 *
 * NOT offered here, per the matrix (gaps, not omissions): open-path lines from SVG/DXF (#B2),
 * variable-depth V-carve (#B3), rotary wrap (#B1), greyscale image relief (#B4). Facing is a job
 * option, not an operation type, and stays where it is.
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
  | 'pocket'
  | 'profile'
  | 'hole'
  | 'bore'
  | 'thread'
  | 'surface';

export interface OperationTypeDef {
  id: OperationTypeId;
  /** The word a row's chip shows and a picker button reads. */
  label: string;
  /** One line saying what the operation makes. */
  blurb: string;
  /** The historic/host testid its picker button carries. */
  addTestId: string;
}

/** The order every picker lists them in — the matrix's own order, the text operation first. */
export const OPERATION_TYPES: readonly OperationTypeDef[] = [
  { id: 'engrave', label: 'Engrave', blurb: 'Text, or single-stroke lines', addTestId: 'engrave-add-label' },
  { id: 'v-carve', label: 'V-carve', blurb: 'A region cut by the job’s V-bit', addTestId: 'engrave-add-v-carve' },
  { id: 'pocket', label: 'Pocket', blurb: 'A flat-bottomed region', addTestId: 'engrave-add-rect' },
  { id: 'profile', label: 'Profile', blurb: 'A cut-out through the blank, held with tabs', addTestId: 'engrave-add-profile' },
  { id: 'hole', label: 'Hole', blurb: 'A hole, or a grid of them', addTestId: 'engrave-add-drill' },
  { id: 'bore', label: 'Bore to size', blurb: 'A hole wider than the cutter, helixed down its wall', addTestId: 'engrave-add-bore' },
  { id: 'thread', label: 'Thread', blurb: 'A milled internal thread', addTestId: 'engrave-add-thread' },
  { id: 'surface', label: 'Surface a mesh', blurb: 'Rough and finish a goal STL/3MF', addTestId: 'engrave-add-surface' },
];

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
  item: { kind: string; through?: boolean; construction?: boolean; mode?: 'drill' | 'bore' } | null | undefined,
  region: 'v-carve' | 'pocket',
): OperationTypeId | null {
  if (item === null || item === undefined) return null;
  if (item.construction === true) return null;
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
    case 'rect':
    case 'circle':
    case 'slot':
    case 'polygon':
    case 'vector':
    case 'box':
    case 'cylinder':
    case 'cone':
    case 'sphere':
      return item.through === true ? 'profile' : region;
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
    case 'profile':
      return store.addCutout();
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
  targetObject?: { role?: 'reference' | 'goal' } | null;
}): boolean {
  const lists = [job.labels, job.shapes, job.traces, job.drills, job.threads, job.primitives, job.cutouts, job.vectors];
  if (lists.some((list) => (list?.length ?? 0) > 0)) return true;
  return job.targetObject?.role === 'goal';
}
