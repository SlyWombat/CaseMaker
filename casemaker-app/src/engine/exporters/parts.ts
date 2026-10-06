import type {
  BuildPlan,
  PrintMeta,
  SupportRequirement,
} from '@/engine/compiler/buildPlan';

export type { PrintMeta, SupportRequirement } from '@/engine/compiler/buildPlan';

/** Issue #120 — multi-part workflow redesign. Every project's BuildPlan
 *  has a known set of top-level nodes; this module formalizes them as
 *  user-facing named parts with material, print-orientation, and category
 *  metadata. The visibility pulldown (Toolbar) and export modal (Export
 *  panel) consume the output of `enumerateParts(buildPlan)`.
 *
 *  Categories drive the visibility-toggle grouping and the export modal's
 *  default sort order. Parts within the same category share a header row.
 *
 *  Issue #154 — this module is also the single source of truth for print
 *  guidance (orientation, flip, supports, walls/infill). `PRINT_FLIP_NODE_IDS`
 *  is derived from the same table `partForId` reads, so the exporter and the
 *  displayed hint can no longer disagree.
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
  /** Print-bed orientation (kept for the existing consumers; sourced from the
   *  print table below so it agrees with `PRINT_FLIP_NODE_IDS`). */
  printOrientation: PrintOrientation;
  /** Issue #154 — slicer support this part needs. */
  supports: SupportRequirement;
  /** Why that support level (#154); present whenever `supports !== 'none'`. */
  supportWhy?: string;
  /** Issue #154 — suggested wall loops where structural (starting point). */
  walls?: number;
  /** Issue #154 — suggested infill percent where structural (starting point). */
  infill?: number;
}

// ---------------------------------------------------------------------------
// Issue #154 — the one print table.
//
// Everything the export path needs to know about how a part prints lives here:
// whether it flips for the bed, how much support it needs (and why), the
// floor/wall suggestions for structural parts, and the sentence shown to the
// user. `PRINT_FLIP_NODE_IDS` and `partForId` both read it, so the flip the
// exporter applies and the flip the UI reports cannot drift apart. They DID
// drift: every `rack-*` id except `rack-bottom` was reported `flipForPrint:
// false` while the exporter flipped the two fused frames (the heaviest parts
// in the app) — see the regression test in tests/unit/parts.spec.ts.
//
// PROVISIONAL / drift note: the numbers embedded in the rack hint prose
// (14.6 cm² vs 392 cm² footprint, the 221 × 250 mm plate, the ~1.1 / ~1.6 kg
// mass) are geometry-derived figures frozen as text. Computing them needs the
// op tree, which a pure id-keyed table does not have; they are accepted drift
// until a caller can pass the node, and are called out here rather than
// silently trusted.
// ---------------------------------------------------------------------------

/** A part that lies flat, needs no support, and prints as-modelled. */
function flat(hint: string, extra: Partial<PrintMeta> = {}): PrintMeta {
  return { rotation: [0, 0, 0], flipForPrint: false, supports: 'none', hint, ...extra };
}

