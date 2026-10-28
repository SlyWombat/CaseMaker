/**
 * ONE PROGRAM SWEEP, SHARED BY THE APP AND THE COMMAND LINE (#744, extracted from #733 item 4).
 *
 * The safety rule is the same in both realms and must not be stated twice: every program of a
 * generated run is swept, in cut order, each on the stock the earlier ones left, with its OWN
 * cutter and its own drill point — and a program whose sweep reports an error stops the run. Before
 * #733 the command line swept only program 1; before #744 the app did. A later cutter's rapid
 * through stock, or its holder in the fixture, went unseen in one realm or the other.
 *
 * So the walk itself lives here. It owns the cut order, the cumulative seed, the per-program tool
 * and point, the simulator's own refusal to seed a program (the column engine and indexed rotary
 * cannot start from a previous program's material — those programs are re-swept from the blank and
 * SAID SO), and the #393 gate (`simulationProblem`, not `load.ok`). It owns no session and no
 * wasm: `load` is the caller's own load, so the command line hands it a synchronous
 * `createSimSession` call and the app hands it the sim store's async load. That is what keeps this
 * module importable by `scripts/lib/casemaker/engrave.ts` and by the web bundle's run store at
 * once.
 *
 * It also does not union the seed meshes: the CALLER's load is handed the list, and each realm
 * performs the subtraction in its own session (`session.load` unions the list; the command line's
 * session does too). One seed semantic, both realms.
 */

import type { Tool } from '@/engine/cnc/tool';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { SimDiagnostic, SimLoadOk, SimLoadResult } from '@/workers/sim/session';
import { simErrors, simulationProblem } from '@/engine/cnc/simGate';

/** The part of a generated program this walk reads. `EngraveProgram` satisfies it structurally. */
export interface SweepProgram {
  kind?: 'facing' | 'engrave';
  toolKey: string;
  nc: string;
  /** The point angle the CAM planned for THIS program, when it is the drill bit's (#434). */
  drill?: { simDrillPoint: { deg: number; source: string } | null } | null;
}

export interface SweepDrillPoint {
  deg: number;
  source: string;
}

/** One program's successful sweep, reduced to what a run gate, a panel or a run sheet reads. */
export interface ProgramSweepResult {
  /** Index into the caller's `programs` array — the generator's own cut order. */
  index: number;
  /** 1-based among ENGRAVING programs, the run sheet's numbering; null for the facing pass. */
  program: number | null;
  /** `program 2 (flat-3.175x12)` or `the facing pass (flat-3.175x12)` — the one wording. */
  label: string;
  toolKey: string;
  outcome: 'swept';
  engine: 'exact' | 'column';
  count: number;
  removedVolume: number;
  errorCount: number;
  /** The load's diagnostics, exactly as the sweep raised them (unprefixed). */
  diagnostics: SimDiagnostic[];
  /** The simulator's own "swept from the blank" notes, when this program could not be seeded. */
  notes: SimDiagnostic[];
  fromBlank: boolean;
  fromBlankCode: string | null;
  /** The FLAT dexel grid this program was swept on, mm; null for an exact or rotary sweep. */
  gridPitchMm: number | null;
  /** This program's own removal. Kept private to the walk; summaries below drop it. */
  removal: NodeMeshOutput | null;
}

/** The light, store/sheet-safe projection of a sweep — no mesh. */
export interface ProgramSweepSummary extends Omit<ProgramSweepResult, 'outcome' | 'engine' | 'removal'> {
  outcome: 'swept' | 'path-only' | 'refused';
  engine: 'exact' | 'column' | null;
}

/** The program whose sweep stopped the walk, in the same words the rest of the run uses. */
export interface ProgramSweepFailure {
  index: number;
  program: number | null;
  label: string;
  toolKey: string;
  /**
   * `diagnostics` — the load swept but reported an ERROR (`simulationProblem`, #393);
   * `refused` — the simulator refused the load (no material);
   * `no-cutter` — the program names a cutter this realm does not have.
   */
  kind: 'diagnostics' | 'refused' | 'no-cutter';
  pathOnly: boolean;
  diagnostics: SimDiagnostic[];
  /** The failing program's sweep when the load DID sweep (kind `diagnostics`); null otherwise. */
  sweep: ProgramSweepResult | null;
}

export interface ProgramSweepOk {
  ok: true;
  sweeps: ProgramSweepResult[];
  /** The cumulative removal the run leaves, one entry per program that removed material. */
  priorRemoval: NodeMeshOutput[];
}

export interface ProgramSweepFailed {
  ok: false;
  /** True when `aborted` (or a load that returned null) stopped the walk — not a failure. */
  cancelled: boolean;
  sweeps: ProgramSweepResult[];
  failed: ProgramSweepFailure | null;
  priorRemoval: NodeMeshOutput[];
}

