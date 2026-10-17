/**
 * The setups engine's vocabulary (#428, §5.4). Pure data: the stock in its own frame, the removals
 * with the faces they open to, and the setups a 3-axis machine reaches them from.
 *
 * THE STOCK FRAME: X left→right, Y front→back, Z bottom→top, origin at the stock's min corner, mm.
 * A FACE is named for its outward normal: `top` (+Z), `bottom` (−Z), `left` (−X), `right` (+X),
 * `front` (−Y), `back` (+Y). The same six words name the MACHINE's faces once the stock is mounted
 * (machine up is `top`; on the vise the jaws close on machine `left`/`right`).
 */

import type { Mat } from './orient';

export const FACES = ['top', 'bottom', 'left', 'right', 'front', 'back'] as const;
export type Face = (typeof FACES)[number];

export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

/** One removal — a pocket, a hole, a chamfer — as the CAM has already split it. */
export interface Removal {
  id: string;
  name: string;
  /** mm³: what the greedy grouping weighs a direction by. */
  volume: number;
  /** Its extent in the stock frame. */
  box: Box;
  /** The faces it opens to: one for a pocket, two for a through feature. Empty = reachable from nowhere. */
  opensTo: Face[];
  /**
   * A facing pass: it takes a whole layer off the face it opens to, so the stock is THINNER after it
   * (#428 review) — its box's depth comes off that face, and the next setup's height is the new one.
   */
  facing?: boolean;
  /**
   * #429: this removal is ONE connected opening (a single hole, a single slot), so its box is its
   * footprint. Only such a removal is used as a registration reference; a group ("the four holes") is not.
   */
  connected?: boolean;
}

export type Mount = 'vise' | 'bracket' | 'tape';

export interface MountSpec {
  kind: Mount;
  /** Vise: the widest the jaws open, mm (a side setup stands the stock on an edge across them). */
  viseOpeningMm?: number;
  /** Tape / bracket: a sacrificial board under the stock carries a cut face — no `rests-on-cut`. */
  board?: boolean;
}

export interface SetupsInput {
  /** The stock's size in its own frame, mm. */
  stock: { x: number; y: number; z: number };
  removals: Removal[];
  /** The mount for every setup that does not name its own in `mounts`. */
  mount: MountSpec;
  /**
   * Per-setup mounts (maintainer decision, 2026-10-17): the key is the setup's UP FACE, and an entry
   * here wins over `mount`. A job may hold its first setup in the vise and the next on the bracket —
   * one fixture is in the machine at a time, so moving between them is part of the remount, and
   * `remountStep` is told the previous mount to say that in words.
   */
  mounts?: Partial<Record<Face, MountSpec>>;
  /** The face the operator puts up first. Default `top`. */
  firstUp?: Face;
}

/** How the stock sits for one setup: which STOCK face is at each MACHINE face. */
export type Orientation = Record<Face, Face>;

export type FindingCode = 'clamp-on-cut' | 'cuts-clamped-face' | 'rests-on-cut' | 'thin-grip' | 'cannot-seat' | 'unholdable';

export interface SetupFinding {
  code: FindingCode;
  severity: 'error' | 'warning';
  text: string;
  itemIds?: string[];
}

/**
 * The stock entering a setup: its BOUNDS in the stock frame — the original box, less any facing — and
 * every region cut so far (in the stock frame).
 */
export interface StockState {
  bounds: Box;
  cuts: Removal[];
}

/**
 * Mounting the stock for a setup — the remount between setups, or the first mount when setup 1 is not
 * top-up. A DIRECTED STEP that needs its own "done" (Q17).
 */
export interface RemountStep {
  kind: 'remount';
  needsDone: true;
  /** The turn from the previous setup (or from as-supplied, top up), in the machine frame; null = none. */
  rotate: { about: 'x' | 'y'; degrees: 90 | -90 | 180 } | null;
  /** The turn in LANDMARK words, what stays first — what the operator reads. */
  turnWords: string[];
  /** The stock face that goes DOWN. */
  faceDown: Face;
  /** The stock face that goes against the fixed jaw (vise) or the bracket's long arm. */
  faceAgainstReference: Face;
  /**
   * A question about a landmark the app can check, or null when no earlier feature tells a mirrored
   * mount apart — then `mirrorCheck` says so plainly. `correct` is the index of the right answer.
   */
  confirm: { question: string; options: string[]; correct: number } | null;
  mirrorCheck: string | null;
}

export interface Setup {
  index: number;
  faceUp: Face;
  /** How THIS setup holds the stock: `SetupsInput.mounts[faceUp]` when stated, else the input's mount. */
  mount: MountSpec;
  /** The rotation from the stock frame to the machine frame (det +1). */
  rotation: Mat;
  orientation: Orientation;
  itemIds: string[];
  stockBefore: StockState;
  stockAfter: StockState;
  /** The mount step into this setup: the remount, or the first mount when it is not top-up; else null. */
  remount: RemountStep | null;
  findings: SetupFinding[];
}

export interface SetupsPlan {
  setups: Setup[];
  /** Directions the mount cannot hold, with the items stranded there. */
  unholdable: { face: Face; reason: string; itemIds: string[] }[];
  /** Removals no direction reaches (an empty `opensTo`), with why. */
  lost: { itemId: string; reason: string }[];
  /** The rotary, offered when it would help and the stock fits it. */
  rotaryOffer: string | null;
}
