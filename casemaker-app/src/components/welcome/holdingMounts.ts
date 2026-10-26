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
 * WHAT THIS BUILD CAN WRITE. The job engine holds a vise and only a vise (`workholding.kind` is
 * `'vise'`), so the three VISE options are the ones `applyMount` can write. The bed and rotary
 * options are offered because the machine and the design have them, but while the machine already
 * gives one of them the option says what the job will actually do — `held in the vise` — rather
 * than pretending a selection would change the cut. The top-line Change the machine… is the way
 * out either way.
 */

import {
  LEDGE_STEP,
  VISE_FLOOR_DEPTH,
  seatDepth,
} from '@/engine/cnc/fixture';
import { rotaryFits } from '@/engine/cnc/setups/plan';
import type { SetupAnswers } from '@/engine/cnc/engrave/setupFlow';
import type { BedProfile, FixtureRecord, MachineRecord } from '@/platform/locationClient';
import {
  MACHINE_MOUNT_WORDS,
  accessoryFor,
  activeMountOf,
  activeProfileOf,
  surfaceWords,
  type MachineMountKind,
} from '@/platform/machineChange';

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
  /** The mockup's "Vise on the pins · wasteboard under · 2 mm MDF boards ×4 · tape". */
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
    if (current !== mechanism) {
      out.push({
        ...base,
        hint: null,
        disabled: true,
        reason: costWords(current, mechanism),
        escape: mechanism,
      });
      continue;
    }

    // The machine gives the mount, but this build's job model holds the stock in the vise.
    if (mechanism !== 'vise') {
      out.push({ ...base, hint: null, disabled: true, reason: 'the job is held in the vise', escape: null });
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
