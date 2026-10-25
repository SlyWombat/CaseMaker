import type { CSSProperties, JSX } from 'react';
import { EngraveItemRow } from '@/components/panels/EngraveItemRow';
import { regionChipLabel, useRegionOperationType } from '@/components/panels/operationTypes';
import { rowSummary } from '@/components/panels/engraveRowText';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { primitiveLabel, primitiveReducesToRegion } from '@/engine/cnc/engrave/partPlan';
import type { PrimitivePatch } from '@/store/engraveJobStore';
import type { EngravePrimitive, EngravePrimitiveAxis } from '@/types/engraveJob';

/**
 * One 3D cut-away primitive of an engrave job (#435): a box, cylinder, cone or sphere positioned
 * against the target object.
 *
 * Only the VERTICAL box and cylinder reduce to a region, and that reduction happens in
 * `toPartPlan` — this row states that fact beside the fields instead of offering a second toolpath.
 * A cone, a sphere and an X/Y primitive are refused BY NAME by `validateJob`; their rows still
 * carry every field, because the model holds the shape and the refusal is the answer, not a
 * reason to hide the drawing.
 *
 * The two schema invariants that would make the document unloadable are guarded at the input: a
 * cone's tip may not exceed its diameter, and a sphere's cap depth may not exceed its diameter.
 * A value that would break one is not committed.
 */

const NUM: CSSProperties = { width: 60 };
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };
const ROW_INLINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 };
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };

const KIND_WORD: Record<EngravePrimitive['kind'], string> = {
  box: 'Box',
  cylinder: 'Cylinder',
  cone: 'Cone',
  sphere: 'Sphere',
};

const KIND_GLYPH: Record<EngravePrimitive['kind'], string> = {
  box: '▭',
  cylinder: '◯',
  cone: '△',
  sphere: '●',
};

export interface EngravePrimitiveRowProps {
  primitive: EngravePrimitive;
  /** Position of this row in `job.primitives`; only used for stable test ids. */
  index: number;
  /** Largest depth this stock allows: `thickness − minFloor`, mm. */
  maxDepth: number;
  onChange: (patch: PrimitivePatch) => void;
  onRemove: () => void;
  /** Findings about THIS primitive (the panel filters the job's list by `labelId`). */
  findings: readonly JobFinding[];
}

