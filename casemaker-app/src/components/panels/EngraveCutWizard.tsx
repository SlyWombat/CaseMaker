/**
 * #573 — "Cut this blank": one guided flow from an open job to the probe and the cut.
 *
 * This is an ORCHESTRATION layer, not a second implementation. It owns the ORDER the four expert
 * surfaces (Design tab, Cut tab, Setups accordion, Manage overlay) leave implicit, and it MOUNTS the
 * existing components that already do each step — `MachinesScope` (machine), `EngraveSetupsSection`
 * (the plan/approve) and `EngraveRegistrationStep` (the probe) — while it drives the existing stores
 * for the steps in between (cutter check, generate, freeze, run). A job started here can be finished
 * in the panels and vice versa: both read and write the same job document.
 *
 * The stepper holds a cursor and never shows a step the operator cannot act on. Each step's gate is
 * the SAME condition the expert surface already enforces, surfaced here as the Next button. Editing
 * the job resets the cursor forward (a stock/cutter change → step 2, a stale run → step 4) so the
 * wizard re-runs forward from the first affected step rather than asking the operator to discover it.
 */

import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { oracleSentence, useEngraveRunStore, verifySimulateSentences } from '@/store/engraveRunStore';
import { useEngravePackageStore } from '@/store/engravePackageStore';
import { useMachineStore } from '@/store/machineStore';
import { useFirstRegistration } from '@/store/engraveRegistrationStore';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { MATERIAL_LABELS } from '@/engine/cnc/materials';
import { cutterRefusedOnMaterial } from '@/engine/cnc/engrave/cutterMaterial';
import { materializeSetups } from '@/engine/cnc/setups/authoring';
import { EngraveRegistrationStep } from './EngraveRegistrationStep';
import { EngraveSetupsSection } from './EngraveSetupsSection';
import { MachinesScope } from '@/components/manage/MachinesScope';

const STEPS = ['Machine', 'Blank and cutter', 'Registration plan', 'Generate', 'Freeze', 'Register', 'Run'] as const;

const SUBHEAD: CSSProperties = { margin: '12px 0 4px', fontSize: 12, fontWeight: 600, color: '#c8d3de' };
const MUTED: CSSProperties = { fontSize: 12, color: '#9aa7b4' };

/** A cheap signature of the job fields a stock/cutter edit touches — for reset-forward. */
function stockCutterSignature(job: ReturnType<typeof useEngraveJobStore.getState>['job']): string {
  return `${job.stock.length}:${job.stock.width}:${job.stock.thickness}:${job.stock.material}:${job.toolKey}:${job.metalLineOverride ?? ''}`;
}

