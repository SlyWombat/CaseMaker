// The camera calibration target — issue #189, the half that needs no machine.
//
// #189 calibrates the Z1's integrated camera, and its central idea is that THE MACHINE IS THE
// LENGTH STANDARD, not the paper: a printed sheet is 0.2–0.5 % out and moves with the humidity, so
// every distance is measured by commanding a move and watching the image shift. That makes the
// target a thing you can build today, with no camera and no bridge: a printed fine pattern for
// sub-pixel corner finding, and crosses MILLED at commanded positions so their machine coordinates
// are known by construction — which is also how the camera-to-spindle offset gets closed.
//
//   npm run camera:target                     -> samples/camera-target.svg + samples/camera-target.job.json
//   npm run camera:target -- --spec t.json    -> use a CameraTargetSpec instead of the derived default
//   npm run camera:target -- --base s.json    -> use a saved job as the sheet (thickness, cutter, vise)
//   npm run camera:target -- --out dir        -> write somewhere else (CAMERA_TARGET_OUT does too)
//   npm run camera:target -- --svg-only       -> the printable art only, no mill job
//
// WHY THIS HANDS OFF RATHER THAN CUTTING. The `.nc`, the dry-run frame and the run sheet are
// `scripts/engrave-job.ts`'s job — that is the app's ONE scriptable path from an `EngraveJob`
// document to the files the bench needs (#248), and a second copy of that pipeline here is a second
// thing to drift. So this writes the art and the resolved JOB DOCUMENT, and prints the exact
// command that cuts it. Nothing here evaluates geometry or talks to wasm.
//
// What is NOT here: identity markers (ArUco/ChArUco). Their bit patterns are a dictionary — data,
// not something to invent — and a fabricated marker is one no detector will ever find. #189 records
// the decision; `targetSpec.ts` says the same at the point of use.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultEngraveJob } from '../src/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '../src/store/engraveJobSchema';
import {
  cameraFiducialCutCount,
  cameraFiducialJob,
  cameraTargetCheckerExtent,
  cameraTargetCheckerSquares,
  cameraTargetFiducialZones,
  cameraTargetFiducials,
  cameraTargetFor,
  cameraTargetProblem,
  cameraTargetSvg,
  cameraTargetSvgFileName,
  type CameraTargetSpec,
} from '../src/engine/cnc/camera';
import type { EngraveJob } from '../src/types/engraveJob';

const here = dirname(fileURLToPath(import.meta.url));
// Default output is the shared `samples/`, like the fit coupons. `CAMERA_TARGET_OUT` or `--out`
// redirects it, so the generator can be verified without touching that directory.
const defaultOut = process.env.CAMERA_TARGET_OUT ?? join(here, '..', '..', 'samples');

function fail(message: string): never {
  console.error(`camera-target: ${message}`);
  process.exit(1);
}

interface Args {
  spec?: string;
  base?: string;
  out?: string;
  svgOnly?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--spec') args.spec = argv[++i];
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--svg-only') args.svgOnly = true;
    else fail(`unknown flag "${a}"\n${USAGE}`);
  }
  return args;
}

const USAGE =
  'usage: scripts/camera-target.ts [--spec <target.json>] [--base <job.json>] [--out <dir>] [--svg-only]';

