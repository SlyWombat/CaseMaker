/**
 * One line of the Setups section (§5.4, #471), and the open row behind it.
 *
 * The LINE is the compact reading the design asks for: the ordinal and the face up, the mount and
 * its reference, the items, and every error as a code — so a stale saved list is visible without
 * opening anything. The OPEN ROW is where the person acts: turn the stock, change the fixture,
 * assign or remove an item, pick the one tool, plan and approve the registration, and preview the
 * remount.
 *
 * Pure vocabulary stays in the engine: the face and mount come from `orient`, the checks from the
 * planner's `Setup.findings`, the registration from `registrationFor` / `summarizePlan`, and the
 * remount from `describeRemount`. This component only holds the seat being typed and the plan being
 * previewed; nothing is written until the person approves it.
 */

import { useMemo, useState, type CSSProperties, type JSX } from 'react';
import { cuttingDiameter } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { summarizePlan } from '@/engine/cnc/registration/summary';
import { expandEngraveRow } from '@/store/engraveRowStore';
import type { PlanMountTap, RegistrationPlan } from '@/engine/cnc/registration/plan';
import { FACES, type Face, type Mount, type MountSpec, type Setup } from '@/engine/cnc/setups';
import type { SetupAuthoringFinding, SetupItemsReading } from '@/engine/cnc/setups';
import { VISE_SEAT_MACHINE_Z } from '@/engine/cnc/fixture';
import type { JobSetup, ViseParams } from '@/types/engraveJob';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const FIELD_LABEL: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: '4px 0' };
const FIELD: CSSProperties = { width: 90 };
const TAG: CSSProperties = {
  fontSize: 10,
  padding: '1px 5px',
  borderRadius: 3,
  border: '1px solid #2a2f36',
  color: '#9aa4b0',
  whiteSpace: 'nowrap',
};
const ERROR_COLOR = '#f0b4ad';
const WARN_COLOR = '#e0c07a';

/** What pressing "Plan registration" answered — an engine plan, a refusal, or a missing input. */
export type RegistrationAttempt =
  | { kind: 'need-seat'; message: string }
  // #607 — the tap carries which mount reference it is, so the button names the right one.
  | { kind: 'need-datum'; message: string; mountTap: PlanMountTap | null }
  | { kind: 'refused'; reason: string }
  | { kind: 'plan'; method: Mount; plan: RegistrationPlan; summary: string; expected: string };

export interface EngraveSetupRowProps {
  /** 0-based, like the stored list; the operator reads `index + 1`. */
  index: number;
  total: number;
  setup: JobSetup;
  /** The planner's setup for this row, or absent when it has no cut item to plan. */
  derived: Setup | undefined;
  reading: SetupItemsReading;
  /** False for the compatibility reading and for a suggested plan: show, do not write. */
  editable: boolean;
  /** #579 — the wizard opens the first row so the Plan/Approve controls are on screen. */
  initiallyOpen?: boolean;
  findings: SetupAuthoringFinding[];
  itemName: (id: string) => string;
  /** Cut items that can move to this setup's up face (not already in it). */
  candidateItems: readonly { id: string; name: string }[];
  tools: readonly ToolLibraryEntry[];
  /** Vise and bracket; tape only when the saved setup already carries it. */
  mountKinds: readonly Mount[];
  /** The job's vise provenance: `'default'` is the shipped Z1 vise; a custom fixture is `saved`/`measured`. */
  viseSource: ViseParams['source'];
  /** Setup 1 names the facing pass when the job enables one. */
  facingPass: boolean;
  /** A refused orientation/mount change, in the engine's words. */
  notice: string | null;
  remountMinutes: number;
  reregisterMinutes: number;
  onFace: (face: Face) => void;
  onMount: (kind: Mount) => void;
  onTool: (key: string) => void;
  onAssign: (id: string) => void;
  onRemoveItem: (id: string) => void;
  onRemoveSetup: () => void;
  onReplace: (next: JobSetup) => void;
  onPreviewRemount: () => void;
  planRegistration: (seatZ: string, useTypedSeat: boolean) => RegistrationAttempt;
  /** #599 — run the standalone mount tap (no datum yet) and write the reading. */
  onTapJaw: (tap: { x: number; y: number; fromMachineZ: number }) => void;
  /** #637 — a tap is running somewhere in this window: the button is disabled, not orphaned. */
  tapBusy: boolean;
  /** #603 — the checked-out probe's name, or null when none is checked out. */
  probeName?: string | null;
  /** #603 — the machine's display name, or null when there is no location record. */
  machineName?: string | null;
}

