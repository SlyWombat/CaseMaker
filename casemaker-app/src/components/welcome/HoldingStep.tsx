/**
 * #681/#684 — step 3 of the one cutting-job wizard: Holding.
 *
 * The step opens on WHAT IS ON THE MACHINE NOW (the location's active bed profile), then asks how
 * THIS stock sits in that mechanism. The options are computed from the stock's numbers by
 * `holdingMounts.ts`: a 3.81 mm plate stands 0.71 mm proud on the 3.1 mm ledge and that is the
 * default; a 2 mm sheet sits below the jaw tops, so a waste board under it is the default and the
 * ledge says why it is not; a block taller than the jaws is gripped as a block. The stock's form
 * word (plate/block/sheet) decides nothing here (§3.3's note).
 *
 * THE PICTURE CARRIES THE ORIENTATION FACTS the panel used to print as prose (A10, B4): a top view
 * of the mechanism, a fixed jaw on the left, X between the jaws. The three landmark answers sit in
 * one fold, and only when the stock has a face worth telling apart. They are stated, not offered as
 * controls: this build's single setup is the identity mount, so a select that changed nothing would
 * be a dead control (the A10 rule). See the completion note on #684.
 *
 * THE ESCAPE IS THE REAL WIZARD (#693). An option the installed mechanism cannot give carries its
 * cost and `Change the machine…`, which opens `openMachineChange` over this wizard with the mount
 * that option needs and this job's name; the machine-change wizard is mounted once by AppShell and
 * its backdrop sits at the raised layer of the stacking scale (#348), so it is above this modal.
 * Its `onDone` re-reads the location, which redraws this step with the new bed.
 *
 * The step writes as the answers change (not at a Finish button that no longer exists), so an edit
 * from the panel's Hold `edit` is kept when the operator closes. The #231 proud-vs-thickness case
 * is still shown here, with the seated value that resolves it.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import {
  stepFindings,
  withVise,
  type SetupAnswers,
} from '@/engine/cnc/engrave/setupFlow';
import { dedupeFindings, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { LEDGE_STEP, VISE_FLOOR_DEPTH } from '@/engine/cnc/fixture';
import { jobMachine } from '@/engine/cnc/calibration';
import { formLabel } from '@/engine/cnc/stockStart';
import { canDriveMachine } from '@/platform/capabilities';
import type { MachineMountKind } from '@/platform/machineChange';
import { useLocationStore } from '@/store/locationStore';
import { useSettingsStore } from '@/store/settingsStore';
import { openMachineChange } from '@/components/machine-change';
import type { EngraveJob, ViseParams } from '@/types/engraveJob';
import {
  DEFAULT_BOARD_MM,
  HOLDING_MOUNT_LABELS,
  HOLDING_MOUNT_WORDS,
  applyMount,
  applyRecommendedMount,
  boardChoices,
  boardProvenance,
  currentMount,
  fmt,
  machineNow,
  mechanismOf,
  mountOptions,
  seatedProud,
  type HoldingMount,
  type MountOption,
  type ViseHoldingMount,
} from './holdingMounts';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const FIELD_LABEL: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12, margin: '2px 0' };
const SEVERITY_COLOR: Record<JobFinding['severity'], string> = { error: '#f0b4ad', warning: '#e0c07a', info: '#7fa6c9' };

/** One finding as the operator reads it: the sentence, never the code. */
function FindingRow({ finding, testid }: { finding: JobFinding; testid: string }): JSX.Element {
  return (
    <div data-testid={testid} style={{ fontSize: 12, lineHeight: 1.45, margin: '3px 0' }}>
      <span style={{ color: SEVERITY_COLOR[finding.severity] }}>● </span>
      {finding.message}
    </div>
  );
}

// ── The picture ────────────────────────────────────────────────────────────────────────────────

const SVG_TEXT = { fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 10, fill: '#d1d5db' } as const;
const SVG_MUTED = { ...SVG_TEXT, fill: '#9aa4b0' } as const;
const SVG_MONO = { fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, fill: '#d1d5db' } as const;

/**
 * The top view for a mechanism. The vise is the mockup's own drawing: the fixed jaw (dark) on the
 * left, the moving jaw on the right, X between them. The bed and rotary views are the same facts
 * for their mechanisms: the bracket corner / the axis line and which way X runs.
 */
