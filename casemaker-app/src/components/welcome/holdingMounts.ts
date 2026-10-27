/**
 * #684 — the Holding step's mount model, as pure functions.
 *
 * The step's question is not "which workholding kind?" but "how does THIS stock sit in what is on
 * the machine now?" (§3.4). So every option is computed from the stock's numbers and the location's
 * active bed profile, never from the stock's form word: a 3.81 mm plate on the vise's 3.1 mm ledge
 * stands 0.71 mm proud, a 2 mm sheet would sit below the jaw tops and calls for a waste board under
 * it, and a block taller than the jaws is gripped as a block with its sides free. The board under a
 * thin stock must leave that stock PROUD of the jaw tops too: the thinnest board that does is the
 * default, and when none does the row says how far the stock still sits below.
 *
 * THE MACHINE'S STATE IS READ, NEVER ASKED (principle 8). What is on the pins, the surface under it,
 * the boards and the tape in the house come from the active bed profile — the same records
 * `machineChange.ts` (#693) reads and writes. An option the installed mechanism cannot give is
 * still SHOWN, with its one-line cost and the mount the change wizard needs (`needs the vise off the
 * pins · Change the machine…`). An accessory the house does not own reads `not owned`, and nothing
 * more: there is no fixture to fit and so no change to offer.
 *
 * WHAT THIS BUILD CAN WRITE. The job model holds the stock in the vise, seated three ways; in the
 * rotary module's chuck (#240), which holds ROUND stock only; or on the bed, taped or in the
 * bracket (#709/#715). The three VISE options are always writable; the rotary option is writable
 * when the machine carries it and the stock is round, and says why not when the stock is not
 * (`the rotary holds round stock — say a rod in step 2`). The bed options are writable when
 * NOTHING IS ON THE PINS, and each writes the job's own `workholding` (`tape`, or `bracket` with
 * its clamp places) and the board under it — the model below is what that write and its picture
 * are made of. The top-line Change the machine… is the way out of any other state.
 */

import {
  LEDGE_STEP,
  VISE_FLOOR_DEPTH,
  seatDepth,
} from '@/engine/cnc/fixture';
import { ROD_VISE_MAX_LENGTH_MM } from '@/engine/cnc/stockStart';
import { rotaryFits } from '@/engine/cnc/setups/plan';
import type { SetupAnswers } from '@/engine/cnc/engrave/setupFlow';
import { TAPE_DEFAULTS, defaultBracketHold, defaultTapeHold } from '@/engine/cnc/engrave/jobSetup';
import {
  bracketSettings,
  clampObstacles,
  type BracketSettings,
  type ClampEdge,
  type ClampPlacement,
  type StockSize,
} from '@/engine/cnc/mounts/bracket';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type { BedProfile, FixtureRecord, MachineRecord } from '@/platform/locationClient';
import {
  MACHINE_MOUNT_WORDS,
  accessoryFor,
  activeMountOf,
  activeProfileOf,
  surfaceWords,
  type MachineMountKind,
} from '@/platform/machineChange';
import type { BracketHold, EngraveJob, JobStockForm, TapeHold } from '@/types/engraveJob';

/** The six mounts the step offers, in the mockup's order. */
export type HoldingMount = 'ledge' | 'board' | 'block' | 'bed-tape' | 'bed-bracket' | 'rotary';

/** The three a job can be stored in today: the vise, seated three ways. */
export type ViseHoldingMount = 'ledge' | 'board' | 'block';

export const HOLDING_MOUNTS: readonly HoldingMount[] = [
  'ledge',
  'board',
  'block',
  'bed-tape',
  'bed-bracket',
  'rotary',
];

/** The mockup's labels, verbatim (§3.4). */
export const HOLDING_MOUNT_LABELS: Record<HoldingMount, string> = {
  ledge: 'In the vise, on the jaw ledge',
  board: 'In the vise, on a waste board between the jaws',
  block: 'In the vise, gripped as a block',
  'bed-tape': 'On the bed, taped',
  'bed-bracket': 'On the bed, bracket and clamps',
  rotary: 'In the rotary chuck',
};

/** How the mount reads in the machine-change wizard's "for <job>, <holding>" line. */
export const HOLDING_MOUNT_WORDS: Record<HoldingMount, string> = {
  ledge: 'held in the vise on the jaw ledge',
  board: 'held in the vise on a waste board',
  block: 'held in the vise as a block',
  'bed-tape': 'held on the bed, taped',
  'bed-bracket': 'held in a bracket and clamps on the bed',
  rotary: 'held in the rotary chuck',
};

/** The mechanism an option belongs to: what its picture draws and what it needs on the pins. */
export function mechanismOf(mount: HoldingMount): 'vise' | 'bed' | 'rotary' {
  if (mount === 'bed-tape' || mount === 'bed-bracket') return 'bed';
  if (mount === 'rotary') return 'rotary';
  return 'vise';
}