export function EngraveCutWizard(): JSX.Element {
  const job = useEngraveJobStore((s) => s.job);
  const setSetups = useEngraveJobStore((s) => s.setSetups);
  const setMetalLineOverride = useEngraveJobStore((s) => s.setMetalLineOverride);
  const machine = useMachineStore((s) => s.machine);
  const staleSince = useEngraveRunStore((s) => s.staleSince);
  const generated = useEngraveRunStore((s) => s.generated);
  const oracle = useEngraveRunStore((s) => s.oracle);
  const generate = useEngraveRunStore((s) => s.generate);
  const run = useEngraveRunStore();
  const freeze = useEngravePackageStore((s) => s.freeze);
  const pkg = useEngravePackageStore((s) => s.packageFor(job.id));

  const [cursor, setCursor] = useState(0);
  // #583 — the double-confirm state for the inline cutter override (F3).
  const [confirmMetalOverride, setConfirmMetalOverride] = useState(false);
  const tool = jobTool(job);
  const target = machine === null ? null : { host: machine.host, port: machine.port };
  const firstReg = useFirstRegistration(job.id, target);

  // Reset-forward: a stock/cutter edit returns to step 2 (the blank + cutter), a stale run returns
  // to step 4 (re-generate). The cursor only ever moves BACK here — it never skips ahead.
  const sig = stockCutterSignature(job);
  const prevSig = useRef(sig);
  useEffect(() => {
    if (prevSig.current !== sig) {
      prevSig.current = sig;
      setCursor((c) => Math.min(c, 1));
    }
  }, [sig]);

  useEffect(() => {
    if (staleSince !== null) setCursor((c) => Math.min(c, 3));
  }, [staleSince]);

  // #579 — step 3 must land on the control it names: materialise the setups (so the section is
  // editable, not the "compatibility reading") when the plan step opens.
  useEffect(() => {
    if (cursor === 2 && job.setups === undefined) setSetups(materializeSetups(job));
  }, [cursor, job, setSetups]);

  // The gate each step owns — the SAME condition the expert surface enforces.
  const machineReady = machine !== null && machine.status !== null;
  const cutterOk = !cutterRefusedOnMaterial(tool, job.stock.material, job.metalLineOverride);
  const planApproved = job.setups !== undefined && job.setups[0]?.registration?.plan !== undefined;
  const oracleChecking = generated !== null && oracle === null;
  const generatedOk = generated !== null && oracle !== null && oracle.ok;
  // #582 — the step names the blocker inline, reusing the panel's run-row sentences.
  const { verified: verifyText, simulated: simulateText } = verifySimulateSentences(run);
  const oracleText = oracleSentence(run);
  const frozen = pkg !== null;
  const registered = firstReg !== null && firstReg.outcome.usable === true;
  const gates: boolean[] = [machineReady, cutterOk, planApproved, generatedOk, frozen, registered, false];

  const next = (): void => setCursor((c) => Math.min(c + 1, STEPS.length - 1));
  const back = (): void => setCursor((c) => Math.max(c - 1, 0));

  return (
    <div data-testid="engrave-cut-wizard" className="engrave-cut-wizard">
      <ol data-testid="engrave-cut-wizard-steps" style={{ display: 'flex', gap: 6, listStyle: 'none', padding: 0, margin: '0 0 8px', flexWrap: 'wrap' }}>
        {STEPS.map((label, i) => (
          <li key={label} style={{ fontSize: 11, color: i === cursor ? '#e2e8f0' : '#6b7a88', fontWeight: i === cursor ? 700 : 400 }}>
            <span data-testid={`engrave-cut-step-${i}`} data-active={i === cursor} data-done={i < cursor}>
              {i + 1}. {label}
            </span>
          </li>
        ))}
      </ol>

      <div data-testid="engrave-cut-wizard-body">
        {cursor === 0 && (
          <div data-testid="engrave-cut-step-content-0">
            <p style={MUTED}>Connect to the saved machine and confirm it is Online and Idle.</p>
            <MachinesScope />
          </div>
        )}

        {cursor === 1 && (
          <div data-testid="engrave-cut-step-content-1">
            <h3 style={SUBHEAD}>Stock</h3>
            <p style={MUTED}>
              {job.stock.length} × {job.stock.width} × {job.stock.thickness} mm · {MATERIAL_LABELS[job.stock.material]}
            </p>
            <h3 style={SUBHEAD}>Cutter</h3>
            <p style={MUTED} data-testid="engrave-cut-wizard-cutter">
              {tool === null ? 'No cutter chosen' : tool.name}
            </p>
            {!cutterOk && (
              <div style={{ color: '#f0b4ad' }} data-testid="engrave-cut-wizard-cutter-refused">
                <p style={{ margin: 0 }}>
                  {tool !== null ? `"${tool.name}" is on Makera's "for Metal" line, and this job cuts ${MATERIAL_LABELS[job.stock.material]}.` : 'Choose a cutter.'}
                </p>
                {!confirmMetalOverride ? (
                  <button type="button" data-testid="engrave-cut-wizard-use-anyway" onClick={() => setConfirmMetalOverride(true)}>
                    Use this cutter anyway
                  </button>
                ) : (
                  <>
                    <p style={{ margin: 0 }}>
                      This bit is ground and coated for metal; on this material it can chip or snap, and no feed row was written for it — feeds/speeds are a guess.
                    </p>
                    <button type="button" data-testid="engrave-cut-wizard-confirm" onClick={() => { setMetalLineOverride(true); setConfirmMetalOverride(false); }}>
                      I understand the bit may break
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {cursor === 2 && (
          <div data-testid="engrave-cut-step-content-2">
            <p style={MUTED}>Plan the registration and approve it — the touch, the left and front edge scans, all in the planner's own words.</p>
            <EngraveSetupsSection initiallyOpen />
          </div>
        )}

        {cursor === 3 && (
          <div data-testid="engrave-cut-step-content-3">
            <p style={MUTED}>Generate, verify and simulate the program. The wizard re-runs this when the job changes.</p>
            <button type="button" data-testid="engrave-cut-generate" onClick={() => void generate()}>
              Generate
            </button>
            {oracleChecking && <p data-testid="engrave-cut-generate-checking" style={MUTED}>Checking the simulation…</p>}
            {generatedOk && <p data-testid="engrave-cut-generate-ok" style={{ color: '#a3e4a0' }}>Generated ✓ Verified ✓ Simulated ✓ Matches ✓</p>}
            {generated !== null && !generatedOk && !oracleChecking && (
              <div data-testid="engrave-cut-generate-blocked" style={{ color: '#f0b4ad' }}>
                <p style={{ margin: 0 }}>{verifyText}</p>
                <p style={{ margin: 0 }}>{simulateText}</p>
                <p style={{ margin: 0 }}>Matches prediction — {oracleText}</p>
              </div>
            )}
          </div>
        )}

        {cursor === 4 && (
          <div data-testid="engrave-cut-step-content-4">
            <p style={MUTED}>Freeze the package — the program and its approved registration plan, sealed together.</p>
            <button
              type="button"
              data-testid="engrave-cut-freeze"
              disabled={!generatedOk}
              onClick={() => {
                if (generated !== null) void freeze(job, generated.programs);
              }}
            >
              Freeze
            </button>
            {frozen && <p data-testid="engrave-cut-frozen" style={{ color: '#a3e4a0' }}>Frozen ✓</p>}
          </div>
        )}

        {cursor === 5 && (
          <div data-testid="engrave-cut-step-content-5">
            <p style={MUTED}>Fit the wired probe, hand near the stop. Then run the registration and write the origin.</p>
            <EngraveRegistrationStep job={job} target={target} />
          </div>
        )}

        {cursor === 6 && (
          <div data-testid="engrave-cut-step-content-6">
            <p style={MUTED}>Upload and run the frozen program — dry run first, then cut.</p>
            <p style={MUTED}>Run the job from the Cut checklist (the expert surface owns the upload and play).</p>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }} data-testid="engrave-cut-wizard-nav">
        <button type="button" data-testid="engrave-cut-back" onClick={back} disabled={cursor === 0}>
          Back
        </button>
        <button type="button" data-testid="engrave-cut-next" onClick={next} disabled={cursor === STEPS.length - 1 || !gates[cursor]}>
          {cursor === STEPS.length - 1 ? 'Done' : 'Next'}
        </button>
      </div>
    </div>
  );
}
