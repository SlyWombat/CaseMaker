/**
 * #874 (slice 3 of #870) — THE ONE SELECTION CHIP: the fill every selected control shares, and the
 * equal-width grid the operation chips are drawn in.
 *
 * The wizard says "what is cut" with chips — the operation chips (flat and rotary), the sides of a
 * part cut from several sides, and step 2's form buttons — and each had its own ON style before
 * this module. They now share {@link SELECTED_FILL}, so a pressed control looks the same whichever
 * question it answers; the shape and layout of each control stay its own.
 *
 * The grid is the mockup's (`docs/design/first-job-flow-mockups.html`, station 4): equal-width
 * chips, `auto-fill` at 120 px on a desktop, two columns on the phone. The phone width is the
 * wizard's own ({@link NARROW_QUERY}), read the same way its other phone layouts read it.
 */

import type { CSSProperties } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { NARROW_QUERY } from './welcome/wizardLayout';

/**
 * The one ON look: filled primary container, white text, no outline. Merged into a control's own
 * layout — a chip's padding, a form button's icon grid — so selecting never moves the control.
 */
export const SELECTED_FILL: CSSProperties = {
  background: 'var(--cm-color-primary-container)',
  borderColor: 'transparent',
  color: '#fff',
};

/** An operation chip, unselected: an outlined pill of the same shape in every picker. */
export const SELECTION_CHIP: CSSProperties = {
  padding: '4px 8px',
  // Longhands, not the `border` shorthand: the ON fill names `borderColor`, and React drops a
  // longhand that fights a shorthand set in the same style object.
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: '#2a2f36',
  borderRadius: 12,
  background: '#161b21',
  color: '#cfe',
  fontFamily: 'inherit',
  fontSize: 11,
  textAlign: 'center',
  cursor: 'pointer',
};

export const SELECTION_CHIP_ON: CSSProperties = {
  ...SELECTION_CHIP,
  ...SELECTED_FILL,
  fontWeight: 600,
};

export const SELECTION_CHIP_DISABLED: CSSProperties = {
  ...SELECTION_CHIP,
  color: '#6b7480',
  cursor: 'not-allowed',
  opacity: 0.7,
};

/** The chips' grid: equal columns, 120 px at the narrowest on a desktop, two on the phone. */
export function selectionChipGrid(narrow: boolean): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: narrow ? 'repeat(2, 1fr)' : 'repeat(auto-fill, minmax(120px, 1fr))',
    gap: 4,
    margin: '4px 0',
    alignItems: 'stretch',
  };
}

/** {@link selectionChipGrid} at the wizard's own phone width. */
export function useSelectionChipGrid(): CSSProperties {
  return selectionChipGrid(useMediaQuery(NARROW_QUERY));
}