/** Operator numbers: at most 3 decimals, trailing zeros dropped (§4). */
export function fmt(n: number): string {
  return `${Number(n.toFixed(3))}`;
}

/** The board a thin stock gets when the house has no board of its own to name, mm. */
export const DEFAULT_BOARD_MM = 2;

/** The one option the stock's numbers call for, before the machine has a say. */
export function recommendedMount(stock: { thickness: number }): ViseHoldingMount {
  if (stock.thickness > VISE_FLOOR_DEPTH) return 'block';
  if (stock.thickness < LEDGE_STEP) return 'board';
  return 'ledge';
}

/**
 * How proud a stock on a board of this thickness sits on the jaw ledge, mm: its thickness plus the
 * board under it, less the seat. `seatedProud`'s board case, shared with the board option's hint.
 */
export function boardSeatProud(thickness: number, boardMm: number): number {
  return thickness + boardMm - seatDepth('ledge');
}

/**
 * The board to seat this stock on, mm: the THINNEST house board that leaves the stock PROUD of the
 * jaw tops (`boardSeatProud > 0`). A board that leaves it flush or below the jaws is never the
 * recommendation, so when no house board is thick enough this is the thickest one the house has —
 * the caller then says in one line how far the stock still sits below. With no house board named,
 * the typed default is the only choice there is.
 *
 * `choices` is `boardChoices`: the house's boards, thinnest first.
 */
export function defaultBoardMm(stock: { thickness: number }, choices: readonly BoardChoice[]): number {
  if (choices.length === 0) return DEFAULT_BOARD_MM;
  const proud = choices.find((b) => boardSeatProud(stock.thickness, b.thickness) > 0);
  if (proud !== undefined) return proud.thickness;
  return choices[choices.length - 1]!.thickness;
}

/** The mount the answers are actually in, read off the seat and the board under the part. */
export function currentMount(a: SetupAnswers): ViseHoldingMount {
  if (a.sacrificial.under !== null) return 'board';
  if (a.vise.seat === 'floor') return 'block';
  return 'ledge';
}

/** How proud a mount leaves the stock: its thickness plus the board under it, less the seat. */
export function seatedProud(a: SetupAnswers, mount: ViseHoldingMount = currentMount(a)): number {
  if (mount === 'board') {
    return boardSeatProud(a.stock.thickness, a.sacrificial.under?.thickness ?? DEFAULT_BOARD_MM);
  }
  return a.stock.thickness - seatDepth(mount === 'block' ? 'floor' : 'ledge');
}

/**
 * Write a vise mount: its seat, the board under the part (or none), and the proud value the seat
 * and board give. The write is the operator's asserted setup (`source: 'saved'`), the same tag the
 * panel's own vise edits carry, so a saved number is never silently replaced by a later stock edit.
 */
export function applyMount(
  a: SetupAnswers,
  mount: ViseHoldingMount,
  boardMm: number = a.sacrificial.under?.thickness ?? DEFAULT_BOARD_MM,
): SetupAnswers {
  const thickness = a.stock.thickness;
  const board =
    mount === 'board'
      ? {
          thickness: boardMm,
          // Between the jaws: the board's own edges are the stock's, so it does not push the jaws out.
          overhang: { left: 0, right: 0, front: 0, back: 0 },
          attach: 'tape' as const,
        }
      : null;
  const seat = mount === 'block' ? 'floor' : 'ledge';
  return {
    ...a,
    sacrificial: { ...a.sacrificial, under: board, source: 'saved' },
    vise: {
      ...a.vise,
      seat,
      stockProud: thickness + (board?.thickness ?? 0) - seatDepth(seat),
      source: 'saved',
    },
  };
}

/**
 * Apply the mount the stock calls for, but only to a setup nobody has asserted yet: a shipped
 * default vise (never a saved or measured one) with no board of its own under the part. That is
 * the first arrival at step 3, when the numbers are all there is; a re-entry keeps the operator's
 * setup exactly, and the #231 fix is what corrects a saved value that disagrees with the blank.
 */
export function applyRecommendedMount(a: SetupAnswers, boardMm: number = DEFAULT_BOARD_MM): SetupAnswers {
  if (a.vise.source !== 'default' || a.sacrificial.under !== null) return a;
  const mount = recommendedMount(a.stock);
  if (currentMount(a) === mount) return a;
  return applyMount(a, mount, boardMm);
}

// ── The machine's state, in one line ────────────────────────────────────────────────────────────

