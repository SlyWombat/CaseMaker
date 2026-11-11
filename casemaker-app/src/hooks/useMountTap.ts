/**
 * The mount tap (#599), shared between the Setups row and the machine card's Bed block (#603).
 *
 * One implementation runs the tap, prompts the operator to fit the probe, writes the transcript,
 * and records the measured jaw top back into the machine's bed profile — so both callers get the
 * same fit-probe prompt, the same transcript, and the same write-back, never two copies that drift.
 */

import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { attachConsole, type ConsoleHandle } from '@/platform/machineConsole';
import { runMountTap, type OperatorStep } from '@/engine/cnc/registration';
import { runFaceAngle, runRotaryTap } from '@/engine/cnc/registration/execute';
import { planFaceAngle, type FaceAngleInputs } from '@/engine/cnc/registration/faceAngle';
import { planRotaryTrial } from '@/engine/cnc/registration/rotaryTap';
import { rotarySearchMm, rotaryTapPoint } from '@/engine/cnc/mounts/rotary';
import type { RegistrationSettings } from '@/engine/cnc/registration/settings';
import type { PlanMountTap } from '@/engine/cnc/registration/plan';
import { useMachineTranscriptStore } from '@/store/machineTranscriptStore';
import { createFirstBed, machineAt, saveMachineWithRetry, useLocationStore, type MachineUpdate } from '@/store/locationStore';
import { withBracketSeatDatum, withRotaryAxisDatum, withRotaryFaceAngleDatum, withViseJawTopDatum } from '@/platform/bedProfiles';
import { bracketSeatFromTap } from '@/engine/cnc/mounts/bracket';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { recordMountReading, recordProbeReading } from '@/engine/cnc/registration/mountContext';
import { SEAT_DERIVED } from '@/engine/cnc/registration/footprintJob';
// #1202 — a completed tap records its routine identity on the machine, so a later press can say
// whether this exact motion has run here before.
import { routineIdentityOf, type MotionRoutineId, type NamedHeights } from '@/engine/cnc/registration/routineIdentity';
import { buildStamp, withRoutineCompletion } from '@/platform/routineRecord';

/**
 * #637 — ONE TAP AT A TIME, ACROSS HOSTS. The hook is used by the Setups row and by the machine
 * card's Bed block at the same time; two presses would overwrite the pending operator prompt's
 * resolver, and the first tap's promise — and its console handle — would never be released. A
 * module-level gate both hosts read, so pressing either button disables both.
 *
 * The gate holds a TOKEN, not a boolean: only the press that took it may release it. A tap whose
 * host unmounts mid-run releases its own token in the cleanup, and its detached promise's `finally`
 * then finds a newer tap's token and leaves it alone — a stale release cannot re-enable the other
 * host's button under a running tap.
 */
interface MountTapGate {
  owner: object | null;
  /** Take the gate for `token`; false when a tap already holds it. */
  begin: (token: object) => boolean;
  /** Release the gate — no-op unless `token` still holds it. */
  end: (token: object) => void;
}

const useMountTapGate = create<MountTapGate>()((set, get) => ({
  owner: null,
  begin: (token) => {
    if (get().owner !== null) return false;
    set({ owner: token });
    return true;
  },
  end: (token) => {
    if (get().owner === token) set({ owner: null });
  },
}));

/** #637 — is a mount tap running anywhere in this window? Hosts disable their buttons on it. */
export function useMountTapBusyFlag(): boolean {
  // A boolean selector: stable by value, so `useSyncExternalStore` sees no change on unrelated sets.
  return useMountTapGate((s) => s.owner !== null);
}

/** #607 — the mount kind a reference belongs to, in `runMountTap`'s own words. */
function mountKindOf(reference: PlanMountTap['reference']): 'vise' | 'bracket' {
  return reference === 'bracket-seat' ? 'bracket' : 'vise';
}

/**
 * #607 — what the rotary tap needs to place its touches. The nominal axis only puts the chord pair
 * and the crown where the chuck is expected; the reading is the datum.
 */
