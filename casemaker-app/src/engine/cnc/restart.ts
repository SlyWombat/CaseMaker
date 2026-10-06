/**
 * Restart from a step (#249, `/Makera-Parity.md` §14.3 M2): turn a stopped job into a new `.nc`
 * that resumes it.
 *
 * A job stops — a broken cutter, a power cut, an operator pressing stop. Restarting from the
 * beginning re-cuts air at best and re-cuts the part at worst. This module writes a file that
 * re-establishes the modal and accessory state the program had at the step you resume at, moves
 * to a safe approach, and then runs the ORIGINAL program's own remaining moves — nothing is
 * re-planned.
 *
 * WHY THIS IS THE RIGHT SHAPE. The `Timeline` already holds the machine state after every event,
 * including the accessory state the issue calls the field's hard part: which way the spindle is
 * turning and at what speed, and whether air is on. So the restart is a pure function of the
 * original program plus the step — no controller command, no probing, no re-planning.
 *
 * WHAT THIS FILE IS NOT. It is not a controller command (`M-` restart keyed on a controller the
 * Z1 does not have); it is a generated `.nc` that runs through the SAME verifier as any other
 * file (see {@link generateRestart}'s `verify`). A restart file is the one most likely to plunge
 * somewhere unexpected, so there is deliberately no exemption: if the generated text trips
 * `verifyProgram`, `ok` is false. The generated file is also not authoritative about the tool
 * LENGTH — that is machine state the file cannot see — so the operator run sheet it returns says
 * so in plain words ({@link RESTART_TOOL_LENGTH_NOTE}).
 *
 * COOLANT. The Z1 dialect our post writes has no coolant word (the verifier's whitelist is
 * `M2 M3 M5 M6 M7 M9`); its single modelled accessory is AIR (`M7`/`M9`), which is what
 * `MachineState.air` tracks. There is no `M8` to lose, and this generator refuses rather than
 * invent one.
 *
 * Pure: no React, no wasm, no worker. `parseGcode` + `buildTimeline` are the same pure halves
 * the verifier uses, so the restart and the file it came from can never disagree about a move.
 */

import { version as CAM_VERSION } from '../../../package.json';
import { aabbOfProfile } from '@/engine/compiler/profile';
import { HOP_Z } from './cam/ir';
import { parseGcode } from './gcode';
import type { GcodeEvent } from './gcode/types';
import { buildTimeline, isRealToolChange, type MachineState, type Timeline } from './emulator/timeline';
import type { MillProfile } from './machine';
import { CAM_ID, CAM_NAME, FINAL_RETRACT_Z } from './post/z1';
import { formatFixed, sanitizeMkrValue } from './post/format';
import type { Setup } from './setup';
import type { Tool } from './tool';
import { stockDepthLimit, verifyProgram, type VerifyReport } from './verify';

/**
 * The work-frame Z the head retracts to before repositioning. It is the post's own end-of-program
 * retract (`G0 Z15`, "above any work" per `/Fabrication.md`), reused so the restart's safe height
 * and the job's cannot drift apart.
 */
export const RESTART_SAFE_Z = FINAL_RETRACT_Z;

/**
 * The one sentence the operator run sheet must carry (#249 acceptance): the tool length is machine
 * state the file cannot see. A restart assumes the cutter is still at the length the job was
 * planned for; if it is not, the file plunges to the wrong Z.
 */
export const RESTART_TOOL_LENGTH_NOTE =
  'Confirm the cutter is at the expected length before starting: the tool length is machine state this file cannot see, and a stale value plunges to the wrong Z. Re-run the tool-length calibration (M491) if the cutter may have moved.';

/** The machine state the restart restores, in the work frame. */
export interface RestartResume {
  /** The step the file resumes AT: the state after `step − 1` is restored, then `step` onward runs. */
  step: number;
  /** The work-frame position restored before the tail runs: [x, y, z]. */
  work: [number, number, number];
  spindle: MachineState['spindle'];
  rpm: number | null;
  air: boolean;
  /** The active tool. `-1` is an empty spindle; `'unknown'` is the setup's own value. */
  tool: MachineState['tool'];
}

