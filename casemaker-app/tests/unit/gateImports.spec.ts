/**
 * #964 / #956 R1 — THE GATE'S INDEPENDENCE, BY TRANSITIVE IMPORT.
 *
 * The gate must judge the CAM without using the CAM's own geometry (#924's B1: "the app's own
 * check passes because it compares the simulation with the app's plan"). A direct-import rule
 * cannot see the coupling that matters: `designCheck.ts` imports helpers from `oracle.ts`, and
 * `oracle.ts` imports the CAM's cone (`vProfile.ts`) and its sweep (`partPlan.ts`) — so the gate
 * grades the CAM with the CAM's math while every direct import looks innocent. This spec follows
 * VALUE imports transitively and treats type-only imports as erased (they are), and forbids, in
 * each gate root's closure:
 *
 *   - `engine/cnc/cam/**` (including the rebuilt `cam/model/**`);
 *   - `engine/cnc/vProfile.ts` (the CAM's cone);
 *   - `engine/cnc/partPlan.ts` (the CAM's sweep).
 *
 * GATE ROOTS (A's R1, #956): `goalCheckField.ts`, `designCheck.ts`, `goalCoverage.ts`,
 * `goalCheckInput.ts`, and the heightfield module when #967 extracts it. NOT `oracle.ts` — its
 * area comparison is the CAM-predicted check by design and is labelled as that.
 *
 * THE ALLOWLIST is a TRUST BOUNDARY, not a hole in the walk's data: a shared module on the list
 * is the definition the gate is allowed to use — placement of the goal (`targetPlace`,
 * `jobSetup`, `targetScale`), the simulator the gate reads the posted NC through
 * (`columnEngine`/`sweep`), the Manifold toplevel (`evaluateOp`), `arcResolution`, and the app's
 * types. The walk records that it reached one and does not enter it; the list is asserted below,
 * so widening it is a reviewed act. Without the boundary the rule would be vacuous: the placement
 * module itself reaches the job model, which knows the CAM.
 *
 * TODAY (main aba577f9, 2026-11-04) the rule fails on two roots, both expected and both owned:
 *   - `goalCheckField.ts` imports `sampleGoalHeightfield`/`isMold`/`moldHeightfield` as VALUES
 *     from `cam/surface3d.ts` — the extraction is #967 (C, lands before #966);
 *   - `designCheck.ts` reaches `oracle.ts`, which reaches `vProfile.ts` (and, through
 *     `rotary/wrap` and `stockStart`, `cam/ir.ts` and `cam/tabSettings.ts`) — A splits the
 *     helpers into `oracleTypes.ts` in the #924 candidate.
 * Both cases are `it.fails` so main stays green: the change that fixes each one flips its case to
 * `it`, and this spec then guards it.
 *
 * One more rule from A's R1, kept here: `cam/model/**` must NEVER import the extracted heightfield
 * module — the rebuild's whole point is that the engine stops planning on the field the gate
 * measures with.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readImports, valueImportClosure, type ClosureEntry } from '../tools/importGraph';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const SRC = join(APP, 'src');

/** A's R1 gate roots. The heightfield module is conditional until #967 extracts it. */
const GATE_ROOTS = [
  'workers/sim/goalCheckField.ts',
  'engine/cnc/engrave/designCheck.ts',
  'engine/cnc/engrave/goalCoverage.ts',
  'engine/cnc/engrave/goalCheckInput.ts',
] as const;

/** #967's destination for `GoalHeightfield`, `sampleGoalHeightfield`, `isMold`, `moldHeightfield`. */
const HEIGHTFIELD_MODULE = 'engine/cnc/engrave/goalHeightfield.ts';

/** The shared-module allowlist: definitions the gate may use; the walk does not enter them. */
const ALLOWED_SHARED = new Set([
  'engine/compiler/arcResolution.ts',
  'workers/geometry/evaluateOp.ts', // the Manifold toplevel
  'workers/geometry/columnEngine.ts', // the simulator
  'workers/geometry/sweep.ts', // the simulator
  'engine/cnc/engrave/jobSetup.ts', // placement: the goal is defined, not judged, here
  'engine/cnc/engrave/targetPlace.ts', // placement
  'engine/cnc/engrave/targetScale.ts', // placement
]);

const isForbidden = (file: string): boolean =>
  file.startsWith('engine/cnc/cam/') || file === 'engine/cnc/vProfile.ts' || file === 'engine/cnc/partPlan.ts';

const forbiddenIn = (closure: { files: Map<string, ClosureEntry> }): ClosureEntry[] =>
  [...closure.files.values()].filter((entry) => isForbidden(entry.file));

const reportOf = (entries: readonly ClosureEntry[]): string =>
  entries.map((entry) => `${entry.file}  ←  ${entry.chain.join(' -> ')}`).join('\n');

