// @vitest-environment jsdom
// #372 — the "App server" section of the settings dialog: the port and the LAN bind.
//
// WHY THIS SPEC EXISTS AT ALL, AND WHAT THE BROWSER RUN CANNOT DO. The controls are drawn only under
// `canRunLocalServer`, which is a BUILD-TIME constant, so a Playwright run against the web build can
// only ever prove that they are absent (which `tests/e2e/settings.spec.ts` does). Every rule about
// what they do lives behind the seam instead: the capability is mocked on (the pattern #354/#346
// established) and the house client is swapped for a fake, so the real `SettingsMenu` — and the real
// `houseClient` calls it makes — run against a service that answers.
//
// WHAT IS PINNED HERE. That the numbers come from the service and not from local state (which is the
// defect: the old field wrote a copy nothing read); that a save sends the whole pair and believes the
// answer rather than assuming it; that the warning about the restart is shown exactly while the saved
// port and the serving port disagree, in the refusal's own words; and that a refusal — the 403 a LAN
// browser gets (decision 35) — is shown verbatim, because there is no second copy of that sentence on
// this side to drift from the service's.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsMenu } from '@/components/layout/SettingsMenu';
import {
  setHouseClientLoader,
  type HouseCall,
  type HouseClient,
  type ServerConfig,
} from '@/platform/houseClient';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A getter, so a test reads the capability at render rather than at import — the same seam
// `manageMode.spec.tsx` uses for `canDriveMachine`.
const caps = vi.hoisted(() => ({ server: true }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canRunLocalServer() {
      return caps.server;
    },
  };
});

/** One request the fake service was asked, so a test can say what was NOT sent as well as what was. */
interface Seen {
  method: string;
  path: string;
  body: unknown;
}

/**
 * A service that answers `/api/v1/config` and nothing else. Reads give `serving`, writes are handed
 * to `onWrite` — which is where a test says what the service would do about them — and every request
 * is recorded.
 */
function fakeService(serving: ServerConfig, onWrite?: (body: unknown) => HouseCall) {
  const seen: Seen[] = [];
  const unused = async (): Promise<{ kind: 'absent'; reason: string }> => ({
    kind: 'absent',
    reason: 'not asked for in this spec',
  });
  const client: HouseClient = {
    probe: unused,
    tools: unused,
    feeds: unused,
    inventory: unused,
    call: async (method, path, body): Promise<HouseCall> => {
      seen.push({ method, path, body });
      if (method === 'GET') return { kind: 'ok', text: JSON.stringify(serving) };
      return onWrite ? onWrite(body) : { kind: 'ok', text: JSON.stringify(serving) };
    },
  };
  setHouseClientLoader(async () => client);
  return seen;
}

/** Render the dialog and wait for the section's read to land, which is what draws its controls. */
async function openDialog(): Promise<void> {
  render(<SettingsMenu onClose={() => {}} />);
  await waitFor(() => expect(screen.getByTestId('settings-port')).toBeTruthy());
}

function portBox(): HTMLInputElement {
  return screen.getByTestId('settings-port') as HTMLInputElement;
}

/** Type a port and commit it, the way the field takes one. */
function type(port: string): void {
  fireEvent.change(portBox(), { target: { value: port } });
  fireEvent.blur(portBox());
}

beforeEach(() => {
  caps.server = true;
});

afterEach(() => {
  cleanup();
  setHouseClientLoader(null);
});

