import type { CSSProperties, JSX, ReactNode } from 'react';
import { EngraveItemRow } from '@/components/panels/EngraveItemRow';
import { RestCutterControl, type RestChoice } from '@/components/panels/RestCutterControl';
import { itemOperationName } from '@/engine/cnc/engrave/partPlan';
import { regionChipLabel, useRegionOperationType } from '@/components/panels/operationTypes';
import { rowSummary } from '@/components/panels/engraveRowText';
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
const ISLANDS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 2,
  padding: '4px 6px',
  border: '1px solid #2a2f36',
  borderRadius: 3,
};

const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a', info: '#7fa6c9' };

const KIND_LABEL: Record<EngraveCombinedShape['kind'], string> = {
  border: 'Border',
  frame: 'Frame',
  cutaway: 'Cut-away',
};

/** The collapsed line's glyph per combined kind (#411): a ring, a picture frame, a hole cut out. */
const KIND_GLYPH: Record<EngraveCombinedShape['kind'], string> = {
  border: '▢',
  frame: '⬚',
  cutaway: '◌',
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
  /**
   * #724 W4 — the words after "Max depth N mm here —": the stock thickness on a plate, the
   * rod's radius (or the tube's wall) on a rotary job. Omitted, the plate's words stand.
   */
  maxDepthWhy?: string;
  /** Every OTHER item a reference can name (this row's own item excluded). */
  candidates: readonly EngraveAnyItem[];
  onChange: (patch: CombinedPatch) => void;
  onRemove: () => void;
  /** Findings about THIS shape (the panel filters the job's list by `labelId`). */
  findings: readonly JobFinding[];
  /** #743 P-5 — a one-click fix under a finding's sentence, when the panel has one. */
  findingAction?: (finding: JobFinding) => ReactNode;
  /**
   * #667 — the rest pair's control data (the setup's rough and rest cutters), or null when this
   * row's item is not in a setup or the job has no cutter. The panel owns the registry reading.
   */
  rest?: RestChoice | null;
  /** #687 — the row's Technical fold (the V-carve geometry), when this item has any. */
  technical?: ReactNode;
}

export function EngraveCombinedRow({
  shape,
  index,
  maxDepth,
  maxDepthWhy = 'the stock thickness less the minimum floor',
  candidates,
  onChange,
  onRemove,
  findings,
  findingAction,
  rest = null,
  technical = null,
}: EngraveCombinedRowProps): JSX.Element {
  // #662 - the chip states what THIS cutter makes of a region.
  const region = useRegionOperationType();
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
        {/* #726 P6 — inset, ring wall and gap are all lengths, like the depth below them. */}
        <span>mm</span>
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
    // #411 — the collapsed line, and the editor below it. A combined item's identity is its kind
    // until someone names it, so an unnamed one reads "Cut-away" rather than blank.
    <EngraveItemRow
      id={shape.id}
      selectable
      prefix="engrave-combined"
      index={index}
      glyph={KIND_GLYPH[shape.kind]}
      kindWord={KIND_LABEL[shape.kind]}
      typeLabel={regionChipLabel(shape.through, region)}
      name={itemOperationName(shape)}
      summary={rowSummary(shape.depth)}
      enabled={shape.enabled}
      enabledTitle="A disabled item is kept in the job but not cut, and cannot be referenced."
      removeTitle="Remove this item."
      removeNoun={KIND_LABEL[shape.kind].toLowerCase()}
      findings={findings}
      {...(findingAction === undefined ? {} : { findingAction })}
      onToggleEnabled={(enabled) => onChange({ enabled })}
      onRemove={onRemove}
      restLabel={rest?.chip ?? null}
      technical={technical}
    >
      <label style={ROW_INLINE}>
        <span>name</span>
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
      </label>

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
        Max depth {maxDepth} mm here — {maxDepthWhy}.
      </p>
      {rest !== null && <RestCutterControl rest={rest} testidPrefix="engrave-combined" index={index} />}
    </EngraveItemRow>
  );
}