export interface RotaryAxisTapRequest {
  /** The tap point's X along the chuck, machine X (the module's mid-length). */
  atX: number;
  /** The nominal axis Z, the axis-line Y and the body radius — the placement, never the reading. */
  nominal: { axisZ: number; axisY: number; radiusMm: number };
  /** The bed's clearance, machine Z (surface top + a probe body's margin); the trial refuses under it. */
  bedClearanceZ: number;
  /** The machine's travel height, machine Z. */
  seekFromMachineZ: number;
  /** The crown is accepted down to this height, machine Z. */
  crownBand: { min: number; max: number };
}

/**
 * #1059 — what the face-angle step needs: everything `planFaceAngle` takes (the axis datum, the
 * stock's section and free span, the machine's clearance and soft limits) plus the touches' feed.
 * The hook plans it, refuses in words when it does not hold, and writes the datum on success.
 */
export interface RotaryFaceAngleTapRequest {
  inputs: FaceAngleInputs;
  /** The touches' probe feed, mm/min (the registration settings' own). */
  touchFeed: number;
}

/** #1059 — the face-angle step's reading, shown beside the control that ran it. */
export interface RotaryFaceAngleReport {
  /** The signed total A turn, degrees. */
  thetaDeg: number;
  /** The last pair's |Z+ − Z−|, mm. */
  residualMm: number;
  /** How many touch pairs it took (1 = level as found). */
  passes: number;
}

/** #607 — the rotary tap's reading, shown beside the control that ran it. */
export interface RotaryAxisReport {
  axisZ: number;
  axisY: number;
  radiusMm: number;
  residualMm: number;
  /** The check chord's one-line note over the tolerance, else null. */
  residualLine: string | null;
}

export interface MountTapInputs {
  /** The machine to talk to, or null when there is no live check to drive. */
  target: { host: string; port: number } | null;
  settings: RegistrationSettings;
  /** The work-envelope floor, the lowest Z the touch may reach. */
  floor: number;
  /** The checked-out probe's id, written as the datum's `by`. */
  probeId: string | null;
  /**
   * #1199 — the machine's own travel height, machine Z (`toolChange.clearanceZ`): the height the
   * XY move to the tap point is taken at. The tap's `fromMachineZ` is a DESCENT height and is never
   * used for the traverse; a tap with no clearance refuses before the wire.
   */
  clearanceZ: number;
  /** What the caller says once the mount's reference is recorded. */
  successNote: string;
  /**
   * #1189 bench blocker — THE CALLER'S STEP-1 STATEMENT ALREADY ANSWERS THE FIT-PROBE ASK. The
   * registration executor takes that answer (`operator: step.kind === 'fit-probe' ? true : ask`);
   * the seat tap runs in the same card off the same statement, so it must take it too, and press
   * straight into motion rather than wait on a prompt the Register card used not to draw.
   */
  probeFitted?: boolean;
}

export interface MountTapApi {
  /**
   * Run the tap at `tap` (machine XY) and write the reading back. No-op with no target.
   *
   * #607 — `reference`/`datumOffsetMm` say which mount datum the reading becomes (absent means the
   * vise's jaw top, which is what every pre-#607 caller passes); the bracket takes its seat one
   * bracket height below the reading.
   */
  tapJaw: (tap: { x: number; y: number; fromMachineZ: number } & Pick<PlanMountTap, 'reference' | 'datumOffsetMm'>) => Promise<void>;
  /**
   * #607 — the rotary module's reference tap: one chord on the chuck body, the crown, a check
   * chord; the fitted axis (Z, Y and R) is written to the bed profile's `rotaryAxis` datum.
   */
  tapAxis: (req: RotaryAxisTapRequest) => Promise<void>;
  /**
   * #1059 — the face-angle step: two touches either side of the axis, the levelling turn, and the
   * A work zero written to the bed profile's `rotaryFaceAngle` datum.
   */
  tapFaceAngle: (req: RotaryFaceAngleTapRequest) => Promise<void>;
  /** #1059 — the last face-angle reading, or null before one has run this session. */
  faceAngle: RotaryFaceAngleReport | null;
  /** #607 — the last axis reading, or null before one has run this session. */
  axis: RotaryAxisReport | null;
  /** The last outcome, shown beside the caller's control. */
  note: string | null;
  /** The fit-probe prompt awaiting a Continue/Cancel, or null. */
  prompt: OperatorStep | null;
  /** Answer the pending prompt (Continue = true). */
  resolve: (ok: boolean) => void;
}

