import type { BuildPlan } from '@/engine/compiler/buildPlan';

/** Issue #120 — multi-part workflow redesign. Every project's BuildPlan
 *  has a known set of top-level nodes; this module formalizes them as
 *  user-facing named parts with material, print-orientation, and category
 *  metadata. The visibility pulldown (Toolbar) and export modal (Export
 *  panel) consume the output of `enumerateParts(buildPlan)`.
 *
 *  Categories drive the visibility-toggle grouping and the export modal's
 *  default sort order. Parts within the same category share a header row.
 */
export type PartCategory =
  | 'case'        // shell, lid — the primary structural halves
  | 'gasket'      // TPU rings (#107/#108)
  | 'fastener'    // hinge pin, latch arm — small captive parts
  | 'accessory';  // flex bumpers (#111), TPU corner caps

export type PartMaterial = 'rigid' | 'flex';

export interface PrintOrientation {
  /** Euler degrees applied before laying the part on the print bed. */
  rotation: [number, number, number];
  /**
   * If true, the part flips upside-down for printing — typical for the lid
   * (rim sits on bed, lid plate prints last). Implemented as a 180° rotation
   * around the X axis after the user's rotation.
   */
  flipForPrint: boolean;
}

export interface ProjectPart {
  /** Stable id matching the BuildPlan node id. */
  id: string;
  /** Human label shown in UI. */
  displayName: string;
  /** Print material: rigid (PLA/PETG/ABS) or flex (TPU 95A). */
  material: PartMaterial;
  /** Category for UI grouping. */
  category: PartCategory;
  /** Print-bed orientation. */
  printOrientation: PrintOrientation;
}

const CASE_ORIENTATION: PrintOrientation = { rotation: [0, 0, 0], flipForPrint: false };
const LID_ORIENTATION: PrintOrientation = { rotation: [0, 0, 0], flipForPrint: true };
const FLAT_ORIENTATION: PrintOrientation = { rotation: [0, 0, 0], flipForPrint: false };

/**
 * Map a node id (string) to a typed ProjectPart. Recognizes the well-known
 * ids emitted by the compiler (shell, lid, hinge-pin, gasket, latch-arm-*,
 * bumper-*). Useful when only the id is in scope (e.g. the live jobStore
 * Map keyed by id without ops attached).
 */
export function partForId(id: string, index = 0): ProjectPart {
  if (id === 'shell') {
    return {
      id,
      displayName: 'Case body',
      material: 'rigid',
      category: 'case',
      printOrientation: CASE_ORIENTATION,
    };
  }
  if (id === 'lid') {
    return {
      id,
      displayName: 'Lid',
      material: 'rigid',
      category: 'case',
      printOrientation: LID_ORIENTATION,
    };
  }
  if (id === 'gasket') {
    return {
      id,
      displayName: 'Gasket (TPU 95A)',
      material: 'flex',
      category: 'gasket',
      printOrientation: FLAT_ORIENTATION,
    };
  }
  if (id === 'hinge-pin') {
    return {
      id,
      displayName: 'Hinge pin',
      material: 'rigid',
      category: 'fastener',
      printOrientation: FLAT_ORIENTATION,
    };
  }
  if (id.startsWith('latch-arm-')) {
    const suffix = id.slice('latch-arm-'.length);
    return {
      id,
      displayName: `Latch arm ${suffix}`,
      material: 'rigid',
      category: 'fastener',
      printOrientation: FLAT_ORIENTATION,
    };
  }
  if (id.startsWith('bumper-')) {
    const suffix = id.slice('bumper-'.length);
    return {
      id,
      displayName: `Bumper ${suffix}`,
      material: 'flex',
      category: 'accessory',
      printOrientation: FLAT_ORIENTATION,
    };
  }
  // Unknown node — best-effort fallback. Display the raw id; treat as rigid.
  return {
    id,
    displayName: id || `Part ${index + 1}`,
    material: 'rigid',
    category: 'case',
    printOrientation: CASE_ORIENTATION,
  };
}

/** Walk a BuildPlan and return the typed parts list. Order preserved from
 *  the BuildPlan's node order so consumers can rely on shell-first / lid-
 *  second / extras-last. */
export function enumerateParts(plan: BuildPlan | null | undefined): ProjectPart[] {
  if (!plan) return [];
  return plan.nodes.map((n, i) => partForId(n.id, i));
}

/** Enumerate parts from a flat node-id list — used by the scene + UI which
 *  read jobStore.nodes (a Map keyed by id, no ops attached). */
export function partsForIds(ids: Iterable<string>): ProjectPart[] {
  const out: ProjectPart[] = [];
  let i = 0;
  for (const id of ids) {
    out.push(partForId(id, i++));
  }
  return out;
}

/** Group enumerated parts by category for UI display. Categories appear in
 *  a fixed order; within a category, parts preserve their plan order. */
export function partsByCategory(parts: ProjectPart[]): { category: PartCategory; parts: ProjectPart[] }[] {
  const order: PartCategory[] = ['case', 'gasket', 'fastener', 'accessory'];
  const buckets = new Map<PartCategory, ProjectPart[]>();
  for (const c of order) buckets.set(c, []);
  for (const p of parts) {
    const list = buckets.get(p.category);
    if (list) list.push(p);
  }
  return order
    .map((category) => ({ category, parts: buckets.get(category) ?? [] }))
    .filter((g) => g.parts.length > 0);
}