const args = parseArgs(process.argv.slice(2));

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return fail(`cannot read ${path}: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The spec: the derived default, or a whole CameraTargetSpec from JSON
// ---------------------------------------------------------------------------------------------

/**
 * A `--spec` file is a PARTIAL spec — the derived default filled in with whatever the file names.
 * The sheet's size, the grid's arithmetic and the pitch all come from `cameraTargetFor`, so a file
 * that only says "use a 6 mm checker square" cannot silently also move the fiducials.
 */
function specFrom(json: unknown, path: string): CameraTargetSpec {
  if (json === null || typeof json !== 'object') fail(`${path} is not a JSON object`);
  const raw = json as Partial<CameraTargetSpec>;
  const merged = cameraTargetFor(undefined, {
    ...raw,
    sheet: { ...cameraTargetFor().sheet, ...raw.sheet },
    fiducials: { ...cameraTargetFor().fiducials, ...raw.fiducials },
    checker: { ...cameraTargetFor().checker, ...raw.checker },
  });
  return merged;
}

const spec = args.spec ? specFrom(readJson(args.spec), args.spec) : cameraTargetFor();

const problem = cameraTargetProblem(spec);
if (problem !== null) fail(`the target does not hold together: ${problem}`);

// ---------------------------------------------------------------------------------------------
// The sheet: a saved job supplies the thickness, material, cutter, vise and sacrificial setup
// ---------------------------------------------------------------------------------------------

let base: EngraveJob = defaultEngraveJob();
if (args.base) {
  const parsed = parseEngraveJob(readJson(isAbsolute(args.base) ? args.base : join(process.cwd(), args.base)));
  if (!parsed.ok) fail(`${args.base} is not a valid engrave job:\n  ${parsed.errors.join('\n  ')}`);
  base = parsed.job;
}

const job = cameraFiducialJob(spec, base);

const outDir = args.out ?? defaultOut;
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------------------------
// Write the art and the job document, and say what cuts it
// ---------------------------------------------------------------------------------------------

const centres = cameraTargetFiducials(spec);
const extent = cameraTargetCheckerExtent(spec);
const squares = cameraTargetCheckerSquares(spec);

console.log(`${spec.title}  (${spec.id})`);
console.log(
  `  sheet      ${spec.sheet.width} x ${spec.sheet.depth} mm, ` +
    `${job.stock.thickness} mm thick ${job.stock.material}, cutter "${job.toolKey}"`,
);
console.log(
  `  fiducials  ${spec.fiducials.count.x}x${spec.fiducials.count.y} @ ${spec.fiducials.pitch.x}/${spec.fiducials.pitch.y} mm, ` +
    `first at (${spec.fiducials.origin.x.toFixed(1)}, ${spec.fiducials.origin.y.toFixed(1)}) mm, ` +
    `arm ${spec.fiducials.arm} / stroke ${spec.fiducials.stroke} mm, ${spec.fiducials.depth} mm deep`,
);
console.log(
  `             ${centres.length} crosses = ${cameraFiducialCutCount(spec)} pocket cuts ` +
    `(x from ${Math.min(...centres.map((c) => c[0])).toFixed(1)} to ${Math.max(...centres.map((c) => c[0])).toFixed(1)}, ` +
    `y from ${Math.min(...centres.map((c) => c[1])).toFixed(1)} to ${Math.max(...centres.map((c) => c[1])).toFixed(1)})`,
);
const zones = cameraTargetFiducialZones(spec);
const pocket = zones[0];
console.log(
  `  checker    ${spec.checker.square} mm squares over ${extent.width} x ${extent.depth} mm ` +
    `(${squares.length} dark squares), ${spec.checker.margin} mm clear of the edge`,
);
console.log(
  `  pockets    ${zones.length} cut zones` +
    (pocket ? ` of ${pocket.width} x ${pocket.depth} mm (at least ${spec.checker.clear} mm clear of each centre)` : ''),
);


const svgName = cameraTargetSvgFileName(spec);
const svg = cameraTargetSvg(spec);
writeFileSync(join(outDir, svgName), svg);
console.log(`  art        ${svgName}  (${svg.length} bytes)  — print at 100%, no fit-to-page`);

if (args.svgOnly) {
  console.log('\n  --svg-only: no mill job written.');
} else {
  const jobName = `${spec.id}.job.json`;
  writeFileSync(join(outDir, jobName), JSON.stringify(job, null, 2) + '\n');
  console.log(`  job        ${jobName}  (${job.shapes.length} shapes)`);
  console.log(
    '\n  cut the fiducials through the printed sheet with:\n' +
      `    npx tsx --tsconfig tsconfig.scripts.json scripts/engrave-job.ts ${join(outDir, jobName)}\n` +
      '  which writes the .nc, the dry-run frame and the run sheet beside the job document.',
  );
}
