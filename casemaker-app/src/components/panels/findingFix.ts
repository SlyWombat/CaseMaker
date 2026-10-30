/**
 * #688 — where a blocking finding's Fix takes the reader, kept out of the panel module so that file
 * exports only its component (react-refresh/only-export-components). The panel opens the GROUP,
 * expands the item's row, opens the fold and focuses the control; a job-level finding with no field
 * of its own (there is none today) still lands on the findings list.
 */

export interface PanelFix {
  group: 'engrave-group-job' | 'engrave-group-cutter' | 'engrave-group-hold';
  /** An item (label/shape/drill/…) whose row the finding names. */
  itemId?: string;
  /** The control to focus once the group and folds are open. */
  focusTestid?: string;
  /** A `<details>` fold to open on the way (`engrave-override`, `engrave-add-menu`). */
  openDetails?: string;
  /**
   * #725 B4 — the fix is in a wizard STEP rather than a field of this panel: the bed's clamp/arm
   * refusals open Holding (the picture where the clamp is dragged), and a rotary job whose blank
   * is not a cylinder opens the Stock step.
   */
  openWizardStep?: 'holding' | 'stock';
}

/**
 * #688 — the control a blocking FINDING names. Most findings point at one item and carry its
 * `labelId`, so the Fix opens that row. The job-level codes are a small closed set with a known
 * home, mapped here rather than guessed from the message.
 *
 * #725 B4 — the bed's generation-time refusals (a clamp in the cut's path, a cut into an arm) are
 * fixed on the Holding step's picture, so those codes open Holding rather than an item row.
 *
 * #725 review — a `rotary-` PREFIX is not a fix: `rotary-unsupported` is per-item (its row), and
 * `rotary-y-off-axis` / `rotary-rapid-engaged` / `rotary-turn-in-stock` are PROGRAM defects of ours
 * (`null`: no Fix at all — never send the operator to re-seat the work for a software gap). Only
 * `rotary-stock` has an operator fix, and it is the Stock step.
 */
export function findingFix(f: { code: string; labelId?: string }): PanelFix | null {
  const code = f.code;
  if (PROGRAM_DEFECT_CODES.has(code)) return null;
  if (HOLD_FIX_CODES.has(code)) {
    return { group: 'engrave-group-hold', openWizardStep: 'holding' };
  }
  if (f.labelId !== undefined) return { group: 'engrave-group-job', itemId: f.labelId };
  if (code === 'rotary-stock') return { group: 'engrave-group-job', openWizardStep: 'stock' };
  if (code === 'tool-missing') return { group: 'engrave-group-cutter', focusTestid: 'engrave-tool' };
  if (code === 'no-items') {
    return { group: 'engrave-group-job', openDetails: 'engrave-add-menu', focusTestid: 'engrave-add-summary' };
  }
  if (code.startsWith('goal-object')) return { group: 'engrave-group-job', focusTestid: 'engrave-target-input' };
  if (code === 'facing-too-deep') return { group: 'engrave-group-job', focusTestid: 'engrave-facing-depth' };
  if (
    code.startsWith('vise-') ||
    code.startsWith('setup-') ||
    code.startsWith('sacrificial-') ||
    code.startsWith('side-strip') ||
    code.startsWith('strip-') ||
    code.startsWith('under-')
  ) {
    return { group: 'engrave-group-hold', openDetails: 'engrave-vise-card', focusTestid: 'engrave-vise-card' };
  }
  return { group: 'engrave-group-job' };
}

/**
 * #725 review — the codes whose refusal is the SOFTWARE's, not the operator's: a rotary program
 * that turns or traverses while the tip is in the cut, leaves the axis, or cannot prove the sector
 * between two indexed positions. The sentence stays (the run's row), but there is no control to
 * offer: asking an operator to re-seat the work for a program defect is the one thing a Fix must
 * never do.
 */
const PROGRAM_DEFECT_CODES: ReadonlySet<string> = new Set([
  'rotary-y-off-axis',
  'rotary-rapid-engaged',
  'rotary-turn-in-stock',
]);

/**
 * #725 B4 — the bed's codes whose fix is the Hold picture (§3.7). `clamp-in-path` and
 * `bracket-in-path` are the verifier's; the tape/board ones are the document gate's. They open
 * the Holding step, where the clamp is dragged and the board chosen.
 */
const HOLD_FIX_CODES: ReadonlySet<string> = new Set([
  'clamp-in-path',
  'bracket-in-path',
  'clamps-overlap',
  'clamp-off-stock',
  'tape-hold-stock',
  'tape-hold-piece',
  'tape-tall-stock',
  'through-needs-board',
  'board-too-small',
]);
