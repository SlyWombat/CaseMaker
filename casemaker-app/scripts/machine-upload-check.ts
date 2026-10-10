// One-off live check: hand a VERIFIED program to the Z1 through the app's own bridge (#255).
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/machine-upload-check.ts <job.json> <host>
//
// Flags: --dry (generate and print, send nothing), --verbose (every byte, both directions),
//        --name <file.nc> (a bare filename; default the run sheet's own name),
//        --dir <path> (the card directory; default GCODE_DIR = /sd/gcodes).
//
// Why this exists rather than "just drive the desktop app": the GUI needs a Rust build and a person
// clicking, and the thing that is actually unproven is the PROTOCOL, not the button (the button has
// its own spec). This drives `machineBridge.ts` itself — the same `asVerifiedProgram` gate and the
// same `runUpload` — over `tools/z1/transport.node.mjs`, which implements the identical five-call
// `MachineTransport` seam the Tauri transport does. The upload code under test is the app's; only
// the socket underneath it differs. The Rust socket layer is NOT covered by this — that needs the
// desktop build, and is a separate half of the live run.
//
// SAFETY. Uploading writes a file to the controller's card; it does NOT run it. On the Z1 a file on
// the card is inert until Studio's five-step Machining Wizard is driven by hand at the machine
// (recorded 2026-10-07, docs/bench/2026-10-bench-day-1.md D0). This script sends a file and reports
// what the controller said. It has no motion path and cannot start a job.

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import ManifoldModule from 'manifold-3d';

import { asVerifiedProgram, uploadVerifiedProgram } from '../src/platform/desktop/machineBridge.ts';
import { GCODE_DIR, md5Hex } from '../src/platform/desktop/protocol.ts';
import { createNodeTransport } from '../tools/z1/transport.node.mjs';
import { engraveGenerate } from '../src/workers/sim/engraveGenerate';
import { runSheetFileName } from '../src/engine/cnc/engrave/runSheet';
import { jobTool } from '../src/engine/cnc/engrave/jobSetup';
import { parseEngraveJob } from '../src/store/engraveJobSchema';
import { BUNDLED_FONT_KEYS, registerBundledFontBytes } from '../src/engine/fonts/registry';

const [jobPath, host] = process.argv.slice(2);
if (!jobPath || !host) {
  console.error('usage: machine-upload-check.ts <job.json> <host>');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();

// Text labels need parsed fonts, and the app loads them by `fetch`ing a static asset, which node's
// fetch cannot do for a `file:` URL. Same seeding `scripts/engrave-job.ts` and `tests/setup/fonts.ts`
// use, so a job with text engraves here too.
for (const key of BUNDLED_FONT_KEYS) {
  const bytes = readFileSync(new URL(`../src/engine/fonts/files/${key}.ttf`, import.meta.url));
  registerBundledFontBytes(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

const parsed = parseEngraveJob(JSON.parse(readFileSync(jobPath, 'utf8')));
if (!parsed.ok) {
  console.error(`${jobPath} is not a valid job document:`);
  for (const e of parsed.errors) console.error(`   ${e}`);
  process.exit(2);
}
const job = parsed.job;
// No Makera feed rows in a headless run (#324): the catalogue tier needs a house service.
const generated = engraveGenerate(tl, job, jobTool(job), []);

console.log(`job      : ${job.name}`);
console.log(`stage    : ${generated.stage}   ok: ${generated.ok}`);
console.log(`verify   : ok=${generated.verify?.ok}   findings=${generated.verify?.findings.length ?? 0}`);
for (const f of generated.verify?.findings ?? []) {
  console.log(`   ${f.severity.padEnd(7)} ${f.code}: ${f.message}`);
}

if (generated.nc === null || generated.verify == null) {
  console.error('\nno program or no report — the gate has nothing to judge, nothing is sent.');
  process.exit(1);
}

// The app's own name for this job, and the DIRECTORY are separate here on purpose. The first live
// run (2026-10-07) sent a bare name and the machine resolved it against the card root, answering
// `Error: failed to open file [/165-depth-ladder.nc]!` — so the name is really a path, and the
// BRIDGE is what builds it (`uploadVerifiedProgram`'s `directory`, defaulting to `GCODE_DIR`).
// Passing the two halves separately is what exercises that join; `--name` is a bare filename.
const nameFlag = process.argv.indexOf('--name');
const filename = nameFlag === -1 ? runSheetFileName(job.name) : process.argv[nameFlag + 1]!;
const dirFlag = process.argv.indexOf('--dir');
const directory = dirFlag === -1 ? undefined : process.argv[dirFlag + 1]!;
const program = asVerifiedProgram(filename, new TextEncoder().encode(generated.nc), generated.verify);
if (program === null) {
  console.error('\nthe gate refused this program — nothing is sent.');
  process.exit(1);
}

// The MD5 the machine will compare against its own copy, and the bytes themselves on disk so the
// card can be checked independently of anything this script claims (`tools/z1/z1.mjs md5 <path>`).
// The copy goes to the system temp dir, not the repo: it exists to be hashed, not to be kept, and
// a byte-identical duplicate of a committed program is not something to leave lying in the tree.
const md5 = md5Hex(program.content);
const localPath = join(tmpdir(), filename.split('/').pop() ?? 'program.nc');
writeFileSync(localPath, program.content);
console.log(`local    : ${localPath}`);
console.log(`md5      : ${md5}`);

if (process.argv.includes('--dry')) {
  console.log('\n--dry: nothing sent.');
  process.exit(0);
}

// --verbose wraps the socket and prints every byte in both directions. The frame type the machine
// cancels with, and any text it attaches, is the whole question — a cancel is documented as meaning
// BOTH "already present" and "refused", so the payload is the only thing that could tell them apart.
const verbose = process.argv.includes('--verbose');
const base = createNodeTransport();
const hex = (b: Uint8Array) =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join(' ');
const printable = (b: Uint8Array) =>
  Array.from(b)
    .map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.'))
    .join('');
const transport = verbose
  ? {
      ...base,
      async tcpWrite(conn: number, data: Uint8Array) {
        console.log(`  -> ${data.length}B  ${hex(data)}`);
        console.log(`     "${printable(data)}"`);
        return base.tcpWrite(conn, data);
      },
      async tcpRead(conn: number, max: number, timeoutMs: number) {
        const data = await base.tcpRead(conn, max, timeoutMs);
        console.log(`  <- ${data.length}B  ${hex(data)}`);
        console.log(`     "${printable(data)}"`);
        return data;
      },
    }
  : base;

const destination = `${(directory ?? GCODE_DIR).replace(/\/+$/, '')}/${filename}`;
console.log(`\nuploading ${destination}  (${program.content.length} bytes)  ->  ${host}:2222`);
const outcome = await uploadVerifiedProgram({ host }, program, { transport, directory });
console.log('outcome  :', JSON.stringify(outcome));
process.exit(outcome.ok ? 0 : 1);
