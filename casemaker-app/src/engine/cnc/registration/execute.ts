/**
 * The registration executor (#430 phase 1): runs a plan on the machine through the typed console
 * (`platform/machineConsole.ts`'s `ConsoleHandle`), one command per line, as the 2026-10-15 bench did.
 *
 * THE SEQUENCE.
 *   1. `?` must answer `Idle` — nothing moves a machine that is busy or alarmed.
 *   2. `$H`; `G54` selected explicitly; `G92.1` clears any G92 offset (this firmware has no way to
 *      read one, so none is left to sit silently between the touches and the origin).
 *   3. The OPERATOR fits the wired probe (a callback — a person, not this code). `M491`: its last
 *      `[PRB:…]` is the probe's tool-length reading, the Z0 reference.
 *   4. The surface at the plan's clean point, from machine Z −3: a fast `G38.2` that travels only to the
 *      expected surface − tolerance, `G0 Z1`, a slow `G38.2`. BOTH readings must land inside the
 *      expected surface ± tolerance, or the run stops. The probe then PARKS at surface + park.
 *   5. Each edge scan, touch by touch, every XY move AT THE PARK HEIGHT: `G0 X Y`, `?` until Idle,
 *      `G91`, `G38.2 Z-(park + cap)` — so a touch can never go below the surface − cap — `$X` after a
 *      miss, `G90`, the lift to park. Coarse, then fine; the scan stops at the first touch off the
 *      stock, then takes ONE touch midway back toward the stock to halve the last step (never further
 *      out than the miss).
 *   6. Lift (`G53 G0 Z-3`) and `$H`.
 *
 * `?` IS POLLED UNTIL IDLE BEFORE EVERY `G38.2`, as the bench did: a probe sent while a move is still
 * settling is not a probe of where the move was meant to end.
 *
 * IT STOPS AT THE FIRST UNEXPECTED ANSWER — a refusal, a timeout, an error, any alarm that is not a
 * scan touch's expected miss, and anything alarming in the output that arrives BETWEEN lines (the
 * console's `carried`). It sends nothing more, except — when it stopped in relative mode — `$X` (if it
 * may be in alarm) and then `G90`, and says how low the probe may be at that step and how to recover.
 *
 * WRITING THE ORIGIN ({@link applyCorrection}) needs `confirmed: true` (Q12) AND a usable outcome — every
 * edge found, every axis measured, every touch where it was sent — and runs in #387's order: home,
 * the CUTTER in, its `M491`, `G10 L2 P1 X Y Z` with Z0 = surface + (cutter PRB − probe PRB), home.
 */

import { controllerState } from '@/platform/machineUpload';
import type { ConsoleSendResult } from '@/platform/machineConsole';
import { scanPositions, type EdgeScan, type RegistrationPlan } from './plan';
import { classifyTouch, lastPrb, type Prb } from './readings';
import { computeOutcome, correctionLine, type RegistrationOutcome, type RunData, type ScanRecord, type ScanTouch } from './outcome';

export interface RegistrationConsole {
  send(line: string): Promise<ConsoleSendResult>;
}

export type OperatorStep = { kind: 'fit-probe' | 'fit-cutter'; text: string };

export interface ExecDeps {
  console: RegistrationConsole;
  operator: (step: OperatorStep) => Promise<boolean>;
}

export interface Transcript {
  line: string;
  reply: string;
}

export type RunResult =
  | { ok: true; data: RunData; outcome: RegistrationOutcome; transcript: Transcript[] }
  | { ok: false; reason: string; transcript: Transcript[] };

/** How many `?` polls to wait for Idle before a probe — each is a round trip of about a second. */
export const MAX_IDLE_POLLS = 30;

const f = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';

class Stop extends Error {}

