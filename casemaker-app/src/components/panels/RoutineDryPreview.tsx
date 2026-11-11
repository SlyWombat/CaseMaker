/**
 * #1202 + #1199 item 3 — A ROUTINE'S OWN DRY LINES, MARKED WHEN THIS MACHINE HAS NEVER RUN THEM.
 *
 * One card serves every motion routine the app presses: the sequence the press will run (for the
 * registration routines: the SAME executor, against a recording console; for the tool change: the
 * exact console lines the run sends), this machine's record of that exact shape, the guard's
 * refusals, and the operator's own first-run statement. The testids are the same for whichever
 * routine owns the card — only one routine's card is on screen at a time.
 */
import type { CSSProperties } from 'react';
import type { DryRoutine } from '@/engine/cnc/registration/dryRun';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const BAD = '#f0b4ad';
const WARN = '#e0c07a';

/** The registration routines' note: their list is the plan's sequence under the expected readings. */
export const REGISTRATION_DRY_NOTE =
  'The routine’s own sequence, under the readings the plan expects. Every line is checked again ' +
  'live as it is sent — this view previews; the guard enforces.';

/** The registration routines' first-run statement: the probe is the thing in the spindle. */
export const REGISTRATION_STATEMENT =
  'I am at the machine — the probe is fitted, the head is clear, and I will stay at the Stop.';

export function RoutineDryPreview({
  preview,
  firstRun,
  ticked,
  onTick,
  headless,
  note = REGISTRATION_DRY_NOTE,
  statement = REGISTRATION_STATEMENT,
}: {
  preview: DryRoutine;
  firstRun: boolean;
  ticked: boolean;
  onTick: (checked: boolean) => void;
  headless: string | null;
  note?: string;
  statement?: string;
}) {
  return (
    <div
      data-testid="engrave-registration-routine"
      data-routine={preview.identity.routine}
      data-shape={preview.identity.shape}
      style={{ marginTop: 6 }}
    >
      {firstRun && (
        <p style={{ ...MUTED, color: WARN, margin: '4px 0' }} data-testid="engrave-registration-first-run">
          This measurement has not run on this machine before — stay at the Stop.
        </p>
      )}
      <details data-testid="engrave-registration-dry">
        <summary data-testid="engrave-registration-dry-summary">
          What will be sent — {preview.lines.length} line{preview.lines.length === 1 ? '' : 's'}
        </summary>
        <ol style={{ ...MUTED, paddingLeft: 18, margin: '4px 0' }} data-testid="engrave-registration-dry-list">
          {preview.lines.map((l, i) => (
            <li
              key={`${i}-${l.line}`}
              data-testid={`engrave-registration-dry-line-${i}`}
              data-refused={l.refused === null ? undefined : 'true'}
              style={l.refused === null ? undefined : { color: BAD }}
            >
              <code>{l.line}</code>
              {l.refused !== null && <span> — {l.refused}</span>}
            </li>
          ))}
        </ol>
        <p style={{ ...MUTED, margin: '2px 0 0' }} data-testid="engrave-registration-dry-note">
          {note}
        </p>
      </details>
      {headless !== null && (
        <p style={{ ...MUTED, color: BAD, margin: '4px 0' }} data-testid="engrave-registration-first-run-headless">
          {headless}
        </p>
      )}
      {preview.error !== null && (
        <p style={{ ...MUTED, color: BAD, margin: '4px 0' }} data-testid="engrave-registration-dry-error">
          {preview.error}
        </p>
      )}
      {preview.refused && (
        <p style={{ ...MUTED, color: BAD, margin: '4px 0' }} data-testid="engrave-registration-dry-refused">
          The marked line would be refused — the press is disabled.
        </p>
      )}
      {firstRun && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: '4px 0' }} data-testid="engrave-registration-first-run-statement">
          <input
            type="checkbox"
            data-testid="engrave-registration-first-run-tick"
            checked={ticked}
            onChange={(e) => onTick(e.target.checked)}
          />
          <span>{statement}</span>
        </label>
      )}
    </div>
  );
}
