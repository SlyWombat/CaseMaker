// Scratch QA for #150 — the toolbox floor sockets and the drop-in dividers that
// plug into them, driven in a real browser.
//
// The unit suite already proves the INTERSECTION claims through Manifold: a
// tenon lands inside a socket cell, a divider never reaches the foot cavity
// wall, and each emitted node is one connected shell. What it cannot show is
// what the assembled PRINT looks like, whether the panel's report and the
// compiler's decision are the same decision, and whether the parts list a user
// actually gets carries the divider. That is what this script is for.
//
// Not part of the test suite — run by hand via qa-150.cmd, delete after.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = './qa-150-out';
mkdirSync(OUT, { recursive: true });
const URL = process.env.QA_URL ?? 'http://127.0.0.1:5198/';

// TOOLBOX_FLOOR_T and the grid's cut depth, types/toolbox.ts. Restated here
// because this script is plain JS and cannot import them; if either moves, the
// checks below say so rather than quietly re-baselining.
const FLOOR_T = 4;
const GRID_DEPTH = 2;

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
// Fail a locator fast: the default 30 s per action turns one wrong testid into
// a multi-minute stall that looks exactly like a hang.
page.setDefaultTimeout(15_000);

const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${String(e).split('\n')[0]}`));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 300)}`);
});

// Bounded, because `waitForIdle` is a bare promise with no timeout of its own:
// if the job scheduler ever stops settling, an unbounded await hangs the whole
// run with no output. A timeout here is itself a finding, so record it and push
// on rather than stall — and gather what the app thinks its job state is.
const idleTimeouts = [];
let currentStep = '';
const idle = async (label = currentStep) => {
  const state = await page.evaluate(async () => {
    const cm = window.__caseMaker;
    const ok = await Promise.race([
      (async () => { await cm?.waitForIdle?.(); return true; })(),
      new Promise((r) => setTimeout(() => r(false), 15_000)),
    ]);
    return { ok, gen: cm?.getGeneration?.(), error: cm?.getJobError?.() ?? null };
  });
  if (!state.ok) idleTimeouts.push({ label, ...state });
  return state;
};

const graph = () =>
  page.evaluate(() => {
    const g = window.__caseMaker?.getSceneGraph?.() ?? [];
    return g.map((n) => ({
      id: n.id,
      tris: n.triangleCount,
      comps: n.componentCount,
      min: [0, 1, 2].map((i) => Number(n.bbox.min[i].toFixed(3))),
      max: [0, 1, 2].map((i) => Number(n.bbox.max[i].toFixed(3))),
      size: [0, 1, 2].map((i) => Number((n.bbox.max[i] - n.bbox.min[i]).toFixed(3))),
    }));
  });
const node = async (id) => (await graph()).find((n) => n.id === id) ?? null;
const has = (sel) => page.locator(sel).count().then((n) => n > 0);

/** Put the camera back to a framed view before every screenshot.
 *  Zoom and orbit PERSIST across steps: without this, one close-up step leaves
 *  every later shot inside the model, which is exactly what the first run did. */
const framed = async () => {
  await page.getByTestId('viewport-fit').click();
  await page.waitForTimeout(500);
};

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

const report = { steps: [] };
const step = async (name, fn) => {
  const before = errs.length;
  let info = null;
  currentStep = name;
  // Progress goes out as it happens: the JSON only prints at the end, so a
  // hang would otherwise leave a silent log with no way to say where it stopped.
  console.log(`>> ${name}`);
  try {
    info = await fn();
  } catch (e) {
    errs.push(`step ${name}: ${String(e).split('\n')[0]}`);
  }
  await page.screenshot({ path: `${OUT}/${name}.png` }).catch(() => {});
  console.log(`<< ${name} ${JSON.stringify(info)?.slice(0, 300) ?? ''}`);
  report.steps.push({ name, newErrors: errs.length - before, info });
};

