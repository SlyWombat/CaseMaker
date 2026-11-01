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

import { useState, type CSSProperties, type JSX } from 'react';
import type { EngraveFaceItem, EngraveFaceOp } from '@/types/engraveJob';
import type { Mm } from '@/types/units';
import { defaultFaceItem, faceChordMm, faceItemWords, faceOperationWords } from '@/engine/cnc/rotary/faceOps';

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
  /** The face's cuttable length along X, mm — where its cuts' centres are measured from. */
  lengthMm: Mm;
  /** The job cutter's diameter, mm — a cross-hole and a hole come out at it. */
  cutterDiameterMm: Mm;
  onChange: (patch: Partial<Omit<EngraveFaceOp, 'id' | 'kind'>>) => void;
  onRemove: () => void;
  /** #833 — a cut added on this face (an engraving, a pocket or a hole). */
  onAddItem: (item: Omit<EngraveFaceItem, 'id'>) => void;
  onRemoveItem: (itemId: string) => void;
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

export function FaceOperationRow({
  face,
  index,
  radiusMm,
  lengthMm,
  cutterDiameterMm,
  onChange,
  onRemove,
  onAddItem,
  onRemoveItem,
}: FaceOperationRowProps): JSX.Element {
  const typeWord = face.kind === 'flat' ? 'Flat' : face.kind === 'faces-all-round' ? 'Faces all round' : 'Cross-hole';
  // #833 — the flat picker's three operations, on this face. Text waits for its words: an
  // engraving with no text is not a cut the CAM can make.
  const [words, setWords] = useState('');
  const [addingText, setAddingText] = useState(false);
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
      {face.kind !== 'cross-hole' && (
        <div style={{ margin: '6px 0 0 2px' }} data-testid={`engrave-face-add-${index}`}>
          <span style={{ ...UNIT }}>Add on this face</span>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3, alignItems: 'center' }}>
            <button
              type="button"
              data-testid={`engrave-face-add-text-${index}`}
              title="Engrave text on the face at this angle. The words are cut below the face plane."
              onClick={() => setAddingText((v) => !v)}
            >
              Engrave text
            </button>
            <button
              type="button"
              data-testid={`engrave-face-add-pocket-${index}`}
              title="A pocket on the face at this angle."
              onClick={() => onAddItem(defaultFaceItem('pocket', lengthMm, chord, cutterDiameterMm))}
            >
              Pocket
            </button>
            <button
              type="button"
              data-testid={`engrave-face-add-hole-${index}`}
              title="A hole drilled at this angle, into the face — it comes out at the cutter's diameter."
              onClick={() => onAddItem(defaultFaceItem('hole', lengthMm, chord, cutterDiameterMm))}
            >
              Hole
            </button>
            {addingText && (
              <>
                <input
                  type="text"
                  aria-label="Words on the face"
                  data-testid={`engrave-face-text-words-${index}`}
                  placeholder="the words"
                  style={{ width: 140 }}
                  value={words}
                  onChange={(e) => setWords(e.target.value)}
                />
                <button
                  type="button"
                  data-testid={`engrave-face-text-add-${index}`}
                  disabled={words.trim() === ''}
                  title="Add the engraving to this face. An engraving with no words is not a cut."
                  onClick={() => {
                    onAddItem(defaultFaceItem('text', lengthMm, chord, cutterDiameterMm, words.trim()));
                    setWords('');
                    setAddingText(false);
                  }}
                >
                  Add
                </button>
              </>
            )}
          </div>
          {(face.items ?? []).map((item) => (
            <div key={item.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 3 }} data-testid={`engrave-face-item-${index}-${item.id}`}>
              <span>{faceItemWords(item)}</span>
              <button type="button" data-testid={`engrave-face-item-remove-${index}-${item.id}`} onClick={() => onRemoveItem(item.id)} title="Remove this cut from the face.">
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