export type ProgramSweepOutcome = ProgramSweepOk | ProgramSweepFailed;

/** What one `load` call is handed. Everything else (setup, calibration, threads, floor) is the caller's. */
export interface ProgramLoadArgs<P extends SweepProgram = SweepProgram> {
  program: P;
  index: number;
  cutter: Tool;
  /** The point this program's plan used, or the realm's shop default; null when neither exists. */
  drillPoint: SweepDrillPoint | null;
  /** The cumulative material left by earlier programs; EMPTY for a from-blank sweep. */
  priorRemoval: readonly NodeMeshOutput[];
  /** True only on the retry of a program the simulator refused to seed. */
  fromBlank: boolean;
}

export interface SweepProgramsOptions<P extends SweepProgram = SweepProgram> {
  programs: readonly P[];
  /** The fallback point for a program that states none (the command line's shop reading). */
  shopDrillPoint?: SweepDrillPoint | null;
  /** The program's own cutter. A null is the `no-cutter` failure. */
  cutterFor: (program: P, index: number) => Tool | null;
  /**
   * Load and sweep one program. `null` means this walk no longer owns the session (a newer load
   * superseded it) and stops the walk as `cancelled`.
   */
  load: (args: ProgramLoadArgs<P>) => Promise<SimLoadResult | null>;
  /**
   * Called after a program swept and BEFORE the next program loads — while this program is still
   * the session's live one. The app's oracle uses it; the command line captures program 1's full
   * `SimLoadOk` here.
   */
  afterLoad?: (args: ProgramLoadArgs<P> & { result: SimLoadOk; sweep: ProgramSweepResult }) => void | Promise<void>;
  /** The rest route's seed: material an EARLIER run left (the command line's two-tool rest pass). */
  initialRemoval?: readonly NodeMeshOutput[];
  /** Checked between programs, so a superseded app run stops before loading the next one. */
  aborted?: () => boolean;
}

/** The 1-based engraving ordinal (the run sheet's numbering), or null for the facing pass. */
export function programOrdinal(programs: readonly SweepProgram[], index: number): number | null {
  const target = programs[index];
  if (target === undefined || (target.kind ?? 'engrave') === 'facing') return null;
  let ordinal = 0;
  for (let i = 0; i <= index; i++) {
    const p = programs[i];
    if (p !== undefined && (p.kind ?? 'engrave') !== 'facing') ordinal += 1;
  }
  return ordinal;
}

/**
 * How a program is named to an operator: `program 2 (flat-3.175x12)` — the run sheet's Cut
 * numbering — and `the facing pass (…)` for the skim. One function, so the sweep note, the app's
 * diagnostic prefix and the sheet cannot number the same program differently.
 */
export function programLabel(programs: readonly SweepProgram[], index: number): string {
  const program = programs[index];
  if (program === undefined) return `program ${index + 1}`;
  if ((program.kind ?? 'engrave') === 'facing') return `the facing pass (${program.toolKey})`;
  return `program ${programOrdinal(programs, index) ?? index + 1} (${program.toolKey})`;
}

/** The flat column grid's Y pitch a load ran on, mm; null for an exact or rotary sweep. */
export function gridPitchMmOf(load: SimLoadOk): number | null {
  return load.stats.engine === 'column' && load.summary.rotary !== true && typeof load.stats.resolution?.dThetaDeg === 'number'
    ? load.stats.resolution.dThetaDeg
    : null;
}

/** A sweep as the store and the run sheet keep it — without the removal mesh. */
export function sweepSummary(sweep: ProgramSweepResult): ProgramSweepSummary {
  const { removal: _removal, ...summary } = sweep;
  return summary;
}

/** A refused/path-only program as a summary, so a stopped run still names the program that stopped. */
export function refusalSummary(failure: ProgramSweepFailure): ProgramSweepSummary {
  return {
    index: failure.index,
    program: failure.program,
    label: failure.label,
    toolKey: failure.toolKey,
    outcome: failure.pathOnly ? 'path-only' : 'refused',
    engine: null,
    count: 0,
    removedVolume: 0,
    errorCount: simErrors(failure.diagnostics).length,
    diagnostics: failure.diagnostics,
    notes: [],
    fromBlank: false,
    fromBlankCode: null,
    gridPitchMm: null,
  };
}

/** The two codes the session raises when it cannot start from another program's material. */
const PRIOR_REFUSAL_CODES: ReadonlySet<string> = new Set(['prior-removal-column', 'prior-removal-rotary']);

