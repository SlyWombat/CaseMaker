/**
 * #681 — step 4 of the one cutting-job wizard: the operation.
 *
 * The picker is GROUPED (the mockup's four groups), and the chosen operation shows the one field it
 * cannot start without: the text for an engraving, nothing for a pocket (it gets its size in the
 * panel), the file for a mesh (requested from the panel, which owns the file input). It never
 * creates the placeholder "New text" the old flow did (#679 §3.5): an engraving with no text is not
 * a job, so Create waits and the sentence beside it says what to type.
 *
 * The store actions are the shell's (`onCreate`): this component decides WHAT was asked for, and
 * the shell makes it, opens its row and lands in Design — the one place that knows the wizard's
 * exit.
 */

import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { newItemDepthFor } from '@/store/engraveJobStore';
import { FontPicker } from '@/components/panels/FontPicker';
import {
  OPERATION_GROUPS,
  operationTypesInGroup,
  type OperationTypeId,
} from '@/components/panels/operationTypes';
import type { EngraveJob } from '@/types/engraveJob';
import type { TextFont } from '@/types/textLabel';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const FIELD_LABEL: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: '4px 0' };
const FIELD: CSSProperties = { width: 72 };
const GROUP_LABEL: CSSProperties = { fontSize: 11, fontWeight: 600, color: '#9aa4b0', margin: '8px 0 3px' };
const CHIPS: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4 };
const CHIP: CSSProperties = {
  padding: '4px 8px',
  border: '1px solid #2a2f36',
  borderRadius: 12,
  background: '#161b21',
  color: '#cfe',
  font: 'inherit',
  fontSize: 11,
  cursor: 'pointer',
};
const CHIP_ON: CSSProperties = { ...CHIP, borderColor: '#5a8abf', background: '#1d2a38', color: '#e6edf5' };
const UNBLOCK: CSSProperties = { fontSize: 11, color: '#e0c07a', margin: '6px 0 0' };

/** What Create asks the shell to make; `null` = nothing new (the job already has its operation). */
export type OperationChoice =
  | { type: 'engrave'; text: string; depth: number; font: TextFont }
  | { type: Exclude<OperationTypeId, 'engrave' | 'surface'> };

export interface OperationStepProps {
  job: EngraveJob;
  /** Whether the job already has an operation: a template's seeded line, or an imported design. */
  hasOperations: boolean;
  /** The step's current answer; the SHELL owns the footer, so the step reports rather than acts. */
  onChoiceChange: (choice: OperationChoice | null) => void;
  /** Surface a mesh needs a FILE, so the panel that owns the input is asked (never gated here). */
  onSurface: () => void;
}

export function OperationStep({ job, hasOperations, onChoiceChange, onSurface }: OperationStepProps): JSX.Element {
  // The mockup's default: Engrave text is on for a job that has nothing to cut yet. A job that
  // already has an operation starts with nothing selected, so Create finishes without adding a
  // duplicate — a template's seeded line IS the item step 4 would otherwise make.
  const [picked, setPicked] = useState<Exclude<OperationTypeId, 'surface'> | null>(
    hasOperations ? null : 'engrave',
  );
  const [text, setText] = useState('');
  // The blank's recommended depth (the stock kind decides it), editable here; never a hidden 0.5.
  const [depth, setDepth] = useState(() => newItemDepthFor(job));
  const [font, setFont] = useState<TextFont>(DEFAULT_FONT_ID);

  const choice: OperationChoice | null =
    picked === 'engrave'
      ? { type: 'engrave', text, depth, font }
      : picked === null
        ? null
        : { type: picked };
  const unblock = operationCreateBlocked(choice);

  // Report on every input change: the footer's Create is the shell's, and it enables the moment the
  // answer is one that can be made. Keyed on the fields, not the object, so it does not re-fire.
  useEffect(() => {
    onChoiceChange(choice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, text, depth, font, onChoiceChange]);

  function pick(id: OperationTypeId): void {
    if (id === 'surface') {
      // The panel owns the goal file input; the shell closes this modal so the dialog is visible.
      onSurface();
      return;
    }
    setPicked(id);
  }
  return (
    <div data-testid="engrave-setup-step-what" style={{ marginTop: 8 }}>
      {OPERATION_GROUPS.map((group) => {
        const types = operationTypesInGroup(group.id);
        // Surface a mesh is a WHOLE-JOB operation, so it is offered only on a job with nothing else
        // in it; otherwise the row says why, rather than showing a type that cannot run.
        const shown = types.filter((t) => t.id !== 'surface' || !hasOperations);
        if (shown.length === 0 && group.id !== '3d') return null;
        return (
          <div key={group.id} data-testid={`start-wizard-op-group-${group.id}`}>
            <div style={GROUP_LABEL}>{group.label}</div>
            <div style={CHIPS}>
              {shown.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  data-testid={`engrave-setup-what-${t.id}`}
                  aria-pressed={picked === t.id}
                  title={t.blurb}
                  style={picked === t.id ? CHIP_ON : CHIP}
                  onClick={() => pick(t.id)}
                >
                  {t.label}
                </button>
              ))}
              {group.id === '3d' && (
                <span style={MUTED} data-testid="start-wizard-op-surface-hint">
                  a whole-job operation; starts an empty job with it
                </span>
              )}
            </div>
          </div>
        );
      })}

      {picked === 'engrave' && (
        <div
          data-testid="start-wizard-op-field"
          style={{ borderTop: '1px solid #2a2f36', marginTop: 10, paddingTop: 8 }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: '#c8d3de' }}>Engrave text</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
            <label style={FIELD_LABEL}>
              <span>Text</span>
              <input
                type="text"
                data-testid="start-wizard-op-text"
                aria-label="Engrave text"
                style={{ width: 180 }}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <label style={FIELD_LABEL}>
              <span>Depth</span>
              <input
                type="number"
                min={0}
                step="any"
                data-testid="start-wizard-op-depth"
                aria-label="Engrave depth"
                style={FIELD}
                value={depth}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setDepth(v);
                }}
              />
              <span style={MUTED}>mm</span>
            </label>
            <label style={FIELD_LABEL} data-testid="start-wizard-op-font">
              <span>Font</span>
              <FontPicker value={font} onChange={setFont} aria-label="Font" />
            </label>
          </div>
        </div>
      )}

      {unblock !== null && (
        <p style={UNBLOCK} data-testid="start-wizard-create-unblock">
          {unblock}
        </p>
      )}
    </div>
  );
}

/** The button's disabled state, in the one place both the shell and its spec read it. */
export function operationCreateBlocked(choice: OperationChoice | null): string | null {
  if (choice === null || choice.type !== 'engrave') return null;
  if (choice.text.trim() === '') return 'Type the text to engrave.';
  if (!Number.isFinite(choice.depth) || choice.depth <= 0) return 'Depth must be above 0 mm.';
  return null;
}
