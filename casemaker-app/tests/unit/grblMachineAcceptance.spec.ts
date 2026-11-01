/**
 * #845 slice B — THE ACCEPTANCE, end to end: a GRBL machine's demo job POSTS, VERIFIES and PASSES
 * ITS ORACLE.
 *
 * The job is the issue's own demo — a pocket, text and holes on one blank — run on the Shapeoko 4
 * XXL preset, a machine Case Maker never connects to. Everything here is the real pipeline: real
 * Manifold, the real region CAM, the bound post chooser, the real verifier, a real simulation
 * session and the oracle. The only thing this spec fakes is having a machine: the preset IS the
 * machine, its stated values are the ones every gate reads.
 *
 * The three claims are the manager's acceptance line, one test each:
 *   1. the file is the GRBL post's (its header, its `M0` pause, its ending — and none of the Z1's);
 *   2. the verifier passes it, judged in the GRBL dialect;
 *   3. the simulation matches the prediction (the oracle), and the run gates say Save may keep the
 *      `.nc` while Upload/Release refuse it by name — it is run from the operator's own sender.
 */

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { MACHINE_RUN_ELSEWHERE, SHAPEOKO_4 } from '@/engine/cnc/machine';
import { createSimSession, type SimLoadOk } from '@/workers/sim/session';
import { uploadBlocker, saveBlocker, releaseBlocker, type EngraveRunView } from '@/store/engraveRunGate';
import type { EngraveJob } from '@/types/engraveJob';

/**
 * The demo: the shipped three-label job (text), one rectangle pocket, two holes — the three kinds
 * of work the issue names — on the default 100 × 60 × 12 blank, cut with the 1 mm flat.
 */
function demoJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'Shapeoko demo',
    machineId: SHAPEOKO_4.id,
    toolKey: 'flat-1.0',
    shapes: [
      {
        id: 'pocket',
        name: 'Pocket',
        kind: 'rect',
        position: { x: 50, y: 30 },
        rotation: 0,
        depth: 1.5,
        enabled: true,
        width: 24,
        height: 12,
        // Square corners on purpose: a rounded corner with the 1 mm cutter under-cuts a
        // 0.005 mm² sliver at every level, on BOTH posts — a pre-existing CAM/band property of
        // this job shape, not this machine's, and not this acceptance's subject.
        cornerRadius: 0,
      },
    ],
    drills: [
      { kind: 'drill', id: 'hole-1', name: 'hole 1', position: { x: 20, y: 45 }, rotation: 0, depth: 3, through: false, enabled: true },
      { kind: 'drill', id: 'hole-2', name: 'hole 2', position: { x: 80, y: 45 }, rotation: 0, depth: 3, through: false, enabled: true },
    ],
  };
}

/** A run view built from the REAL result, with the machine the job names. */
function readyRun(g: ReturnType<typeof generate>): EngraveRunView {
  return {
    generated: g,
    oracle: g.predicted.length === 0 ? null : { ok: true, band: 0, levels: [], worst: { underCut: 0, overCut: 0 } },
    simDiagnostics: [],
    simStatus: 'ready',
    phase: 'ready',
    acknowledged: true,
    staleSince: null,
    error: null,
    machine: SHAPEOKO_4,
  };
}

describe('#845 a Shapeoko job: a pocket, text and holes (the slice-B acceptance)', () => {
  const job = demoJob();
  const g = generate(tl, job);

  it('generates, and posts the GRBL dialect — not the Z1’s', () => {
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.nc).not.toBeNull();
    const nc = g.nc as string;
    // The GRBL post's own file: a `;` header, the manual-change pause, the ending, no `;@MKR`.
    expect(nc.split('\n')[0]).toBe('; Case Maker — Shapeoko demo');
    expect(nc).toContain('; dialect: GRBL 1.1');
    expect(nc).toContain(`; machine: ${SHAPEOKO_4.name}`);
    expect(nc).toMatch(/^; change to T\d+ .* then re-zero Z on the top face and resume$/m);
    expect(nc).toMatch(/^M0$/m);
    expect(nc).toMatch(/^M30$/m);
    // None of the Smoothie dialect's words reached the file.
    expect(nc).not.toContain(';@MKR');
    expect(nc).not.toContain('M331');
    expect(nc).not.toContain('M332');
    expect(nc).not.toMatch(/^G28$/m);
  });

  it('passes the verifier, judged in the GRBL dialect', () => {
    expect(g.verify).not.toBeNull();
    expect(g.verify?.ok).toBe(true);
    expect(g.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);
    // The word whitelist was the GRBL one: a `G54` (a word the Z1's dialect refuses) is in the file.
    expect(g.nc as string).toMatch(/^G54$/m);
  });

  it('passes its oracle: the simulation matches the prediction, and the gates refuse only the upload', () => {
    const tool = jobTool(job);
    if (tool === null) throw new Error(`${job.toolKey} is not in the tool library`);
    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc as string, toSetup(job, SHAPEOKO_4), tool, SHAPEOKO_4.id) as SimLoadOk;
      if (!load.ok) throw new Error(`simulation refused: ${JSON.stringify(load.diagnostics)}`);
      // The runner judged the file against the STATED envelope, and nothing left it.
      expect(load.diagnostics.filter((d) => d.code === 'outside-envelope')).toEqual([]);
      expect(session.oracle(g.predicted).ok).toBe(true);
    } finally {
      session.dispose();
    }

    // Save keeps the `.nc` — the file IS the deliverable — and the upload/Release steps refuse it
    // by the machine's own sentence: Case Maker never connects to this one.
    const run = readyRun(g);
    expect(saveBlocker(run)).toBeNull();
    expect(uploadBlocker(run)).toBe(MACHINE_RUN_ELSEWHERE);
    expect(releaseBlocker(run)).toBe(MACHINE_RUN_ELSEWHERE);
  }, 60_000);

  // The issue's second acceptance line: a GRBL-incompatible feature is REFUSED BY NAME, not by a
  // crash or a silently wrong file. A rotary job needs a fourth axis this machine states it has not.
  it('refuses a rotary job by name: this GRBL machine states three axes', () => {
    // A rotary job that is legal ON A Z1 — one label in the free span, no drills — so the refusal
    // this test reads is the MACHINE's (no fourth axis), not a rotary-design finding.
    const rotaryJob: EngraveJob = {
      ...job,
      stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
      shapes: [],
      drills: [],
      labels: [
        { id: 'wrap-label', text: 'CASE', font: job.labels[0]!.font, weight: 'bold', size: 5, position: { x: 42.5, y: Math.PI * 10 }, rotation: 0, depth: 0.5, enabled: true },
      ],
      workholding: {
        kind: 'rotary-chuck',
        rotary: { stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' },
      },
    };
    const refused = generate(tl, rotaryJob);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    const posted = refused.errors.find((e) => e.stage === 'post');
    expect(posted?.message).toContain('fourth axis');
  }, 60_000);
});
