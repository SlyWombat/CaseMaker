#!/usr/bin/env node
// The package `bin` (#477). npm links this file; it re-executes `scripts/casemaker.ts` through tsx
// with this package's `tsconfig.scripts.json`, so the `@/…` aliases resolve no matter which
// directory the user runs `casemaker` from.
//
// A separate JS shim rather than a `#!/usr/bin/env -S npx tsx` shebang: npx resolves from the
// CALLER's directory, which would fail outside the package, and npm's Windows shims do not all
// understand `env -S`. `node --import tsx` is the same loader the npm scripts use, with the config
// named explicitly.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// A file: URL, not a path: `--import` is a module specifier, and an absolute Windows path would be
// read as a `c:` URL.
const tsxEntry = import.meta.resolve('tsx');
const result = spawnSync(
  process.execPath,
  ['--import', tsxEntry, join(here, 'casemaker.ts'), ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: join(here, '..', 'tsconfig.scripts.json'),
    },
  },
);

if (result.error) {
  console.error(`casemaker: could not start tsx — ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
