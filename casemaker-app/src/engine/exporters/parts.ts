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

/**
 * Assembled one-piece rack exports. These are ALTERNATIVES to the separate
 * parts, not extra parts: the same geometry fused. They belong in the export
 * list, but must be kept out of the 3D view (they would sit exactly on top of
 * the parts they are made from) and out of Save All (which would hand you the
 * rack twice over).
 */
export function isAssembledNodeId(id: string): boolean {
  return id.startsWith('rack-assembled-');
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
  if (id === 'stand') {
    return {
      id,
      displayName: 'Desk stand (frame + foot)',
      material: 'rigid',
      category: 'case',
      printOrientation: CASE_ORIENTATION,
    };
  }
  if (id === 'wall-body') {
    return {
      id,
      displayName: 'Wall mount — body (frame + shroud)',
      material: 'rigid',
      category: 'case',
      printOrientation: CASE_ORIENTATION,
    };
  }
  if (id === 'wall-plate') {
    return {
      id,
      displayName: 'Wall mount — wall plate',
      material: 'rigid',
      category: 'case',
      printOrientation: CASE_ORIENTATION,
    };
  }
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
  if (id.startsWith('latch-pin-')) {
    const suffix = id.slice('latch-pin-'.length);
    return {
      id,
      displayName: `Latch pin ${suffix}`,
      material: 'rigid',
      category: 'fastener',
      printOrientation: FLAT_ORIENTATION,
    };
  }
  if (id.startsWith('rack-')) {
    const RACK_NAMES: Record<string, string> = {
      'rack-side-left': 'Rack side panel — LEFT',
      'rack-side-right': 'Rack side panel — RIGHT',
      'rack-top': 'Rack top plate',
      'rack-bottom': 'Rack bottom plate',
      'rack-wall-cleat': 'Wall cleat (screws to the wall)',
      'rack-wall-spacer': 'Wall spacer strip (bottom)',
      'rack-assembled-frame': 'Rack frame — ASSEMBLED (one piece)',
      'rack-assembled-all': 'Whole rack — ASSEMBLED (one piece)',
    };
    let displayName = RACK_NAMES[id];
    if (!displayName) {
      // Accessory ids: rack-<type>-<index>.
      const m = /^rack-(blank|shelf|keystone|cable-tray)-(\d+)$/.exec(id);
      const label: Record<string, string> = {
        blank: 'Blank faceplate',
        shelf: 'Shelf',
        keystone: 'Keystone patch plate',
        'cable-tray': 'Cable tray',
      };
      displayName = m ? `${label[m[1]!]} ${Number(m[2]) + 1}` : id;
    }
    const structural =
      id.startsWith('rack-side-') ||
      id === 'rack-top' ||
      id === 'rack-bottom' ||
      isAssembledNodeId(id);
    return {
      id,
      displayName,
      material: 'rigid',
      category: structural ? 'case' : 'accessory',
      // The bottom plate has its counterbores facing DOWN in the assembly; it has to be turned
      // over to print them without supports (see PRINT_FLIP_NODE_IDS).
      printOrientation: id === 'rack-bottom' ? LID_ORIENTATION : FLAT_ORIENTATION,
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

/** Human-readable print orientation hint for the export modal. Tells the
 *  user how the part should sit on the bed for a clean print — based on
 *  the same metadata applyLayoutToMeshes uses to lay parts out. */
export function printOrientationHint(part: ProjectPart): string {
  if (part.printOrientation.flipForPrint) {
    if (part.id === 'lid') return 'Print upside-down (lid ceiling on the bed)';
    if (part.id === 'rack-bottom')
      return 'Lay flat, COUNTERBORES UP — the plate is a flat slab, so either face lies flat, but the head seats must face up: printed the other way their floors bridge and the screw head has nothing smooth to bear on. No supports. (This is upside-down from how the bottom plate sits in the rack.)';
    return 'Print upside-down (flipped 180° on X)';
  }
  if (part.id === 'stand') return 'Print FACE DOWN — lay the frame\'s front face on the bed (the foot\'s front edge is flush with it, so the whole front beds flat). The foot and gussets then rise at 75°, self-supporting. Gives a flat, accurate mating face for the panel';
  if (part.id === 'wall-body') return 'Print FACE DOWN — frame\'s front face on the bed, shroud walls rising. No supports';
  if (part.id === 'wall-plate') return 'Print flat, wall-side face DOWN on the bed — the snap fingers point up and print without supports';
  if (part.id === 'shell') return 'Print right-side up (case floor on the bed, walls + cavity opening up)';
  if (part.id.startsWith('latch-arm-')) return 'Lay flat — knuckle and cam hook face up';
  if (part.id.startsWith('latch-pin-')) return 'Stand on end (cap up) for a clean barrel; or lay flat if seam tolerance is OK';
  if (part.id === 'hinge-pin')         return 'Stand on end or lay flat — straight cylinder';
  if (part.id === 'gasket')            return 'Lay flat (TPU 95A — see the *-gasket-print-instructions.txt sidecar)';
  if (part.id.startsWith('bumper-'))   return 'Lay flat — TPU 95A flexible bumper';
  if (part.id === 'rack-assembled-frame')
    return 'One piece, printed standing as it sits in the rack. Needs support throughout the interior — that support is reachable through the open front and the side windows. Expect ~1.1 kg and a multi-day print; a failure late is an expensive one';
  if (part.id === 'rack-assembled-all')
    return 'One piece with the shelves fused in, printed standing. Support under each shelf deck is SEALED INSIDE and can only be worked out through the side vent windows — and the shelf layout becomes permanent. ~1.6 kg. Print the frame-only version first if you have not done this before';
  if (part.id.startsWith('rack-side-'))
    return 'Lay FLAT, inner face down (the face with the plate tab ledges). Wall-mount ears/gussets then rise as self-supporting walls. Strongest layer direction for the screw columns';
  if (part.id === 'rack-top')
    return 'Lay flat, COUNTERBORES UP — flat slab, so it sits flat either way, but the head seats must face up or their floors bridge and give the head nothing smooth to bear on. No supports';
  if (part.id.startsWith('rack-blank-') || part.id.startsWith('rack-keystone-'))
    return 'Front face DOWN on the bed — the end ribs and keystone bosses rise behind it, no supports needed';
  if (part.id.startsWith('rack-shelf-') || part.id.startsWith('rack-cable-tray-'))
    return 'Deck DOWN on the bed — end ribs and comb fingers rise as walls, no supports needed';
  if (part.id === 'rack-wall-cleat')
    return 'Wall-side face DOWN — the 45° bevel prints self-supporting. Screw it to studs with the bevel sloping up toward the wall';
  if (part.id === 'rack-wall-spacer')
    return 'Lay flat, either face down — plain strip, mounts low on the wall so the rack hangs plumb';
  return 'Default orientation';
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
