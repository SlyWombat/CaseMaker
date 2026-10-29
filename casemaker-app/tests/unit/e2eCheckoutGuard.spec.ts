// #704/#728 — the e2e global setup refuses a reused dev server that serves another checkout.
import { afterEach, describe, expect, it, vi } from 'vitest';
import globalSetup from '../e2e/globalSetup';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function serving(text: string | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      text === null ? Promise.reject(new Error('ECONNREFUSED')) : new Response(text, { status: 200 }),
    ),
  );
}

describe('#728 — the e2e checkout guard', () => {
  it('passes a server that serves this checkout', async () => {
    vi.stubEnv('CASEMAKER_PORT', '5999');
    serving(process.cwd());
    await expect(globalSetup()).resolves.toBeUndefined();
  });

  it('refuses a server that serves another checkout, naming both and the way out', async () => {
    vi.stubEnv('CASEMAKER_PORT', '5999');
    serving('/somewhere/else/casemaker-app');
    await expect(globalSetup()).rejects.toThrow(/port 5999 serves another checkout \(\/somewhere\/else\/casemaker-app\).*set CASEMAKER_PORT/);
  });

  it('lets a run through when nothing answers (the webServer step reports that) or the server cannot say', async () => {
    vi.stubEnv('CASEMAKER_PORT', '5999');
    serving(null);
    await expect(globalSetup()).resolves.toBeUndefined();
    serving('<!doctype html>');
    await expect(globalSetup()).resolves.toBeUndefined();
  });
});
