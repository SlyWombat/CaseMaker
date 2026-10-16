/**
 * The machine strip's switches (#421, §5.8 "Where the machine's features live"): each machine feature
 * a job can use, its DEFAULT, and the REASON for that default, in words the strip prints. Pure.
 *
 *   - VACUUM — on for every cut (the maintainer): `M331` before play, `M332` after.
 *   - AIR RUN — Q14: on by default only for a program this machine has not run (by hash); an
 *     identical repeat defaults off. Either way it can be switched.
 *   - AUTO-LEVEL — Q13: OFF until #176 proves `G32 R1` / `M370` on this machine. Until then the switch
 *     is locked, and the strip still says what the rule WILL choose once it is proven: on for domed or
 *     unknown stock with a cut shallower than `plan.autoLevelShallowMm` (Studio's own rule), or on tape;
 *     off for faced stock.
 *   - LIGHT — Q18: in the strip once ONE bench check (#422) sees `M821`/`M822` work from our console.
 *     It is an UNPROVEN CAPABILITY until then: modelled, never drawn. Proven, it defaults on while a
 *     job runs, so the camera and the operator can see.
 *
 * WHAT IS PROVEN IS A FACT ABOUT THE MACHINE, NOT A SHOP SETTING. {@link Z1_CAPABILITIES} is the
 * build's record of the bench, cited to the issue that proves each; it is not a shop default, so a
 * switch cannot be made to appear by editing a value — only by the bench check and a change here.
 */

import type { Mount } from '../setups/types';
import type { StockFlatness } from '@/platform/stockClient';
import type { Sourced } from './settings';

export type FeatureKind = 'vacuum' | 'air-run' | 'auto-level' | 'light';

export interface Capability {
  proven: boolean;
  /** The issue whose bench check proves it. */
  gate: string;
  /** What it sends, for the strip's title. */
  commands: string;
}

/** The Z1's capabilities as the bench has (or has not) shown them. */
export interface MachineCapabilities {
  autoLevel: Capability;
  light: Capability;
}

/**
 * As of 2026-10-16. Auto-level: `G32 R1` / `M370` are Studio's sequence, never run from our console
 * (#176, Q13). Light: `M821`/`M822` are listed for every machine in Studio's `interface_config.json`
 * (Appendix A.7) and unobserved here — the 2026-10-15 attempt did not run (#422, Q18).
 */
export const Z1_CAPABILITIES: MachineCapabilities = {
  autoLevel: { proven: false, gate: '#176', commands: 'G32 R1 … M370' },
  light: { proven: false, gate: '#422', commands: 'M821 / M822' },
};

export interface FeatureSwitch {
  feature: FeatureKind;
  label: string;
  /** False: not drawn at all (an unproven capability the strip does not offer yet). */
  shown: boolean;
  /** False: drawn, but locked at its default. */
  available: boolean;
  /** What the plan chooses with nobody touching it. */
  defaultOn: boolean;
  /** What the job will do: the default, or the operator's switch. */
  on: boolean;
  /** The operator switched it away from its default. */
  overridden: boolean;
  /** Why the default is what it is, one sentence. */
  reason: string;
  /** Something true about the switch the reason does not cover (what it does not control yet). */
  note: string | null;
  /** What it sends. */
  commands: string;
}

export interface FeatureOverrides {
  vacuum?: boolean;
  airRun?: boolean;
  autoLevel?: boolean;
  light?: boolean;
}

export interface FeatureInput {
  /** The programs' hashes, in order (null: the program has none). */
  programs: { label: string; hash: string | null }[];
  /** The hashes this machine has finished cleanly. Empty or unknown: every program is new. */
  finishedHashes: readonly string[];
  stock: { flatness: StockFlatness };
  mount: Mount;
  /** The job faces the stock first (#428's `facing` removal): the top is cut flat. */
  faced: boolean;
  /** The shallowest cut's depth, mm; null when not known. */
  shallowestCutMm: number | null;
  capabilities?: MachineCapabilities;
  overrides?: FeatureOverrides;
  autoLevelShallowMm: Sourced;
}

function sw(base: Omit<FeatureSwitch, 'on' | 'overridden'>, override: boolean | undefined): FeatureSwitch {
  const canSwitch = base.shown && base.available;
  const on = canSwitch && override !== undefined ? override : base.defaultOn;
  return { ...base, on, overridden: canSwitch && override !== undefined && override !== base.defaultOn };
}

/** Which programs the air run defaults on for: those whose hash this machine has not finished. */
export function newPrograms(programs: FeatureInput['programs'], finishedHashes: readonly string[]): boolean[] {
  const done = new Set(finishedHashes);
  return programs.map((p) => p.hash === null || !done.has(p.hash));
}

