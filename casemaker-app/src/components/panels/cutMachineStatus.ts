/**
 * #1170 — the machine's state in the Cut cards' headers, in one place: the vacuum span, the rest,
 * the controller state, and what this app last sent for the work light (#648: a light has no
 * read-back, so "light on" is only ever what this app sent on this connection).
 *
 * The words are facts the operator needs beside the step: a blank turned without a homed head is
 * not a flip anybody should confirm. Nothing here claims a state the machine did not say.
 */
import { readStatusLine } from '@/platform/desktop/protocol';
import { readMachineRest } from '@/platform/machineChangeRun';
import { stateWord } from '@/components/viewport/machineWords';
import type { MachineObservation } from '@/platform/machineProbe';
import type { MachineHeartbeat } from '@/store/machineStore';

export interface CutMachineLineInput {
  machine: MachineObservation | null;
  heartbeat: MachineHeartbeat;
  light: boolean | null;
  /** The release's vacuum span, when the card is about a cut; absent on the flip card. */
  vacuum?: 'on' | 'off' | 'unknown' | null;
}

export function cutMachineLine(input: CutMachineLineInput): string {
  const machine = input.machine;
  const statusLine =
    machine?.statusLine ?? (machine?.status == null ? null : readStatusLine(machine.status));
  const homed = readMachineRest(machine?.status ?? null)?.homed === true;
  const state =
    statusLine?.state === undefined ? null : stateWord(statusLine.state, false, input.heartbeat.reachable);
  return [
    input.vacuum === 'on' ? 'vacuum on' : input.vacuum === 'off' ? 'vacuum off' : null,
    homed ? 'homed' : null,
    state === null ? null : state.toLowerCase(),
    input.light === true ? 'light on' : null,
  ]
    .filter((word): word is string => word !== null)
    .join(' · ');
}
