/**
 * #752 R-UI-4 — THE ROTARY OPERATION PICKER (design `rotary-flow.md` §3.6).
 *
 * The wizard's step 4 on a rod in the rotary chuck draws these three groups instead of the flat
 * ones. Each chip is one operation; the step asks for the one field the operation needs (the
 * fields live in `OperationStep`, which owns the answer the shell's Create reads).
 *
 * The face group's chips are DISABLED with a stated reason (#726 W23: a disabled control carries
 * its reason in words on the screen, not only in a hover title). See `rotaryOperations.ts` for
 * why: the job model has no face/index block yet.
 */
import type { CSSProperties, JSX } from 'react';
import {
  ROTARY_FACE_REASON,
  ROTARY_OPERATION_GROUPS,
  type RotaryOperationId,
} from './rotaryOperations';

const GROUP_LABEL: CSSProperties = { fontSize: 11, fontWeight: 600, color: '#9aa4b0', margin: '8px 0 3px' };
const CHIPS: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' };
const CHIP: CSSProperties = {
  padding: '4px 8px',
  border: '1px solid #2a2f36',
  borderRadius: 12,
  background: '#161b21',
  color: '#cfe',
  font: 'inherit',
  fontSize: 11,
  cursor: 'pointer',
};
const CHIP_ON: CSSProperties = { ...CHIP, borderColor: '#5a8abf', background: '#1d2a38', color: '#e6edf5' };
const CHIP_DISABLED: CSSProperties = { ...CHIP, color: '#6b7480', cursor: 'not-allowed', opacity: 0.7 };
const TAG: CSSProperties = { fontSize: 10, color: '#e0c07a', border: '1px solid #5a4a1d', borderRadius: 8, padding: '1px 6px' };
const REASON: CSSProperties = { fontSize: 10, color: '#9aa4b0', lineHeight: 1.4, margin: '4px 0 0' };

export interface RotaryOperationPickerProps {
  selected: RotaryOperationId | null;
  /** Only an enabled chip reaches this. */
  onPick: (id: RotaryOperationId) => void;
  /** The row's own test id, e.g. `start-wizard-op-rotary-${id}`. */
  testidFor: (id: RotaryOperationId) => string;
}

export function RotaryOperationPicker({ selected, onPick, testidFor }: RotaryOperationPickerProps): JSX.Element {
  return (
    <div data-testid="rotary-operation-picker" style={{ marginTop: 4 }}>
      {ROTARY_OPERATION_GROUPS.map((group) => (
        <div key={group.id} data-testid={`rotary-operation-group-${group.id}`}>
          <div style={GROUP_LABEL}>{group.label}</div>
          <div style={CHIPS}>
            {group.operations.map((op) => {
              const disabled = op.reason !== null;
              const on = !disabled && selected === op.id;
              return (
                <button
                  key={op.id}
                  type="button"
                  data-testid={testidFor(op.id)}
                  aria-pressed={on}
                  disabled={disabled}
                  title={op.reason ?? op.blurb}
                  style={disabled ? CHIP_DISABLED : on ? CHIP_ON : CHIP}
                  onClick={() => onPick(op.id)}
                >
                  {op.label}
                </button>
              );
            })}
            {group.id === '3d' &&
              group.operations
                .filter((op) => op.tag !== null)
                .map((op) => (
                  <span key={`tag-${op.id}`} data-testid={`rotary-operation-tag-${op.id}`} style={TAG}>
                    {op.tag}
                  </span>
                ))}
          </div>
          {group.id === 'face' && (
            <p data-testid="rotary-face-reason" style={REASON}>
              {ROTARY_FACE_REASON}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
