import type { CSSProperties, JSX } from 'react';
import { itemLabel, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { CombinedPatch } from '@/store/engraveJobStore';
import type { EngraveAnyItem, EngraveCombinedShape } from '@/types/engraveJob';

/**
 * One COMBINED item of an engrave job (#215, work item 3): a border, a frame or a cut-away.
 *
 * These are DERIVED shapes — a border follows the stock outline, a frame follows another item's
 * outline, a cut-away clears one item and leaves others standing — so their inherited
 * `position`/`rotation` are IGNORED by the engine and this row deliberately shows neither. What
 * the row does show is the kind's own dimensions and, for a frame/cut-away, a PICKER for the item
 * (or items) it references.
 *
 * A bad reference (missing, disabled, self or cyclic) is NOT prevented here: `resolveItems`
 * reports it as an `item-reference` finding and nothing is generated for that item. The picker
 * only stops a user picking the item itself, which can never be its own outline.
 *
 * Depth is a NUMERIC field with a slider BESIDE it, the same rule every other row follows.
 */

const NUM: CSSProperties = { width: 60 };
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };
const INVALID: CSSProperties = { borderColor: '#7a2828', color: '#f0b4ad' };
const ROW_INLINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 };
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };
const TAG: CSSProperties = {
  fontSize: 10,
  color: '#9aa4b0',
  border: '1px solid #2a2f36',
  borderRadius: 3,
  padding: '1px 4px',
  whiteSpace: 'nowrap',
};
const ISLANDS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 2,
  padding: '4px 6px',
  border: '1px solid #2a2f36',
  borderRadius: 3,
};

const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a' };

const KIND_LABEL: Record<EngraveCombinedShape['kind'], string> = {
  border: 'Border',
  frame: 'Frame',
  cutaway: 'Cut-away',
};

/**
 * A hand edit to one combined shape is `CombinedPatch` (#215), defined in the store beside
 * `ShapePatch` so the store's `updateCombined` and this row share one type.
 */

export interface EngraveCombinedRowProps {
  shape: EngraveCombinedShape;
  /** Position of this row in `job.combined`; only used for stable test ids. */
  index: number;
  /** Largest depth this stock allows: `thickness − minFloor`, mm. */
  maxDepth: number;
  /** Every OTHER item a reference can name (this row's own item excluded). */
  candidates: readonly EngraveAnyItem[];
  onChange: (patch: CombinedPatch) => void;
  onRemove: () => void;
  /** Findings about THIS shape (the panel filters the job's list by `labelId`). */
  findings: readonly JobFinding[];
}