export interface MachineNow {
  profile: BedProfile;
  mount: MachineMountKind;
  /** The line's parts: the mount, the surface, the boards, the tape. */
  parts: string[];
  /** The mockup's line: "Vise on the pins · bare bed · 2 mm MDF boards ×4 · tape" (Makera's vise
   * page removes the MDF board before the vise goes on — #717). */
  text: string;
}

function boardWords(board: NonNullable<BedProfile['consumables']>['boards'][number]): string {
  return `${fmt(board.size[2])} mm ${board.material} boards ×${board.count}`;
}

/**
 * What the machine is now, from the active bed profile. Null when this location has no machine
 * record with a described bed — the web build, or a job started before the location was read.
 * The step still works then: the three vise mounts are the app's own model, and the machine-only
 * options are not offered because there is no machine state to change.
 */
export function machineNow(machine: MachineRecord | null): MachineNow | null {
  const profile = activeProfileOf(machine);
  if (profile === null) return null;
  const parts = [MACHINE_MOUNT_WORDS[activeMountOf(machine)], surfaceWords(profile.surface)];
  const consumables = profile.consumables;
  if (consumables !== null) {
    for (const board of consumables.boards) if (board.count > 0) parts.push(boardWords(board));
    if (consumables.tape !== null) parts.push('tape');
  }
  return { profile, mount: activeMountOf(machine), parts, text: parts.join(' · ') };
}

/** One board the house has, as the waste-board choice names it. */
export interface BoardChoice {
  thickness: number;
  material: string;
  count: number;
}

/**
 * The boards the house has, THINNEST FIRST. Order is not the default by itself: the board under a
 * stock too thin for the ledge is the thinnest one that leaves that stock proud (`defaultBoardMm`).
 */
export function boardChoices(profile: BedProfile | null): BoardChoice[] {
  const boards = profile?.consumables?.boards ?? [];
  return boards
    .filter((b) => b.count > 0)
    .map((b) => ({ thickness: b.size[2], material: b.material, count: b.count }))
    .sort((a, b) => a.thickness - b.thickness);
}

// ── The options ────────────────────────────────────────────────────────────────────────────────

export interface MountOption {
  mount: HoldingMount;
  label: string;
  /** The second line when the option is available: what this mount does for this stock. */
  hint: string | null;
  disabled: boolean;
  /** The ONE line when the option is disabled: why, in the operator's words. */
  reason: string | null;
  /** The mount the machine must carry for this option, when the installed mechanism is the blocker. */
  escape: MachineMountKind | null;
  /**
   * #718 — the escape also FITS the bed's bracket (the bed carries none at an anchor yet): the
   * change wizard's request says so, and its fit step writes the placement.
   */
  escapeFitBracket?: boolean;
  /** How the option reads in the machine-change request. */
  holdingWords: string;
}

export interface MountOptionArgs {
  /** The job's machine record, or null when the location has none. */
  machine: MachineRecord | null;
  /** Every accessory the house owns, in the box or checked out. */
  accessories: readonly FixtureRecord[];
  stock: { length: number; width: number; thickness: number };
  /** The board under the part when the mount is board, mm; the typed default when not said. */
  boardMm?: number;
  /** The machine's rotary envelope; the Z1's ⌀80 × 150 when the caller does not say. */
  rotaryEnvelope?: { diameter: number; length: number };
  /**
   * Whether the job's stock is ROUND (#240): a rod in step 2, or a box already in the axis frame.
   * The rotary chuck holds round stock; a plate or a block is refused with the sentence that
   * points back at step 2.
   */
  round?: boolean;
  /** #715 — the tape the job would be held with, for the bed tape option's own line. */
  tape?: TapeHold | null;
}

const Z1_ROTARY_ENVELOPE = { diameter: 80, length: 150 } as const;

/** "needs the vise off the pins" — the cost line, from what is on the pins now. */
function costWords(current: MachineMountKind, needed: MachineMountKind): string {
  if (needed === 'rotary') return 'needs the rotary on the pins';
  if (needed === 'vise') {
    return current === 'rotary' ? 'needs the rotary off the pins' : 'needs the vise on the pins';
  }
  const out = current === 'rotary' ? 'rotary' : 'vise';
  return `needs the ${out} off the pins`;
}

/**
 * The six options, computed from the machine's state and the stock's numbers.
 *
 * With no machine record, only the three vise mounts are offered — the app's own model, not a
 * claim about a bed nobody has described. With one, the machine-only options appear with their
 * cost and escape; the job engine's vise-only limit is the last word only when the machine already
 * carries the mount the option needs.
 */
/**
 * Why a ROUND stock cannot be held in the vise at all, or null (#713 review). A rod stands on its
 * end in the jaws, and the vise's grip is its floor depth, so a rod longer than that has no vise
 * mount — the chuck is the only one. The box says which frame it is in: standing (`D × D × L`, so
 * the THICKNESS is the rod's length) or the chuck's axis frame (`L × D × D`, so the LENGTH is) —
 * the rod's own length is read off the frame, never assumed.
 */