export interface RestartResult {
  /** True only when the text was produced AND the verifier raised no error on it. */
  ok: boolean;
  /** The generated program text, or null when it could not be produced at all. */
  nc: string | null;
  /** Suggested file name (the original's stem plus `-restart-stepN.nc`). */
  fileName: string | null;
  resume: RestartResume | null;
  /** `verifyProgram`'s report on `nc` — the same verifier as any other file, no exemption. */
  verify: VerifyReport | null;
  /** Why the file could not be produced, in the order found; empty on success. */
  errors: string[];
  /** The operator run sheet for this restart, one plain-text line per item. */
  runSheet: string[];
}

export interface RestartInput {
  /** The original program text. */
  gcodeText: string;
  setup: Setup;
  tool: Tool;
  /** The machine the program is simulated/verified on (the Z1's profile). */
  machine: MillProfile;
  /**
   * Resume AT this program step (the step index the transport shows). The state after `step − 1`
   * is restored, then the original's events from `step` onward are re-emitted verbatim.
   */
  step: number;
  /** The stock the program cuts; the verifier's depth limit derives from it. */
  stock: { length: number; width: number; thickness: number };
  /** Deepest cut floor: `depthLimit = thickness − minFloor`. Default 0 (never through the bottom). */
  minFloor?: number;
  /** XY-rapid floor passed to the verifier. Defaults to the post's `HOP_Z`. */
  minRapidZ?: number;
  /** Base name for the generated file; defaults to `restart`. */
  baseName?: string;
}

const fmt = (v: number, precision: number): string => formatFixed(v, precision);

/** The file name for a restart: the original's stem plus `-restart-stepN.nc`, sanitised. */
export function restartFileName(baseName: string, step: number): string {
  const raw = baseName.trim();
  const stem = raw.toLowerCase().endsWith('.nc') ? raw.slice(0, -'.nc'.length) : raw;
  // Sanitise the STEM, then trim separators, so stripping the extension cannot leave a trailing
  // dash next to the one this adds (`My Part (v2).nc` → `My-Part-v2-restart-stepN.nc`).
  const cleaned = stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-_.]+|[-_.]+$/g, '');
  return `${cleaned || 'job'}-restart-step${step}.nc`;
}

/**
 * The stock a `Setup` describes, when it is a prism (the only part kind with a known rectangle).
 * The Simulate panel builds its setup from the stock it displays, so this is the same rectangle.
 * Null for a cylinder or a compiled node: the caller must supply the stock itself.
 */
export function stockFromSetup(setup: Setup): { length: number; width: number; thickness: number } | null {
  const part = setup.part;
  if (part.kind !== 'prism') return null;
  const box = aabbOfProfile(part.outline);
  if (!box) return null;
  return { length: box.max[0] - box.min[0], width: box.max[1] - box.min[1], thickness: part.thickness };
}

/** One `;@MKR|` record, joined by `|` (the same shape the post writes). */
function mkr(tag: string, ...fields: string[]): string {
  return fields.length === 0 ? `;@MKR|${tag}` : `;@MKR|${tag}|${fields.join('|')}`;
}

const numOrZero = (v: number | null, precision = 3): string => (v === null ? '0' : formatFixed(v, precision));

/**
 * The tail: the original program's events from `step` to the end, re-emitted in the Z1 dialect.
 *
 * SYNTHETIC STEPS ARE SKIPPED and their source command is emitted instead, so the runner
 * re-expands the very same firmware macro (`M6`, `G28`). Emitting both would double the macro.
 * A no-op tool change (`isRealToolChange === false`) emits NOTHING — the firmware does nothing —
 * which is also what keeps the restart's tool state tracking the original's: both start from the
 * same `setup.startingTool` and see the same real changes.
 *
 * Anything the dialect cannot express is a refusal, not a silent drop: a pause, a dwell, a
 * spindle that runs counter-clockwise (`M4` is not in the post's whitelist), a work offset other
 * than G54, a laser job. A restart that quietly changed the program would be worse than none.
 */