export function EngraveCombinedRow({
  shape,
  index,
  maxDepth,
  candidates,
  onChange,
  onRemove,
  findings,
}: EngraveCombinedRowProps): JSX.Element {
  const depthInvalid = shape.depth > maxDepth;

  /** A plain number field. `undefined` for a field this kind does not carry, so it is not rendered. */
  const numField = (key: 'inset' | 'width' | 'gap', label: string, title: string): JSX.Element | null => {
    const value = (shape as unknown as Record<string, number | undefined>)[key];
    if (value === undefined) return null;
    return (
      <label style={FIELD_LABEL}>
        <span>{label}</span>
        <input
          type="number"
          min={key === 'width' ? undefined : 0}
          step="any"
          value={value}
          data-testid={`engrave-combined-${key}-${index}`}
          aria-label={`${KIND_LABEL[shape.kind]} ${index + 1} ${label}`}
          title={title}
          style={NUM}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange({ [key]: v } as CombinedPatch);
          }}
        />
      </label>
    );
  };

  /** The single-reference picker (a frame's target / a cut-away's outer). Missing ids stay shown. */
  const refPicker = (key: 'around' | 'outer', label: string, title: string, value: string): JSX.Element => {
    const known = candidates.some((c) => c.id === value);
    return (
      <label style={FIELD_LABEL}>
        <span>{label}</span>
        <select
          value={value}
          data-testid={`engrave-combined-${key}-${index}`}
          aria-label={`${KIND_LABEL[shape.kind]} ${index + 1} ${label}`}
          title={title}
          style={{ maxWidth: 220 }}
          onChange={(e) => onChange({ [key]: e.target.value } as CombinedPatch)}
        >
          {!known && value !== '' && <option value={value}>{value} (missing)</option>}
          <option value="">— choose an item —</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id} title={c.enabled ? undefined : 'disabled'}>
              {itemLabel(c)}
              {c.enabled ? '' : ' (disabled)'}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <div
      data-testid={`engrave-combined-row-${index}`}
      style={{ border: '1px solid #2a2f36', borderRadius: 4, padding: 6, marginBottom: 6 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={shape.enabled}
          data-testid={`engrave-combined-enabled-${index}`}
          aria-label={`${KIND_LABEL[shape.kind]} ${index + 1} enabled`}
          title="A disabled item is kept in the job but not cut, and cannot be referenced."
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <span style={TAG}>{KIND_LABEL[shape.kind]}</span>
        <input
          type="text"
          value={shape.name ?? ''}
          placeholder="optional name"
          data-testid={`engrave-combined-name-${index}`}
          aria-label={`${KIND_LABEL[shape.kind]} ${index + 1} name`}
          title="Optional name, shown in the operation list and findings."
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => onChange({ name: e.target.value || undefined })}
        />
        <button
          type="button"
          data-testid={`engrave-combined-remove-${index}`}
          aria-label={`Remove ${KIND_LABEL[shape.kind]} ${index + 1}`}
          title="Remove this item."
          onClick={onRemove}
        >
          🗑
        </button>
      </div>

      {shape.kind === 'border' && (
        <div style={ROW_INLINE}>
          {numField('inset', 'inset', 'Distance from the stock outline in to the ring’s outer edge, mm.')}
          {numField('width', 'width', 'Ring wall thickness, mm. Narrower than the cutter loses the ring.')}
        </div>
      )}

      {shape.kind === 'frame' && (
        <div style={ROW_INLINE}>
          {refPicker('around', 'around', 'The item whose outline this ring follows.', shape.around)}
          {numField('gap', 'gap', 'Clearance between the target outline and the ring’s inner edge, mm.')}
          {numField('width', 'width', 'Ring wall thickness, mm.')}
        </div>
      )}

      {shape.kind === 'cutaway' && (
        <>
          <div style={ROW_INLINE}>
            {refPicker('outer', 'outer', 'The item whose outline is cleared to this depth.', shape.outer)}
          </div>
          <div style={ISLANDS} data-testid={`engrave-combined-islands-${index}`}>
            <span style={{ ...MUTED, width: '100%' }}>islands left standing at full height</span>
            {candidates.length === 0 && <span style={MUTED}>No other items to leave standing.</span>}
            {candidates.map((c) => {
              const checked = shape.islands.includes(c.id);
              return (
                <label key={c.id} style={FIELD_LABEL}>
                  <input
                    type="checkbox"
                    checked={checked}
                    data-testid={`engrave-combined-island-${index}-${c.id}`}
                    aria-label={`${itemLabel(c)} left standing`}
                    title="An island is subtracted from the cleared panel and stays at full height."
                    onChange={(e) =>
                      onChange({
                        islands: e.target.checked
                          ? [...shape.islands, c.id]
                          : shape.islands.filter((id) => id !== c.id),
                      })
                    }
                  />
                  <span>{itemLabel(c)}</span>
                </label>
              );
            })}
          </div>
        </>
      )}

      <div style={ROW_INLINE}>
        <label style={FIELD_LABEL}>
          <span>depth</span>
          <input
            type="range"
            min={0}
            max={maxDepth}
            step="0.1"
            value={Math.min(shape.depth, maxDepth)}
            aria-label={`${KIND_LABEL[shape.kind]} ${index + 1} depth slider`}
            title={`Depth below the top face, mm. At most ${maxDepth} mm on this stock: the thickness less the minimum floor.`}
            onChange={(e) => onChange({ depth: Number(e.target.value) })}
          />
          <input
            type="number"
            min={0}
            step="0.1"
            value={shape.depth}
            data-testid={`engrave-combined-depth-${index}`}
            aria-label={`${KIND_LABEL[shape.kind]} ${index + 1} depth`}
            title="Depth of this pocket's floor below the top face, mm."
            style={{ ...NUM, ...(depthInvalid ? INVALID : null) }}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange({ depth: v });
            }}
          />
          <span>mm</span>
        </label>
      </div>

      <p style={{ ...MUTED, ...(depthInvalid ? { color: SEVERITY_COLOR.error } : null) }} data-testid={`engrave-combined-maxdepth-${index}`}>
        Max depth {maxDepth} mm here — the stock thickness less the minimum floor.
      </p>

      {findings.map((f, i) => (
        <p
          key={`${f.code}-${i}`}
          data-testid={`engrave-combined-finding-${index}-${f.code}`}
          style={{ ...MUTED, color: SEVERITY_COLOR[f.severity] }}
        >
          {f.message}
        </p>
      ))}
    </div>
  );
}