export function HoldingPicture({
  mechanism,
  stock,
  seat = 'ledge',
}: {
  mechanism: 'vise' | 'bed' | 'rotary';
  stock: { length: number; width: number; thickness: number };
  seat?: 'ledge' | 'floor';
}): JSX.Element {
  const dims = `${fmt(stock.length)} × ${fmt(stock.width)}`;
  const caption =
    mechanism === 'bed'
      ? "Top view. The bed's front edge is nearest you; the bracket corner is the reference."
      : mechanism === 'rotary'
        ? 'Top view. The chuck is on the left; the axis runs along X.'
        : seat === 'floor'
          ? 'Top view. The fixed jaw is on the left; the blank sits on the vise body, its sides free.'
          : 'Top view. The fixed jaw is on the left; the blank sits on the soft jaws’ ledge.';
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <svg
        viewBox="0 0 240 150"
        style={{ width: '100%', maxWidth: '100%', display: 'block', border: '1px solid #2a2f36', background: '#10151b' }}
        role="img"
        aria-label={`Top view of the ${mechanism === 'bed' ? 'bed' : mechanism === 'rotary' ? 'rotary' : 'vise'}`}
        data-testid="engrave-setup-holding-picture"
        data-mechanism={mechanism}
      >
        <defs>
          <marker id="holding-x-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0 0 L6 3 L0 6 Z" fill="#d1d5db" />
          </marker>
        </defs>
        {mechanism === 'vise' ? (
          <>
            <rect x="18" y="30" width="34" height="90" fill="#5b6672" />
            <rect x="188" y="30" width="34" height="90" fill="#39424c" stroke="#5b6672" />
            <rect x="52" y="52" width="136" height="46" fill="#1e3a4a" stroke="#6aa6c9" strokeWidth="1.5" />
            <text x="120" y="79" textAnchor="middle" {...SVG_MONO}>
              {dims}
            </text>
            <text x="35" y="22" textAnchor="middle" {...SVG_MUTED}>
              fixed jaw
            </text>
            <text x="205" y="22" textAnchor="middle" {...SVG_MUTED}>
              moving jaw
            </text>
            <path d="M60 128 H180" stroke="#d1d5db" strokeWidth="1" markerEnd="url(#holding-x-arrow)" />
            <text x="120" y="142" textAnchor="middle" {...SVG_TEXT}>
              X runs between the jaws
            </text>
            <path d="M232 100 V60" stroke="#d1d5db" strokeWidth="1" />
            <text x="236" y="80" {...SVG_TEXT} transform="rotate(90 236 80)">
              Y
            </text>
          </>
        ) : mechanism === 'bed' ? (
          <>
            <rect x="24" y="26" width="192" height="98" fill="#141a21" stroke="#5b6672" />
            <path d="M24 96 h34 v28" fill="none" stroke="#5b6672" strokeWidth="4" />
            <text x="46" y="20" textAnchor="middle" {...SVG_MUTED}>
              bracket
            </text>
            <rect x="74" y="50" width="106" height="50" fill="#1e3a4a" stroke="#6aa6c9" strokeWidth="1.5" />
            <text x="127" y="79" textAnchor="middle" {...SVG_MONO}>
              {dims}
            </text>
            <path d="M40 130 H200" stroke="#d1d5db" strokeWidth="1" markerEnd="url(#holding-x-arrow)" />
            <text x="120" y="144" textAnchor="middle" {...SVG_TEXT}>
              X along the bed
            </text>
          </>
        ) : (
          <>
            <circle cx="50" cy="75" r="34" fill="#39424c" stroke="#5b6672" />
            <path d="M50 41 v18 M26 92 l16 -10 M74 92 l-16 -10" stroke="#5b6672" strokeWidth="5" />
            <rect x="84" y="61" width="112" height="28" fill="#1e3a4a" stroke="#6aa6c9" strokeWidth="1.5" />
            <text x="140" y="79" textAnchor="middle" {...SVG_MONO}>
              {dims}
            </text>
            <text x="50" y="122" textAnchor="middle" {...SVG_MUTED}>
              chuck
            </text>
            <path d="M92 128 H204" stroke="#d1d5db" strokeWidth="1" markerEnd="url(#holding-x-arrow)" />
            <text x="148" y="142" textAnchor="middle" {...SVG_TEXT}>
              the axis runs along X
            </text>
          </>
        )}
      </svg>
      <p className="hint" style={{ margin: 0 }} data-testid="engrave-setup-holding-caption">
        {caption}
      </p>
    </div>
  );
}