function buildTail(timeline: Timeline, step: number): { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  const events = timeline.events;

  for (let i = step; i < events.length; i++) {
    const ev: GcodeEvent = events[i] as GcodeEvent;
    // A synthetic step is inserted by the runner's macro expansion; the source command below
    // re-creates it, so skip it here.
    if (ev.synthetic !== undefined) continue;

    switch (ev.kind) {
      case 'move': {
        const pos = timeline.stateAt(i).work;
        if (pos[0] === null || pos[1] === null || pos[2] === null) {
          errors.push(`step ${i}: a move to a position the program never established cannot be re-emitted`);
          return { lines, errors };
        }
        const code = ev.mode === 'rapid' ? 'G0' : 'G1';
        const words = `X${fmt(pos[0], 3)} Y${fmt(pos[1], 3)} Z${fmt(pos[2], 3)}`;
        // A rapid never carries an F (the rapid rate is the controller's own).
        if (ev.mode === 'cut' && ev.feed !== null) lines.push(`${code} ${words} F${fmt(ev.feed, 2)}`);
        else lines.push(`${code} ${words}`);
        break;
      }
      case 'spindle': {
        if (ev.state === 'ccw') {
          errors.push(`step ${i}: the spindle runs counter-clockwise (M4), which the post's dialect does not write`);
          return { lines, errors };
        }
        if (ev.state === 'off') lines.push('M5');
        else lines.push(ev.rpm === null ? 'M3' : `S${fmt(ev.rpm, 0)} M3`);
        break;
      }
      case 'air':
        lines.push(ev.on ? 'M7' : 'M9');
        break;
      case 'tool-change': {
        const real = isRealToolChange(timeline.stateAt(i - 1), ev.tool);
        if (real !== false) lines.push(`T${ev.tool} M6`);
        break;
      }
      case 'home':
        // `M6`/`G28` are re-expanded by the runner, so their synthetic moves are skipped above.
        lines.push('G28');
        break;
      case 'toolpath-start':
        // A comment marker in the source; nothing to emit (the verifier never sees it).
        break;
      case 'program-end':
        // The file gets this generator's own ending below.
        break;
      case 'laser-mode':
        errors.push(`step ${i}: an M321 laser-mode step; a restart is a mill file`);
        return { lines, errors };
      case 'tlo-calibrate':
        errors.push(`step ${i}: a standalone M491 tool-length calibration; the post's dialect does not write it`);
        return { lines, errors };
      case 'probe':
        errors.push(`step ${i}: a G38 probe; the post's dialect does not write it`);
        return { lines, errors };
      case 'pause':
        errors.push(`step ${i}: a program stop (${ev.reason}); the post's dialect does not write it`);
        return { lines, errors };
      case 'dwell':
        errors.push(`step ${i}: a dwell (G4); the post's dialect does not write it`);
        return { lines, errors };
      case 'offset-set':
        errors.push(`step ${i}: a G92 offset; the restart cannot re-establish it in the post's dialect`);
        return { lines, errors };
      case 'wcs-select':
      case 'wcs-set':
        errors.push(`step ${i}: a work-coordinate-system change; only G54 is modelled and the dialect has no G54 word`);
        return { lines, errors };
      case 'rotary-unwind':
        errors.push(`step ${i}: a rotary unwind (G92.4); the restart is a flat 3-axis file`);
        return { lines, errors };
      default:
        errors.push(`step ${i}: an event the restart cannot express (${(ev as GcodeEvent).kind})`);
        return { lines, errors };
    }
  }
  return { lines, errors };
}

/** The feed to descend at: the first cutting move's feed at or after `step`, else the last before. */
function descentFeed(timeline: Timeline, step: number): number | null {
  for (let i = step; i < timeline.events.length; i++) {
    const ev = timeline.events[i] as GcodeEvent;
    if (ev.kind === 'move' && ev.mode === 'cut' && ev.feed !== null) return ev.feed;
  }
  for (let i = step - 1; i >= 0; i--) {
    const ev = timeline.events[i] as GcodeEvent;
    if (ev.kind === 'move' && ev.mode === 'cut' && ev.feed !== null) return ev.feed;
  }
  return null;
}

/**
 * Generate the restart `.nc`, or refuse with the reasons.
 *
 * The file is: a header, `G90 G21`, the restored accessory state, a safe approach (retract, rapid
 * over the resume point, controlled descent to it), the original's own remaining moves, and the
 * post's own ending. It is then run through `verifyProgram` — the ordinary verifier, no exemption.
 */
