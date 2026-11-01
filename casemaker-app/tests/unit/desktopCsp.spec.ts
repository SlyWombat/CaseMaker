// #837 — THE DESKTOP APP'S CONTENT-SECURITY-POLICY, read from the config the desktop build
// compiles in (`src-tauri/tauri.conf.json`; tauri-build embeds it in the binary, so this file IS
// the built policy).
//
// WHAT NEEDED `'unsafe-eval'`, and what the answer was:
//
//  - NOTHING, in any path this app takes. The only eval-like call left in the production bundle is
//    manifold-3d 3.4.1's Emscripten method-caller factory (`Function(Object.keys(captures), body)`),
//    and it is LAZY: it runs only when a JavaScript function is passed INTO wasm (a `warp`-style
//    callback). No manifold API this app calls takes a function — `grep -rn '\.warp(\|\.setProperties('
//    src/` finds none — and the runtime check described here never reaches it.
//  - zod PROBES eval (`try { Function('') } catch`) to choose its JIT parser. A refusal is a
//    fallback, not a failure: the probe sits in a try/catch and zod parses without it.
//  - WASM is the one thing the policy must still allow: `'wasm-unsafe-eval'` is the CSP keyword
//    that permits compiling WebAssembly (Manifold), and Chromium/WebView2 refuses wasm without it.
//
// manifold-3d 3.5 replaces that factory with `Object.defineProperty` and would remove the last
// eval-like construct from the bundle entirely — but 3.5 also re-splits one template node
// (`guition-pocket-shelf/pocket-tray`, templateIntegrity), so the upgrade is its own piece of work
// and not a prerequisite for this policy.
//
// Verified at runtime for the hand-in: the PRODUCTION bundle (built with the locked manifold
// 3.4.1), served with exactly this header, starts a project and compiles geometry through the
// geometry worker (Manifold) with no Content-Security-Policy violation in the console.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src-tauri', 'tauri.conf.json');

interface TauriConf {
  app?: { security?: { csp?: string } };
}

const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as TauriConf;
const csp = config.app?.security?.csp ?? '';

/** The policy's directives as a name → tokens table. */
function directives(policy: string): Map<string, string[]> {
  const table = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter((t) => t !== '');
    const name = tokens.shift();
    if (name !== undefined) table.set(name, tokens);
  }
  return table;
}

const policy = directives(csp);

describe('#837 the desktop CSP carries no eval', () => {
  it('declares a policy at all, and no directive anywhere allows eval', () => {
    expect(csp).not.toBe('');
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('script-src allows wasm but not eval, and not inline scripts either', () => {
    const script = policy.get('script-src') ?? [];
    expect(script).toContain("'self'");
    // The wasm allowance is the reason this directive cannot be bare: Manifold is compiled wasm.
    expect(script).toContain("'wasm-unsafe-eval'");
    expect(script).not.toContain("'unsafe-inline'");
    // The app's own local endpoints stay reachable from its script.
    expect(script).toContain('tauri:');
    expect(script).toContain('ipc:');
    expect(script).toContain('http://ipc.localhost');
  });

  it('the rest of the policy the app needs is unchanged', () => {
    // Workers from blobs are how the geometry/sim workers are created; the relay and the
    // machine WebSocket are the connect sources. Styles keep 'unsafe-inline' — React writes
    // style attributes, and a style hole is not a script hole.
    expect(policy.get('worker-src') ?? []).toEqual(expect.arrayContaining(["'self'", 'blob:']));
    expect(policy.get('connect-src') ?? []).toEqual(expect.arrayContaining(["'self'", 'ws:', 'wss:']));
    expect(policy.get('style-src') ?? []).toEqual(expect.arrayContaining(["'self'", "'unsafe-inline'"]));
    expect(policy.get('default-src') ?? []).toContain("'self'");
  });
});
