import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILD_TARGET,
  canDriveMachine,
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
  it('the pure matrix is desktop-only for machine, files and server; web has none', () => {
    expect(capabilitiesFor('web')).toEqual({
      buildTarget: 'web',
      canDriveMachine: false,
      canReadLocalFiles: false,
      canRunLocalServer: false,
    });
    expect(capabilitiesFor('desktop')).toEqual({
      buildTarget: 'desktop',
      canDriveMachine: true,
      canReadLocalFiles: true,
      canRunLocalServer: true,
    });
  });

  it('the runtime constants match the web matrix under the test build', () => {
    // vitest.config.ts defines __BUILD_TARGET__ as 'web', so the exported constants must equal
    // capabilitiesFor('web') — the constants and the pure matrix cannot drift.
    const web = capabilitiesFor('web');
    expect(BUILD_TARGET).toBe('web');
    expect(canDriveMachine).toBe(web.canDriveMachine);
    expect(canReadLocalFiles).toBe(web.canReadLocalFiles);
    expect(canRunLocalServer).toBe(web.canRunLocalServer);
  });

  it('loadMachineBridge refuses on a non-desktop build rather than half-working', async () => {
    await expect(loadMachineBridge()).rejects.toThrow(/desktop build/i);
  });

  it('no source file reads window.__TAURI_INTERNALS__ any more (#181 migrated the only one)', () => {
    const offenders = walk(join(process.cwd(), 'src')).filter((file) =>
      readFileSync(file, 'utf8').includes('__TAURI_INTERNALS__'),
    );
    expect(offenders).toEqual([]);
  });
});