export function generateRestart(input: RestartInput): RestartResult {
  const errors: string[] = [];
  const step = Math.trunc(input.step);
  const baseName = input.baseName ?? 'job';

  const parse = parseGcode(input.gcodeText);
  let timeline: Timeline;
  try {
    timeline = buildTimeline(parse, input.setup, input.machine);
  } catch (e) {
    return {
      ok: false,
      nc: null,
      fileName: null,
      resume: null,
      verify: null,
      errors: [`the program could not be lowered to moves: ${e instanceof Error ? e.message : String(e)}`],
      runSheet: [],
    };
  }

  const total = timeline.events.length;
  if (!(step >= 1 && step < total)) {
    errors.push(`resume step ${step} is outside 1 … ${Math.max(1, total - 1)}: the step before it must exist`);
  }

  let resume: RestartResume | null = null;
  const lines: string[] = [];
  if (errors.length === 0) {
    const before = timeline.stateAt(step - 1);
    const w = before.work;
    if (w[0] === null || w[1] === null || w[2] === null) {
      errors.push(`the position at step ${step} is not known, so the tool cannot be moved back to it`);
    } else if (before.wcs !== 0) {
      errors.push(`the program is not in G54 at step ${step}; the post's dialect cannot re-establish another offset`);
    } else if (before.g92.some((g) => g !== null && Math.abs(g) > 1e-9)) {
      errors.push(`a G92 offset is in force at step ${step}; the restart cannot re-establish it`);
    } else if (before.spindle === 'ccw') {
      errors.push(`the spindle runs counter-clockwise at step ${step}; the post's dialect has no M4`);
    } else {
      resume = { step, work: [w[0], w[1], w[2]], spindle: before.spindle, rpm: before.rpm, air: before.air, tool: before.tool };
    }
  }

  let tail: { lines: string[]; errors: string[] } = { lines: [], errors: [] };
  if (errors.length === 0) {
    tail = buildTail(timeline, step);
    errors.push(...tail.errors);
  }

  // ---- The safe approach. ----
  if (errors.length === 0 && resume !== null) {
    const [rx, ry, rz] = resume.work;
    lines.push('G90 G21');
    // Restore the accessory state BEFORE the descent, so the descent happens with the spindle in
    // the state it will cut in. Air first (it is the coolant substitute); the spindle follows.
    if (resume.air) lines.push('M7');
    if (resume.spindle === 'off') lines.push('M5');
    else lines.push(resume.rpm === null ? 'M3' : `S${fmt(resume.rpm, 0)} M3`);
    // 1. Retract straight up from wherever the machine is. A pure-Z rapid is exempt from the
    //    verifier's rapid-too-low check and cannot hit material it was not already at.
    lines.push(`G0 Z${fmt(RESTART_SAFE_Z, 3)}`);
    // 2. Rapid over the resume point at the safe height.
    lines.push(`G0 X${fmt(rx, 3)} Y${fmt(ry, 3)}`);
    // 3. Descend to the resume Z. With the spindle OFF this is a pure-Z rapid (the tool was
    //    already at this point, so nothing is being cut); with the spindle ON it is a controlled
    //    FEED, never a rapid into material — the whole reason a restart file is dangerous.
    if (resume.spindle === 'off') {
      lines.push(`G0 Z${fmt(rz, 3)}`);
    } else {
      const feed = descentFeed(timeline, step);
      if (feed === null) {
        errors.push('the spindle is on at the resume point but the program has no cutting feed to descend at');
      } else {
        lines.push(`G1 Z${fmt(rz, 3)} F${fmt(feed, 2)}`);
      }
    }
  }

  const nc = errors.length === 0 && resume !== null ? compose(input, step, resume, lines, tail.lines, baseName) : null;

  // ---- The verifier, with no exemption for restarts (#249 acceptance 2). ----
  let verify: VerifyReport | null = null;
  if (nc !== null) {
    verify = verifyProgram(nc, {
      setup: input.setup,
      machine: input.machine,
      tool: input.tool,
      depthLimit: stockDepthLimit(input.stock, input.minFloor ?? 0),
      minRapidZ: input.minRapidZ ?? HOP_Z,
    });
    if (verify.findings.some((f) => f.severity === 'error')) {
      const n = verify.findings.filter((f) => f.severity === 'error').length;
      errors.push(`the verifier refused the restart (${n} error${n === 1 ? '' : 's'})`);
    }
  }

  const ok = nc !== null && errors.length === 0;
  return {
    ok,
    nc,
    fileName: nc === null ? null : restartFileName(baseName, step),
    resume,
    verify,
    errors,
    runSheet: buildRunSheet(input, step, total, resume, verify, ok),
  };
}

