import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

/**
 * Issue #504 — welcome template cards cut their description at four lines and
 * the old CSS let a fifth line leak out on desktop (the description was the
 * flex item carrying `flex: 1`, so flex-grow stretched it past the clamp).
 * A cut is only acceptable if there is a way to read the rest: the card
 * carries the full description as a `title` (hover) and as its accessible
 * description (keyboard focus / assistive tech).
 *
 * The assertion that catches the old CSS is the rendered height: at a desktop
 * width the mini-rack description measured 5.1 line-heights, while four lines
 * plus a pixel of rounding is the most a cut card may show. The disclosure
 * assertions are new behaviour; `title` was empty before #504.
 */

interface CardMetrics {
  testId: string;
  /** Full description text, straight from the DOM (the clamp is visual only). */
  description: string;
  descriptionId: string | null;
  title: string;
  describedBy: string | null;
  /** Rendered height in CSS px; four lines at line-height 16.8 is 67.2. */
  height: number;
  lineHeight: number;
  clientHeight: number;
  scrollHeight: number;
  overflow: string;
  lineClamp: string;
}

async function readTemplateCards(page: Page): Promise<CardMetrics[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid^="welcome-template-"]')).map(
      (card) => {
        const desc = card.querySelector<HTMLElement>('.wb-card__desc');
        if (!desc) throw new Error(`${card.dataset.testid} has no .wb-card__desc`);
        const cs = getComputedStyle(desc);
        return {
          testId: card.dataset.testid ?? '',
          description: desc.textContent ?? '',
          descriptionId: desc.id || null,
          title: card.title,
          describedBy: card.getAttribute('aria-describedby'),
          height: desc.getBoundingClientRect().height,
          lineHeight: parseFloat(cs.lineHeight),
          clientHeight: desc.clientHeight,
          scrollHeight: desc.scrollHeight,
          overflow: cs.overflow,
          lineClamp: cs.webkitLineClamp,
        };
      },
    ),
  );
}

/** Descriptions long enough that any sane card width cuts them. */
const LONG_TEMPLATE_IDS = ['mini-rack-10in', 'toolbox', 'tool-insert'];

// The viewports the visual walkthrough used (playwright.config.ts): the
// desktop band and the phone band. The clamp must hold at both; the old CSS
// failed only at desktop, which is why both widths are pinned.
const VIEWPORTS = [
  { name: 'desktop', width: 1500, height: 850 },
  { name: 'phone', width: 390, height: 844 },
] as const;

for (const viewport of VIEWPORTS) {
  test(`welcome template descriptions: four-line cut, full text disclosed (${viewport.name})`, async ({
    cm,
    page,
  }) => {
    await cm.ready();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // Let the responsive grid settle before measuring.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );

    const cards = await readTemplateCards(page);
    expect(cards.length, 'welcome template cards').toBeGreaterThanOrEqual(10);

    for (const card of cards) {
      // The cut: no card may render more than four lines of description.
      // +1px absorbs fractional line-height rounding (4 × 16.8 = 67.2).
      expect(
        card.height,
        `${card.testId} description height (four lines max)`,
      ).toBeLessThanOrEqual(card.lineHeight * 4 + 1);
      expect(card.lineClamp, `${card.testId} line clamp`).toBe('4');
      expect(card.overflow, `${card.testId} overflow`).toBe('hidden');

      // The full text is not lost: it is still in the DOM and the card
      // discloses it on hover and to assistive tech.
      expect(card.description, `${card.testId} description`).not.toBe('');
      expect(card.title, `${card.testId} hover title`).toBe(card.description);
      expect(card.describedBy, `${card.testId} aria-describedby`).toBe(card.descriptionId);
      expect(card.descriptionId, `${card.testId} description id`).toMatch(/^welcome-template-desc-/);
    }

    // Long descriptions must actually be cut — a box that merely happens to
    // fit would pass the height check without proving the clamp works.
    for (const id of LONG_TEMPLATE_IDS) {
      const card = cards.find((c) => c.testId === `welcome-template-${id}`);
      expect(card, `long template ${id}`).toBeDefined();
      expect(
        card!.scrollHeight,
        `${id} description has more text than the four-line cut`,
      ).toBeGreaterThan(card!.clientHeight + 1);
    }

    // Keyboard focus (and any screen reader) gets the complete description,
    // not the clipped DOM abbreviation.
    const mini = page.getByTestId('welcome-template-mini-rack-10in');
    const miniCard = cards.find((c) => c.testId === 'welcome-template-mini-rack-10in')!;
    await expect(mini).toHaveAccessibleName('Load Mini rack — 10" network rack template');
    await mini.focus();
    await expect(mini).toBeFocused();
    await expect(mini).toHaveAccessibleDescription(miniCard.description);
  });
}
