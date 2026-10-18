/**
 * `casemaker export <project.json>` (#477) — the ProjectCompiler → Manifold → STL path the sample
 * script has always used, applied to a project the user saved from the app.
 *
 * The output is one binary STL with the parts laid out print-ready and the PRINT-NOTES sidecar
 * beside it, exactly as `scripts/export-sample.ts` writes its committed samples. Nothing is patched
 * here: the project document is read as saved, and #482's case-patch path is out of scope.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { bootstrap } from '../../../src/platform/headless/bootstrap';
import { RECEIPT_VERSION } from '../../../src/platform/headless/receipt';
import { parseProject } from '../../../src/store/persistence';
import { CliExit, isCliExit } from './exit';
import { commandOutput, HUMAN, type CommandOptions } from './output';
import { writeProjectStl } from './projectExport';
import { fileReceipt } from './receiptFiles';

interface Args {
  project?: string;
  out?: string;
  location?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--location') args.location = argv[++i];
    else if (a !== undefined && a.startsWith('--')) throw new Error(`unknown flag "${a}"`);
    else if (args.project === undefined) args.project = a;
    else throw new Error(`unexpected argument "${a}"`);
  }
  return args;
}

function fail(message: string): never {
  console.error(`casemaker export: ${message}`);
  throw new CliExit(1);
}

const USAGE =
  'usage: casemaker export <project.json> [--out <dir>] [--location <location.json|house.json>]\n' +
  '       <project.json> is a project saved by the app (.caseproj.json);\n' +
  '       the STL and its PRINT-NOTES sidecar go beside it unless --out says otherwise.';

/**
 * A file name from the project's own name. The same rule the app uses for a saved project
 * (`persistence.ts`), so the STL a CLI export writes is named the way the user already expects.
 */
function stemFor(name: string): string {
  const safe = name.replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '');
  return safe === '' ? 'project' : safe;
}

/** Run the export. Returns the process exit code; a refusal has already been printed. */
export async function exportMain(argv: string[], options: CommandOptions = HUMAN): Promise<number> {
  try {
    return await exportBody(argv, options);
  } catch (e) {
    if (isCliExit(e)) return e.code;
    throw e;
  }
}

async function exportBody(argv: string[], options: CommandOptions): Promise<number> {
  const out = commandOutput(options);
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    fail(`${(e as Error).message}\n${USAGE}`);
    throw e; // unreachable; `fail` throws
  }
  if (!args.project) fail(USAGE);

  const path = args.project;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`cannot read ${path}: ${(e as Error).message}`);
  }

  let project: ReturnType<typeof parseProject>;
  try {
    project = parseProject(JSON.stringify(raw));
  } catch (e) {
    fail(`${path} is not a valid project:\n  ${(e as Error).message}`);
  }

  // The wasm module — and, harmlessly, the fonts and the machine's document — through the one
  // headless bootstrap every entry point shares (#476).
  const { manifold: tl } = await bootstrap({ location: args.location });

  const outDir = args.out ?? dirname(path);
  mkdirSync(outDir, { recursive: true });
  const filename = `${stemFor(project.name)}.stl`;
  const written = await writeProjectStl(tl, project, outDir, filename);

  // One receipt for the run (#478): the project it read, both files it wrote with their hashes, and
  // the triangle count — `renderReceipt` is what turns these into the three lines an operator sees.
  out.emitReceipt({
    version: RECEIPT_VERSION,
    command: 'export',
    ok: true,
    stage: 'written',
    gate: null,
    inputs: [fileReceipt(path)],
    outputs: [fileReceipt(join(outDir, written.fileName)), fileReceipt(join(outDir, written.notesFileName))],
    diagnostics: [],
    provenance: [],
    refusals: [],
    details: { triangles: written.triangles },
  });
  return 0;
}
