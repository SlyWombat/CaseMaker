import type { CSSProperties, JSX } from 'react';
import { EngraveItemRow } from '@/components/panels/EngraveItemRow';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { TargetObjectPatch } from '@/store/engraveJobStore';
import type { EngraveTargetObject } from '@/types/engraveJob';

/**
 * The reference object the 3D primitives are positioned against (#435).
 *
 * It is NOT an item: it is never cut and never enters `toPartPlan`. Its row exists so the imported
 * model can be placed against the pockets — the bbox centre in X/Y and its TOP at `position.z`
 * (Z0 is the stock top). The import owns the bytes, hash and parsed size; this row edits only
 * placement, rotation and visibility.
 *
 * The row still uses `EngraveItemRow`: it is the panel's one line-per-object shape, and the target
 * has a name, a number and a fold like every other object. It is `selectable` because the viewport
 * draws and picks it (`EngravePrimitives`); the selection highlights the row and the mesh.
 */

const NUM: CSSProperties = { width: 60 };
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };
const ROW_INLINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 };
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };

export interface EngraveTargetObjectRowProps {
  target: EngraveTargetObject;
  /** Row position; the target has one row, so this is always 0. */
  index: number;
  onChange: (patch: TargetObjectPatch) => void;
  onRemove: () => void;
  findings: readonly JobFinding[];
}

export function EngraveTargetObjectRow({
  target,
  index,
  onChange,
  onRemove,
  findings,
}: EngraveTargetObjectRowProps): JSX.Element {
  const size = target.size;
  const sizeText = `${Number(size.x.toFixed(2))}×${Number(size.y.toFixed(2))}×${Number(size.z.toFixed(2))} mm`;

  const positionNum = (axis: 'x' | 'y' | 'z'): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{axis.toUpperCase()}</span>
      <input
        type="number"
        step="any"
        value={target.position[axis]}
        data-testid={`engrave-target-${axis}-${index}`}
        aria-label={`Target object ${axis.toUpperCase()}`}
        title={
          axis === 'z'
            ? "Height of the object's TOP above the stock's top face, mm. Z0 is the top face; a negative value sinks it into the blank."
            : `Centre of the object's bounding box in ${axis.toUpperCase()}, mm from the stock's front-left corner.`
        }
        style={NUM}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ position: { [axis]: v } });
        }}
      />
    </label>
  );

  return (
    <EngraveItemRow
      id={target.id}
      selectable
      prefix="engrave-target"
      index={index}
      glyph="◎"
      kindWord="Target object"
      name={target.name}
      summary={sizeText}
      enabled={target.enabled}
      enabledTitle="A hidden target object stays in the job but is not drawn."
      removeTitle="Remove the target object."
      removeNoun="target object"
      findings={findings}
      onToggleEnabled={(enabled) => onChange({ enabled })}
      onRemove={onRemove}
    >
      <label style={ROW_INLINE}>
        <span>name</span>
        <input
          type="text"
          value={target.name}
          data-testid={`engrave-target-name-${index}`}
          aria-label="Target object name"
          title="Shown in the job and in findings."
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => onChange({ name: e.target.value || target.name })}
        />
      </label>

      <p style={MUTED}>
        Imported {target.format.toUpperCase()} — embedded in the job ({target.sha256.slice(0, 12)}…).
        The object is a reference, not a cut; its size is {sizeText}.
      </p>

      <div style={ROW_INLINE}>
        {positionNum('x')}
        {positionNum('y')}
        {positionNum('z')}
        <label style={FIELD_LABEL}>
          <span>rot</span>
          <input
            type="number"
            step="any"
            value={target.rotation}
            data-testid={`engrave-target-rotation-${index}`}
            aria-label="Target object rotation"
            title="Degrees counter-clockwise about the object's Z axis, through its bbox centre."
            style={NUM}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange({ rotation: v });
            }}
          />
        </label>
      </div>
    </EngraveItemRow>
  );
}
