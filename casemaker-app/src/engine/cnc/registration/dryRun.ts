/**
 * #1202 + #1199 item 3 — WHAT WILL BE SENT, BEFORE THE PRESS.
 *
 * The 2026-11-10 seat press bent a probe with a sequence nobody had seen: the app built its lines
 * as it went, and the card showed coordinates, not the order of the moves. This runs the SAME
 * executor the press runs against a RECORDING console — no socket, no machine — so the card can
 * show the full line sequence first. Every recorded line is handed to the motion-order guard's
 * `check()`/`commit()` (`motionOrder.ts`, #1199), the same pair that guards the wire: a sequence the
 * guard would refuse is shown line by line WITH its refusal, and the card must not let it start.
 *
 * THE REPLIES ARE SCRIPTED so the executor walks its normal branches (an Idle poll, a good M491, a
 * touched probe); they are the fake console's own reply shapes. A dry run is therefore the plan's
 * behaviour under a machine that answers well — which is exactly the run whose lines the operator
 * needs to see. Nothing here can reach a machine: `send` only records.
 */

import { motionOrderGuard } from './motionOrder';
import { routineIdentityOf, type MotionRoutineId, type NamedHeights, type RoutineIdentity } from './routineIdentity';
import {
  runFlipRegistration,
  runMountTap,
  runRegistration,
  type ExecDeps,
  type FlipRunResult,
  type MountTapResult,
  type RunResult,
} from './execute';
import type { FlipRegistrationPlan } from './plan';
import type { ConsoleSendResult } from '@/platform/machineConsole';
import type { RegistrationPlan } from './plan';
import type { RegistrationSettings } from './settings';

/** The machine's own idle line, as the scripts' status polls answer it. */
export const DRY_STATUS = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';
/** The tool-length reading the fake console gives M491: a touched PRB at machine Z −80. */
export const DRY_M491 = '[PRB:0,0,-80.000:1]\r\nok';

/** One recorded line and the guard's verdict on it. */
export interface DryLine {
  line: string;
  /** The guard's refusal sentence, or null when this line would go out. */
  refused: string | null;
}

/** A routine's dry run: the lines it would send, what the guard says, and its identity. */
export interface DryRoutine {
  lines: DryLine[];
  /** The routine's identity from this exact list (so a recorded completion matches the shown one). */
  identity: RoutineIdentity;
  /** True when at least one line would be refused — the card must not start the press. */
  refused: boolean;
  /** Why the routine could not complete under the scripted machine, or null. */
  error: string | null;
}

/** The recording console: it answers like a well-behaved machine and never opens a socket. */
export function recordingConsole(): {
  send: (line: string, timing?: Partial<unknown>) => Promise<ConsoleSendResult>;
  lines: string[];
} {
  const lines: string[] = [];
  return {
    lines,
    async send(line: string): Promise<ConsoleSendResult> {
      lines.push(line);
      return { kind: 'sent', line, text: dryReply(line), frames: 1, elapsedMs: 0 };
    },
  };
}

/**
 * The scripted reply for one line. Shapes copied from the fake console (#816), which every probing
 * e2e runs against: a `?` is Idle, M119 is open, M491 is a touched reading, and a `G38.3` reports
 * the trigger at half its travel so the executor records a reading and carries on.
 */
export function dryReply(line: string): string {
  const text = line.trim();
  if (text === '?') return DRY_STATUS;
  if (text === 'M119') return 'X_max:0 Y_max:0 Z_max:0 Probe: 0';
  if (text === 'M491') return DRY_M491;
  const probe = /^G38\.3\s+([XYZ])(-?[\d.]+)/.exec(text);
  if (probe !== null) {
    const axis = probe[1]!;
    const at = (Number(probe[2]!) / 2).toFixed(3);
    const x = axis === 'X' ? at : '0.000';
    const y = axis === 'Y' ? at : '0.000';
    const z = axis === 'Z' ? at : '-80.000';
    return `[PRB:${x},${y},${z}:1]\r\nok`;
  }
  return 'ok';
}

/** Walk a recorded line list through the guard in send order — the SHOWN verdict. */
export function reviewLines(lines: readonly string[], clearanceZ: number): DryLine[] {
  const guard = motionOrderGuard(clearanceZ);
  return lines.map((line) => ({ line, refused: guard.observe(line, dryReply(line)) }));
}

/** The heights a registration plan names, for the identity: machine Z (or the seek travel). */
export function registrationHeights(plan: RegistrationPlan, clearanceZ: number): NamedHeights {
  const heights: Record<string, number> = { clearance: clearanceZ };
  if (Number.isFinite(plan.seek.fromMachineZ)) heights['seek-start'] = plan.seek.fromMachineZ;
  if (Number.isFinite(plan.seek.travelMm) && plan.seek.travelMm > 0) heights.seek = -plan.seek.travelMm;
  if (plan.mountTap !== null && Number.isFinite(plan.mountTap.fromMachineZ)) heights.approach = plan.mountTap.fromMachineZ;
  return heights;
}