export function rodViseProblem(
  stock: { length: number; width: number; thickness: number },
  round: boolean,
): string | null {
  if (!round) return null;
  // Axis frame: `L × D × D`, so width === thickness and the LENGTH is the rod's. Standing:
  // `D × D × L`, so the THICKNESS is.
  const axisFrame = Math.abs(stock.width - stock.thickness) <= 1e-9;
  const rodLength = axisFrame ? stock.length : stock.thickness;
  if (rodLength <= ROD_VISE_MAX_LENGTH_MM) return null;
  return (
    `the vise holds a rod up to ${fmt(ROD_VISE_MAX_LENGTH_MM)} mm standing on its end — this rod is ` +
    `${fmt(rodLength)} mm; hold it in the rotary chuck`
  );
}

export function mountOptions(args: MountOptionArgs): MountOption[] {
  const { machine, accessories, stock } = args;
  const boardMm = args.boardMm ?? DEFAULT_BOARD_MM;
  const now = machineNow(machine);
  const current: MachineMountKind = now?.mount ?? 'vise';
  const envelope = args.rotaryEnvelope ?? Z1_ROTARY_ENVELOPE;
  const out: MountOption[] = [];

  for (const mount of HOLDING_MOUNTS) {
    const mechanism = mechanismOf(mount);
    const label = HOLDING_MOUNT_LABELS[mount];
    const holdingWords = HOLDING_MOUNT_WORDS[mount];
    const base = { mount, label, holdingWords } as const;

    // No machine described: the vise mounts are the app's own setup; the machine-only ones are not
    // offered (there is no state to read and no change to offer).
    if (now === null) {
      if (mechanism !== 'vise') continue;
      out.push({ ...base, hint: hintFor(mount, stock, boardMm), disabled: false, reason: null, escape: null });
      continue;
    }

    // A fixture the house does not own cannot be fitted at all — no cost, no escape.
    const owned = mechanism === 'bed' ? true : accessoryFor(accessories, mechanism) !== null;
    if (!owned) {
      out.push({ ...base, hint: null, disabled: true, reason: 'not owned', escape: null });
      continue;
    }

    // #713 review — a rod too long for the vise's grip has NO vise mount: it stands on its end in
    // the jaws and the vise holds it only up to its floor depth. The stock's own refusal, so no
    // machine change can fix it; the chuck (or a shorter rod) is the way out.
    if (mechanism === 'vise') {
      const rodProblem = rodViseProblem(stock, args.round === true);
      if (rodProblem !== null) {
        out.push({ ...base, hint: null, disabled: true, reason: rodProblem, escape: null });
        continue;
      }
    }

    // Stock that cannot sit in the mount is the stock's own refusal; a machine change cannot fix it.
    if (mount === 'ledge' && stock.thickness < LEDGE_STEP) {
      const below = LEDGE_STEP - stock.thickness;
      out.push({
        ...base,
        hint: null,
        disabled: true,
        reason: `it would sit ${fmt(below)} mm below the jaw tops`,
        escape: null,
      });
      continue;
    }
    if (mount === 'rotary' && !rotaryFits({ x: stock.length, y: stock.width, z: stock.thickness }, envelope)) {
      out.push({
        ...base,
        hint: null,
        disabled: true,
        reason: `the stock does not fit the rotary's ⌀${fmt(envelope.diameter)} × ${fmt(envelope.length)} mm`,
        escape: null,
      });
      continue;
    }

    // The installed mechanism cannot give this mount as it stands: its cost and the way out.
    // #725 B5 — asking for the BRACKET also asks the wizard to fit it: taking the vise off leaves
    // the bed clear, and the bracket is a second machine change unless the same request carries it
    // (#718's fit step). The bed row without an anchor says the same (below).
    if (current !== mechanism) {
      out.push({
        ...base,
        hint: null,
        disabled: true,
        reason: costWords(current, mechanism),
        escape: mechanism,
        ...(mount === 'bed-bracket' ? { escapeFitBracket: true } : {}),
      });
      continue;
    }

    // #240 — the machine gives the mount, and this job model can hold it: the ROTARY, but only
    // round stock. Rectangular stock is the stock's own refusal, so it carries no machine-change
    // escape — the way out is step 2, not a different mount.
    if (mechanism === 'rotary') {
      if (args.round !== true) {
        out.push({
          ...base,
          hint: null,
          disabled: true,
          reason: 'the rotary holds round stock — say a rod in step 2',
          escape: null,
        });
        continue;
      }
      // #714 — the chuck's own line, the mockup's words: the rod turns, the cutter does not.
      out.push({
        ...base,
        hint: 'the rod turns about X; the cutter stays over it',
        disabled: false,
        reason: null,
        escape: null,
      });
      continue;
    }

    // The bed is a machine mount and a JOB mount (#715): with nothing on the pins the two bed
    // options are real choices, and each says what it does for this stock. The bracket needs the
    // bracket at an anchor on the bed (BM-3's fit step records one; until then the row says so).
    if (mechanism === 'bed') {
      if (mount === 'bed-bracket' && bedAnchor(now.profile) === null) {
        // #718 — the way out is the change wizard's fit step (target `bed`: nothing moves on the
        // pins, the bracket goes on at anchor 1).
        out.push({
          ...base,
          hint: null,
          disabled: true,
          reason: 'needs the bracket at anchor 1',
          escape: 'bed',
          escapeFitBracket: true,
        });
        continue;
      }
      const hint =
        mount === 'bed-tape'
          ? tapeStripsLine(args.tape ?? defaultTapeHold(), stock)
          : bracketHint(now.profile, stock);
      out.push({ ...base, hint, disabled: false, reason: null, escape: null });
      continue;
    }

    out.push({ ...base, hint: hintFor(mount, stock, boardMm), disabled: false, reason: null, escape: null });
  }

  return out;
}

