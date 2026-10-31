/**
 * The remount page (§5.4, #471): the mount or turn between two setups, as STEPS the operator reads
 * and ONE landmark question they answer.
 *
 * The words and the question are the engine's (`describeRemount` / `checkRemountAnswer`); this
 * component only holds the answer being picked and refuses a wrong one with the engine's reason.
 * The "done" flag belongs to the CALLER — authoring uses it to approve the remount for the job,
 * the run flow (#419 slice 3) uses it to move the release on — so the page reports "it is mounted"
 * and never writes a store itself.
 *
 * A page with no question is the `mirrorCheck` case: no earlier feature can tell the mount from its
 * mirror image, the engine says so plainly, and Done is enabled with that caveat rather than
 * pretending a confirmation took place.
 */

import { createPortal } from 'react-dom';
import { useState, type CSSProperties, type JSX } from 'react';
import { checkRemountAnswer, describeRemount } from '@/engine/cnc/setups';
import type { MountSpec, Setup } from '@/engine/cnc/setups';
import type { JobSetupRemount } from '@/types/engraveJob';

const OVERLAY: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 'var(--cm-z-modal)', // the one stacking scale (#348), src/styles/tokens.css
  background: 'rgba(8, 11, 15, 0.72)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};
const BOX: CSSProperties = {
  width: 'min(460px, 100%)',
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',
  background: '#141a21',
  border: '1px solid #2a2f36',
  borderRadius: 6,
  padding: 12,
  color: '#d1d5db',
};
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };

export function EngraveRemountPage({
  setup,
  total,
  mount,
  onClose,
  onMounted,
  doneLabel = 'It is mounted',
  preview,
}: {
  /** The engine's setup: its `remount` step carries the words and the question. */
  setup: Setup;
  /**
   * #723 P2-3 — THE FLIP PREVIEW: the stock's own rectangle and, when the job states them, the
   * two locating pins. The page draws the turn only when the step really has one, so a same-face
   * remount never shows a flip it is not.
   */
  preview?: {
    length: number;
    width: number;
    pins: readonly { x: number; y: number }[] | null;
  };
  /** How many setups the job has, for the title ("setup 2 of 3"). */
  total: number;
  mount: MountSpec;
  onClose: () => void;
  /** The caller's "done": fired once, with the remount the job should store on approval. */
  onMounted: (remount: JobSetupRemount) => void;
  doneLabel?: string;
}): JSX.Element | null {
  const described = describeRemount(setup, total, mount);
  const [answer, setAnswer] = useState<number | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [reported, setReported] = useState(false);

  if (described === null || setup.remount === null) return null;
  const step = setup.remount;

  function done(): void {
    if (reported) return;
    if (described!.confirm !== null) {
      if (answer === null) return;
      const check = checkRemountAnswer(step, answer);
      if (!check.ok) {
        setRefusal(check.reason);
        return;
      }
    }
    setRefusal(null);
    setReported(true);
    onMounted({ instruction: [...described!.steps], confirm: described!.confirm });
  }

  return createPortal(
    <div style={OVERLAY} data-testid="engrave-remount-page">
      <div style={BOX} role="dialog" aria-label={described.title}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* The design's own words, matching the run sheet and the release step. */}
          <b style={{ flex: 1, fontSize: 13 }} data-testid="engrave-remount-title">
            {described.title}
          </b>
          <button type="button" data-testid="engrave-remount-close" onClick={onClose}>
            Close
          </button>
        </div>

        {step.rotate !== null && preview !== undefined && (() => {
          const { length, width, pins } = preview;
          // The flip line: through both pins when the job states them, else the stock's centre
          // about the stated axis. SVG's y runs down; the stock frame's y runs up.
          const alongX = step.rotate.about === 'x';
          const lineAt =
            pins !== null && pins.length === 2
              ? alongX
                ? pins[0]!.y
                : pins[0]!.x
              : alongX
                ? width / 2
                : length / 2;
          return (
            <figure data-testid="engrave-remount-preview" style={{ margin: '8px 0 0' }}>
              <svg
                viewBox={`0 0 ${length} ${width}`}
                width="100%"
                role="img"
                aria-label={`The stock turns ${Math.abs(step.rotate.degrees)} degrees about ${step.rotate.about.toUpperCase()}`}
                style={{ maxHeight: 120, background: '#0f141a', border: '1px solid #2a2f36', borderRadius: 4, display: 'block' }}
              >
                <rect x={0} y={0} width={length} height={width} fill="#1a222b" stroke="#3a4a5a" strokeWidth={Math.max(0.3, length / 300)} />
                {alongX ? (
                  <line x1={0} y1={width - lineAt} x2={length} y2={width - lineAt} stroke="#e0c07a" strokeWidth={Math.max(0.25, length / 400)} strokeDasharray={`${length / 60} ${length / 90}`} />
                ) : (
                  <line x1={lineAt} y1={0} x2={lineAt} y2={width} stroke="#e0c07a" strokeWidth={Math.max(0.25, length / 400)} strokeDasharray={`${length / 60} ${length / 90}`} />
                )}
                {pins?.map((pin, i) => (
                  <circle
                    key={i}
                    data-testid={`engrave-remount-preview-pin-${i}`}
                    cx={pin.x}
                    cy={width - pin.y}
                    r={Math.max(0.8, length / 80)}
                    fill="#8fb8e0"
                  />
                ))}
              </svg>
              <figcaption style={MUTED} data-testid="engrave-remount-preview-words">
                Turn {Math.abs(step.rotate.degrees)}° about {step.rotate.about.toUpperCase()}: {step.faceDown} goes
                down, {step.faceAgainstReference} against the reference.
              </figcaption>
            </figure>
          );
        })()}

        <ol style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {described.steps.map((line, i) => (
            <li
              key={`${i}-${line}`}
              data-testid={`engrave-remount-step-${i + 1}`}
              style={{ fontSize: 12, lineHeight: 1.5, margin: '3px 0' }}
            >
              {line}
            </li>
          ))}
        </ol>

        {described.confirm === null ? (
          <div
            data-testid="engrave-remount-mirror"
            style={{ border: '1px solid #7a5a28', background: '#241d12', borderRadius: 4, padding: 6, marginTop: 8 }}
          >
            <p style={{ ...MUTED, color: '#e0c07a', margin: 0 }}>{described.mirrorCheck}</p>
          </div>
        ) : (
          <div data-testid="engrave-remount-question" style={{ marginTop: 8 }}>
            <p style={{ fontSize: 12, margin: '4px 0' }}>{described.confirm.question}</p>
            {described.confirm.options.map((option, i) => (
              <label key={option} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: '3px 0' }}>
                <input
                  type="radio"
                  name="engrave-remount-answer"
                  checked={answer === i}
                  onChange={() => {
                    setAnswer(i);
                    setRefusal(null);
                  }}
                  data-testid={`engrave-remount-option-${i}`}
                />{' '}
                {option}
              </label>
            ))}
          </div>
        )}

        {refusal !== null && (
          <p data-testid="engrave-remount-refusal" style={{ ...MUTED, color: '#f0b4ad', margin: '6px 0 0' }}>
            {refusal}
          </p>
        )}

        <div
          style={{
            display: 'flex',
            gap: 6,
            marginTop: 14,
            paddingTop: 10,
            borderTop: '1px solid #2a2f36',
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            data-testid="engrave-remount-done"
            style={{ padding: '3px 12px' }}
            disabled={described.confirm !== null && answer === null}
            onClick={done}
          >
            {doneLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