await step('01-load-toolbox', async () => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  // Say so plainly if the test API is missing: without it every later step fails
  // for its own reason and the log reads like ten unrelated bugs. This is what a
  // lost VITE_E2E looks like.
  const api = await page.evaluate(() => typeof window.__caseMaker);
  check('the test API is exposed (VITE_E2E reached vite)', api === 'object', `typeof = ${api}`);
  await page.waitForFunction(() => Boolean(window.__caseMaker?.apiVersion === 1), undefined, {
    timeout: 30_000,
  });
  await page.waitForLoadState('networkidle', { timeout: 30_000 });
  await page.getByTestId('welcome-template-toolbox').click();
  await idle();
  await page.getByTestId('sidebar-button-toolbox').click();
  // X-ray, explicitly: the lid and the walls are opaque otherwise and the floor
  // is the whole subject of this issue.
  await page.evaluate(() => window.__caseMaker.setShellRender('xray'));
  return { graph: await graph() };
});

await step('02-bin-xray', async () => {
  await page.getByTestId('viewport-view-base-only').click();
  await framed();
  const render = await page.evaluate(() => window.__caseMaker.getShellRender());
  check('the shell is in x-ray, so the floor can be seen at all', render === 'xray', String(render));
  const bin = await node('toolbox-bin');
  check('the bin is one printed piece', bin?.comps === 1, `${bin?.comps} components`);
  return { render, bin };
});

await step('03-add-divider', async () => {
  const before = await graph();
  await page.getByTestId('toolbox-add-peg').click();
  await idle();
  await framed();
  const after = await graph();
  const peg = after.find((n) => n.id === 'divider-peg-1') ?? null;
  const bin = after.find((n) => n.id === 'toolbox-bin') ?? null;
  const panelHeight = Number(await page.getByTestId('toolbox-peg-height-1').inputValue());
  const summary = (await page.getByTestId('toolbox-summary').textContent().catch(() => null))?.trim();

  check('the divider reaches the scene graph', peg !== null, peg?.id ?? 'absent');
  if (peg && bin) {
    // Tenon in a socket, in the assembled frame. The floor's TOP face is
    // `FLOOR_T` above the seating plane, so a tenon that is properly sunk
    // starts BELOW it — and stops above the seating plane, since the socket is
    // blind. A divider merely standing on the floor would start exactly at
    // `FLOOR_T`, and one that had dropped through would go below zero.
    const sunk = peg.min[2] - bin.min[2];
    check('the tenons are sunk into the floor, not standing on it', sunk < FLOOR_T - 0.2, `${sunk} mm below the seating plane`);
    check('the tenons do not pierce the floor', sunk > 0.2, `${sunk} mm`);
    check(
      'each tenon engages, but not the full socket depth',
      Math.abs(FLOOR_T - sunk - (GRID_DEPTH - 0.4)) < 0.05,
      `engagement ${Number((FLOOR_T - sunk).toFixed(3))} mm of a ${GRID_DEPTH} mm socket`,
    );
    // The wall's top face: it must rise its full height from the FLOOR's face,
    // so its top sits `FLOOR_T + height` above the seating plane.
    const top = peg.max[2] - bin.min[2];
    check(
      'the wall stands the height the panel says, from the floor up',
      Math.abs(top - (FLOOR_T + panelHeight)) < 0.05,
      `top ${top} vs ${FLOOR_T} + ${panelHeight}`,
    );
    check('the divider is one printed piece', peg.comps === 1, `${peg.comps} components`);
  }
  return { nodes: before.length + '->' + after.length, peg, panelHeight, summary };
});

await step('04-second-divider-across-the-depth', async () => {
  await page.getByTestId('toolbox-add-peg').click();
  await page.getByTestId('toolbox-peg-axis-2').selectOption('y');
  await idle();
  await framed();
  const second = await node('divider-peg-2');
  const first = await node('divider-peg-1');
  check('the second divider is emitted', second !== null, second?.id ?? 'absent');
  if (second && first) {
    check(
      'axis y runs the wall along the depth, not the width',
      second.size[1] > second.size[0] && first.size[0] > first.size[1],
      `y:${second.size[0]}x${second.size[1]}  x:${first.size[0]}x${first.size[1]}`,
    );
    check('the turned divider is still one printed piece', second.comps === 1, `${second.comps} components`);
  }
  return { second, first };
});

await step('05-top-view-lattice', async () => {
  await page.getByTestId('viewport-camera-top').click();
  await framed();
  return { graph: await graph() };
});

