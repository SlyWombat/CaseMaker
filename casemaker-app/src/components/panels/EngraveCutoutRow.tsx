import type { CSSProperties, JSX } from 'react';
import { EngraveItemRow } from '@/components/panels/EngraveItemRow';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { CutoutPatch } from '@/store/engraveJobStore';
import type { EngraveCutout } from '@/types/engraveJob';

/**
 * One PROFILE CUT-OUT of an engrave job (#218).
 *
 * A cut-out is not a pocket: the cutter follows a closed path and removes a kerf one cutter wide,
 * through the blank and into the board. Its row therefore has no depth — the breakthrough rule
 * sets the floor — and carries the things the path needs:
 *
 *   - `of`, the item whose outline the path follows (`stock-inset` for the blank's own edge);
 *   - `side` and `inset`, which side of that outline the PATH runs on and how far from it;
 *   - the holding tabs, in MATERIAL millimetres (the CAM adds `2 × toolRadius` to the centre-path
 *     span, so the number here is the bridge the operator sees, not the move length).
 *
 * `tabs.count: 0` frees the part during the cut; the job's findings say so
 * (`released-onto-board`).
 */

const NUM: CSSProperties = { width: 60 };
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '2px 0' };
const ROW_INLINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 };
const FIELD_LABEL: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa4b0' };

/** One item the `of` picker can name, with the words the item list already uses for it. */
export interface CutoutTarget {
  id: string;
  label: string;
}

export interface EngraveCutoutRowProps {
  cutout: EngraveCutout;
  /** Position of this row in `job.cutouts`; only used for stable test ids. */
  index: number;
  /** Every item that can be cut around, excluding none: a cut-out may follow any item. */
  targets: readonly CutoutTarget[];
  onChange: (patch: CutoutPatch) => void;
  onRemove: () => void;
  /** Findings about THIS cut-out (the panel filters the job's list by `labelId`). */
  findings: readonly JobFinding[];
}

export function EngraveCutoutRow({
  cutout,
  index,
  targets,
  onChange,
  onRemove,
  findings,
}: EngraveCutoutRowProps): JSX.Element {
  const tabCount = cutout.tabs.count;
  return (
    <EngraveItemRow
      id={cutout.id}
      selectable
      prefix="engrave-cutout"
      index={index}
      glyph="⌐"
      kindWord="Cut-out"
      name={cutout.name?.trim() ? cutout.name : 'Cut-out'}
      summary={tabCount === 0 ? 'no tabs' : `${tabCount} tab${tabCount === 1 ? '' : 's'}`}
      enabled={cutout.enabled}
      enabledTitle="A disabled cut-out is kept in the job but not cut."
      removeTitle="Remove this cut-out."
      removeNoun="cut-out"
      findings={findings}
      onToggleEnabled={(enabled) => onChange({ enabled })}
      onRemove={onRemove}
    >
      <label style={ROW_INLINE}>
        <span>name</span>
        <input
          type="text"
          value={cutout.name ?? ''}
          placeholder="optional name"
          data-testid={`engrave-cutout-name-${index}`}
          aria-label={`Cut-out ${index + 1} name`}
          title="Optional name, shown in the operation list and findings."
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => onChange({ name: e.target.value || undefined })}
        />
      </label>

      <div style={ROW_INLINE}>
        <label style={FIELD_LABEL}>
          <span>of</span>
          <select
            value={cutout.of}
            data-testid={`engrave-cutout-of-${index}`}
            aria-label={`Cut-out ${index + 1} outline`}
            title="The outline the cut follows. The blank's own edge is inset from the stock; an item's outline is followed on the side and at the inset below."
            onChange={(e) => onChange({ of: e.target.value })}
          >
            <option value="stock-inset">Blank edge (inset)</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label style={FIELD_LABEL}>
          <span>side</span>
          <select
            value={cutout.side}
            data-testid={`engrave-cutout-side-${index}`}
            aria-label={`Cut-out ${index + 1} side`}
            title="Outside cuts around the part and frees it; inside cuts a hole in it. The kerf is centred on the path either way."
            onChange={(e) => onChange({ side: e.target.value as EngraveCutout['side'] })}
          >
            <option value="outside">outside</option>
            <option value="inside">inside</option>
          </select>
        </label>
        <label style={FIELD_LABEL}>
          <span>inset</span>
          <input
            type="number"
            min={0}
            step="any"
            value={cutout.inset}
            data-testid={`engrave-cutout-inset-${index}`}
            aria-label={`Cut-out ${index + 1} inset`}
            title="Distance from the outline (or the blank edge) to the cutter's PATH, mm. The material left at the edge is this less the tool radius."
            style={NUM}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) onChange({ inset: v });
            }}
          />
          <span>mm</span>
        </label>
      </div>

      <div style={ROW_INLINE}>
        <label style={FIELD_LABEL}>
          <span>tabs</span>
          <input
            type="number"
            min={0}
            max={64}
            step={1}
            value={tabCount}
            data-testid={`engrave-cutout-tabs-count-${index}`}
            aria-label={`Cut-out ${index + 1} tab count`}
            title="How many bridges of material hold the part. 0 cuts it free — which needs tape, glue or screws to keep it from moving."
            style={NUM}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= 0) onChange({ tabs: { count: v } });
            }}
          />
        </label>
        <label style={FIELD_LABEL}>
          <span>width</span>
          <input
            type="number"
            min={0.1}
            step="any"
            value={cutout.tabs.width}
            data-testid={`engrave-cutout-tabs-width-${index}`}
            aria-label={`Cut-out ${index + 1} tab width`}
            title="Tab width in MATERIAL, mm. The cutter's centre stops one tool radius short on each side, so the move span is this plus two radii."
            style={NUM}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) onChange({ tabs: { width: v } });
            }}
          />
        </label>
        <label style={FIELD_LABEL}>
          <span>height</span>
          <input
            type="number"
            min={0.1}
            step="any"
            value={cutout.tabs.height}
            data-testid={`engrave-cutout-tabs-height-${index}`}
            aria-label={`Cut-out ${index + 1} tab height`}
            title="Material left under the tab, measured up from the blank's bottom face, mm."
            style={NUM}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) onChange({ tabs: { height: v } });
            }}
          />
          <span>mm</span>
        </label>
      </div>

      <p style={MUTED}>
        The path cuts through the blank into the board; the tabs are bridges of material left uncut.
        Free the part and cut the tabs by hand only after the program ends.
      </p>
    </EngraveItemRow>
  );
}
