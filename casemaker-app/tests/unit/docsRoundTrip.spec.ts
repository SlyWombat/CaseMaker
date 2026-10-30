// #484 — the receipts the CLI chapter shows are generated, not written by hand, and this is the
// test that keeps them that way: the same commands that wrote `docs/bench/*.receipt.json` must still
// write them, byte for byte, from the committed job and the committed sample project.
//
// Three things make the comparison portable, and each is a decision rather than a convenience:
//
// - PATHS ARE TOKENS. A temp directory differs every run and the checkout's absolute path differs
//   per machine, so the only fields allowed to vary are normalised to `<job>`, `<location>`,
//   `<project>` and `<out>` before the receipt is formatted.
// - THE CLOCK IS PINNED. The run sheet carries its generation date and the receipt carries the
//   sheet's sha256, so without `CommandOptions.now` the fixture would change at midnight. The sheet
//   prints the date as `toISOString().slice(0, 10)` — UTC — so the pinned instant gives the same
//   sheet in every timezone.
// - `--location` IS PINNED. The bootstrap otherwise reads the machine's own document, which would
//   make the receipt depend on the developer's saved setup. The fixture document is committed for
//   the same reason `casemakerCommands.spec.ts` reads it.
//
// The commands are called in process rather than spawned: the clock seam is programmatic and has no
// flag, and the receipt a sink receives is `parseReceipt`'s result — the very value `--json` would
// format — so the bytes compared here are the bytes `receiptJson` prints.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import { exportMain } from '../../scripts/lib/casemaker/exportCommand';
import { HUMAN, type CommandOptions } from '../../scripts/lib/casemaker/output';
import { parseReceipt, receiptJson, type Receipt } from '../../src/platform/headless/receipt';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const REPO = join(APP, '..');

/** The instant the committed fixtures were written at; see "THE CLOCK IS PINNED" above. */
const NOW = new Date('2026-10-18T12:00:00.000Z');

const JOB = join(REPO, 'docs', 'bench', 'single-barrel.job.json');
const PROJECT = join(REPO, 'docs', 'bench', 'bench-sample.caseproj.json');
const LOCATION = join(APP, 'tests', 'unit', 'fixtures', 'location-doc.json');

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-docs-round-trip-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** A path as the command will read it — relative to the cwd the spec runs in. */
const asArg = (path: string): string => relative(process.cwd(), path);

function replacePaths<T>(value: T, map: Record<string, string>): T {
  if (typeof value === 'string') {
    let out = value.replaceAll('\\', '/');
    for (const [from, to] of Object.entries(map)) out = out.replaceAll(from.replaceAll('\\', '/'), to);
    return out as T;
  }
  if (Array.isArray(value)) return value.map((v) => replacePaths(v, map)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, replacePaths(v, map)]),
    ) as T;
  }
  return value;
}

async function capture(run: (options: CommandOptions) => Promise<number>): Promise<Receipt> {
  let receipt: Receipt | null = null;
  const options: CommandOptions = {
    ...HUMAN,
    now: NOW,
    sink: {
      receipt: (r) => {
        receipt = r;
      },
    },
  };
  const code = await run(options);
  expect(code, 'the command must succeed').toBe(0);
  expect(receipt, 'the command must emit a receipt').not.toBeNull();
  return receipt!;
}

/** The receipt is only worth committing if it describes the bytes that really landed on disk. */
function expectOutputsMatchDisk(receipt: Receipt, outDir: string): void {
  expect(receipt.outputs.length).toBeGreaterThan(0);
  for (const output of receipt.outputs) {
    const name = output.path.split(/[\\/]/).pop()!;
    const bytes = readFileSync(join(outDir, name));
    expect(bytes.length, `${name} byte count`).toBe(output.bytes);
    expect(createHash('sha256').update(bytes).digest('hex'), `${name} sha256`).toBe(output.sha256);
  }
}

/**
 * A committed fixture must already be in the one canonical form `receiptJson` produces.
 *
 * #610 — CRLF IS A CHECKOUT ARTEFACT, NOT CONTENT. Git stores these JSONs with LF, but a Windows
 * clone (`core.autocrlf=true`) writes the working copy back as CRLF, and the byte comparison below
 * then fails on Windows while Linux passes. `.gitattributes` pins the receipts to `eol=lf`; this
 * normalisation also keeps the check honest for a clone checked out before that rule existed.
 *
 * #641 — `.gitattributes` only governs a NEW checkout: an existing CRLF working copy keeps its
 * bytes until the files are re-checked out, so a byte failure here can be a stale checkout rather
 * than changed content. The message says so.
 */
function readFixture(name: string): string {
  const text = readFileSync(join(REPO, 'docs', 'bench', name), 'utf8').replace(/\r\n/g, '\n');
  expect(
    receiptJson(parseReceipt(JSON.parse(text))),
    `${name} is canonical — if this clone predates the eol=lf rule, re-check out the fixtures`,
  ).toBe(text);
  return text;
}

/**
 * A fixture change is a deliberate act. `CM_EXPORT_RECEIPTS=1` rewrites the committed receipt from
 * this spec's own call (clock `NOW`, the same token map) — for the case the test below describes;
 * a normal run still byte-compares, and the canonicality check above still runs first.
 */
function expectReceiptFixture(name: string, fresh: string, committed: string): void {
  if (process.env.CM_EXPORT_RECEIPTS === '1') {
    writeFileSync(join(REPO, 'docs', 'bench', name), fresh);
    return;
  }
  expect(fresh, `${name} has drifted — regenerate it deliberately, or say why it moved`).toBe(committed);
}

describe('#484 the committed receipts round-trip', () => {
  it('casemaker engrave rewrites docs/bench/single-barrel.receipt.json', async () => {
    const committed = readFixture('single-barrel.receipt.json');
    const job = asArg(JOB);
    const location = asArg(LOCATION);
    const outDir = join(SCRATCH, 'engrave');
    mkdirSync(outDir, { recursive: true });

    const receipt = await capture((options) =>
      engraveJobMain([job, '--out', outDir, '--location', location], options),
    );
    expectOutputsMatchDisk(receipt, outDir);

    const fresh = receiptJson(
      parseReceipt(replacePaths(receipt, { [job]: '<job>', [location]: '<location>', [outDir]: '<out>' })),
    );
    // A diff here has to be explained (#484): either the run legitimately changed and the fixture
    // is regenerated from this spec's own call (clock `NOW`, the same token map), or something
    // moved that the receipt now reports and a reviewer has to see.
    expectReceiptFixture('single-barrel.receipt.json', fresh, committed);
  });

  it('casemaker export rewrites docs/bench/bench-sample.receipt.json', async () => {
    const committed = readFixture('bench-sample.receipt.json');
    const project = asArg(PROJECT);
    const location = asArg(LOCATION);
    const outDir = join(SCRATCH, 'export');
    mkdirSync(outDir, { recursive: true });

    const receipt = await capture((options) =>
      exportMain([project, '--out', outDir, '--location', location], options),
    );
    expectOutputsMatchDisk(receipt, outDir);

    const fresh = receiptJson(
      parseReceipt(replacePaths(receipt, { [project]: '<project>', [location]: '<location>', [outDir]: '<out>' })),
    );
    expectReceiptFixture('bench-sample.receipt.json', fresh, committed);
  });
});
