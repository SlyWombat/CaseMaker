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
  runCentreFind,
  runFlipRegistration,
  runMountTap,
  runRegistration,
  type CentreFindOptions,
  type CentreRunResult,
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

/**
 * #1202 — WHETHER THE CARD'S ROUTINE PRESS IS HELD BY ITS PREVIEW. A preview that could not finish
 * (a dry error) shows LESS than the app would send — the analyst saw 23 lines of 36 — so it holds
 * the press on a proved routine as firmly as on a first run; a refused line holds too, and a first
 * run needs its own tick.
 */
export function previewHolds(preview: DryRoutine | null, firstRun: boolean, ticked: boolean): boolean {
  return (preview !== null && (preview.refused || preview.error !== null)) || (firstRun && !ticked);
}

/**
 * #1202 — WHAT A PREVIEW SAYS WHEN THE MACHINE'S CLEARANCE IS UNKNOWN. D's #1199 makes the live
 * clearance REQUIRED: a routine cannot be reviewed against a height nobody read, so the preview
 * refuses instead of inventing one (the tool change and the flip registration share the sentence).
 */
export const CLEARANCE_UNKNOWN = 'clearance unknown — the line can’t be reviewed';

/**
 * THE SCRIPTED MACHINE'S OWN STATE — the head's Z and G90/G91. A `G38.3` answers from where the
 * head actually is: the fast top touch contacts at the level the plan expects (the middle of its
 * band), and the slow touch that follows starts just above it and triggers at that same level.
 * Answering half a relative travel as an ABSOLUTE machine Z (what `dryReply` did) put the reading
 * above the machine's clearance; the scripted executor then stopped partway and the card showed a
 * truncated sequence — 23 lines of 36 (#1202 analyst defect, 2026-11-11).
 */
