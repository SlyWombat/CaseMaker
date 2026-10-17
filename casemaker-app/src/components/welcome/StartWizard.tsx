import { useState, type CSSProperties, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { MACHINES } from '@/engine/cnc/machine';
import { machineCalibrationNotice } from '@/engine/cnc/calibration';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { ensureSeedFontsLoaded } from '@/engine/fonts/registry';
import { canDriveMachine } from '@/platform/capabilities';
import { probeMachine, type MachineObservation } from '@/platform/machineProbe';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import { useSettingsStore } from '@/store/settingsStore';
import { findTemplateAcrossSources } from '@/library/templateRegistry';
import { scheduleImmediate } from '@/engine/jobs/JobScheduler';
import { useProjectStore, clearHistory } from '@/store/projectStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useMachineStore, type MachineCheckOutcome } from '@/store/machineStore';
import { useStartWizardStore } from '@/store/startWizardStore';
import { useViewportStore } from '@/store/viewportStore';
import { EngraveSetupFlow } from '@/components/panels/EngraveSetupFlow';
import { PanelErrorBoundary } from '@/components/ui/PanelErrorBoundary';
import { readDesignFile } from '@/engine/import/designImport';
import { useStockStore } from '@/store/stockStore';
import type { Project } from '@/types/project';
import type { JobStockEntry } from '@/types/engraveJob';
import type { SetupStepId } from '@/engine/cnc/engrave/setupFlow';
import { facingSeed, facingShopFrom, jobItemCount } from '@/engine/cnc/stockStart';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import '@/store/stockEntryFollow';
import { StartStockStep, type PendingStock } from './StartStockStep';

/**
 * The startup wizard (#280, filed from #274) — three questions and a panel.
 *
 * 1. **Which machine is this job for?** A PICKER on every build, plus a CHECK where a socket exists
 *    (#347). The picker writes `machineId` and nothing else, so the work area, the spindle ceiling
 *    and the limits are the profile's before any hardware is involved — and on the web build, which
 *    has no socket at all (#346), it is the only way the question can be answered. `probeMachine`
 *    then asks the network; the answer is one of four and all four are rendered, and a found machine
 *    whose profile is not the selected one is said out loud rather than silently repointed. Neither
 *    half blocks: a job can be authored, verified and simulated with no machine at all, which is the
 *    same conclusion MillMage's skippable setup and Bantam's "will not prevent you from milling"
 *    reach (UI-PATTERNS §1).
 * 2. **What are you cutting from?** (#418, §5.1) The material first, then the stock: off the shelf
 *    (#413), typed here (and optionally put on the shelf), or an STL/3MF used as the stock — see
 *    `StartStockStep`. The two templates (blank, badge blank) are still offered beneath it, as the
 *    new-from-template route they always were.
 * 3. **How is it held?** Delegated, not duplicated: `EngraveSetupFlow` (#254) already owns
 *    workholding, material, blank and cutter, already seeds from the job, and already writes
 *    through the one tagged answer path. A second copy would be a second place to change.
 *
 * Portal'd to `document.body` at the modal layer of the one stacking scale (`--cm-z-modal`,
 * #348), the house pattern the setup flow and the import dialog both use, and mounted from
 * `AppShell` rather than from the welcome overlay — step 2 creates the project, which flips
 * `welcomeMode` off and unmounts that overlay, and this has to survive it.
 */

const OVERLAY: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 'var(--cm-z-modal)', // the one stacking scale (#348), src/styles/tokens.css
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
 * Step 2's project types: ONLY what the CNC cuts (#346 — "no way a rack mount is being carved").
 * The printed archetypes (protective case, mini rack, tool insert, toolbox) have the welcome
 * screen; a cutting job is a blank. Each id is an existing template — nothing here invents a
 * second way to make a project, and a spec that is renamed or missing simply drops out of the
 * list rather than breaking the wizard.
 */
const JOB_TYPE_IDS = ['badge-blank', 'blank'] as const;

/**
 * The machines step 1 offers: every profile this app can actually write for (#347). It is the
 * catalogue of MODELS, not of connected hardware — one entry today (the Z1), and the select exists
 * before the second one lands so the job's machine is a question rather than a constant.
 */
const MACHINE_PROFILES = Object.values(MACHINES);

/**
 * `stock` is #418's material-first step (§5.1); the two templates are offered beneath it. `setup`
 * hands over to the mount — `EngraveSetupFlow`'s holding step alone after a stock pick, every step
 * after a template (whose blank has not been asked about).
 */
type Step = 'machine' | 'stock' | 'setup';

/**
 * A new project whose part IS the stock (#418): the `blank` template, sized to it, so the viewport
 * draws the piece that was picked rather than the template's 100 × 60 × 12. Square corners — a plate
 * off the shelf has no radius, and `blankStockFor` reads width → length, height → width.
 */
/** Take `stockEntry` off the job, if it carries one. */
function clearStockEntry(): void {
  const store = useEngraveJobStore.getState();
  if (store.job.stockEntry === undefined) return;
  const next = { ...store.job };
  delete next.stockEntry;
  store.replace(next);
}

function projectForStock(stock: { length: number; width: number; thickness: number }): Project | null {
  const template = findTemplateAcrossSources('blank');
  if (template === undefined) return null;
  const project = template.build();
  const blank = project.case.blank;
  if (blank === undefined) return null;
  return {
    ...project,
    case: {
      ...project.case,
      blank: { ...blank, enabled: true, width: stock.length, height: stock.width, thickness: stock.thickness, cornerRadius: 0 },
    },
  };
}

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
  calibration,
  selectedId,
}: {
  outcome: MachineCheckOutcome;
  machine: MachineObservation | null;
  reason: string | null;
  /** The saved frame for this machine, if there is one (#279). */
  calibration?: MachineCalibration | null;
  /** The profile the job is set up for (#347), so a found machine can disagree with it out loud. */
  selectedId: string;
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
  const frameNotice = profile === undefined ? null : machineCalibrationNotice(profile, calibration);
  // #347 — the machine that answered is EVIDENCE about the job's machine, not a substitute for it.
  // When the two disagree, both are named and the fix is the select just above: repointing the job
  // to a controller it was not set up for would move every number in the document without a word.
  const mismatch =
    profile !== undefined && machine.profileId !== null && machine.profileId !== selectedId
      ? { found: profile, chosen: MACHINES[selectedId] }
      : null;
  return (
    <div data-testid="start-wizard-machine-state" data-state="found">
      {mismatch && (
        <p style={NOTE} data-testid="start-wizard-machine-mismatch">
          This controller answers as <b>{mismatch.found.name}</b>, but the job is set up for{' '}
          <b>{mismatch.chosen?.name ?? selectedId}</b>. Nothing has been repointed for you — change
          the machine above if this is the machine the job will run on.
        </p>
      )}
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
        <>
          <p style={MUTED} data-testid="start-wizard-machine-profile">
            {profile.name} — {span(profile.envelope.x.min, profile.envelope.x.max)} ×{' '}
            {span(profile.envelope.y.min, profile.envelope.y.max)} ×{' '}
            {span(profile.envelope.z.min, profile.envelope.z.max)} mm work area, spindle to{' '}
            {profile.maxRpm} rpm. Feeds and speeds are clamped to these.
          </p>
          {/* Which frame is in force, and where its numbers came from (#279, decision 28). A
              warning here is the honest state, not a defect: the vendor's defaults are what ran
              before any of this existed, and saying so beats a blank. */}
          <p
            data-testid="start-wizard-machine-frame"
            data-state={frameNotice?.code}
            style={frameNotice?.severity === 'warning' ? NOTE : MUTED}
          >
            {frameNotice?.message}
          </p>
        </>
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
 * Seed the engrave job's stock from the project the wizard just built, once, at hand-off (#280 §3).
 *
 * A blank — or a badge blank — IS the stock, so retyping its size into the job would be an invitation
 * to a typo. Which archetype the project carries is the project's answer, not this function's: the
 * badge route seeds `case.badge`, which also brings the magnet pocket, the colour split and the
 * print's flatness with it (#352 — before this it read `case.blank` only, so a badge job kept
 * `defaultEngraveJob`'s 100 × 60 × 12 softwood and step 3 asked about a blank nobody picked). The
 * write goes through the store's `takeBadgeBlank`, the same one the panel's button makes.
 *
 * But the job is stored independently of the project and outlives it, so a size the user typed or
 * measured is NOT overwritten: `'computed'` is the app's own derivation and may be replaced,
 * `'user'` and `'measured'` may not (#254's source tags are what make that distinction readable).
 * The guard is on the DIMENSIONS and covers the whole seed — a badge's pocket belongs to the badge's
 * blank, so seeding the one without the other would be a void floating in a stock that is not its own.
 *
 * ASYNC, because the store's seed MEASURES the line it lays out and the hand-off is the very call
 * that runs before any face is parsed (#365 review): a badge taken here seeded the estimate's 5 mm
 * cap where the panel's own row — with the faces up — says 8. Awaiting the labels' faces costs a
 * fetch (once, on a cold cache) and makes the number the wizard hands over the number the panel
 * shows; a fetch that fails leaves the estimate in its place rather than a hand-off that stops
 * (`ensureSeedFontsLoaded` and not `ensureLabelFontsLoaded`).
 */
async function seedStockFromProject(project: Project): Promise<void> {
  const job = useEngraveJobStore.getState();
  const sources = job.job.sources?.stock;
  const asserted = (['length', 'width', 'thickness'] as const).some((key) => {
    const source = sources?.[key];
    return source === 'user' || source === 'measured';
  });
  if (asserted) return;

  await ensureSeedFontsLoaded(job.job.labels, job.job.customFonts ?? []);

  const badge = project.case.badge;
  if (badge !== undefined && badge.enabled) {
    job.takeBadgeBlank(badgeBlankFor(badge));
    return;
  }
  const blank = project.case.blank;
  if (blank === undefined || !blank.enabled) return;
  // #364 — the blank route's own store method, the twin of `takeBadgeBlank`: it takes the stock AND
  // the lines (a blank that is not the demo plank gets one seeded `Text` line, and every unclaimed
  // label is re-depthed either way), so the hand-off no longer leaves three demo words laid out for
  // a plank on a blank that is not one.
  job.takeBlankStock(blank);
}

export function StartWizard(): JSX.Element {
  const closeWizard = useStartWizardStore((s) => s.closeWizard);
  const machine = useMachineStore((s) => s.machine);
  const outcome = useMachineStore((s) => s.outcome);
  const reason = useMachineStore((s) => s.reason);
  const setProbeResult = useMachineStore((s) => s.setProbeResult);
  const setProject = useProjectStore((s) => s.setProject);
  const setSection = useViewportStore((s) => s.setActiveSidebarSection);
  const savedCalibration = useSettingsStore((s) => s.machineCalibration);
  const setMachineCalibration = useSettingsStore((s) => s.setMachineCalibration);
  const jobMachineId = useEngraveJobStore((s) => s.job.machineId);
  const setMachine = useEngraveJobStore((s) => s.setMachine);

  // The job's own answer, as a value the `<select>` can hold. The schema coerces an unknown id to
  // the Z1 (#347), so a miss here is a store-side impossibility rather than a state to render — but
  // a blank control is a worse answer than the first profile, which is what the schema would pick.
  const machineChoice = MACHINE_PROFILES.some((p) => p.id === jobMachineId)
    ? jobMachineId
    : (MACHINE_PROFILES[0]?.id ?? '');

  const [step, setStep] = useState<Step>('machine');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingStock | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // Which steps the mount hand-off asks: a stock pick has answered the material and the blank.
  const [setupSteps, setSetupSteps] = useState<readonly SetupStepId[] | undefined>(undefined);
  // #418 review — the job open now has items, and starting from stock would replace it: ask first.
  const [confirmReplace, setConfirmReplace] = useState<{ pending: PendingStock; items: number } | null>(null);
  const [address, setAddress] = useState('');

  // `probeMachine` resolves every failure into one of its four outcomes, so there is nothing to
  // catch here: a thrown probe would be a bug in the probe, not an error to swallow.
  async function runCheck(host?: string): Promise<void> {
    setBusy(true);
    try {
      const result = await probeMachine(host === undefined ? {} : { host });
      setProbeResult(result);
      // The machine's own coordinate frame, saved where its provenance lives (#279). Only a
      // COMPLETE read ever produces one, so this cannot half-apply; a read that failed leaves the
      // previously saved record in force and the probe's notes say what went wrong.
      if (result.kind === 'found' && result.calibration !== null) {
        setMachineCalibration(result.calibration);
      }
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
    await seedStockFromProject(project);
    // #418 review — a template's blank is the stock now, so a shelf entry or file an earlier start
    // named is no longer where it came from.
    clearStockEntry();
    // Hand off to step 3, which is the flow's own overlay: the wizard gets out of the way rather
    // than stacking a second dialog on top of it.
    setSetupSteps(undefined);
    setStep('setup');
    await scheduleImmediate(project);
  }

  /**
   * #418 — start a NEW job from the stock step 2 settled, with an empty design, and hand over to the
   * mount. Applied here and not seeded: a pick off the shelf is an explicit answer, so
   * `seedStockFromProject`'s "never overwrite a typed size" guard does not apply.
   *
   * A new project is a new job: the job store is `reset` (the machine chosen in step 1 is kept), then
   * the stock goes through `setStock` — so the vise's `stockProud` follows the thickness (#344) —
   * and the job is left with no items. There is one job per browser until #425's save/open, so the
   * job that was open is replaced; the wizard is the door for a NEW project, which is what that means.
   *
   * The stock entry is NAMED on the job (`stockEntry.shelfId`) and not reserved: Cut mode (#419)
   * reserves it. A typed piece the user asked to keep goes on the shelf first, and a refusal there
   * stops the start rather than leaving a job that names an entry that does not exist.
   */
  async function startFromStock(p: PendingStock): Promise<void> {
    setStarting(true);
    setStartError(null);
    try {
      const store = useEngraveJobStore.getState();
      const machineId = store.job.machineId;
      let entry: JobStockEntry;
      if (p.kind === 'design') {
        const read = await readDesignFile(p.file);
        if (!read.ok) {
          setStartError(read.error);
          return;
        }
        store.reset();
        store.setMachine(machineId);
        // #410's own route: the blank, its void and the design's items, in one write.
        store.takeDesign(read.patch);
        entry = {
          kind: 'file',
          shelfId: null,
          file: { name: read.filename, sha256: p.sha256 },
          form: 'printed-blank',
          finish: 'printed',
          conductive: false,
        };
      } else {
        if (p.saveToShelf !== null) {
          const shelf = useStockStore.getState();
          const ok = await shelf.add(p.saveToShelf);
          if (!ok) {
            setStartError(`It could not be put on the shelf: ${useStockStore.getState().notice?.text ?? 'no reason was given'}`);
            return;
          }
        }
        store.reset();
        store.setMachine(machineId);
        // A size read off a file is the app's reading of it; a shelf entry or a typed piece is the
        // user's statement. `print`/`flatness` are cleared explicitly (see `stockStart.ts`).
        store.setStock(
          { ...p.choice.stock, print: undefined, flatness: undefined },
          p.choice.entry.kind === 'file' ? 'computed' : 'user',
        );
        entry = p.choice.entry;
      }
      const job = useEngraveJobStore.getState().job;
      // #432 slice 4 — the facing choice comes from the finish (decision Q6), and it is SEEDED here
      // rather than interpreted at Generate: a job with no key must keep planning exactly as it did
      // before #432, so "rough stock is faced by default" has to be written on the job when the job
      // is made. The panel's toggle then overrides it like any other answer.
      const facing = facingSeed(
        entry.finish,
        job.stock.material,
        facingShopFrom(useShopDefaultsStore.getState().defaults),
      );
      // The empty design: a stock pick brings no lines. (A design file brings its own items.)
      store.replace({
        ...job,
        ...(p.kind === 'design' ? {} : { labels: [], shapes: [] }),
        stockEntry: entry,
        facing,
      });

      const stock = useEngraveJobStore.getState().job.stock;
      const project = projectForStock(stock);
      if (project === null) {
        setStartError('the blank template is missing from this build');
        return;
      }
      setProject(project); // also flips welcomeMode off
      clearHistory();
      setSection('cnc-engrave');
      setSetupSteps(['holding']);
      setStep('setup');
      await scheduleImmediate(project);
    } finally {
      setStarting(false);
    }
  }

  // #490 — the same boundary as the panel's: a throw in the setup flow used to blank the hand-off
  // (it is what #488's cold font cache did), leaving the wizard gone with nothing in its place.
  if (step === 'setup') {
    return (
      <PanelErrorBoundary name="Engrave setup flow">
        <EngraveSetupFlow onClose={closeWizard} steps={setupSteps} />
      </PanelErrorBoundary>
    );
  }

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

        {/* #347 — the machine is a QUESTION first, and it is asked on every build. Before this, step
            1 was the check alone: the job carried `defaultEngraveJob`'s Z1 whoever was on the bench,
            and the web build (#346) could not answer at all. The list is `MACHINES` — the profiles
            this app can write for — and picking one writes the id and nothing else (`setMachine`),
            so nothing else in a half-built document moves. The check below is then evidence about
            that answer; where there is no socket it is the whole of step 1. */}
        {step === 'machine' && (
          <div data-testid="start-wizard-step-machine" style={{ marginTop: 8 }}>
            <label style={{ ...MUTED, display: 'block', margin: '4px 0 0' }}>
              <span>Machine</span>
              <select
                data-testid="start-wizard-machine-select"
                aria-label="Machine profile"
                value={machineChoice}
                onChange={(e) => setMachine(e.target.value)}
                style={{ display: 'block', width: '100%', marginTop: 2 }}
              >
                {MACHINE_PROFILES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <p style={MUTED} data-testid="start-wizard-machine-pick-note">
              Every job is written for one machine: its work area, its spindle ceiling and its own
              limits. That is true whether or not one is connected now.
            </p>

            {!canDriveMachine && (
              <p style={NOTE} data-testid="start-wizard-machine-note-build">
                This instance cannot control a machine. To connect one, launch Case Maker from your
                local (desktop) instance. You can still set the job up here, without a machine.
              </p>
            )}

            {canDriveMachine && (
              <>
                <p style={MUTED}>
                  Whether a machine is on the network. This is a check rather than a question — the
                  machine is asked, and it answers or it does not.
                </p>
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
                    Listening for a machine, then reading its own configuration…
                  </p>
                )}
                {!busy && outcome !== null && (
                  <MachineAnswer
                    outcome={outcome}
                    machine={machine}
                    reason={reason}
                    calibration={savedCalibration}
                    selectedId={machineChoice}
                  />
                )}
              </>
            )}
          </div>
        )}

        {step === 'stock' && (
          <>
            <StartStockStep onChange={setPending} />
            {confirmReplace !== null && (
              <div
                data-testid="start-wizard-replace-confirm"
                style={{ border: '1px solid #7a5a28', background: '#241d12', borderRadius: 4, padding: 6, marginTop: 6 }}
              >
                <p style={{ ...MUTED, color: '#e0c07a', margin: 0 }}>
                  The job open now has {confirmReplace.items} item{confirmReplace.items === 1 ? '' : 's'} on it. A new
                  project starts a new job, and there is one job here until save and open land (#425) — starting
                  replaces it, and its items are lost.
                </p>
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <button
                    type="button"
                    data-testid="start-wizard-replace-yes"
                    onClick={() => {
                      const p = confirmReplace.pending;
                      setConfirmReplace(null);
                      void startFromStock(p);
                    }}
                  >
                    Replace it
                  </button>
                  <button type="button" data-testid="start-wizard-replace-no" onClick={() => setConfirmReplace(null)}>
                    Keep it
                  </button>
                </div>
              </div>
            )}
            {startError !== null && (
              <p style={{ ...MUTED, color: '#f0b4ad' }} data-testid="start-wizard-start-error">
                {startError}
              </p>
            )}
            <div data-testid="start-wizard-step-job" style={{ marginTop: 10, borderTop: '1px solid #2a2f36', paddingTop: 6 }}>
              <p style={MUTED}>
                Or start from a template — its blank becomes the stock, and the setup asks the rest.
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
          </>
        )}

        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          {step === 'machine' && !canDriveMachine ? (
            <button type="button" data-testid="start-wizard-cancel" onClick={closeWizard}>
              Cancel
            </button>
          ) : (
            <button
              type="button"
              data-testid="start-wizard-back"
              disabled={step === 'machine'}
              onClick={() => setStep('machine')}
            >
              Back
            </button>
          )}
          {/* The SAME test id either way: it is the button that advances, whatever it says. */}
          {step === 'machine' && (
            <button
              type="button"
              data-testid="start-wizard-next"
              style={{ padding: '3px 12px' }}
              title="A job does not need a machine."
              onClick={() => setStep('stock')}
            >
              {canDriveMachine ? 'Next' : 'Continue without a machine'}
            </button>
          )}
          {step === 'stock' && (
            <button
              type="button"
              data-testid="start-wizard-stock-next"
              style={{ padding: '3px 12px' }}
              disabled={pending === null || starting}
              title={pending === null ? 'Pick the stock first.' : 'Start the job on this stock, then say how it is held.'}
              onClick={() => {
                if (pending === null) return;
                const items = jobItemCount(useEngraveJobStore.getState().job);
                if (items > 0) setConfirmReplace({ pending, items });
                else void startFromStock(pending);
              }}
            >
              {starting ? 'Starting…' : 'Next: mount'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
