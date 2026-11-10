/**
 * #1098 — THE QUESTION STEP OPENS WITH THE FILE.
 *
 * One full-width drop target above the picker: drop (or choose) a file and the FORMAT decides the
 * operation — a mesh becomes Surface a mesh, an SVG/DXF the outline choice, a PNG the relief, a
 * Gerber set the circuit board. The alternative is the picker below, for work that starts with no
 * file at all.
 *
 * It is deliberately not `WizardFileField`: that control is a field INSIDE one choice, and this one
 * sits over all of them. Both keep the browser's input hidden (the native "No file chosen" line
 * would sit under the name of the file that was chosen — #870's reason).
 */

import { useRef, useState, type JSX } from 'react';

export interface WizardDropZoneProps {
  /** The hidden input's `accept`. */
  accept: string;
  /** The grey line under the heading: the kinds the app reads. */
  kinds: string;
  reading: boolean;
  /** The one-sentence refusal for a file the app does not read. */
  error: string | null;
  onFiles: (files: File[]) => void;
  testId: string;
  inputTestId: string;
  errorTestId: string;
}

export function WizardDropZone(props: WizardDropZoneProps): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const open = (): void => {
    if (!props.reading) input.current?.click();
  };
  return (
    <div
      className={over ? 'sw-file sw-file--drop sw-file--over' : 'sw-file sw-file--drop'}
      data-testid={props.testId}
      data-state={over ? 'over' : props.reading ? 'reading' : 'empty'}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        // The step body is also a drop target (the spec's "whole dialog"); the field that took the
        // drop owns the read, so the bubbled copy must not read the same files twice.
        e.stopPropagation();
        setOver(false);
        const files = [...(e.dataTransfer.files ?? [])];
        if (files.length > 0 && !props.reading) props.onFiles(files);
      }}
    >
      <input
        ref={input}
        type="file"
        hidden
        accept={props.accept}
        data-testid={props.inputTestId}
        aria-label="The file to make"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          // Cleared so picking the same file again fires again (#870).
          e.target.value = '';
          if (files.length > 0) props.onFiles(files);
        }}
      />
      <p className="sw-file__drop-title">Drop your file here</p>
      <p className="sw-file__kinds">{props.kinds}</p>
      <button
        type="button"
        className="sw-btn sw-file__choose"
        data-testid={`${props.testId}-choose`}
        disabled={props.reading}
        onClick={open}
      >
        {props.reading ? 'Reading…' : 'Choose a file…'}
      </button>
      {props.error !== null && (
        <p className="sw-file__error" role="alert" data-testid={props.errorTestId}>
          {props.error}
        </p>
      )}
    </div>
  );
}
