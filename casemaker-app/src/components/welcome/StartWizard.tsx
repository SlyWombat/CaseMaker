import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { ensureSeedFontsLoaded } from '@/engine/fonts/registry';
import { canDriveMachine } from '@/platform/capabilities';
import { probeMachine } from '@/platform/machineProbe';
import { useSettingsStore } from '@/store/settingsStore';
import { findTemplateAcrossSources } from '@/library/templateRegistry';
import { blankProjectForStock } from '@/library/blankProject';
import { scheduleImmediate } from '@/engine/jobs/JobScheduler';
import { useProjectStore, clearHistory } from '@/store/projectStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useMachineStore } from '@/store/machineStore';
import { useLocationStore } from '@/store/locationStore';
import { useStartWizardStore } from '@/store/startWizardStore';
import { useViewportStore } from '@/store/viewportStore';
import { PanelErrorBoundary } from '@/components/ui/PanelErrorBoundary';
import { readDesignFile } from '@/engine/import/designImport';
import { embedSource } from '@/engine/cnc/engrave/jobSources';
import { useStockStore } from '@/store/stockStore';
import { expandEngraveRow } from '@/store/engraveRowStore';
import { addOperationOfType, jobHasOperations } from '@/components/panels/operationTypes';
import type { Project } from '@/types/project';
import type { EngraveJob, JobStockEntry } from '@/types/engraveJob';
import { defaultSetupAnswers, type SetupAnswers } from '@/engine/cnc/engrave/setupFlow';
import { facingSeed, facingShopFrom, jobItemCount } from '@/engine/cnc/stockStart';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import '@/store/stockEntryFollow';
import { previousWizardStep, wizardNextLabel, wizardStep, wizardStepLine, type WizardStepId } from './wizardSteps';
import { MachineStep } from './MachineStep';
import { StockStep } from './StockStep';
import { HoldingStep } from './HoldingStep';
import { OperationStep, operationCreateBlocked, type OperationChoice } from './OperationStep';
import type { PendingStock, StartStockSeed } from './StartStockStep';

/**
 * #681 — the ONE cutting-job wizard.
 *
 * A cutting job is four questions, asked once, in one modal with one counter:
 *
 * ```
 * Step 1 of 4 · Machine      the machine the job is written for, and a check (never a gate)
 * Step 2 of 4 · Stock        material, then where the piece comes from
 * Step 3 of 4 · Holding      how it is held, and what that does to the blank
 * Step 4 of 4 · What are you cutting?   the grouped picker and the field the pick needs
 * ```
 *
 * THE SHELL owns the step index, the counter and the transitions; each step's body is its own file
 * (`MachineStep`, `StockStep`, `HoldingStep`, `OperationStep`) so a wave-2 slice can rewrite one
 * without touching the numbering, the footer or another step. The panel's Stock and Hold `edit`
 * controls re-open this same wizard at the step they name (`openWizard('stock' | 'holding')`), with
 * the same counter — not a second modal with a second numbering (A1, B3, A10, E1).
 *
 * The old second modal (`EngraveSetupFlow`) is gone: its material and blank questions are step 2,
 * its holding question step 3, and its "What are you cutting?" step 4. Nothing is handed off to a
 * second overlay; the wizard lands in Design with the item made, its row open.
 *
 * Portal'd to `document.body` at the modal layer of the one stacking scale (`--cm-z-modal`, #348)
 * and mounted from `AppShell` rather than the welcome overlay — step 2 can create the project,
 * which flips `welcomeMode` off and unmounts that overlay, and this has to survive it.
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
/** #684 — Holding draws a top-view picture beside the mount options, so that one step is wider. */
const BOX_WIDE: CSSProperties = { ...BOX, width: 'min(700px, 100%)' };

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const FOOTER: CSSProperties = {
  display: 'flex',
  gap: 6,
  marginTop: 14,
  paddingTop: 10,
  borderTop: '1px solid #2a2f36',
  flexWrap: 'wrap',
};
const UNBLOCK: CSSProperties = { fontSize: 11, color: '#e0c07a', margin: '6px 0 0' };

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

