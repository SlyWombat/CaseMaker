/**
 * #693 — the change-the-machine wizard (station 3a of `first-job-flow-mockups.html`).
 *
 * FIVE STEPS IN ONE MODAL, the mockup's shape: 1 What changes · 2 Make it safe · 3 Take off ·
 * 4 Fit · 5 Confirm. Steps 1 and 2 are answered by what the product already knows and what the
 * machine says; 3 and 4 are the operator's own hands, one action per line; 5 is the one write.
 *
 * THE SAFETY LINES ARE THE POINT. Home is read off the controller (`Idle` at its homed rest), not
 * ticked by the operator; the work light is sent with `machineLight.ts`'s own switch, which asks the
 * machine before it sends anything. The spindle-cold line is the one thing no machine here can see,
 * which is why it is the operator's check and says so. With the machine unreachable, the two machine
 * lines say why they cannot tick and the change stops: a fixture is not swapped on a machine nobody
 * has homed.
 *
 * NOTHING IS WRITTEN BEFORE CONFIRM. Steps 3 and 4 only tick local checkboxes. Confirm writes the
 * new bed profile through the guarded machine PUT (`saveMachineWithRetry`, #650) and moves the two
 * accessory records (`whereabouts`). It does NOT move the machine: the operator may still have a
 * hand in it when that press lands, so step 5's Work light off and Home are each their own press,
 * with the machine's answer as the line's tick — and "Back to the job" waits for neither, because
 * the record is already written. Closing at any earlier point leaves the location exactly as it was,
 * which `machineChangeWizard.spec.tsx` pins.
 *
 * THE JOB THAT ASKED IS RE-CHECKED. When the caller names a frozen job's mount, the new profile is
 * asked whether it can still hold that mount; if not, step 5 says so in one sentence ("Generate it
 * again before cutting") and the result carries `refreeze: true` to the caller. The package itself
 * is not re-frozen here — that is the gate's job, and this slice only flags it.
 */

import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { newId } from '@/utils/id';
import type { MachineRecord } from '@/platform/locationClient';
import { useLocationStore, saveMachineWithRetry } from '@/store/locationStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { readDefault } from '@/platform/defaultsClient';
import {
  MACHINE_MOUNT_WORDS,
  accessoryFor,
  activeMountOf,
  activeProfileOf,
  changeHeadline,
  changeRecordWords,
  datumDescriptorFor,
  fitSteps,
  planMountChange,
  profileHolds,
  refreezeSentence,
  shippedDatumFor,
  shippedDatumProfileName,
  surfaceChangeFor,
  changePowersOff,
  surfaceWords,
  takeOffSteps,
  targetMountsFor,
  type MachineMountKind,
  type MountDatumKey,
  type SurfaceChange,
} from '@/platform/machineChange';
import { checkMachine, homeMachine, type MachineAnswer } from '@/platform/machineChangeRun';
import { toggleLight } from '@/platform/machineLight';
import { useMachineChangeStore, type MachineChangeResult } from '@/store/machineChangeStore';
import { formatStamp } from '../manage/display';
import './machineChange.css';

/** The three make-it-safe lines, in the mockup's order. */
type LineState = { done: boolean; meta: string | null; note: string | null };
const NOT_DONE: LineState = { done: false, meta: null, note: null };

/** `±0.5` — the band a re-fit is taken to repeat within, from the shop's own vise uncertainty. */
function refitBandMm(): string {
  const v = readDefault(useShopDefaultsStore.getState().defaults, 'vise.uncertaintyMm').value;
  return Number(v.toFixed(3)).toString();
}

