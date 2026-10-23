/**
 * The run plan (#421, §5.8): every job as the same sequence of PHASES, unrolled per setup and per tool,
 * each with a time and WHERE THAT TIME CAME FROM. Pure — the setups, the programs, the registration
 * plans, the machine and the shop's defaults in; a plan out. No machine, no store.
 *
 * THE SEQUENCE.
 *   home `$H` → per setup: [remount] → probe in (home first after a cut, fit the probe, `M491`) →
 *   registration (the touches, plus the auto-level grid when it is on) → per program, one per tool
 *   (Q15): bit change (home first — the bench rule — fit Tn, `M491`) → [air run] → cut (`M331`, the
 *   program, `M332` and clearance) → finish (`M332`, spindle off, `G28`, `M370` if a grid was set).
 *
 * WHERE EACH TIME COMES FROM (`TimeSource`):
 *   - MEASURED — a shop default the bench timed (dated, with a note): `$H`, `M491`, one probe touch;
 *   - CHOSEN — a shop default somebody chose (seeded or set): fitting a cutter, a remount;
 *   - FALLBACK — the build's labelled value, only when there is no location to read;
 *   - ESTIMATED — computed here: the cut is `estimateIRCycleSeconds` on the MACHINE's own rapid model
 *     (#281 — 1200/600 mm/min with acceleration, never an assumed 3000), the air run ≈ the cut, and
 *     registration is its plan's touches × the per-touch time.
 * A phase is labelled by the part carrying most of its time; every part keeps its own label.
 *
 * LAST RUN (#277's extension). A phase's wall clock from the last run of this job is shown BESIDE its
 * estimate, never folded into it — `runHistory.ts`'s rule: the estimate stays the planning figure it
 * is, and the clock is one more fact next to it. No scale-factor knob (`Makera-Parity.md` §14.2 A1).
 */

import { estimateIRCycleSeconds, type RapidEstimate, type ToolpathIR } from '../cam/ir';
import { type PlanResult } from '../registration';
import type { Mount, Setup } from '../setups/types';
import type { StockFlatness } from '@/platform/stockClient';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { machineFeatures, newPrograms, type FeatureOverrides, type FeatureSwitch, type MachineCapabilities } from './features';
import { planFallbacks, planSettings, type PlanSettings, type Sourced, type TimeSource } from './settings';

export type PhaseKind = 'home' | 'remount' | 'probe-in' | 'registration' | 'bit-change' | 'air-run' | 'cut' | 'finish';
export type Who = 'machine' | 'you' | 'you + machine';

export interface PhasePart {
  label: string;
  who: 'machine' | 'you';
  /** Null: no number for it (a program with no estimate, a registration the planner refused). */
  seconds: number | null;
  source: TimeSource;
  /** Where the number came from, in words: the shop default's key, the estimate's rapid model. */
  from: string;
}

export interface Phase {
  /** Stable across re-plans of the same job: `home`, `s1.probe-in`, `s1.p2.cut`, `finish`. */
  id: string;
  kind: PhaseKind;
  setupIndex: number | null;
  programId: string | null;
  title: string;
  who: Who;
  /** A directed physical step that needs its own "done" (Q17) — the one confirmation does not cover it. */
  needsDone: boolean;
  parts: PhasePart[];
  /** The sum of the parts; null when any part has no number. */
  seconds: number | null;
  /** The source of the part carrying most of the time. */
  source: TimeSource;
  /** The wall clock this phase took the last time this job ran, when one was recorded. */
  lastRun: { seconds: number; at: string } | null;
}

/** One program — one tool (Q15) — in one setup. */
export interface PlanProgram {
  id: string;
  setupIndex: number;
  /** What the operator reads: `T1 ⌀2 flat end`. */
  label: string;
  /** The program's hash (the air-run default's key, Q14); null when it has none yet. */
  hash: string | null;
  /** The toolpath, timed here on the machine's rapid model. Preferred over `estimatedSeconds`. */
  ir?: ToolpathIR;
  /** The CAM's own cycle estimate, seconds, when the IR is not at hand. */
  estimatedSeconds?: number;
}

/** One setup as the plan needs it. {@link planSetupsFrom} makes these from #428's plan. */
export interface PlanSetup {
  index: number;
  /** A mount step comes first: every setup after the first, and a first setup that is not top-up. */
  mountStep: boolean;
  /** The job faces the stock in this setup (#428's `facing` removal). */
  faced: boolean;
  /** #430's plan for this setup, or null when none was made. */
  registration: PlanResult | null;
}

