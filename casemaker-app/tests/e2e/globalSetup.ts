/**
 * #704/#728 — refuse a dev server that belongs to ANOTHER checkout.
 *
 * Each checkout's e2e port is derived from its path (`scripts/e2ePort.ts`), but 100 ports cannot
 * keep well over 100 worktrees apart: two checkouts can hash to one port, and `reuseExistingServer`
 * would then attach to the other tree's server and test its code. Every dev server answers
 * `/__casemaker_checkout` with the directory it serves (`vite.config.ts`); this compares that with
 * the checkout running the tests, before any test runs. A server that does not answer (an older
 * build) is allowed through with a note, so the guard never blocks a run it cannot judge.
 */
import path from 'node:path';
import { devServerPort } from '../../scripts/e2ePort';

const norm = (p: string): string => path.resolve(p).replace(/\\/g, '/').toLowerCase();

export default async function globalSetup(): Promise<void> {
  const port = devServerPort();
  const url = `http://127.0.0.1:${port}/__casemaker_checkout`;
  let served: string | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) served = (await res.text()).trim();
  } catch {
    return; // nothing answered: Playwright's own webServer step reports a missing server
  }
  if (served === null || served === '' || served.startsWith('<')) {
    console.warn(`[e2e] the dev server on :${port} does not say which checkout it serves; continuing`);
    return;
  }
  if (norm(served) !== norm(process.cwd())) {
    throw new Error(
      `The dev server on port ${port} serves another checkout (${served}), not this one ` +
        `(${process.cwd()}). Two worktrees share a derived port: set CASEMAKER_PORT to a free port ` +
        'for this run, or stop the other server.',
    );
  }
}
