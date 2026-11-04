/**
 * #964 — THE SPAWN GUARD.
 *
 * B ran `clParity.spec` on Windows against the exact-contact drop-cutter: `cl-engine-check.ts`
 * passed 21/21 by hand, but the spec's spawned test failed EINVAL — `spawnSync('npx.cmd', …)`
 * without `shell: true` is refused on Node >= 20.12. `tsxCli.ts` runs tsx through the CURRENT
 * Node binary instead (`process.execPath` + tsx's own CLI entry), which needs neither the `.cmd`
 * shim nor a shell. This spec keeps a future edit from quietly reintroducing `npx`.
 */

import { isAbsolute } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TSX_CLI, tsxArgs } from '../tools/tsxCli';

describe('#964 the test CLI spawn is OS-safe', () => {
  it('resolves tsx’s own CLI entry to an absolute JS path', () => {
    expect(isAbsolute(TSX_CLI)).toBe(true);
    expect(TSX_CLI).toMatch(/\.(mjs|cjs|js)$/);
  });

  it('never builds an npx command — the .cmd shim is what Windows refuses', () => {
    const args = tsxArgs('some-script.ts', ['--flag']);
    expect(args[0]).toBe(TSX_CLI);
    expect(args.join(' ')).not.toMatch(/\bnpx(\.cmd)?\b/);
    expect(args).toContain('--tsconfig');
    expect(args).toContain('some-script.ts');
    expect(args).toContain('--flag');
  });
});
