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
import type { CutterSpec } from '@/engine/cnc/registerCutter';
import { SHAPE_LABELS, TYPABLE_SHAPES } from './reading';

export interface CutterFieldsProps {
  /** Test-id stem: `<prefix>-name`, `-shape`, `-tip`, `-shank`, `-flute`, `-shoulder`. */
  prefix: string;
  spec: CutterSpec;
  onChange: (next: CutterSpec) => void;
  disabled: boolean;
}

export function CutterFields({ prefix, spec, onChange, disabled }: CutterFieldsProps) {
  const field = (key: keyof CutterSpec) => ({
    value: spec[key],
    disabled,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      onChange({ ...spec, [key]: e.target.value }),
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
        <label className="lf">
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
        <label className="lf">
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
        <label className="lf">
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
        <label className="lf">
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
