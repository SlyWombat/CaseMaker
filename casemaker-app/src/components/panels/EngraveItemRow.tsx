import type { JSX, ReactNode } from 'react';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { useEngraveRowStore } from '@/store/engraveRowStore';

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
  /** What to draw where the mockup has "Face" / "Pocket A": the item's name, or the kind's word. */
  name: string;
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
  onToggleEnabled: (enabled: boolean) => void;
  onRemove: () => void;
  /** The editor. Drawn only while the row is open. */
  children: ReactNode;
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
  name,
  summary,
  intent = null,
  enabled,
  enabledTitle,
  removeTitle,
  removeNoun,
  findings,
  onToggleEnabled,
  onRemove,
  children,
}: EngraveItemRowProps): JSX.Element {
  const open = useEngraveRowStore((s) => s.open.has(id));
  const toggle = useEngraveRowStore((s) => s.toggle);
  const n = index + 1;
  const what = whatOf(name, removeNoun, n);
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity !== 'error');

  return (
    <div
      className={`engrave-item-row${enabled ? '' : ' engrave-item-row--hidden'}`}
      data-testid={`${prefix}-row-${index}`}
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
        <button
          type="button"
          className="engrave-item-row__expand"
          data-testid={`${prefix}-expand-${index}`}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${what}`}
          title={open ? 'Collapse this item' : 'Show everything this item can be set to'}
          onClick={() => toggle(id)}
        >
          <span className="engrave-item-row__caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="engrave-item-row__glyph" aria-hidden="true" title={kindWord}>
            {glyph}
          </span>
          <span className="engrave-item-row__name">{name}</span>
        </button>
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
          {children}
        </div>
      )}
    </div>
  );
}
