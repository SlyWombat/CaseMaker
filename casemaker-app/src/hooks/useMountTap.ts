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
import type { RegistrationSettings } from '@/engine/cnc/registration/settings';
import type { PlanMountTap } from '@/engine/cnc/registration/plan';
import { useMachineTranscriptStore } from '@/store/machineTranscriptStore';
import { createFirstBed, machineAt, saveMachineWithRetry, useLocationStore, type MachineUpdate } from '@/store/locationStore';
import { withBracketSeatDatum, withViseJawTopDatum } from '@/platform/bedProfiles';
import { bracketSeatFromTap } from '@/engine/cnc/mounts/bracket';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { recordProbeReading } from '@/engine/cnc/registration/mountContext';

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

export interface MountTapInputs {
  /** The machine to talk to, or null when there is no live check to drive. */
  target: { host: string; port: number } | null;
  settings: RegistrationSettings;
  /** The work-envelope floor, the lowest Z the touch may reach. */
  floor: number;
  /** The checked-out probe's id, written as the datum's `by`. */
  probeId: string | null;
  /** What the caller says once the mount's reference is recorded. */
  successNote: string;
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
      resolver.current?.(false);
      resolver.current = null;
      if (tokenRef.current !== null) {
        useMountTapGate.getState().end(tokenRef.current);
        tokenRef.current = null;
      }
      void handleRef.current?.close();
      handleRef.current = null;
    };
  }, []);

  const resolve = (ok: boolean): void => resolver.current?.(ok);

  /** A note is a render of a host that may already have gone (Design → Cut mid-tap). */
  const noteNow = (text: string): void => {
    if (alive.current) setNote(text);
  };

  const askOperator = (step: OperatorStep): Promise<boolean> => {
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
    tap: { x: number; y: number; fromMachineZ: number } & Pick<PlanMountTap, 'reference' | 'datumOffsetMm'>,
  ): Promise<void> {
    if (inputs.target === null) return;
    // #637 — a second press (the other host's button, or a double press) must not orphan the first
    // tap's console handle: the shared gate refuses it outright.
    const token = {};
    if (!useMountTapGate.getState().begin(token)) return;
    tokenRef.current = token;
    setNote(null);
    const handle = attachConsole(inputs.target);
    handleRef.current = handle;
    try {
      const r = await runMountTap(
        { x: tap.x, y: tap.y },
        tap.fromMachineZ,
        inputs.settings,
        { console: { send: (line, timing) => handle.send(line, timing) }, operator: askOperator },
        inputs.floor,
        mountKindOf(tap.reference),
      );
      useMachineTranscriptStore.getState().setRegistration(r.transcript.map((t) => `> ${t.line}\n${t.reply}`).join('\n'));
      if (r.ok) {
        const record = machineAt(inputs.target);
        if (record !== null) {
          const now = new Date().toISOString();
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
            const update: MachineUpdate = (current) => withBracketSeatDatum(bed(current), { z: seat, at: r.at }, inputs.probeId, now);
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
              note: 'tapped on the bracket’s front arm',
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
            const update: MachineUpdate = (current) => withViseJawTopDatum(bed(current), { z: r.z, at: r.at }, inputs.probeId, now);
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
        noteNow(inputs.successNote);
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

  return { tapJaw, note, prompt, resolve };
}
