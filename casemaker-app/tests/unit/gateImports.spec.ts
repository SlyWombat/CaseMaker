/**
 * #964 / #956 R1 — THE GATE'S INDEPENDENCE, BY TRANSITIVE IMPORT.
 *
 * The gate must judge the CAM without using the CAM's own geometry (#924's B1: "the app's own
 * check passes because it compares the simulation with the app's plan"). A direct-import rule
 * cannot see the coupling that matters: `designCheck.ts` imports helpers from `oracle.ts`, and
 * `oracle.ts` imports the CAM's cone (`vProfile.ts`) and sweep (`engrave/partPlan.ts`) — so the
 * gate grades the CAM with the CAM's math while every direct import looks innocent. This spec
 * follows imports transitively and forbids, in each gate root's closure:
 *
 *   - `engine/cnc/cam/**` (including the rebuilt `cam/model/**`);
 *   - `engine/cnc/vProfile.ts` (the CAM's cone);
 *   - `engine/cnc/engrave/partPlan.ts` (the CAM's sweep).
 *
 * GATE ROOTS (A's R1, #956): `goalCheckField.ts`, `designCheck.ts`, `goalCoverage.ts`,
 * `goalCheckInput.ts`, and the heightfield module when #967 extracts it. NOT `oracle.ts` — its
 * area comparison is the CAM-predicted check by design and is labelled as that.
 *
 * THE WALK ENTERS EVERY MODULE — there is no allowlist. A's measurement on #956 showed why a
 * trust boundary is not acceptable: `jobSetup.ts` is "placement, allowed", yet its closure reaches
 * TEN forbidden files (`vCone` via `vProfile`, `partPlan`, `cam/relief`, `primitiveSurface` →
 * `cam/surface3d`, …). The gate uses only `pureGoalObject` from it, so the fix is to move that
 * helper into `jobKind.ts`, not to stop at the module. An exemption, if one is ever needed, is a
 * single named edge, never a subtree.
 *
 * TYPE-ONLY IMPORTS: under `verbatimModuleSyntax: true` (tsconfig.app.json), only a
 * DECLARATION-level `import type { … }` / `export type { … } from` is erased. An inline
 * `import { type X }` still emits a module load, so it is followed as a value edge. The fixture
 * pair under `fixtures/importGraph/` pins that distinction.
 *
 * MEASURED on this branch (main a17b27f4 + #967, 86d98612):
 *   - `goalCheckField.ts` — 17 files, **0 forbidden**. It was 47 / 9 before #967; the extraction
 *     is what closed it, and this case now guards it as a plain `it`.
 *   - `designCheck.ts` — 71 files, **4 forbidden** via `oracle.ts`: `vProfile`,
 *     `engrave/partPlan`, `cam/ir` (through `rotary/wrap`) and `cam/tabSettings` (through
 *     `stockStart` → `defaultsClient`) — A's `oracleTypes.ts` split (#924) is the flip.
 *   - `goalCheckInput.ts` — 90 files, **4 forbidden** via `jobSetup.ts`: the same four (the CAM's
 *     `surface3d`/`relief` paths went with #967; `partPlan`, `vProfile`, `cam/ir`, `cam/tabSettings`
 *     remain) — A's `pureGoalObject` → `jobKind.ts` move is the flip.
 *   - `goalCoverage.ts` — 1 file, 0; `goalHeightfield.ts` (the extracted module) — 16 files, 0.
 * The two failing cases are `it.fails` so main stays green; the change that fixes one flips it to
 * `it`, and this spec then guards it.
 *
 * One more rule from A's R1: `cam/model/**` must NEVER import the extracted heightfield module —
 * the rebuild's point is that the engine stops planning on the field the gate measures with.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readImports, valueImportClosure, type ClosureEntry } from '../tools/importGraph';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const SRC = join(APP, 'src');
const IMPORT_FIXTURES = join(HERE, 'fixtures', 'importGraph');

/** A's R1 gate roots. The heightfield module is conditional until #967 extracts it. */
const GATE_ROOTS = [
  'workers/sim/goalCheckField.ts',
  'engine/cnc/engrave/designCheck.ts',
  'engine/cnc/engrave/goalCoverage.ts',
  'engine/cnc/engrave/goalCheckInput.ts',
] as const;

/** #967's destination for `GoalHeightfield`, `sampleGoalHeightfield`, `isMold`, `moldHeightfield`. */
const HEIGHTFIELD_MODULE = 'engine/cnc/engrave/goalHeightfield.ts';

const isForbidden = (file: string): boolean =>
  file.startsWith('engine/cnc/cam/') || file === 'engine/cnc/vProfile.ts' || file === 'engine/cnc/engrave/partPlan.ts';