function depsFor(console_: ReturnType<typeof recordingConsole>, liveClearanceZ: number): ExecDeps {
  return {
    console: { send: (line, timing) => console_.send(line, timing) },
    // The operator is not asked in a dry run: every prompt is answered as the press would with a
    // person at the machine who proceeds.
    operator: () => Promise.resolve(true),
    stopRequested: () => false,
    // #1199 item 2 / #1202 — the guard is built from the SAME live clearance the real run passes,
    // so the shown verdicts and the wire's verdicts are one guard, not two readings. The field is
    // REQUIRED (1e5ecb4aa): every caller here names the machine's clearance (the live reading when
    // one was observed, the routine's own clearance otherwise).
    liveClearanceZ,
  };
}

function finish(routine: MotionRoutineId, console_: ReturnType<typeof recordingConsole>, clearanceZ: number, heights: NamedHeights, error: string | null): DryRoutine {
  const reviewed = reviewLines(console_.lines, clearanceZ);
  return {
    lines: reviewed,
    identity: routineIdentityOf(routine, console_.lines, heights),
    refused: reviewed.some((l) => l.refused !== null),
    error,
  };
}

/** The registration run's dry lines (the full executor: home, M491, seeks, scans, epilogue). */
export async function dryRegistration(
  plan: RegistrationPlan,
  opts: { clearanceZ: number; settings: RegistrationSettings; liveClearanceZ?: number },
): Promise<DryRoutine> {
  const console_ = recordingConsole();
  const heights = registrationHeights(plan, opts.clearanceZ);
  let error: string | null = null;
  try {
    const result: RunResult = await runRegistration(plan, depsFor(console_, opts.liveClearanceZ ?? opts.clearanceZ));
    if (!result.ok) error = result.reason;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return finish('registration', console_, opts.clearanceZ, heights, error);
}

/**
 * The standalone mount tap's dry lines — the seat press and the jaw/arm taps, which the Register
 * card runs through `runMountTap` rather than the registration executor.
 */
export async function dryMountTap(
  tap: { x: number; y: number; fromMachineZ?: number },
  opts: {
    clearanceZ: number;
    settings: RegistrationSettings;
    workEnvelopeFloorZ: number;
    mount?: 'vise' | 'bracket' | 'rotary';
    planTravelMm?: number | null;
    routine: Extract<MotionRoutineId, 'seat-press' | 'mount-tap'>;
    liveClearanceZ?: number;
  },
): Promise<DryRoutine> {
  const console_ = recordingConsole();
  const heights: Record<string, number> = { clearance: opts.clearanceZ };
  if (tap.fromMachineZ !== undefined && Number.isFinite(tap.fromMachineZ)) heights.approach = tap.fromMachineZ;
  if (opts.planTravelMm !== undefined && opts.planTravelMm !== null && opts.planTravelMm > 0) {
    heights.seek = -opts.planTravelMm;
  }
  let error: string | null = null;
  try {
    const result: MountTapResult = await runMountTap(
      tap,
      opts.clearanceZ,
      opts.settings,
      depsFor(console_, opts.liveClearanceZ ?? opts.clearanceZ),
      opts.workEnvelopeFloorZ,
      opts.mount ?? 'bracket',
      null,
      opts.planTravelMm ?? null,
    );
    if (!result.ok) error = result.reason;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return finish(opts.routine, console_, opts.clearanceZ, heights, error);
}

/**
 * The flip registration's dry lines — side 2's frame plan (the front pair, the seed, each bore's
 * four touches) through the SAME executor the press runs. `attempt` is the card's own FlipAttempt:
 * the plan, its context and the carried Z0.
 */
export async function dryFlipRegistration(
  attempt: { plan: FlipRegistrationPlan; ctx: RegistrationPlan; z0: unknown },
  opts: { clearanceZ?: number; liveClearanceZ?: number } = {},
): Promise<DryRoutine> {
  const console_ = recordingConsole();
  const clearanceZ = opts.liveClearanceZ ?? opts.clearanceZ ?? attempt.ctx.machineClearanceZ ?? 0;
  let error: string | null = null;
  try {
    const result: FlipRunResult = await runFlipRegistration(
      attempt.plan,
      { ctx: attempt.ctx, z0: attempt.z0 as never },
      depsFor(console_, clearanceZ),
    );
    if (!result.ok) error = result.reason;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return finish('flip-registration', console_, clearanceZ, { clearance: clearanceZ }, error);
}
