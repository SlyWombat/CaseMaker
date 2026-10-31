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
import { newItemDepthFor, newTargetObjectId, useEngraveJobStore } from '@/store/engraveJobStore';
import type { PcbAlignmentOffer } from '@/engine/import/pcbAlignment';
import { readGoalObjectFile } from '@/engine/import/targetObject';
import { FontPicker } from '@/components/panels/FontPicker';
import { OperationPicker } from '@/components/panels/OperationPicker';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { RotaryOperationPicker } from './RotaryOperationPicker';
import { operationCreateBlocked } from './operationCreate';
import { isSideGoal, jobHasItems, jobSetups, jobTargetObjects, jobTool, sideSetupIdOf } from '@/engine/cnc/engrave/jobSetup';
import { defaultFaceOperation } from '@/engine/cnc/rotary/faceOps';
import { cuttingDiameter } from '@/engine/cnc/tool';
import type { RotaryOperationId } from './rotaryOperations';
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

/** The job's cutter diameter, mm — the size a cross-hole starts at, so the seed is a hole it cuts. */
function toolDiameterMm(job: EngraveJob): number {
  const tool = jobTool(job);
  const d = tool === null ? null : cuttingDiameter(tool);
  return d !== null && d > 0 ? d : 3.175;
}
const UNBLOCK: CSSProperties = { fontSize: 11, color: '#e0c07a', margin: '6px 0 0' };
/** #723 P2-3 — one side of a part cut from several sides, as a choice. */
const SIDE_CHIP: CSSProperties = { fontSize: 11, padding: '4px 8px', borderRadius: 4, border: '1px solid #2a2f36', background: 'transparent', color: '#c8d3de', cursor: 'pointer' };
const SIDE_CHIP_ON: CSSProperties = { ...SIDE_CHIP, border: '1px solid #4a90d9', background: '#1c2b3a' };

/**
 * What Create asks the shell to make; `null` = nothing new (the job already has its operation).
 *
 * #752 — the rotary step widens two members rather than adding new types: `engrave` carries Reads
 * (along / around), and a `v-carve` may carry text (a V-cut line) with an empty text meaning "a
 * region to draw in the panel"; a `flute` may carry the length its wizard field states. A flat
 * step creates the same members without those fields and behaves exactly as before.
 *
 * #241 slice 2 — the FACE group's three operations are their own members, each carrying the index
 * (A) it is cut at and its one field. The shell writes them as the job's face operations, in the
 * order they were made.
 */