export function EngravePrimitiveRow({
  primitive,
  index,
  maxDepth,
  onChange,
  onRemove,
  findings,
}: EngravePrimitiveRowProps): JSX.Element {
  // #662 - the chip states what THIS cutter makes of a region.
  const region = useRegionOperationType();
  const kindWord = KIND_WORD[primitive.kind];
  const tipDiameter = primitive.kind === 'cone' ? primitive.tipDiameter : null;
  const depthInvalid = primitive.depth > maxDepth || (primitive.kind === 'sphere' && primitive.depth > primitive.diameter);
  const shapeInvalid =
    primitive.kind === 'cone' ? primitive.tipDiameter > primitive.diameter : false;

  const positionNum = (axis: 'x' | 'y'): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{axis.toUpperCase()}</span>
      <input
        type="number"
        step="any"
        value={primitive.position[axis]}
        data-testid={`engrave-primitive-${axis}-${index}`}
        aria-label={`${kindWord} ${index + 1} ${axis.toUpperCase()}`}
        title={`Centre of the primitive, mm from the stock's front-left corner. ${
          axis === 'x' ? 'X runs between the vise jaws.' : 'Y runs away from the operator.'
        }`}
        style={NUM}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ position: { [axis]: v } });
        }}
      />
    </label>
  );

  const positiveNum = (
    field: 'width' | 'height' | 'diameter',
    label: string,
    title: string,
  ): JSX.Element | null => {
    let value: number;
    if (field === 'width') {
      if (primitive.kind !== 'box') return null;
      value = primitive.width;
    } else if (field === 'height') {
      if (primitive.kind !== 'box') return null;
      value = primitive.height;
    } else {
      if (primitive.kind === 'box') return null;
      value = primitive.diameter;
    }
    return (
      <label style={FIELD_LABEL}>
        <span>{label}</span>
        <input
          type="number"
          min={0}
          step="any"
          value={value}
          data-testid={`engrave-primitive-${field}-${index}`}
          aria-label={`${kindWord} ${index + 1} ${field}`}
          title={title}
          style={NUM}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isFinite(v) || v <= 0) return;
            // A sphere's cap cannot be deeper than its diameter (schema invariant).
            if (field === 'diameter' && primitive.kind === 'sphere' && primitive.depth > v) return;
            // A cone's tip cannot be wider than its base (schema invariant).
            if (field === 'diameter' && primitive.kind === 'cone' && primitive.tipDiameter > v) return;
            onChange({ [field]: v } as PrimitivePatch);
          }}
        />
      </label>
    );
  };

  return (
    <EngraveItemRow
      id={primitive.id}
      selectable
      prefix="engrave-primitive"
      index={index}
      glyph={KIND_GLYPH[primitive.kind]}
      kindWord={kindWord}
      typeLabel={regionChipLabel(undefined, region)}
      name={primitive.name?.trim() ? primitive.name : kindWord}
      summary={rowSummary(primitive.depth)}
      enabled={primitive.enabled}
      enabledTitle="A disabled primitive is kept in the job but not cut."
      removeTitle="Remove this 3D primitive."
      removeNoun={kindWord}
      findings={findings}
      onToggleEnabled={(enabled) => onChange({ enabled })}
      onRemove={onRemove}
    >
      <label style={ROW_INLINE}>
        <span>name</span>
        <input
          type="text"
          value={primitive.name ?? ''}
          placeholder="optional name"
          data-testid={`engrave-primitive-name-${index}`}
          aria-label={`${kindWord} ${index + 1} name`}
          title="Optional name, shown in the operation list and findings."
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => onChange({ name: e.target.value || undefined })}
        />
      </label>

      <div style={ROW_INLINE}>
        {positionNum('x')}
        {positionNum('y')}
        <label style={FIELD_LABEL}>
          <span>rot</span>
          <input
            type="number"
            step="any"
            value={primitive.rotation}
            data-testid={`engrave-primitive-rotation-${index}`}
            aria-label={`${kindWord} ${index + 1} rotation`}
            title="Degrees counter-clockwise the primitive is turned about its centre."
            style={NUM}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange({ rotation: v });
            }}
          />
        </label>
        <label style={FIELD_LABEL}>
          <span>axis</span>
          <select
            value={primitive.axis ?? 'z'}
            data-testid={`engrave-primitive-axis-${index}`}
            aria-label={`${kindWord} ${index + 1} opening axis`}
            title="The axis the shape opens along. Only Z is a top-face pocket the region CAM can cut; X and Y are side-opening undercuts and are refused by name."
            onChange={(e) => onChange({ axis: e.target.value as EngravePrimitiveAxis })}
          >
            <option value="z">Z — top face</option>
            <option value="x">X — side</option>
            <option value="y">Y — side</option>
          </select>
        </label>
      </div>

      <div style={ROW_INLINE}>
        {positiveNum('width', 'width', 'Box width in X, mm. Positive.')}
        {positiveNum('height', 'height', 'Box height in Y, mm. Positive.')}
        {positiveNum(
          'diameter',
          primitive.kind === 'cone' ? 'base ⌀' : '⌀',
          primitive.kind === 'sphere'
            ? 'Sphere diameter, mm. The cap depth may not exceed it.'
            : primitive.kind === 'cone'
              ? 'Cone base diameter, mm. The tip may not be wider than it.'
              : 'Cylinder diameter, mm.',
        )}
        {tipDiameter !== null && (
          <label style={FIELD_LABEL}>
            <span>tip ⌀</span>
            <input
              type="number"
              min={0}
              step="any"
              value={tipDiameter}
              data-testid={`engrave-primitive-tip-diameter-${index}`}
              aria-label={`${kindWord} ${index + 1} tip diameter`}
              title="Flat diameter at the narrow end, mm. May be 0 for a point; may not exceed the base."
              style={NUM}
              onChange={(e) => {
                const v = Number(e.target.value);
                // Only the round forms have a base diameter to bound the tip against; the box
                // never renders this input, so the `in` check narrows instead of assuming.
                if (!Number.isFinite(v) || v < 0) return;
                if ('diameter' in primitive && v > primitive.diameter) return;
                onChange({ tipDiameter: v });
              }}
            />
          </label>
        )}
      </div>

      <div style={ROW_INLINE}>
        <label style={FIELD_LABEL}>
          <span>depth</span>
          <input
            type="range"
            min={0.1}
            max={maxDepth}
            step="0.1"
            value={Math.min(primitive.depth, maxDepth)}
            aria-label={`${kindWord} ${index + 1} depth slider`}
            title={`Depth below the top face, mm. At most ${maxDepth} mm on this stock.`}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) onChange({ depth: v });
            }}
          />
          <input
            type="number"
            min={0}
            step="0.1"
            value={primitive.depth}
            data-testid={`engrave-primitive-depth-${index}`}
            aria-label={`${kindWord} ${index + 1} depth`}
            title="Depth of the pocket floor below the top face, mm."
            style={{ ...NUM, ...(depthInvalid ? { borderColor: '#7a2828', color: '#f0b4ad' } : null) }}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v) || v <= 0) return;
              if (primitive.kind === 'sphere' && v > primitive.diameter) return;
              onChange({ depth: v });
            }}
          />
          <span>mm</span>
        </label>
      </div>

      <p style={MUTED} data-testid={`engrave-primitive-cut-${index}`}>
        {primitiveReducesToRegion(primitive)
          ? 'Cut as a flat-floor region by the ordinary pocket CAM.'
          : primitive.kind === 'cone'
            ? 'A cone has a sloped wall; the region CAM cannot cut it and Generate refuses it by name.'
            : primitive.kind === 'sphere'
              ? 'A sphere is a dexel job; the region CAM cannot cut it and Generate refuses it by name.'
              : 'A side-opening primitive is an undercut; the region CAM cannot cut it and Generate refuses it by name.'}
      </p>

      <p style={{ ...MUTED, ...(depthInvalid || shapeInvalid ? { color: '#f0b4ad' } : null) }} data-testid={`engrave-primitive-maxdepth-${index}`}>
        Max depth {maxDepth} mm here — the stock thickness less the minimum floor.
        {primitive.kind === 'sphere' && ` A sphere's cap must be no deeper than its diameter (${primitive.diameter} mm).`}
        {primitive.kind === 'cone' && shapeInvalid && ' The tip is wider than the base.'}
      </p>
      <p style={{ ...MUTED, margin: 0 }} data-testid={`engrave-primitive-label-${index}`}>
        {primitiveLabel(primitive)}
      </p>
    </EngraveItemRow>
  );
}