/** One machine conversation, stopping at the first answer it did not expect. */
function session(deps: ExecDeps) {
  const transcript: Transcript[] = [];
  let relative = false;
  /** Whether the last answer left the machine in alarm (a miss before its `$X`, or any alarm). */
  let alarmed = false;
  /** How low the probe may be right now, in a sentence — set by each step that moves it down. */
  let depth = 'at a safe height';

  async function send(line: string, opts: { missOk?: boolean } = {}): Promise<string> {
    const r = await deps.console.send(line);
    const reply = r.kind === 'sent' || r.kind === 'timeout' ? r.text : r.detail;
    const carried = r.kind === 'sent' || r.kind === 'timeout' ? (r.carried?.text ?? '') : '';
    transcript.push({ line, reply: carried ? `${reply}\n(between lines) ${carried}` : reply });
    if (r.kind !== 'sent') throw new Stop(`${line}: ${r.kind} — ${reply}`);
    if (/ALARM/i.test(reply) || /ALARM/i.test(carried)) alarmed = true;
    if (line === '$X') alarmed = false;
    for (const text of [reply, carried]) {
      if (/\berror:/i.test(text)) throw new Stop(`${line}: the controller answered ${text.trim()}`);
      const alarm = /ALARM[^\n]*/i.exec(text)?.[0];
      if (alarm && !(opts.missOk && text === reply && /Probe fail/i.test(alarm))) throw new Stop(`${line}: ${alarm.trim()}`);
    }
    if (line === 'G91') relative = true;
    if (line === 'G90') relative = false;
    return reply;
  }

  /** `?` until the machine reads Idle; stop if it never does. */
  async function idle(): Promise<void> {
    for (let i = 0; i < MAX_IDLE_POLLS; i++) {
      const state = controllerState(await send('?'));
      if (state === 'Idle') return;
    }
    throw new Stop(`the machine did not read Idle in ${MAX_IDLE_POLLS} status polls`);
  }

  /** Say how low the probe may be from here on (the stop message uses the latest). */
  function at(sentence: string): void {
    depth = sentence;
  }

  /**
   * After a stop: if the mode was left relative, put it back — `$X` FIRST, because the Z1 refuses `G90`
   * with `error:Alarm lock` while in alarm (Z1-Firmware-Dialect.md, the 2026-10-08 table) — and say
   * how low the probe may be and how to recover. Nothing else is sent.
   */
  async function stopped(reason: string): Promise<string> {
    if (relative) {
      for (const line of alarmed || /ALARM|timeout/i.test(reason) ? ['$X', 'G90'] : ['G90']) {
        try {
          const r = await deps.console.send(line);
          transcript.push({ line, reply: r.kind === 'sent' ? r.text : r.kind });
        } catch {
          break;
        }
      }
    }
    return (
      `${reason}. Stopped — the probe may be ${depth}, and the machine may be in alarm. ` +
      'To recover: $X, then G90, then lift with G53 G0 Z-3 before any XY move.'
    );
  }

  return { send, idle, stopped, at, transcript };
}

type Session = ReturnType<typeof session>;

/** One scan touch at `at`: XY at the park height, Idle, probe down at most to the cap, clear a miss, lift. */
async function touch(io: Session, plan: RegistrationPlan, scan: EdgeScan, at: number, parkZ: number, surfaceZ: number): Promise<ScanTouch> {
  const s = plan.settings;
  const [x, y] = scan.edge === 'left' || scan.edge === 'right' ? [at, scan.along] : [scan.along, at];
  await io.send(`G0 X${f(x)} Y${f(y)}`);
  await io.idle();
  io.at(`as low as ${s.capBelowSurfaceMm} mm below the surface (a scan touch)`);
  await io.send('G91');
  const reply = await io.send(`G38.2 Z-${f(s.parkAboveSurfaceMm + s.capBelowSurfaceMm)} F${f(s.touchFeed)}`, { missOk: true });
  const prb = lastPrb(reply);
  if (prb === null) throw new Stop(`the touch at ${f(x)}, ${f(y)} answered no probe reading`);
  if (!prb.touched) await io.send('$X');
  await io.send('G90');
  await io.send(`G53 G0 Z${f(parkZ)}`);
  io.at(`at the park height, ${s.parkAboveSurfaceMm} mm above the surface`);
  return { at, prb, kind: classifyTouch(prb, surfaceZ, s.surfaceBandMm) };
}

/** One pass outward; it STOPS at the first touch off the stock, then halves the last step inward. */
async function scanEdge(io: Session, plan: RegistrationPlan, scan: EdgeScan, parkZ: number, surfaceZ: number): Promise<ScanRecord> {
  const touches: ScanTouch[] = [];
  let lastOn: number | null = null;
  for (const p of scanPositions(scan)) {
    const t = await touch(io, plan, scan, p, parkZ, surfaceZ);
    touches.push(t);
    if (t.kind !== 'stock') {
      // Something above the surface (a clamp): stop the scan here and say so (outcome.ts).
      if (t.kind !== 'above' && lastOn !== null) {
        const mid = Math.round(((lastOn + p) / 2) * 1000) / 1000;
        touches.push(await touch(io, plan, scan, mid, parkZ, surfaceZ));
      }
      break;
    }
    lastOn = p;
  }
  return { scan, touches };
}

