// #704 — the per-checkout e2e dev-server port. Pure, so the rule is pinned without a server: the
// band, stability, the explicit override, CI, and the failure on a bad value.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEV_PORT,
  E2E_PORT_FIRST,
  E2E_PORT_LAST,
  devServerPort,
  fnv1a,
  portForCheckout,
} from '../../scripts/e2ePort';

describe('#704 the dev-server port belongs to the checkout', () => {
  it('derives a stable port in the band from the checkout path', () => {
    const port = portForCheckout('/mnt/c/Projects/cm-wt/704-e2e-port/casemaker-app');
    expect(port).toBeGreaterThanOrEqual(E2E_PORT_FIRST);
    expect(port).toBeLessThanOrEqual(E2E_PORT_LAST);
    // Stable: the same checkout, same port, every run.
    expect(portForCheckout('/mnt/c/Projects/cm-wt/704-e2e-port/casemaker-app')).toBe(port);
    // Two worktrees do not share one — the whole point (#704).
    expect(portForCheckout('/mnt/c/Projects/cm-wt/705-round-picture/casemaker-app')).not.toBe(port);
  });

  it('an explicit CASEMAKER_PORT wins — and a bad one fails loudly rather than guessing', () => {
    expect(devServerPort({ CASEMAKER_PORT: '5393' }, '/one/tree')).toBe(5393);
    expect(() => devServerPort({ CASEMAKER_PORT: 'e2e' }, '/one/tree')).toThrow(/CASEMAKER_PORT/);
    expect(() => devServerPort({ CASEMAKER_PORT: '70000' }, '/one/tree')).toThrow(/CASEMAKER_PORT/);
  });

  it('CI keeps the standard port; a plain checkout derives its own', () => {
    expect(devServerPort({ CI: 'true' }, '/one/tree')).toBe(DEFAULT_DEV_PORT);
    expect(devServerPort({}, '/one/tree')).toBe(portForCheckout('/one/tree'));
    // A blank variable is not an explicit choice.
    expect(devServerPort({ CASEMAKER_PORT: '  ' }, '/one/tree')).toBe(portForCheckout('/one/tree'));
  });

  it('the hash is FNV-1a, deterministic and unsigned', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('a')).toBe(fnv1a('a'));
  });
});