// ── The step ───────────────────────────────────────────────────────────────────────────────────

export interface HoldingStepProps {
  job: EngraveJob;
  answers: SetupAnswers;
  /** Apply the answer immediately: there is no later Finish to collect it. */
  onAnswers: (answers: SetupAnswers) => void;
}

export function HoldingStep({ job, answers, onAnswers }: HoldingStepProps): JSX.Element {
  const location = useLocationStore((s) => s.location);
  // The machine-change wizard reads the location's first machine (#693); the step reads the same
  // record so the line and the escape describe one machine.
  const machine = location?.machines[0] ?? null;
  const accessories = location?.accessories ?? [];
  const calibration = useSettingsStore((s) => s.machineCalibration);
  const now = useMemo(() => machineNow(machine), [machine]);
  const rotaryEnvelope = useMemo(() => jobMachine(job, calibration).rotary?.envelope, [job, calibration]);

  const options = useMemo(
    () => mountOptions({ machine, accessories, stock: answers.stock, rotaryEnvelope }),
    [machine, accessories, answers.stock, rotaryEnvelope],
  );
  const current = currentMount(answers);

  // The machine-only options have no way out when this build cannot drive a machine; a disabled
  // control with no escape is hidden (A10), not narrated.
  const shown = options.filter((o) => canDriveMachine || mechanismOf(o.mount) === 'vise');

  const boards = useMemo(() => boardChoices(now?.profile ?? null), [now]);
  const underMm = answers.sacrificial.under?.thickness ?? null;
  const [boardMm, setBoardMm] = useState<number>(underMm ?? boards[0]?.thickness ?? DEFAULT_BOARD_MM);
  const boardIndex = boards.findIndex((b) => b.thickness === boardMm);
  const boardValue = boardIndex >= 0 ? `loc:${boardIndex}` : 'typed';

  // First arrival at the step: the mount the stock calls for, unless someone has asserted a setup.
  // Deliberately once per mount of the step — a later answer is the operator's.
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current) return;
    applied.current = true;
    const next = applyRecommendedMount(answers, boardMm);
    if (next !== answers) onAnswers(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function choose(mount: ViseHoldingMount, mm: number = boardMm): void {
    onAnswers(applyMount(answers, mount, mm));
  }

  function changeMachine(target: MachineMountKind | null, holding: string): void {
    openMachineChange({
      ...(target === null ? {} : { target }),
      forJob: { name: job.name, holding },
      onDone: () => void useLocationStore.getState().refresh(),
    });
  }

  // The visible checks: the mount's sacrificial ones plus the blank's, minus the provenance note
  // that now lives in the Technical fold (B12/A10).
  const findings = useMemo(
    () =>
      dedupeFindings([
        ...stepFindings('holding', job, answers),
        ...stepFindings('blank', job, answers),
      ]),
    [job, answers],
  );
  const defaultFinding = findings.find((f) => f.code === 'vise-default') ?? null;
  const visibleFindings = findings.filter((f) => f.code !== 'vise-default');

  // The #231 fix, seated on the mount the answers are actually in: the board under the part is
  // part of the height (a 12 mm board is not ignored just because the seat is the ledge).
  const fix: ViseParams | null =
    answers.vise.stockProud < answers.stock.thickness
      ? null
      : {
          ...answers.vise,
          stockProud: seatedProud(answers),
          source: 'saved',
        };
  const seatPhrase = answers.vise.seat === 'floor' ? 'on the vise body' : 'on the jaws’ ledge';

  const form = job.stockEntry?.form;
  const heading = `How is the ${form === undefined ? 'blank' : formLabel(form).toLowerCase()} held?`;

  const finish = job.stockEntry?.finish;
  const hasFace = (finish !== undefined && finish !== 'unknown') || job.stock.colour !== undefined;

  // What the picture draws: the mechanism on the machine now, or the vise when no machine record
  // has been read (the app's own mount).
  const mechanism: 'vise' | 'bed' | 'rotary' = now?.mount ?? 'vise';

  return (
    <div data-testid="engrave-setup-step-holding" style={{ marginTop: 8 }}>
      {/* ── What is on the machine now ─────────────────────────────────────────────────────── */}
      <div
        data-testid="engrave-setup-machine-now"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
          border: '1px solid #2a2f36',
          background: '#10151b',
          borderRadius: 4,
          padding: '6px 8px',
          fontSize: 12,
          marginBottom: 10,
        }}
      >
        <span style={MUTED}>On the machine now</span>
        {now === null ? (
          <span data-testid="engrave-setup-machine-none">Not read from a machine record.</span>
        ) : (
          <>
            <b>{now.parts[0]}</b>
            {now.parts.length > 1 && <span>· {now.parts.slice(1).join(' · ')}</span>}
          </>
        )}
        {canDriveMachine && now !== null && (
          <button
            type="button"
            className="btn btn--sm"
            style={{ marginLeft: 'auto' }}
            data-testid="engrave-setup-change-machine"
            onClick={() => changeMachine(null, HOLDING_MOUNT_WORDS[current])}
          >
            Change the machine…
          </button>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(190px, 230px)',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'grid', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }} data-testid="engrave-setup-holding-heading">
            {heading}
          </span>

          <div data-testid="engrave-setup-holding-vise" style={{ display: 'grid', gap: 7 }}>
            {shown.map((option) => (
              <MountRow
                key={option.mount}
                option={option}
                checked={!option.disabled && current === option.mount}
                onChoose={() => choose(option.mount as ViseHoldingMount)}
                onMachineChange={() => {
                  if (option.escape !== null) changeMachine(option.escape, option.holdingWords);
                }}
                boardControl={
                  option.mount === 'board' && !option.disabled ? (
                    <BoardSelect
                      value={boardValue}
                      boards={boards}
                      mm={boardMm}
                      onSelect={(value) => {
                        if (value === 'typed') {
                          choose('board', boardMm);
                          return;
                        }
                        const board = boards[Number(value.slice('loc:'.length))];
                        if (board === undefined) return;
                        setBoardMm(board.thickness);
                        choose('board', board.thickness);
                      }}
                      onMm={(value) => {
                        if (!Number.isFinite(value) || value <= 0) return;
                        setBoardMm(value);
                        choose('board', value);
                      }}
                    />
                  ) : null
                }
              />
            ))}
          </div>

          {hasFace && (
            <details data-testid="engrave-setup-orientation">
              <summary style={{ fontSize: 12, cursor: 'pointer' }}>Which way round</summary>
              <ul style={{ ...MUTED, margin: '4px 0 0 18px', padding: 0 }}>
                <li>Face up: the printed face.</li>
                <li>Against the fixed jaw: the long edge.</li>
                <li>Nearest you: the left end.</li>
              </ul>
            </details>
          )}

          <details data-testid="engrave-setup-holding-technical">
            <summary style={{ fontSize: 12, cursor: 'pointer' }}>Technical</summary>
            <div style={{ marginTop: 4 }}>
              {defaultFinding !== null && (
                <FindingRow finding={defaultFinding} testid="engrave-setup-step-finding-vise-default" />
              )}
              <p style={MUTED} data-testid="engrave-setup-holding-jaws">
                Jaws: {fmt(answers.vise.fixedJawThickness)} mm fixed ·{' '}
                {fmt(answers.vise.movingJawThickness)} mm moving · {fmt(answers.vise.jawLength)} mm long ·{' '}
                ledge {fmt(LEDGE_STEP)} mm · vise body {fmt(VISE_FLOOR_DEPTH)} mm
              </p>
              {answers.sacrificial.under !== null && (
                <p style={MUTED} data-testid="engrave-setup-holding-board">
                  Board {fmt(answers.sacrificial.under.thickness)} mm (
                  {boardProvenance(answers.sacrificial.under.thickness, boards)}), taped down
                </p>
              )}
              {Object.values(answers.sacrificial.sides).some((s) => s !== null) && (
                <p style={MUTED} data-testid="engrave-setup-holding-strips">
                  Strips beside the part
                </p>
              )}
            </div>
          </details>
        </div>

        <HoldingPicture
          mechanism={mechanism}
          stock={answers.stock}
          seat={answers.vise.seat}
        />
      </div>

      {fix !== null && (
        <div
          data-testid="engrave-setup-fix-slot"
          style={{ border: '1px solid #7a5a28', background: '#241d12', borderRadius: 4, padding: 6, marginTop: 8 }}
        >
          <p style={{ ...MUTED, color: '#e0c07a', margin: 0 }}>
            The vise holds the stock {fmt(answers.vise.stockProud)} mm proud, taller than this{' '}
            {fmt(answers.stock.thickness)} mm blank. Seated {seatPhrase} it stands{' '}
            {fmt(fix.stockProud)} mm proud.
          </p>
          <button
            type="button"
            data-testid="engrave-setup-fix-proud"
            onClick={() => onAnswers(withVise(answers, { stockProud: fix.stockProud, source: fix.source }))}
          >
            Set stock proud to {fmt(fix.stockProud)} mm
          </button>
        </div>
      )}

      {visibleFindings.length > 0 && (
        <div data-testid="engrave-setup-findings" style={{ marginTop: 6 }}>
          {visibleFindings.map((f, i) => (
            <FindingRow key={`${f.code}-${i}`} finding={f} testid={`engrave-setup-step-finding-${f.code}`} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── One mount row ──────────────────────────────────────────────────────────────────────────────

function MountRow({
  option,
  checked,
  onChoose,
  onMachineChange,
  boardControl,
}: {
  option: MountOption;
  checked: boolean;
  onChoose: () => void;
  onMachineChange: () => void;
  boardControl: JSX.Element | null;
}): JSX.Element {
  const hint =
    option.disabled && option.reason !== null
      ? option.reason
      : option.hint !== null
        ? option.hint
        : null;
  return (
    <div data-testid={`engrave-setup-mount-row-${option.mount}`} data-disabled={option.disabled}>
      <label style={{ ...FIELD_LABEL, opacity: option.disabled ? 0.65 : 1 }}>
        <input
          type="radio"
          name="start-wizard-holding-mount"
          checked={checked}
          disabled={option.disabled}
          onChange={onChoose}
          data-testid={`engrave-setup-mount-${option.mount}`}
        />
        <span>
          <b style={{ fontWeight: checked ? 600 : 400 }}>{option.label}</b>
          {hint !== null && (
            <>
              <br />
              <span style={{ ...MUTED, margin: 0 }}>{hint}</span>
            </>
          )}
        </span>
      </label>
      {option.disabled && option.escape !== null && canDriveMachine && (
        <button
          type="button"
          className="btn btn--sm"
          style={{ marginLeft: 22, marginTop: 2 }}
          data-testid={`engrave-setup-change-${option.mount}`}
          onClick={onMachineChange}
        >
          Change the machine…
        </button>
      )}
      {option.mount === 'board' && boardControl !== null && (
        <div style={{ marginLeft: 22, marginTop: 2 }}>{boardControl}</div>
      )}
    </div>
  );
}

// ── The board under the part: the step's ONE sacrificial select ─────────────────────────────────

function BoardSelect({
  value,
  boards,
  mm,
  onSelect,
  onMm,
}: {
  value: string;
  boards: readonly { thickness: number; material: string; count: number }[];
  mm: number;
  onSelect: (value: string) => void;
  onMm: (value: number) => void;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <select
        className="fld"
        aria-label="Board under the part"
        data-testid="engrave-setup-sacrificial"
        value={value}
        onChange={(e) => onSelect(e.target.value)}
      >
        {boards.map((board, i) => (
          <option key={`${board.material}-${board.thickness}-${i}`} value={`loc:${i}`}>
            {fmt(board.thickness)} mm {board.material}
          </option>
        ))}
        <option value="typed">Other thickness…</option>
      </select>
      {value === 'typed' && (
        <label style={{ ...FIELD_LABEL, margin: 0 }}>
          <input
            type="number"
            className="fld"
            aria-label="Board thickness"
            data-testid="engrave-setup-board-thickness"
            min="0.1"
            step="0.1"
            value={mm}
            style={{ width: 64 }}
            onChange={(e) => onMm(Number(e.target.value))}
          />{' '}
          mm
        </label>
      )}
    </div>
  );
}

/** The label words, exported for the step's tests and the panel's future Hold line. */
export { HOLDING_MOUNT_LABELS, HOLDING_MOUNT_WORDS };
export type { HoldingMount };
