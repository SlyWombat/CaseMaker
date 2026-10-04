import { BUNDLED_FONTS } from '@/engine/fonts/registry';
import type { CustomFont, TextFont, TextWeight } from '@/types/textLabel';

/**
 * The font and weight pickers shared by every label editor (#205).
 *
 * The text-label editor in `FeaturesPanel.tsx` and the Engrave label row both choose a
 * typeface from the bundled registry plus the project's embedded fonts, and both need the
 * same "missing - using sans" fallback when a saved job names a font this build does not
 * have. `resolveFont` degrades a missing id to the default face at render time
 * (`@/engine/fonts/registry`), so the option only has to say what is happening, not fix it.
 *
 * Extracted rather than copied so the two editors cannot drift: the issue's own instruction
 * ("find it in FeaturesPanel.tsx and extract it into a shared component rather than copying
 * it").
 */

export interface FontPickerProps {
  value: TextFont;
  onChange: (font: TextFont) => void;
  /** Embedded fonts of the open project, in addition to the bundled ones. */
  customFonts?: readonly CustomFont[];
  'aria-label'?: string;
  title?: string;
}

export function FontPicker({ value, onChange, customFonts = [], title, ...rest }: FontPickerProps) {
  const known =
    BUNDLED_FONTS.some((f) => f.id === value) || customFonts.some((f) => f.id === value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={rest['aria-label']}
      title={title}
    >
      {BUNDLED_FONTS.map((f) => (
        <option key={f.id} value={f.id}>
          {f.label}
        </option>
      ))}
      {customFonts.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name} (embedded)
        </option>
      ))}
      {!known && <option value={value}>{value} (missing - using sans)</option>}
    </select>
  );
}

export interface WeightPickerProps {
  value: TextWeight;
  onChange: (weight: TextWeight) => void;
  'aria-label'?: string;
  title?: string;
}

export function WeightPicker({ value, onChange, title, ...rest }: WeightPickerProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as TextWeight)}
      aria-label={rest['aria-label']}
      title={title}
    >
      <option value="regular">regular</option>
      <option value="bold">bold</option>
    </select>
  );
}
