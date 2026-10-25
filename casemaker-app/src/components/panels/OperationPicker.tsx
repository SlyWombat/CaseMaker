/**
 * #662 — the operation type picker: the one place a person says WHICH operation to add.
 *
 * It is used twice — the wizard's first question ("What are you cutting?") and the panel's
 * "Add operation" — so the words, the order and the set are one table (`operationTypes.ts`). Both
 * callers own what a pick DOES (the wizard starts the job with it; the panel appends one), and the
 * caller owns the test ids, so the historic `engrave-add-*` ids survive the redesign.
 *
 * Surface a mesh appears only while the job has no operations: the engine posts 3D surfacing for a
 * pure goal job, and a mesh added beside 2D work posts no cut (the engine's own
 * `goal-object-no-toolpath` finding says so). Offering it there would be a type that cannot run.
 */

import type { CSSProperties, JSX } from 'react';
import { OPERATION_TYPES, type OperationTypeId } from './operationTypes';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0 0' };
const BUTTON: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '6px 8px',
  border: '1px solid #2a2f36',
  borderRadius: 4,
  background: '#161b21',
  color: '#e6edf5',
  font: 'inherit',
  cursor: 'pointer',
};
const LABEL: CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600 };
const BLURB: CSSProperties = { display: 'block', fontSize: 10, color: '#9aa4b0', lineHeight: 1.4 };

export interface OperationPickerProps {
  /** The test id one type's button carries. The caller owns the stem. */
  testidFor: (id: OperationTypeId) => string;
  onPick: (id: OperationTypeId) => void;
  /** Whether "Surface a mesh" is offered — the job holds no operations yet. */
  surfaceAllowed: boolean;
}

export function OperationPicker({ testidFor, onPick, surfaceAllowed }: OperationPickerProps): JSX.Element {
  return (
    <div
      data-testid="operation-picker"
      style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 6, marginTop: 4 }}
    >
      {OPERATION_TYPES.filter((t) => t.id !== 'surface' || surfaceAllowed).map((t) => (
        <button key={t.id} type="button" data-testid={testidFor(t.id)} style={BUTTON} onClick={() => onPick(t.id)}>
          <span style={LABEL}>{t.label}</span>
          <span style={BLURB}>{t.blurb}</span>
        </button>
      ))}
      {!surfaceAllowed && (
        <p style={{ ...MUTED, gridColumn: '1 / -1' }} data-testid="operation-picker-surface-note">
          Surface a mesh is offered on a job with nothing else in it — a goal mesh is roughed and
          finished as the whole program.
        </p>
      )}
    </div>
  );
}
