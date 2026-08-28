import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';
import { executeOpSync } from '@/workers/geometry/evaluateOp';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { TEMPLATES, findTemplate } from '@/library/templates';

/**
 * Every node of every template must compile to ONE connected solid.
 *
 * Issues #123 (snap-fit-test shell came out as 3 pieces) and #122 (the
 * protective case's recessed lid as 4) were both this, and both were found by
 * eye during a render walkthrough rather than by a test. A loose piece is
 * invisible in the viewport — it sits exactly where it belongs — and only
 * shows up when a slicer drops it on the bed as a separate object.
 *
 * Deliberately across ALL templates rather than the two that failed: the fault
 * is in shared joint geometry (hinge fairings, snap lips, lid recesses), so
 * whichever template happens to combine those features next inherits it.
 */
let tl: Awaited<ReturnType<typeof ManifoldModule>>;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
  tl.setup();
}, 60000);

describe('template integrity', () => {
  it('compiles every template with every node a single connected solid', () => {
    const offenders: string[] = [];
    for (const t of TEMPLATES) {
      const tpl = findTemplate(t.id);
      expect(tpl, `${t.id} resolves`).toBeDefined();
      const plan = compileProject(tpl!.build());
      expect(plan.nodes.length, `${t.id} emits parts`).toBeGreaterThan(0);
      for (const node of plan.nodes) {
        const m = executeOpSync(tl, node.op);
        try {
          const parts = m.decompose();
          if (parts.length !== 1) offenders.push(`${t.id}/${node.id}=${parts.length}`);
          parts.forEach((c) => c.delete());
        } finally {
          m.delete();
        }
      }
    }
    expect(offenders, 'nodes that are not one connected solid').toEqual([]);
  }, 600000);
});
