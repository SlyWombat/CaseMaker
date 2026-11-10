/**
 * #1150 — A DESTRUCTIVE PRESS TAKES TWO, AND THE SECOND ONE NAMES WHAT GOES.
 *
 * The file delete's confirm (`MachineFiles`) is the app's own precedent: the first press only opens
 * a sentence and a danger button; Cancel costs nothing and nothing has been sent. This is that
 * pattern's one implementation, so the five controls that had none — Remove from inventory, Remove
 * this definition, a feed row, Forget this machine, Remove the switch — read and behave the same.
 *
 * The sentence names the thing by the name the screen shows it under (never an internal id), and
 * the confirm button carries the verb, so the second press is the one that means it.
 */
import { useState, type CSSProperties, type JSX } from 'react';

export interface ConfirmPressProps {
  /** The first press's label, e.g. "Remove from inventory". */
  label: string;
  /** What goes, named as the screen names it. Shown on the second press only. */
  sentence: string;
  /** The danger press's label, e.g. "Remove it". */
  confirmLabel: string;
  onConfirm: () => void;
  /** The first press's test id; the confirm/cancel/testids are `-confirm` / `-cancel` / `-sentence`. */
  testId: string;
  disabled?: boolean;
  /** The first press's hover title (the existing explanation, kept where there was one). */
  title?: string;
  style?: CSSProperties;
}

export function ConfirmPress({
  label,
  sentence,
  confirmLabel,
  onConfirm,
  testId,
  disabled = false,
  title,
  style,
}: ConfirmPressProps): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        className="btn btn--sm btn--danger"
        data-testid={testId}
        disabled={disabled}
        title={title}
        style={style}
        onClick={() => setConfirming(true)}
      >
        {label}
      </button>
    );
  }
  return (
    <span
      data-testid={`${testId}-confirming`}
      style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, ...style }}
    >
      <span className="hint" data-testid={`${testId}-sentence`} style={{ flexBasis: '100%' }}>
        {sentence}
      </span>
      <button
        type="button"
        className="btn btn--sm btn--danger"
        data-testid={`${testId}-confirm`}
        onClick={() => {
          setConfirming(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="btn btn--sm" data-testid={`${testId}-cancel`} onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  );
}
