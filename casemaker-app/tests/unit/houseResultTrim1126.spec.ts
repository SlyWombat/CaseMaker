// #1126 slice 2 — THE CHECK BEFORE camIr IS DROPPED: does anything in the BROWSER read it?
//
// A house result no longer carries `camIr` (nor any NC text). If any browser code path read it off
// a result, it would get `undefined` silently — so this spec pins the answer at the source: every
// `camIr` occurrence under `src/` lives inside `workers/sim/engraveGenerate.ts`, where the IR is
// produced and used internally, and nowhere else. It also proves the write path (#1132's freeze)
// works from a result that has none: the package freezes nc + frame text, hashes and all.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { freezePackage, type PackageProgramInput } from '@/engine/cnc/engrave/package';
import { programHash } from '@/engine/cnc/programHash';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const OWNER = 'src/workers/sim/engraveGenerate.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/**
 * #1126 slice 2 — THE PLAN'S TOOLPATH IR IS NOT A BROWSER INPUT EITHER (the 223 MB field).
 *
 * `resultDocument` does not strip fields at all: it BUILDS each plan from `planSummary`, an
 * allowlist of exactly what the browser reads — `outcome` and `perSetup[].{setupIndex, notes}`.
 * A field the engine adds tomorrow cannot reach the document unless that type names it. The
 * consumers the Manager named, and why none of them reads plan internals:
 *   - #1132 re-freeze: `freezePackage` takes `PackageProgramInput[]` built from the FROZEN
 *     PACKAGE's own programs (`engravePackageStore.frozenProgramInputs`), never from a plan.
 *   - #1123-11 stored-run restore: IndexedDB stores the settled `generated` opaquely and hands it
 *     back; the sim walk reads its nc/oracle fields, not a plan.
 *   - #1136 partial regen (F's branch): it carries frozen programs from the PACKAGE as well, so a
 *     plan without IR does not reach it — stated as the expected shape; that branch is not in this
 *     tree to scan.
 *   - #1134 reuse: house-side (the CLI's own pick cache), where the full plan still exists in
 *     memory; the result's plan is the browser's copy only.
 */