export function scriptedReply(
  opts: { band?: { min: number; max: number }; m491Z?: number | null; tapZ?: number | null } = {},
): (line: string) => string {
  // The machine's Z and the mode. A relative `G38.3 Z-…` answers from where the head IS; the fast
  // top touch contacts at the level the plan expects (the middle of its band) and the slow touch
  // answers at that same level. X/Y probes keep the shape the scans were shaped on (`half the
  // travel` on the probed axis) — only Z needed the machine's own position.
  let z = 0;
  // #1202 bench blocker — THE M491 THE PLAN WAS MEASURED WITH. The plan's expected band carries
  // the datum's probe reference; the executor corrects the band by today's M491 less that
  // reference (#1189), so a scripted −80 for a seat measured at −75.467 shifts the band by
  // −4.533 and every scripted touch reads above it. Answer the plan's own reference (else the
  // long-standing −80) and the correction is zero.
  const m491Z = opts.m491Z !== undefined && opts.m491Z !== null && Number.isFinite(opts.m491Z) ? opts.m491Z : -80;
  // #1202 — THE MOUNT TAP'S STORED LEVEL. The first Z probe of a registration is the mount tap; a
  // real machine meets the jaw top (or the bracket's top) the record stores, and the executor
  // checks the reading against `expectZ`. A midpoint answer reads millimetres above it and the dry
  // run stops — the card shows an error and holds a real Register.
  const tapZ = opts.tapZ !== undefined && opts.tapZ !== null && Number.isFinite(opts.tapZ) ? opts.tapZ : null;
  let tapPending = tapZ !== null;
  let absolute = true;
  const expected = opts.band === undefined ? null : (opts.band.min + opts.band.max) / 2;
  /** The level the fast touch found; the slow touch starts just above it and triggers there. */
  let found: number | null = null;
  const applyZ = (value: number): void => {
    z = absolute ? value : z + value;
  };
  return (line: string): string => {
    const text = line.trim();
    const upper = text.toUpperCase();
    if (text === '?') return DRY_STATUS;
    if (text === 'M119') return 'X_max:0 Y_max:0 Z_max:0 Probe: 0';
    if (text === 'M491') return `[PRB:0,0,${m491Z.toFixed(3)}:1]\r\nok`;
    // Homing parks at the top of travel; the Z1 reports -1,-1,-1 (#1202).
    if (upper === '$H') {
      z = -1;
      return 'ok';
    }
    if (upper === 'G90') {
      absolute = true;
      return 'ok';
    }
    if (upper === 'G91') {
      absolute = false;
      return 'ok';
    }
    // G53 is machine-coordinate and absolute whatever the mode.
    let m = /^G53\s+G0\s+Z([-+]?[\d.]+)/.exec(upper);
    if (m !== null) {
      z = Number(m[1]);
      return 'ok';
    }
    // A probe.
    m = /^G38\.3\s+([XYZ])([-+]?[\d.]+)(?:\s|$)/.exec(upper);
    if (m !== null) {
      const axis = m[1]!.toLowerCase() as 'x' | 'y' | 'z';
      const amount = Number(m[2]);
      if (axis !== 'z') {
        // The scans' own scripted reading, unchanged from the long-green dry run.
        const at = (amount / 2).toFixed(3);
        const x = axis === 'x' ? at : '0.000';
        const y = axis === 'y' ? at : '0.000';
        return `[PRB:${x},${y},-80.000:1]\r\nok`;
      }
      const from = z;
      const target = absolute ? amount : z + amount;
      const lo = Math.min(from, target);
      const hi = Math.max(from, target);
      // THE MOUNT TAP IS TWO STAGES (execute.ts `mountTapTouch`): a FAST touch that ends just above
      // the stored level and must MISS, then a SLOW touch down past it that meets the jaw there.
      // Fabricating a fast-stage contact in the air is what stopped the dry run.
      if (tapPending && target < from && tapZ !== null) {
        if (target <= tapZ) {
          z = tapZ;
          tapPending = false;
          return `[PRB:0.000,0.000,${tapZ.toFixed(3)}:1]\r\nok`;
        }
        z = target;
        return `[PRB:0.000,0.000,${target.toFixed(3)}:0]\r\nok`;
      }
      let hit: number;
      if (found !== null && found >= lo && found <= hi) {
        // The slow touch (and any re-seek): the surface is where the fast touch found it.
        hit = found;
      } else if (target < from && expected !== null && expected >= lo && expected <= hi) {
        // The fast touch: place the contact at the level the plan expects, inside its band.
        hit = expected;
        found = expected;
      } else {
        hit = (from + target) / 2;
      }
      z = hit;
      return `[PRB:0.000,0.000,${hit.toFixed(3)}:1]\r\nok`;
    }
    // Probe-away (G38.5): the stylus release, NOT a head travel — the bench measured the axis
    // moving 0.057 mm of the commanded 3 before the trigger cleared (2026-10-30 survey), and the
    // executor's slow touch is placed on the fast hit + 1 mm on that reading. The head's Z stays
    // where the probe found the surface.
    m = /^G38\.5\s+([XYZ])([-+]?[\d.]+)(?:\s|$)/.exec(upper);
    if (m !== null) return 'ok';
    // Any other move with a Z word: apply it so the next probe answers from the right place.
    // G10/G92 write offsets and move nothing.
    m = /^G([0-9]+)\s+(.+)$/.exec(upper);
    const words = m !== null && m[1] !== '10' && m[1] !== '92' ? m[2]! : upper;
    const zw = /(?:^|\s)Z([-+]?[\d.]+)(?:\s|$)/.exec(words);
    if (zw !== null) applyZ(Number(zw[1]));
    return 'ok';
  };
}

/** The recording console: it answers like a well-behaved machine and never opens a socket. The
 * reply function is stateful by default (`scriptedReply`); each answer is recorded beside its line
 * so the guard reviews the SAME conversation the executor heard. */