describe('#964 the gate roots and the allowlist', () => {
  it('names gate roots that exist', () => {
    for (const root of GATE_ROOTS) expect(existsSync(join(SRC, root))).toBe(true);
  });

  it('keeps the allowlist to the shared definitions A ruled on', () => {
    expect([...ALLOWED_SHARED].sort()).toEqual([
      'engine/cnc/engrave/jobSetup.ts',
      'engine/cnc/engrave/targetPlace.ts',
      'engine/cnc/engrave/targetScale.ts',
      'engine/compiler/arcResolution.ts',
      'workers/geometry/columnEngine.ts',
      'workers/geometry/evaluateOp.ts',
      'workers/geometry/sweep.ts',
    ]);
  });

  it('the graph reads value imports and skips type-only ones', () => {
    // designCheck → oracle is a VALUE import and must be in the closure.
    const design = valueImportClosure(['engine/cnc/engrave/designCheck.ts'], SRC, ALLOWED_SHARED);
    expect(design.files.has('engine/cnc/engrave/oracle.ts')).toBe(true);
    // goalCoverage imports only the GoalHeightfield TYPE from cam/surface3d; it must not be.
    const coverage = valueImportClosure(['engine/cnc/engrave/goalCoverage.ts'], SRC, ALLOWED_SHARED);
    expect(coverage.files.has('engine/cnc/cam/surface3d.ts')).toBe(false);
  });
});

describe('#964 the gate’s value-import closure carries no CAM', () => {
  // RED-FIRST: these two are the slices that make the rule true. Flip each to `it` in the change
  // that lands its fix (the failure message then names anything that regresses).
  it.fails('goalCheckField — clean once #967 extracts the heightfield module', () => {
    const closure = valueImportClosure(['workers/sim/goalCheckField.ts'], SRC, ALLOWED_SHARED);
    const bad = forbiddenIn(closure);
    expect(bad, `forbidden CAM imports:\n${reportOf(bad)}`).toEqual([]);
  });

  it.fails('designCheck — clean once A’s oracleTypes split lands (#924)', () => {
    const closure = valueImportClosure(['engine/cnc/engrave/designCheck.ts'], SRC, ALLOWED_SHARED);
    const bad = forbiddenIn(closure);
    expect(bad, `forbidden CAM imports:\n${reportOf(bad)}`).toEqual([]);
  });

  it('goalCoverage — clean today (the heightfield is a type import)', () => {
    const closure = valueImportClosure(['engine/cnc/engrave/goalCoverage.ts'], SRC, ALLOWED_SHARED);
    const bad = forbiddenIn(closure);
    expect(bad, `forbidden CAM imports:\n${reportOf(bad)}`).toEqual([]);
  });

  it('goalCheckInput — clean today (placement is allowlisted)', () => {
    const closure = valueImportClosure(['engine/cnc/engrave/goalCheckInput.ts'], SRC, ALLOWED_SHARED);
    const bad = forbiddenIn(closure);
    expect(bad, `forbidden CAM imports:\n${reportOf(bad)}`).toEqual([]);
  });

  it.skipIf(!existsSync(join(SRC, HEIGHTFIELD_MODULE)))(
    'the extracted heightfield module (#967) joins the gate roots and stays clean',
    () => {
      const closure = valueImportClosure([HEIGHTFIELD_MODULE], SRC, ALLOWED_SHARED);
      const bad = forbiddenIn(closure);
      expect(bad, `forbidden CAM imports:\n${reportOf(bad)}`).toEqual([]);
    },
  );
});

describe('#964 the reverse rule — the rebuilt engine never plans on the gate’s field', () => {
  const MODEL = join(SRC, 'engine', 'cnc', 'cam', 'model');
  const HEIGHTFIELD = join(SRC, HEIGHTFIELD_MODULE);
  const applicable = existsSync(MODEL) && existsSync(HEIGHTFIELD);

  it.skipIf(!applicable)(`cam/model/** does not import ${HEIGHTFIELD_MODULE}`, () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && /\.(ts|tsx|mts)$/.test(entry.name)) files.push(path);
      }
    };
    walk(MODEL);
    const bad: string[] = [];
    for (const file of files) {
      for (const edge of readImports(file, SRC)) {
        // A type import is erased, but A's rule is "never" — the engine must not name the gate's
        // module at all, so a future value import cannot slip in beside a harmless type.
        if (edge.to === HEIGHTFIELD_MODULE) {
          bad.push(`${relative(SRC, file).split('\\').join('/')}:${edge.line} imports ${edge.specifier}`);
        }
      }
    }
    expect(bad, `cam/model imports the gate's heightfield module:\n${bad.join('\n')}`).toEqual([]);
  });
});