function holderWords(mount: MountSpec): string {
  if (mount.kind === 'vise') return 'vise, on its ledges';
  if (mount.kind === 'bracket') return 'bracket, in its inside corner';
  return 'tape, on the bed';
}

function itemChip(
  id: string,
  name: string,
  state: 'cut' | 'missing' | 'not-cut',
): JSX.Element {
  const color = state === 'cut' ? '#d1d5db' : state === 'missing' ? ERROR_COLOR : WARN_COLOR;
  const common = {
    title:
      state === 'cut'
        ? `${name} (${id}) — press to open its row`
        : state === 'missing'
          ? `${id} is no longer in the job`
          : `${name} (${id}) no longer cuts`,
    style: { ...TAG, color, ...(state === 'cut' ? { cursor: 'pointer' as const } : {}) },
    'data-testid': `engrave-setup-item-${id}`,
  };
  const text = `${name}${state === 'cut' ? '' : state === 'missing' ? ' (missing)' : ' (not cut)'}`;
  return state === 'cut' ? (
    <button key={id} type="button" {...common} onClick={() => expandEngraveRow(id)}>
      {text}
    </button>
  ) : (
    <span key={id} {...common}>
      {text}
    </span>
  );
}

export function EngraveSetupRow(props: EngraveSetupRowProps): JSX.Element {
  const { index, setup, derived, reading, editable, findings } = props;
  const n = index + 1;
  const [open, setOpen] = useState(props.initiallyOpen === true);
  // The shipped Z1 vise carries a known provisional seat aim (#559); a custom/measured fixture
  // does not, so its field stays empty and the operator types the probe reading as before.
  const shippedZ1Vise = setup.mount.kind === 'vise' && props.viseSource === 'default';
  const [seatZ, setSeatZ] = useState('');
  // #598 — the expert override: use the typed seat instead of the measured jaw-top datum. Off by default.
  const [useTypedSeat, setUseTypedSeat] = useState(false);
  // The field says where its aim came from: a default is an AIM, not a reading, and the probe still
  // writes the true Z — so a shipped-vise default and a typed custom reading must read differently.
  const seatTitle = shippedZ1Vise
    ? `The Z1’s provisional vise-seat aim (${VISE_SEAT_MACHINE_Z} mm); the probe still measures the true Z. Override for a non-standard setup.`
    : 'The machine Z of the surface the stock sits on — measured with one probe touch, never assumed.';
  const seatHint = shippedZ1Vise
    ? 'the Z1 vise’s provisional seat aim — the probe still measures the true Z; override for a non-standard setup'
    : 'the measured surface under the stock; the section invents no number';
  const [preview, setPreview] = useState<{ for: string; value: RegistrationAttempt } | null>(null);

  // A plan is a statement about ONE mount and one item list. Change either and it stops describing
  // this row: the derived `attempt` below is then null, so Approve is not drawn until planned again.
  const signature = `${setup.mount.kind}:${setup.mount.board === true}:${FACES.map((f) => setup.orientation[f]).join(',')}:${setup.itemIds.join(',')}`;
  const attempt = preview !== null && preview.for === signature ? preview.value : null;

  const faceUp = setup.orientation.top;
  const candidates = useMemo(() => props.candidateItems, [props.candidateItems]);

  function planNow(): void {
    setPreview({ for: signature, value: props.planRegistration(seatZ, useTypedSeat) });
  }

  function approve(): void {
    if (attempt?.kind !== 'plan') return;
    props.onReplace({
      ...setup,
      registration: { method: attempt.method, plan: attempt.plan, expected: attempt.expected },
    });
    setPreview(null);
  }

  const toolLabel = (e: ToolLibraryEntry): string => {
    const d = cuttingDiameter(e.tool);
    return d === null ? e.tool.name : `${e.tool.name} — Ø ${d} mm cutting`;
  };

  // #667 — the pair this setup cuts with, when the region rows gave it a rest cutter: the number
  // pair is the one the row's chip and the run sheet's rest section use.
  const pairWords = ((): string | null => {
    if (setup.tools.length < 2) return null;
    const dia = (key: string | undefined): string | null => {
      const entry = key === undefined ? undefined : props.tools.find((e) => e.key === key);
      const d = entry === undefined ? null : cuttingDiameter(entry.tool);
      return d === null ? (key ?? null) : `⌀${Number(d.toFixed(3))} mm`;
    };
    const rough = dia(setup.tools[0]);
    const rest = dia(setup.tools[1]);
    if (rough === null || rest === null) return null;
    return `${rough} rough · ${rest} rest`;
  })();

  return (
    <div className="engrave-setups__row" data-testid={`engrave-setup-${n}`}>
      <div className="engrave-setups__row-head">
        <button
          type="button"
          className="engrave-setups__expand"
          aria-expanded={open}
          data-testid={`engrave-setup-expand-${n}`}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="engrave-setups__caret">{open ? '▾' : '▸'}</span>
          <b data-testid={`engrave-setup-ordinal-${n}`}>Setup {n}</b>
        </button>
        <span style={TAG} data-testid={`engrave-setup-face-words-${n}`}>
          {faceUp} up
        </span>
        <span style={TAG} data-testid={`engrave-setup-mount-words-${n}`}>
          {holderWords(setup.mount)}
        </span>
        {pairWords !== null && (
          <span style={TAG} data-testid={`engrave-setup-pair-${n}`}>
            {pairWords}
          </span>
        )}
        {props.machineName != null && (
          <span style={TAG} data-testid={`engrave-setup-machine-${n}`}>
            {props.machineName}
          </span>
        )}
        {props.probeName != null && (
          <span style={TAG} data-testid={`engrave-setup-probe-${n}`}>
            {props.probeName}
          </span>
        )}
        <span className="engrave-setups__items">
          {reading.itemIds.length === 0 ? (
            <span style={{ ...MUTED, margin: 0 }}>no items</span>
          ) : (
            reading.itemIds.map((id) =>
              itemChip(id, props.itemName(id), reading.missing.includes(id) ? 'missing' : reading.notCut.includes(id) ? 'not-cut' : 'cut'),
            )
          )}
        </span>
        {findings.map((f) => (
          <span
            key={f.code}
            data-testid={`engrave-setup-finding-${n}-${f.code}`}
            title={f.message}
            style={{ ...TAG, color: ERROR_COLOR, borderColor: '#7a3a34' }}
          >
            ● {f.code}
          </span>
        ))}
        {props.facingPass && (
          <span style={TAG} data-testid={`engrave-setup-facing-${n}`}>
            the facing pass runs first here
          </span>
        )}
      </div>

      {open && (
        <div className="engrave-setups__body" data-testid={`engrave-setup-body-${n}`}>
          {editable ? (
            <>
              <label style={FIELD_LABEL}>
                <span>Face up</span>
                <select
                  value={faceUp}
                  data-testid={`engrave-setup-face-${n}`}
                  aria-label={`Setup ${n} face up`}
                  onChange={(e) => props.onFace(e.target.value as Face)}
                >
                  {FACES.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
              <label style={FIELD_LABEL}>
                <span>Held by</span>
                <select
                  value={setup.mount.kind}
                  data-testid={`engrave-setup-mount-${n}`}
                  aria-label={`Setup ${n} mount`}
                  onChange={(e) => props.onMount(e.target.value as Mount)}
                >
                  {props.mountKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                      {kind === 'tape' ? ' (read from the job; not offered)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label style={FIELD_LABEL}>
                <span>Tool</span>
                <select
                  value={setup.tools[0] ?? ''}
                  data-testid={`engrave-setup-tool-${n}`}
                  aria-label={`Setup ${n} tool`}
                  style={{ maxWidth: 240 }}
                  onChange={(e) => props.onTool(e.target.value)}
                >
                  {props.tools.map((e) => (
                    <option key={e.key} value={e.key} title={e.provenance}>
                      {toolLabel(e)}
                    </option>
                  ))}
                  {setup.tools[0] !== undefined && !props.tools.some((e) => e.key === setup.tools[0]) && (
                    <option value={setup.tools[0]}>{setup.tools[0]} (not in the registry)</option>
                  )}
                </select>
              </label>
              <label style={{ ...FIELD_LABEL, marginTop: 8 }}>
                <span>Add an item</span>
                <select
                  value=""
                  data-testid={`engrave-setup-add-item-${n}`}
                  aria-label={`Add an item to setup ${n}`}
                  style={{ maxWidth: 240 }}
                  onChange={(e) => {
                    if (e.target.value !== '') props.onAssign(e.target.value);
                  }}
                >
                  <option value="">choose a cut item…</option>
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <p style={MUTED} data-testid={`engrave-setup-read-only-${n}`}>
              This is the derived reading. {index === 0 ? 'Press “Edit setups”' : 'Use the suggested plan'} to make it
              editable.
            </p>
          )}

          {props.notice !== null && (
            <p style={{ ...MUTED, color: ERROR_COLOR }} data-testid={`engrave-setup-notice-${n}`}>
              {props.notice}
            </p>
          )}

          {reading.missing.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {reading.missing.map((id) => (
                <div key={id} style={FIELD_LABEL} data-testid={`engrave-setup-missing-${n}-${id}`}>
                  <span style={{ color: ERROR_COLOR }}>
                    {id} is no longer in the job.
                  </span>
                  {editable && (
                    <button type="button" data-testid={`engrave-setup-remove-item-${n}-${id}`} onClick={() => props.onRemoveItem(id)}>
                      Remove from setup
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {reading.notCut.length > 0 && (
            <p style={MUTED} data-testid={`engrave-setup-not-cut-${n}`}>
              Not cut here: {reading.notCut.join(', ')} — disabled, reference-only, or no longer a cut.
            </p>
          )}

          {derived !== undefined && derived.findings.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {derived.findings.map((f, i) => (
                <div
                  key={`${f.code}-${i}`}
                  data-testid={`engrave-setup-plan-finding-${n}-${f.code}`}
                  style={{ fontSize: 12, lineHeight: 1.45, margin: '3px 0' }}
                >
                  <span style={{ color: f.severity === 'error' ? ERROR_COLOR : WARN_COLOR }}>● </span>
                  <code style={{ color: f.severity === 'error' ? ERROR_COLOR : WARN_COLOR }}>{f.code}</code> {f.text}
                </div>
              ))}
            </div>
          )}

          {derived !== undefined && (
            <div className="engrave-setups__registration" data-testid={`engrave-setup-registration-${n}`}>
              <p style={{ ...MUTED, margin: '8px 0 2px', color: '#d1d5db' }}>Registration</p>
              {setup.registration !== undefined ? (
                <div data-testid={`engrave-setup-reg-approved-${n}`}>
                  <p style={{ ...MUTED, color: '#8fd18f', margin: '2px 0' }}>Approved — {setup.registration.expected}</p>
                  <p style={MUTED}>{summarizePlan(setup.registration.plan)}</p>
                </div>
              ) : (
                <p style={MUTED} data-testid={`engrave-setup-reg-unplanned-${n}`}>
                  Not planned. Plan it, read the plan, then approve it.
                </p>
              )}

              {editable && (
                <>
                  {setup.mount.kind === 'vise' && (
                    <label style={FIELD_LABEL}>
                      <input
                        type="checkbox"
                        checked={useTypedSeat}
                        data-testid="engrave-setups-use-typed-seat"
                        onChange={(e) => {
                          setUseTypedSeat(e.target.checked);
                          // #614 — the provisional aim counts only when the override is ticked: unticked
                          // (datum absent) must plan to need-datum, not from the seeded default.
                          if (e.target.checked && shippedZ1Vise && seatZ.trim() === '') {
                            setSeatZ(String(VISE_SEAT_MACHINE_Z));
                          }
                          setPreview(null);
                        }}
                      />
                      <span>Use a typed seat instead</span>
                      {useTypedSeat && (
                        <span style={{ ...MUTED, margin: 0 }}>expert override — the measured jaw top is ignored</span>
                      )}
                    </label>
                  )}
                  {(setup.mount.kind === 'tape' || useTypedSeat) && (
                    <label style={FIELD_LABEL}>
                      <span>Seat machine Z</span>
                      <input
                        type="number"
                        step="any"
                        value={seatZ}
                        style={FIELD}
                        data-testid={`engrave-setup-seat-${n}`}
                        aria-label={`Setup ${n} seat machine Z`}
                        title={seatTitle}
                        onChange={(e) => {
                          setSeatZ(e.target.value);
                          setPreview(null);
                        }}
                      />
                      <span style={{ ...MUTED, margin: 0 }}>
                        {seatHint}
                      </span>
                    </label>
                  )}
                  <button type="button" data-testid={`engrave-setup-plan-reg-${n}`} onClick={planNow}>
                    {setup.registration === undefined ? 'Plan registration' : 'Plan registration again'}
                  </button>
                </>
              )}

              {attempt?.kind === 'need-seat' && (
                <p style={{ ...MUTED, color: WARN_COLOR }} data-testid={`engrave-setup-reg-need-seat-${n}`}>
                  {attempt.message}
                </p>
              )}
              {attempt?.kind === 'need-datum' && (
                <div data-testid={`engrave-setup-reg-need-datum-${n}`}>
                  <p style={{ ...MUTED, color: WARN_COLOR, margin: '4px 0' }}>{attempt.message}</p>
                  {attempt.mountTap !== null && (
                    <button type="button" data-testid={`engrave-setup-tap-jaw-${n}`} disabled={props.tapBusy} onClick={() => props.onTapJaw(attempt.mountTap!)}>
                      {/* #607 — the tap is the mount's, so the button says which reference it touches.
                          #640 — the bracket-seat branch is UNREACHABLE today: `bracketTapFor` is null
                          until the seat is measured, and no bracket plan offers a need-datum tap. The
                          branch stays, and so does this note: it costs nothing and marks the door. */}
                      {attempt.mountTap.reference === 'bracket-seat' ? 'Tap the bracket’s front arm' : 'Tap the fixed jaw'}
                    </button>
                  )}
                </div>
              )}
              {attempt?.kind === 'refused' && (
                <p style={{ ...MUTED, color: ERROR_COLOR }} data-testid={`engrave-setup-reg-refusal-${n}`}>
                  {attempt.reason}
                </p>
              )}
              {attempt?.kind === 'plan' && (
                <div data-testid={`engrave-setup-reg-preview-${n}`}>
                  <p style={MUTED} data-testid={`engrave-setup-reg-summary-${n}`}>
                    {attempt.summary}
                  </p>
                  <p style={MUTED}>Expected accuracy: {attempt.expected}</p>
                  <button type="button" data-testid={`engrave-setup-approve-reg-${n}`} onClick={approve}>
                    Approve registration
                  </button>
                </div>
              )}
            </div>
          )}

          {derived !== undefined && (
            <div data-testid={`engrave-setup-remount-${n}`} style={{ marginTop: 8 }}>
              <p style={{ ...MUTED, margin: '0 0 2px', color: '#d1d5db' }}>Remount</p>
              {setup.remount !== undefined ? (
                <>
                  <p style={{ ...MUTED, color: '#8fd18f', margin: '2px 0' }} data-testid={`engrave-setup-remount-approved-${n}`}>
                    Approved — {setup.remount.instruction.length} steps
                  </p>
                  <button type="button" data-testid={`engrave-setup-remount-preview-${n}`} onClick={props.onPreviewRemount}>
                    Preview the remount
                  </button>
                </>
              ) : derived.remount !== null ? (
                <>
                  <p style={MUTED}>Derived — preview it, answer its question, and approve it.</p>
                  <p style={MUTED} data-testid={`engrave-setup-remount-times-${n}`}>
                    Remount ≈ {props.remountMinutes} min · re-register ≈ {props.reregisterMinutes} min
                  </p>
                  <button type="button" data-testid={`engrave-setup-remount-preview-${n}`} onClick={props.onPreviewRemount}>
                    Preview the remount
                  </button>
                </>
              ) : (
                <p style={MUTED} data-testid={`engrave-setup-remount-none-${n}`}>
                  No remount: setup 1 is mounted as supplied.
                </p>
              )}
            </div>
          )}

          {editable && (
            <button
              type="button"
              data-testid={`engrave-setup-remove-${n}`}
              style={{ marginTop: 8, color: ERROR_COLOR }}
              onClick={props.onRemoveSetup}
            >
              Remove setup
            </button>
          )}
        </div>
      )}
    </div>
  );
}
