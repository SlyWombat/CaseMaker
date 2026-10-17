import { useId, useMemo, useState, type JSX } from 'react';
import {
  buildCutterProfile,
  type CutterField,
  type CutterProfilePath,
  type CutterProfileSize,
  type CutterProfileText,
  type CutterRefusal,
} from '@/engine/cnc/cutterProfile';
import type { Tool } from '@/engine/cnc/tool';
import type { Condition } from '@/engine/cnc/toolCondition';
import { cutterFieldsLinked } from './cutterFieldLinks';
import './cutterProfile.css';

/**
 * The cutter profile (#489), rendered from the same pure model the run sheet's SVG uses.
 *
 * The drawing is not decoration: it is the cutter's data. Every dimension line is linked to the
 * `Tool` field that supplied it (`data-field`), so the editor can highlight the dimension when the
 * field is hovered or focused and this component reports the reverse through `onFieldHover`. An
 * absent field is a dashed `?` dimension and a dashed edge — Makera's engravers and chamfers leave
 * `shoulderLength` empty, and the drawing must say so rather than guess a length. A refusal is not
 * hidden: the profile stays on the page, greyed, with the simulator's own code and reason under it.
 *
 * Three mounts, one component:
 *   - `thumb` — the silhouette only, for the cutter picker and the my-tools rows;
 *   - `full`  — dimensions and scale bars, for the editor and the tool detail;
 *   - `print` — the same drawing in monochrome, used by the run sheet via `cutterProfileSvg`.
 */
export interface CutterProfileProps {
  tool: Tool;
  size?: CutterProfileSize;
  /** The job's cut depth, mm, for the honest V groove overlay. */
  grooveDepth?: number | null;
  /** The simulator's refusal, drawn greyed with its reason. */
  refusal?: CutterRefusal | null;
  /** An owned cutter's label colour, drawn as a shank band. */
  labelColor?: string | null;
  /** The physical condition, when known. */
  condition?: Condition | null;
  /** A field highlighted from outside (the editor's hover/focus); links field → dimension. */
  highlightedField?: CutterField | null;
  /** Reports a dimension being hovered or focused; links dimension → field. */
  onFieldHover?: (field: CutterField | null) => void;
  className?: string;
  testId?: string;
}

function roleClass(path: CutterProfilePath): string {
  return `cutter-profile__path cutter-profile__path--${path.role}${path.missing ? ' is-missing' : ''}${path.fill === true ? ' is-fill' : ''}`;
}

function textProps(t: CutterProfileText): {
  x: number;
  y: number;
  textAnchor: 'start' | 'middle' | 'end';
  transform?: string;
} {
  return {
    x: t.x,
    y: t.y,
    textAnchor: t.anchor,
    ...(t.rotate === undefined ? {} : { transform: `rotate(${t.rotate} ${t.x} ${t.y})` }),
  };
}

