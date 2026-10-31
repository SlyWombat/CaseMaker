/**
 * The #754 two-side mouse shell as a `.cutjob.json`, for the e2e specs that need a real multi-side
 * goal job (#723 P2-3).
 *
 * The part is the demo job's real 1.2 MB, 18,432-triangle STL
 * (`docs/bench/2026-10-28-z1-real-jobs/jobs/j27-mouse-shell-side1.json`), at the resolution the
 * bench ran. The inside goal is that same mesh lowered by the 2.5 mm wall and clamped at the rim —
 * the same closed-form relationship `tests/unit/flipMouldShell.acceptance.spec.ts` checks on the
 * analytic form. Side 2 is a bottom-up vise mount (the setups engine's 180° turn about X), with
 * the two pins on the flip line as its datum.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

import { flatEndMill } from '@/engine/cnc/tool';

const DEMO_JOB = fileURLToPath(
  new URL('../../../../docs/bench/2026-10-28-z1-real-jobs/jobs/j27-mouse-shell-side1.json', import.meta.url),
);

/** The designed wall between the shell's outside and the inside form, mm. */
const WALL = 2.5;

/** The demo long ball: a ⌀3.175 ball with a 30 mm flute — the only cutter that reaches this shell. */
export const LONG_BALL_KEY = 'user:723-demo-ball';
export const LONG_BALL = {
  key: LONG_BALL_KEY,
  provenance: 'Makera demo ball, 30 mm flute (the #754 mouse shell needs a long ball)',
  tool: flatEndMill(3.175, {
    name: 'Two Flute Ball Nose Bit - 1/8" Shank 2mm * 30mm',
    typeText: 'Ball Nose',
    shape: 'ball',
    handleDiameter: 3.175,
    tipDiameter: 2,
    cornerRadius: 1,
    fluteLength: 30,
  }),
};

/** Everything `HouseHealthSchema` requires; nothing has been imported on this fake machine. */
export const HEALTH = {
  ok: true,
  schemaVersion: 1,
  hasCatalogue: false,
  feedRows: 0,
  materialSpecRows: 0,
  catalogueSyncedAt: null,
  lastSync: null,
  problems: [],
  warnings: [],
};

/** Answer the house service (no real one runs in the web build) with the demo long ball. */
export async function routeHouse(page: Page): Promise<void> {
  await page.route('**/api/v1/health**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HEALTH) }),
  );
  await page.route('**/api/v1/tools**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { etag: '"tools-723"' },
      body: JSON.stringify([LONG_BALL]),
    }),
  );
  await page.route('**/api/v1/feeds**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('**/api/v1/inventory**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
}

/**
 * The inside form as an STL: every vertex of the real outside mesh lowered by the wall, clamped
 * at the rim plane (z = 0). Normals are recomputed from the moved vertices; the hash is of the
 * bytes the job embeds, so the mesh cache and the document agree.
 */
function insideMesh(base64: string): { data: string; sha256: string; size: { x: number; y: number; z: number } } {
  const raw = Buffer.from(base64, 'base64');
  const out = Buffer.from(raw);
  const triangles = out.readUInt32LE(80);
  let maxZ = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < triangles; i++) {
    const facet = 84 + i * 50;
    for (let v = 0; v < 3; v++) {
      const p = facet + 12 + v * 12;
      const z = raw.readFloatLE(p + 8);
      out.writeFloatLE(Math.max(0, z - WALL), p + 8);
      const x = raw.readFloatLE(p);
      const y = raw.readFloatLE(p + 4);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, Math.max(0, z - WALL));
    }
    const ax = out.readFloatLE(facet + 12);
    const ay = out.readFloatLE(facet + 16);
    const az = out.readFloatLE(facet + 20);
    const bx = out.readFloatLE(facet + 24);
    const by = out.readFloatLE(facet + 28);
    const bz = out.readFloatLE(facet + 32);
    const cx = out.readFloatLE(facet + 36);
    const cy = out.readFloatLE(facet + 40);
    const cz = out.readFloatLE(facet + 44);
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    out.writeFloatLE(nx, facet);
    out.writeFloatLE(ny, facet + 4);
    out.writeFloatLE(nz, facet + 8);
  }
  return {
    data: out.toString('base64'),
    sha256: createHash('sha256').update(out).digest('hex'),
    size: { x: maxX - minX, y: maxY - minY, z: maxZ },
  };
}

const TOP_UP = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;
/** Bottom up in the vise: the setups engine's 180° turn about X, the flip line y = 25. */
const BOTTOM_UP = { top: 'bottom', bottom: 'top', left: 'left', right: 'right', front: 'back', back: 'front' } as const;

/** The two-side document: the demo job's outside on setup 1, the derived inside (a mold) on setup 2. */
export function twoSideJob(): Record<string, unknown> {
  const source = JSON.parse(readFileSync(DEMO_JOB, 'utf8')) as Record<string, unknown> & {
    targetObject: Record<string, unknown>;
  };
  const { targetObject: outside, ...rest } = source;
  const inside = insideMesh(outside.data as string);
  return {
    ...rest,
    name: 'mouse-shell-two-sides',
    toolKey: LONG_BALL_KEY,
    // The document states the cutter was CHOSEN, not computed: the panel's recommender leaves a
    // user's pick alone (a 12 mm-flute built-in cannot reach this shell), as it must on any saved
    // job. Without this the panel would replace it with `flat-1.0 · recommended`.
    sources: { tool: 'user' },
    setups: [
      { id: 'setup-1', orientation: TOP_UP, mount: { kind: 'vise', viseOpeningMm: 100 }, itemIds: [], tools: [LONG_BALL_KEY] },
      {
        id: 'setup-2',
        orientation: BOTTOM_UP,
        mount: { kind: 'vise', viseOpeningMm: 100 },
        itemIds: [],
        tools: [LONG_BALL_KEY],
        // The turn, and the datum it is made against: (4, 25) and (75, 25), on the flip line.
        remount: { instruction: ['Turn the stock over about the two pins, so the face that was up is down.'], confirm: null },
        pins: { at: [{ x: 4, y: 25 }, { x: 75, y: 25 }] },
      },
    ],
    targetObjects: [
      { ...outside, id: 'shell-out', setupId: 'setup-1' },
      {
        ...outside,
        id: 'shell-in',
        name: 'mouse-shell-inside.stl',
        setupId: 'setup-2',
        goalMode: 'mold',
        data: inside.data,
        sha256: inside.sha256,
        size: inside.size,
        surface: { finishStepOverMm: 0.3 },
      },
    ],
  };
}