export function useMountTap(inputs: MountTapInputs): MountTapApi {
  const [note, setNote] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<OperatorStep | null>(null);
  const [axis, setAxis] = useState<RotaryAxisReport | null>(null);
  const [faceAngle, setFaceAngle] = useState<RotaryFaceAngleReport | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const handleRef = useRef<ConsoleHandle | null>(null);
  /** The gate token this instance's tap holds, or null when it is not running one. */
  const tokenRef = useRef<object | null>(null);
  const alive = useRef(true);

  // #637 — UNMOUNT CANCELS AND CLOSES. Switching Design → Cut while the fit-probe prompt is pending
  // used to leave the promise hanging and the console attachment open, with setState firing on an
  // unmounted component (the registration step has had this cleanup since #495).
  //
  // The effect body re-arms `alive`: React's dev-mode StrictMode runs this cleanup once on mount,
  // and a flag that stayed false would swallow every note in a dev build (`machineConsole.ts` keeps
  // its handle alive for the same reason).
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // #653 — CANCEL ONLY A PENDING PROMPT. Answering No is the runner's own stop path: it homes
      // and closes as it unwinds. Mid-motion there is no prompt to answer — the machine may be
      // between a touch and its closing `$H`, and closing the console here does not stop the move
      // (a later line reopens the session), it only leaves the run to finish under a host that has
      // gone. With nothing pending, `tapJaw` keeps the console and finishes: its `finally` closes
      // the handle and releases the gate.
      const answer = resolver.current;
      if (answer !== null) {
        resolver.current = null;
        answer(false);
      }
    };
  }, []);

  const resolve = (ok: boolean): void => resolver.current?.(ok);

  /**
   * #1202 — THE ROUTINE COMPLETED: record its identity on the machine BEFORE any datum write that
   * may fail. What is recorded is the MOTION ("this sequence finished without a stop"), which is
   * true even when a later save is refused; a failed record write is silent here — the next press
   * simply marks the routine again, which is the safe direction.
   */
  function recordRoutine(routine: MotionRoutineId, lines: readonly string[], heights: NamedHeights): void {
    if (inputs.target === null) return;
    const machine = machineAt(inputs.target);
    if (machine === null) return;
    const identity = routineIdentityOf(routine, lines, heights);
    void saveMachineWithRetry(machine, (current) =>
      withRoutineCompletion(current, {
        routine: identity.routine,
        shape: identity.shape,
        at: new Date().toISOString(),
        build: buildStamp(),
      }),
    );
  }

  /** A note is a render of a host that may already have gone (Design → Cut mid-tap). */
  const noteNow = (text: string): void => {
    if (alive.current) setNote(text);
  };

  const askOperator = (step: OperatorStep): Promise<boolean> => {
    // #1189 — the caller's step-1 statement answers this one, exactly as for the executor.
    if (step.kind === 'fit-probe' && inputs.probeFitted === true) return Promise.resolve(true);
    setPrompt(step);
    return new Promise<boolean>((resolve) => {
      resolver.current = (ok) => {
        resolver.current = null;
        setPrompt(null);
        resolve(ok);
      };
    });
  };

  async function tapJaw(
    tap: { x: number; y: number; fromMachineZ: number } & Pick<PlanMountTap, 'reference' | 'datumOffsetMm'> & {
        /** #1070 — the plan's own seek bound (the seat press): never search past it. */
        planTravelMm?: number | null;
      },
  ): Promise<void> {
    if (inputs.target === null) return;
    // #637 — a second press (the other host's button, or a double press) must not orphan the first
    // tap's console handle: the shared gate refuses it outright.
    const token = {};
    if (!useMountTapGate.getState().begin(token)) {
      // #1189 — a press swallowed by another tap's gate says so, where the press was made.
      noteNow('a seat measurement is already running');
      return;
    }
    tokenRef.current = token;
    setNote(null);
    const handle = attachConsole(inputs.target);
    handleRef.current = handle;
    try {
      const r = await runMountTap(
        // #1199 — the tap's own approach rides with the point; the session's height is the
        // machine's clearance, so the XY move to the seat is taken there and the descent at it.
        { x: tap.x, y: tap.y, fromMachineZ: tap.fromMachineZ },
        inputs.clearanceZ,
        inputs.settings,
        { console: { send: (line, timing) => handle.send(line, timing) }, operator: askOperator },
        inputs.floor,
        mountKindOf(tap.reference),
        // #1070 — the probe is stated (null here: the hook's caller carries no instrument object;
        // the executor releases a triggered tap whatever the instrument), and the seat press's
        // own bound rides last: a never-triggering tap stops at the band's floor less the scan
        // reach, not at the machine's work-envelope floor.
        null,
        tap.planTravelMm ?? null,
      );
      useMachineTranscriptStore.getState().setRegistration(r.transcript.map((t) => `> ${t.line}\n${t.reply}`).join('\n'));
      if (r.ok) {
        // #1202 — the tap's motion is a completed routine on this machine: the seat press and the
        // jaw/arm taps are distinct routines, and the identity is the line sequence it SENT.
        const seatRoutine = tap.reference === 'bracket-seat' && (tap.datumOffsetMm ?? 0) === 0;
        recordRoutine(seatRoutine ? 'seat-press' : 'mount-tap', r.transcript.map((t) => t.line), {
          clearance: inputs.clearanceZ,
          ...(Number.isFinite(tap.fromMachineZ) ? { approach: tap.fromMachineZ } : {}),
          ...(tap.planTravelMm !== undefined && tap.planTravelMm !== null && tap.planTravelMm > 0
            ? { seek: -tap.planTravelMm }
            : {}),
        });
        const record = machineAt(inputs.target);
        if (record !== null) {
          const now = new Date().toISOString();
          // #595 — the tap's reading lands on the mount's OWN record as well: the unit's record is
          // the one the planner prefers (`mountDatumFor`), and a measurement that happened must not
          // depend on the bed write below succeeding.
          // #1070, 6b's amendment — THE SEAT PRESS NEVER WRITES THE UNIT'S bracketTopZ. That key is
          // the arm's TOP (15.05 mm above the seat); the seat press reads the WASTEBOARD, so with
          // no offset the reading IS the seat and belongs to the bed profile alone. (An arm-top
          // tap — offset stated — still records the unit reading one height down, as #607 built it.)
          if (!(tap.reference === 'bracket-seat' && (tap.datumOffsetMm ?? 0) === 0)) {
            await recordMountReading(
              record,
              tap.reference === 'bracket-seat' ? 'bracket' : 'vise',
              { z: r.z, at: r.at },
              inputs.probeId,
              // #1189 — the seating this reading was taken in, for a later refit's correction.
              r.probe.lengthZ,
            );
          }
          // #613 — a no-profile machine gets its first bed here; the datum then lands as designed.
          // #650 — the bed and the datum are an update folded onto the record the service holds; a
          // stale guard re-applies them to the re-read record rather than re-sending this window's
          // pre-read copy over another writer's change.
          const bed = await createFirstBed(record, null, now);
          if (tap.reference === 'bracket-seat') {
            // #607 — the reading is the bracket's top; the datum is the seat one height below. The
            // shop default is what the compiler reads, so the tap moves it too (or says it could not).
            const seat = bracketSeatFromTap(r.z, tap.datumOffsetMm ?? 0);
            // #636 — the write's answer is read: a stale guard retries once against the re-read, and
            // a record that did not land is never reported as one that did.
            const update: MachineUpdate = (current) =>
              withBracketSeatDatum(bed(current), { z: seat, at: r.at }, inputs.probeId, now, r.probe.lengthZ);
            const outcome = await saveMachineWithRetry(record, update);
            if (outcome !== 'ok') {
              noteNow(
                `the seat was tapped, but the machine record was not saved: ${useLocationStore.getState().writeNote ?? 'the service refused the write'}. Run the tap again to write it.`,
              );
              await recordProbeReading(record, r.probe);
              return;
            }
            const saved = await useShopDefaultsStore.getState().set('bracket.seatMachineZ', {
              value: seat,
              source: 'measured',
              setAt: now,
              unit: 'mm',
              note: 'the seat: tapped on the wasteboard beside the bracket’s front arm',
            });
            if (!saved) {
              noteNow(
                `the bracket seat was tapped, but the shop default was not saved: ${useShopDefaultsStore.getState().reason ?? 'the write was refused'}`,
              );
              // The machine save above still stands; report the partial result and return.
              await recordProbeReading(record, r.probe);
              return;
            }
          } else {
            const update: MachineUpdate = (current) =>
              withViseJawTopDatum(bed(current), { z: r.z, at: r.at }, inputs.probeId, now, r.probe.lengthZ);
            const outcome = await saveMachineWithRetry(record, update);
            if (outcome !== 'ok') {
              noteNow(
                `the jaw top was tapped, but the machine record was not saved: ${useLocationStore.getState().writeNote ?? 'the service refused the write'}. Run the tap again to write it.`,
              );
              await recordProbeReading(record, r.probe);
              return;
            }
          }
          // #601 — the probe's last M491 length and M119 rest ride on the checked-out probe accessory.
          await recordProbeReading(record, r.probe);
        }
        // #1070, 6b's amendment — the SEAT press's note carries the reading against the derived
        // band: the operator sees the number that is now stored, not just that something was.
        if (tap.reference === 'bracket-seat' && (tap.datumOffsetMm ?? 0) === 0) {
          const offset = Math.round((r.z - SEAT_DERIVED.machineZ) * 1000) / 1000;
          const where = offset === 0 ? 'the derived value' : `${Math.abs(offset).toFixed(2)} mm ${offset > 0 ? 'above' : 'below'} the derived ${SEAT_DERIVED.machineZ}`;
          noteNow(`the bracket seat is recorded at machine Z ${r.z} (${where}) — plan the registration again`);
        } else {
          noteNow(inputs.successNote);
        }
      } else {
        noteNow(r.reason);
      }
    } finally {
      tokenRef.current = null;
      handleRef.current = null;
      useMountTapGate.getState().end(token);
      await handle.close();
    }
  }

  /**
   * #607 — THE ROTARY BRANCH: the 4th-axis module's reference tap through the same gate, prompt and
   * transcript as the jaw taps. The trial's height is planned from the nominal radius against the
   * bed clearance (refused by name when the sound band cannot clear the bed); the reading — axis Z,
   * axis Y, radius — is what lands in `rotaryAxis`, with the check chord's residual said beside it.
   */
  async function tapAxis(req: RotaryAxisTapRequest): Promise<void> {
    if (inputs.target === null) return;
    const token = {};
    if (!useMountTapGate.getState().begin(token)) return;
    tokenRef.current = token;
    setNote(null);
    setAxis(null);
    const handle = attachConsole(inputs.target);
    handleRef.current = handle;
    try {
      const trial = planRotaryTrial({ axisZ: req.nominal.axisZ, radiusMm: req.nominal.radiusMm }, req.bedClearanceZ);
      if (!trial.ok) {
        noteNow(trial.reason);
        return;
      }
      const record: { axisY: number; nominalRadiusMm: number } = {
        axisY: req.nominal.axisY,
        nominalRadiusMm: req.nominal.radiusMm,
      };
      const r = await runRotaryTap(
        {
          at: rotaryTapPoint(record, req.atX),
          trial: { z1: trial.z1, z2: trial.z2 },
          crownEstimateZ: trial.crownEstimateZ,
          crownBandMm: req.crownBand,
          probeRadiusMm: inputs.settings.tipRadiusMm,
          searchMm: rotarySearchMm(record),
          seekFromMachineZ: req.seekFromMachineZ,
          touchFeed: inputs.settings.touchFeed,
          surfaceFeed: inputs.settings.surfaceSlowFeed,
          parkAboveSurfaceMm: inputs.settings.parkAboveSurfaceMm,
        },
        { console: { send: (line, timing) => handle.send(line, timing) }, operator: askOperator },
      );
      useMachineTranscriptStore.getState().setRegistration(r.transcript.map((t) => `> ${t.line}\n${t.reply}`).join('\n'));
      if (!r.ok) {
        noteNow(r.reason);
        return;
      }
      // #1202 — the rotary tap completed on this machine.
      recordRoutine('rotary-tap', r.transcript.map((t) => t.line), {
        ...(Number.isFinite(req.seekFromMachineZ) ? { clearance: req.seekFromMachineZ } : {}),
      });
      // The measurement stands on its own; the record write is reported separately.
      setAxis({
        axisZ: r.circle.axisZ,
        axisY: r.circle.axisY,
        radiusMm: r.circle.radiusMm,
        residualMm: r.residualMm,
        residualLine: r.residualLine,
      });
      const held = machineAt(inputs.target);
      if (held !== null) {
        const now = new Date().toISOString();
        const bed = await createFirstBed(held, null, now);
        const update: MachineUpdate = (current) =>
          withRotaryAxisDatum(
            bed(current),
            { axisZ: r.circle.axisZ, axisY: r.circle.axisY, radiusMm: r.circle.radiusMm, atX: req.atX },
            inputs.probeId,
            now,
            // #1189 — the seating this tap was taken in (runRotaryTap returns the run's M491).
            r.probeRefZ,
          );
        const outcome = await saveMachineWithRetry(held, update);
        if (outcome !== 'ok') {
          noteNow(
            `the axis was tapped, but the machine record was not saved: ${useLocationStore.getState().writeNote ?? 'the service refused the write'}. Run the tap again to write it.`,
          );
          return;
        }
      }
      noteNow('the axis is recorded');
    } finally {
      tokenRef.current = null;
      handleRef.current = null;
      useMountTapGate.getState().end(token);
      await handle.close();
    }
  }

  /**
   * #1059 — THE FACE-ANGLE STEP. The plan is built here, so a refusal is one sentence in the same
   * note every other tap uses; the run is the executor's; on success the levelled A is written to
   * the bed profile beside the axis datum it depends on.
   */
  async function tapFaceAngle(req: RotaryFaceAngleTapRequest): Promise<void> {
    if (inputs.target === null) return;
    const token = {};
    if (!useMountTapGate.getState().begin(token)) return;
    tokenRef.current = token;
    setNote(null);
    setFaceAngle(null);
    const handle = attachConsole(inputs.target);
    handleRef.current = handle;
    try {
      const planned = planFaceAngle(req.inputs);
      if (!planned.ok) {
        noteNow(planned.reason);
        return;
      }
      const r = await runFaceAngle(
        { plan: planned, touchFeed: req.touchFeed },
        { console: { send: (line, timing) => handle.send(line, timing) }, operator: askOperator },
      );
      useMachineTranscriptStore.getState().setRegistration(r.transcript.map((t) => `> ${t.line}\n${t.reply}`).join('\n'));
      if (!r.ok) {
        noteNow(r.reason);
        return;
      }
      // #1202 — the face-angle step completed on this machine.
      recordRoutine('face-angle', r.transcript.map((t) => t.line), {});
      setFaceAngle({ thetaDeg: r.thetaDeg, residualMm: r.residualMm, passes: r.readings.length });
      const held = machineAt(inputs.target);
      if (held !== null) {
        const now = new Date().toISOString();
        const bed = await createFirstBed(held, null, now);
        const update: MachineUpdate = (current) =>
          withRotaryFaceAngleDatum(
            bed(current),
            { aOffsetDeg: r.thetaDeg, atX: planned.x, axisY: (planned.yPlus + planned.yMinus) / 2, residualMm: r.residualMm },
            inputs.probeId,
            now,
          );
        const outcome = await saveMachineWithRetry(held, update);
        if (outcome !== 'ok') {
          noteNow(
            `the face was levelled, but the machine record was not saved: ${useLocationStore.getState().writeNote ?? 'the service refused the write'}. Run the step again to write it.`,
          );
          return;
        }
      }
      noteNow('the face angle is recorded');
    } finally {
      tokenRef.current = null;
      handleRef.current = null;
      useMountTapGate.getState().end(token);
      await handle.close();
    }
  }

  return { tapJaw, tapAxis, tapFaceAngle, axis, faceAngle, note, prompt, resolve };
}