/** A small picture for each physical step, so "a picture each" is true rather than a promise. */
function StepIcon({ word }: { word: string }): JSX.Element {
  const w = word.toLowerCase();
  const common = {
    width: 26,
    height: 20,
    viewBox: '0 0 26 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (w.includes('bolt')) {
    return (
      <svg {...common}>
        <circle cx="13" cy="10" r="5" />
        <path d="M13 6v8M9 10h8" />
      </svg>
    );
  }
  if (w.includes('lift')) {
    return (
      <svg {...common}>
        <path d="M13 16V4M8 9l5-5 5 5" />
        <path d="M5 18h16" />
      </svg>
    );
  }
  if (w.includes('shelf')) {
    return (
      <svg {...common}>
        <path d="M3 13h20M6 13v5M20 13v5" />
        <rect x="9" y="6" width="8" height="7" rx="1" />
      </svg>
    );
  }
  if (w.includes('pins')) {
    return (
      <svg {...common}>
        <path d="M3 15h20" />
        <path d="M9 15V6M17 15V6M7 6h4M15 6h4" />
      </svg>
    );
  }
  if (w.includes('cable')) {
    return (
      <svg {...common}>
        <path d="M4 13c4 0 4-6 8-6s4 6 8 6" />
        <rect x="10" y="10" width="6" height="6" rx="1" />
      </svg>
    );
  }
  if (w.includes('chuck') || w.includes('key')) {
    return (
      <svg {...common}>
        <circle cx="13" cy="10" r="6" />
        <path d="M13 4v3M13 13v3M7 10h3M16 10h3M13 8v4" />
      </svg>
    );
  }
  if (w.includes('jaw')) {
    return (
      <svg {...common}>
        <path d="M4 16V5h5v11M22 16V5h-5v11" />
        <path d="M9 10h8" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="13" cy="10" r="6" />
      <path d="M10 10l2 2 4-4" />
    </svg>
  );
}

/** One step's shell: marker, title, and whatever the step draws. */
function Step({
  n,
  title,
  state,
  children,
}: {
  n: number;
  title: string;
  state: 'done' | 'current' | 'later';
  children?: ReactNode;
}): JSX.Element {
  return (
    <section className="mc-step" data-state={state} data-testid={`machine-change-step-${n}`}>
      <span className="mc-marker" aria-hidden="true">
        {state === 'done' ? '✓' : n}
      </span>
      <div className="mc-text">
        <b>
          {n} {title}
        </b>
        {children}
      </div>
    </section>
  );
}

/** A checkable physical action, with its picture. */
function CheckLine({
  item,
  checked,
  onToggle,
  testId,
}: {
  item: string;
  checked: boolean;
  onToggle: () => void;
  testId: string;
}): JSX.Element {
  return (
    <label className="mc-check" data-done={checked} data-testid={testId}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <StepIcon word={item} />
      <span>{item}</span>
    </label>
  );
}

export function MachineChangeWizard(): JSX.Element | null {
  const open = useMachineChangeStore((s) => s.open);
  const request = useMachineChangeStore((s) => s.request);
  const session = useMachineChangeStore((s) => s.session);
  const close = useMachineChangeStore((s) => s.close);
  if (!open) return null;
  return <Wizard key={session} request={request} onClose={close} />;
}

function Wizard({
  request,
  onClose,
}: {
  request: ReturnType<typeof useMachineChangeStore.getState>['request'];
  onClose: () => void;
}): JSX.Element {
  const location = useLocationStore((s) => s.location);
  const machine = location?.machines[0] ?? null;
  const accessories = location?.accessories ?? [];
  const active = activeProfileOf(machine);
  const from = activeMountOf(machine);
  const address = machine?.address ?? null;
  const job = request.forJob ?? null;

  const [target, setTarget] = useState<MachineMountKind | null>(request.target ?? null);
  const [view, setView] = useState<number | null>(null);

  const [answer, setAnswer] = useState<MachineAnswer | null>(null);
  const [checking, setChecking] = useState(false);

  const [home, setHome] = useState<LineState>(NOT_DONE);
  const [homing, setHoming] = useState(false);
  const [light, setLight] = useState<LineState>(NOT_DONE);
  const [lightBusy, setLightBusy] = useState(false);
  const [byHand, setByHand] = useState(false);
  // #717 — the fit's own power cycle is the machine's switch, ticked by the operator (#479).
  const [poweredOff, setPoweredOff] = useState(false);

  const [offChecks, setOffChecks] = useState<boolean[]>([]);
  const [onChecks, setOnChecks] = useState<boolean[]>([]);
  const [takenOff, setTakenOff] = useState(false);
  const [fitted, setFitted] = useState(false);
  // #706 — the rotary fit's Done waits for the machine's own answer after power-on.
  const [fitChecking, setFitChecking] = useState(false);
  const [fitNote, setFitNote] = useState<string | null>(null);
  const [datumChoice, setDatumChoice] = useState<'measure' | 'shipped' | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState<{
    at: string;
    refreeze: boolean;
    notes: string[];
    result: MachineChangeResult;
  } | null>(null);
  // Step 5's two closing actions are the operator's own presses — Confirm never moves the machine.
  const [finalLight, setFinalLight] = useState<LineState>(NOT_DONE);
  const [finalLightBusy, setFinalLightBusy] = useState(false);
  const [finalHome, setFinalHome] = useState<LineState>(NOT_DONE);
  const [finalHoming, setFinalHoming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The step words are the change as it was ASKED FOR. After Confirm the machine's active profile
  // changes, so `from` (read live) would name the incoming fixture on both sides; the frozen copy
  // keeps step 1 and the take-off title describing what the operator actually did. #706 — the
  // wasteboard's move is part of the change, and its words are frozen the same way.
  const shownFrom = confirmed?.result.from ?? from;
  const plannedSurface: SurfaceChange | null =
    machine === null || target === null ? null : surfaceChangeFor(machine, target);
  const plannedWasteboard: 'off' | 'back' | null =
    confirmed?.result.wasteboard ?? plannedSurface?.wasteboard ?? null;
  const takeWords = takeOffSteps(shownFrom, { wasteboard: plannedWasteboard === 'off' ? 'off' : null });
  const fitWords = target === null ? null : fitSteps(target, { wasteboard: plannedWasteboard === 'back' ? 'back' : null });
  // #717 — a change that touches the vise or the rotary is made with the machine off at its own
  // switch (Makera's page for each), so step 2 carries the switch and the work light line moves to
  // AFTER the power returns: a powered-off machine has no light.
  const powerOff = target !== null && changePowersOff(from, target);
  const bedNowWords =
    plannedWasteboard === 'off'
      ? 'wasteboard off'
      : plannedWasteboard === 'back'
        ? 'wasteboard under'
        : active !== null
          ? surfaceWords(active.surface)
          : null;
  const datumDesc = target === null ? null : datumDescriptorFor(target);
  const shippedDatum = datumDesc === null ? null : shippedDatumFor(machine, datumDesc.key);

  // ── The machine check: on open, and on demand ────────────────────────────────────────────────
  const runCheck = async (): Promise<void> => {
    if (address === null) return;
    setChecking(true);
    setError(null);
    const a = await checkMachine(address);
    setAnswer(a);
    setChecking(false);
    if (a.kind === 'ok' && a.rest.state === 'Idle' && a.rest.homed) {
      // The machine is already home: that IS the line's answer. It is not moved again for display.
      setHome({ done: true, meta: 'Idle · homed ✓', note: null });
    }
  };

  useEffect(() => {
    if (address === null) return;
    // Deferred one tick: the check's first act is a state write ("checking"), and a synchronous
    // setState from an effect body is the cascading render the hooks rule refuses.
    let live = true;
    const timer = setTimeout(() => {
      if (live) void runCheck();
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one check per machine address; `runCheck` closes over state setters only
  }, [address?.host, address?.port]);

  // Escape closes, like every other dialog. Nothing is written before Confirm, so there is nothing
  // to lose but the operator's own ticks. While the write is in flight it cannot be closed: the
  // record and the fixture moves are one outcome, and walking away mid-way is not an option the
  // dialog offers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !confirming) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirming]);

  // ── Make it safe ─────────────────────────────────────────────────────────────────────────────
  async function doHome(): Promise<void> {
    if (address === null) return;
    setHoming(true);
    setError(null);
    const r = await homeMachine(address);
    if (r.kind === 'homed') {
      setHome({ done: true, meta: r.sent ? '$H · Idle · homed ✓' : 'Idle · homed ✓', note: null });
    } else setHome({ done: false, meta: null, note: `Home did not complete: ${r.detail}.` });
    setHoming(false);
  }

  async function doLightOn(): Promise<void> {
    if (address === null) return;
    setLightBusy(true);
    setError(null);
    const r = await toggleLight(address, true);
    if (r.kind === 'toggled') setLight({ done: true, meta: 'M821 ✓', note: null });
    else {
      setLight({ done: false, meta: null, note: `The work light was not switched on: ${r.detail}.` });
    }
    setLightBusy(false);
  }

  /**
   * #706/#717 — A POWER-OFF FIT'S DONE IS THE MACHINE'S OWN ANSWER. The 4th axis's cable is never
   * plugged in live, and #717's vise fit is Makera's power-off install: the operator switches the
   * machine off for the fit and on again afterwards, and this press asks `?` through the SAME
   * status read step 2 uses. No answer, no advance — and power stays the machine's own switch,
   * never this app (#479).
   */
  async function doFitDone(): Promise<void> {
    if (powerOff && address !== null) {
      setFitChecking(true);
      setFitNote(null);
      const a = await checkMachine(address);
      setFitChecking(false);
      if (a.kind !== 'ok') {
        setFitNote(
          `The machine has not answered — ${a.detail}. Switch it on at its switch, wait for its screen, then press Done again.`,
        );
        return;
      }
      setFitNote(`The machine answered${a.rest.state !== null ? ` · ${a.rest.state}` : ''} ✓`);
    }
    setFitted(true);
    advance();
  }

  // Step 5's closing lines: each is its own press, answered by the machine, and neither is required
  // for the record — which is already written by the time they exist.
  async function doLightOff(): Promise<void> {
    if (address === null) return;
    setFinalLightBusy(true);
    const r = await toggleLight(address, false);
    if (r.kind === 'toggled') setFinalLight({ done: true, meta: 'M822 ✓', note: null });
    else setFinalLight({ done: false, meta: null, note: `The work light was not switched off: ${r.detail}.` });
    setFinalLightBusy(false);
  }

  async function doFinalHome(): Promise<void> {
    if (address === null) return;
    setFinalHoming(true);
    const r = await homeMachine(address);
    if (r.kind === 'homed') {
      setFinalHome({ done: true, meta: r.sent ? '$H · Idle · homed ✓' : 'Idle · homed ✓', note: null });
    } else setFinalHome({ done: false, meta: null, note: `Home did not complete: ${r.detail}.` });
    setFinalHoming(false);
  }

  // ── Progress ─────────────────────────────────────────────────────────────────────────────────
  const targetError =
    target !== null && target !== from && target !== 'bed' && accessoryFor(accessories, target) === null
      ? `The house does not own ${target === 'vise' ? 'a vise' : 'a rotary module'}, so there is nothing to fit.`
      : target !== null && target === from
        ? `${MACHINE_MOUNT_WORDS[target]} is already on the machine.`
        : null;
  const targetDone = confirmed !== null || (target !== null && targetError === null);
  // #717 — with the fit done powered off, the light line lives in step 4 (after the power
  // returns); step 2's own answer is the switch. The light still gates the FIT's Done.
  const safeDone = home.done && byHand && (powerOff ? poweredOff : light.done);
  // #706 — a bed → rotary change still has the wasteboard to take off, so the step's own words
  // decide whether there is anything to do (not the mount alone).
  const takeDone = takeWords === null ? true : takenOff;
  const datumResolved = datumDesc === null || datumChoice !== null;
  // #717 — a fit is walked whenever there ARE fit steps (a change to a bed job's "wasteboard back
  // on" is one), and a power-off fit is not done until the light is back on (its line follows it).
  const fitDone = fitWords === null ? true : fitted && datumResolved && (!powerOff || light.done);
  const firstIncomplete = !targetDone ? 1 : !safeDone ? 2 : !takeDone ? 3 : !fitDone ? 4 : 5;
  const shown = confirmed !== null ? 5 : (view ?? firstIncomplete);
  /** Nothing is on / nothing is fitted: the step is complete without a tick. */
  const skipped = (n: number): boolean => (n === 3 && takeWords === null) || (n === 4 && fitWords === null);
  const stateOf = (n: number): 'done' | 'current' | 'later' => {
    // Once the change is written, every step is behind the operator — including the Confirm row.
    if (confirmed !== null) return 'done';
    if (n === shown) return 'current';
    if (n < firstIncomplete || skipped(n)) return 'done';
    return 'later';
  };
  const advance = (): void => setView(null);
  const back = (): void => setView(Math.max(1, shown - 1));

  // ── Confirm: the one write ───────────────────────────────────────────────────────────────────
  async function confirm(): Promise<void> {
    // The record write does not need the machine to answer; step 5's closing lines do, and each
    // says so on its own.
    if (target === null || machine === null) return;
    setConfirming(true);
    setError(null);
    const at = new Date().toISOString();
    const profileId = newId('bp');
    const datumKey: MountDatumKey | null = datumDesc?.key ?? null;
    const datum = datumChoice === 'shipped' && datumKey !== null ? shippedDatumFor(machine, datumKey) : null;

    const freshMachine = (): typeof machine =>
      useLocationStore.getState().location?.machines.find((m) => m.id === machine.id) ?? machine;
    const freshAccessories = (): typeof accessories => useLocationStore.getState().location?.accessories ?? accessories;

    const plan = planMountChange({
      machine: freshMachine(),
      to: target,
      datum,
      profileId,
      at,
      jobName: job?.name ?? null,
      accessories: freshAccessories(),
    });
    if ('error' in plan) {
      setError(plan.error);
      setConfirming(false);
      return;
    }

    // #650 — a stale guard re-applies the change to the record the service holds, so another
    // window's datum or accessory edit survives this write.
    const outcome = await saveMachineWithRetry(freshMachine(), (current) => {
      // A retry that reaches a record already carrying this profile has nothing left to do — and
      // re-planning would add a second profile with the same id, which the schema refuses.
      if (current.bedProfiles?.some((p) => p.id === profileId)) return current;
      const again = planMountChange({
        machine: current,
        to: target,
        datum,
        profileId,
        at,
        jobName: job?.name ?? null,
        accessories: freshAccessories(),
      });
      return 'error' in again ? current : again.machine;
    });
    if (outcome !== 'ok') {
      setError(
        `The bed was not written: ${useLocationStore.getState().writeNote ?? (outcome === 'stale' ? 'the machine changed again while it was being written' : 'the service refused it')}.`,
      );
      setConfirming(false);
      return;
    }
    const applied = useLocationStore.getState().location?.machines.find((m) => m.id === machine.id);
    if (applied !== undefined && applied.activeBedProfileId !== profileId) {
      setError('The bed changed in another window while this change was being written — open Manage and try again.');
      setConfirming(false);
      return;
    }

    // The fixtures' own records move with them. A refusal here is reported and does not undo the
    // bed: the change happened at the machine, and the record of where the fixture is must not
    // pretend otherwise.
    const notes: string[] = [];
    for (const planned of plan.accessoryWrites) {
      let write = planned;
      let done = false;
      for (let attempt = 0; attempt < 2 && !done; attempt++) {
        const r = await useLocationStore.getState().saveAccessory(write);
        if (r === 'ok') done = true;
        else if (r === 'stale') {
          // Another window edited this accessory between the read and the write: re-apply the one
          // move to THEIR record rather than overwriting their measurement with our stale copy.
          const fresh = freshAccessories().find((a) => a.id === write.id);
          if (fresh !== undefined) {
            write = {
              ...fresh,
              whereabouts: planned.whereabouts,
              history: [...fresh.history, planned.history.at(-1)!],
            };
          }
        } else {
          notes.push(
            `${write.product ?? write.kind}: not written (${useLocationStore.getState().accessoryNote ?? 'the service refused it'}).`,
          );
          break;
        }
      }
      if (!done && !notes.some((n) => n.startsWith(write.product ?? write.kind))) {
        notes.push(`${write.product ?? write.kind}: not written (the record was changing in another window).`);
      }
    }

    // NOTHING MOVES HERE. The operator may still have a hand in the machine when this press lands:
    // step 5's light-off and home are their own presses below, with the machine's answer as each
    // line's tick. The record is written; "Back to the job" does not wait for either.
    const refreeze = job?.frozen === true && !profileHolds(plan.profile, job.frozenMount ?? null);
    setConfirmed({
      at,
      refreeze,
      notes,
      result: {
        profileId,
        profileName: plan.profile.name,
        from: plan.from,
        to: plan.to,
        wasteboard: plan.wasteboard,
        refreeze,
        jobName: job?.name ?? null,
      },
    });
    setConfirming(false);
  }

  function finish(): void {
    if (confirmed !== null) {
      try {
        request.onDone?.(confirmed.result);
      } catch {
        // A caller's callback is not this dialog's failure; the write already happened.
      }
    }
    onClose();
  }

  // ── Render ───────────────────────────────────────────────────────────────────────────────────
  if (machine === null || active === null) {
    return createPortal(
      <div className="mc-backdrop" data-testid="machine-change-backdrop" style={{ zIndex: 'var(--cm-z-modal-raised)' }}>
        <div
          className="mc-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="machine-change-title"
          data-testid="machine-change"
        >
          <header className="mc-head">
            <span className="mc-eyebrow">Change the machine</span>
            <h3 id="machine-change-title">Change the machine</h3>
            <button type="button" className="mc-close" aria-label="Close" data-testid="machine-change-close" onClick={onClose}>
              ✕
            </button>
          </header>
          <div className="mc-body">
            <p className="mc-hint" data-testid="machine-change-no-bed">
              This location has no machine with a described bed, so there is nothing to change here.
            </p>
          </div>
          <footer className="mc-foot">
            <button type="button" className="mc-btn" data-testid="machine-change-finish" onClick={onClose}>
              Close
            </button>
          </footer>
        </div>
      </div>,
      document.body,
    );
  }

  const targetLabel = target === null ? null : MACHINE_MOUNT_WORDS[target];
  // A failed check stays on screen until something the machine DID answer (a home, a light) says it
  // is back; otherwise a successful re-home would leave the light line claiming the machine is away.
  const offline = answer?.kind === 'no' && !home.done && !light.done ? answer.detail : null;
  const homeWord =
    home.done
      ? home.meta
      : homing
        ? 'homing — the head is moving'
        : offline !== null
          ? `the machine is not answering at ${address?.host ?? '—'}:${address?.port ?? '—'} — ${offline}`
          : address === null
            ? 'this machine has no address yet — check it in Manage › Machines'
            : answer?.kind === 'ok'
              ? `it reads ${answer.rest.state ?? 'no state'}${answer.rest.homed ? ' · homed' : ''}`
              : 'asking the machine…';
  const lightWord =
    light.done
      ? light.meta
      : lightBusy
        ? 'switching the light on…'
        : offline !== null
          ? 'the machine must answer before its light can be switched'
          : !home.done
            ? 'home the machine first — the light goes on once the head is out of the way'
            : null;

  const body = (
    <div className="mc-backdrop" data-testid="machine-change-backdrop" style={{ zIndex: 'var(--cm-z-modal-raised)' }}>
      <div
        className="mc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="machine-change-title"
        data-testid="machine-change"
      >
        <header className="mc-head">
          <span className="mc-eyebrow">Change the machine</span>
          <h3 id="machine-change-title" data-testid="machine-change-title">
            {target === null ? 'Change the machine' : changeHeadline(shownFrom, target)}
          </h3>
          <button
            type="button"
            className="mc-close"
            aria-label="Close"
            data-testid="machine-change-close"
            disabled={confirming}
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="mc-body">
          {/* 1 · What changes */}
          <Step n={1} title="What changes" state={stateOf(1)}>
            {targetDone ? (
              <span className="mc-meta" data-testid="machine-change-what">
                {MACHINE_MOUNT_WORDS[shownFrom]} → {targetLabel}
                {job !== null ? (
                  <>
                    {' · for '}
                    <b>{job.name}</b>
                    {job.holding !== undefined && job.holding !== '' ? `, ${job.holding}` : ''}
                  </>
                ) : null}
              </span>
            ) : null}
            {shown === 1 ? (
              <div className="mc-choice" data-testid="machine-change-targets">
                <span className="mc-meta">On the machine now: {MACHINE_MOUNT_WORDS[shownFrom]}</span>
                {targetMountsFor(machine, accessories).length === 0 ? (
                  <span className="mc-hint">This house has no other fixture to fit.</span>
                ) : (
                  <span className="mc-btns">
                    {targetMountsFor(machine, accessories).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className="mc-btn"
                        data-testid={`machine-change-target-${m}`}
                        onClick={() => {
                          setTarget(m);
                          setTakenOff(false);
                          setFitted(false);
                          setOffChecks([]);
                          setOnChecks([]);
                          setDatumChoice(null);
                          advance();
                        }}
                      >
                        {MACHINE_MOUNT_WORDS[m]}
                      </button>
                    ))}
                  </span>
                )}
                {targetError !== null ? (
                  <span className="mc-note" data-testid="machine-change-target-error">
                    {targetError}
                  </span>
                ) : null}
              </div>
            ) : null}
          </Step>

          {/* 2 · Make it safe */}
          <Step n={2} title="Make it safe" state={stateOf(2)}>
            {shown !== 2 ? (
              <>
                {home.done ? (
                  <span className="mc-meta" data-testid="machine-change-home-done">
                    Home · <span className="mc-mono">{home.meta}</span>
                  </span>
                ) : null}
                {powerOff ? (
                  <span className="mc-meta" data-testid="machine-change-power-done">
                    Power off at its switch · {poweredOff ? 'switched off ✓' : 'not yet'}
                  </span>
                ) : null}
                {light.done ? (
                  <span className="mc-meta" data-testid="machine-change-light-done">
                    Work light on · <span className="mc-mono">{light.meta}</span>
                  </span>
                ) : null}
                {byHand ? (
                  <span className="mc-meta" data-testid="machine-change-spindle-done">
                    Spindle cold, cutter out · I have checked ✓
                  </span>
                ) : null}
              </>
            ) : (
              <div className="mc-lines">
                <div className="mc-line" data-done={home.done} data-testid="machine-change-home-line">
                  <span className="mc-dot" aria-hidden="true" />
                  <b>Home</b>
                  <span className="mc-meta">{homeWord}</span>
                  {!home.done ? (
                    <button
                      type="button"
                      className="mc-btn"
                      data-testid="machine-change-home"
                      disabled={homing || address === null}
                      onClick={() => void doHome()}
                    >
                      {homing ? 'Homing…' : 'Home'}
                    </button>
                  ) : null}
                  {offline !== null ? (
                    <button
                      type="button"
                      className="mc-btn"
                      data-testid="machine-change-recheck"
                      disabled={checking}
                      onClick={() => void runCheck()}
                    >
                      {checking ? 'Checking…' : 'Check again'}
                    </button>
                  ) : null}
                </div>
                {home.note !== null ? (
                  <p className="mc-note" data-testid="machine-change-home-note">
                    {home.note}
                  </p>
                ) : null}

                {powerOff ? (
                  <div className="mc-line" data-done={poweredOff} data-testid="machine-change-power-line">
                    <span className="mc-dot" aria-hidden="true" />
                    <b>Power off at its switch</b>
                    <span className="mc-meta">
                      {poweredOff
                        ? 'switched off ✓'
                        : 'the fit is done with the machine off — switch it off at its switch'}
                    </span>
                    {!poweredOff ? (
                      <button
                        type="button"
                        className="mc-btn"
                        data-testid="machine-change-powered-off"
                        onClick={() => setPoweredOff(true)}
                      >
                        I have switched it off
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <div className="mc-line" data-done={light.done} data-testid="machine-change-light-line">
                      <span className="mc-dot" aria-hidden="true" />
                      <b>Work light on</b>
                      <span className="mc-meta">{lightWord}</span>
                      {!light.done ? (
                        <button
                          type="button"
                          className="mc-btn"
                          data-testid="machine-change-light"
                          disabled={lightBusy || !home.done || address === null}
                          onClick={() => void doLightOn()}
                        >
                          {lightBusy ? 'Switching…' : 'Work light on'}
                        </button>
                      ) : null}
                    </div>
                    {light.note !== null ? (
                      <p className="mc-note" data-testid="machine-change-light-note">
                        {light.note}
                      </p>
                    ) : null}
                  </>
                )}

                <div className="mc-line" data-done={byHand} data-testid="machine-change-spindle-line">
                  <span className="mc-dot" aria-hidden="true" />
                  <b>Spindle cold, cutter out</b>
                  <span className="mc-meta">{byHand ? 'I have checked ✓' : 'look at the spindle before your hands go in'}</span>
                  {!byHand ? (
                    <button
                      type="button"
                      className="mc-btn"
                      data-testid="machine-change-checked"
                      onClick={() => {
                        setByHand(true);
                        advance();
                      }}
                    >
                      I have checked
                    </button>
                  ) : null}
                </div>
              </div>
            )}
          </Step>

          {/* 3 · Take off */}
          <Step n={3} title={takeWords?.title ?? 'Take off'} state={stateOf(3)}>
            {takeWords === null ? (
              <span className="mc-meta" data-testid="machine-change-take-none">
                nothing is on the pins
              </span>
            ) : shown === 3 ? (
              <div className="mc-checks" data-testid="machine-change-take">
                {takeWords.items.map((item, i) => (
                  <CheckLine
                    key={item}
                    item={item}
                    checked={offChecks[i] === true}
                    testId={`machine-change-take-${i}`}
                    onToggle={() =>
                      setOffChecks((prev) => {
                        const next = [...prev];
                        next[i] = !next[i];
                        return next;
                      })
                    }
                  />
                ))}
                <span className="mc-hint">a picture for each step</span>
                <button
                  type="button"
                  className="mc-btn mc-btn--primary"
                  data-testid="machine-change-take-done"
                  disabled={!takeWords.items.every((_, i) => offChecks[i] === true)}
                  onClick={() => {
                    setTakenOff(true);
                    advance();
                  }}
                >
                  Done
                </button>
              </div>
            ) : (
              <span className="mc-meta">{takeWords.items.join(' · ')}</span>
            )}
          </Step>

          {/* 4 · Fit */}
          <Step n={4} title={fitWords?.title ?? 'Fit'} state={stateOf(4)}>
            {fitWords === null ? (
              <span className="mc-meta" data-testid="machine-change-fit-none">
                the bed is left clear
              </span>
            ) : shown === 4 ? (
              <div className="mc-checks" data-testid="machine-change-fit">
                {fitWords.items.map((item, i) => (
                  <CheckLine
                    key={item}
                    item={item}
                    checked={onChecks[i] === true}
                    testId={`machine-change-fit-${i}`}
                    onToggle={() =>
                      setOnChecks((prev) => {
                        const next = [...prev];
                        next[i] = !next[i];
                        return next;
                      })
                    }
                  />
                ))}
                <span className="mc-hint">a picture for each step</span>
                {datumDesc !== null ? (
                  <div className="mc-datum" data-testid="machine-change-datum">
                    <span className="mc-meta">
                      {datumDesc.word}:{' '}
                      {shippedDatum !== null ? `shipped value (±${refitBandMm()})` : 'not measured on this machine'}
                      {datumChoice !== null ? ' · ' : ''}
                    </span>
                    {datumChoice === null ? (
                      <span className="mc-btns">
                        <button
                          type="button"
                          className="mc-btn"
                          data-testid="machine-change-measure-now"
                          onClick={() => setDatumChoice('measure')}
                        >
                          Measure now
                        </button>
                        <button
                          type="button"
                          className="mc-btn"
                          data-testid="machine-change-use-shipped"
                          disabled={shippedDatum === null}
                          title={
                            shippedDatum === null
                              ? 'No jaw-top reading has been taken on this machine yet — measure one after fitting'
                              : undefined
                          }
                          onClick={() => setDatumChoice('shipped')}
                        >
                          use the shipped value
                        </button>
                      </span>
                    ) : datumChoice === 'shipped' ? (
                      <span className="mc-meta" data-testid="machine-change-datum-shipped">
                        using the shipped value ✓
                      </span>
                    ) : (
                      <span className="mc-meta" data-testid="machine-change-datum-measure">
                        measure it after fitting — fit the probe and register the blank from Cut; the reading is
                        recorded on the bed then
                      </span>
                    )}
                    <details className="mc-fold" data-testid="machine-change-datum-technical">
                      <summary>Technical</summary>
                      <p className="mc-hint">{datumProvenance(datumDesc.key, machine, shippedDatum)}</p>
                    </details>
                  </div>
                ) : null}
                {powerOff ? (
                  <div className="mc-line" data-done={light.done} data-testid="machine-change-light-after-power">
                    <span className="mc-dot" aria-hidden="true" />
                    <b>Work light on</b>
                    <span className="mc-meta">
                      {light.done ? lightWord : 'the power is back — switch the light on before your hands go back in'}
                    </span>
                    {!light.done ? (
                      <button
                        type="button"
                        className="mc-btn"
                        data-testid="machine-change-light-again"
                        disabled={lightBusy || address === null}
                        onClick={() => void doLightOn()}
                      >
                        {lightBusy ? 'Switching…' : 'Work light on'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {light.note !== null && powerOff ? (
                  <p className="mc-note" data-testid="machine-change-light-note">
                    {light.note}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="mc-btn mc-btn--primary"
                  data-testid="machine-change-fit-done"
                  disabled={
                    fitChecking ||
                    !fitWords.items.every((_, i) => onChecks[i] === true) ||
                    !datumResolved ||
                    (powerOff && !light.done)
                  }
                  onClick={() => void doFitDone()}
                >
                  {fitChecking ? 'Waiting for the machine…' : 'Done'}
                </button>
                {fitNote !== null ? (
                  <p className="mc-note" data-testid="machine-change-fit-note">
                    {fitNote}
                  </p>
                ) : null}
              </div>
            ) : (
              <span className="mc-meta">
                {fitWords.items.join(' · ')}
                {datumDesc !== null
                  ? ` · ${datumDesc.word}: ${shippedDatum !== null ? `shipped value (±${refitBandMm()})` : 'not measured'}`
                  : ''}
              </span>
            )}
          </Step>

          {/* 5 · Confirm */}
          <Step n={5} title="Confirm" state={confirmed !== null ? 'done' : shown === 5 ? 'current' : 'later'}>
            {shown === 5 || confirmed !== null ? (
              <div className="mc-confirm" data-testid="machine-change-confirm">
                <span className="mc-meta" data-testid="machine-change-bed-now">
                  the bed is now: {targetLabel ?? '—'}
                  {bedNowWords !== null ? ` · ${bedNowWords}` : ''}
                </span>
                {confirmed === null ? (
                  <>
                    <span className="mc-meta" data-testid="machine-change-record-preview">
                      the machine's record will say: {changeRecordWords(shownFrom, target ?? shownFrom)}
                      {job !== null ? ` · for ${job.name}` : ''}
                    </span>
                    {!safeDone ? (
                      <span className="mc-note" data-testid="machine-change-not-safe">
                        The machine is not safe to put hands in yet: {home.done ? '' : 'home it, '}
                        {powerOff && !poweredOff ? 'switch it off at its switch, ' : ''}
                        {light.done ? '' : 'switch the work light on, '}check the spindle is cold and the cutter is
                        out.
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="mc-btn mc-btn--primary"
                      data-testid="machine-change-confirm-button"
                      disabled={confirming || !safeDone}
                      onClick={() => void confirm()}
                    >
                      {confirming ? 'Writing the change…' : 'Confirm the change'}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="mc-meta" data-testid="machine-change-record">
                      written to the machine's record:{' '}
                      <span className="mc-mono">{formatStamp(confirmed.at) ?? confirmed.at}</span> ·{' '}
                      {changeRecordWords(confirmed.result.from, confirmed.result.to)}
                      {job !== null ? ` · for ${job.name}` : ''}
                    </span>
                    <div className="mc-line" data-done={finalLight.done} data-testid="machine-change-final-light">
                      <span className="mc-dot" aria-hidden="true" />
                      <b>Work light off</b>
                      <span className="mc-meta">
                        {finalLight.done
                          ? <span className="mc-mono">{finalLight.meta}</span>
                          : finalLightBusy
                            ? 'switching the light off…'
                            : 'the light can go off now'}
                      </span>
                      {!finalLight.done ? (
                        <button
                          type="button"
                          className="mc-btn"
                          data-testid="machine-change-light-off"
                          disabled={finalLightBusy || address === null}
                          onClick={() => void doLightOff()}
                        >
                          {finalLightBusy ? 'Switching…' : 'Work light off'}
                        </button>
                      ) : null}
                    </div>
                    {finalLight.note !== null ? (
                      <p className="mc-note" data-testid="machine-change-light-off-note">
                        {finalLight.note}
                      </p>
                    ) : null}
                    <div className="mc-line" data-done={finalHome.done} data-testid="machine-change-final-home">
                      <span className="mc-dot" aria-hidden="true" />
                      <b>Home</b>
                      <span className="mc-meta">
                        {finalHome.done
                          ? <span className="mc-mono">{finalHome.meta}</span>
                          : finalHoming
                            ? 'homing — the head is moving'
                            : 'home it with your hands clear'}
                      </span>
                      {!finalHome.done ? (
                        <button
                          type="button"
                          className="mc-btn"
                          data-testid="machine-change-home-again"
                          disabled={finalHoming || address === null}
                          onClick={() => void doFinalHome()}
                        >
                          {finalHoming ? 'Homing…' : 'Home'}
                        </button>
                      ) : null}
                    </div>
                    {finalHome.note !== null ? (
                      <p className="mc-note" data-testid="machine-change-home-again-note">
                        {finalHome.note}
                      </p>
                    ) : null}
                    {confirmed.refreeze ? (
                      <p className="mc-note" data-testid="machine-change-refreeze">
                        {refreezeSentence(job?.name ?? null, job?.frozenMount ?? null)}
                      </p>
                    ) : null}
                    {confirmed.notes.map((n) => (
                      <p key={n} className="mc-note" data-testid="machine-change-write-note">
                        {n}
                      </p>
                    ))}
                  </>
                )}
                {error !== null ? (
                  <p className="mc-note" data-testid="machine-change-error">
                    {error}
                  </p>
                ) : null}
              </div>
            ) : (
              <span className="mc-meta">
                {targetLabel !== null ? `the bed will be: ${targetLabel}` : null}
              </span>
            )}
          </Step>
        </div>

        <footer className="mc-foot">
          <button
            type="button"
            className="mc-btn"
            data-testid="machine-change-back"
            disabled={shown <= 1 || confirmed !== null || confirming}
            onClick={back}
          >
            ← Back
          </button>
          <button
            type="button"
            className="mc-btn mc-btn--primary"
            data-testid="machine-change-finish"
            disabled={confirmed === null}
            onClick={finish}
          >
            {job !== null ? 'Back to the job' : 'Done'}
          </button>
        </footer>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}

/** The Technical fold's one sentence about the datum the step offers to carry. */
function datumProvenance(
  key: MountDatumKey,
  machine: MachineRecord | null,
  datum: ReturnType<typeof shippedDatumFor>,
): string {
  const word = key === 'viseJawTopZ' ? 'jaw top' : 'rotary axis';
  if (datum === null) {
    return `No ${word} reading has been taken on this machine yet. A datum is measured, never typed; the profile keeps it unmeasured until a probe touch records it, and a job that needs it refuses by name until then.`;
  }
  const from = shippedDatumProfileName(machine, key);
  const when = formatStamp(datum.measuredAt) ?? datum.measuredAt;
  return `The ${word} on this machine: ${Number(datum.value.toFixed(3))} mm, measured ${when} by ${datum.by}, carried from ${from === null ? 'an earlier bed' : `“${from}”`}. ±${refitBandMm()} mm is the band a re-fit is taken to repeat within.`;
}
