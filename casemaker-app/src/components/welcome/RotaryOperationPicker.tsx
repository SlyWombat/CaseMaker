/**
 * #752 R-UI-4 — THE ROTARY OPERATION PICKER (design `rotary-flow.md` §3.6).
 *
 * The wizard's question step on a rod in the rotary chuck draws these three groups instead of the flat
 * ones. Each chip is one operation; the step asks for the one field the operation needs (the
 * fields live in `OperationStep`, which owns the answer the shell's Create reads).
 *
 * Every chip is enabled since #241 slice 2: the face group writes the job's face operations, each
 * with its own index. A chip that cannot be authored would carry a stated reason in words on the
 * screen (#726 W23), never only a hover title — no chip carries one today.
 */
import type { CSSProperties, JSX } from 'react';
import {
  SELECTION_CHIP,
  SELECTION_CHIP_DISABLED,
  SELECTION_CHIP_ON,
  useSelectionChipGrid,
} from '@/components/selectionChip';
import { Explain } from './Explain';
import { GLOSSARY, type GlossaryTerm } from './glossary';
import { ROTARY_OPERATION_GROUPS, type RotaryOperationId } from './rotaryOperations';

/**
 * #1109 item 9 — the rotary chips whose word has a glossary line ("Relief from a mesh" is the first
 * place the rod path says "relief"). The visible help is the gloss, then the chip's own blurb when
 * that says something the gloss does not.
 */
const ROTARY_TERM: Partial<Record<RotaryOperationId, GlossaryTerm>> = { relief: 'relief' };

const GROUP_LABEL: CSSProperties = { fontSize: 11, fontWeight: 600, color: '#9aa4b0', margin: '8px 0 3px' };
const TAGS: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', margin: '2px 0 0' };
const TAG: CSSProperties = { fontSize: 10, color: '#e0c07a', border: '1px solid #5a4a1d', borderRadius: 8, padding: '1px 6px' };

export interface RotaryOperationPickerProps {
  selected: RotaryOperationId | null;
  /** Only an enabled chip reaches this. */
  onPick: (id: RotaryOperationId) => void;
  /** The row's own test id, e.g. `start-wizard-op-rotary-${id}`. */
  testidFor: (id: RotaryOperationId) => string;
}

export function RotaryOperationPicker({ selected, onPick, testidFor }: RotaryOperationPickerProps): JSX.Element {
  const grid = useSelectionChipGrid();
  return (
    <div data-testid="rotary-operation-picker" style={{ marginTop: 4 }}>
      {ROTARY_OPERATION_GROUPS.map((group) => (
        <div key={group.id} data-testid={`rotary-operation-group-${group.id}`}>
          <div style={GROUP_LABEL}>{group.label}</div>
          <div style={grid}>
            {group.operations.map((op) => {
              const disabled = op.reason !== null;
              const on = !disabled && selected === op.id;
              // #1109 item 8 — the hover help is a VISIBLE line under the chip, in the blurb's own
              // words (rotaryOperations.ts); a refused chip shows its reason there instead.
              // #1109 item 9 — a glossed word's line comes from the glossary first.
              const help = op.reason ?? op.blurb;
              const term = disabled ? undefined : ROTARY_TERM[op.id];
              const extra =
                term !== undefined && !GLOSSARY[term].toLowerCase().includes(op.blurb.toLowerCase()) ? op.blurb : undefined;
              return (
                <div key={op.id} style={{ display: 'grid', gap: 2 }}>
                  <button
                className="sw-btn"
                    type="button"
                    data-testid={testidFor(op.id)}
                    aria-pressed={on}
                    disabled={disabled}
                    style={disabled ? SELECTION_CHIP_DISABLED : on ? SELECTION_CHIP_ON : SELECTION_CHIP}
                    onClick={() => onPick(op.id)}
                  >
                    {op.label}
                  </button>
                  {help !== null &&
                    (term === undefined ? (
                      <span
                        data-testid={`${testidFor(op.id)}-help`}
                        style={{ fontSize: 11, color: '#9aa4b0', lineHeight: 1.35 }}
                      >
                        {help}
                      </span>
                    ) : (
                      <Explain term={term}>{extra}</Explain>
                    ))}
                </div>
              );
            })}
          </div>
          {group.id === '3d' && group.operations.some((op) => op.tag !== null) && (
            // A fact tag beside its operation — `simulate only` — never a disabled state.
            <>
              <div style={TAGS}>
                {group.operations
                  .filter((op) => op.tag !== null)
                  .map((op) => (
                    <span key={`tag-${op.id}`} data-testid={`rotary-operation-tag-${op.id}`} style={TAG}>
                      {op.tag}
                    </span>
                  ))}
              </div>
              {/* #1109 item 9 — the tag's word says what this build cannot do; the gloss says what
                  the operator can. */}
              <Explain term="simulate-only" />
            </>
          )}
        </div>
      ))}
    </div>
  );
}