/**
 * Sweep every program, in cut order, on the stock the earlier ones left (#744/#733 item 4).
 *
 * Stops at the first program that fails, exactly as the command line has since #733: the run is
 * refused, and the caller reports THAT program's sentence. A later program could add more, but a
 * sentence naming the first real failure is the one an operator can act on.
 */
export async function sweepPrograms<P extends SweepProgram>(options: SweepProgramsOptions<P>): Promise<ProgramSweepOutcome> {
  const sweeps: ProgramSweepResult[] = [];
  let priorRemoval: NodeMeshOutput[] = [...(options.initialRemoval ?? [])];

  const stop = (): ProgramSweepFailed => ({ ok: false, cancelled: true, sweeps, failed: null, priorRemoval });

  for (const [index, program] of options.programs.entries()) {
    if (options.aborted?.()) return stop();
    const label = programLabel(options.programs, index);
    const base = { index, program: programOrdinal(options.programs, index), label, toolKey: program.toolKey };

    const cutter = options.cutterFor(program, index);
    if (cutter === null) {
      const failure: ProgramSweepFailure = {
        ...base,
        kind: 'no-cutter',
        pathOnly: false,
        diagnostics: [
          {
            source: 'sweep',
            severity: 'error',
            code: 'tool-refused',
            message: `${label} names ${program.toolKey}, which is not on this bench`,
          },
        ],
        sweep: null,
      };
      return { ok: false, cancelled: false, sweeps, failed: failure, priorRemoval };
    }

    const drillPoint = program.drill?.simDrillPoint ?? options.shopDrillPoint ?? null;
    const seed = priorRemoval;
    const args: ProgramLoadArgs<P> = { program, index, cutter, drillPoint, priorRemoval: seed, fromBlank: false };
    let load = await options.load(args);
    if (load === null) return stop();
    if (options.aborted?.()) return stop();

    const notes: SimDiagnostic[] = [];
    let fromBlank = false;
    let fromBlankCode: string | null = null;
    if (!load.ok && seed.length > 0) {
      const refused = load.diagnostics.find((d) => PRIOR_REFUSAL_CODES.has(d.code));
      if (refused !== undefined) {
        // The simulator cannot start from the previous program's material. Sweeping the blank is
        // still a real check — fixture, stock and rapid collisions — so it is done, and the note
        // says the result covers this program's own cuts only. Refusing a good drill or V job over
        // a limitation of the sweep is not the safety rule this walk exists for.
        const retry: ProgramLoadArgs<P> = { ...args, priorRemoval: [], fromBlank: true };
        load = await options.load(retry);
        if (load === null) return stop();
        if (load.ok) {
          fromBlank = true;
          fromBlankCode = refused.code;
          notes.push({
            source: 'sweep',
            severity: 'info',
            code: refused.code,
            message: `${label} was swept from the blank: this program’s engine cannot start from the material the previous program left, so its result covers its own cuts only`,
          });
        }
      }
    }

    if (!load.ok) {
      const failure: ProgramSweepFailure = {
        ...base,
        kind: 'refused',
        pathOnly: load.pathOnly,
        diagnostics: load.diagnostics,
        sweep: null,
      };
      return { ok: false, cancelled: false, sweeps, failed: failure, priorRemoval };
    }

    // #393 — `ok` means the sweep produced material, NOT that the program is safe. A rapid through
    // the fixture is `ok: true` with an error diagnostic, because the panel must draw that cut.
    const problem = simulationProblem(load.diagnostics);
    const sweep: ProgramSweepResult = {
      ...base,
      outcome: 'swept',
      engine: load.stats.engine,
      count: load.count,
      removedVolume: load.stats.removedVolume,
      errorCount: simErrors(load.diagnostics).length,
      diagnostics: load.diagnostics,
      notes,
      fromBlank,
      fromBlankCode,
      gridPitchMm: gridPitchMmOf(load),
      removal: load.meshes.removal,
    };
    if (problem !== null) {
      const failure: ProgramSweepFailure = {
        ...base,
        kind: 'diagnostics',
        pathOnly: false,
        diagnostics: load.diagnostics,
        sweep,
      };
      return { ok: false, cancelled: false, sweeps, failed: failure, priorRemoval };
    }

    sweeps.push(sweep);
    if (load.meshes.removal !== null) priorRemoval = [...priorRemoval, load.meshes.removal];
    // The hook sees the load THAT RAN: a retried program was loaded from the blank, not with the
    // seed the first attempt was handed.
    await options.afterLoad?.({ ...args, priorRemoval: fromBlank ? [] : seed, fromBlank, result: load, sweep });
    if (options.aborted?.()) return stop();
  }

  return { ok: true, sweeps, priorRemoval };
}
