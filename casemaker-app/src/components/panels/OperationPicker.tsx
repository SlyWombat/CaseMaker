/**
 * #662/#685 — the operation picker: the one place a person says WHICH operation to add.
 *
 * It is used twice — the wizard's last step ("What are you cutting?") and the panel's
 * "+ Add operation" — so the words, the order, the groups and the set are one table
 * (`operationTypes.ts`). The caller owns what a pick DOES: the wizard selects the operation and
 * asks for its one field (#685, `OperationStep`); the panel adds it and opens its row.
 *
 * TWO MODES, ONE PICKER (#685):
 *  - `select` is the wizard: the sixteen operation chips, grouped, and the one hint a card needs
 *    (Surface a mesh is the whole job, which a job with work already cannot be). Nothing is added
 *    here; the shell's Create does that.
 *  - `add` is the panel's "+ Add operation": the same chips, plus every kind the old second
 *    vocabulary ("More kinds and imports") carried, drawn as OPTIONS OF the operation it always
 *    was — a Circle is a Pocket, a Line is Engrave text, a Hole array is a Hole, the primitives
 *    are Cut away's "3D shape" — and the two file routes under them.
 *
 * Surface a mesh is a WHOLE-JOB operation: the engine posts 3D surfacing for a pure goal job, and
 * a mesh added beside 2D work posts no cut. So on a job that already holds operations the card is
 * drawn DISABLED with the one sentence that says why — never hidden behind a sentence of its own
 * (principle 4, B6).
 */

import type { CSSProperties, JSX } from 'react';
import {
  SELECTION_CHIP,
  SELECTION_CHIP_DISABLED,
  SELECTION_CHIP_ON,
  useSelectionChipGrid,
} from '@/components/selectionChip';
import { Explain } from '@/components/welcome/Explain';
import { GLOSSARY, type GlossaryTerm } from '@/components/welcome/glossary';
import {
  OPERATION_GROUPS,
  operationOptionsInGroup,
  operationTypesInGroup,
  type OperationOptionDef,
  type OperationTypeDef,
  type OperationTypeId,
} from './operationTypes';

const GROUP_LABEL: CSSProperties = { fontSize: 11, fontWeight: 600, color: '#9aa4b0', margin: '8px 0 3px' };
const HINT: CSSProperties = { fontSize: 10, color: '#9aa4b0', lineHeight: 1.4, margin: '2px 0 0' };
const OPTIONS_ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', margin: '3px 0 0 12px' };
const OPTIONS_LABEL: CSSProperties = { fontSize: 10, color: '#9aa4b0', marginRight: 2 };
const OPTION_CHIP: CSSProperties = {
  padding: '2px 7px',
  border: '1px solid #2a2f36',
  borderRadius: 10,
  background: 'transparent',
  color: '#9fb4c8',
  font: 'inherit',
  fontSize: 10,
  cursor: 'pointer',
};
const OPTION_CHIP_DISABLED: CSSProperties = { ...OPTION_CHIP, color: '#6b7480', cursor: 'not-allowed', opacity: 0.7 };
const IMPORTS: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 10 };

/**
 * #1109 item 9 — A CHIP WHOSE LABEL NAMES A GLOSSARY TERM shows the glossary's line as its visible
 * help (the approved operator words — the same words the blurb already carried for most of these).
 * Where the blurb states a fact the gloss does not, it follows the gloss after the em dash.
 */
const CHIP_TERM: Partial<Record<OperationTypeId, GlossaryTerm>> = {
  'v-carve': 'v-carve',
  'v-carve-variable': 'variable-depth',
  inlay: 'inlay',
  prism: 'prism',
  flute: 'flute',
  texture: 'texture',
  'thread-external': 'boss',
};

function ChipHelp({ type }: { type: OperationTypeDef }): JSX.Element {
  const term = CHIP_TERM[type.id];
  if (term === undefined) {
    return <span style={{ display: 'block', fontSize: 10, opacity: 0.75, lineHeight: 1.3, textAlign: 'left' }}>{type.blurb}</span>;
  }
  const gloss = GLOSSARY[term];
  const extra = gloss.toLowerCase().includes(type.blurb.toLowerCase()) ? undefined : type.blurb;
  return <Explain term={term}>{extra}</Explain>;
}

export interface OperationPickerProps {
  /** `select` = the wizard's step 4; `add` = the panel's "+ Add operation" (#685). */
  mode: 'select' | 'add';
  /** The test id one operation's chip carries. The caller owns the stem. */
  testidFor: (id: OperationTypeId) => string;
  onPick: (id: OperationTypeId) => void;
  /** Whether "Surface a mesh" can run — the job holds no operations yet. */
  surfaceAllowed: boolean;
  /** `select` mode: which chip is on. */
  selected?: OperationTypeId | null;
  /** `add` mode only: a folded option was picked. */
  onOption?: (option: OperationOptionDef) => void;
  /** `add` mode only: whether a folded option can be added now (frame/cut-away need an item). */
  optionEnabled?: (option: OperationOptionDef) => boolean;
  /** `add` mode only: the two file routes, drawn under the groups. */
  onImportOutline?: () => void;
  onImportImage?: () => void;
  importing?: boolean;
}