describe('#1126 — camIr is not a browser input', () => {
  it('every camIr reference under src/ is inside engraveGenerate.ts', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const name = relative(SRC, file).split('\\').join('/');
      if (`src/${name}` === OWNER) continue;
      // Comments name it on purpose (this slice explains why it is gone); the pin is about CODE.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (code.includes('camIr')) offenders.push(`src/${name}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the browser reads only a plan summary: outcome and perSetup notes', () => {
    // Every `generated.plan` read under src/ must be one of the two known readers, and each must
    // read only an allowlisted field. The engine modules that BUILD the plan are exempt.
    const readers: Record<string, RegExp> = {
      'src/store/engraveRunStore.ts': /generated\.plan\?\.outcome/,
      // The cycle sentence reads the plan's outcome too (its `cycleSeconds`).
      'src/engine/cnc/engrave/runCycle.ts': /generated\?\.plan\?\.outcome/,
      'src/testing/windowApi.ts': /perSetup\.flatMap\(\(setup\) => setup\.notes\)/,
      // The allowlist's other named fields, each with its reader (see `planSummary.ts`'s header):
      'src/components/panels/EngraveTabChoice.tsx': /generated\?\.plan\?\.tabChoiceApplied/,
      'src/components/panels/useTabChoiceSuffix.ts': /generated\?\.plan\?\.tabChoiceApplied/,
      'src/components/panels/GoalFreeingTabs.tsx': /generated\?\.plan\?\.perSetup/,
      // Existence tests only — no plan field is read.
      'src/components/panels/EngravePanel.tsx': /run\.generated\?\.plan === undefined \|\| run\.generated\?\.plan === null/,
      'src/engine/cnc/engrave/restoredRun.ts': /const plan = generated\.plan;/,
    };
    const isEngine = (path: string): boolean =>
      path.startsWith('src/workers/sim/') || path.startsWith('src/engine/cnc/cam/model/');
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const name = `src/${relative(SRC, file).split('\\').join('/')}`;
      if (isEngine(name)) continue;
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (!/\bgenerated\??\.plan\b/.test(code)) continue;
      if (!(name in readers)) {
        offenders.push(name);
        continue;
      }
      expect(code, `${name} reads a plan field outside the summary`).toMatch(readers[name]!);
    }
    expect(offenders).toEqual([]);
  });

  it('nothing in the browser reads a plan’s toolpath IR (perSetup[].programs)', () => {
    // Allowed to name `perSetup` in code: the engine that produces the plan, the QA window, which
    // reads NOTES from it, and the freeing-tabs counts, which read ops[].kind / outcome.tabCounts —
    // both pinned below so a change to `.programs` fails here. The summary builder names it to
    // build the allowlist. `restoredRun.ts` names it only to ask whether the plan has an entry for
    // each program's setup (pinned below); everything it checks with comes from `verifyContext`.
    const allowed = (path: string): boolean =>
      path.startsWith('src/workers/sim/') ||
      path.startsWith('src/engine/cnc/cam/model/') ||
      path === 'src/engine/cnc/engrave/planSummary.ts' ||
      path === 'src/engine/cnc/engrave/restoredRun.ts' ||
      path === 'src/components/panels/GoalFreeingTabs.tsx' ||
      path === 'src/testing/windowApi.ts';
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const name = relative(SRC, file).split('\\').join('/');
      if (allowed(`src/${name}`)) continue;
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (/\bperSetup\b/.test(code)) offenders.push(`src/${name}`);
    }
    expect(offenders).toEqual([]);
    const windowApi = readFileSync(join(SRC, 'testing', 'windowApi.ts'), 'utf8');
    expect(windowApi).toContain('perSetup.flatMap((setup) => setup.notes)');
    const freeing = readFileSync(join(SRC, 'components', 'panels', 'GoalFreeingTabs.tsx'), 'utf8');
    expect(freeing).toContain("last?.ops.find((op) => op.kind === 'contour')");
    expect(freeing).toContain('contour?.outcome.tabCounts');
    expect(freeing).not.toMatch(/\.programs\b/);
    const restored = readFileSync(join(SRC, 'engine', 'cnc', 'engrave', 'restoredRun.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect([...restored.matchAll(/\bperSetup\b[^\n]*/g)].map((m) => m[0].trim())).toEqual([
      'perSetup[program.setupIndex - 1] === undefined)) {',
    ]);
  });

  it('a result without camIr still freezes (#1132): the package takes nc, frames and hashes', () => {
    const job = { ...defaultEngraveJob(), name: 'trim' };
    // The shape `assembleResult` produces: nc texts restored, frameNc restored, no camIr at all.
    const assembled = {
      ok: true,
      nc: 'G0 P2\n',
      frameNc: 'FRAME1\n',
      programs: [
        { name: 'trim', kind: 'engrave', nc: 'G0 P1\n', frameNc: 'FRAME1\n', toolKey: job.toolKey },
        { name: 'trim', kind: 'engrave', nc: 'G0 P2\n', frameNc: null, toolKey: job.toolKey },
      ],
    };
    expect('camIr' in assembled).toBe(false);
    const inputs: PackageProgramInput[] = assembled.programs.map((program, setupIndex) => ({
      setupIndex,
      setupId: `s${setupIndex}`,
      toolKey: program.toolKey,
      nc: program.nc,
      frameNc: program.frameNc,
      programHash: programHash(program.nc),
      frame: 'flat',
    }));
    const frozen = freezePackage(job, inputs, '2026-11-10T12:00:00.000Z');
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.package.programs.map((p) => p.nc)).toEqual(['G0 P1\n', 'G0 P2\n']);
    expect(frozen.package.programs[0]!.frameHash).not.toBeNull();
    expect(frozen.package.programs[1]!.frameHash).toBeNull();
  });
});
