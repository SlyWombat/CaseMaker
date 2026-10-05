import type { CSSProperties, JSX } from 'react';
import { FontPicker, WeightPicker } from '@/components/panels/FontPicker';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { CustomFont } from '@/types/textLabel';
import type { EngraveLabel } from '@/types/engraveJob';

/**
 * One label of an engrave job (#205): enabled, text, font, weight, cap height, position,
 * rotation, depth, and its own findings.
 *
 * Depth is a NUMERIC field with a slider BESIDE it, never a slider alone (the mockup's rule) —
 * a slider cannot express "11.5 mm" reliably, and depth is the one number a user has a reason
 * to type exactly. The field is marked when the depth leaves less than `minFloor` under the cut.
 */

const NUM: CSSProperties = { width: 60 };
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };
const INVALID: CSSProperties = { borderColor: '#7a2828', color: '#f0b4ad' };
const LABEL_INLINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 };
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };

const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a' };

export interface EngraveLabelRowProps {
  label: EngraveLabel;
  /** Position of this row in `job.labels`; only used for stable test ids. */
  index: number;
  /** Largest depth this stock allows: `thickness − minFloor`, mm. */
  maxDepth: number;
  onChange: (patch: Partial<EngraveLabel>) => void;
  onRemove: () => void;
  /** Findings about THIS label (the panel filters the job's list by `labelId`). */
  findings: readonly JobFinding[];
  /** The project's embedded fonts, for the font picker. */
  customFonts?: readonly CustomFont[];
}

export function EngraveLabelRow({
  label,
  index,
  maxDepth,
  onChange,
  onRemove,
  findings,
  customFonts = [],
}: EngraveLabelRowProps): JSX.Element {
  const depthInvalid = label.depth > maxDepth;

  const num = (
    key: 'size' | 'rotation',
    aria: string,
    title: string,
    step = 'any',
  ): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{aria}</span>
      <input
        type="number"
        step={step}
        value={label[key]}
        data-testid={`engrave-label-${key}-${index}`}
        aria-label={`Label ${index + 1} ${aria}`}
        title={title}
        style={NUM}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ [key]: v } as Partial<EngraveLabel>);
        }}
      />
    </label>
  );

  const positionNum = (axis: 'x' | 'y'): JSX.Element => (
    <label style={FIELD_LABEL}>
      <span>{axis.toUpperCase()}</span>
      <input
        type="number"
        step="any"
        value={label.position[axis]}
        data-testid={`engrave-label-${axis}-${index}`}
        aria-label={`Label ${index + 1} ${axis.toUpperCase()}`}
        title={`Centre of the text, mm from the stock's front-left corner. ${
          axis === 'x' ? 'X runs between the vise jaws.' : 'Y runs away from the operator.'
        }`}
        style={NUM}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ position: { ...label.position, [axis]: v } });
        }}
      />
    </label>
  );

  return (
    <div
      data-testid={`engrave-label-row-${index}`}
      style={{ border: '1px solid #2a2f36', borderRadius: 4, padding: 6, marginBottom: 6 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={label.enabled}
          data-testid={`engrave-label-enabled-${index}`}
          aria-label={`Label ${index + 1} enabled`}
          title="A disabled label is kept in the job but not cut."
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <input
          type="text"
          value={label.text}
          data-testid={`engrave-label-text-${index}`}
          aria-label={`Label ${index + 1} text`}
          title="The text to engrave."
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => onChange({ text: e.target.value })}
        />
        <FontPicker
          value={label.font}
          onChange={(font) => onChange({ font })}
          customFonts={customFonts}
          aria-label={`Label ${index + 1} font`}
          title="Typeface for the label."
        />
        <WeightPicker
          value={label.weight}
          onChange={(weight) => onChange({ weight })}
          aria-label={`Label ${index + 1} weight`}
          title="Regular or bold (bundled fonts only; an embedded font is used as-is)."
        />
        <button
          type="button"
          data-testid={`engrave-label-remove-${index}`}
          aria-label={`Remove label ${index + 1}`}
          title="Remove this label."
          onClick={onRemove}
        >
          🗑
        </button>
      </div>

      <div style={LABEL_INLINE}>
        <label style={FIELD_LABEL}>
          <input
            type="checkbox"
            checked={label.construction === true}
            data-testid={`engrave-label-construction-${index}`}
            aria-label={`Label ${index + 1} reference only`}
            title="Reference only: this label is not cut. It can still be named by a frame, or left as a cut-away island — that is how raised text is made."
            onChange={(e) => onChange({ construction: e.target.checked ? true : undefined })}
          />
          <span>reference only</span>
        </label>
        {num('size', 'cap', 'Cap height, mm — the size the cutter has to reach through.')}
        {positionNum('x')}
        {positionNum('y')}
        {num('rotation', 'rot', 'Degrees counter-clockwise about the text centre.')}
        <label style={FIELD_LABEL}>
          <span>depth</span>
          <input
            type="range"
            min={0}
            max={maxDepth}
            step="0.1"
            value={Math.min(label.depth, maxDepth)}
            aria-label={`Label ${index + 1} depth slider`}
            title={`Depth below the top face, mm. At most ${maxDepth} mm on this stock: the thickness less the minimum floor.`}
            onChange={(e) => onChange({ depth: Number(e.target.value) })}
          />
          <input
            type="number"
            min={0}
            step="0.1"
            value={label.depth}
            data-testid={`engrave-label-depth-${index}`}
            aria-label={`Label ${index + 1} depth`}
            title={`Depth of this label's floor below the top face, mm.`}
            style={{ ...NUM, ...(depthInvalid ? INVALID : null) }}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange({ depth: v });
            }}
          />
          <span>mm</span>
        </label>
      </div>

      <p style={{ ...MUTED, ...(depthInvalid ? { color: SEVERITY_COLOR.error } : null) }} data-testid={`engrave-label-maxdepth-${index}`}>
        Max depth {maxDepth} mm here — the stock thickness less the minimum floor.
      </p>

      {findings.map((f, i) => (
        <p
          key={`${f.code}-${i}`}
          data-testid={`engrave-label-finding-${index}-${f.code}`}
          style={{ ...MUTED, color: SEVERITY_COLOR[f.severity] }}
        >
          {f.message}
        </p>
      ))}
    </div>
  );
}