export function CutterProfile({
  tool,
  size = 'full',
  grooveDepth = null,
  refusal = null,
  labelColor = null,
  condition = null,
  highlightedField = null,
  onFieldHover,
  className,
  testId = 'cutter-profile',
}: CutterProfileProps): JSX.Element {
  const [hovered, setHovered] = useState<CutterField | null>(null);
  const titleId = useId();
  const descId = useId();

  const model = useMemo(
    () =>
      buildCutterProfile(tool, {
        size,
        grooveDepth,
        refusal,
        labelColor,
        condition,
      }),
    [tool, size, grooveDepth, refusal, labelColor, condition],
  );

  // A dimension hover wins while it lasts; otherwise the editor's highlighted field does.
  const active = hovered ?? highlightedField ?? null;

  const enter = (field: CutterField) => {
    setHovered(field);
    onFieldHover?.(field);
  };
  const leave = () => {
    setHovered(null);
    onFieldHover?.(null);
  };

  const isRefused = model.refusal !== null;
  const wrapperClass = [
    'cutter-profile',
    `cutter-profile--${size}`,
    isRefused ? 'is-refused' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <figure className={wrapperClass} data-testid={testId} data-shape={model.shape}>
      <svg
        className="cutter-profile__svg"
        viewBox={`${model.viewBox.x} ${model.viewBox.y} ${model.viewBox.width} ${model.viewBox.height}`}
        role="img"
        aria-labelledby={`${titleId} ${descId}`}
      >
        <title id={titleId}>{model.title}</title>
        <desc id={descId}>{model.desc}</desc>

        {model.fillPath !== null && (
          <path className="cutter-profile__fill" d={model.fillPath} aria-hidden="true" />
        )}

        {model.paths.map((path, i) => (
          <path
            key={`p-${i}`}
            className={`${roleClass(path)}${path.missingField !== undefined && cutterFieldsLinked(active, path.missingField) ? ' is-active' : ''}`}
            d={path.d}
            data-role={path.role}
            data-dashed={path.dashed ? 'true' : undefined}
            data-missing-field={path.missingField}
            aria-hidden="true"
          />
        ))}

        {model.labelBand !== null && (
          <path
            className="cutter-profile__label-band"
            d={model.labelBand.d}
            style={labelColor !== null ? { fill: labelColor } : undefined}
            data-testid="cutter-profile-label-band"
            aria-hidden="true"
          />
        )}

        {model.dimensions.map((dimension) => {
          const isActive = cutterFieldsLinked(active, dimension.field);
          const label = `${dimension.code} ${dimension.label}: ${dimension.missing ? 'not stated' : dimension.text}`;
          return (
            <g
              key={dimension.code}
              className={`cutter-profile__dimension${dimension.missing ? ' is-missing' : ''}${isActive ? ' is-active' : ''}`}
              data-dimension={dimension.code}
              data-field={dimension.field}
              aria-label={label}
              role="group"
              tabIndex={0}
              onMouseEnter={() => enter(dimension.field)}
              onMouseLeave={leave}
              onFocus={() => enter(dimension.field)}
              onBlur={leave}
            >
              <title>{label}</title>
              {dimension.paths.map((path, i) => (
                <path
                  key={`d-${dimension.code}-${i}`}
                  className={roleClass(path)}
                  d={path.d}
                  data-dashed={path.dashed ? 'true' : undefined}
                  aria-hidden="true"
                />
              ))}
              {dimension.textAt.background !== undefined && (
                <rect
                  className="cutter-profile__dimension-background"
                  x={dimension.textAt.background.x}
                  y={dimension.textAt.background.y}
                  width={dimension.textAt.background.width}
                  height={dimension.textAt.background.height}
                  aria-hidden="true"
                />
              )}
              <text
                className={`cutter-profile__dimension-text${dimension.missing ? ' is-missing' : ''}`}
                {...textProps(dimension.textAt)}
                aria-hidden="true"
              >
                {dimension.textAt.text}
              </text>
            </g>
          );
        })}

        {model.groove !== null && (
          <g className="cutter-profile__groove" data-testid="cutter-profile-groove">
            {model.groove.paths.map((path, i) => (
              <path key={`g-${i}`} className={roleClass(path)} d={path.d} data-dashed={path.dashed ? 'true' : undefined} aria-hidden="true" />
            ))}
            <text className="cutter-profile__groove-label" {...textProps(model.groove.label)}>
              {model.groove.label.text}
            </text>
          </g>
        )}

        {model.extraMarks.map((mark, i) => (
          <text
            key={`m-${i}`}
            className={`cutter-profile__mark${mark.missing === true ? ' is-missing' : ''}`}
            {...textProps(mark)}
            aria-hidden="true"
          >
            {mark.text}
          </text>
        ))}

        {model.scaleBars.length > 0 && (
          <g className="cutter-profile__scale" data-testid="cutter-profile-scale">
            {model.scaleBars.map((bar, i) => (
              <g key={`bar-${i}`}>
                <path className="cutter-profile__scale-line" d={`M${bar.x1},${bar.y1} L${bar.x2},${bar.y2}`} aria-hidden="true" />
                {bar.ticks.map((tick, j) => (
                  <path
                    key={`tick-${j}`}
                    className="cutter-profile__scale-line"
                    d={`M${tick.x1},${tick.y1} L${tick.x2},${tick.y2}`}
                    aria-hidden="true"
                  />
                ))}
                <text className="cutter-profile__scale-text" {...textProps(bar.textAt)}>
                  {bar.textAt.text}
                </text>
              </g>
            ))}
            {model.scaleNoteAt !== null && (
              <text className="cutter-profile__scale-note" {...textProps(model.scaleNoteAt)}>
                {model.scaleNoteAt.text}
              </text>
            )}
          </g>
        )}
      </svg>

      {size !== 'thumb' && model.refusal !== null && (
        <p className="cutter-profile__refusal" data-testid="cutter-profile-refusal" role="note">
          <strong>{model.refusal.code}</strong> — {model.refusal.reason}
        </p>
      )}
      {size !== 'thumb' && model.condition !== null && model.condition !== 'new' && model.condition !== 'used' && (
        <p className="cutter-profile__condition" data-testid="cutter-profile-condition">
          Marked <strong>{model.condition}</strong>; the drawing shows the stated geometry only.
        </p>
      )}
    </figure>
  );
}
