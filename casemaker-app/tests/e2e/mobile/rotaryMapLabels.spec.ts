import { test, expect } from '../fixtures/caseMaker';

/**
 * #716 review — at phone width the map's labels must not print over each other or under the Depth
 * panel. Two mechanisms answer the report: the Map's camera frames the map inside the free area
 * beside the panel, and a label whose measured box would touch a higher-priority one is dropped
 * (`rotaryMapLabels`). This spec measures the boxes that actually remain at 390 px, and checks the
 * toolbar states the fixed top-down frame instead of leaving Perspective lit.
 */

/** The dowel the screenshots use: ⌀20 × 100, 85 mm out of the chuck, tailstock in, one label. */
const DOWEL_JOB = {
  schemaVersion: 3,
  id: 'job-cc237op824',
  name: 'Zoomba on a dowel',
  machineId: 'Z1',
  stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
  labels: [
    {
      id: 'l1',
      text: 'ZOOMBA',
      font: 'sans-default',
      weight: 'bold',
      size: 8,
      position: { x: 50, y: 43 },
      rotation: 0,
      depth: 2,
      enabled: true,
      centre: { x: 40, y: 15.708 },
    },
  ],
  shapes: [],
  toolKey: 'flat-1.0',
  workholding: {
    kind: 'rotary-chuck',
    rotary: {
      jawDiameter: null,
      stickout: 85,
      gripDiameter: null,
      jawMode: 'reverse-inner',
      tailstock: true,
      source: 'test',
    },
  },
  minFloor: 1,
  edgeMargin: 1,
  sacrificial: { under: null, sides: { left: null, right: null, front: null, back: null }, source: 'default' },
  breakthrough: 0.3,
  jawClearance: 1,
  customFonts: [],
};

interface Box {
  id?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

const intersects = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('the map’s labels clear each other and the Depth panel at phone width (#716)', async ({ cm, page }) => {
  await page.addInitScript((job) => {
    localStorage.setItem('casemaker.engraveJob.v3', JSON.stringify(job));
  }, DOWEL_JOB);
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });

  // The drawer is where the section lives at this width.
  if (((await page.getByTestId('sidebar').boundingBox())?.x ?? 0) < 0) {
    await page.getByTestId('sidebar-handle').click();
  }
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-preview-legend')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('rotary-view-controls')).toBeVisible();

  // The context drawer rides over the canvas at phone width; close it so the map is what is seen.
  const panel = page.getByTestId('context-panel');
  if (((await panel.getAttribute('class')) ?? '').includes('context-panel--open')) {
    await page.getByTestId('context-panel-handle').click();
  }

  // The Map is a fixed top-down frame: Top says so, and the presets are disabled rather than
  // pretending a click would change a camera the map owns.
  await expect(page.getByTestId('viewport-camera-top')).toHaveAttribute('aria-checked', 'true');
  for (const id of ['perspective', 'top', 'front', 'side']) {
    await expect(page.getByTestId(`viewport-camera-${id}`)).toBeDisabled();
  }

  // Wait for the collision layout's first pass. Labels mount through drei's portal a frame after
  // the preview, and the layout marks the canvas only once it has a measured set to decide on.
  await page.waitForSelector('canvas[data-rotary-map-settled="1"]', { timeout: 60_000 });
  await page.waitForTimeout(300);

  const labels: Box[] = await page.locator('[data-rotary-label]').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: el.getAttribute('data-testid'),
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      };
    }),
  );
  // Not a vacuous pass: the map is labelled, and the words the report named survive.
  expect(labels.length).toBeGreaterThanOrEqual(8);
  const ids = labels.map((l) => l.id);
  for (const id of ['rotary-band-label-jaws', 'rotary-band-label-tailstock', 'rotary-ruler-360']) {
    expect(ids).toContain(id);
  }

  const collisions: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (intersects(labels[i]!, labels[j]!)) {
        collisions.push(`${labels[i]!.id} × ${labels[j]!.id}`);
      }
    }
  }
  expect(collisions).toEqual([]);

  // The Depth panel is chrome over the canvas; no map label may sit under it.
  const legend = await page.getByTestId('engrave-preview-legend').boundingBox();
  expect(legend).not.toBeNull();
  const underPanel = labels.filter((l) => intersects(l, legend!)).map((l) => l.id);
  expect(underPanel).toEqual([]);

  // The Map | Stock chip shares the top line with the panel. In one row it ran under the panel's
  // top-left corner ("Stock" on the panel's border); stacked, it must still clear it.
  const chip = await page.getByTestId('rotary-view-controls').boundingBox();
  expect(chip).not.toBeNull();
  expect(intersects(chip!, legend!), 'the Map | Stock chip overlaps the Depth panel').toBe(false);
});
