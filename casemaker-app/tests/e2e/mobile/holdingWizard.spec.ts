// #726 W19/P12 — the cutting-job wizard at phone width (390 × 844, the `mobile-chromium`
// project, which matches this `mobile/` directory).
//
// W19: Holding drew its mount options and its top-view picture in two columns at every width. At
// 390 the options were left an 86 px column, their text ran under the picture, and the picture's
// caption printed on top of it. The two now STACK — options, then the picture and its caption.
//
// P12: the wizard's backdrop was the usual translucent scrim, so the welcome library stayed
// legible behind the dialog; the phone also got only the box's 12 px content edge. The backdrop
// is plain (opaque, nothing behind it reads), the dialog keeps a 16 px gutter from the screen
// edge, and on a phone its content gets the same 16 px edge.

import { test, expect } from '../fixtures/caseMaker';

type Box = { left: number; top: number; right: number; bottom: number } | null;

test('#726 W19/P12 — Holding stacks at phone width, and the wizard is a plain sheet with a 16 px gutter', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();

  // P12 — a plain backdrop, a 16 px gutter either side, a 16 px content edge, no sideways scroll.
  const sheet = await page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="start-wizard"]') as HTMLElement;
    const box = overlay.querySelector('[role="dialog"]') as HTMLElement;
    const o = overlay.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return {
      background: getComputedStyle(overlay).backgroundColor,
      left: Math.round(b.left - o.left),
      right: Math.round(o.right - b.right),
      padding: getComputedStyle(box).padding,
      scrollW: document.documentElement.scrollWidth,
      vw: document.documentElement.clientWidth,
    };
  });
  // A plain backdrop has no alpha: the page behind the wizard cannot be read through it.
  expect(sheet.background).toMatch(/^rgb\(/);
  expect(sheet.left, 'gutter left').toBeGreaterThanOrEqual(16);
  expect(sheet.right, 'gutter right').toBeGreaterThanOrEqual(16);
  expect(sheet.padding).toBe('16px');
  expect(sheet.scrollW).toBeLessThanOrEqual(sheet.vw);

  // Door → the wizard's Holding step, with the exercise's plate typed by hand.
  await page.getByTestId('start-wizard-next').click();
  await page.getByTestId('start-wizard-form-plate').click();
  await page.getByTestId('start-wizard-make-length').fill('76.2');
  await page.getByTestId('start-wizard-make-width').fill('38.1');
  await page.getByTestId('start-wizard-make-thickness').fill('3.81');
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();

  const layout = await page.evaluate(() => {
    const box = (el: Element | null): { left: number; top: number; right: number; bottom: number } | null => {
      if (el === null) return null;
      const b = el.getBoundingClientRect();
      return {
        left: Math.round(b.left),
        top: Math.round(b.top),
        right: Math.round(b.right),
        bottom: Math.round(b.bottom),
      };
    };
    const columns = document.querySelector<HTMLElement>('[data-testid="engrave-setup-holding-columns"]');
    return {
      columns: columns === null ? null : getComputedStyle(columns).gridTemplateColumns,
      options: box(document.querySelector('[data-testid="engrave-setup-holding-vise"]')),
      picture: box(document.querySelector('[data-testid="engrave-setup-holding-picture"]')),
      caption: box(document.querySelector('[data-testid="engrave-setup-holding-caption"]')),
      scrollW: document.documentElement.scrollWidth,
      vw: document.documentElement.clientWidth,
    } satisfies {
      columns: string | null;
      options: Box;
      picture: Box;
      caption: Box;
      scrollW: number;
      vw: number;
    };
  });

  // ONE column: a computed two-track grid would list both tracks here.
  expect(layout.columns?.trim().split(/\s+/)).toHaveLength(1);
  expect(layout.options).not.toBeNull();
  expect(layout.picture).not.toBeNull();
  expect(layout.caption).not.toBeNull();
  // The picture and its caption sit BELOW the options — W19 was the opposite: an 86 px options
  // column with the picture over it and the caption printed across the option text.
  expect(layout.picture!.top).toBeGreaterThanOrEqual(layout.options!.bottom);
  expect(layout.caption!.top).toBeGreaterThanOrEqual(layout.picture!.bottom);
  expect(layout.scrollW).toBeLessThanOrEqual(layout.vw);

  await page.screenshot({ path: 'test-results/726-w19-holding-phone.png' });

  // The manager's own width (#726 review): 375 × 812, the narrower phone. Same two questions —
  // no horizontal page scroll and the 16 px gutter — asked again on the Holding step.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
  const narrow = await page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="start-wizard"]') as HTMLElement;
    const box = overlay.querySelector('[role="dialog"]') as HTMLElement;
    const o = overlay.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return {
      left: Math.round(b.left - o.left),
      right: Math.round(o.right - b.right),
      scrollW: document.documentElement.scrollWidth,
      vw: document.documentElement.clientWidth,
    };
  });
  expect(narrow.left, '375 px gutter left').toBeGreaterThanOrEqual(16);
  expect(narrow.right, '375 px gutter right').toBeGreaterThanOrEqual(16);
  expect(narrow.scrollW, '375 px horizontal page scroll').toBe(narrow.vw);
});