export interface RunPlanInput {
  setups: PlanSetup[];
  programs: PlanProgram[];
  /** The machine the job is for: its own rapid model (#281). Required — there is no default. */
  machine: { rapidEstimate: RapidEstimate };
  mount: Mount;
  stock: { flatness: StockFlatness };
  /** The shallowest cut's depth, mm, for the auto-level rule; null when not known. */
  shallowestCutMm: number | null;
  /** The program hashes this machine has FINISHED cleanly (Q14). */
  finishedHashes: readonly string[];
  defaults: ShopDefaults | null;
  overrides?: FeatureOverrides;
  capabilities?: MachineCapabilities;
  /** Last run's wall clocks, by phase id. */
  lastRun?: { at: string; seconds: Readonly<Record<string, number>> } | null;
}

export interface PlanFinding {
  code: 'plan-cut-unestimated' | 'plan-registration-unplanned' | 'plan-defaults-fallback' | 'plan-air-run-unhashed';
  severity: 'warning' | 'info';
  text: string;
}

export interface RunPlan {
  phases: Phase[];
  /** The sum of every phase with a number. */
  totalSeconds: number;
  /** Some phase has no number, so the total is a lower bound. */
  totalIsLowerBound: boolean;
  features: FeatureSwitch[];
  /** Per program, in input order: whether its air run is planned. */
  airRunFor: boolean[];
  findings: PlanFinding[];
  settings: PlanSettings;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function fromDefault(label: string, who: 'machine' | 'you', s: Sourced): PhasePart {
  return { label, who, seconds: s.value, source: s.source, from: s.key };
}

/** Touches in a registration plan: the surface touch, plus each scan's bracket-and-bisect probes (#594). */
export function registrationTouches(plan: Extract<PlanResult, { ok: true }>): number {
  return 1 + plan.plan.scans.reduce((n, scan) => {
    // Two bracket probes (start and limit), then ~log₂ bisections to the fine step.
    const bracket = Math.abs(scan.start - scan.limit);
    return n + 2 + Math.ceil(Math.log2(Math.max(2, bracket / scan.fineStep)));
  }, 0);
}

/** The setups planner's setups (#428) as the plan needs them. */
export function planSetupsFrom(setups: readonly Setup[], registrations: Readonly<Record<number, PlanResult>> = {}): PlanSetup[] {
  return setups.map((s, i) => ({
    index: s.index,
    mountStep: i > 0 || s.remount !== null,
    faced: s.stockAfter.cuts.some((c) => c.facing === true && s.itemIds.includes(c.id)),
    registration: registrations[s.index] ?? null,
  }));
}

function phase(base: Omit<Phase, 'seconds' | 'source' | 'lastRun'>, lastRun: RunPlanInput['lastRun']): Phase {
  const known = base.parts.every((p) => p.seconds !== null);
  const seconds = known ? r1(base.parts.reduce((n, p) => n + (p.seconds ?? 0), 0)) : null;
  // The part with the most time; with no numbers, the first part with none (it is what is missing).
  const lead = known
    ? base.parts.reduce((a, b) => ((b.seconds ?? 0) > (a.seconds ?? 0) ? b : a), base.parts[0]!)
    : base.parts.find((p) => p.seconds === null)!;
  const clock = lastRun?.seconds[base.id];
  return {
    ...base,
    seconds,
    source: lead.source,
    lastRun: typeof clock === 'number' && clock > 0 && lastRun ? { seconds: clock, at: lastRun.at } : null,
  };
}

function whoOf(parts: PhasePart[]): Who {
  const you = parts.some((p) => p.who === 'you');
  const machine = parts.some((p) => p.who === 'machine');
  return you && machine ? 'you + machine' : you ? 'you' : 'machine';
}

function cutTime(p: PlanProgram, rapid: RapidEstimate): { seconds: number | null; from: string } {
  if (p.ir) return { seconds: r1(estimateIRCycleSeconds(p.ir, rapid)), from: `the toolpath, rapids on ${rapid.source}` };
  if (typeof p.estimatedSeconds === 'number' && p.estimatedSeconds >= 0) return { seconds: r1(p.estimatedSeconds), from: 'the CAM cycle estimate' };
  return { seconds: null, from: 'no estimate: the program has not been generated' };
}

export function planRun(input: RunPlanInput): RunPlan {
  const s = planSettings(input.defaults);
  const rapid = input.machine.rapidEstimate;
  const findings: PlanFinding[] = [];
  const phases: Phase[] = [];
  const add = (p: Omit<Phase, 'seconds' | 'source' | 'lastRun' | 'who'> & { who?: Who }) =>
    phases.push(phase({ ...p, who: p.who ?? whoOf(p.parts) }, input.lastRun));

  const features = machineFeatures({
    programs: input.programs.map((p) => ({ label: p.label, hash: p.hash })),
    finishedHashes: input.finishedHashes,
    stock: input.stock,
    mount: input.mount,
    faced: input.setups.some((x) => x.faced),
    shallowestCutMm: input.shallowestCutMm,
    capabilities: input.capabilities,
    overrides: input.overrides,
    autoLevelShallowMm: s.autoLevelShallowMm,
  });
  const sw = (k: FeatureSwitch['feature']) => features.find((f) => f.feature === k)!;
  const vacuumOn = sw('vacuum').on;
  const autoLevelOn = sw('auto-level').on;
  // Q14 per program, unless the operator switched the air run for the whole job.
  const fresh = newPrograms(input.programs, input.finishedHashes);
  const airSwitch = sw('air-run');
  const explicitAir = airSwitch.available && input.overrides?.airRun !== undefined;
  const airRunFor = input.programs.map((_, i) => (explicitAir ? airSwitch.on : fresh[i]!));

  add({
    id: 'home',
    kind: 'home',
    setupIndex: null,
    programId: null,
    title: 'Home ($H)',
    needsDone: false,
    parts: [fromDefault('$H', 'machine', s.homeSeconds)],
  });

  for (const setup of input.setups) {
    const sid = `s${setup.index}`;
    const programs = input.programs.filter((p) => p.setupIndex === setup.index);
    if (setup.mountStep) {
      add({
        id: `${sid}.remount`,
        kind: 'remount',
        setupIndex: setup.index,
        programId: null,
        title: setup.index === 1 ? `Mount the stock (setup ${setup.index})` : `Remount for setup ${setup.index}`,
        needsDone: true,
        parts: [fromDefault('turn and clamp the stock', 'you', s.remountSeconds)],
      });
    }
    // The probe goes in: home first after a cut (the bench rule for every bit change); not when the
    // head has not moved since the job's own home.
    const probeParts: PhasePart[] = [];
    if (phases.some((x) => x.kind === 'cut')) probeParts.push(fromDefault('home before the change ($H)', 'machine', s.homeSeconds));
    probeParts.push(fromDefault('fit the probe', 'you', s.fitProbeSeconds), fromDefault('M491 on the probe', 'machine', s.toolLengthSeconds));
    add({ id: `${sid}.probe-in`, kind: 'probe-in', setupIndex: setup.index, programId: null, title: 'Probe in', needsDone: true, parts: probeParts });

    const regParts: PhasePart[] = [];
    const reg = setup.registration;
    if (reg?.ok) {
      const touches = registrationTouches(reg);
      regParts.push({
        label: `${touches} touch${touches === 1 ? '' : 'es'} (${reg.plan.mount}; at most — a scan stops at its first miss)`,
        who: 'machine',
        seconds: r1(touches * s.touchSeconds.value),
        source: 'estimated',
        from: `${touches} × ${s.touchSeconds.key} (${s.touchSeconds.value} s, ${s.touchSeconds.source})`,
      });
    } else {
      regParts.push({
        label: 'find the stock (no registration plan to count touches from)',
        who: 'machine',
        seconds: s.reregisterSeconds.value,
        source: s.reregisterSeconds.source,
        from: s.reregisterSeconds.key,
      });
      findings.push({
        code: 'plan-registration-unplanned',
        severity: 'info',
        text: `Setup ${setup.index}: ${reg && !reg.ok ? `the registration planner refused (${reg.reason})` : 'no registration plan was made'}, so its time is the shop's re-registration estimate.`,
      });
    }
    if (autoLevelOn) {
      const points = Math.max(1, Math.round(s.autoLevelPoints.value));
      regParts.push({
        label: `auto-level grid, ${points} points (G32 R1)`,
        who: 'machine',
        seconds: r1(points * s.autoLevelPointSeconds.value),
        source: s.autoLevelPointSeconds.source === 'measured' && s.autoLevelPoints.source === 'measured' ? 'measured' : 'chosen',
        from: `${s.autoLevelPoints.key} × ${s.autoLevelPointSeconds.key}`,
      });
    }
    add({ id: `${sid}.registration`, kind: 'registration', setupIndex: setup.index, programId: null, title: 'Registration', needsDone: false, parts: regParts });

    programs.forEach((p, k) => {
      const pid = `${sid}.p${k + 1}`;
      const i = input.programs.indexOf(p);
      add({
        id: `${pid}.bit-change`,
        kind: 'bit-change',
        setupIndex: setup.index,
        programId: p.id,
        title: `Bit change: ${p.label}`,
        needsDone: true,
        parts: [
          fromDefault('home before the change ($H)', 'machine', s.homeSeconds),
          fromDefault(`fit ${p.label}`, 'you', s.fitCutterSeconds),
          fromDefault('M491, set Z0', 'machine', s.toolLengthSeconds),
        ],
      });
      const cut = cutTime(p, rapid);
      if (cut.seconds === null) {
        findings.push({ code: 'plan-cut-unestimated', severity: 'warning', text: `${p.label}: ${cut.from}, so the plan's total leaves it out.` });
      }
      if (p.hash === null) {
        findings.push({ code: 'plan-air-run-unhashed', severity: 'info', text: `${p.label} has no program hash yet, so it counts as a program this machine has not run.` });
      }
      if (airRunFor[i]) {
        add({
          id: `${pid}.air-run`,
          kind: 'air-run',
          setupIndex: setup.index,
          programId: p.id,
          title: `Air run: ${p.label}`,
          needsDone: false,
          parts: [{ label: 'the program, raised clear of the stock', who: 'machine', seconds: cut.seconds, source: 'estimated', from: `≈ the cut (${cut.from})` }],
        });
      }
      const cutParts: PhasePart[] = [{ label: 'the program', who: 'machine', seconds: cut.seconds, source: 'estimated', from: cut.from }];
      cutParts.push(fromDefault(vacuumOn ? 'vacuum off (M332), clearance' : 'clearance', 'machine', s.clearanceSeconds));
      add({
        id: `${pid}.cut`,
        kind: 'cut',
        setupIndex: setup.index,
        programId: p.id,
        title: `${vacuumOn ? 'Vacuum on (M331), cut' : 'Cut'}: ${p.label}`,
        needsDone: false,
        parts: cutParts,
      });
    });
  }

  add({
    id: 'finish',
    kind: 'finish',
    setupIndex: null,
    programId: null,
    title: `Done: ${vacuumOn ? 'M332, ' : ''}spindle off, G28${autoLevelOn ? ', M370' : ''}`,
    needsDone: false,
    parts: [fromDefault('finish', 'machine', s.finishSeconds)],
  });

  const fallbacks = planFallbacks(s);
  if (fallbacks.length > 0) {
    findings.push({
      code: 'plan-defaults-fallback',
      severity: 'info',
      // #505 — the keys (`plan.homeSeconds`, `setups.remountMinutes`, ...) are how the defaults
      // client addresses them, not words an operator should meet in a finding. The count is what
      // the sentence needs; the key list stays available on `PlanSettings` for code.
      text: `No location was read, so ${
        fallbacks.length === 1 ? 'one phase time uses' : `${fallbacks.length} phase times use`
      } the app's built-in defaults rather than this shop's settings.`,
    });
  }
  return {
    phases,
    totalSeconds: r1(phases.reduce((n, p) => n + (p.seconds ?? p.parts.reduce((m, q) => m + (q.seconds ?? 0), 0)), 0)),
    totalIsLowerBound: phases.some((p) => p.seconds === null),
    features,
    airRunFor,
    findings,
    settings: s,
  };
}

/**
 * The cut's wall clock from a run the app played (#423): the controller's own elapsed seconds at the
 * last status read of a FINISHED run, keyed by the plan's phase id. Anything else records nothing —
 * a stopped or failed run's clock is not how long the cut takes.
 */
export function cutClockFrom(
  phaseId: string,
  outcome: { kind: string; last?: { elapsedS: number | null } },
): Record<string, number> {
  const s = outcome.kind === 'finished' ? outcome.last?.elapsedS ?? null : null;
  return s !== null && s > 0 ? { [phaseId]: s } : {};
}
