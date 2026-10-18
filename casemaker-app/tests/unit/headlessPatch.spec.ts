// #482 — a headless driver must not edit `project.case` and compile: setting `joint = 'snap-fit'`
// by assignment leaves `snapCatches` empty and the compiled case has no catches. `patchProject` is
// the store's patch path without the store, and these tests hold it to the two consumers' needs:
// the catches exist, and the result is what the UI/template path produces.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { buildProjectFromSpec } from '@/library/templates/buildFromSpec';
import { templateSpecSchema } from '@/library/templates/templateSchema';
import { patchProject } from '@/platform/headless/patch';
import { createDefaultProject, useProjectStore } from '@/store/projectStore';
import type { Project } from '@/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPECS = join(HERE, '..', '..', 'src', 'library', 'templates', 'specs');

/** The snap-fit fixture template as committed: the same spec the UI builds from. */
function snapFitSpec() {
  return templateSpecSchema.parse(
    JSON.parse(readFileSync(join(SPECS, 'snap-fit-test.json'), 'utf8')),
  );
}

function expectOk(result: ReturnType<typeof patchProject>): Project {
  if (!result.ok) throw new Error(`patch was rejected: ${result.reason}`);
  return result.project;
}

/**
 * Two independent `createDefaultProject` calls mint different random project, board-clone and port
 * ids. Those are not part of what the template path decides, so collapse the random tail before
 * comparing two builds field for field — the prefix (and the field it sits in) still has to match.
 */
function stableIds<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v !== 'string' || !/^(?:custom|proj|port|ant)-/.test(v)) return v;
      const cut = v.lastIndexOf('-');
      return cut > 0 ? `${v.slice(0, cut)}-<id>` : v;
    }),
  ) as T;
}

describe('#482 headless case patching', () => {
  it('a snap-fit patch seeds snapCatches', () => {
    const fresh = createDefaultProject('snap-test-fixture');
    expect(fresh.case.snapCatches).toBeUndefined();

    const patched = expectOk(patchProject(fresh, { joint: 'snap-fit' }));

    expect(patched.case.joint).toBe('snap-fit');
    expect(patched.case.snapCatches).toBeDefined();
    expect(patched.case.snapCatches!.length).toBeGreaterThan(0);
    // The input is untouched: the headless path returns a new project.
    expect(fresh.case.joint).toBe('flat-lid');
    expect(fresh.case.snapCatches).toBeUndefined();
  });

  it('matches the template/UI path for the same template spec', () => {
    const spec = snapFitSpec();
    const viaTemplate = buildProjectFromSpec(spec);

    // The SAME template built without its case patch, then patched headlessly. Starting from one
    // project instead of two fresh ones matters: createDefaultProject mints random project, board
    // and port ids, so two independent starts could never be compared field for field.
    const { casePatch, ...withoutPatch } = spec;
    const beforePatch = buildProjectFromSpec(withoutPatch);
    const viaPatch = expectOk(patchProject(beforePatch, casePatch));

    expect(stableIds(viaPatch)).toEqual(stableIds(viaTemplate));
    expect(viaPatch.case.snapCatches).toEqual(viaTemplate.case.snapCatches);
    // The end of the chain the bug class actually broke: the compiled plan, not just the data.
    expect(stableIds(compileProject(viaPatch))).toEqual(stableIds(compileProject(viaTemplate)));
  });

  it('rejects an invalid patch, names the field, and leaves the project byte-identical', () => {
    const fresh = createDefaultProject('snap-test-fixture');
    const before = JSON.stringify(fresh);

    const result = patchProject(fresh, { joint: 'not-a-joint', wallThickness: -1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('invalid case patch');
    expect(result.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['joint', 'wallThickness']));
    expect(JSON.stringify(fresh)).toBe(before);
  });

  it('produces the same project through the store and the plain function', () => {
    const fresh = createDefaultProject('snap-test-fixture');
    useProjectStore.setState({ project: fresh });

    const patch = { joint: 'snap-fit', wallThickness: 2.5 } as const;
    useProjectStore.getState().patchCase(patch);
    const viaStore = useProjectStore.getState().project;

    const viaFn = expectOk(patchProject(fresh, patch));
    expect(viaFn).toEqual(viaStore);
    expect(viaFn.case.snapCatches).toEqual(viaStore.case.snapCatches);
  });

  it('pins modifiedAt by default and takes a clock for a caller that wants a real date', () => {
    const fresh = createDefaultProject('snap-test-fixture');
    expect(expectOk(patchProject(fresh, { wallThickness: 3 })).modifiedAt).toBe(
      new Date(0).toISOString(),
    );
    expect(
      expectOk(patchProject(fresh, { wallThickness: 3 }, () => '2026-10-18T09:30:00.000Z'))
        .modifiedAt,
    ).toBe('2026-10-18T09:30:00.000Z');
  });
});