/**
 * The available option's second line, in the mockup's words and with this stock's numbers. The
 * board line is the resulting seat, from `seatedProud`'s board case: a board that still leaves the
 * stock below the jaw tops says so plainly, and never reads as the recommendation.
 */
function hintFor(mount: HoldingMount, stock: { thickness: number }, boardMm: number): string | null {
  switch (mount) {
    case 'ledge': {
      const proud = stock.thickness - LEDGE_STEP;
      if (proud > 0) return `${fmt(stock.thickness)} mm stands ${fmt(proud)} mm proud of the jaws`;
      return 'its top would be level with the jaw tops';
    }
    case 'board': {
      const proud = boardSeatProud(stock.thickness, boardMm);
      if (proud > 0) {
        return `${fmt(stock.thickness)} mm on a ${fmt(boardMm)} mm board stands ${fmt(proud)} mm proud of the jaws`;
      }
      if (proud === 0) return 'level with the jaw tops — a thicker board, or tape it to the bed';
      return `still ${fmt(-proud)} mm below the jaw tops — a thicker board, or tape it to the bed`;
    }
    case 'block':
      return 'the sides free; for a block taller than the jaws';
    default:
      return null;
  }
}

/**
 * The board choice's label for a thickness: the location's board when one matches, else `typed`.
 * Used by the select and by the Technical fold's provenance.
 */
export function boardProvenance(mm: number, choices: readonly BoardChoice[]): 'typed' | 'location' {
  return choices.some((b) => b.thickness === mm) ? 'location' : 'typed';
}

// ── #715: the two bed mounts, as the step writes them ──────────────────────────────────────────
//
// With nothing on the pins the bed's two mounts are the job's REAL choices (`bed-mounts-flow.md`
// §3.2): "On the bed, taped" writes `workholding.tape`, "On the bed, bracket and clamps" writes
// `workholding.bracket` with the job's own clamp places. What is under the part is the active bed
// profile's surface, read and never asked — the step's own line for it is `underWords`.

/** The two mounts a bed job can be held in. */
export type BedMount = 'bed-tape' | 'bed-bracket';

export function isBedMount(mount: HoldingMount): mount is BedMount {
  return mount === 'bed-tape' || mount === 'bed-bracket';
}

/** What is under the part, in the record's words ("wasteboard under", "bare bed"). */
export function underWords(profile: BedProfile | null): string | null {
  return profile === null ? null : surfaceWords(profile.surface);
}

/** The same fact at the FIELD's length (§3.4's "Under it  wasteboard"): "wasteboard" / "bare bed". */
export function underFieldWords(profile: BedProfile | null): string | null {
  const words = underWords(profile);
  return words === null ? null : words.replace(' under', '');
}

/**
 * The tape a bed job starts from: the house roll the profile states (`consumables.tape`), else
 * Makera's 20 mm at its store's ~0.2 mm. A job already taped keeps its own hold — reloading the
 * step shows what the job stores, not a fresh default.
 */
export function bedTapeHold(profile: BedProfile | null, keep: TapeHold | null, insetMm: number = TAPE_DEFAULTS.insetMm): TapeHold {
  if (keep !== null) return { ...keep, where: keep.where === null ? null : { ...keep.where } };
  const roll = profile?.consumables?.tape ?? null;
  if (roll === null) return defaultTapeHold({ ...TAPE_DEFAULTS, insetMm });
  return defaultTapeHold({
    widthMm: roll.widthMm,
    thicknessMm: roll.thicknessMm,
    // #727 F9 — the INSET is the shop's (`tape.insetMm`, seeded at 2), read by the caller; it used
    // to be the hard-coded default even when the house had changed it.
    insetMm,
    provenance: roll.provenance,
  });
}