/** Assemble the header + body. */
function compose(
  input: RestartInput,
  step: number,
  resume: RestartResume,
  preamble: string[],
  tail: string[],
  baseName: string,
): string {
  const axis = (v: number): string => fmt(v, input.machine.dialect.axisPrecision);
  const { length: L, width: W, thickness: T } = input.stock;
  const t = input.tool;
  const heading = [
    ';@MKR|BEGIN',
    ';@MKR|SCHEMA|v=1.0.0',
    mkr('MACHINE', `id=${input.machine.id}`, `name=${sanitizeMkrValue(input.machine.name)}`),
    mkr('STOCK', 'id=cuboid', `length=${axis(L)}`, `width=${axis(W)}`, `height=${axis(T)}`, 'diameter=1'),
    mkr(
      'TOOL',
      `number=${t.number ?? 0}`,
      `id=${sanitizeMkrValue(t.id ?? '')}`,
      `name=${sanitizeMkrValue(t.name)}`,
      `type=${sanitizeMkrValue(t.typeText)}`,
      `handlediameter=${numOrZero(t.handleDiameter)}`,
      `sticklength=${numOrZero(t.stickout)}`,
      `shoulderlength=${numOrZero(t.shoulderLength)}`,
      `flutelength=${numOrZero(t.fluteLength)}`,
      `diameter=${numOrZero(t.diameter)}`,
      `tipdiameter=${numOrZero(t.tipDiameter)}`,
      `cornerradius=${numOrZero(t.cornerRadius)}`,
      `angle=${numOrZero(t.angle)}`,
      `halfAngle=${numOrZero(t.halfAngle)}`,
    ),
    mkr('CAM', `id=${CAM_ID}`, `name=${CAM_NAME}`, `v=${CAM_VERSION}`),
    ';@MKR|UNIT|value=MM',
    ';@MKR|END',
    `; RESTART from ${sanitizeMkrValue(baseName)}: resumes at step ${step}; state re-established from the step before`,
    `; tool in the spindle: ${resume.tool === 'unknown' ? 'unknown' : resume.tool === -1 ? 'empty' : `T${resume.tool}`}`,
    `; ${RESTART_TOOL_LENGTH_NOTE}`,
    '',
  ];
  const body = [
    ...preamble,
    ...tail,
    `G0 Z${axis(FINAL_RETRACT_Z)}`,
    'M9',
    'M05',
    'G28',
    'M02',
  ];
  return [...heading, ...body].join('\n') + '\n';
}

/** The operator run sheet for the restart: what it restores, and what it cannot know. */
function buildRunSheet(
  input: RestartInput,
  step: number,
  total: number,
  resume: RestartResume | null,
  verify: VerifyReport | null,
  ok: boolean,
): string[] {
  const baseName = input.baseName ?? 'job';
  const lines = [`Restart ${restartFileName(baseName, step)} — resumes at step ${step} of ${total - 1}.`];
  if (resume !== null) {
    const spindle = resume.spindle === 'off' ? 'off' : `${resume.spindle.toUpperCase()}${resume.rpm === null ? '' : ` at ${resume.rpm} RPM`}`;
    const tool = resume.tool === 'unknown' ? 'unknown' : resume.tool === -1 ? 'empty' : `T${resume.tool}`;
    lines.push(`Re-establishes: spindle ${spindle}, air ${resume.air ? 'on' : 'off'}, tool ${tool}.`);
  }
  lines.push(RESTART_TOOL_LENGTH_NOTE);
  lines.push('The moves after the resume step are the original file’s own, re-emitted unchanged; nothing was re-planned.');
  lines.push(
    'This dialect’s only accessory is air (M7/M9); coolant is not modelled and is not in this file.',
  );
  if (verify !== null) {
    if (ok) lines.push('The verifier passed this file under the same rules as any other program.');
    else {
      const n = verify.findings.filter((f) => f.severity === 'error').length;
      lines.push(`The verifier REFUSED this file (${n} error${n === 1 ? '' : 's'}) — do not run it.`);
    }
  }
  return lines;
}