describe('the app server settings (#372)', () => {
  it('shows the settings the service reports, not a local copy', async () => {
    const seen = fakeService({ port: 8123, bindToAll: true, servingPort: 8123 });
    await openDialog();
    expect(portBox().value).toBe('8123');
    expect((screen.getByTestId('settings-bind-all') as HTMLInputElement).checked).toBe(true);
    // And the numbers came from the service, at the one path both ends share.
    expect(seen).toEqual([{ method: 'GET', path: '/config', body: undefined }]);
  });

  it('warns about the new origin only while the saved port is not the port in force', async () => {
    // A fresh install: the file says what this process is serving, so nothing is pending and there is
    // nothing to warn about.
    fakeService({ port: 8123, bindToAll: false, servingPort: 8123 });
    await openDialog();
    expect(screen.queryByTestId('settings-port-pending')).toBeNull();
  });

  it('saves the whole pair and believes the answer rather than assuming it', async () => {
    const seen = fakeService({ port: 8000, bindToAll: false, servingPort: 8000 }, (body) => ({
      kind: 'ok',
      // The service's answer to a write: the settings as it now holds them, and the port THIS process
      // is on. The two disagree, which is the state the banner exists for.
      text: JSON.stringify({ ...(body as object), servingPort: 8000 }),
    }));
    await openDialog();
    type('8123');

    await waitFor(() => expect(screen.getByTestId('settings-port-pending')).toBeTruthy());
    // Both fields are sent: the endpoint takes a statement about the settings, not a partial edit
    // (the Rust side refuses a body missing either one).
    expect(seen).toContainEqual({
      method: 'POST',
      path: '/config',
      body: { port: 8123, bindToAll: false },
    });
    // The banner names the port that is actually being served — the service's number, not the one
    // the user typed.
    expect(screen.getByTestId('settings-serving-port').textContent).toBe('8000');
    // And it uses the refusal's own words for what the restart costs (decision 34/35): a port change
    // is a new origin and an empty app.
    expect(screen.getByTestId('settings-port-pending').textContent).toContain(
      'A different port is a different origin',
    );
    expect(screen.getByTestId('settings-port-pending').textContent).toContain(
      'your saved settings, library and run records missing',
    );
    // The box holds what the file now says.
    expect(portBox().value).toBe('8123');
  });

  it('sends the LAN bind on its own, with the port unchanged', async () => {
    const seen = fakeService({ port: 8123, bindToAll: false, servingPort: 8123 });
    await openDialog();
    fireEvent.click(screen.getByTestId('settings-bind-all'));
    await waitFor(() => expect(seen.some((c) => c.method === 'POST')).toBe(true));
    expect(seen).toContainEqual({
      method: 'POST',
      path: '/config',
      body: { port: 8123, bindToAll: true },
    });
  });

  it('shows a refusal in the service’s own words, and puts the box back', async () => {
    // The 403 a browser on the LAN gets: this endpoint writes the HOST's settings, so only the host
    // may write them (decision 35). The sentence is written by the service for the user, and it is
    // shown as-is — this side does not have its own copy of it.
    const refusal =
      "Case Maker's own settings can only be changed from the machine it runs on, and this request " +
      'came from 192.168.10.44. Open the app on that machine, or start it with --port or --bind-all ' +
      'to change which port and address it serves on.';
    const seen = fakeService(
      { port: 8000, bindToAll: false, servingPort: 8000 },
      () => ({ kind: 'refused', status: 403, message: refusal }),
    );
    await openDialog();
    type('8123');

    await waitFor(() =>
      expect(screen.getByTestId('settings-server-error').textContent).toBe(refusal),
    );
    // Nothing was saved, so the box shows what is actually in the file rather than what was refused.
    expect(portBox().value).toBe('8000');
    // The requested port DID reach the service — the range and the type are its judgement, and its
    // refusal names them; nothing here pre-empts that with a rule of its own.
    expect(seen).toContainEqual({
      method: 'POST',
      path: '/config',
      body: { port: 8123, bindToAll: false },
    });
  });

  it('does not ask the service about a box that holds no number', async () => {
    // `Number('')` is 0, which is a port the service would refuse — but an empty box is not a claim
    // about a port at all, so nothing is sent and the box goes back to what the file says.
    const seen = fakeService({ port: 8123, bindToAll: false, servingPort: 8123 });
    await openDialog();
    type('');
    type('abc');
    expect(seen.filter((c) => c.method === 'POST')).toEqual([]);
    expect(portBox().value).toBe('8123');
  });

  it('draws nothing, and asks nothing, in a build with no embedded server', async () => {
    caps.server = false;
    const seen = fakeService({ port: 8123, bindToAll: false, servingPort: 8123 });
    render(<SettingsMenu onClose={() => {}} />);
    // The rest of the dialog is there — only the server section is gone.
    expect(screen.getByTestId('settings-export-format')).toBeTruthy();
    expect(screen.queryByTestId('settings-port')).toBeNull();
    expect(screen.queryByTestId('settings-bind-all')).toBeNull();
    // Not merely undrawn: a web build never reaches for an endpoint its host has no reason to serve.
    await waitFor(() => expect(screen.getByTestId('settings-export-layout')).toBeTruthy());
    expect(seen).toEqual([]);
  });
});