const forbiddenIn = (closure: { files: Map<string, ClosureEntry> }): ClosureEntry[] =>
  [...closure.files.values()].filter((entry) => isForbidden(entry.file));

const reportOf = (entries: readonly ClosureEntry[]): string =>
  entries.map((entry) => `${entry.file}  ←  ${entry.chain.join(' -> ')}`).join('\n');

const closureOf = (root: string): ReturnType<typeof valueImportClosure> => valueImportClosure([root], SRC);

describe('#964 the gate roots and the graph’s rules', () => {
  it('names gate roots that exist', () => {
    for (const root of GATE_ROOTS) expect(existsSync(join(SRC, root))).toBe(true);
  });

  it('the graph reads value imports and skips declaration-level type imports', () => {
    // designCheck → oracle is a VALUE import and must be in the closure.
    expect(closureOf('engine/cnc/engrave/designCheck.ts').files.has('engine/cnc/engrave/oracle.ts')).toBe(true);
    // goalCoverage imports only `import type { GoalHeightfield }` from cam/surface3d; it must not be.
    expect(closureOf('engine/cnc/engrave/goalCoverage.ts').files.has('engine/cnc/cam/surface3d.ts')).toBe(false);
  });

  it('an INLINE `{ type X }` import is a value edge; a declared `import type` is erased', () => {
    const inline = readImports(join(IMPORT_FIXTURES, 'inline.ts'), IMPORT_FIXTURES);
    expect(inline).toHaveLength(1);
    expect(inline[0]!.typeOnly).toBe(false);
    expect(inline[0]!.to).toBe('target.ts');

    const declared = readImports(join(IMPORT_FIXTURES, 'declared.ts'), IMPORT_FIXTURES);
    expect(declared).toHaveLength(1);
    expect(declared[0]!.typeOnly).toBe(true);

    const viaInline = valueImportClosure(['inline.ts'], IMPORT_FIXTURES);
    expect(viaInline.files.has('target.ts')).toBe(true);
    const viaDeclared = valueImportClosure(['declared.ts'], IMPORT_FIXTURES);
    expect(viaDeclared.files.has('target.ts')).toBe(false);
  });

  it('enters every module — the walk does not stop at placement', () => {
    // This is A's finding: `jobSetup` is where the gate gets `pureGoalObject`, and its closure
    // still reaches the CAM after #967 (`cam/ir`, `cam/tabSettings`). A stop-at-allowlist rule
    // would hide exactly that.
    const closure = closureOf('engine/cnc/engrave/goalCheckInput.ts');
    expect(closure.files.has('engine/cnc/engrave/jobSetup.ts')).toBe(true);
    expect(closure.files.has('engine/cnc/cam/ir.ts')).toBe(true);
    expect(closure.files.has('engine/cnc/cam/tabSettings.ts')).toBe(true);
  });
});

describe('#964 the gate’s value-import closure carries no CAM', () => {
  // RED-FIRST: these three are the cuts that make the rule true. Flip each to `it` in the change
  // that lands its fix (the failure message then names anything that regresses).
  it('goalCheckField — 17 files, 0 forbidden after #967 (was 47 / 9)', () => {
    const bad = forbiddenIn(closureOf('workers/sim/goalCheckField.ts'));
    expect(bad.length, `forbidden CAM imports:\n${reportOf(bad)}`).toBe(0);
  });

  it.fails('designCheck — clean once A’s oracleTypes split lands (#924)', () => {
    const bad = forbiddenIn(closureOf('engine/cnc/engrave/designCheck.ts'));
    expect(bad.length, `forbidden CAM imports:\n${reportOf(bad)}`).toBe(0);
  });

  it.fails('goalCheckInput — 90 files, 4 forbidden; clean once pureGoalObject moves to jobKind.ts (A)', () => {
    const bad = forbiddenIn(closureOf('engine/cnc/engrave/goalCheckInput.ts'));
    expect(bad.length, `forbidden CAM imports:\n${reportOf(bad)}`).toBe(0);
  });

  it('goalCoverage — clean today (the heightfield is a declaration-level type import)', () => {
    const bad = forbiddenIn(closureOf('engine/cnc/engrave/goalCoverage.ts'));
    expect(bad.length, `forbidden CAM imports:\n${reportOf(bad)}`).toBe(0);
  });

  it.skipIf(!existsSync(join(SRC, HEIGHTFIELD_MODULE)))(
    'the extracted heightfield module (#967) joins the gate roots and stays clean',
    () => {
      const bad = forbiddenIn(closureOf(HEIGHTFIELD_MODULE));
      expect(bad.length, `forbidden CAM imports:\n${reportOf(bad)}`).toBe(0);
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
