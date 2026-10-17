/**
 * The six fields that describe a cutter (#309 Type door, #335 Yours-row editor): name, shape, tip
 * and shank diameter, flute and shoulder length. One component because two surfaces ask the same
 * six questions of the same `Tool` — the Type door before a cutter exists, the detail rail once it
 * is the user's own — and two forms would be two places for "blank means unknown" to drift.
 *
 * THE RULES ARE NOT HERE. Blank-is-null, 0-is-refused and the shank/tip convention live in
 * `registerCutter.ts` (`specProblem`, `toolFromSpec`); this file is the boxes and their labels.
 */

import type { ChangeEvent } from 'react';
import type { CutterField } from '@/engine/cnc/cutterProfile';
import type { CutterSpec } from '@/engine/cnc/registerCutter';
import { cutterFieldsLinked } from '@/components/ui/cutterFieldLinks';
import { SHAPE_LABELS, TYPABLE_SHAPES } from './reading';

export interface CutterFieldsProps {
  /** Test-id stem: `<prefix>-name`, `-shape`, `-tip`, `-shank`, `-flute`, `-shoulder`. */
  prefix: string;
  spec: CutterSpec;
  onChange: (next: CutterSpec) => void;
  disabled: boolean;
  /** The dimension field the profile is pointing at; the matching box is marked. */
  highlight?: CutterField | null;
  /** Reports a box being hovered or focused, so the profile can mark its dimension. */
  onHighlight?: (field: CutterField | null) => void;
}

export function CutterFields({
  prefix,
  spec,
  onChange,
  disabled,
  highlight = null,
  onHighlight,
}: CutterFieldsProps) {
  const field = (key: keyof CutterSpec) => ({
    value: spec[key],
    disabled,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      onChange({ ...spec, [key]: e.target.value }),
  });

  /**
   * A box's link to the drawing (#489). The four lengths/diameters are the fields the Type door
   * owns; corner radius, the two angles and the tip's D1 code have no box here, and carry their
   * links in `CutterProfileFields` beside the drawing instead. Hover and focus both count, so the
   * link is usable without a mouse.
   */
  const link = (fieldName: CutterField) => ({
    className: `lf${cutterFieldsLinked(highlight, fieldName) ? ' is-active' : ''}`,
    'data-field': fieldName,
    onMouseEnter: () => onHighlight?.(fieldName),
    onMouseLeave: () => onHighlight?.(null),
    onFocus: () => onHighlight?.(fieldName),
    onBlur: () => onHighlight?.(null),
  });

  return (
    <>
      <label className="lf">
        <span>name</span>
        <input
          className="fld fld--text"
          type="text"
          placeholder="1 mm ball nose — green box"
          data-testid={`${prefix}-name`}
          {...field('name')}
        />
      </label>

      <label className="lf">
        <span>shape</span>
        <select className="fld fld--text" data-testid={`${prefix}-shape`} {...field('shape')}>
          {TYPABLE_SHAPES.map((shape) => (
            <option key={shape} value={shape}>
              {SHAPE_LABELS[shape]}
            </option>
          ))}
        </select>
      </label>

      {/* `tip ⌀` and `shank ⌀` are held together: this rail is narrow, and a break between a word
          and its symbol leaves a stray glyph alone on a line. */}
      <div className="grid2">
        <label {...link('tipDiameter')}>
          <span>tip&nbsp;⌀ mm</span>
          <input
            className="fld fld--num"
            type="number"
            min={0}
            step="0.001"
            placeholder="—"
            data-testid={`${prefix}-tip`}
            {...field('tipDiameter')}
          />
        </label>
        <label {...link('handleDiameter')}>
          <span>shank&nbsp;⌀ mm</span>
          <input
            className="fld fld--num"
            type="number"
            min={0}
            step="0.001"
            placeholder="—"
            data-testid={`${prefix}-shank`}
            {...field('handleDiameter')}
          />
        </label>
        <label {...link('fluteLength')}>
          <span>flute mm</span>
          <input
            className="fld fld--num"
            type="number"
            min={0}
            step="0.001"
            placeholder="—"
            data-testid={`${prefix}-flute`}
            {...field('fluteLength')}
          />
        </label>
        <label {...link('shoulderLength')}>
          <span>shoulder mm</span>
          <input
            className="fld fld--num"
            type="number"
            min={0}
            step="0.001"
            placeholder="—"
            data-testid={`${prefix}-shoulder`}
            {...field('shoulderLength')}
          />
        </label>
      </div>
    </>
  );
}
