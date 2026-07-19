import { test, expect } from './fixtures/caseMaker';

test('Docs button opens the modal; nav switches between docs; Escape closes', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.getByTestId('docs-open').click();
  await expect(page.getByTestId('docs-modal')).toBeVisible();
  // Registry order puts the User Manual first, so it's the default doc.
  await expect(page.getByTestId('docs-content-user-manual')).toContainText('Parameter dictionary');

  await page.getByTestId('docs-nav-getting-started').click();
  await expect(page.getByTestId('docs-content-getting-started')).toContainText('Getting Started');

  await page.getByTestId('docs-nav-technical-reference').click();
  await expect(page.getByTestId('docs-content-technical-reference')).toContainText('Module API');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('docs-modal')).toBeHidden();
});

test('Docs modal renders markdown blockquote admonitions', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('docs-open').click();
  await page.getByTestId('docs-nav-user-manual').click();
  // The user manual contains "> **Note:**" admonitions; confirm rendered as blockquote
  const blockquoteCount = await page.locator('.docs-modal-content blockquote').count();
  expect(blockquoteCount).toBeGreaterThan(0);
});