// The panel's report and the compiler's decision must be the same decision: a
// divider the panel complains about must NOT be in the scene graph.
await step('06-panel-report-matches-compiler', async () => {
  await page.getByTestId('toolbox-peg-spans-1').fill('99');
  await idle();
  await framed();
  const problem = (await page.getByTestId('toolbox-peg-problem').first().textContent().catch(() => null))?.trim();
  const stillThere = await node('divider-peg-1');
  check('an impossible divider is reported', Boolean(problem), problem ?? 'no message');
  check('...and it is not drawn', stillThere === null, stillThere ? 'still in graph' : 'absent');
  const other = await node('divider-peg-2');
  check('a valid divider beside it is untouched', other !== null, other?.id ?? 'absent');

  // A fractional span is the reachable one: the input steps by one, but `2.5`
  // types fine, and the geometry guard refuses it while the panel's predicate
  // is what has to SAY so.
  await page.getByTestId('toolbox-peg-spans-1').fill('2.5');
  await idle();
  const fractional = (await page.getByTestId('toolbox-peg-problem').first().textContent().catch(() => null))?.trim();
  check('a fractional span is reported, not silently dropped', /whole number/.test(fractional ?? ''), fractional ?? 'no message');
  check('...and it is not drawn either', (await node('divider-peg-1')) === null, '');

  await page.getByTestId('toolbox-peg-spans-1').fill('3');
  await idle();
  check('fixing it brings it back', (await node('divider-peg-1')) !== null, '');
  return { problem, fractional };
});

// Turning the grid off is a fact about the BIN: every divider loses its mount,
// the panel says so once, and nothing is drawn.
await step('07-grid-off', async () => {
  await page.getByTestId('toolbox-grid').click();
  await idle();
  const problems = await page.getByTestId('toolbox-peg-problem').allTextContents();
  const drawn = (await graph()).filter((n) => n.id.startsWith('divider-peg-'));
  check('the bin-wide reason is one line, not one per divider', problems.length === 1, problems.join(' | '));
  check('no divider is drawn without sockets', drawn.length === 0, drawn.map((n) => n.id).join(','));

  await page.getByTestId('toolbox-grid').click();
  await idle();
  check('turning it back on restores them', (await graph()).filter((n) => n.id.startsWith('divider-peg-')).length === 2, '');
  return { problems, drawn: drawn.map((n) => n.id) };
});

// What the user is actually handed.
await step('08-export-parts', async () => {
  await page.getByTestId('sidebar-button-export').click();
  await page.getByTestId('export-open').click({ timeout: 10_000 });
  await page.getByTestId('export-modal-format').waitFor({ timeout: 10_000 });
  const text = (await page.locator('.export-modal').textContent()).replace(/\s+/g, ' ').trim();
  check('the parts list carries the first divider', /Divider peg 1/.test(text), '');
  check('the parts list carries the second divider', /Divider peg 2/.test(text), '');
  // The divider is a standing blade in assembly orientation, and the exporters
  // never apply `printOrientation.rotation`, so the note IS the mechanism: if
  // this text ever goes, the part ships with nothing telling the user to lay it
  // down. Pinned here rather than in a unit test because it is copy, not geometry.
  const note = /Lay it on its SIDE[^.]*\./.exec(text)?.[0] ?? null;
  check('the divider part says how to lay it down', note !== null, note ?? 'no note');
  await page.screenshot({ path: `${OUT}/08-export-modal.png` });
  await page.getByTestId('export-modal-close').click();
  return { note, excerpt: text.slice(0, 300) };
});

