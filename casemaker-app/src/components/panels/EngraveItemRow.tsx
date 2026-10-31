import type { JSX, ReactNode } from 'react';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { useEngraveRowStore } from '@/store/engraveRowStore';
import {
  isEngraveItemSelected,
  selectEngraveItem,
  useViewportStore,
} from '@/store/viewportStore';

/**
 * One line of the engrave panel's item list (#411), for every kind of item.
 *
 * The maintainer reported this list as "very cluttered" and asked that objects "be easily collapsed
 * to a single line"; then that they could not find the remove control, which exists but sat at the
 * far right of a *wrapping* second line on the label row:
 *
 *   > "not near the front where you check to display or not, wraps far away… Put remove beside the
 *   > display checkbox at the front of the one-line collapsed row, on every row kind. Remove must
 *   > never wrap away from the item's name."
 *
 * So the front cluster is the same on every kind — remove, then show/hide, then the chevron — and
 * `flex-wrap: nowrap` with a `min-width: 0` name (`index.css`) makes "never wrap away from the name"
 * a property of the layout rather than a matter of how long the name happens to be.
 *
 * WHAT STAYS IN THE ROW. Everything a kind needs to be *edited* is the caller's `children`, drawn
 * only while the row is open. The shell owns the line: the fold, the two controls at the front, the
 * name, the one-number summary, the intent word beside it (§5.3) and the `⚠`. A kind that wanted a
 * second control up here would be re-deciding what the list looks like; the design's answer is the
 * glyph (`docs/design/cnc-job-workflow.md`).
 *
 * THE LINE IS ONE LINE, ERRORS INCLUDED (the maintainer's decision on the #411 review). An earlier
 * pass wrote an error out under the head so that a row hiding the reason Generate refuses would not
 * leave the panel's error count pointing at nothing — but the whole point of this list is that a
 * person can see ten items at once, and a row that grows a paragraph whenever a number is wrong
 * takes that away. So the collapsed line carries ONE `⚠` whose tooltip holds every finding, error
 * or warning, and the full sentences are drawn when the row is opened — a count is visible, the
 * text is one press away, and the line never moves.
 *
 * The shell draws those sentences, for the seven kinds alike: they had each grown their own copy
 * (warnings only, with the errors promised to a collapsed line that no longer carries them), which
 * is how a warning ended up drawn twice and an error once. One owner, in the body, above the
 * editor — a row is opened BECAUSE of its `⚠`, so what the `⚠` meant is the first thing to read.
 *
 * THE FOLD LIVES IN `engraveRowStore`, not in `useState`, because "collapse all" is a write to
 * every row at once and a row that held its own state could not hear it. It is keyed by the item's
 * own id, so a row keeps its fold across an edit that moves it in the list.
 */

export interface EngraveItemRowProps {
  /** The item's own id — what this row's fold is remembered by. */
  id: string;
  /** The testid stem every row kind already uses: `engrave-label` → `engrave-label-row-3`. */
  prefix: string;
  /** Position in its list; only for the test ids and the `aria-label`s. */
  index: number;
  /** One character for the kind, always drawn. */
  glyph: string;
  /** The kind in a word: the glyph's tooltip, and the `aria-label` stem. */
  kindWord: string;
  /**
   * #662 — the OPERATION TYPE this row is, drawn as a chip beside the name (`Engrave`, `V-carve`,
   * `Pocket`, `Profile`, `Hole`, `Thread`, `Surface a mesh`). Null for a row that is not an
   * operation — a kept-out void, or a mesh the job only references.
   */
  typeLabel?: string | null;
  /**
   * #667 — the rest pair's chip (`rest ⌀1 mm`), drawn beside the type chip when the item's setup
   * names a second cutter. Null on a row with no rest cutter.
   */
  restLabel?: string | null;
  /** What to draw where the mockup has "Face" / "Pocket A": the item's name, or the kind's word. */
  name: string;
  /**
   * Whether this row names an item the engrave PREVIEW can show (#441).
   *
   * The seven item kinds say yes; the void rows of §1b say no, because a declared void is a
   * pocket the blank already has, not an item with a floor in the preview. When yes, the name is
   * its own control — clicking it selects this item for the preview exactly as clicking the
   * item's floor selects and opens its row — and the row carries the selected styling. When no,
   * the name stays inside the fold button, as before.
   */
  selectable?: boolean;
  /** The one number on the right — the depth, or the void's ceiling. */
  summary: string;
  /**
   * The intent word that belongs beside that number (§5.3), or null for the kinds that have none.
   *
   * A plain string rather than the model's union: the shell draws a word, it does not decide what
   * the words are — `intentWord` in `engraveRowText` maps the job's vocabulary to this, and keeping
   * the mapping there is what stops a kind inventing a word of its own.
   */
  intent?: string | null;
  enabled: boolean;
  /** What a disabled item of THIS kind means (the show/hide tooltip). */
  enabledTitle: string;
  /** The remove button's tooltip, in this kind's words. */
  removeTitle: string;
  /**
   * How the remove button addresses the item when it has no name of its own: `Remove label 3`.
   * A named item is addressed by its name instead (#411 review) — "Remove the one I am looking at"
   * is the point of the control, and a kind word plus a number is what the person was reading past.
   */
  removeNoun: string;
  findings: readonly JobFinding[];
  /**
   * #743 P-5 — an optional one-click fix drawn under a finding's sentence (the isolation's finer
   * engraver). Return null for a finding with no action; the row draws nothing then.
   */
  findingAction?: (finding: JobFinding) => ReactNode;
  onToggleEnabled: (enabled: boolean) => void;
  onRemove: () => void;
  /** The editor. Drawn only while the row is open. */
  children: ReactNode;
  /**
   * #687 — engineering detail about this item, drawn in a `Technical` fold under the editor. The
   * V-carve geometry lives here now: it is arithmetic about this item's floor, not a second opinion
   * about which cutter to use. Omitted by kinds with no detail of their own.
   */
  technical?: ReactNode;
}

