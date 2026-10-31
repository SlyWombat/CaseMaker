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
  it('the machine follows the relay; the filesystem and the server controls stay Tauri-only (#821)', () => {
    // The static deploy has no relay at all.
    expect(capabilitiesFor('web')).toEqual({
      buildTarget: 'web',
      canReachMachine: false,
      canReadLocalFiles: false,
      canRunLocalServer: false,
    });
    // The house bundle is served TO a LAN browser BY a local instance: it reaches the machine
    // through that instance's relay, but it does not own a local filesystem or host the server.
    expect(capabilitiesFor('house')).toEqual({
      buildTarget: 'house',
      canReachMachine: true,
      canReadLocalFiles: false,
      canRunLocalServer: false,
    });
    // The Tauri shell has all three.
    expect(capabilitiesFor('desktop')).toEqual({
      buildTarget: 'desktop',
      canReachMachine: true,
      canReadLocalFiles: true,
      canRunLocalServer: true,
    });
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

  it('the relay-less sentence says why, and where a machine can be driven — in one sentence (#821)', () => {
    expect(NO_MACHINE_RELAY_SENTENCE).toMatch(/without the machine relay/);
    expect(NO_MACHINE_RELAY_SENTENCE).toMatch(/house server or the desktop app/);
    expect(NO_MACHINE_RELAY_SENTENCE.split('.').filter((part) => part.trim() !== '')).toHaveLength(1);
  });

  // #821 — THE DESKTOP BUNDLE OPENED FROM THE LAN. A LAN browser hitting the Tauri app's own
  // embedded server gets the DESKTOP bundle, where `canReachMachine` is true; it has no Tauri
  // runtime, so the transport must be the app's HTTP relay, exactly like the house bundle on k3.
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
