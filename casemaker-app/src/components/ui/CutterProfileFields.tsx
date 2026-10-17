import { type JSX } from 'react';
import { cutterDimensionSpecs, type CutterField } from '@/engine/cnc/cutterProfile';
import type { Tool } from '@/engine/cnc/tool';
import { cutterFieldsLinked } from './cutterFieldLinks';
import './cutterProfile.css';

/**
 * The dimension vocabulary as text, beside the drawing (#489).
 *
 * The profile's dimension lines are the links, but the four boxes the Type door owns are not every
 * field a cutter can state: corner radius, included angle, half angle and the tip have no editor
 * box. This list names every code the shape uses — `DS DC LS LC CR TI AN D1` — and holds the same
 * hover/focus contract as the drawing, so every dimension has a field to point at in both
 * directions even when the form has no input for it. A field the record does not state reads
 * `? not stated`, in the warning colour, matching its dashed dimension.
 */
export interface CutterProfileFieldsProps {
  tool: Tool;
  highlightedField?: CutterField | null;
  onFieldHover?: (field: CutterField | null) => void;
  className?: string;
  testId?: string;
}

export function CutterProfileFields({
  tool,
  highlightedField = null,
  onFieldHover,
  className,
  testId = 'cutter-profile-fields',
}: CutterProfileFieldsProps): JSX.Element | null {
  const specs = cutterDimensionSpecs(tool);
  if (specs.length === 0) return null;

  return (
    <div
      className={`cutter-profile-fields${className === undefined ? '' : ` ${className}`}`}
      data-testid={testId}
      role="list"
      aria-label="Cutter dimensions"
    >
      {specs.map((spec) => {
        const active = cutterFieldsLinked(highlightedField, spec.field);
        const value = spec.missing ? '? not stated' : spec.unit === 'mm' ? `${spec.text} mm` : spec.text;
        return (
          <div
            key={`${spec.code}:${spec.field}`}
            className={`cutter-profile-fields__row${spec.missing ? ' is-missing' : ''}${active ? ' is-active' : ''}`}
            data-field={spec.field}
            data-dimension={spec.code}
            data-missing={spec.missing ? 'true' : undefined}
            role="listitem"
            tabIndex={0}
            aria-label={`${spec.code} ${spec.label}: ${spec.missing ? 'not stated' : value}`}
            onMouseEnter={() => onFieldHover?.(spec.field)}
            onMouseLeave={() => onFieldHover?.(null)}
            onFocus={() => onFieldHover?.(spec.field)}
            onBlur={() => onFieldHover?.(null)}
          >
            <span className="cutter-profile-fields__code">{spec.code}</span>
            <span className="cutter-profile-fields__label">{spec.label}</span>
            <span className="cutter-profile-fields__value">{value}</span>
          </div>
        );
      })}
    </div>
  );
}