export function recordingConsole(
  reply: (line: string) => string = scriptedReply(),
): {
  send: (line: string, timing?: Partial<unknown>) => Promise<ConsoleSendResult>;
  lines: string[];
  replies: string[];
} {
  const lines: string[] = [];
  const replies: string[] = [];
  return {
    lines,
    replies,
    async send(line: string): Promise<ConsoleSendResult> {
      lines.push(line);
      const text = reply(line);
      replies.push(text);
      return { kind: 'sent', line, text, frames: 1, elapsedMs: 0 };
    },
  };
}

/**
 * The centre find's scripted machine (#827): the top touch is the FIRST `G38.3` Z probe and must
 * trigger (it finds the surface); every later Z probe is a descent to the side touch's depth, which
 * must MISS — a bore's centre is open air, a boss's start is beyond its wall. X/Y probes trigger.
 */
export function centreFindReply(): (line: string) => string {
  let zProbes = 0;
  return (line) => {
    if (/^G38\.3\s+Z[-+]?[\d.]+/i.test(line.trim())) {
      zProbes += 1;
      if (zProbes > 1) return '[PRB:0,0,-80.000:0]\r\nok';
    }
    return dryReply(line);
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

/**
 * The same review over the console's OWN recorded answers. The guard reads a probe's trigger Z out
 * of the reply (`motionOrder.commit`), so re-deriving the reply from the line alone would feed it a
 * different conversation than the executor heard — the stateful machine's answers must be the ones
 * reviewed.
 */
export function reviewSequence(entries: readonly { line: string; reply: string }[], clearanceZ: number): DryLine[] {
  const guard = motionOrderGuard(clearanceZ);
  return entries.map((e) => ({ line: e.line, refused: guard.observe(e.line, e.reply) }));
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
  const reviewed = reviewSequence(
    console_.lines.map((line, i) => ({ line, reply: console_.replies[i] ?? dryReply(line) })),
    clearanceZ,
  );
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
  // The scripted machine is seeded with the plan's OWN band: the fast touch contacts where the
  // plan expects the top, and the slow touch answers at that level (#1202 analyst defect).
  const console_ = recordingConsole(
    scriptedReply({
      band: plan.seek.band,
      m491Z: plan.probeRefZ ?? null,
      tapZ: plan.mountTap?.expectZ ?? null,
    }),
  );
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
    /** #1202 — the stored level this tap expects (a jaw or bracket top), when the caller has one. */
    expectZ?: number | null;
  },
): Promise<DryRoutine> {
  const console_ = recordingConsole(scriptedReply({ tapZ: opts.expectZ ?? null }));
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
 * The centre find's dry lines (#1202 field 5) — the bore/boss/round-part routine through the SAME
 * executor the Find press runs. `seekFromMachineZ` is the machine's travel height; the press uses
 * it as the session's live clearance, so the preview reviews against the same number.
 */
export async function dryCentreFind(opts: CentreFindOptions): Promise<DryRoutine> {
  const console_ = recordingConsole(centreFindReply());
  const clearanceZ = opts.seekFromMachineZ;
  let error: string | null = null;
  try {
    const result: CentreRunResult = await runCentreFind(opts, depsFor(console_, clearanceZ));
    if (!result.ok) error = result.reason;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return finish('centre-find', console_, clearanceZ, { clearance: clearanceZ }, error);
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
  const clearanceZ = opts.liveClearanceZ ?? opts.clearanceZ ?? attempt.ctx.machineClearanceZ ?? null;
  // #1202 — UNKNOWN MEANS REFUSED, never reviewed against an invented 0 (the tool-change rule):
  // the card shows the sentence and `previewHolds` keeps the press held.
  if (clearanceZ === null || !Number.isFinite(clearanceZ)) {
    return {
      lines: [],
      identity: routineIdentityOf('flip-registration', [], {}),
      refused: true,
      error: CLEARANCE_UNKNOWN,
    };
  }
  // No tapZ here: the flip run never taps the mount (`runFlipRegistration` reads the ctx for its
  // stock, settings and probe only), so seeding it would misplace its first Z probe.
  const console_ = recordingConsole(
    scriptedReply({ band: attempt.ctx.seek.band, m491Z: attempt.ctx.probeRefZ ?? null }),
  );
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