/** A surface reading inside the plan's band, or a stop that says where it landed. */
function inBand(prb: Prb | null, plan: RegistrationPlan, which: string): Prb {
  if (prb === null || !prb.touched) {
    throw new Stop(`the ${which} surface touch found nothing down to machine Z ${plan.seek.band.min} — the stock is not where the job expects it`);
  }
  if (prb.z < plan.seek.band.min || prb.z > plan.seek.band.max) {
    throw new Stop(`the ${which} surface touch read machine Z ${prb.z}, outside the expected ${plan.seek.band.min} to ${plan.seek.band.max}`);
  }
  return prb;
}

export async function runRegistration(plan: RegistrationPlan, deps: ExecDeps): Promise<RunResult> {
  const io = session(deps);
  const s = plan.settings;
  try {
    const status = await io.send('?');
    if (controllerState(status) !== 'Idle') throw new Stop(`the machine reads ${controllerState(status) ?? 'no state'}, not Idle`);
    await io.send('$H');
    await io.send('G54');
    await io.send('G92.1');
    if (!(await deps.operator({ kind: 'fit-probe', text: 'Fit the wired probe in the spindle, then continue.' }))) {
      throw new Stop('stopped: the probe was not fitted');
    }
    const ref = lastPrb(await io.send('M491'));
    if (ref === null || !ref.touched) throw new Stop('M491 answered no tool-length reading');

    await io.send(`G53 G0 Z${f(plan.seek.fromMachineZ)}`);
    await io.send('G90');
    await io.send(`G0 X${f(plan.surfacePoint.x)} Y${f(plan.surfacePoint.y)}`);
    await io.idle();
    io.at(`as low as machine Z ${plan.seek.band.min}, ${s.surfaceToleranceMm} mm below the expected surface (the surface seek)`);
    await io.send('G91');
    inBand(lastPrb(await io.send(`G38.2 Z-${f(plan.seek.travelMm)} F${f(s.surfaceFastFeed)}`)), plan, 'fast');
    await io.send('G0 Z1');
    await io.idle();
    const slow = inBand(lastPrb(await io.send(`G38.2 Z-2 F${f(s.surfaceSlowFeed)}`)), plan, 'slow');
    await io.send('G90');
    const parkZ = slow.z + s.parkAboveSurfaceMm;
    await io.send(`G53 G0 Z${f(parkZ)}`);
    io.at(`at the park height, ${s.parkAboveSurfaceMm} mm above the surface`);

    const scans: ScanRecord[] = [];
    for (const scan of plan.scans) scans.push(await scanEdge(io, plan, scan, parkZ, slow.z));

    await io.send(`G53 G0 Z${f(plan.seek.fromMachineZ)}`);
    await io.send('$H');
    const data: RunData = { probeRefZ: ref.z, surface: slow, scans };
    return { ok: true, data, outcome: computeOutcome(plan, data), transcript: io.transcript };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: await io.stopped(e.message), transcript: io.transcript };
    throw e;
  }
}

export type ApplyResult =
  | { ok: true; line: string; cutterRefZ: number; transcript: Transcript[] }
  | { ok: false; reason: string; transcript: Transcript[] };

/**
 * Write the corrected origin — ONLY from a usable measurement, ONLY after the operator confirmed it
 * (Q12), and in #387's order: home before the bit change, the cutter in, its `M491`, `G10 L2` with Z0
 * recomputed for it, home.
 */
export async function applyCorrection(
  outcome: RegistrationOutcome,
  deps: ExecDeps,
  consent: { confirmed: boolean },
): Promise<ApplyResult> {
  const io = session(deps);
  if (!outcome.usable) {
    return { ok: false, reason: `no origin is written from this measurement: ${outcome.problems.join('; ')}`, transcript: [] };
  }
  if (consent.confirmed !== true) {
    return { ok: false, reason: 'the origin is written only after the operator confirms the measured offset', transcript: [] };
  }
  try {
    await io.send('$H');
    if (!(await deps.operator({ kind: 'fit-cutter', text: 'Take the probe out, fit the cutter, then continue.' }))) {
      throw new Stop('stopped: the cutter was not fitted');
    }
    const ref = lastPrb(await io.send('M491'));
    if (ref === null || !ref.touched) throw new Stop('M491 answered no tool-length reading for the cutter');
    const line = correctionLine(outcome, ref.z);
    await io.send(line);
    await io.send('$H');
    return { ok: true, line, cutterRefZ: ref.z, transcript: io.transcript };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: await io.stopped(e.message), transcript: io.transcript };
    throw e;
  }
}
