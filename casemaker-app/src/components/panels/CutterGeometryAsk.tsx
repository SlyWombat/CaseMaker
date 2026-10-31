import { useState, type JSX } from 'react';

/**
 * #786 slice 6 — A NUMBER THE CUTTER'S RECORD DOES NOT STATE, ASKED WHERE THE FINDING IS SAID.
 *
 * Two findings stop a V job for a field that is not in the job at all: `tool-tip-unrecorded` (a
 * pointed cutter with no tip — the width every engraving reaches the design with is unknown) and
 * `chamfer-reach-unproven` (a cone with no base diameter — how wide a chamfer it reaches cannot be
 * worked out). Both point at the cutter's OWN record, and sending the operator to Manage → Tools
 * to type one number is a trip the panel can spare: this is that one field, beside the sentence,
 * written through the same two doors the centre-cutting answer uses (a `user:` definition through
 * the tool list, an `inv:` possession through the inventory).
 *
 * It asks; it does not guess. The input starts empty, the press is disabled until a number is
 * typed, and nothing is written until it is pressed — the number on the record is the operator's
 * claim, exactly as if they had typed it in Manage.
 *
 * A catalogue row alone is the service's record, so the ask is never drawn for one: the finding's
 * sentence stands, and the cutter is answered once it is owned.
 */

export interface CutterGeometryAskProps {
  /** The field in the sentence's own words: `tip ⌀`, `cutting diameter`. */
  label: string;
  /**
   * Whether a stated `0` is an answer. A tip of 0 is a point — a real claim about a sharp cutter
   * (`vCone` reads it as one, tool.ts). A cone's base diameter of 0 is no cone at all.
   */
  allowZero?: boolean;
  /** Write the number onto the cutter's record. Resolves once the job's snapshot is refreshed. */
  onRecord: (mm: number) => Promise<void> | void;
  /** The press's test id; the input is `${testid}-input`. */
  testid: string;
}

export function CutterGeometryAsk({ label, allowZero = false, onRecord, testid }: CutterGeometryAskProps): JSX.Element {
  const [text, setText] = useState('');
  const mm = Number(text);
  const valid = text.trim() !== '' && Number.isFinite(mm) && (allowZero ? mm >= 0 : mm > 0);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12 }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span>{label}</span>
        <input
          type="number"
          min={0}
          step="0.01"
          value={text}
          placeholder="—"
          data-testid={`${testid}-input`}
          aria-label={`${label} (mm) to record on the cutter`}
          title="The number the cutter's own record does not state, mm."
          style={{ width: 70 }}
          onChange={(e) => setText(e.target.value)}
        />
        <span>mm</span>
      </label>
      <button type="button" data-testid={testid} disabled={!valid} onClick={() => void onRecord(mm)}>
        Record
      </button>
    </span>
  );
}
