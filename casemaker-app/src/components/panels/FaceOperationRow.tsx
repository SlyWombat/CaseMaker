/**
 * #241 slice 2 — ONE FACE OPERATION'S ROW in the panel's operation list.
 *
 * The operation is one cut on the round stock's face — a Flat, a ring of flats, or a Cross-hole —
 * and it carries the INDEX (A) it is cut at. The row edits the one field each operation has (its
 * depth, the ring's count and across-flats, the hole's diameter) plus the angle, in the same
 * layout as every other operation row: a folded line that reads the whole operation, and the
 * fields inside.
 *
 * The number beside a flat is the CHORD the face is at that depth (`rotary/faceOps.ts`): the face
 * is exactly that wide, and the CAM steps over in Y to cut it. It is stated here because the width
 * is a consequence of the depth, not a field — and a person setting a D-flat wants to see it.
 */

import type { CSSProperties, JSX } from 'react';
import type { EngraveFaceOp } from '@/types/engraveJob';
import type { Mm } from '@/types/units';
import { faceChordMm, faceOperationWords } from '@/engine/cnc/rotary/faceOps';

const ROW: CSSProperties = { borderTop: '1px solid #22272d', padding: '6px 2px', fontSize: 12, color: '#c8d3de' };
const SUMMARY: CSSProperties = { cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'baseline' };
const TYPE: CSSProperties = { fontSize: 10, color: '#9aa4b0', border: '1px solid #2a2f36', borderRadius: 8, padding: '0 6px' };
const FIELDS: CSSProperties = { display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', margin: '6px 0 0 2px' };
const LABEL: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 };
const UNIT: CSSProperties = { fontSize: 10, color: '#9aa4b0' };
const NOTE: CSSProperties = { fontSize: 10, color: '#9aa4b0', margin: '4px 0 0 2px', lineHeight: 1.45 };

export interface FaceOperationRowProps {
  face: EngraveFaceOp;
  index: number;
  /** The stock's radius, mm — the flat's chord is stated against it. */
  radiusMm: Mm;
  onChange: (patch: Partial<Omit<EngraveFaceOp, 'id' | 'kind'>>) => void;
  onRemove: () => void;
}

const num = (v: number): string => String(Number(v.toFixed(2)));

/** A number field that only reports finite values, so a half-typed minus never reaches the job. */
function NumberField({
  label,
  testid,
  value,
  unit,
  min,
  step,
  onValue,
}: {
  label: string;
  testid: string;
  value: number;
  unit: string | null;
  min?: number | undefined;
  step?: number | undefined;
  onValue: (v: number) => void;
}): JSX.Element {
  return (
    <label style={LABEL}>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        step={step ?? 'any'}
        data-testid={testid}
        aria-label={label}
        style={{ width: 64 }}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onValue(v);
        }}
      />
      {unit !== null && <span style={UNIT}>{unit}</span>}
    </label>
  );
}

export function FaceOperationRow({ face, index, radiusMm, onChange, onRemove }: FaceOperationRowProps): JSX.Element {
  const typeWord = face.kind === 'flat' ? 'Flat' : face.kind === 'faces-all-round' ? 'Faces all round' : 'Cross-hole';
  const chord = face.kind === 'flat' ? faceChordMm(radiusMm, face.depth ?? 0) : faceChordMm(radiusMm, radiusMm - (face.acrossFlats ?? 0) / 2);
  return (
    <details style={ROW} data-testid={`engrave-face-row-${index}`}>
      <summary style={SUMMARY} data-testid={`engrave-face-summary-${index}`}>
        <span style={TYPE}>{typeWord}</span>
        <span>{faceOperationWords(face)}</span>
      </summary>
      <div style={FIELDS}>
        <NumberField
          label={face.kind === 'faces-all-round' ? 'First face' : 'Angle'}
          testid={`engrave-face-a-${index}`}
          value={face.a}
          unit="°"
          onValue={(a) => onChange({ a })}
        />
        {face.kind === 'flat' && (
          <NumberField
            label="Depth"
            testid={`engrave-face-depth-${index}`}
            value={face.depth ?? 0}
            unit="mm"
            min={0}
            onValue={(depth) => onChange({ depth })}
          />
        )}
        {face.kind === 'faces-all-round' && (
          <>
            <NumberField
              label="Count"
              testid={`engrave-face-count-${index}`}
              value={face.count ?? 0}
              unit={null}
              min={3}
              step={1}
              onValue={(count) => onChange({ count })}
            />
            <NumberField
              label="Across flats"
              testid={`engrave-face-across-${index}`}
              value={face.acrossFlats ?? 0}
              unit="mm"
              min={0}
              onValue={(acrossFlats) => onChange({ acrossFlats })}
            />
          </>
        )}
        {face.kind === 'cross-hole' && (
          <NumberField
            label="Diameter"
            testid={`engrave-face-hole-${index}`}
            value={face.diameter ?? 0}
            unit="mm"
            min={0}
            onValue={(diameter) => onChange({ diameter })}
          />
        )}
        <button type="button" data-testid={`engrave-face-remove-${index}`} onClick={onRemove} title="Remove this face operation.">
          Remove
        </button>
      </div>
      <p style={NOTE} data-testid={`engrave-face-note-${index}`}>
        {face.kind === 'cross-hole'
          ? 'A cross-hole is drilled through the rod at this angle, in one plunge.'
          : `The face is ${num(chord)} mm wide at this depth on a ⌀${num(2 * radiusMm)} mm rod; the passes step across it while the stock is held at the angle.`}
      </p>
    </details>
  );
}