/** The auto-level rule as it will apply once #176 proves the sequence: on or off, and why. */
export function autoLevelRule(input: Pick<FeatureInput, 'stock' | 'mount' | 'faced' | 'shallowestCutMm' | 'autoLevelShallowMm'>): { on: boolean; why: string } {
  if (input.faced) return { on: false, why: 'the job faces the stock first, so its top is cut flat' };
  if (input.mount === 'tape') return { on: true, why: 'taped stock does not sit dead flat on the bed' };
  if (input.stock.flatness === 'flat') return { on: false, why: 'the stock is recorded as flat' };
  const limit = input.autoLevelShallowMm.value;
  if (input.shallowestCutMm === null) {
    return { on: true, why: `the stock is ${input.stock.flatness === 'domed' ? 'domed' : 'of unknown flatness'} and the shallowest cut's depth is not known` };
  }
  if (input.shallowestCutMm < limit) {
    return { on: true, why: `the stock is ${input.stock.flatness === 'domed' ? 'domed' : 'of unknown flatness'} and the shallowest cut (${input.shallowestCutMm} mm) is under ${limit} mm` };
  }
  return { on: false, why: `every cut is at least ${limit} mm deep, deeper than the stock's own error is likely to matter` };
}

/** The four switches, in the strip's order. */
export function machineFeatures(input: FeatureInput): FeatureSwitch[] {
  const caps = input.capabilities ?? Z1_CAPABILITIES;
  const o = input.overrides ?? {};

  const vacuum = sw(
    {
      feature: 'vacuum',
      label: 'Vacuum',
      shown: true,
      // Locked until #419 wires it: the runner sends M331 before every program regardless, so a switch
      // here that could be turned off would claim a control it does not have.
      available: false,
      defaultOn: true,
      reason: 'On for every cut — the maintainer’s default: M331 before play, M332 after.',
      note: 'Locked on: the run switches the vacuum on before every program today, and this switch takes effect only once the job flow (#419) passes it to the run.',
      commands: 'M331 / M332',
    },
    o.vacuum,
  );

  const fresh = newPrograms(input.programs, input.finishedHashes);
  const freshLabels = input.programs.filter((_, i) => fresh[i]).map((p) => p.label);
  const anyNew = freshLabels.length > 0;
  const airReason =
    input.programs.length === 0
      ? 'No program to air-run.'
      : !anyNew
        ? 'Off: this machine has already run every program in this job, unchanged (Q14 — same hash).'
        : freshLabels.length === input.programs.length
          ? `On: this machine has not run ${input.programs.length === 1 ? 'this program' : 'these programs'} before (Q14 — no finished run with ${input.programs.length === 1 ? 'its hash' : 'their hashes'}).`
          : `On for the programs this machine has not run before (${freshLabels.join(', ')}); off for the repeats (Q14 — by hash).`;
  const airRun = sw(
    {
      feature: 'air-run',
      label: 'Air run',
      shown: true,
      available: input.programs.length > 0,
      defaultOn: anyNew,
      reason: airReason,
      note: null,
      commands: 'the program raised clear of the stock',
    },
    o.airRun,
  );
  // The default is per program (new ones only); an explicit switch applies to every program, so it is
  // an override even when it matches the job-level default.
  if (airRun.available && o.airRun !== undefined) airRun.overridden = fresh.some((f) => f !== o.airRun);

  const rule = autoLevelRule(input);
  const autoLevel = caps.autoLevel.proven
    ? sw(
        {
          feature: 'auto-level',
          label: 'Auto-level',
          shown: true,
          available: true,
          defaultOn: rule.on,
          reason: `${rule.on ? 'On' : 'Off'}: ${rule.why}.`,
          note: null,
          commands: caps.autoLevel.commands,
        },
        o.autoLevel,
      )
    : sw(
        {
          feature: 'auto-level',
          label: 'Auto-level',
          shown: true,
          available: false,
          defaultOn: false,
          reason: `Off until ${caps.autoLevel.gate} proves G32 R1 / M370 on this machine (Q13). Once it does, this job would have it ${rule.on ? 'on' : 'off'}: ${rule.why}.`,
          note: null,
          commands: caps.autoLevel.commands,
        },
        o.autoLevel,
      );

  const light = sw(
    caps.light.proven
      ? {
          feature: 'light',
          label: 'Light',
          shown: true,
          available: true,
          defaultOn: true,
          reason: 'On while the job runs, so the camera and the operator can see (Q18).',
          note: null,
          commands: caps.light.commands,
        }
      : {
          feature: 'light',
          label: 'Light',
          shown: false,
          available: false,
          defaultOn: false,
          reason: `Not offered until the ${caps.light.gate} bench check sees M821 / M822 work from our console (Q18); then it is on while a job runs.`,
          note: null,
          commands: caps.light.commands,
        },
    o.light,
  );

  return [vacuum, airRun, autoLevel, light];
}