export type OperationChoice =
  | { type: 'engrave'; text: string; depth: number; font: TextFont; reads?: 'along' | 'around' }
  | { type: 'surface'; target: EngraveTargetObject | null; /** #723 P2-3 — the side it is written to. */ setupId?: string }
  /** #241 slice 2 — a flat on a face: the index and the depth. */
  | { type: 'flat'; a: number; depth: number }
  /** #241 slice 2 — evenly spaced flats: the first index, the count, and the across-flats. */
  | { type: 'faces-all-round'; a: number; count: number; acrossFlats: number }
  /** #241 slice 2 — a cross-hole: the index and the diameter. */
  | { type: 'cross-hole'; a: number; diameter: number }
  | { type: Exclude<OperationTypeId, 'engrave' | 'surface'>; text?: string; lengthMm?: number };

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
  // #752 R-UI-4 — on a rod in the chuck the step is the rotary one (§3.6): its own three groups,
  // and each operation's one field. `rotaryPicked` is null on a job that already has work, so
  // Create finishes without adding a duplicate — the same rule the flat picker follows.
  const rotary = rotaryMapOf(job) !== null;
  const [rotaryPicked, setRotaryPicked] = useState<RotaryOperationId | null>(hasOperations ? null : 'engrave');
  const [reads, setReads] = useState<'along' | 'around'>('along');
  const [vcarveText, setVcarveText] = useState('');
  const [fluteLengthMm, setFluteLengthMm] = useState(20);
  // #241 slice 2 — THE FACE GROUP'S one field each, seeded by `defaultFaceOperation` (§5): a Flat
  // at 0° and 1 mm; a hex whose across-flats is the largest inside the stock; a cross-hole at 0°
  // on the job's own cutter. The angle is the FIRST face for a ring.
  const faceRadiusMm = rotaryMapOf(job)?.radius ?? 0;
  const faceDefaults = defaultFaceOperation('flat', faceRadiusMm, toolDiameterMm(job));
  const [faceAngle, setFaceAngle] = useState(0);
  const [faceDepth, setFaceDepth] = useState(faceDefaults.depth ?? 1);
  const [facesCount, setFacesCount] = useState(6);
  const [facesAcross, setFacesAcross] = useState(() => defaultFaceOperation('faces-all-round', faceRadiusMm, toolDiameterMm(job)).acrossFlats ?? 0);
  const [holeDiameter, setHoleDiameter] = useState(() => defaultFaceOperation('cross-hole', faceRadiusMm, toolDiameterMm(job)).diameter ?? 0);
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
  // #743 P-4b — the circuit-board door. The set writes its items through the store's one import
  // action; the step only reads the files and reports the outcome (there is no `OperationChoice`
  // for it — the files ARE the design, and Create finishes without adding a placeholder).
  const [pcbReading, setPcbReading] = useState(false);
  const [pcbSummary, setPcbSummary] = useState<string | null>(null);
  // #743 P-4b review — the board-on-a-non-PCB-blank fact and its one-click fix; never a refusal.
  const [pcbStockFix, setPcbStockFix] = useState<string | null>(null);
  // #743 P-6 — a board on a holding of the operator's (the vise): stated with its one-click fix.
  const [pcbHoldingFix, setPcbHoldingFix] = useState<string | null>(null);
  // #723 P2-3 — THE WIZARD'S SIDES SURFACE. A job cut from more than one saved setup shows its
  // sides here, and the mesh picked below is written to the chosen side (`withSideGoal`), never
  // over the job's single target. One side (the ordinary job) keeps today's behaviour.
  const savedSides = job.setups !== undefined && job.setups.length > 1 ? jobSetups(job) : [];
  const sideGoals = jobTargetObjects(job).filter(isSideGoal);
  const [sideId, setSideId] = useState<string | null>(savedSides[0]?.id ?? null);
  const selectedSide = savedSides.some((s) => s.id === sideId) ? sideId : (savedSides[0]?.id ?? null);
  const goalForSide = (id: string): EngraveTargetObject | null =>
    sideGoals.find((g) => sideSetupIdOf(job, g) === id) ?? null;
  // #743 P-8 — a two-sided board whose holes the fitted probe cannot read, with its one-click offer.
  const [pcbAlignment, setPcbAlignment] = useState<PcbAlignmentOffer | null>(null);

  const surfaceChoice: OperationChoice = {
    type: 'surface',
    target:
      surface === null || !makeMold || surface.format === 'png' ? surface : { ...surface, goalMode: 'mold' },
    ...(selectedSide === null ? {} : { setupId: selectedSide }),
  };
  const choice: OperationChoice | null = rotary
    ? rotaryPicked === 'engrave'
      ? { type: 'engrave', text, depth, font, reads }
      : rotaryPicked === 'v-carve'
        ? { type: 'v-carve', text: vcarveText }
        : rotaryPicked === 'pocket'
          ? { type: 'pocket' }
          : rotaryPicked === 'flute'
            ? { type: 'flute', lengthMm: fluteLengthMm }
            : rotaryPicked === 'relief'
              ? surfaceChoice
              : rotaryPicked === 'flat'
                ? { type: 'flat', a: faceAngle, depth: faceDepth }
                : rotaryPicked === 'faces-all-round'
                  ? { type: 'faces-all-round', a: faceAngle, count: facesCount, acrossFlats: facesAcross }
                  : rotaryPicked === 'cross-hole'
                    ? { type: 'cross-hole', a: faceAngle, diameter: holeDiameter }
                    : null
    : picked === 'engrave'
      ? { type: 'engrave', text, depth, font }
      : picked === 'surface'
        ? surfaceChoice
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
  }, [picked, text, depth, font, surface, makeMold, rotary, rotaryPicked, reads, vcarveText, fluteLengthMm, selectedSide, faceAngle, faceDepth, facesCount, facesAcross, holeDiameter, onChoiceChange]);

  async function readPcbSet(files: File[]): Promise<void> {
    setPcbSummary(null);
    setPcbStockFix(null);
    setPcbHoldingFix(null);
    setPcbAlignment(null);
    setPcbReading(true);
    try {
      const out = await useEngraveJobStore.getState().importPcbFiles(files);
      setPcbSummary(
        out.ok
          ? `The board is in: ${out.itemCount} items from ${out.fileCount} files${out.twoSided ? ', cut on both faces' : ''}${out.warnings.length > 0 ? ` — ${out.warnings.map((w) => w.message).join(' ')}` : ''}`
          : out.reason,
      );
      if (out.ok) {
        setPcbStockFix(out.stockNotice);
        setPcbHoldingFix(out.holdingNotice);
        setPcbAlignment(out.alignment);
      }
    } finally {
      setPcbReading(false);
    }
  }

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

  const engraveField = rotary ? rotaryPicked === 'engrave' : picked === 'engrave';
  const surfaceField = rotary ? rotaryPicked === 'relief' : picked === 'surface';
  const vcarveField = rotary && rotaryPicked === 'v-carve';
  const pocketField = rotary && rotaryPicked === 'pocket';
  const fluteField = rotary && rotaryPicked === 'flute';
  // #241 slice 2 — the face group: each operation's one field, and the index it is cut at.
  const faceField = rotary && (rotaryPicked === 'flat' || rotaryPicked === 'faces-all-round' || rotaryPicked === 'cross-hole');

  return (
    <div data-testid="engrave-setup-step-what" style={{ marginTop: 8 }}>
      {savedSides.length > 0 && (
        <div data-testid="start-wizard-op-sides" style={{ marginBottom: 10 }}>
          <div style={FIELD_HEADING}>Sides</div>
          <p style={MUTED} data-testid="start-wizard-op-sides-note">
            This job is cut from {savedSides.length} sides. A mesh picked below is attached to the
            side you choose; the other sides keep theirs.
          </p>
          <div style={FIELDS} role="radiogroup" aria-label="Which side this mesh is for">
            {savedSides.map((setup, i) => {
              const goal = goalForSide(setup.id);
              return (
                <button
                  key={setup.id}
                  type="button"
                  role="radio"
                  aria-checked={selectedSide === setup.id}
                  data-testid={`start-wizard-op-side-${i}`}
                  onClick={() => setSideId(setup.id)}
                  style={selectedSide === setup.id ? SIDE_CHIP_ON : SIDE_CHIP}
                >
                  Side {i + 1} · {goal === null ? 'no goal yet' : goal.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {rotary ? (
        <RotaryOperationPicker
          selected={rotaryPicked}
          onPick={setRotaryPicked}
          testidFor={(id) => `start-wizard-op-rotary-${id}`}
        />
      ) : (
        <OperationPicker
          mode="select"
          testidFor={(id) => `engrave-setup-what-${id}`}
          onPick={setPicked}
          surfaceAllowed={!jobHasItems(job)}
          surfaceHint={
            savedSides.length > 0
              ? 'the mesh goes on the side chosen above; the other sides keep theirs'
              : undefined
          }
          selected={picked}
        />
      )}

      {engraveField && (
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
            {rotary && (
              // #752 — §3.6's one field for text on a round stock: which way the line reads,
              // along the rod by default (like a pencil's lettering).
              <label style={FIELD_LABEL} data-testid="start-wizard-op-reads">
                <span>Reads</span>
                <select
                  data-testid="start-wizard-op-reads-select"
                  aria-label="Reads"
                  style={FIELD}
                  value={reads}
                  onChange={(e) => setReads(e.target.value === 'around' ? 'around' : 'along')}
                >
                  <option value="along">along</option>
                  <option value="around">around</option>
                </select>
                <span style={MUTED}>the rod</span>
              </label>
            )}
          </div>
        </div>
      )}

      {vcarveField && (
        <div data-testid="start-wizard-op-field" style={FIELD_BOX}>
          <div style={FIELD_HEADING}>V-carve</div>
          <div style={FIELDS}>
            <label style={FIELD_LABEL}>
              <span>Text</span>
              <input
                type="text"
                data-testid="start-wizard-op-vcarve-text"
                aria-label="V-carve text"
                style={{ width: 180 }}
                value={vcarveText}
                onChange={(e) => setVcarveText(e.target.value)}
              />
            </label>
            <span style={MUTED}>Leave it empty to draw a region in the panel.</span>
          </div>
        </div>
      )}

      {pocketField && (
        <div data-testid="start-wizard-op-field" style={FIELD_BOX}>
          <div style={FIELD_HEADING}>Pocket</div>
          <p style={MUTED} data-testid="start-wizard-op-pocket-note">
            The pocket’s size and place come in the panel — Create adds it, ready to drag.
          </p>
        </div>
      )}

      {fluteField && (
        <div data-testid="start-wizard-op-field" style={FIELD_BOX}>
          <div style={FIELD_HEADING}>Flute</div>
          <div style={FIELDS}>
            <label style={FIELD_LABEL}>
              <span>Length along</span>
              <input
                type="number"
                min={0}
                step="any"
                data-testid="start-wizard-op-flute-length"
                aria-label="Flute length"
                style={FIELD}
                value={fluteLengthMm}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setFluteLengthMm(v);
                }}
              />
              <span style={MUTED}>mm</span>
            </label>
          </div>
        </div>
      )}

      {faceField && (
        <div data-testid="start-wizard-op-field" style={FIELD_BOX}>
          <div style={FIELD_HEADING}>
            {rotaryPicked === 'flat' ? 'Flat' : rotaryPicked === 'faces-all-round' ? 'Faces all round' : 'Cross-hole'}
          </div>
          <div style={FIELDS}>
            <label style={FIELD_LABEL}>
              <span>{rotaryPicked === 'faces-all-round' ? 'First face' : 'Angle'}</span>
              <input
                type="number"
                step="any"
                data-testid="start-wizard-op-face-angle"
                aria-label="Index angle"
                style={FIELD}
                value={faceAngle}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setFaceAngle(v);
                }}
              />
              <span style={MUTED}>°</span>
            </label>
            {rotaryPicked === 'flat' && (
              <label style={FIELD_LABEL}>
                <span>Depth</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  data-testid="start-wizard-op-face-depth"
                  aria-label="Flat depth"
                  style={FIELD}
                  value={faceDepth}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setFaceDepth(v);
                  }}
                />
                <span style={MUTED}>mm</span>
              </label>
            )}
            {rotaryPicked === 'faces-all-round' && (
              <>
                <label style={FIELD_LABEL}>
                  <span>Count</span>
                  <input
                    type="number"
                    min={3}
                    max={24}
                    step={1}
                    data-testid="start-wizard-op-faces-count"
                    aria-label="How many faces"
                    style={FIELD}
                    value={facesCount}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) setFacesCount(v);
                    }}
                  />
                </label>
                <label style={FIELD_LABEL}>
                  <span>Across flats</span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    data-testid="start-wizard-op-faces-across"
                    aria-label="Across flats"
                    style={FIELD}
                    value={facesAcross}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) setFacesAcross(v);
                    }}
                  />
                  <span style={MUTED}>mm</span>
                </label>
              </>
            )}
            {rotaryPicked === 'cross-hole' && (
              <label style={FIELD_LABEL}>
                <span>Diameter</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  data-testid="start-wizard-op-hole-diameter"
                  aria-label="Cross-hole diameter"
                  style={FIELD}
                  value={holeDiameter}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setHoleDiameter(v);
                  }}
                />
                <span style={MUTED}>mm</span>
              </label>
            )}
          </div>
          <p style={MUTED} data-testid="start-wizard-op-face-note">
            {rotaryPicked === 'flat'
              ? `Turned to A ${faceAngle}° and held while the face is cut; the flat is ${faceDepth} mm deep.`
              : rotaryPicked === 'faces-all-round'
                ? `${facesCount} faces, evenly spaced from A ${faceAngle}°, leaving ${facesAcross} mm across flats.`
                : `Turned to A ${faceAngle}° and drilled across; the hole comes out at the cutter's own diameter.`}
          </p>
        </div>
      )}

      {surfaceField && (
        <div data-testid="start-wizard-op-field" style={FIELD_BOX}>
          <div style={FIELD_HEADING}>{rotary ? 'Relief from a mesh' : 'Surface a mesh'}</div>
          <div style={FIELDS}>
            <label style={FIELD_LABEL}>
              <span>Mesh</span>
              <input
                type="file"
                accept=".stl,.3mf,.step,.stp,.png,model/stl,model/3mf,model/step,image/png"
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
                <span>Make a mould of it</span>
              </label>
            </div>
          )}
          {makeMold && surface?.format !== 'png' && (
            <p style={MUTED} data-testid="start-wizard-op-surface-mold-note">
              The part's shape is cut as a cavity from the top, turned over so a casting reads the
              right way round. One side only: a part with undercuts needs a two-part mould.
            </p>
          )}
          {surfaceError !== null && (
            <p style={ERROR} data-testid="start-wizard-op-surface-error">
              {surfaceError}
            </p>
          )}
        </div>
      )}

      {!rotary && (
        <div data-testid="start-wizard-op-pcb" style={FIELD_BOX}>
          <div style={FIELD_HEADING}>Circuit board from Gerber files</div>
          <p style={MUTED}>
            A board's copper, holes and outline as ordinary items: the copper kept, the band
            isolating it, the holes and the board cut-out. A board is cut from copper-clad PCB; on
            another blank the import says so and offers PCB stock, and can still be a practice cut.
          </p>
          <div style={FIELDS}>
            <label style={FIELD_LABEL}>
              <span>Files</span>
              <input
                type="file"
                multiple
                accept=".gbr,.gtl,.gbl,.gko,.gm1,.gto,.gbo,.gts,.gbs,.gtp,.gbp,.drl,.xln,.zip"
                data-testid="start-wizard-op-pcb-files"
                aria-label="Gerber and drill files"
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = '';
                  if (files.length > 0) void readPcbSet(files);
                }}
              />
            </label>
            {pcbReading && <span style={MUTED}>Reading the board…</span>}
            {pcbSummary !== null && !pcbReading && (
              <span style={MUTED} data-testid="start-wizard-op-pcb-summary">
                {pcbSummary}
              </span>
            )}
            {pcbHoldingFix !== null && !pcbReading && job.workholding.kind !== 'tape' && (
              <span style={MUTED} data-testid="start-wizard-op-pcb-holding-notice">
                {pcbHoldingFix}{' '}
                <button
                  type="button"
                  data-testid="start-wizard-op-pcb-use-holding"
                  onClick={() => {
                    useEngraveJobStore.getState().usePcbHolding();
                    setPcbHoldingFix(null);
                  }}
                >
                  Tape it to the bed
                </button>
              </span>
            )}
            {pcbAlignment !== null && !pcbReading && (
              <span style={MUTED} data-testid="start-wizard-op-pcb-alignment-notice">
                {pcbAlignment.message}{' '}
                {pcbAlignment.holes.length > 0 && (
                  <button
                    type="button"
                    data-testid="start-wizard-op-pcb-add-alignment"
                    onClick={() => {
                      useEngraveJobStore
                        .getState()
                        .addPcbAlignmentHoles(pcbAlignment.holes, pcbAlignment.diameterMm);
                      setPcbAlignment(null);
                    }}
                  >
                    Add two {pcbAlignment.diameterMm} mm alignment holes
                  </button>
                )}
              </span>
            )}
            {pcbStockFix !== null && !pcbReading && job.stock.material !== 'pcb' && (
              <span style={MUTED} data-testid="start-wizard-op-pcb-stock-notice">
                {pcbStockFix}{' '}
                <button
                  type="button"
                  data-testid="start-wizard-op-pcb-use-stock"
                  onClick={() => {
                    useEngraveJobStore.getState().usePcbStock();
                    setPcbStockFix(null);
                  }}
                >
                  Use PCB stock
                </button>
              </span>
            )}
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
