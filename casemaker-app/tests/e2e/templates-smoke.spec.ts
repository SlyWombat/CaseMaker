import { test, expect } from './fixtures/caseMaker';
import path from 'node:path';

/**
 * Hard-coded mirror of `TEMPLATES` ids from `src/library/templates/index.ts`.
 * Keeping the list in-file (rather than importing the module) avoids dragging
 * the JSON-import / Vite-aliased graph into Playwright's plain-node module
 * loader — Playwright would need `type: json` import attributes that the
 * Vite source doesn't have. The unit-test companion (templatesCompile.spec.ts)
 * runs under Vitest and DOES import TEMPLATES — that catches the case where
 * a new template is added but this list isn't updated, because the unit
 * harness will run for every template and the e2e harness won't, which
 * shows up immediately in CI.
 *
 * If you add a new template, add its id here too.
 */
const TEMPLATE_IDS = [
  'pi-server-tray',
  'pi-poe-stack',
  'pi-zero-tablet',
  'arduino-dmx',
  'giga-dmx-controller',
  'esp32-dev-tray',
  'mini-rack-10in',
  'snap-fit-test',
] as const;

/**
 * Issue #88 — templates smoke harness.
 *
 * For every entry in TEMPLATES, click the welcome card, wait for the engine
 * to settle, then assert the worker output is sane:
 *
 *   - every node has componentCount === 1 (no loose pieces)
 *   - every node has vertexCount > 0 and triangleCount > 0
 *   - every node's bbox has positive extent in every axis
 *   - no JobScheduler error
 *
 * Captures a viewport screenshot for review either way.
 *
 * KNOWN_BROKEN: templates currently failing the assertions, with the
 * follow-up bug-issue id. The harness still EXERCISES these templates
 * (loads them, screenshots them, prints the failure summary) — but
 * `expect.soft` lets the suite stay green so CI doesn't block on
 * known-broken templates that already have a tracking issue.
 *
 * When a template gets fixed, remove its entry from KNOWN_BROKEN — the
 * hard assertion will engage automatically and prevent regression.
 */

/** Templates that compile to a multi-part ASSEMBLY instead of shell+lid.
 *  Values are the structural node ids the smoke test pins in place of the
 *  shell/lid spot-check. */
const ASSEMBLY_TEMPLATE_NODES: Record<string, string[]> = {
  'mini-rack-10in': ['rack-side-left', 'rack-side-right', 'rack-bottom', 'rack-top'],
};

const KNOWN_BROKEN: Record<string, number> = {
  // Empty — every template currently passes the harness.
  // Add an entry { '<template-id>': <issue-number> } when a template
  // regression is filed and tracked but the fix hasn't landed yet.
  // (#90 — previously here for snap-fit-test loose pieces, fixed by 133f79a.)
};

interface TemplateResult {
  graph: Array<{
    id: string;
    triangleCount: number;
    vertexCount: number;
    bbox: { min: [number, number, number]; max: [number, number, number] };
    componentCount?: number;
  }>;
  shellStats: {
    vertexCount: number;
    triangleCount: number;
    bbox: { min: [number, number, number]; max: [number, number, number] };
    componentCount?: number;
  } | null;
  lidStats: {
    vertexCount: number;
    triangleCount: number;
    bbox: { min: [number, number, number]; max: [number, number, number] };
    componentCount?: number;
  } | null;
  jobError: string | null;
}

for (const id of TEMPLATE_IDS) {
  test(`templates-smoke: ${id}`, async ({ cm, page }, testInfo) => {
    await cm.ready();

    // Click the welcome-overlay template card.
    const card = page.getByTestId(`welcome-template-${id}`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    // Wait for the worker to finish.
    await page.evaluate(async () => {
      await window.__caseMaker!.waitForIdle();
    });

    // Snapshot scene state.
    const result: TemplateResult = await page.evaluate(() => {
      const api = window.__caseMaker!;
      return {
        graph: api.getSceneGraph(),
        shellStats: api.getMeshStats('shell'),
        lidStats: api.getMeshStats('lid'),
        jobError: api.getJobError(),
      };
    });

    // Capture a viewport screenshot for human review either way.
    const screenshotPath = path.join(
      'test-results',
      'templates-smoke',
      `${id}.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: false });
    await testInfo.attach(`${id}.png`, { path: screenshotPath, contentType: 'image/png' });

    // Collect every assertion failure rather than aborting on the first.
    // For known-broken templates we log them as annotations and let the
    // test pass — the follow-up issue tracks the fix and removing the
    // entry from KNOWN_BROKEN re-engages the hard assertion.
    const failures: string[] = [];
    const check = (cond: boolean, msg: string): void => {
      if (!cond) failures.push(msg);
    };

    check(result.jobError === null, `${id}: jobError=${result.jobError}`);
    check(result.graph.length > 0, `${id}: scene graph empty`);

    for (const node of result.graph) {
      check(
        node.vertexCount > 0,
        `${id} node ${node.id}: vertexCount=${node.vertexCount} (expected > 0)`,
      );
      check(
        node.triangleCount > 0,
        `${id} node ${node.id}: triangleCount=${node.triangleCount} (expected > 0)`,
      );
      const dx = node.bbox.max[0] - node.bbox.min[0];
      const dy = node.bbox.max[1] - node.bbox.min[1];
      const dz = node.bbox.max[2] - node.bbox.min[2];
      check(dx > 0, `${id} node ${node.id}: bbox x extent ${dx} <= 0`);
      check(dy > 0, `${id} node ${node.id}: bbox y extent ${dy} <= 0`);
      check(dz > 0, `${id} node ${node.id}: bbox z extent ${dz} <= 0`);
      // The user-reported failure mode for snap-fit-test — disjointed shell.
      check(
        node.componentCount === 1,
        `${id} node ${node.id}: componentCount=${node.componentCount} (loose pieces)`,
      );
    }

    // Spot-check the archetype's structural nodes (per issue #88 acceptance).
    // Assembly archetypes (rack) have no shell/lid — pin their frame parts
    // instead so a compile that silently drops a panel still fails here.
    if (ASSEMBLY_TEMPLATE_NODES[id]) {
      for (const nodeId of ASSEMBLY_TEMPLATE_NODES[id]) {
        check(
          result.graph.some((n) => n.id === nodeId),
          `${id}: missing '${nodeId}' node`,
        );
      }
    } else {
      check(result.shellStats !== null, `${id}: no 'shell' MeshStats`);
      check(result.lidStats !== null, `${id}: no 'lid' MeshStats`);
    }

    const knownBrokenIssue = KNOWN_BROKEN[id];
    if (failures.length > 0 && knownBrokenIssue) {
      // Allowlisted: annotate so the failure is visible in test reports
      // and HTML output, but don't fail the suite.
      testInfo.annotations.push({
        type: 'known-broken',
        description: `Template ${id} fails templates-smoke assertions (tracked in #${knownBrokenIssue}):\n${failures.map((f) => `  - ${f}`).join('\n')}`,
      });
      return;
    }

    expect(failures, `${id} templates-smoke failures:\n${failures.map((f) => `  - ${f}`).join('\n')}`).toEqual([]);
  });
}