/** Why "Surface a mesh" is off on a job that has work: on the card's title AND in words on the screen. */
const SURFACE_DISABLED_REASON = 'this job already has work — Surface a mesh starts a new, empty job';

export function OperationPicker({
  mode,
  testidFor,
  onPick,
  surfaceAllowed,
  selected = null,
  onOption,
  optionEnabled,
  onImportOutline,
  onImportImage,
  importing = false,
}: OperationPickerProps): JSX.Element {
  const grid = useSelectionChipGrid();
  return (
    <div data-testid="operation-picker" style={{ marginTop: 4 }}>
      {OPERATION_GROUPS.map((group) => (
        <div key={group.id} data-testid={`operation-picker-group-${group.id}`}>
          <div style={GROUP_LABEL}>{group.label}</div>
          <div style={grid}>
            {operationTypesInGroup(group.id).map((t) => {
              // A whole-job operation on a job that has work already: say why, at the card.
              const disabled = t.id === 'surface' && !surfaceAllowed;
              const on = mode === 'select' && selected === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  data-testid={testidFor(t.id)}
                  aria-pressed={mode === 'select' ? on : undefined}
                  disabled={disabled}
                  title={disabled ? SURFACE_DISABLED_REASON : undefined}
                  style={disabled ? SELECTION_CHIP_DISABLED : on ? SELECTION_CHIP_ON : SELECTION_CHIP}
                  onClick={() => onPick(t.id)}
                >
                  <span style={{ display: 'block' }}>{t.label}</span>
                  {/* #1109 — the help is VISIBLE, not a title: a glossed term's line comes from the
                      glossary, every other chip keeps its blurb. */}
                  <ChipHelp type={t} />
                </button>
              );
            })}
          </div>
          {group.id === 'file' && !surfaceAllowed && (
            // #726 W23 — a DISABLED card carries its reason in words on the screen (A10), not only
            // in a hover title: the generic rule says what the operation is, not why this job
            // cannot pick it now. Nothing is said while it CAN be picked (#874): on a new job that
            // is every job, so the enabled sentence told no one anything.
            <div style={HINT} data-testid="operation-picker-surface-hint">
              {SURFACE_DISABLED_REASON}
            </div>
          )}
          {mode === 'add' &&
            operationOptionsInGroup(group.id).map((row) => (
              <div key={row.operation} style={OPTIONS_ROW} data-testid={`operation-picker-options-${row.operation}`}>
                <span style={OPTIONS_LABEL}>{row.label}</span>
                {row.options.map((option) => {
                  const enabled = optionEnabled?.(option) ?? true;
                  // #1109 item 8 — the hover title becomes a VISIBLE line under its chip: the same
                  // text, on the screen, for touch and for anyone who never hovers.
                  const help =
                    enabled
                      ? option.title
                      : `A ${option.label.toLowerCase()} follows another item; add a label or a shape first.`;
                  return (
                    <div key={option.id} style={{ display: 'grid', gap: 2 }}>
                      <button
                        type="button"
                        data-testid={option.testId}
                        disabled={!enabled}
                        style={enabled ? OPTION_CHIP : OPTION_CHIP_DISABLED}
                        onClick={() => onOption?.(option)}
                      >
                        {option.label}
                      </button>
                      {help !== undefined && (
                        <span style={HINT} data-testid={`${option.testId}-help`}>
                          {help}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
        </div>
      ))}

      {mode === 'add' && (onImportOutline !== undefined || onImportImage !== undefined) && (
        <div style={IMPORTS} data-testid="operation-picker-imports">
          <span style={OPTIONS_LABEL}>From a file</span>
          {onImportOutline !== undefined && (
            <div style={{ display: 'grid', gap: 2 }}>
              <button
                type="button"
                data-testid="engrave-add-import-outline"
                disabled={importing}
                onClick={onImportOutline}
              >
                {importing ? 'Reading…' : 'Import outline or lines…'}
              </button>
              {/* #1109 item 8 — the long help is a visible line, not a title. */}
              <span style={HINT} data-testid="engrave-add-import-outline-help">
                Import an SVG or DXF drawing: its closed, filled shapes become a pocket, and its open
                paths become Engrave (line) operations. Text and images are reported, not dropped.
              </span>
            </div>
          )}
          {onImportImage !== undefined && (
            <div style={{ display: 'grid', gap: 2 }}>
              <button
                type="button"
                data-testid="engrave-add-trace-image"
                disabled={importing}
                onClick={onImportImage}
              >
                {importing ? 'Reading…' : 'Trace image…'}
              </button>
              <span style={HINT} data-testid="engrave-add-trace-image-help">
                Trace a bitmap — PNG, JPEG, GIF, WebP or BMP — into a cut region. Threshold,
                despeckle and corner smoothing are live in the dialog.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