/** Exact ids. Insertion order is the order of `PRINT_FLIP_NODE_IDS`. */
const PRINT_TABLE: Record<string, PrintMeta> = {
  shell: flat('Print right-side up (case floor on the bed, walls + cavity opening up)'),
  lid: flat('Print upside-down (lid ceiling on the bed)', { flipForPrint: true }),
  gasket: flat('Lay flat (TPU 95A — see the *-gasket-print-instructions.txt sidecar)'),
  'hinge-pin': flat('Stand on end or lay flat — straight cylinder'),
  stand: flat(
    "Print FACE DOWN — lay the frame's front face on the bed (the foot's front edge is flush with it, so the whole front beds flat). The foot and gussets then rise at 75°, self-supporting. Gives a flat, accurate mating face for the panel",
  ),
  'wall-body': flat(
    "Print FACE DOWN — frame's front face on the bed, shroud walls rising. No supports",
  ),
  'wall-plate': flat(
    'Print flat, wall-side face DOWN on the bed — the snap fingers point up and print without supports',
  ),
  'rack-side-left': flat(
    'Lay FLAT, inner face down (the face with the plate tab ledges). Wall-mount ears/gussets then rise as self-supporting walls. Strongest layer direction for the screw columns',
  ),
  'rack-side-right': flat(
    'Lay FLAT, inner face down (the face with the plate tab ledges). Wall-mount ears/gussets then rise as self-supporting walls. Strongest layer direction for the screw columns',
  ),
  'rack-top': flat(
    'Lay flat, COUNTERBORES UP — flat slab, so it sits flat either way, but the head seats must face up or their floors bridge and give the head nothing smooth to bear on. No supports',
  ),
  'rack-bottom': flat(
    'Lay flat, COUNTERBORES UP — the plate is a flat slab, so either face lies flat, but the head seats must face up: printed the other way their floors bridge and the screw head has nothing smooth to bear on. No supports.',
    {
      flipForPrint: true,
      exportedFlipNote: 'The exported file already comes this way up — drop it straight in.',
    },
  ),
  'rack-wall-cleat': flat(
    'Wall-side face DOWN — the 45° bevel prints self-supporting. Screw it to studs with the bevel sloping up toward the wall',
  ),
  'rack-wall-spacer': flat(
    'Lay flat, either face down — plain strip, mounts low on the wall so the rack hangs plumb',
  ),
  'rack-assembled-frame': flat(
    'Top plate flat on the bed, stacking feet in the air. The other way up only the four feet touch (14.6 cm² against 392 cm²) and the whole 221 × 250 mm bottom plate bridges 5 mm above the bed, so a slicer supports the entire underside. Interior support is still needed and is reachable through the open front and side windows. ~1.1 kg, a multi-day print',
    {
      flipForPrint: true,
      supports: 'buildplate-only',
      supportWhy:
        'Interior overhangs hang over the open frame; every support the slicer needs can grow from the build plate through the front and side windows, so nothing needs support-on-support.',
      exportedFlipNote: 'The exported file already comes this way up — drop it straight in.',
    },
  ),
  'rack-assembled-all': flat(
    'Top plate on the bed as with the frame. Support under each shelf deck is SEALED INSIDE and can only be worked out through the side vent windows, and the shelf layout becomes permanent. ~1.6 kg. Print the frame-only version first if you have not done this before',
    {
      flipForPrint: true,
      supports: 'full',
      supportWhy:
        "Each shelf deck's underside is enclosed by the frame, so support has to build on support inside the sealed cavity instead of reaching the plate.",
      exportedFlipNote: 'The exported file already comes this way up — drop it straight in.',
    },
  ),
  'badge-bottom': flat(
    'Print FLIPPED — the magnet pocket opens UPWARD, so its roof prints on the layer below instead of bridging 45 × 13 mm over the void. The bottom colour',
    {
      flipForPrint: true,
      exportedFlipNote:
        'The exported file already comes this way up — drop it straight in. Print the TOP colour separately and bond the two at the flat face.',
    },
  ),
  'badge-top': flat(
    'Print FLIPPED — engraved face DOWN on the bed, so the engraved detail is the first layer and the split face stays flat. The top colour',
    {
      flipForPrint: true,
      exportedFlipNote:
        'The exported file already comes this way up — drop it straight in. Print the BOTTOM colour separately and bond the two at the flat face.',
    },
  ),
};

/** Id families (rack accessories, latch arms/pins, bumpers). None of these
 *  currently flips; if that ever changes the pattern must be added to a table
 *  entry OR the flip list derivation in the test will flag it. */
interface PrintPattern {
  test: (id: string) => boolean;
  meta: PrintMeta;
}

const PRINT_PATTERNS: PrintPattern[] = [
  {
    test: (id) => id.startsWith('latch-arm-'),
    meta: flat('Lay flat — knuckle and cam hook face up'),
  },
  {
    test: (id) => id.startsWith('latch-pin-'),
    meta: flat('Stand on end (cap up) for a clean barrel; or lay flat if seam tolerance is OK'),
  },
  {
    test: (id) => id.startsWith('bumper-'),
    meta: flat('Lay flat — TPU 95A flexible bumper'),
  },
  {
    test: (id) => /^rack-(blank|keystone)-\d+$/.test(id),
    meta: flat(
      'Front face DOWN on the bed — the end ribs and keystone bosses rise behind it, no supports needed',
    ),
  },
  {
    test: (id) => /^rack-shelf-\d+$/.test(id),
    meta: flat(
      'Deck DOWN on the bed — end ribs and comb fingers rise as walls, no supports needed',
      // A shelf carries gear, so it is the one id family that gets a
      // structural suggestion. Starting point, not a measured value.
      { walls: 4, infill: 25 },
    ),
  },
  {
    test: (id) => /^rack-cable-tray-\d+$/.test(id),
    meta: flat(
      'Deck DOWN on the bed — end ribs and comb fingers rise as walls, no supports needed',
    ),
  },
];

const DEFAULT_PRINT_META: PrintMeta = flat('Default orientation');

/** Print guidance for any node id — the exact table first, then the id
 *  families, then a safe default. Issue #154. */
export function printMetaForId(id: string): PrintMeta {
  return (
    PRINT_TABLE[id] ?? PRINT_PATTERNS.find((p) => p.test(id))?.meta ?? DEFAULT_PRINT_META
  );
}

