import { useState, type CSSProperties, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { MACHINES } from '@/engine/cnc/machine';
import { blankStockFor } from '@/engine/cnc/engrave/fromBlank';
import { canDriveMachine } from '@/platform/capabilities';
import { probeMachine, type MachineObservation } from '@/platform/machineProbe';
import { findTemplateAcrossSources } from '@/library/templateRegistry';
import { scheduleImmediate } from '@/engine/jobs/JobScheduler';
import { useProjectStore, clearHistory } from '@/store/projectStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useMachineStore, type MachineCheckOutcome } from '@/store/machineStore';
import { useStartWizardStore } from '@/store/startWizardStore';
import { useViewportStore } from '@/store/viewportStore';
import { EngraveSetupFlow } from '@/components/panels/EngraveSetupFlow';
import type { Project } from '@/types/project';

/**
 * The startup wizard (#280, filed from #274) — three questions and a panel.
 *
 * 1. **Is a machine there?** A CHECK, not a picker. `probeMachine` asks the network; the answer is
 *    one of four, and all four are rendered. It never blocks: a job can be authored, verified and
 *    simulated with no machine at all, which is the same conclusion MillMage's skippable setup and
 *    Bantam's "will not prevent you from milling" reach (UI-PATTERNS §1).
 * 2. **What are you making?** Five project types, each one an existing template spec. Ours is the
 *    question the field does not ask, because every other product is single-purpose CAM; the
 *    nearest equivalent is new-from-template, which is exactly the route this reuses.
 * 3. **How is it held?** Delegated, not duplicated: `EngraveSetupFlow` (#254) already owns
 *    workholding, material, blank and cutter, already seeds from the job, and already writes
 *    through the one tagged answer path. A second copy would be a second place to change.
 *
 * Portal'd to `document.body` at `zIndex: 60`, the house pattern the run sheet and the setup flow
 * both use, and mounted from `AppShell` rather than from the welcome overlay — step 2 creates the
 * project, which flips `welcomeMode` off and unmounts that overlay, and this has to survive it.
 */

const OVERLAY: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  background: 'rgba(8, 11, 15, 0.72)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};
const BOX: CSSProperties = {
  width: 'min(460px, 100%)',
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',
  background: '#141a21',
  border: '1px solid #2a2f36',
  borderRadius: 6,
  padding: 12,
  color: '#d1d5db',
};
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const NOTE: CSSProperties = { ...MUTED, borderLeft: '2px solid #3a5a7a', paddingLeft: 6 };

/**
 * Step 2's five project types, in the order the question makes sense: the things you print, then
 * the two that are cut. Each is an existing template id — nothing here invents a second way to make
 * a project, and a spec that is renamed or missing simply drops out of the list rather than
 * breaking the wizard.
 */
const JOB_TYPE_IDS = ['protective-case', 'mini-rack-10in', 'tool-insert', 'badge-blank', 'blank'] as const;

type Step = 'machine' | 'job' | 'setup';

/** `100 × 60 × 12 mm` — the work area is the envelope's span, machine coordinates run negative. */
function span(min: number, max: number): number {
  return Number((max - min).toFixed(3));
}

/**
 * What we can say about a found machine. The profile is looked up by the id the NAME resolved to:
 * a machine we do not know has `profileId: null` and gets no numbers at all — it is never handed
 * another machine's envelope or spindle ceiling.
 */
function MachineAnswer({
  outcome,
  machine,
  reason,
}: {
  outcome: MachineCheckOutcome;
  machine: MachineObservation | null;
  reason: string | null;
}): JSX.Element {
  if (outcome === 'not-found') {
    return (
      <div data-testid="start-wizard-machine-state" data-state="not-found" style={NOTE}>
        Nothing answered the search. That is not a problem — a job can be written, verified and
        simulated without a machine, and the machine can be connected later.
      </div>
    );
  }
  if (outcome === 'unavailable') {
    return (
      <div data-testid="start-wizard-machine-state" data-state="unavailable" style={NOTE}>
        This build cannot reach a machine: {reason ?? 'no reason was given.'}
      </div>
    );
  }
  if (outcome === 'error') {
    return (
      <div data-testid="start-wizard-machine-state" data-state="error" style={NOTE}>
        The search failed: {reason ?? 'no detail was given.'}
      </div>
    );
  }
  if (outcome !== 'found' || machine === null) return <></>;

  const profile = machine.profileId !== null ? MACHINES[machine.profileId] : undefined;
  return (
    <div data-testid="start-wizard-machine-state" data-state="found">
      <p style={{ ...MUTED, color: '#cfe', margin: '6px 0 2px' }} data-testid="start-wizard-machine-name">
        {machine.name ?? `a controller at ${machine.host}`}
      </p>
      <ul style={{ ...MUTED, margin: '2px 0', paddingLeft: 16 }}>
        <li data-testid="start-wizard-machine-address">
          {machine.host}:{machine.port}
          {machine.busy === null ? '' : machine.busy ? ' — busy' : ' — idle'}
        </li>
        <li data-testid="start-wizard-machine-identity">
          ip {machine.ip ?? 'not reported'} · mac {machine.mac ?? 'not reported'}
        </li>
        <li data-testid="start-wizard-machine-status">
          {machine.status === null ? 'status: no answer' : `status: ${machine.status}`}
        </li>
      </ul>
      {profile ? (
        <p style={MUTED} data-testid="start-wizard-machine-profile">
          {profile.name} — {span(profile.envelope.x.min, profile.envelope.x.max)} ×{' '}
          {span(profile.envelope.y.min, profile.envelope.y.max)} ×{' '}
          {span(profile.envelope.z.min, profile.envelope.z.max)} mm work area, spindle to{' '}
          {profile.maxRpm} rpm. Feeds and speeds are clamped to these.
        </p>
      ) : (
        <p style={MUTED} data-testid="start-wizard-machine-unknown">
          This machine is not one the app knows, so its work area and limits are unknown — it is
          not being given another machine's numbers.
        </p>
      )}
      {machine.notes.map((note, i) => (
        <p key={i} style={NOTE} data-testid={`start-wizard-machine-note-${i}`}>
          {note}
        </p>
      ))}
    </div>
  );
}

/**
 * Seed the engrave job's stock from a blank project, once, at hand-off (#280 §3).
 *
 * A blank IS the stock, so retyping its size into the job would be an invitation to a typo. But the
 * job is stored independently of the project and outlives it, so a size the user typed or measured
 * is NOT overwritten: `'computed'` is the app's own derivation and may be replaced, `'user'` and
 * `'measured'` may not (#254's source tags are what make that distinction readable).
 */
function seedStockFromBlank(project: Project): void {
  const blank = project.case.blank;
  if (blank === undefined || !blank.enabled) return;
  const job = useEngraveJobStore.getState();
  const sources = job.job.sources?.stock;
  const asserted = (['length', 'width', 'thickness'] as const).some((key) => {
    const source = sources?.[key];
    return source === 'user' || source === 'measured';
  });
  if (asserted) return;
  job.setStock(blankStockFor(blank).stock, 'computed');
}

export function StartWizard(): JSX.Element {
  const closeWizard = useStartWizardStore((s) => s.closeWizard);
  const machine = useMachineStore((s) => s.machine);
  const outcome = useMachineStore((s) => s.outcome);
  const reason = useMachineStore((s) => s.reason);
  const setProbeResult = useMachineStore((s) => s.setProbeResult);
  const setProject = useProjectStore((s) => s.setProject);
  const setSection = useViewportStore((s) => s.setActiveSidebarSection);

  const [step, setStep] = useState<Step>('machine');
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState('');

  // `probeMachine` resolves every failure into one of its four outcomes, so there is nothing to
  // catch here: a thrown probe would be a bug in the probe, not an error to swallow.
  async function runCheck(host?: string): Promise<void> {
    setBusy(true);
    try {
      setProbeResult(await probeMachine(host === undefined ? {} : { host }));
    } finally {
      setBusy(false);
    }
  }

  async function chooseJob(id: string): Promise<void> {
    const template = findTemplateAcrossSources(id);
    if (template === undefined) return;
    const project = template.build();
    setProject(project); // also flips welcomeMode off
    clearHistory();
    setSection('cnc-engrave');
    seedStockFromBlank(project);
    // Hand off to step 3, which is the flow's own overlay: the wizard gets out of the way rather
    // than stacking a second dialog on top of it.
    setStep('setup');
    await scheduleImmediate(project);
  }

  if (step === 'setup') return <EngraveSetupFlow onClose={closeWizard} />;

  const jobTypes = JOB_TYPE_IDS.map((id) => findTemplateAcrossSources(id)).filter(
    (t): t is NonNullable<typeof t> => t !== undefined,
  );

  return createPortal(
    <div style={OVERLAY} data-testid="start-wizard">
      <div style={BOX} role="dialog" aria-label="Start a cutting job">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <b style={{ flex: 1, fontSize: 13 }}>Start a cutting job</b>
          <span style={MUTED} data-testid="start-wizard-progress">
            {step === 'machine' ? '1 / 3' : '2 / 3'}
          </span>
          <button type="button" data-testid="start-wizard-close" onClick={closeWizard}>
            Close
          </button>
        </div>

        {step === 'machine' && (
          <div data-testid="start-wizard-step-machine" style={{ marginTop: 8 }}>
            <p style={MUTED}>
              First, whether a machine is on the network. This is a check rather than a question —
              the machine is asked, and it answers or it does not.
            </p>
            {!canDriveMachine && (
              <p style={NOTE} data-testid="start-wizard-machine-note-build">
                This build cannot open a raw socket, so it cannot reach a machine on the network:
                a browser cannot, and the desktop build can. Everything else works — a job can be
                written, verified and simulated here, and cut later on the desktop build.
              </p>
            )}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                data-testid="start-wizard-check"
                disabled={busy}
                style={{ padding: '3px 12px' }}
                onClick={() => {
                  void runCheck();
                }}
              >
                {busy ? 'Looking…' : 'Check for a machine'}
              </button>
              <label style={{ ...MUTED, display: 'flex', gap: 4, alignItems: 'center' }}>
                or connect to an address
                {/* A GENERIC example, deliberately not the address of the machine on this bench:
                    a real one in the placeholder reads as a value the app already filled in. */}
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="192.168.1.50"
                  data-testid="start-wizard-address"
                  aria-label="Machine address"
                  title="For a machine whose broadcast does not reach this computer."
                  style={{ width: 120 }}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </label>
              <button
                type="button"
                data-testid="start-wizard-connect-address"
                disabled={busy || address.trim().length === 0}
                onClick={() => {
                  void runCheck(address.trim());
                }}
              >
                Connect
              </button>
            </div>
            {busy && (
              <p style={MUTED} data-testid="start-wizard-machine-busy">
                Listening for a machine…
              </p>
            )}
            {!busy && outcome !== null && (
              <MachineAnswer outcome={outcome} machine={machine} reason={reason} />
            )}
          </div>
        )}

        {step === 'job' && (
          <div data-testid="start-wizard-step-job" style={{ marginTop: 8 }}>
            <p style={MUTED}>
              What are you making? Each of these sets the project up; a machine can be connected
              later, or not at all.
            </p>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
              {jobTypes.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    data-testid={`start-wizard-job-${t.id}`}
                    style={{ width: '100%', textAlign: 'left', padding: 6 }}
                    onClick={() => {
                      void chooseJob(t.id);
                    }}
                  >
                    <div style={{ fontSize: 12, color: '#cfe' }}>{t.name}</div>
                    <div style={MUTED}>{t.description}</div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <button
            type="button"
            data-testid="start-wizard-back"
            disabled={step === 'machine'}
            onClick={() => setStep('machine')}
          >
            Back
          </button>
          {step === 'machine' && (
            <button
              type="button"
              data-testid="start-wizard-next"
              style={{ padding: '3px 12px' }}
              title="A job does not need a machine."
              onClick={() => setStep('job')}
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
