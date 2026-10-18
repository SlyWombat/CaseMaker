// The verified program a job produces, and the app's own verdict on it (#477).
//
// `casemaker machine upload` must hand the machine a program that has passed the same gates the
// app's Upload button enforces (#395): generate → simulate → oracle → `uploadBlocker`. This module
// is that pipeline as a function. It is the body of `scripts/machine-upload-check.ts`, which had to
// be a script because it is driven from a terminal; the CLI needs it as a library, and a second
// copy of a safety rule is the kind of duplicate this codebase refuses to keep.
//
// WHAT IT DOES NOT DO. It writes nothing to disk and sends nothing to a machine. It returns the
// bytes, the verifier's report, the program hash and the gate's sentence; the caller decides what
// its own command may do with them.
//
// THE GATE IS THE APP'S. `uploadBlocker` is the function that disables the Upload button, and
// `requiredAckCodes` is the list it reads. Nothing here re-lists the conditions.

import { readFileSync } from 'node:fs';

import { bootstrap } from '../../../src/platform/headless/bootstrap';
import { engraveGenerate, type EngraveFailure, type EngraveStage } from '../../../src/workers/sim/engraveGenerate';
import { createSimSession, type SimDiagnostic } from '../../../src/workers/sim/session';
import { simErrors } from '../../../src/engine/cnc/simGate';
import { runSheetFileName } from '../../../src/engine/cnc/engrave/runSheet';
import { jobTool, toSetup, type JobFinding } from '../../../src/engine/cnc/engrave/jobSetup';
import {
  jobMachine,
  parseMachineCalibration,
  type MachineCalibration,
} from '../../../src/engine/cnc/calibration';
import {
  effectiveMargins,
  MARGIN_DEFAULTS,
  type MarginSettings,
} from '../../../src/engine/cnc/engrave/depthBounds';
import type { EngraveMargins } from '../../../src/types/engraveJob';
import type { OracleReport } from '../../../src/engine/cnc/engrave/oracle';
import { programHash } from '../../../src/engine/cnc/programHash';
import type { VerifyReport } from '../../../src/engine/cnc/verify';
import { parseEngraveJob } from '../../../src/store/engraveJobSchema';
import { parseMyMachineFile } from '../../../src/store/myMachineFile';
import {
  requiredAckCodes,
  uploadBlocker,
  type EngraveRunView,
} from '../../../src/store/engraveRunGate';
import type { SimStatus } from '../../../src/store/simStore';

/** A program generated from a job, with every gate's answer attached. */
export interface PreparedProgram {
  jobPath: string;
  jobName: string;
  /** The `.nc` name the app would give it (`runSheetFileName`). */
  filename: string;
  nc: string;
  verify: VerifyReport;
  /** The generate stage that produced it (`done`), for the receipt. */
  stage: EngraveStage;
  /** The generator's own `ok` flag. */
  ok: boolean;
  /** The generator's stage-failure messages, for the receipt. */
  errors: EngraveFailure[];
  /** `programHash(nc)` — the FNV key `--confirm` names and `finishedPrograms` records. */
  hash: string;
  findings: JobFinding[];
  sim: {
    status: SimStatus;
    diagnostics: SimDiagnostic[];
    oracle: OracleReport | null;
  };
  margins: EngraveMargins;
  /** The machine profile the program was posted and swept against. */
  machineId: string;
  /** Where the depth margins came from, for the receipt. */
  marginsFrom: string;
  /** Where the machine profile came from, or null when it is the shipped one. */
  calibrationNote: string | null;
  /** The clearance codes the app's gate asks a person to acknowledge. */
  requiredAcks: string[];
  /**
   * `--acknowledge` did not name exactly `requiredAcks`. A usage error, so a command refuses it
   * before sending anything.
   */
  ackError: string | null;
  /** The app's own sentence when it would disable Upload, or null when it would allow it. */
  blocker: string | null;
}

export type PrepareResult =
  | { ok: true; program: PreparedProgram }
  | {
      ok: false;
      stage: string;
      reason: string;
      /**
       * What `engraveGenerate` produced, when the run reached it. The bench script prints its
       * `stage`/`verify` report before it says "no usable cutter" or "no program", so a refusal that
       * happened AFTER generation must carry the report along for it to print. Absent for a
       * pre-generate failure (an unparseable job, an unreadable record).
       */
      generated?: {
        stage: EngraveStage;
        ok: boolean;
        verify: VerifyReport | null;
        errors: EngraveFailure[];
        findings: JobFinding[];
      };
    };

export interface PrepareOptions {
  /** The app's exported "my machine" record (#247) — its depth margins are the house's (#345). */
  myMachine?: string;
  /** The app's saved machine calibration (#279). Absent: the shipped profile, as the app uses. */
  calibration?: string;
  /** The codes `--acknowledge` named, or null when the caller said nothing. */
  acknowledged: string[] | null;
}

function savedCalibration(path: string | undefined): MachineCalibration | null {
  if (path === undefined) return null;
  const parsed = parseMachineCalibration(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.ok) throw new Error(`${path} is not a calibration record: ${parsed.reason}`);
  return parsed.calibration;
}

