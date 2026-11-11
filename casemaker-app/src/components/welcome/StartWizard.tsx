import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { DEFAULT_FONT_ID, ensureLabelFontsLoaded, ensureSeedFontsLoaded } from '@/engine/fonts/registry';
import { defaultRotaryChuck } from '@/engine/cnc/engrave/setupFlow';
import { jobVise } from '@/engine/cnc/fixture';
import { liveShopDefaults, readDefault } from '@/platform/defaultsClient';
import { canReachMachine } from '@/platform/capabilities';
import { probeMachine } from '@/platform/machineProbe';
import { useSettingsStore } from '@/store/settingsStore';
import { findTemplateAcrossSources } from '@/library/templateRegistry';
import { blankProjectForStock } from '@/library/blankProject';
import { scheduleImmediate } from '@/engine/jobs/JobScheduler';
import { useProjectStore, clearHistory } from '@/store/projectStore';
import { newItemDepthFor, useEngraveJobStore } from '@/store/engraveJobStore';
import { newEngraveShapeId, newEngraveTraceId } from '@/engine/cnc/engrave/defaults';
import { toLineTraces, toVectorShape } from '@/engine/import/outlineImport';
import { useMachineStore } from '@/store/machineStore';
import { useLocationStore } from '@/store/locationStore';
import { machineForJob } from '@/platform/bedProfiles';
import { useStartWizardStore } from '@/store/startWizardStore';
import { useFlightRecorderStore } from '@/store/flightRecorderStore';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { NARROW_QUERY } from './wizardLayout';
import './startWizard.css';
import { useViewportStore } from '@/store/viewportStore';
import { PanelErrorBoundary } from '@/components/ui/PanelErrorBoundary';
import { readDesignFile } from '@/engine/import/designImport';
import { embedSource } from '@/engine/cnc/engrave/jobSources';
import { useStockStore } from '@/store/stockStore';
import { expandEngraveRow } from '@/store/engraveRowStore';
import { addOperationOfType, jobHasOperations } from '@/components/panels/operationTypes';
import type { Project } from '@/types/project';
import type { BracketHold, EngraveJob, JobStockEntry, RotaryChuck, StockHold, TapeHold } from '@/types/engraveJob';
import { defaultSetupAnswers, type SetupAnswers } from '@/engine/cnc/engrave/setupFlow';
import { facingShopFrom, jobItemCount, rodDimsOf } from '@/engine/cnc/stockStart';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import '@/store/stockEntryFollow';
import {
  WIZARD_STEPS,
  previousWizardStep,
  wizardNextLabel,
  wizardStep,
  wizardStepEyebrow,
  wizardStepNumber,
  type WizardStepId,
} from './wizardSteps';
import { MachineStep } from './MachineStep';
import { StockStep } from './StockStep';
import { HoldingStep } from './HoldingStep';
import { openMachineChange } from '@/components/machine-change';
import { currentMount, facingForSeat, machineNow, mechanismOf, rodViseProblem } from './holdingMounts';
import { accessoryFor } from '@/platform/machineChange';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { OperationStep, type OperationChoice } from './OperationStep';
import { operationCreateBlocked } from './operationCreate';
import type { PendingStock, StartStockSeed } from './StartStockStep';
import { proposeStock, type StockProposal } from '@/engine/cnc/stockProposal';
import { partFootprintFor, proposedMaterialFor, proposedStockFor, workShapeFor } from './workShape';
import { workFactsOf } from './workFacts';
import { readLastMachineId, writeLastMachineId } from './lastMachine';
import type { MachineRecord } from '@/platform/locationClient';

/**
 * #681 — the ONE cutting-job wizard.
 *
 * A cutting job is four questions, asked once, in one modal with one counter:
 *
 * ```
 * Step 1 of 4 · Machine      the machine the job is written for, and a check (never a gate)
 * Step 2 of 4 · What are you cutting?   the grouped picker and the field the pick needs
 * Step 3 of 4 · Stock        the blank the work is sized from, then where the piece comes from
 * Step 4 of 4 · Holding      how it is held, and what that does to the blank
 * ```
 *
 * #897 — THE WORK COMES BEFORE THE BLANK: the stock step is seeded with a blank proposed from what
 * is being cut (`stockProposal.ts`), and Holding follows from both. The operator can change every
 * proposed number; the sentence over the size fields says where it came from.
 *
 * THE SHELL owns the step index, the counter and the transitions; each step's body is its own file
 * (`MachineStep`, `StockStep`, `HoldingStep`, `OperationStep`) so a wave-2 slice can rewrite one
 * without touching the numbering, the footer or another step. The panel's Stock and Hold `edit`
 * controls re-open this same wizard at the step they name (`openWizard('stock' | 'holding')`), with
 * the same counter — not a second modal with a second numbering (A1, B3, A10, E1).
 *
 * The old second modal (`EngraveSetupFlow`) is gone: its "What are you cutting?" question is step
 * 2, its material and blank questions step 3, and its holding question step 4. Nothing is handed
 * off to a second overlay; the wizard lands in Design with the item made, its row open.
 *
 * Portal'd to `document.body` at the modal layer of the one stacking scale (`--cm-z-modal`, #348)
 * and mounted from `AppShell` rather than the welcome overlay — the stock step can create the project,
 * which flips `welcomeMode` off and unmounts that overlay, and this has to survive it.
 */

/**
 * #726 P12 — a PLAIN backdrop: the app's own surface colour, opaque, so the operator is in the
 * cutting job and nowhere else. #870 — the overlay, the card and its three regions (a pinned header,
 * the body as the ONE scroll region, a pinned footer) are drawn by `startWizard.css`; on a phone the
 * card is a full-height sheet (`sw-overlay--sheet`). Holding draws a top-view picture beside the
 * mount options, so that one step is wider (#684).
 */
const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
/** #870 — a fact or "nothing yet" is grey; amber is only for a step that cannot be left. */
const ARRIVAL: CSSProperties = { fontSize: 11, color: '#9aa4b0', margin: 0 };
const UNBLOCK: CSSProperties = { fontSize: 11, color: '#e0c07a', margin: 0 };

/** Take `stockEntry` off the job, if it carries one. */
function clearStockEntry(): void {
  const store = useEngraveJobStore.getState();
  if (store.job.stockEntry === undefined) return;
  const next = { ...store.job };
  delete next.stockEntry;
  store.replace(next);
}