/**
 * Parts that must be turned over to print cleanly — DERIVED from the table
 * above, never hand-maintained beside it (`exportLayout` re-exports this and
 * the exporter keys its flip off it).
 *
 * The lid prints ceiling-down.
 *
 * The rack plates print COUNTERBORE-UP, and that is the whole reason these
 * entries exist. Each tab screw's head bears on the floor of its counterbore;
 * printed the other way up that floor is a downward-facing ceiling spanning
 * the bore — it bridges, droops, and gives the head nothing flat to seat on.
 * Turned over, the same floor is an ordinary supported top surface.
 *
 * In assembly the BOTTOM plate has its counterbored face pointing down at the
 * underside of the rack, so it is the one that needs turning. The TOP plate is
 * that same part already rotated 180 degrees, so its counterbores face up and
 * it is correct as-modelled. Both therefore reach the bed in the SAME
 * orientation, which is right — they are one printed part.
 *
 * The fused frames print UPSIDE DOWN too. As they stand in the rack the four
 * stacking feet are the only thing touching — 2.3% of the footprint — and the
 * whole bottom plate bridges 5 mm above the bed. That is not a hypothetical:
 * it happened on the first one printed. Turned over, the top plate and rails
 * give a 31% first layer and nothing bridges.
 *
 * This entry has now flipped twice. It is set by which way the counterbores
 * face, nothing else; re-derive it from that if the joint changes again.
 */
export const PRINT_FLIP_NODE_IDS: ReadonlyArray<string> = Object.keys(PRINT_TABLE).filter(
  (id) => PRINT_TABLE[id]!.flipForPrint,
);

/** Display name / material / category for an id — the non-print half of
 *  `partForId`, split out so the print fields come from one place. */
function describePart(
  id: string,
  index: number,
): { displayName: string; material: PartMaterial; category: PartCategory } {
  if (id === 'stand') {
    return { displayName: 'Desk stand (frame + foot)', material: 'rigid', category: 'case' };
  }
  if (id === 'wall-body') {
    return {
      displayName: 'Wall mount — body (frame + shroud)',
      material: 'rigid',
      category: 'case',
    };
  }
  if (id === 'wall-plate') {
    return { displayName: 'Wall mount — wall plate', material: 'rigid', category: 'case' };
  }
  if (id === 'shell') {
    return { displayName: 'Case body', material: 'rigid', category: 'case' };
  }
  if (id === 'lid') {
    return { displayName: 'Lid', material: 'rigid', category: 'case' };
  }
  if (id === 'gasket') {
    return { displayName: 'Gasket (TPU 95A)', material: 'flex', category: 'gasket' };
  }
  if (id === 'hinge-pin') {
    return { displayName: 'Hinge pin', material: 'rigid', category: 'fastener' };
  }
  if (id === 'badge-bottom') {
    return { displayName: 'Badge blank — BOTTOM colour', material: 'rigid', category: 'case' };
  }
  if (id === 'badge-top') {
    return {
      displayName: 'Badge blank — TOP colour (engraved face)',
      material: 'rigid',
      category: 'case',
    };
  }
  if (id.startsWith('latch-arm-')) {
    const suffix = id.slice('latch-arm-'.length);
    return { displayName: `Latch arm ${suffix}`, material: 'rigid', category: 'fastener' };
  }
  if (id.startsWith('latch-pin-')) {
    const suffix = id.slice('latch-pin-'.length);
    return { displayName: `Latch pin ${suffix}`, material: 'rigid', category: 'fastener' };
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
      id.startsWith('rack-side-') || id === 'rack-top' || id === 'rack-bottom' || isAssembledNodeId(id);
    return { displayName, material: 'rigid', category: structural ? 'case' : 'accessory' };
  }
  if (id.startsWith('bumper-')) {
    const suffix = id.slice('bumper-'.length);
    return { displayName: `Bumper ${suffix}`, material: 'flex', category: 'accessory' };
  }
  // Unknown node — best-effort fallback. Display the raw id; treat as rigid.
  return {
    displayName: id || `Part ${index + 1}`,
    material: 'rigid',
    category: 'case',
  };
}

/**
 * Map a node id (string) to a typed ProjectPart. Recognizes the well-known
 * ids emitted by the compiler (shell, lid, hinge-pin, gasket, latch-arm-*,
 * bumper-*). Useful when only the id is in scope (e.g. the live jobStore
 * Map keyed by id without ops attached).
 *
 * Print fields come from the one table above (#154).
 */
export function partForId(id: string, index = 0): ProjectPart {
  const meta = printMetaForId(id);
  const { displayName, material, category } = describePart(id, index);
  return {
    id,
    displayName,
    material,
    category,
    printOrientation: { rotation: meta.rotation, flipForPrint: meta.flipForPrint },
    supports: meta.supports,
    supportWhy: meta.supportWhy,
    walls: meta.walls,
    infill: meta.infill,
  };
}

/** Human-readable print orientation hint for the export modal. Tells the
 *  user how the part should sit on the bed for a clean print — the same
 *  table `PRINT_FLIP_NODE_IDS` is derived from, so the hint can no longer sit
 *  in the wrong branch of a flip check (#154). The trailing "already comes
 *  this way up" sentence applies to the print-ready layout only; see
 *  `printNotesText` for the layout-aware sidecar. */
export function printOrientationHint(part: ProjectPart): string {
  const meta = printMetaForId(part.id);
  return meta.exportedFlipNote ? `${meta.hint} ${meta.exportedFlipNote}` : meta.hint;
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
