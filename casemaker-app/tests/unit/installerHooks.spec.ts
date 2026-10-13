// The installer hook and the app's own constants live in different languages and nothing else ties
// them together (#403). The installer opens a firewall port for the Z1's discovery broadcast
// (UDP, inbound); the app binds that port. Drift means discovery fails on a machine where the
// install "succeeded": the datagram is dropped and the panel just reports no machine found.
//
// This reads the hook off disk and holds the two together, because there is nothing else that can.
// The .nsh is compiled by makensis — `src-tauri/nsis-harness.sh` runs the hook and covers what it
// WRITES — and no part of the JS build ever reads it. What is asserted here is therefore the joint
// the harness cannot see: the port the rule opens, that the rule is replaced rather than stacked,
// and that the uninstaller removes it only on a real uninstall.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DISCOVERY_UDP_PORT } from '@/platform/desktop/protocol';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src-tauri', 'installer-hooks.nsh');
const source = readFileSync(HOOKS, 'utf8');

/** The uninstall hook's own text, so its assertions cannot be satisfied by the install half. */
const preuninstall = source.slice(source.indexOf('!macro NSIS_HOOK_PREUNINSTALL'));

describe('the installer hook and the app agree (#403)', () => {
  it('opens the UDP port the app binds for discovery', () => {
    expect(source).toContain(`protocol=UDP localport=${DISCOVERY_UDP_PORT}`);
  });

  it('deletes the discovery rule before adding it, so a change replaces rather than stacks', () => {
    const del = source.indexOf('advfirewall firewall delete rule name="Case Maker Discovery"');
    const add = source.indexOf('advfirewall firewall add rule name="Case Maker Discovery"');
    expect(del).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThan(del);
  });

  it('removes the discovery rule on a real uninstall', () => {
    expect(preuninstall).toContain('delete rule name="Case Maker Discovery"');
  });

  it('leaves the discovery rule alone during an update', () => {
    // An update runs the uninstaller too, and the install that follows re-adds the rule: deleting
    // it here would open a window with discovery blocked for no reason.
    const guard = preuninstall.indexOf('${If} $UpdateMode <> 1');
    const del = preuninstall.indexOf('delete rule name="Case Maker Discovery"');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(guard);
  });
});
