// @vitest-environment jsdom
// The one-line item row the engrave panel's list is built from (#411): the front cluster (remove,
// show/hide, chevron), the item's name, the one number it has room for, and the editor folded away
// behind the chevron. The maintainer could not find remove — it sat at the far right of a WRAPPING
// second line — so this spec pins the parts that must be on the line whatever the name is.
//
// The layout claim itself ("never wraps away from the name") is CSS, and jsdom computes no layout:
// `engrave.spec.ts` measures the real thing in a browser. What is checkable here is that the line
// carries the controls at all, and that they work from it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngraveItemRow } from '@/components/panels/EngraveItemRow';
import { intentWord, rowSummary } from '@/components/panels/engraveRowText';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { resetEngraveRows } from '@/store/engraveRowStore';

beforeEach(() => {
  resetEngraveRows();
});

afterEach(() => {
  cleanup();
});

const noop = (): void => {};

const finding = (severity: JobFinding['severity'], code: string, message: string): JobFinding => ({
  severity,
  code: code as JobFinding['code'],
  message,
});

interface RowOptions {
  findings?: JobFinding[];
  onRemove?: () => void;
  onToggleEnabled?: (enabled: boolean) => void;
  /** §5.3's intent word. Omitted by default, which is how most kinds call the shell. */
  intent?: string | null;
}

/** One row with an editor in it, so "the body is absent" is a claim about a body that exists when open. */
function row({
  findings = [],
  onRemove = noop,
  onToggleEnabled = noop,
  intent,
}: RowOptions = {}): void {
  render(
    <EngraveItemRow
      id="item-1"
      prefix="engrave-widget"
      index={0}
      glyph="▭"
      kindWord="Widget"
      name="Face"
      summary={rowSummary(0.3)}
      intent={intent}
      enabled
      enabledTitle="A disabled widget is kept in the job but not cut."
      removeTitle="Remove this widget."
      removeNoun="widget"
      findings={findings}
      onToggleEnabled={onToggleEnabled}
      onRemove={onRemove}
    >
      <input data-testid="engrave-widget-body-field" aria-label="a field" />
    </EngraveItemRow>,
  );
}

