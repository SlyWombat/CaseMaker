/**
 * The mount tap (#599), shared between the Setups row and the machine card's Bed block (#603).
 *
 * One implementation runs the tap, prompts the operator to fit the probe, writes the transcript,
 * and records the measured jaw top back into the machine's bed profile — so both callers get the
 * same fit-probe prompt, the same transcript, and the same write-back, never two copies that drift.
 */

import { useRef, useState } from 'react';
import { attachConsole } from '@/platform/machineConsole';
import { runMountTap, type OperatorStep } from '@/engine/cnc/registration';
import type { RegistrationSettings } from '@/engine/cnc/registration/settings';
import type { PlanMountTap } from '@/engine/cnc/registration/plan';
import { useMachineTranscriptStore } from '@/store/machineTranscriptStore';
import { createFirstBed, machineAt, saveMachineWithRetry, useLocationStore } from '@/store/locationStore';
import { withBracketSeatDatum, withViseJawTopDatum } from '@/platform/bedProfiles';
import { bracketSeatFromTap } from '@/engine/cnc/mounts/bracket';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { recordProbeReading } from '@/engine/cnc/registration/mountContext';

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

  const resolve = (ok: boolean): void => resolver.current?.(ok);

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
    setNote(null);
    const handle = attachConsole(inputs.target);
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
          const withBed = await createFirstBed(record, null, now);
          if (tap.reference === 'bracket-seat') {
            // #607 — the reading is the bracket's top; the datum is the seat one height below. The
            // shop default is what the compiler reads, so the tap moves it too (or says it could not).
            const seat = bracketSeatFromTap(r.z, tap.datumOffsetMm ?? 0);
            // #636 — the write's answer is read: a stale guard retries once against the re-read, and
            // a record that did not land is never reported as one that did.
            const outcome = await saveMachineWithRetry(withBracketSeatDatum(withBed, { z: seat, at: r.at }, inputs.probeId, now));
            if (outcome !== 'ok') {
              setNote(
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
              setNote(
                `the bracket seat was tapped, but the shop default was not saved: ${useShopDefaultsStore.getState().reason ?? 'the write was refused'}`,
              );
              // The machine save above still stands; report the partial result and return.
              await recordProbeReading(record, r.probe);
              return;
            }
          } else {
            const outcome = await saveMachineWithRetry(withViseJawTopDatum(withBed, { z: r.z, at: r.at }, inputs.probeId, now));
            if (outcome !== 'ok') {
              setNote(
                `the jaw top was tapped, but the machine record was not saved: ${useLocationStore.getState().writeNote ?? 'the service refused the write'}. Run the tap again to write it.`,
              );
              await recordProbeReading(record, r.probe);
              return;
            }
          }
          // #601 — the probe's last M491 length and M119 rest ride on the checked-out probe accessory.
          await recordProbeReading(record, r.probe);
        }
        setNote(inputs.successNote);
      } else {
        setNote(r.reason);
      }
    } finally {
      await handle.close();
    }
  }

  return { tapJaw, note, prompt, resolve };
}
