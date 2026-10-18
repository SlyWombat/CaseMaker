/**
 * Writes the headless MCP JSON Schemas (#480) to `src/platform/headless/schemas/`.
 *
 * Run from `casemaker-app/` with:
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/gen-mcp-schemas.ts
 *
 * `package.json` is deliberately untouched: this is a checked-in artifact, not a build step.
 * `tests/unit/mcpSchemas.spec.ts` regenerates the same text and fails when a checked-in file is
 * stale, so forgetting to rerun this is a red test rather than a silent drift.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateMcpSchemas } from '../src/platform/headless/mcpSchemas';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'src', 'platform', 'headless', 'schemas');

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, json] of Object.entries(generateMcpSchemas())) {
  const path = join(OUT_DIR, `${name}.json`);
  writeFileSync(path, json);
  console.log(`wrote ${path}`);
}