// Is the divider DRAWN? `getSceneGraph()` reporting triangles only says the
// worker produced them (#162's lesson). The only honest test is pixels — remove
// the thing and the picture has to change — and a pixel diff needs a CONTROL:
// if two shots of an unchanged view already differ (camera easing, antialiasing
// under swiftshader), then every "the render changed" claim below is worthless.
await step('09-base-only-takes-the-lid-off', async () => {
  const canvas = page.locator('canvas').first();
  // The export modal left the sidebar on Export, which UNMOUNTS the toolbox
  // panel: the previous run's click on a divider button timed out here for
  // exactly that reason, and the screenshots after it were of nothing.
  await page.getByTestId('sidebar-button-toolbox').click();
  await page.getByTestId('viewport-camera-perspective').click();
  await page.getByTestId('viewport-view-base-only').click();
  await framed();

  const ctrlA = await canvas.screenshot();
  await page.waitForTimeout(900);
  const ctrlB = await canvas.screenshot();
  const control = Buffer.compare(ctrlA, ctrlB) === 0;
  check('control — two shots of one unchanged view are identical', control, 'diff method is sound only if this holds');
  await page.screenshot({ path: `${OUT}/09a-base-only.png` });

  // Base-only must take the LID off and leave the bin. Before the fix the
  // toolbox's lid was `toolbox-lid`, which the id check for 'lid' never
  // matched, so it stayed on and covered the floor the dividers plug into.
  await page.getByTestId('viewport-view-lid-only').click();
  await framed();
  const lidOnly = await canvas.screenshot();
  await page.screenshot({ path: `${OUT}/09b-lid-only.png` });
  check('base-only and lid-only are different views of a toolbox', Buffer.compare(ctrlA, lidOnly) !== 0, '');

  // The money question. Both shots in base-only + x-ray: if the dividers are
  // really on screen, taking them away has to change the picture.
  await page.getByTestId('viewport-view-base-only').click();
  await framed();
  const withPegs = await canvas.screenshot();
  await page.getByTestId('toolbox-peg-remove-1').click();
  await page.getByTestId('toolbox-peg-remove-2').click();
  await idle();
  await framed();
  const noPegs = await canvas.screenshot();
  await page.screenshot({ path: `${OUT}/09c-dividers-removed.png` });
  check('the dividers are visible — removing them changes the render', Buffer.compare(withPegs, noPegs) !== 0, '');

  // Put them back, so the shots below show dividers that are really on screen.
  await page.getByTestId('toolbox-add-peg').click();
  await idle();
  await framed();
  await page.screenshot({ path: `${OUT}/09d-divider-in-the-open-bin.png` });
  return { control, lidViewsDiffer: Buffer.compare(ctrlA, lidOnly) !== 0, pegVisible: Buffer.compare(withPegs, noPegs) !== 0 };
});

// The x-ray toggle is the only way to see a floor at all, so check it does
// something on this archetype rather than trusting the state flag. Meaningful
// only because the control above passed.
await step('10-xray-makes-a-difference', async () => {
  const canvas = page.locator('canvas').first();
  await page.evaluate(() => window.__caseMaker.setShellRender('solid'));
  await framed();
  const solid = await canvas.screenshot();
  await page.screenshot({ path: `${OUT}/10a-solid.png` });
  await page.evaluate(() => window.__caseMaker.setShellRender('xray'));
  await framed();
  const xray = await canvas.screenshot();
  await page.screenshot({ path: `${OUT}/10b-xray.png` });
  check('x-ray shows a toolbox bin that solid does not', Buffer.compare(solid, xray) !== 0, '');
  return { differs: Buffer.compare(solid, xray) !== 0 };
});

// Last, so nothing after it inherits the zoom. Fixes the first run's mistake:
// six wheel notches put the camera INSIDE the bin and every later shot with it.
await step('11-floor-closeup', async () => {
  await page.getByTestId('viewport-camera-perspective').click();
  await framed();
  const box = await page.locator('canvas').first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 2; i++) await page.mouse.wheel(0, -240);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2 + 90, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const bin = await node('toolbox-bin');
  return { binTris: bin?.tris, sockets: 'see 09-floor-closeup.png for the lattice' };
});

report.idleTimeouts = idleTimeouts;
report.checks = checks;
report.errors = errs;
console.log(JSON.stringify(report, null, 2));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) console.log('FAILED:\n' + failed.map((f) => `  - ${f.name} (${f.detail})`).join('\n'));
if (idleTimeouts.length) console.log('IDLE TIMEOUTS:\n' + JSON.stringify(idleTimeouts));

await b.close();
process.exit(errs.length > 0 || failed.length > 0 || idleTimeouts.length > 0 ? 1 : 0);
