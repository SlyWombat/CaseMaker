import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILD_TARGET,
  NO_MACHINE_RELAY_SENTENCE,
  canReachMachine,
  canReadLocalFiles,
  canRunLocalServer,
  capabilitiesFor,
  isTauriWindow,
  loadMachineBridge,
} from '@/platform/capabilities';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe('#181 platform capabilities', () => {
  it('one package: the machine follows the bundle; the window controls follow isTauri (#867)', () => {
    // The static deploy has no relay at all.
    expect(capabilitiesFor('web')).toEqual({
      buildTarget: 'web',
      canReachMachine: false,
      canReadLocalFiles: false,
      canRunLocalServer: false,
    });
    // The desktop bundle served TO a LAN browser BY a local install: it reaches the machine
    // through the instance's relay, but it does not own the window — no filesystem dialogs and no
    // server controls.
    expect(capabilitiesFor('desktop', { tauri: false })).toEqual({
      buildTarget: 'desktop',
      canReachMachine: true,
      canReadLocalFiles: false,
      canRunLocalServer: false,
    });
    // The same bundle inside the Tauri window has all three.
    expect(capabilitiesFor('desktop', { tauri: true })).toEqual({
      buildTarget: 'desktop',
      canReachMachine: true,
      canReadLocalFiles: true,
      canRunLocalServer: true,
    });
  });

  it('isTauriWindow reads the runtime flag the Tauri v2 shell sets, and nothing else', () => {
    const globals = globalThis as { isTauri?: unknown };
    const had = globals.isTauri;
    try {
      delete globals.isTauri;
      expect(isTauriWindow()).toBe(false);
      globals.isTauri = true;
      expect(isTauriWindow()).toBe(true);
      globals.isTauri = 'yes';
      expect(isTauriWindow()).toBe(false);
    } finally {
      if (had === undefined) delete globals.isTauri;
      else globals.isTauri = had;
    }
  });

  it('the runtime constants match the web matrix under the test build', () => {
    // vitest.config.ts defines __BUILD_TARGET__ as 'web', so the exported constants must equal
    // capabilitiesFor('web') — the constants and the pure matrix cannot drift.
    const web = capabilitiesFor('web');
    expect(BUILD_TARGET).toBe('web');
    expect(canReachMachine).toBe(web.canReachMachine);
    expect(canReadLocalFiles).toBe(web.canReadLocalFiles);
    expect(canRunLocalServer).toBe(web.canRunLocalServer);
  });

  it('loadMachineBridge refuses on the relay-less build rather than half-working', async () => {
    await expect(loadMachineBridge()).rejects.toThrow(/machine bridge/i);
  });

  it('the relay-less sentence says why, and where a machine can be driven — in one sentence (#821/#867)', () => {
    // #1106 (later) rewrote the sentence to the positive form — what this page can do, and where
    // the machine is driven. The later issue's wording wins; the one-sentence rule stays.
    expect(NO_MACHINE_RELAY_SENTENCE).toMatch(/write, check and simulate/);
    expect(NO_MACHINE_RELAY_SENTENCE).toMatch(/open the desktop app/);
    expect(NO_MACHINE_RELAY_SENTENCE.split('.').filter((part) => part.trim() !== '')).toHaveLength(1);
  });

  // #821 — THE DESKTOP BUNDLE OPENED FROM THE LAN. A LAN browser hitting the Tauri app's own
  // embedded server gets the DESKTOP bundle, where `canReachMachine` is true; it has no Tauri
  // runtime, so the transport must be the app's HTTP relay — the same page a headless install serves on k3.
  it('a machine-carrying bundle in a plain browser uses the HTTP relay; only the Tauri shell uses IPC', async () => {
    const { defaultTransport } = await import('@/platform/desktop/machineBridge');
    const { httpTransport } = await import('@/platform/desktop/httpTransport');
    const { tauriTransport } = await import('@/platform/desktop/transport');
    const globals = globalThis as { isTauri?: unknown };
    const had = globals.isTauri;
    try {
      delete globals.isTauri;
      // No Tauri runtime: k3's browser, and a LAN browser on the desktop app's own server.
      expect(defaultTransport()).toBe(httpTransport);
      globals.isTauri = true;
      expect(defaultTransport()).toBe(tauriTransport);
    } finally {
      if (had === undefined) delete globals.isTauri;
      else globals.isTauri = had;
    }
  });

  it('no source file reads window.__TAURI_INTERNALS__ any more (#181 migrated the only one)', () => {
    const offenders = walk(join(process.cwd(), 'src')).filter((file) =>
      readFileSync(file, 'utf8').includes('__TAURI_INTERNALS__'),
    );
    expect(offenders).toEqual([]);
  });
});