/** The item in a word or two, for a control that has to say what it acts on: `CASE`, `label 3`. */
function whatOf(name: string, noun: string, n: number): string {
  return name.trim() === '' ? `${noun} ${n}` : name;
}

/**
 * What the `⚠` is worth, in words: `2 warnings`, `1 error and 2 warnings`.
 *
 * An error and a warning are not the same claim — one blocks Generate and one does not — so the
 * count says which, and the tooltip has the sentences.
 */
function findingsLabel(errors: number, warnings: number): string {
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return parts.join(' and ');
}

export function EngraveItemRow({
  id,
  prefix,
  index,
  glyph,
  kindWord,
  typeLabel = null,
  restLabel = null,
  name,
  summary,
  intent = null,
  selectable = false,
  enabled,
  enabledTitle,
  removeTitle,
  removeNoun,
  findings,
  findingAction,
  onToggleEnabled,
  onRemove,
  children,
  technical = null,
}: EngraveItemRowProps): JSX.Element {
  const open = useEngraveRowStore((s) => s.open.has(id));
  const toggle = useEngraveRowStore((s) => s.toggle);
  // #441 — the row is selected when the preview's selection carries its id. The selection lives
  // in `viewportStore` (not here) precisely so a redraw of the preview, which replaces every floor
  // mesh, cannot lose it: nothing in the preview owns the selection, and the row reads the same
  // value the floor's highlight does.
  const selected = useViewportStore((s) => selectable && isEngraveItemSelected(s.selection, id));
  const n = index + 1;
  const what = whatOf(name, removeNoun, n);
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity !== 'error');

  const caret = (
    <span className="engrave-item-row__caret" aria-hidden="true">
      {open ? '▾' : '▸'}
    </span>
  );
  const glyphSpan = (
    <span className="engrave-item-row__glyph" aria-hidden="true" title={kindWord}>
      {glyph}
    </span>
  );

  return (
    <div
      className={`engrave-item-row${enabled ? '' : ' engrave-item-row--hidden'}${
        selected ? ' engrave-item-row--selected' : ''
      }`}
      data-testid={`${prefix}-row-${index}`}
      // #688 — the Generate blocker's Fix finds the row a finding named. The row's test ids are
      // positional (a list index), so they cannot answer "where is THIS item"; its own id can.
      data-item-id={id}
    >
      <div className="engrave-item-row__head">
        <button
          type="button"
          className="engrave-item-row__remove"
          data-testid={`${prefix}-remove-${index}`}
          aria-label={`Remove ${what}`}
          title={removeTitle}
          onClick={onRemove}
        >
          ✕
        </button>
        <label className="engrave-item-row__show" title={enabledTitle}>
          <input
            type="checkbox"
            checked={enabled}
            data-testid={`${prefix}-enabled-${index}`}
            aria-label={`${what} enabled`}
            onChange={(e) => onToggleEnabled(e.target.checked)}
          />
        </label>
        {selectable ? (
          <>
            {/* #441 — the chevron keeps the fold; the NAME is the selection control. They are two
                controls rather than one because a click that opens an editor and a click that
                says "this is the item I am looking at" are different intentions, and the
                preview already draws the distinction: clicking a floor selects AND opens, while
                the chevron only ever folds. */}
            <button
              type="button"
              className="engrave-item-row__expand engrave-item-row__expand--fold"
              data-testid={`${prefix}-expand-${index}`}
              aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} ${what}`}
              title={open ? 'Collapse this item' : 'Show everything this item can be set to'}
              onClick={() => toggle(id)}
            >
              {caret}
              {glyphSpan}
            </button>
            <button
              type="button"
              className={`engrave-item-row__select${
                selected ? ' engrave-item-row__select--selected' : ''
              }`}
              data-testid={`${prefix}-select-${index}`}
              aria-pressed={selected}
              aria-label={`Select ${what} in the preview`}
              title={
                selected
                  ? `${what} is selected in the preview`
                  : `Select ${what} in the preview`
              }
              onClick={() => selectEngraveItem(id)}
            >
              <span className="engrave-item-row__name">{name}</span>
              {typeLabel !== null && (
                <span className="engrave-item-row__op" data-testid={`${prefix}-type-${index}`}>
                  {typeLabel}
                </span>
              )}
              {restLabel !== null && (
                <span className="engrave-item-row__op" data-testid={`${prefix}-rest-chip-${index}`}>
                  {restLabel}
                </span>
              )}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="engrave-item-row__expand"
            data-testid={`${prefix}-expand-${index}`}
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${what}`}
            title={open ? 'Collapse this item' : 'Show everything this item can be set to'}
            onClick={() => toggle(id)}
          >
            {caret}
            {glyphSpan}
            <span className="engrave-item-row__name">{name}</span>
            {typeLabel !== null && (
              <span className="engrave-item-row__op" data-testid={`${prefix}-type-${index}`}>
                {typeLabel}
              </span>
            )}
            {restLabel !== null && (
              <span className="engrave-item-row__op" data-testid={`${prefix}-rest-chip-${index}`}>
                {restLabel}
              </span>
            )}
          </button>
        )}
        <span className="engrave-item-row__summary">{summary}</span>
        {/* §5.3 — the depth's intent word, drawn only by the kinds that state one. It is beside the
            number rather than in the tooltip because "surface" and "custom" are different claims
            about the same digits, and a folded list is where that has to be readable. */}
        {intent !== null && (
          <span className="engrave-item-row__intent" data-testid={`${prefix}-intent-${index}`}>
            {intent}
          </span>
        )}
        {findings.length > 0 && (
          <span
            className={`engrave-item-row__warn${errors.length > 0 ? ' engrave-item-row__warn--error' : ''}`}
            data-testid={`${prefix}-warn-${index}`}
            role="img"
            aria-label={findingsLabel(errors.length, warnings.length)}
            title={findings.map((f) => f.message).join('\n')}
          >
            ⚠
          </span>
        )}
      </div>
      {open && (
        <div className="engrave-item-row__body">
          {/* The sentences the ⚠ is counting. They live here rather than on the line so that the
              line stays a line (the maintainer's decision), and they are drawn in the order the
              panel was handed them. */}
          {findings.map((f, i) => (
            <p
              key={`${f.code}-${i}`}
              className={`engrave-item-row__finding engrave-item-row__finding--${f.severity}`}
              data-testid={`${prefix}-finding-${index}-${f.code}`}
            >
              {f.message}
            </p>
          ))}
          {findings.map((f, i) => {
            const action = findingAction?.(f) ?? null;
            return action === null ? null : (
              <div key={`action-${f.code}-${i}`} data-testid={`${prefix}-finding-action-${index}-${f.code}`} style={{ margin: '2px 0 4px' }}>
                {action}
              </div>
            );
          })}
          {children}
          {technical !== null && (
            <details data-testid={`${prefix}-technical-${index}`} style={{ marginTop: 6 }}>
              <summary style={{ fontSize: 11, color: '#9aa4b0', cursor: 'pointer' }}>Technical</summary>
              <div style={{ marginTop: 4 }}>{technical}</div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
