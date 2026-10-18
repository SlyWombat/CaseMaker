// The committed project sample the CLI chapter's round-trip test reads (#484).
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/gen-docs-sample.ts
//
// WHY A GENERATOR. `docs/bench/bench-sample.caseproj.json` must be a document the app itself
// would save, not a hand-written approximation of one: a schema drift then shows up as a
// regeneration diff rather than a fixture that has quietly stopped being valid. There is no
// `casemaker new-project` subcommand today (#498 is the question about one), so this is the
// smallest reproducible route: call the store's own `createDefaultProject`, the same function the
// app's New-project action uses, from a script (as `export-sample.ts` does).
//
// The ids and timestamps are then pinned. `createDefaultProject` stamps `new Date(0)` already, but
// every id comes from `newId()`, which is random; a committed document may not change from one
// regeneration to the next, so the ids are rewritten to fixed ones here. `parseProject` accepts
// them — an id is opaque.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootstrap } from '../src/platform/headless/bootstrap';
import { serializeProject } from '../src/store/persistence';
import { createDefaultProject } from '../src/store/projectStore';

// The board library and the wasm seam, exactly as every headless entry point resolves them (#476).
await bootstrap();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const out = join(repoRoot, 'docs', 'bench', 'bench-sample.caseproj.json');

const project = createDefaultProject('esp32-devkit-v1');
project.id = 'proj-docs-sample';
project.name = 'ESP32 DevKit V1 — CLI sample';
project.board.id = 'custom-esp32-devkit-v1-docs-sample';
project.ports = project.ports.map((port, i) => ({
  ...port,
  id: `port-docs-sample-${i}-${port.sourceComponentId}`,
}));

writeFileSync(out, serializeProject(project));
console.log(`wrote ${out}`);
