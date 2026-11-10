/**
 * #1170 — ARRIVING AT THE FLIP: the head is homed first, then the work light goes on (M821).
 *
 * The mockup's flip card says `machine homed · idle · light on`, and the design field is explicit:
 * "The work light goes on when this card appears (M821) and the head is homed first." The order is
 * the point — a light switched on for a head that is not home illuminates a machine that is about
 * to move from an unknown place. A refused home (an alarm, a machine that did not answer) sends no
 * light at all; the card still shows, and its header tells the operator what the machine said.
 *
 * The IO is injected so the order and the refusal are testable without a controller; the app's own
 * implementation is {@link machineFlipArrival}.
 */
import { homeMachine, readMachineRest } from '@/platform/machineChangeRun';
import { toggleLight } from '@/platform/machineLight';
import { useMachineStore } from '@/store/machineStore';

export interface FlipArrivalIO {
  /** Whether the last observation says the head is at the homed rest; null when nothing says. */
  isHomed: () => boolean | null;
  home: (target: { host: string; port: number }) => Promise<{ kind: string }>;
  lightOn: (target: { host: string; port: number }) => Promise<{ kind: string }>;
}

export type FlipArrivalResult = 'light-on' | 'home-failed' | 'light-failed';

/** Home if needed, THEN light the work. A failed home stops before the light. */
export async function prepareFlipArrival(
  target: { host: string; port: number },
  io: FlipArrivalIO,
): Promise<FlipArrivalResult> {
  if (io.isHomed() !== true) {
    const home = await io.home(target);
    if (home.kind !== 'homed') return 'home-failed';
  }
  const light = await io.lightOn(target);
  return light.kind === 'toggled' ? 'light-on' : 'light-failed';
}

/** The app's own arrival: the remembered machine's rest, the guarded home, and the M821 light. */
export function machineFlipArrival(): FlipArrivalIO {
  return {
    isHomed: () => readMachineRest(useMachineStore.getState().machine?.status ?? null)?.homed === true,
    home: (target) => homeMachine(target),
    lightOn: (target) => toggleLight(target, true),
  };
}