describe('EngraveItemRow (#411)', () => {
  it('draws the whole line with the editor folded away', () => {
    row();
    // The front cluster: remove first, then show/hide, then the chevron.
    expect(screen.getByTestId('engrave-widget-remove-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-widget-enabled-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-widget-expand-0')).toBeTruthy();
    // …the name, the kind's glyph beside it, and the one number.
    expect(screen.getByText('Face')).toBeTruthy();
    expect(screen.getByText('0.3 mm')).toBeTruthy();
    // The editor is not merely hidden — it is not rendered.
    expect(screen.queryByTestId('engrave-widget-body-field')).toBeNull();
    expect(screen.getByTestId('engrave-widget-expand-0').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the editor on the chevron and folds it again', () => {
    row();
    fireEvent.click(screen.getByTestId('engrave-widget-expand-0'));
    expect(screen.getByTestId('engrave-widget-body-field')).toBeTruthy();
    expect(screen.getByTestId('engrave-widget-expand-0').getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByTestId('engrave-widget-expand-0'));
    expect(screen.queryByTestId('engrave-widget-body-field')).toBeNull();
  });

  it('removes and shows/hides from the collapsed line', () => {
    const removals: number[] = [];
    const toggles: boolean[] = [];
    row({ onRemove: () => removals.push(1), onToggleEnabled: (on) => toggles.push(on) });

    fireEvent.click(screen.getByTestId('engrave-widget-remove-0'));
    expect(removals).toEqual([1]);

    fireEvent.click(screen.getByTestId('engrave-widget-enabled-0'));
    expect(toggles).toEqual([false]);
  });

  it('keeps an error on the line as a count, and draws the sentences when the row is opened', () => {
    // The maintainer's decision on the #411 review: the line stays ONE line, errors included. An
    // earlier pass wrote an error out under the head so the panel's error count would not point at
    // nothing — but that is a paragraph that appears whenever a number is wrong, and ten rows at
    // once is the whole point of the list. So the line carries the count and the tooltip, and the
    // sentences are one press away.
    row({
      findings: [
        finding('error', 'depth-exceeds-stock', 'Too deep for this blank.'),
        finding('warning', 'item-over-void', 'Crosses the magnet pocket.'),
      ],
    });

    // Nothing is written into the collapsed line…
    expect(screen.queryByTestId('engrave-widget-finding-0-depth-exceeds-stock')).toBeNull();
    // …but the ⚠ says both what is wrong and how much of it, and its tooltip has the sentences.
    const warn = screen.getByTestId('engrave-widget-warn-0');
    expect(warn.getAttribute('aria-label')).toBe('1 error and 1 warning');
    expect(warn.getAttribute('title')).toBe('Too deep for this blank.\nCrosses the magnet pocket.');
    // An error is not a warning: the glyph is coloured, so a row that will not cut is not read as
    // one that merely has a note.
    expect(warn.className).toContain('engrave-item-row__warn--error');
  });

  it('draws an error and a warning under the open row, in the order the panel was handed them', () => {
    row({
      findings: [
        finding('error', 'depth-exceeds-stock', 'Too deep for this blank.'),
        finding('warning', 'item-over-void', 'Crosses the magnet pocket.'),
      ],
    });
    fireEvent.click(screen.getByTestId('engrave-widget-expand-0'));

    const error = screen.getByTestId('engrave-widget-finding-0-depth-exceeds-stock');
    expect(error.textContent).toContain('Too deep for this blank.');
    expect(error.className).toContain('engrave-item-row__finding--error');
    const warning = screen.getByTestId('engrave-widget-finding-0-item-over-void');
    expect(warning.textContent).toContain('Crosses the magnet pocket.');
    expect(warning.className).toContain('engrave-item-row__finding--warning');
    expect(error.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has no ⚠ when the item has nothing to warn about', () => {
    row();
    expect(screen.queryByTestId('engrave-widget-warn-0')).toBeNull();
  });

  it('draws the intent word beside the number, and draws nothing where there is no intent', () => {
    // §5.3 — the design's line reads "the depth with its intent word", and the word earns its place
    // because `0.3 mm surface` and `0.3 mm` are different claims about the same digits. Beside the
    // number rather than in a tooltip: a folded list is exactly where that has to be readable.
    row({ intent: 'surface' });
    expect(screen.getByTestId('engrave-widget-intent-0').textContent).toBe('surface');
    // …and beside the number, not somewhere else on the line.
    const summary = screen.getByText('0.3 mm');
    expect(summary.nextElementSibling).toBe(screen.getByTestId('engrave-widget-intent-0'));
    cleanup();

    // A kind with no intent to state draws the span at all — not an empty one. `custom` is the
    // person's own number, and a word on it would claim a provenance it does not have.
    row({ intent: intentWord('custom') });
    expect(screen.queryByTestId('engrave-widget-intent-0')).toBeNull();
    cleanup();

    row();
    expect(screen.queryByTestId('engrave-widget-intent-0')).toBeNull();
  });

  it('maps only the two intents the two-state control itself shows', () => {
    // The line and the control must not be able to disagree about what an intent is called, so the
    // words are the control's own and the rest of the union draws nothing.
    expect(intentWord('surface')).toBe('surface');
    expect(intentWord('reveal')).toBe('reveal');
    expect(intentWord('custom')).toBeNull();
    expect(intentWord(undefined)).toBeNull();
  });

  it('prints the one number at the precision the run sheet uses, without a float tail', () => {
    expect(rowSummary(0.3)).toBe('0.3 mm');
    expect(rowSummary(2)).toBe('2 mm');
    // The band #436 derives arrives as 0.49302855497458753; a line would be unreadable at that.
    expect(rowSummary(0.49302855497458753)).toBe('0.493 mm');
    expect(rowSummary(12.5, '°')).toBe('12.5 °');
  });
});