/**
 * Seed the engrave job's stock from the project the wizard just built, once, at hand-off (#280 §3).
 *
 * A blank — or a badge blank — IS the stock, so retyping its size into the job would be an invitation
 * to a typo. Which archetype the project carries is the project's answer, not this function's: the
 * badge route seeds `case.badge`, which also brings the magnet pocket, the colour split and the
 * print's flatness with it (#352). The write goes through the store's `takeBadgeBlank` /
 * `takeBlankStock`, the same ones the panel's buttons make.
 *
 * The job is stored independently of the project and outlives it, so a size the user typed or
 * measured is NOT overwritten: `'computed'` is the app's own derivation and may be replaced,
 * `'user'` and `'measured'` may not (#254's source tags make that distinction readable).
 *
 * ASYNC, because the store's seed MEASURES the line it lays out: awaiting the labels' faces (a
 * fetch, once, on a cold cache) makes the number the wizard hands over the number the panel shows;
 * a fetch that fails leaves the estimate in its place rather than a hand-off that stops.
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
  job.takeBlankStock(blank);
}

/** A job's own stock as the stock step's starting answers, when it is re-opened to edit it (#681). */
function seedFromJob(job: EngraveJob): StartStockSeed {
  const entry = job.stockEntry;
  const computed = (['length', 'width', 'thickness'] as const).every(
    (key) => job.sources?.stock?.[key] === 'computed',
  );
  // #240/#713 — a rotary job's box is the axis frame (`L × D × D`), but the stock step asks a rod's
  // own numbers (its diameter and its length) in its STANDING box. `rodDimsOf` reads whichever
  // frame the job holds, so an edit opens on the numbers the operator typed and not the axes.
  const rod = rodDimsOf(job.stock);
  const tube = entry?.form === 'tube';
  return {
    form: entry?.form ?? (rod !== null ? 'rod' : 'plate'),
    material: job.stock.material,
    length: rod !== null ? rod.diameter : job.stock.length,
    width: rod !== null ? rod.diameter : job.stock.width,
    thickness: rod !== null ? rod.length : job.stock.thickness,
    ...(tube ? { wall: job.stock.wall } : {}),
    finish: entry?.finish ?? 'unknown',
    computed,
  };
}

/**
 * Does the stock step report exactly the job's stock as it stands?
 *
 * Passing THROUGH the step is not an edit: the seeded door reports the job's own numbers, and
 * writing them back would relabel a template's computed values as typed ones. The typed door
 * carries no colour, so an absent one means "leave the job's colour alone", not "clear it".
 */
function sameStockChoice(p: PendingStock, job: EngraveJob): boolean {
  if (p.kind !== 'choice' || p.saveToShelf !== null) return false;
  const s = p.choice.stock;
  const sameColour = s.colour === undefined || JSON.stringify(s.colour) === JSON.stringify(job.stock.colour ?? null);
  // #240/#713 — a rotary job's box is the axis frame; the stock step reports the rod's standing
  // box. Same rod, two frames: compare the rod, not the frame, or passing through would rewrite it.
  // A tube's wall is part of the piece (#713).
  if (job.stock.shape === 'cylinder' && (p.choice.entry.form === 'rod' || p.choice.entry.form === 'tube')) {
    const a = rodDimsOf(s);
    const b = rodDimsOf(job.stock);
    return (
      a !== null &&
      b !== null &&
      a.diameter === b.diameter &&
      a.length === b.length &&
      (s.wall ?? undefined) === (job.stock.wall ?? undefined) &&
      s.material === job.stock.material &&
      sameColour
    );
  }
  return (
    s.length === job.stock.length &&
    s.width === job.stock.width &&
    s.thickness === job.stock.thickness &&
    s.shape === job.stock.shape &&
    s.diameter === job.stock.diameter &&
    (s.wall ?? undefined) === (job.stock.wall ?? undefined) &&
    s.material === job.stock.material &&
    sameColour
  );
}

/**
 * #897 — does the stock step report exactly the blank the work proposed?
 *
 * A match means the operator has not changed the proposed numbers, so leaving the question step
 * and coming back RE-PROPOSES from the (possibly changed) work. Any other answer is the
 * operator's own and is kept: the proposal never overwrites an edit.
 */
function stockMatchesProposal(
  p: PendingStock,
  proposal: StockProposal,
  material: StockProposal['material'],
): boolean {
  if (p.kind !== 'choice' || p.saveToShelf !== null) return false;
  const s = p.choice.stock;
  return (
    p.choice.entry.form === proposal.form &&
    s.material === material &&
    s.length === proposal.length &&
    s.width === proposal.width &&
    s.thickness === proposal.thickness
  );
}

/** #897 — the operator's own answer, back in the step's own terms when they return to it. */
function seedFromPending(p: PendingStock): StartStockSeed | undefined {
  if (p.kind !== 'choice') return undefined;
  const s = p.choice.stock;
  return {
    form: p.choice.entry.form,
    material: s.material,
    length: s.length,
    width: s.width,
    thickness: s.thickness,
    ...(s.wall === undefined ? {} : { wall: s.wall }),
    finish: p.choice.entry.finish,
  };
}