/** A job's own stock as step 2's starting answers, when the step is re-opened to edit it (#681). */
function seedFromJob(job: EngraveJob): StartStockSeed {
  const entry = job.stockEntry;
  const computed = (['length', 'width', 'thickness'] as const).every(
    (key) => job.sources?.stock?.[key] === 'computed',
  );
  return {
    form: entry?.form ?? 'plate',
    material: job.stock.material,
    length: job.stock.length,
    width: job.stock.width,
    thickness: job.stock.thickness,
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
  return (
    s.length === job.stock.length &&
    s.width === job.stock.width &&
    s.thickness === job.stock.thickness &&
    s.material === job.stock.material &&
    (s.colour === undefined || JSON.stringify(s.colour) === JSON.stringify(job.stock.colour ?? null))
  );
}

export function StartWizard(): JSX.Element {
  const closeWizard = useStartWizardStore((s) => s.closeWizard);
  const initialStep = useStartWizardStore((s) => s.initialStep);
  // #680 — a starter job on the welcome door opens this wizard with its blank already the stock.
  // The template id is the door's word for it; `chooseJob` (the one template path since #683 took
  // the cards out of step 2) does the rest: project, seeded stock, step 3, and the counters move
  // as they always have.
  const starter = useStartWizardStore((s) => s.starter);
  const starterRan = useRef(false);
  const machine = useMachineStore((s) => s.machine);
  const outcome = useMachineStore((s) => s.outcome);
  const reason = useMachineStore((s) => s.reason);
  const setProbeResult = useMachineStore((s) => s.setProbeResult);
  const setProject = useProjectStore((s) => s.setProject);
  const setSection = useViewportStore((s) => s.setActiveSidebarSection);
  // #682 — step 1 wears the location's machine (name, nickname and address) without a picker.
  const machines = useLocationStore((s) => s.location?.machines ?? null);
  const setMachineCalibration = useSettingsStore((s) => s.setMachineCalibration);
  const job = useEngraveJobStore((s) => s.job);

  // THE ONE STEP INDEX. It starts where the opener asked (the panel's Stock/Hold `edit` names a
  // step), and from then on only this shell moves it.
  const [step, setStep] = useState<WizardStepId>(initialStep);
  // Re-entry is an EDIT: it opens on an existing job and must not reset it. A new job becomes an
  // edit the moment step 2 creates it, so Back to Stock asks about the stock the job now has.
  const [jobStarted, setJobStarted] = useState(initialStep !== 'machine');
  // HOW this run was opened, captured at mount: a run that did not start at step 1 was opened by
  // the panel's Stock/Hold `edit` on an existing job, so it finishes at the step it came to edit.
  // `jobStarted` cannot answer this later — a new job turns it true when step 2 creates the project.
  const [reEntry] = useState(initialStep !== 'machine');
  // Whether THIS run made the project. Step 2 after a Back must keep the drawn part equal to the
  // stock it wrote; a panel re-entry edits a job beside a project someone else owns.
  const [projectCreatedHere, setProjectCreatedHere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingStock | null>(null);
  // The one sentence a stock form is blocked with, when the form itself cannot start the job (a rod
  // past the vise's grip). The step puts it under the picture; here it sits at the Next button.
  const [stockBlock, setStockBlock] = useState<string | null>(null);
  const onStockPending = useCallback((next: PendingStock | null, block: string | null) => {
    setPending(next);
    setStockBlock(block);
  }, []);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState<{ pending: PendingStock; items: number } | null>(null);
  const [address, setAddress] = useState('');
  const [answers, setAnswers] = useState<SetupAnswers>(() =>
    defaultSetupAnswers(useEngraveJobStore.getState().job),
  );
  const [operationChoice, setOperationChoice] = useState<OperationChoice | null>(null);
  const onOperationChoice = useCallback((choice: OperationChoice | null) => setOperationChoice(choice), []);

  useEffect(() => {
    if (starter === null || starterRan.current) return;
    starterRan.current = true;
    void chooseJob(starter);
    // The starter is captured once per open; chooseJob owns the project, stock and step from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for the opening starter
  }, [starter]);

  const hasOperations = jobHasOperations(job);
  const seed = jobStarted ? seedFromJob(job) : undefined;
  // The step this re-entry came to edit: its primary action is Done, not the next step. While a
  // stock replacement is being confirmed, the confirmation owns the footer.
  const doneStep =
    reEntry &&
    step === initialStep &&
    (step === 'holding' || (step === 'stock' && confirmReplace === null));

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

  /** Step 3 is always seeded from the job as it now stands, so Back and forth cannot go stale. */
  function enterHolding(): void {
    setAnswers(defaultSetupAnswers(useEngraveJobStore.getState().job));
    setStep('holding');
  }

  /**
   * Holding answers write as they change: there is no later Finish to collect them. The write is
   * the holding's own — the stock and its provenance belong to step 2 and are left untouched
   * (#684 review: a laminate's assumed cap has no answer field to carry it through a whole-setup
   * write, so writing the stock dropped it).
   */
  function applyHoldAnswers(next: SetupAnswers): void {
    setAnswers(next);
    useEngraveJobStore.getState().applyHoldAnswers(next);
  }

  async function chooseJob(id: string): Promise<void> {
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
    setJobStarted(true);
    setProjectCreatedHere(true);
    enterHolding();
    await scheduleImmediate(project);
  }

  /**
   * Step 2, new job (#418): start from the settled stock with an empty design.
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
      const facing = facingSeed(
        entry.finish,
        seeded.stock.material,
        facingShopFrom(useShopDefaultsStore.getState().defaults),
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
      setJobStarted(true);
      setProjectCreatedHere(true);
      enterHolding();
      await scheduleImmediate(project);
    } finally {
      setStarting(false);
    }
  }

  /**
   * Step 2, re-opened from the panel's Stock `edit`: change THIS job's stock and keep its items.
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
    setStarting(true);
    setStartError(null);
    try {
      // Passing THROUGH the step is not an edit: only a changed answer is written.
      const current = useEngraveJobStore.getState().job;
      if (sameStockChoice(p, current)) {
        if (closeAfter) closeWizard();
        else enterHolding();
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
      const facing = facingSeed(
        p.choice.entry.finish,
        after.stock.material,
        facingShopFrom(useShopDefaultsStore.getState().defaults),
      );
      store.replace({ ...after, stockEntry: p.choice.entry, facing });
      if (closeAfter) closeWizard();
      else enterHolding();
    } finally {
      setStarting(false);
    }
  }

  function applyStock(p: PendingStock, closeAfter = false): void {
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
    // #418 review — starting from stock replaces the job open now, so a job with items is asked
    // first. A design FILE carries its own items and stock, so it replaces on re-entry too; a
    // size/material edit of a job beside someone else's project keeps the items and asks nothing.
    const replaces =
      !jobStarted ||
      pending.kind === 'design' ||
      (projectCreatedHere && !sameStockChoice(pending, current));
    if (replaces) {
      const items = jobItemCount(current);
      if (items > 0) {
        setConfirmReplace({ pending, items });
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

  /** Step 4's Create: make the operation, open its row and land in Design. */
  function createOperation(choice: OperationChoice | null): void {
    let id: string | null = null;
    if (choice !== null) {
      if (choice.type === 'engrave') {
        id = addOperationOfType('engrave');
        // The placeholder "New text" is never what was asked for: the line is made with the text
        // (and depth, and face) the operator gave it, in the same write.
        useEngraveJobStore.getState().updateLabel(id, {
          text: choice.text,
          depth: choice.depth,
          font: choice.font,
        });
      } else if (choice.type === 'surface') {
        // #685 — Surface a mesh is the one operation whose item is not a store "add": the file
        // that was read in the step IS the goal object, and it is the whole job.
        if (choice.target !== null) {
          useEngraveJobStore.getState().setTargetObject(choice.target);
          id = choice.target.id;
        }
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
        setStep('stock');
        break;
      case 'stock':
        leaveStock();
        break;
      case 'holding':
        setStep('operation');
        break;
      case 'operation':
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
          address={address}
          onAddress={setAddress}
          onCheck={(host) => {
            void runCheck(host);
          }}
        />
      )}

      {step === 'stock' && (
        <>
          <StockStep seed={seed} onPending={onStockPending} />
          {confirmReplace !== null && (
            <div
              data-testid="start-wizard-replace-confirm"
              style={{ border: '1px solid #7a5a28', background: '#241d12', borderRadius: 4, padding: 6, marginTop: 6 }}
            >
              <p style={{ ...MUTED, color: '#e0c07a', margin: 0 }}>
                The job open now has {confirmReplace.items} item{confirmReplace.items === 1 ? '' : 's'} on it. A new
                project starts a new job, and there is one job here until save and open land — starting
                replaces it, and its items are lost.
              </p>
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <button
                  type="button"
                  data-testid="start-wizard-replace-yes"
                  onClick={() => {
                    const p = confirmReplace.pending;
                    setConfirmReplace(null);
                    applyStock(p);
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
        </>
      )}

      {step === 'holding' && <HoldingStep job={job} answers={answers} onAnswers={applyHoldAnswers} />}

      {step === 'operation' && (
        <OperationStep job={job} hasOperations={hasOperations} onChoiceChange={onOperationChoice} />
      )}
    </>
  );

  const stockUnblock =
    step === 'stock' && pending === null && confirmReplace === null && startError === null && !starting;

  return createPortal(
    <div style={OVERLAY} data-testid="start-wizard">
      <div style={step === 'holding' ? BOX_WIDE : BOX} role="dialog" aria-label="New cutting job">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* THE ONE COUNTER. No second numbering exists: this line is the whole of it (#681, A1). */}
          <b style={{ flex: 1, fontSize: 13 }} data-testid="start-wizard-progress">
            {wizardStepLine(step)}
          </b>
          <button type="button" data-testid="start-wizard-close" onClick={closeWizard}>
            Close
          </button>
        </div>

        {/* #490 — a throw in a step used to blank the hand-off; the body has its own boundary so a
            broken step leaves the modal (and its Close) in place. */}
        <PanelErrorBoundary name="Cut setup flow">{stepContent}</PanelErrorBoundary>

        {stockUnblock && (
          <p style={UNBLOCK} data-testid="start-wizard-stock-unblock">
            {stockBlock ?? 'Choose the stock above — a piece on the shelf, a size you type, or a file.'}
          </p>
        )}

        {/* #348 — the actions are their own region, not a row tucked under the last field: a native
            `<select>`'s popup paints over what is under it, so the buttons get clearance. */}
        <div style={FOOTER}>
          {step === 'machine' ? (
            <button type="button" data-testid="start-wizard-cancel" onClick={closeWizard}>
              Cancel
            </button>
          ) : (
            <button type="button" data-testid="start-wizard-back" onClick={back}>
              ← Back
            </button>
          )}

          {step === 'machine' && (
            // The SAME test id either way: it is the button that advances, whatever it says.
            <button
              type="button"
              data-testid="start-wizard-next"
              style={{ padding: '3px 12px' }}
              title="A job does not need a machine."
              onClick={next}
            >
              {canDriveMachine ? wizardStep('machine').nextLabel : 'Continue without a machine'}
            </button>
          )}
          {step === 'stock' && confirmReplace === null && (
            <button
              type="button"
              data-testid="start-wizard-stock-next"
              style={doneStep ? undefined : { padding: '3px 12px' }}
              disabled={pending === null || starting}
              onClick={next}
            >
              {starting ? 'Starting…' : wizardNextLabel('stock', reEntry)}
            </button>
          )}
          {step === 'holding' && (
            <button
              type="button"
              data-testid="engrave-setup-next"
              style={doneStep ? undefined : { padding: '3px 12px' }}
              onClick={next}
            >
              {wizardNextLabel('holding', reEntry)}
            </button>
          )}
          {step === 'operation' && (
            <button
              type="button"
              data-testid="start-wizard-create"
              style={{ padding: '3px 12px' }}
              disabled={operationCreateBlocked(operationChoice) !== null || (operationChoice === null && !hasOperations)}
              onClick={next}
            >
              {wizardNextLabel('operation', reEntry)}
            </button>
          )}
          {doneStep && (
            // The edited step's primary action on a re-entry: finish here, so walking to step 4 is
            // a choice rather than the price of closing the wizard (#681 follow-up).
            <button
              type="button"
              data-testid="start-wizard-done"
              style={{ padding: '3px 12px' }}
              disabled={step === 'stock' && (pending === null || starting)}
              onClick={done}
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
