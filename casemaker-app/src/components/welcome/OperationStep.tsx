/**
 * #681/#685 — step 4 of the one cutting-job wizard: the operation.
 *
 * The picker is the SHARED grouped one (`OperationPicker`, `operationTypes.ts`): the fourteen
 * operations in the mockup's four groups, the same words the panel's "+ Add operation" uses. The
 * chosen operation shows the one thing it cannot start without, under the grid — the text for an
 * engraving (with its recommended depth and font beside it, as the mockup draws them), the FILE
 * for Surface a mesh, nothing for a Pocket (it gets its size in the panel) (#685).
 *
 * It never creates the placeholder "New text" the old flow did (#679 §3.5, E3): an engraving with
 * no text is not a job, so Create waits and the sentence beside it says what to type. Surface a
 * mesh is a WHOLE-JOB operation, so on a job that already holds items its card is disabled with
 * its reason, not replaced by a sentence (B6).
 *
 * The store actions are the shell's (`onCreate`): this component decides WHAT was asked for, and
 * the shell makes it, opens its row and lands in Design — the one place that knows the wizard's
 * exit.
 */

import { useLayoutEffect, useState, type CSSProperties, type JSX } from 'react';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { newItemDepthFor, newTargetObjectId } from '@/store/engraveJobStore';
import { readGoalObjectFile } from '@/engine/import/targetObject';
import { FontPicker } from '@/components/panels/FontPicker';
import { OperationPicker } from '@/components/panels/OperationPicker';
import type { OperationTypeId } from '@/components/panels/operationTypes';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { TextFont } from '@/types/textLabel';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const ERROR: CSSProperties = { ...MUTED, color: '#f0b4ad' };
const FIELD_HEADING: CSSProperties = { fontSize: 12, fontWeight: 600, color: '#c8d3de' };
const FIELD_LABEL: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: '4px 0' };
const FIELD: CSSProperties = { width: 72 };
const FIELDS: CSSProperties = { display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' };
const FIELD_BOX: CSSProperties = { borderTop: '1px solid #2a2f36', marginTop: 10, paddingTop: 8 };
const UNBLOCK: CSSProperties = { fontSize: 11, color: '#e0c07a', margin: '6px 0 0' };

/** What Create asks the shell to make; `null` = nothing new (the job already has its operation). */
export type OperationChoice =
  | { type: 'engrave'; text: string; depth: number; font: TextFont }
  | { type: 'surface'; target: EngraveTargetObject | null }
  | { type: Exclude<OperationTypeId, 'engrave' | 'surface'> };

export interface OperationStepProps {
  job: EngraveJob;
  /** Whether the job already has an operation: a template's seeded line, or an imported design. */
  hasOperations: boolean;
  /** The step's current answer; the SHELL owns the footer, so the step reports rather than acts. */
  onChoiceChange: (choice: OperationChoice | null) => void;
}

export function OperationStep({ job, hasOperations, onChoiceChange }: OperationStepProps): JSX.Element {
  // The mockup's default: Engrave text is on for a job that has nothing to cut yet. A job that
  // already has an operation starts with nothing selected, so Create finishes without adding a
  // duplicate — a template's seeded line IS the item step 4 would otherwise make.
  const [picked, setPicked] = useState<OperationTypeId | null>(hasOperations ? null : 'engrave');
  const [text, setText] = useState('');
  // The blank's recommended depth (the stock kind decides it), editable here; never a hidden 0.5.
  const [depth, setDepth] = useState(() => newItemDepthFor(job));
  const [font, setFont] = useState<TextFont>(DEFAULT_FONT_ID);
  // The Surface a mesh pick's one field: the file, read here into the job's GOAL (#685).
  const [surface, setSurface] = useState<EngraveTargetObject | null>(null);
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [surfaceReading, setSurfaceReading] = useState(false);
  // #721 — what the goal makes: the part itself, or a mold to cast it in.
  const [makeMold, setMakeMold] = useState(false);

  const choice: OperationChoice | null =
    picked === 'engrave'
      ? { type: 'engrave', text, depth, font }
      : picked === 'surface'
        ? {
            type: 'surface',
            target:
              surface === null || !makeMold || surface.format === 'png' ? surface : { ...surface, goalMode: 'mold' },
          }
        : picked === null
          ? null
          : { type: picked };
  const unblock = operationCreateBlocked(choice);

  // Report on every input change: the footer's Create is the shell's, and it enables the moment the
  // answer is one that can be made. Keyed on the fields, not the object, so it does not re-fire.
  //
  // #745 — a LAYOUT effect, not a passive one. The shell's Create is disabled from the answer it
  // was last told, while the sentence beside the field is drawn from `choice` right here. With a
  // passive effect there is a commit — long enough to be painted, and to be caught by a page
  // evaluation, under load — where the text has arrived (so this sentence is gone) but the shell
  // still holds the empty answer (so Create is disabled with no words). The layout effect hands the
  // answer over in the same commit, before paint, so the button and its sentence never disagree.
  useLayoutEffect(() => {
    onChoiceChange(choice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, text, depth, font, surface, makeMold, onChoiceChange]);

  async function chooseGoal(file: File): Promise<void> {
    setSurfaceError(null);
    setSurfaceReading(true);
    try {
      const result = await readGoalObjectFile(file, newTargetObjectId(), job.stock);
      if (result.ok) setSurface(result.target);
      else setSurfaceError(result.error);
    } catch (e) {
      setSurfaceError(e instanceof Error ? e.message : String(e));
    } finally {
      setSurfaceReading(false);
    }
  }

  return (
    <div data-testid="engrave-setup-step-what" style={{ marginTop: 8 }}>
      <OperationPicker
        mode="select"
        testidFor={(id) => `engrave-setup-what-${id}`}
        onPick={setPicked}
        surfaceAllowed={!hasOperations}
        selected={picked}
      />

      {picked === 'engrave' && (
        <div data-testid="start-wizard-op-field" style={FIELD_BOX}>
          <div style={FIELD_HEADING}>Engrave text</div>
          <div style={FIELDS}>
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

      {picked === 'surface' && (
        <div data-testid="start-wizard-op-field" style={FIELD_BOX}>
          <div style={FIELD_HEADING}>Surface a mesh</div>
          <div style={FIELDS}>
            <label style={FIELD_LABEL}>
              <span>Mesh</span>
              <input
                type="file"
                accept=".stl,.3mf,.png,model/stl,model/3mf,image/png"
                data-testid="start-wizard-op-surface-file"
                aria-label="Mesh to surface"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void chooseGoal(file);
                }}
              />
            </label>
            {surfaceReading && <span style={MUTED}>Reading the mesh…</span>}
            {surface !== null && !surfaceReading && <span style={MUTED}>{surface.name}</span>}
          </div>
          {surface?.format !== 'png' && (
            <div style={FIELDS} role="radiogroup" aria-label="What to make">
              <label style={FIELD_LABEL}>
                <input
                  type="radio"
                  name="start-wizard-op-surface-make"
                  checked={!makeMold}
                  data-testid="start-wizard-op-surface-make-part"
                  onChange={() => setMakeMold(false)}
                />
                <span>Make the part</span>
              </label>
              <label style={FIELD_LABEL}>
                <input
                  type="radio"
                  name="start-wizard-op-surface-make"
                  checked={makeMold}
                  data-testid="start-wizard-op-surface-make-mold"
                  onChange={() => setMakeMold(true)}
                />
                <span>Make a mold of it</span>
              </label>
            </div>
          )}
          {makeMold && surface?.format !== 'png' && (
            <p style={MUTED} data-testid="start-wizard-op-surface-mold-note">
              The part's shape is cut as a cavity from the top, turned over so a casting reads the
              right way round. One side only: a part with undercuts needs a two-part mold.
            </p>
          )}
          {surfaceError !== null && (
            <p style={ERROR} data-testid="start-wizard-op-surface-error">
              {surfaceError}
            </p>
          )}
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
  if (choice === null) return null;
  if (choice.type === 'engrave') {
    if (choice.text.trim() === '') return 'Type the text to engrave.';
    if (!Number.isFinite(choice.depth) || choice.depth <= 0) return 'Depth must be above 0 mm.';
    return null;
  }
  // The mesh is the operation's one field; Create waits for a file that read cleanly.
  if (choice.type === 'surface') return choice.target === null ? 'Choose the mesh to surface.' : null;
  return null;
}