export function StartWizard(): JSX.Element {
  const closeWizard = useStartWizardStore((s) => s.closeWizard);
  const initialStep = useStartWizardStore((s) => s.initialStep);
  // #680 — a starter job on the welcome door opens this wizard with its blank already the stock.
  // The template id is the door's word for it; `chooseJob` (the one template path since #683 took
  // the cards out of the stock step) does the rest: project, seeded stock, Holding, and the counters move
  // as they always have.
  const starter = useStartWizardStore((s) => s.starter);
  const starterRan = useRef(false);
  const machine = useMachineStore((s) => s.machine);
  const outcome = useMachineStore((s) => s.outcome);
  const reason = useMachineStore((s) => s.reason);
  // #882 — how the last found machine was reached, so the step can say it.
  const machineRoute = useMachineStore((s) => s.route);
  const setProbeResult = useMachineStore((s) => s.setProbeResult);
  const setProject = useProjectStore((s) => s.setProject);
  const setSection = useViewportStore((s) => s.setActiveSidebarSection);
  // #682 — step 1 wears the location's machine (name, nickname and address) without a picker.
  const machines = useLocationStore((s) => s.location?.machines ?? null);
  // #1106 item 1 — the SELECTED ROW is a location record held here; the job holds only its profile
  // id. Until a row is chosen: the last-used machine's record if it exists, else the only record,
  // else the first record whose profile is the job's.
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  // #930 — the stock step judges whether a facing pass can clear the jaws, which needs the
  // machine's own state: the vise's jaw tops only matter while the vise is what is on the pins.
  const location = useLocationStore((s) => s.location);
  const setMachineCalibration = useSettingsStore((s) => s.setMachineCalibration);
  const job = useEngraveJobStore((s) => s.job);
  const selectedMachine = ((): MachineRecord | null => {
    if (machines === null || machines.length === 0) return null;
    const chosen = selectedRecordId === null ? undefined : machines.find((m) => m.id === selectedRecordId);
    if (chosen !== undefined) return chosen;
    const last = readLastMachineId();
    const lastUsed = last === null ? undefined : machines.find((m) => m.id === last);
    if (lastUsed !== undefined) return lastUsed;
    if (machines.length === 1) return machines[0] ?? null;
    return machines.find((m) => m.profileId === job.machineId) ?? null;
  })();

  // THE ONE STEP INDEX. It starts where the opener asked (the panel's Stock/Hold `edit` names a
  // step), and from then on only this shell moves it.
  const [step, setStep] = useState<WizardStepId>(initialStep);
  // #726 W19/P12 — the phone layout: a 16 px content edge, and Holding stacks (HoldingStep reads
  // the same query for its own grid, so the two never disagree at the breakpoint).
  const narrow = useMediaQuery(NARROW_QUERY);
  // Re-entry is an EDIT: it opens on an existing job and must not reset it. A new job becomes an
  // edit the moment the stock step creates it, so Back to Stock asks about the stock the job now has.
  const [jobStarted, setJobStarted] = useState(initialStep !== 'machine');
  // HOW this run was opened, captured at mount: a run that did not start at step 1 was opened by
  // the panel's Stock/Hold `edit` on an existing job, so it finishes at the step it came to edit.
  // `jobStarted` cannot answer this later — a new job turns it true when the stock step makes the project.
  const [reEntry] = useState(initialStep !== 'machine');
  // Whether THIS run made the project. The stock step after a Back must keep the drawn part equal to the
  // stock it wrote; a panel re-entry edits a job beside a project someone else owns.
  const [projectCreatedHere, setProjectCreatedHere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingStock | null>(null);
  // #930 — the reason the Holding step has no selected mount (its own sentence), so Create can say
  // why it is disabled instead of landing a job in a hold the step refused.
  const [mountBlocked, setMountBlocked] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // #1123 item 3 — what a confirmation press runs. The stock step's replace question and the
  // operation step's empty job share the one box (and the one sentence), so the pending action
  // travels with the count instead of the box living inside a single step.
  const [confirmReplace, setConfirmReplace] = useState<{ run: () => void; items: number } | null>(null);

  /**
   * #890 — A NEW JOB HAS STARTED (step 2 created its project). The previous session's crash
   * prompt is about the session that died, not this job: it goes with the old one rather than
   * sitting over the new job's first screen. Every start path ends here, so all three say it once.
   */
  function noteJobStarted(): void {
    useFlightRecorderStore.getState().dismiss();
    setJobStarted(true);
    setProjectCreatedHere(true);
  }
  const [address, setAddress] = useState('');
  const [answers, setAnswers] = useState<SetupAnswers>(() =>
    defaultSetupAnswers(useEngraveJobStore.getState().job),
  );
  const [operationChoice, setOperationChoice] = useState<OperationChoice | null>(null);
  const onOperationChoice = useCallback((choice: OperationChoice | null) => setOperationChoice(choice), []);
  // #897 — THE BLANK THE WORK ASKS FOR. The question step comes first, so its answer sizes the
  // stock step's starting numbers. `stockEdited` records that the operator has changed them, so a
  // return to the step keeps their answer and only an untouched proposal is re-derived.
  const [stockEdited, setStockEdited] = useState(false);
  // #897 — a line's extent is MEASURED where its face is up, and the estimate until then: ask for
  // the face as the line changes, and re-derive once it is parsed.
  const [fontEpoch, setFontEpoch] = useState(0);
  useEffect(() => {
    if (operationChoice?.type !== 'engrave') return;
    let live = true;
    ensureLabelFontsLoaded(
      [{ text: operationChoice.text, font: operationChoice.font, weight: 'bold' }],
      job.customFonts ?? [],
    )
      .then(() => {
        if (live) setFontEpoch((n) => n + 1);
      })
      .catch(() => {
        // The estimate is the documented answer when no face is available.
      });
    return () => {
      live = false;
    };
  }, [operationChoice, job.customFonts]);
  const work = useMemo(() => {
    void fontEpoch; // a parsed face changes the MEASUREMENT, not the choice or the job
    return workShapeFor(operationChoice, job);
  }, [operationChoice, job, fontEpoch]);
  const proposal = useMemo(() => proposedStockFor(work, job, proposeStock(work)), [work, job]);
  // #930 — whether the vise's jaws are the fixture over this blank: with no machine record the
  // app's own vise model is, and a bed job has no jaw tops to clear.
  const viseOnPins = useMemo(() => {
    const now = machineNow(machineForJob(location, job.machineId));
    return now === null || now.mount === 'vise';
  }, [location, job.machineId]);
  // #1107 — the ROTARY facts the question step offers its rod intents from: whether the house
  // owns one (the location's accessories) and whether it is on the pins (the machine's state).
  const rotaryFacts = useMemo(() => {
    const now = machineNow(machineForJob(location, job.machineId));
    return {
      owned: accessoryFor(location?.accessories ?? [], 'rotary') !== null,
      onPins: now?.mount === 'rotary',
    };
  }, [location, job.machineId]);
  // The material the proposal's blank opens on: the house's, the job's own, or the board's.
  const proposalMaterial = useMemo(
    () => (proposal === null ? null : proposedMaterialFor(proposal, job)),
    [proposal, job],
  );
  const onStockPending = useCallback(
    (next: PendingStock | null) => {
      setPending(next);
      // Only a NEW job compares against the work's proposal (its seed); a re-entry's stock is the
      // job's own answer, and reporting it is not an edit (#930: the house's proposal exists for
      // every operation now, so comparing a started job's own numbers against it would mark them
      // "edited" and lose the template sentence).
      if (
        !jobStarted &&
        next !== null &&
        proposal !== null &&
        proposalMaterial !== null &&
        !stockMatchesProposal(next, proposal, proposalMaterial)
      ) {
        setStockEdited(true);
      }
    },
    [jobStarted, proposal, proposalMaterial],
  );

  // Declared before the opening-starter effect that calls it: a function declaration hoists, but
  // the hooks lint (react-hooks/immutability) needs the binding textual before its use so the
  // compiler can track it.
  async function chooseJob(id: string): Promise<void> {
    // #716 R-UI-15 — "Name on a dowel" is not a project template: the job opens on a ⌀20 × 100
    // rod in the rotary chuck, and the wizard shows Holding so the operator sees what holds it.
    // The chuck is the Holding step's OWN `defaultRotaryChuck` (the shop's grip, the jaw rule for
    // the diameter), so the starter cannot invent numbers the step would not.
    if (id === 'dowel') {
      setSection('cnc-engrave');
      const jobStore = useEngraveJobStore.getState();
      jobStore.reset();
      jobStore.setStock(
        {
          material: jobStore.job.stock.material,
          shape: 'cylinder',
          diameter: 20,
          // The STANDING box (D × D × L); `setRotaryHolding` turns it into the axis frame and
          // writes the workholding in the one undoable step, the Holding step's own write.
          length: 20,
          width: 20,
          thickness: 100,
        },
        'computed',
      );
      const ready = useEngraveJobStore.getState();
      const grip = readDefault(liveShopDefaults(), 'rotary.gripMm').value;
      ready.setRotaryHolding(defaultRotaryChuck(ready.job, grip), jobVise(ready.job));
      // #716 — the wizard's own empty-design rule (the stock step): a starter seeds the stock and the
      // mount, not items. Without this the demo lines would be cut into the rod.
      const seeded = useEngraveJobStore.getState().job;
      useEngraveJobStore.getState().replace({ ...seeded, labels: [], shapes: [] });
      const project = blankProjectForStock(useEngraveJobStore.getState().job.stock);
      if (project !== null) {
        setProject(project);
        clearHistory();
      }
      clearStockEntry();
      noteJobStarted();
      // #1107 — the starter ASKS ITS QUESTION: step 2 with the dowel intent selected and the text
      // field waiting. Create with nothing typed is refused, so the empty job is impossible; the
      // rod stock and chuck are already seeded, so Stock and Holding pass straight through.
      setOperationChoice({
        type: 'engrave',
        text: '',
        depth: newItemDepthFor(useEngraveJobStore.getState().job),
        font: DEFAULT_FONT_ID,
        reads: 'along',
        frame: 'rotary',
      });
      setStep('operation');
      if (project !== null) await scheduleImmediate(project);
      return;
    }
    const template = findTemplateAcrossSources(id);
    if (template === undefined) return;
    const project = template.build();
    setProject(project); // also flips welcomeMode off
    clearHistory();
    setSection('cnc-engrave');
    await seedStockFromProject(project);
    // A template's blank is the stock now, so a shelf entry or file an earlier start named is no
    // longer where it came from.
    clearStockEntry();
    noteJobStarted();
    enterHolding();
    await scheduleImmediate(project);
  }

  useEffect(() => {
    if (starter === null || starterRan.current) return;
    starterRan.current = true;
    void chooseJob(starter);
    // The starter is captured once per open; chooseJob owns the project, stock and step from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for the opening starter
  }, [starter]);

  const hasOperations = jobHasOperations(job);
  const seed = jobStarted ? seedFromJob(job) : undefined;
  // #897 — the stock step's starting point: the blank the work asks for on a run that has not
  // started its job yet; an edited answer or a re-entry's job keeps what it has.
  const proposedSeed: StartStockSeed | null =
    !jobStarted && proposal !== null && proposalMaterial !== null
      ? { ...proposal, material: proposalMaterial, computed: true }
      : null;
  const stockSeed = stockEdited && pending !== null ? (seedFromPending(pending) ?? seed) : (proposedSeed ?? seed);
  // The step this re-entry came to edit: Done applies it and returns. The stock step keeps its own
  // Done (a stock edit finishes at the stock when asked); Holding's primary IS its finish — it
  // says Done while this run is finishing the step it came to edit, and the holding block gates
  // it like every other exit (#713 review, #897).
  const doneStep = reEntry && step === initialStep && step === 'stock' && confirmReplace === null;

  // `probeMachine` resolves every failure into one of its four outcomes, so there is nothing to
  // catch here: a thrown probe would be a bug in the probe, not an error to swallow.
  async function runCheck(host?: string): Promise<void> {
    setBusy(true);
    try {
      // #882 — THE LOCATION'S MACHINES GO WITH THE SEARCH. A LAN server on a bridge network cannot
      // hear the UDP broadcast, but it reaches the machine at its recorded address over TCP; the
      // probe tries both and the result says which route found it.
      const recorded = (machines ?? []).flatMap((m) =>
        m.address === null ? [] : [{ host: m.address.host, port: m.address.port, profileId: m.profileId }],
      );
      const result = await probeMachine(host === undefined ? { recorded } : { host });
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

  /** Holding is always seeded from the job as it now stands, so Back and forth cannot go stale. */
  function enterHolding(): void {
    // #1107 — a ROD answer pre-selects the chuck: the frame the question chose is the hold the
    // job needs, and the operator sees it already selected (the chuck must be the house's).
    const store = useEngraveJobStore.getState();
    if (operationChoice !== null && 'frame' in operationChoice && operationChoice.frame === 'rotary' && rotaryMapOf(store.job) === null) {
      const grip = readDefault(liveShopDefaults(), 'rotary.gripMm').value;
      store.setRotaryHolding(defaultRotaryChuck(store.job, grip), jobVise(store.job));
    }
    setAnswers(defaultSetupAnswers(useEngraveJobStore.getState().job));
    setMountBlocked(null);
    setStep('holding');
  }

  /**
   * Holding answers write as they change: there is no later Finish to collect them. The write is
   * the holding's own — the stock and its provenance belong to the stock step and are left untouched
   * (#684 review: a laminate's assumed cap has no answer field to carry it through a whole-setup
   * write, so writing the stock dropped it).
   */
  function applyHoldAnswers(next: SetupAnswers): void {
    setAnswers(next);
    useEngraveJobStore.getState().applyHoldAnswers(next);
  }

  /**
   * #240 — selecting the rotary chuck (or the vise again) is ONE store write: the workholding and
   * the stock box change together, because they are one fact. The answers are then re-seeded from
   * the job that write produced — the box has changed frame, and the blank step's findings must
   * judge the box the job now holds, not the one it had.
   */
  function applyRotaryHolding(rotary: RotaryChuck | null, next: SetupAnswers): void {
    useEngraveJobStore.getState().setRotaryHolding(rotary, next.vise, next.sacrificial);
    setAnswers(defaultSetupAnswers(useEngraveJobStore.getState().job));
  }

  /**
   * #715 — selecting a bed mount (or the vise again) is ONE store write: the workholding and the
   * board under it are one fact. The answers are re-seeded from the job that write produced,
   * because the default board under a through cut is part of that write.
   */
  function applyBedHolding(hold: TapeHold | BracketHold | null, next: SetupAnswers): void {
    useEngraveJobStore.getState().setBedHold(hold, next.vise, next.sacrificial);
    setAnswers(defaultSetupAnswers(useEngraveJobStore.getState().job));
  }

  /**
   * #783 — WHICH WAY ROUND the part sits is the job's own field (`hold`), written by `setHold`:
   * the box's three dimensions move to different axes, and the items re-map with their face. The
   * answers are re-seeded from that write, since the box they judge is the box it restated.
   */
  function applyStockHold(hold: StockHold): void {
    useEngraveJobStore.getState().setHold(hold);
    setAnswers(defaultSetupAnswers(useEngraveJobStore.getState().job));
  }

  /** #783 — the one-press move of items onto the face that is now up (never automatic). */
  function applyMoveItemsToTop(): void {
    useEngraveJobStore.getState().moveItemsToHoldFace();
    setAnswers(defaultSetupAnswers(useEngraveJobStore.getState().job));
  }
  /**
   * The stock step, new job (#418): start from the settled stock with an empty design.
   *
   * A new project is a new job: the job store is `reset` (the machine chosen in step 1 is kept),
   * then the stock goes through `setStock` — so the vise's `stockProud` follows the thickness
   * (#344) — and the job is left with no items. The wizard is the door for a NEW project.
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
        // #425 §4 — the file itself travels with the job, content-addressed. The derived items
        // above are what the job cuts; this record is the provenance a re-import proves itself
        // against, embedded when it fits the 4 MiB cap. `p.sha256` is the digest the picker
        // already computed, so the record and the stock entry cannot disagree about the file.
        const { source } = await embedSource({
          kind: '3mf',
          name: read.filename,
          bytes: await p.file.arrayBuffer(),
          sha256: p.sha256,
        });
        store.addSourceFile(source);
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
        // user's statement. The colour facts are NOT cleared here any more (#492). `flatness` is
        // cleared — it is the bow measured on the PREVIOUS piece as clamped (#496).
        const colourSource = p.choice.colourSource;
        store.setStock(
          { ...p.choice.stock, flatness: undefined },
          colourSource !== undefined
            ? { colour: colourSource }
            : p.choice.entry.kind === 'file'
              ? 'computed'
              : 'user',
        );
        entry = p.choice.entry;
      }
      const seeded = useEngraveJobStore.getState().job;
      // #432 slice 4 — the facing choice comes from the finish (decision Q6), SEEDED here rather
      // than interpreted at Generate: a job with no key must keep planning as it did before #432.
      // #930 — and only when the pass can run clear of the jaws: a blank seated at or below them,
      // or standing proud by less than the pass, is never faced (the 2026-11-02 walk's failure).
      const facing = facingForSeat(
        entry.finish,
        seeded.stock.material,
        seeded.stock,
        facingShopFrom(useShopDefaultsStore.getState().defaults),
        viseOnPins,
      );
      // The empty design: a stock pick brings no lines. (A design file brings its own items.)
      store.replace({
        ...seeded,
        ...(p.kind === 'design' ? {} : { labels: [], shapes: [] }),
        stockEntry: entry,
        facing,
      });

      const stock = useEngraveJobStore.getState().job.stock;
      const project = blankProjectForStock(stock);
      if (project === null) {
        setStartError('the blank template is missing from this build');
        return;
      }
      setProject(project); // also flips welcomeMode off
      clearHistory();
      setSection('cnc-engrave');
      noteJobStarted();
      enterHolding();
      await scheduleImmediate(project);
    } finally {
      setStarting(false);
    }
  }

  /**
   * The stock step, re-opened from the panel's Stock `edit`: change THIS job's stock, keep its items.
   *
   * A design file is the exception — it carries its own stock AND its own items, so it is a new job
   * and goes through the new-job route (with the same replace confirmation, raised on the way in).
   * Everything else writes through `setStock`, so the vise's proud height follows (#344), and names
   * the entry and facing the job now has without touching the project or the undo history.
   */
  async function editStock(p: PendingStock, closeAfter: boolean): Promise<void> {
    if (p.kind === 'design') {
      // A design file is a new job, not an edit: it brings its own stock and items and still walks
      // through Holding, even when Done asked for this step alone.
      await startFromStock(p);
      return;
    }
    // #897 — a board's set was imported in the question step and IS the job, so this is that
    // run's FIRST blank applied to work that already exists: the project's drawn blank is made
    // from it, as the new-job route makes one, but the items are kept.
    const firstStock = !jobStarted;
    const settled = (): void => {
      if (!firstStock) {
        if (closeAfter) closeWizard();
        else enterHolding();
        return;
      }
      const stock = useEngraveJobStore.getState().job.stock;
      const project = blankProjectForStock(stock);
      if (project === null) {
        setStartError('the blank template is missing from this build');
        return;
      }
      setProject(project); // also flips welcomeMode off
      clearHistory();
      setSection('cnc-engrave');
      setJobStarted(true);
      setProjectCreatedHere(true);
      enterHolding();
      void scheduleImmediate(project);
    };
    setStarting(true);
    setStartError(null);
    try {
      // Passing THROUGH the step is not an edit: only a changed answer is written.
      const current = useEngraveJobStore.getState().job;
      if (sameStockChoice(p, current)) {
        settled();
        return;
      }
      if (p.saveToShelf !== null) {
        const shelf = useStockStore.getState();
        const ok = await shelf.add(p.saveToShelf);
        if (!ok) {
          setStartError(`It could not be put on the shelf: ${useStockStore.getState().notice?.text ?? 'no reason was given'}`);
          return;
        }
      }
      const store = useEngraveJobStore.getState();
      const colourSource = p.choice.colourSource;
      // A changed size on the SAME material keeps the piece's colour facts; a changed material
      // cannot, because the cap was the old material's.
      const keepColour =
        p.choice.stock.colour === undefined &&
        p.choice.stock.material === current.stock.material &&
        current.stock.colour !== undefined
          ? { colour: current.stock.colour }
          : {};
      store.setStock(
        { ...p.choice.stock, ...keepColour, flatness: undefined },
        colourSource !== undefined
          ? { colour: colourSource }
          : p.choice.entry.kind === 'file'
            ? 'computed'
            : 'user',
      );
      const after = useEngraveJobStore.getState().job;
      // #930 — the same jaw rule as the new-job route: a pass deeper than the blank stands proud
      // is not seeded, because it would put the cutter into the jaws.
      const facing = facingForSeat(
        p.choice.entry.finish,
        after.stock.material,
        after.stock,
        facingShopFrom(useShopDefaultsStore.getState().defaults),
        viseOnPins,
      );
      store.replace({ ...after, stockEntry: p.choice.entry, facing });
      settled();
    } finally {
      setStarting(false);
    }
  }

  function applyStock(p: PendingStock, closeAfter = false): void {
    // #897 — a circuit board's set wrote the job's items in the question step; sizing its blank is
    // an edit of that job. Starting over here would throw the Gerber items away.
    if (p.kind === 'choice' && operationChoice?.type === 'pcb' && hasOperations) {
      void editStock(p, closeAfter);
      return;
    }
    if (!jobStarted) {
      void startFromStock(p);
      return;
    }
    // This run made the project, so the part is the stock: a changed answer starts a new job from
    // it (and resizes the drawn blank) rather than editing the document under an old-sized part.
    if (projectCreatedHere) {
      if (sameStockChoice(p, useEngraveJobStore.getState().job)) {
        if (closeAfter) closeWizard();
        else enterHolding();
      } else void startFromStock(p);
      return;
    }
    void editStock(p, closeAfter);
  }

  function leaveStock(closeAfter = false): void {
    if (pending === null) return;
    const current = useEngraveJobStore.getState().job;
    // #897 — a board's set is the work this run already wrote, not a job to be replaced: the
    // blank it was imported onto is sized, not thrown away.
    const keepBoardItems = pending.kind === 'choice' && operationChoice?.type === 'pcb' && hasOperations;
    // #418 review — starting from stock replaces the job open now, so a job with items is asked
    // first. A design FILE carries its own items and stock, so it replaces on re-entry too; a
    // size/material edit of a job beside someone else's project keeps the items and asks nothing.
    const replaces =
      (!jobStarted && !keepBoardItems) ||
      pending.kind === 'design' ||
      (projectCreatedHere && !sameStockChoice(pending, current));
    if (replaces) {
      const items = jobItemCount(current);
      if (items > 0) {
        setConfirmReplace({ run: () => applyStock(pending), items });
        return;
      }
    }
    applyStock(pending, closeAfter);
  }

  /**
   * A re-entry's primary action (#681 follow-up): apply the edited step and return to Design,
   * creating no item. Holding writes as it changes, so it has nothing left to collect; the stock
   * step applies through `leaveStock`, and a design FILE still walks through Holding as a new job.
   */
  function done(): void {
    if (step === 'stock') {
      leaveStock(true);
      return;
    }
    if (step === 'holding') closeWizard();
  }

  /**
   * #1183 — START WITH AN EMPTY JOB, from the question step's secondary action. This is #1123
   * item 3's door, given its own deliberate control: the primary with nothing picked stays
   * refused (#1107), and this link-weight action makes the empty job instead. The job is made
   * empty NOW, so the Stock step — and Back from it — see the job it will be; the wizard then
   * walks on to Stock exactly as a pick does. A job that already carries real work is asked
   * first — the same replacement question (and sentence) the stock step raises.
   */
  function createEmptyJob(): void {
    const items = jobItemCount(useEngraveJobStore.getState().job);
    if (items > 0) {
      setConfirmReplace({ items, run: createEmptyJobNow });
      return;
    }
    createEmptyJobNow();
  }

  function createEmptyJobNow(): void {
    const store = useEngraveJobStore.getState();
    const machineId = store.job.machineId;
    // A NEW document: the machine chosen in step 1 is kept, everything else is the shipped
    // default — and the demo lines are cleared, because they are not this operator's work.
    store.reset();
    store.setMachine(machineId);
    const fresh = useEngraveJobStore.getState().job;
    useEngraveJobStore.getState().replace({ ...fresh, labels: [], shapes: [] });
    // No project, no history and no close here: the stock step creates the job's project from
    // the blank it settles (startFromStock), exactly as it does after a pick. Any answer picked
    // BEFORE the door is not the empty job's: left standing, Stock would size from it and the
    // last step would create it — so it is cleared (and the stock step starts from its proposal).
    setOperationChoice(null);
    setPending(null);
    setStockEdited(false);
    setStartError(null);
    setStep('stock');
  }

  /** The last step's Create: make the operation, open its row and land in Design. */
  function createOperation(choice: OperationChoice | null): void {
    let id: string | null = null;
    if (choice !== null) {
      if (choice.type === 'engrave') {
        // #700 — the placeholder "New text" is never what was asked for, and neither is the
        // generic centre-of-stock placement: the line is made with the operator's text, depth and
        // face AND laid out to fit the blank it will be cut on, in one store write.
        // #752 — on a rotary job the step also asked which way the line reads; that answer lays
        // the line along the map's X (along) or turns it 90° onto the around axis.
        id = useEngraveJobStore.getState().addEngraveText(choice.text, {
          depth: choice.depth,
          font: choice.font,
          ...(choice.reads === undefined ? {} : { reads: choice.reads }),
        });
      } else if (choice.type === 'surface') {
        // #685 — Surface a mesh is the one operation whose item is not a store "add": the file
        // that was read in the step IS the goal object.
        // #723 P2-3 — on a part cut from more than one side the step names WHICH side, and the
        // goal is written to that side (`withSideGoal`); the job's other sides are untouched. A
        // single-side job keeps the one-goal form unchanged.
        if (choice.target !== null) {
          if (choice.setupId !== undefined) {
            useEngraveJobStore.getState().setSideGoal(choice.setupId, choice.target);
          } else {
            // #897 — the mesh was read BEFORE the blank existed, so its centre is the centre of
            // whatever stock the job held then. The goal is seated on the blank the stock step
            // settled: the file's x/y place it on the blank the job will cut.
            const stock = useEngraveJobStore.getState().job.stock;
            useEngraveJobStore.getState().setTargetObject({
              ...choice.target,
              position: { ...choice.target.position, x: stock.length / 2, y: stock.width / 2 },
            });
          }
          id = choice.target.id;
        }
      } else if (choice.type === 'v-carve' && choice.text !== undefined && choice.text.trim() !== '') {
        // #752 — a V-carved line on the map: the text IS the operation's field, so it is made
        // like an engrave text and the cutter decides the V. Empty text is the region route below.
        id = useEngraveJobStore.getState().addEngraveText(choice.text, {
          depth: newItemDepthFor(useEngraveJobStore.getState().job),
          font: DEFAULT_FONT_ID,
        });
      } else if (choice.type === 'flute' && choice.lengthMm !== undefined && choice.lengthMm > 0) {
        // #752 — the wizard's one field for a flute is its length along; the line is created and
        // its two points set to that length about its centre in one row the panel can still edit.
        id = addOperationOfType('flute');
        useEngraveJobStore.getState().updateTrace(id, {
          points: [
            [-choice.lengthMm / 2, 0],
            [choice.lengthMm / 2, 0],
          ],
        });
      } else if (choice.type === 'cutout') {
        // #1100 — Cut out a shape: the region item the panel's shape tools write, plus the
        // profile that frees it (the shop's tabs), centred on the blank like every new item.
        const store = useEngraveJobStore.getState();
        const shapeId = store.addShape(choice.shape === 'circle' ? 'circle' : 'rect');
        store.updateShape(
          shapeId,
          choice.shape === 'circle'
            ? { diameter: choice.length }
            : { width: choice.length, height: choice.width, cornerRadius: choice.radius },
        );
        const cutout = useEngraveJobStore.getState().addCutout();
        useEngraveJobStore.getState().updateCutout(cutout, { of: shapeId, side: 'outside', inset: 0 });
        id = shapeId;
      } else if (
        choice.type === 'pocket' &&
        choice.length !== undefined &&
        choice.width !== undefined &&
        choice.depth !== undefined
      ) {
        // #1100 — A pocket or tray: one rect region with the card's size, corner radius and floor.
        const store = useEngraveJobStore.getState();
        const shapeId = store.addShape('rect');
        store.updateShape(shapeId, {
          width: choice.length,
          height: choice.width,
          cornerRadius: choice.radius ?? 0,
          depth: choice.depth,
        });
        id = shapeId;
      } else if (choice.type === 'outline') {
        // #1098 — the drawing becomes the items the panel's own outline import writes: the closed
        // rings as one vector region and every open path as a line, both centred on the settled
        // stock. Cut it out additionally writes the profile that frees the part: the vector is a
        // construction reference and a cutout of it carries the shop's tabs. Pocket it and Carve
        // it ARE the region; the job's own cutter decides the V (the panel's chips do the same).
        const current = useEngraveJobStore.getState().job;
        const position = { x: current.stock.length / 2, y: current.stock.width / 2 };
        const depth =
          choice.use === 'pocket' && choice.depth !== undefined ? choice.depth : newItemDepthFor(current);
        if (choice.outline.contours.length > 0) {
          const shape = toVectorShape(choice.outline, {
            id: newEngraveShapeId(),
            position,
            depth,
            name: choice.outline.sourceName,
          });
          useEngraveJobStore.getState().addVector(choice.use === 'profile' ? { ...shape, construction: true } : shape);
          id = shape.id;
          if (choice.use === 'profile') {
            const cutout = useEngraveJobStore.getState().addCutout();
            useEngraveJobStore.getState().updateCutout(cutout, {
              of: shape.id,
              side: 'outside',
              inset: 0,
              name: choice.outline.sourceName,
            });
          }
        }
        const lines = toLineTraces(choice.outline, {
          idFor: () => newEngraveTraceId(),
          position,
          depth,
          name: choice.outline.sourceName,
        });
        for (const line of lines) {
          useEngraveJobStore.getState().addLine(line);
          id ??= line.id;
        }
      } else if (choice.type === 'pcb') {
        // #874 — the board's Gerber set wrote the job's items as it read; Create adds nothing.
        // `id` stays null, so no row is opened and the wizard simply closes onto the work.
      } else if (choice.type === 'flat' || choice.type === 'faces-all-round' || choice.type === 'cross-hole') {
        // #241 slice 2 — a cut on the round stock's face. The operation carries its own index and
        // is appended to the job's face list, which is the cut order Generate walks.
        id = useEngraveJobStore.getState().addFaceOperation(
          choice.type === 'flat'
            ? { kind: 'flat', a: choice.a, depth: choice.depth }
            : choice.type === 'faces-all-round'
              ? { kind: 'faces-all-round', a: choice.a, count: choice.count, acrossFlats: choice.acrossFlats }
              : { kind: 'cross-hole', a: choice.a, diameter: choice.diameter },
        );
      } else {
        id = addOperationOfType(choice.type);
      }
    }
    setSection('cnc-engrave');
    if (id !== null) expandEngraveRow(id);
    closeWizard();
  }

  function next(): void {
    switch (step) {
      case 'machine':
        setPending(null);
        // #897 — the question next, because its answer is what the blank is sized from.
        setStep('operation');
        break;
      case 'operation':
        // #1107 — a NEW run with nothing picked cannot get here: its primary is disabled with
        // "Pick what to make first." and the empty job has its own door (#1183). A re-entry's
        // Done finishes the job as it is, adding nothing.
        if (operationChoice === null) {
          if (jobStarted) createOperation(null);
          break;
        }
        setStep('stock');
        break;
      case 'stock':
        leaveStock();
        break;
      case 'holding':
        // The last step creates the operation (or, on a re-entry, adds it or finishes).
        createOperation(operationChoice);
        break;
    }
  }

  function back(): void {
    setConfirmReplace(null);
    setStartError(null);
    const previous = previousWizardStep(step);
    if (previous !== null) setStep(previous);
  }

  const stepContent = (
    <>
      {step === 'machine' && (
        <MachineStep
          machines={machines}
          busy={busy}
          outcome={outcome}
          machine={machine}
          reason={reason}
          route={machineRoute}
          address={address}
          onAddress={setAddress}
          onCheck={(host) => {
            void runCheck(host);
          }}
          // #1106 — the step is a picker: the job's machine is the selected row, the last used is
          // first, and the bed is changed from here.
          // The rows are LOCATION RECORDS; the job carries the record's PROFILE id (item 1).
          selectedMachineId={selectedMachine?.id ?? null}
          lastMachineId={readLastMachineId()}
          onSelectMachine={(id) => {
            setSelectedRecordId(id);
            const record = machines?.find((m) => m.id === id);
            if (record?.profileId) useEngraveJobStore.getState().setMachine(record.profileId);
            writeLastMachineId(id);
          }}
          onChangeBed={() =>
            openMachineChange({
              forJob: { name: job.name, holding: job.workholding.kind },
              onDone: () => undefined,
            })
          }
        />
      )}

      {step === 'stock' && (
        <>
          <StockStep seed={stockSeed} onPending={onStockPending} part={partFootprintFor(work)} />
          {startError !== null && (
            <p style={{ ...MUTED, color: '#f0b4ad' }} data-testid="start-wizard-start-error">
              {startError}
            </p>
          )}
        </>
      )}

      {step === 'holding' && (
        <HoldingStep
          job={job}
          answers={answers}
          // #1103 — the recommended seat reads what the work takes, from the question step.
          work={workFactsOf(operationChoice, proposal, work)}
          onAnswers={applyHoldAnswers}
          onRotary={applyRotaryHolding}
          onBedHold={applyBedHolding}
          onHold={applyStockHold}
          onMoveItemsToTop={applyMoveItemsToTop}
          onMountBlocked={setMountBlocked}
          part={partFootprintFor(work)}
        />
      )}

      {step === 'operation' && (
        <OperationStep
          job={job}
          hasOperations={hasOperations}
          fresh={!jobStarted}
          initial={operationChoice}
          rotaryFacts={rotaryFacts}
          onChoiceChange={onOperationChoice}
          onStartEmptyJob={createEmptyJob}
        />
      )}
    </>
  );

  const stockUnblock =
    step === 'stock' && pending === null && confirmReplace === null && startError === null && !starting;
  // #1107 — the question's only footer sentence: a NEW run with nothing picked. (A picked but
  // incomplete answer draws its sentence inside its own field, as before.)
  const operationUnblock =
    step === 'operation' && operationChoice === null
      ? operationCreateBlocked(null, { reEntry: jobStarted })
      : null;

  // #713 review — a rod longer than the vise's grip has no vise mount, so the wizard must not let
  // the job LEAVE Holding held in one: while the answers are in a vise seat and the stock is a rod
  // too long for it, Next is disabled and carries the one sentence that unblocks it (hold it in
  // the rotary chuck, or change the stock). The mount options already refuse those seats; this is
  // the footer's same rule, because a job opened on a vise mount would otherwise pass through.
  const roundStock =
    job.stockEntry?.form === 'rod' || job.stockEntry?.form === 'tube' || job.stock.shape === 'cylinder';
  // The answers' mount is the rotary when the job is in the chuck; otherwise the vise answers'
  // seat names it (the same reading HoldingStep draws its radios from).
  const currentHolding = answers.workholding === 'rotary' ? 'rotary' : currentMount(answers);
  const holdingBlock =
    step === 'holding' && mechanismOf(currentHolding) === 'vise'
      ? rodViseProblem(answers.stock, roundStock)
      : null;

  const stepNumber = wizardStepNumber(step);

  return createPortal(
    <div
      className={narrow ? 'sw-overlay sw-overlay--sheet' : 'sw-overlay'}
      // The one stacking scale (#348), inline as the change wizard's is, so the order is readable.
      style={{ zIndex: 'var(--cm-z-modal)' }}
      data-testid="start-wizard"
    >
      <div
        className={step === 'holding' ? 'sw-card sw-card--wide' : 'sw-card'}
        role="dialog"
        aria-modal="true"
        aria-labelledby="start-wizard-title"
        data-testid="start-wizard-dialog"
      >
        <div className="sw-head">
          <div className="sw-title-row">
            {/* THE ONE COUNTER. No second numbering exists: this is the whole of it (#681, A1). Its
                text stays `Step n of 4 · Title` — the separator is there for the text, not drawn. */}
            <h2 className="sw-titles" id="start-wizard-title" data-testid="start-wizard-progress">
              <span className="sw-eyebrow">{wizardStepEyebrow(step)}</span>
              <span style={{ display: 'none' }}> · </span>
              <span className="sw-title">{wizardStep(step).name}</span>
            </h2>
            <button
              type="button"
              className="sw-close"
              aria-label="Close"
              title="Close"
              data-testid="start-wizard-close"
              onClick={closeWizard}
            >
              ✕
            </button>
          </div>
          <div className="sw-progress" aria-hidden="true" data-testid="start-wizard-progress-strip">
            {WIZARD_STEPS.map((s, i) => (
              <span
                key={s.id}
                className={i < stepNumber ? 'sw-progress__seg sw-progress__seg--on' : 'sw-progress__seg'}
              />
            ))}
          </div>
        </div>

        <div className="sw-body" data-testid="start-wizard-body">
          {/* #490 — a throw in a step used to blank the hand-off; the body has its own boundary so a
              broken step leaves the modal (and its Close) in place. */}
          <PanelErrorBoundary name="Cut setup flow">{stepContent}</PanelErrorBoundary>
          {/* #1123 item 3 — the replacement question, on whichever step raised it: the stock step's
              chosen blank, or the operation step's empty job. Both replace the job open now. */}
          {confirmReplace !== null && (
            <div
              data-testid="start-wizard-replace-confirm"
              style={{ border: '1px solid #7a5a28', background: '#241d12', borderRadius: 4, padding: 6, marginTop: 6 }}
            >
              <p style={{ ...MUTED, color: '#e0c07a', margin: 0 }}>
                The job open now has {confirmReplace.items} item{confirmReplace.items === 1 ? '' : 's'} on it.
                Starting a new job replaces it; save it first to keep its items.
              </p>
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <button
                  type="button"
                  data-testid="start-wizard-replace-yes"
                  onClick={() => {
                    const run = confirmReplace.run;
                    setConfirmReplace(null);
                    run();
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
        </div>

        {/* #348 — the actions are their own region, not a row tucked under the last field: a native
            `<select>`'s popup paints over what is under it, so the buttons get clearance. #870 — the
            step-wide sentence sits directly above them, pinned with the footer. */}
        <div className="sw-foot" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {operationUnblock !== null && (
            <p style={UNBLOCK} data-testid="start-wizard-operation-unblock">
              {operationUnblock}
            </p>
          )}
          {stockUnblock && (
            <p style={ARRIVAL} data-testid="start-wizard-stock-unblock">
              Choose the stock: a size you type, a piece on the shelf, or a file.
            </p>
          )}
          {holdingBlock !== null && (
            <p style={UNBLOCK} data-testid="start-wizard-holding-block">
              {holdingBlock}.
            </p>
          )}
          {holdingBlock === null && mountBlocked !== null && (
            <p style={UNBLOCK} data-testid="start-wizard-holding-unblock">
              {mountBlocked}.
            </p>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* #726 P10 — step 1 has no Back, and no footer Cancel: the header's ✕ is the one way
                out every step carries; the footer offers only what moves the flow. */}
            {step !== 'machine' && (
              <button type="button" className="sw-btn sw-btn--ghost" data-testid="start-wizard-back" onClick={back}>
                ← Back
              </button>
            )}
            <span className="sw-foot__spacer" />
            {doneStep && (
              // A re-entry finishes at the step it came to edit (#681 follow-up); #897 put the
              // question before the blank, so there is no later step for this press to walk to.
              <button
                type="button"
                className="sw-btn"
                data-testid="start-wizard-done"
                disabled={step === 'stock' && (pending === null || starting)}
                onClick={done}
              >
                Done
              </button>
            )}

            {step === 'machine' && (
              // The SAME test id either way: it is the button that advances, whatever it says.
              <button type="button" className="sw-btn sw-btn--primary" data-testid="start-wizard-next" onClick={next}>
                {canReachMachine ? wizardStep('machine').nextLabel : 'Continue without a machine'}
              </button>
            )}
            {step === 'stock' && confirmReplace === null && (
              <button
                type="button"
                className="sw-btn sw-btn--primary"
                data-testid="start-wizard-stock-next"
                disabled={pending === null || starting}
                onClick={next}
              >
                {starting ? 'Starting…' : wizardNextLabel('stock', reEntry)}
              </button>
            )}
            {step === 'holding' && (
              <button
                type="button"
                className="sw-btn sw-btn--primary"
                data-testid="engrave-setup-next"
                disabled={
                  holdingBlock !== null ||
                  mountBlocked !== null ||
                  // #1107 — a NEW run must have picked something; a re-entry's Done is unchanged.
                  operationCreateBlocked(operationChoice, { reEntry }) !== null
                }
                onClick={next}
              >
                {doneStep
                  ? 'Done'
                  : wizardNextLabel('holding', reEntry, operationChoice === null)}
              </button>
            )}
            {step === 'operation' && (
              // #897 — the question only walks on to the blank it sizes when something was picked;
              // the creating button is the last step's. #1123 item 3 — with nothing picked the
              // press creates the empty job (a new run) or finishes an existing one.
              <button
                type="button"
                className="sw-btn sw-btn--primary"
                data-testid="start-wizard-operation-next"
                // #1107 — nothing picked on a NEW run is refused (the dowel starter's old trap);
                // a re-entry's Done finishes without adding an item. #1123's empty job remains for
                // the re-entry door only. The reason is the button's own title: with nothing
                // picked the step draws no sentence (its line speaks for a picked item), so a
                // disabled control would otherwise say nothing at all.
                disabled={operationCreateBlocked(operationChoice, { reEntry: jobStarted }) !== null}
                title={
                  operationCreateBlocked(operationChoice, { reEntry: jobStarted }) ?? undefined
                }
                onClick={next}
              >
                {operationChoice === null
                  ? jobStarted
                    ? 'Done'
                    : 'Create the job'
                  : wizardNextLabel('operation', reEntry)}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
