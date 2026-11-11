/**
 * #870 — the wizard's ONE file control: the stock step's stock file, the question's mesh and Gerbers.
 *
 * The browser's own `<input type="file">` is never shown. Its label reads "No file chosen" the
 * moment a step clears it (so the same file can be picked twice), and that sentence sat next to the
 * name of the file that WAS chosen. The input stays in the DOM, hidden, with its test id, so
 * `setInputFiles` and `fireEvent.change` keep working; what the operator sees is drawn here:
 *
 * - empty:   a "Choose a file…" button, and the accepted kinds in grey under it;
 * - reading: the button disabled, reading "Reading…";
 * - chosen:  the name, the read's one fact in grey, and a small Change;
 * - refused: the name stays, the reason in red under it, and the button reads "Choose another…".
 *
 * The whole field is also a drop target. The states are the caller's: it owns the read.
 */

import { useRef, useState, type JSX, type ReactNode } from 'react';

export interface WizardFileFieldProps {
  /** The hidden input's `accept`. */
  accept: string;
  multiple?: boolean;
  /** The hidden input's test id and accessible name (kept from the native control it replaces). */
  inputTestId: string;
  inputLabel: string;
  /** The accepted kinds in words, in grey under the empty button ("STL, 3MF, OBJ, STEP or PNG"). */
  kinds?: string;
  /** The empty state's button. */
  chooseLabel?: string;
  reading: boolean;
  /** What was picked: its name (several files say so) and the read's one fact, if it has one. */
  chosen: { name: string; fact?: string | null } | null;
  /** Why the pick was refused, in a sentence; drawn red. */
  error: string | null;
  onFiles: (files: File[]) => void;
  /** The stock step's variant: the dashed box it has always drawn. */
  drop?: boolean;
  testId?: string;
  nameTestId?: string;
  errorTestId?: string;
  /** Lines under the field that belong to the read (a unit note, the board's notices). */
  children?: ReactNode;
  /** #1099 — the read state's drawing (the file's thumbnail), above the name row. */
  thumbnail?: ReactNode;
}

export function WizardFileField(props: WizardFileFieldProps): JSX.Element {
  const { reading, chosen, error } = props;
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const state = reading ? 'reading' : error !== null ? 'refused' : chosen !== null ? 'chosen' : 'empty';
  const open = (): void => {
    if (!reading) input.current?.click();
  };

  const classes = ['sw-file'];
  if (props.drop === true) classes.push('sw-file--drop');
  if (over) classes.push('sw-file--over');

  return (
    <div
      className={classes.join(' ')}
      data-testid={props.testId}
      data-state={over ? 'over' : state}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = [...(e.dataTransfer.files ?? [])];
        if (files.length > 0 && !reading) props.onFiles(props.multiple === true ? files : files.slice(0, 1));
      }}
    >
      <input
        ref={input}
        type="file"
        hidden
        accept={props.accept}
        multiple={props.multiple}
        data-testid={props.inputTestId}
        aria-label={props.inputLabel}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          // Cleared so picking the same file again fires again; the control is never shown, so
          // the browser's "No file chosen" never reaches the screen.
          e.target.value = '';
          if (files.length > 0) props.onFiles(files);
        }}
      />
      {/* #1099 item 8 — the name row reads FIRST; the drawing follows with its facts beside it,
          so the thumbnail is never the thing standing between the name and its change button. */}
      {chosen !== null && state !== 'reading' && (
        <div className="sw-file__row">
          <span className="sw-file__name" data-testid={props.nameTestId}>
            {chosen.name}
          </span>
          {state === 'chosen' && chosen.fact != null && <span className="sw-file__fact">{chosen.fact}</span>}
          {state === 'chosen' && (
            <button
              type="button"
              className="sw-btn sw-btn--sm"
              data-testid={props.testId === undefined ? undefined : `${props.testId}-change`}
              onClick={open}
            >
              Change
            </button>
          )}
        </div>
      )}
      {chosen !== null && state !== 'reading' && props.thumbnail !== undefined && props.thumbnail}
      {state === 'refused' && (
        <p className="sw-file__error" role="alert" data-testid={props.errorTestId}>
          {error}
        </p>
      )}
      {state !== 'chosen' && (
        <button
          type="button"
          className="sw-btn sw-file__choose"
          data-testid={props.testId === undefined ? undefined : `${props.testId}-choose`}
          disabled={reading}
          onClick={open}
          style={state === 'refused' ? { marginTop: 4 } : undefined}
        >
          {reading ? 'Reading…' : state === 'refused' ? 'Choose another…' : (props.chooseLabel ?? 'Choose a file…')}
        </button>
      )}
      {state === 'empty' && props.kinds !== undefined && <p className="sw-file__kinds">{props.kinds}</p>}
      {props.children}
    </div>
  );
}