/**
 * The bracket a bed job starts from: the Makera kit's thin bracket at the bed's anchor (#718 — the
 * anchor the bed records the bracket at, Makera's 1 when it records none) and the default clamps.
 */
export function bedBracketHold(
  stock: { length: number; width: number; thickness: number },
  defaults: ShopDefaults | null,
  keep: BracketHold | null,
  anchor: 1 | 2 = 1,
): BracketHold {
  if (keep !== null) return { ...keep, clamps: keep.clamps.map((c) => ({ ...c })) };
  return { ...defaultBracketHold({ x: stock.length, y: stock.width, z: stock.thickness }, defaults), anchor };
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'] as const;

/**
 * The tape's strips across the stock: `ceil((width − 2 × inset) / tape width)` (§3.4), the last
 * trimmed. Two for the badge's 38.1 mm on the 20 mm roll.
 */
export function tapeStrips(tape: Pick<TapeHold, 'width' | 'inset'>, stock: { width: number }): number {
  const span = Math.max(0, stock.width - 2 * tape.inset);
  return Math.max(1, Math.ceil(span / tape.width));
}

/** The tape's line under its option: "two strips of the 20 mm tape, 2 mm in from every edge". */
export function tapeStripsLine(tape: TapeHold, stock: { width: number }): string {
  const n = tapeStrips(tape, stock);
  const count = n < NUMBER_WORDS.length ? NUMBER_WORDS[n]! : String(n);
  return `${count} ${n === 1 ? 'strip' : 'strips'} of the ${fmt(tape.width)} mm tape, ${fmt(tape.inset)} mm in from every edge`;
}

/** The bed's anchor placement, when the bed carries the bracket: 1 or 2; null when it carries none. */
export function bedAnchor(profile: BedProfile | null): 1 | 2 | null {
  const placement = profile?.placements.find((p) => p.where.kind === 'anchor');
  if (placement === undefined) return null;
  return (placement.where.anchor ?? 1) === 2 ? 2 : 1;
}

/** The bracket option's line: which bracket, at which anchor. */
export function bracketHint(profile: BedProfile | null, _stock: { length: number; width: number }): string {
  return `the plate in the bracket's corner at anchor ${bedAnchor(profile) ?? 1}`;
}

/**
 * Does a profile row's stock class name this stock? The bed wizard's own classes
 * (`bed-profiles.md` S4): `sheet<=3mm`, `plate|block`, `rod|tube`, or a bare form word. A class
 * this build does not understand matches nothing — a preferred mount is a convenience, never a
 * guess about a stock it cannot place.
 */
function stockClassMatches(expr: string, stock: { thickness: number }, form: JobStockForm | null): boolean {
  return expr.split('|').some((alternative) => {
    const word = alternative.trim().toLowerCase();
    if (word === '') return false;
    const bounded = /^([a-z-]+)\s*<=\s*([\d.]+)\s*mm$/.exec(word);
    if (bounded !== null) {
      const cls = bounded[1]!;
      // "sheet" is the thin member of the plate family: a plate no thicker than the bound is
      // the same stock class, which is how a 2 mm plate gets tape.
      const fits = form === cls || (cls === 'sheet' && (form === 'plate' || form === 'sheet'));
      return fits && stock.thickness <= Number(bounded[2]);
    }
    if (word === 'tube') return form === 'rod';
    return form === word;
  });
}

/** The mount the active profile prefers for this stock, among those the bed can give as it stands. */
export function preferredBedMount(
  profile: BedProfile | null,
  stock: { thickness: number },
  form: JobStockForm | null,
): BedMount | null {
  for (const row of profile?.preferredMounting ?? []) {
    if (!stockClassMatches(row.stock, stock, form)) continue;
    if (row.mount.manner === 'tape') return 'bed-tape';
    if (row.mount.manner === 'corner+clamps' && bedAnchor(profile) !== null) return 'bed-bracket';
  }
  return null;
}

/**
 * The bed mount a job gets when nobody has chosen one (§3.2): the profile's preferred mount when
 * it names this stock and the bed carries it; else sheet ≤ 3 mm on tape, plates and blocks in the
 * bracket, and tape when the bed has no bracket at an anchor. On the house's profile after the
 * vise comes off, that is tape.
 */
export function defaultBedMount(
  profile: BedProfile | null,
  stock: { thickness: number },
  form: JobStockForm | null,
): BedMount {
  const preferred = preferredBedMount(profile, stock, form);
  if (preferred !== null) return preferred;
  if (stock.thickness <= 3) return 'bed-tape';
  return bedAnchor(profile) === null ? 'bed-tape' : 'bed-bracket';
}

/** How far the bracket's arms stand above the stock's top, mm — negative when they sit below it. */
export function armsAboveStock(
  stock: { thickness: number },
  underMm: number,
  settings: BracketSettings,
): number {
  return Math.round((settings.height - stock.thickness - underMm) * 1000) / 1000;
}

/** A clamp's landmark sentence, from the one owner of that label (`clampObstacles`). */
export function clampLabelFor(
  stock: { length: number; width: number; thickness: number },
  placement: ClampPlacement,
  settings: BracketSettings,
): string {
  const size: StockSize = { x: stock.length, y: stock.width, z: stock.thickness };
  return clampObstacles(size, [placement], settings)[0]!.label;
}

/**
 * #725 W1 — the Design panel's Hold line for a bed job (§3.7's three lines): the mount, the surface
 * under the stock, the board when one is under it, and the mount's own facts — never the vise's.
 * Null for a rotary or vise job, whose own lines the panel draws.
 */
export function bedHoldLine(
  job: Pick<EngraveJob, 'workholding' | 'stock' | 'sacrificial'>,
  profile: BedProfile | null,
  defaults: ShopDefaults | null,
): string | null {
  const held = job.workholding;
  if (held.kind === 'tape') {
    const under = underWords(profile) ?? 'the bed';
    const board =
      job.sacrificial.under === null ? '' : `a ${fmt(job.sacrificial.under.thickness)} mm board under · `;
    return `On the bed, taped · ${under} · ${board}${fmt(held.tape.width)} mm tape · ${tapeWhereWords(held.tape)}`;
  }
  if (held.kind === 'bracket') {
    const settings = bracketSettings(defaults).settings;
    const count = held.bracket.clamps.length;
    const edges = [...new Set(held.bracket.clamps.map((c) => c.edge))];
    const edgeWords = edges.length === 1 ? `on the ${edges[0]} edge` : 'on the back and right edges';
    return (
      `Bracket at anchor ${held.bracket.anchor} · ${count} clamp${count === 1 ? '' : 's'} ${edgeWords}, ` +
      `${fmt(settings.clamp.height)} mm tall · X 0 Y 0 at its corner`
    );
  }
  return null;
}

/** The thinnest house board a through cut needs on this surface, mm; null when the house has none. */
export function defaultBedBoardMm(profile: BedProfile | null, needMm: number): number | null {
  const boards = (profile?.consumables?.boards ?? [])
    .filter((b) => b.count > 0 && b.size[2] >= needMm)
    .sort((a, b) => a.size[2] - b.size[2]);
  return boards[0]?.size[2] ?? null;
}

/** Does this job cut through its stock anywhere (a through shape, a cut-out, a through drill)? */
export function jobHasThroughCut(job: Pick<EngraveJob, 'shapes' | 'cutouts' | 'drills'>): boolean {
  if (job.shapes.some((s) => s.enabled && s.through === true)) return true;
  if ((job.cutouts ?? []).some((c) => c.enabled)) return true;
  return (job.drills ?? []).some((d) => d.enabled && d.through);
}

/** Where the tape expects the stock: the middle of the bed, or the corner it was dragged to. */
export function tapeWhereWords(tape: TapeHold): string {
  if (tape.where === null) return 'the middle of the bed';
  return `X ${fmt(tape.where.x)} · Y ${fmt(tape.where.y)} mm on the bed`;
}

// ── The picture's own geometry, as pure arithmetic ─────────────────────────────────────────────
//
// The bed pictures are schematic, but their HANDLES are the model: a clamp dragged on the picture
// lands at a place in the work frame, and the same arithmetic draws it back. These functions are
// the one mapping both use, so a test can pin the drag without a browser.

/** A rectangle in the picture's own units (SVG user units). */
export interface PictureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Where (px, py) sits on a stock drawn as `rect`, mm from its front-left corner (X right, Y back). */
export function stockPointFromPicture(
  rect: PictureRect,
  stock: { length: number; width: number },
  px: number,
  py: number,
): { x: number; y: number } {
  const sx = rect.w === 0 ? 1 : stock.length / rect.w;
  const sy = rect.h === 0 ? 1 : stock.width / rect.h;
  return { x: (px - rect.x) * sx, y: (rect.y + rect.h - py) * sy };
}

/**
 * The placement a clamp takes when it is dragged to (px, py): the edge it is nearer of the two
 * free ones (back and right), and its centre along that edge clamped to the edge's own length —
 * which still lets it hang past an end, the mount check that refuses a clamp that would not hold.
 */
export function clampPlacementAtPointer(
  rect: PictureRect,
  stock: { length: number; width: number },
  px: number,
  py: number,
): ClampPlacement {
  const p = stockPointFromPicture(rect, stock, px, py);
  const edge: ClampEdge = stock.width - p.y <= stock.length - p.x ? 'back' : 'right';
  const len = edge === 'back' ? stock.length : stock.width;
  const at = Math.min(len, Math.max(0, edge === 'back' ? p.x : p.y));
  return { edge, at: r3(at) };
}

/**
 * The stock's expected front-left corner (machine XY) when the stock is dragged to (px, py) on a
 * surface drawn as `rect`: the pointer takes the stock's middle, and the stock stays on the
 * surface.
 */
export function tapeWhereAtPointer(
  rect: PictureRect,
  stock: { length: number; width: number },
  surface: { length: number; width: number; frontLeft: [number, number] },
  px: number,
  py: number,
): { x: number; y: number } {
  const p = stockPointFromPicture(rect, surface, px, py);
  const x = Math.min(Math.max(0, surface.length - stock.length), Math.max(0, p.x - stock.length / 2));
  const y = Math.min(Math.max(0, surface.width - stock.width), Math.max(0, p.y - stock.width / 2));
  return { x: r3(surface.frontLeft[0] + x), y: r3(surface.frontLeft[1] + y) };
}

/** The stock's rect on a surface drawn as `rect`: centred when `where` is null, else where it is. */
export function stockRectFor(
  rect: PictureRect,
  stock: { length: number; width: number },
  surface: { length: number; width: number; frontLeft: [number, number] },
  where: { x: number; y: number } | null,
): PictureRect {
  const sx = surface.length === 0 ? 1 : rect.w / surface.length;
  const sy = surface.width === 0 ? 1 : rect.h / surface.width;
  const w = Math.max(0, stock.length * sx);
  const h = Math.max(0, stock.width * sy);
  if (where === null) return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
  const x = Math.min(Math.max(rect.x, rect.x + (where.x - surface.frontLeft[0]) * sx), rect.x + rect.w - w);
  const y = Math.min(Math.max(rect.y, rect.y + rect.h - (where.y - surface.frontLeft[1]) * sy - h), rect.y + rect.h - h);
  return { x, y, w, h };
}

/** The tape's strips under a stock drawn as `stockRect`, along its length, the last trimmed. */
export function tapeStripRects(
  stockRect: PictureRect,
  stock: { length: number; width: number },
  tape: Pick<TapeHold, 'width' | 'inset'>,
): PictureRect[] {
  const sx = stockRect.w === 0 ? 1 : stockRect.w / stock.length;
  const sy = stockRect.h === 0 ? 1 : stockRect.h / stock.width;
  const out: PictureRect[] = [];
  for (let i = 0; i < tapeStrips(tape, stock); i++) {
    const y0 = tape.inset + i * tape.width;
    const y1 = Math.min(tape.inset + (i + 1) * tape.width, stock.width - tape.inset);
    if (y1 <= y0) continue;
    out.push({
      x: stockRect.x + tape.inset * sx,
      y: stockRect.y + stockRect.h - y1 * sy,
      w: Math.max(0, stock.length - 2 * tape.inset) * sx,
      h: (y1 - y0) * sy,
    });
  }
  return out;
}

/** A clamp's rect on a stock drawn as `stockRect`: it reaches `reach` mm onto the stock. */
export function clampRectFor(
  stockRect: PictureRect,
  stock: { length: number; width: number },
  clamp: { width: number; length: number; reach: number },
  p: ClampPlacement,
): PictureRect {
  const sx = stockRect.w === 0 ? 1 : stockRect.w / stock.length;
  const sy = stockRect.h === 0 ? 1 : stockRect.h / stock.width;
  if (p.edge === 'back') {
    const yMin = stock.width - clamp.reach;
    return {
      x: stockRect.x + (p.at - clamp.width / 2) * sx,
      y: stockRect.y + stockRect.h - (yMin + clamp.length) * sy,
      w: clamp.width * sx,
      h: clamp.length * sy,
    };
  }
  const xMin = stock.length - clamp.reach;
  return {
    x: stockRect.x + xMin * sx,
    y: stockRect.y + stockRect.h - (p.at + clamp.width / 2) * sy,
    w: clamp.length * sx,
    h: clamp.width * sy,
  };
}

/** The stock's rect centred in `rect`, its aspect kept and at most `fill` of the frame. */
export function centredStockRect(
  rect: PictureRect,
  stock: { length: number; width: number },
  fill = 0.6,
): PictureRect {
  const scale = Math.min(
    (rect.w * fill) / Math.max(stock.length, 1e-9),
    (rect.h * fill) / Math.max(stock.width, 1e-9),
  );
  const w = stock.length * scale;
  const h = stock.width * scale;
  return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
}