function houseMargins(path: string | undefined): { margins: MarginSettings; from: string } {
  if (path === undefined) {
    return { margins: MARGIN_DEFAULTS, from: 'the shipped defaults (no --my-machine)' };
  }
  const record = parseMyMachineFile(readFileSync(path, 'utf8'));
  if (!record.ok) throw new Error(`${path} is not a machine record: ${record.reason}`);
  if (record.margins === null) {
    throw new Error(
      `${path} carries no margins (it was exported before #345) — pass a current one, or leave --my-machine off for the shipped defaults`,
    );
  }
  return { margins: record.margins, from: path };
}

/**
 * Turn one job document into the program the app would upload, or the reason it would not.
 *
 * `ok: false` means no program exists (the job did not parse, there was no cutter, the generator
 * stopped). `ok: true` with a non-null `blocker` means a program exists and the app's own upload
 * gate still refuses it — the caller must not send it, and the sentence says why.
 */
export async function prepareVerifiedProgram(
  jobPath: string,
  opts: PrepareOptions,
): Promise<PrepareResult> {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(jobPath, 'utf8')));
  if (!parsed.ok) {
    return { ok: false, stage: 'job', reason: `${jobPath} is not a valid job document: ${parsed.errors.join('; ')}` };
  }
  const job = parsed.job;

  const calibration = savedCalibration(opts.calibration);
  const house = houseMargins(opts.myMachine);
  const margins = effectiveMargins(job, house.margins);
  // The wasm module and the bundled fonts (a job with text engraves here too), the same bootstrap
  // every headless command starts with (#476).
  const { manifold: tl } = await bootstrap();

  // `jobTool` reads the registry, so it must come after the bootstrap.
  const tool = jobTool(job);
  const mill = jobMachine(job, calibration);
  const catalogue: never[] = [];
  // Generate even with no cutter: the bench script prints the `stage`/`verify` report before it
  // says "no usable cutter", so the refusal below must carry what `engraveGenerate` produced.
  const generated = engraveGenerate(tl, job, tool, catalogue, calibration, margins);
  if (tool === null) {
    return {
      ok: false,
      stage: 'findings',
      reason: 'the job has no usable cutter — nothing is swept or prepared',
      generated: {
        stage: generated.stage,
        ok: generated.ok,
        verify: generated.verify,
        errors: generated.errors,
        findings: generated.findings,
      },
    };
  }

  const run: { simStatus: SimStatus; simDiagnostics: SimDiagnostic[]; oracle: OracleReport | null } = {
    simStatus: 'idle',
    simDiagnostics: [],
    oracle: null,
  };
  const programNc = generated.ok ? generated.nc : null;
  if (programNc !== null) {
    const session = createSimSession(tl);
    try {
      const sim = session.load(programNc, toSetup(job, mill), tool, mill.id, { calibration });
      run.simStatus = sim.ok ? 'ready' : 'refused';
      run.simDiagnostics = sim.diagnostics;
      if (sim.ok) run.oracle = session.oracle(generated.predicted);
    } finally {
      session.dispose();
    }
  }

  const acknowledged = opts.acknowledged !== null;
  const view: EngraveRunView = {
    generated,
    oracle: run.oracle,
    simDiagnostics: run.simDiagnostics,
    simStatus: run.simStatus,
    phase: run.oracle?.ok ? 'ready' : 'blocked',
    acknowledged,
    staleSince: null,
    error: null,
  };
  const requiredAcks = requiredAckCodes(view);
  let ackError: string | null = null;
  if (opts.acknowledged !== null) {
    const missing = requiredAcks.filter((c) => !opts.acknowledged!.includes(c));
    const extra = opts.acknowledged.filter((c) => !requiredAcks.includes(c));
    if (missing.length > 0 || extra.length > 0) {
      ackError =
        `--acknowledge must name exactly the codes this run asks for: ` +
        `${requiredAcks.length > 0 ? requiredAcks.join(', ') : '(none)'}` +
        (missing.length > 0 ? ` — not named: ${missing.join(', ')}` : '') +
        (extra.length > 0 ? ` — named but not asked for: ${extra.join(', ')}` : '');
    }
  }

  if (generated.nc === null || generated.verify === null) {
    return {
      ok: false,
      stage: generated.stage,
      reason: `no program, or no verifier report — the run stopped at ${generated.stage}`,
      generated: {
        stage: generated.stage,
        ok: generated.ok,
        verify: generated.verify,
        errors: generated.errors,
        findings: generated.findings,
      },
    };
  }

  const program: PreparedProgram = {
    jobPath,
    jobName: job.name,
    filename: runSheetFileName(job.name),
    nc: generated.nc,
    verify: generated.verify,
    stage: generated.stage,
    ok: generated.ok,
    errors: generated.errors,
    hash: programHash(generated.nc),
    findings: generated.findings,
    sim: { status: run.simStatus, diagnostics: run.simDiagnostics, oracle: run.oracle },
    margins,
    machineId: mill.id,
    marginsFrom: job.margins ? "this job's own record" : house.from,
    calibrationNote:
      calibration === null ? null : `calibrated ${calibration.measuredAt} — ${calibration.source}`,
    requiredAcks,
    ackError,
    blocker: uploadBlocker(view),
  };
  return { ok: true, program };
}

/** The sim's error diagnostics, for a caller that wants them named rather than counted. */
export function simulationErrors(program: PreparedProgram): SimDiagnostic[] {
  return simErrors(program.sim.diagnostics);
}
