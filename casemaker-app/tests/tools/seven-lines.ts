#!/usr/bin/env tsx
/**
 * #964 — THE SEVEN-LINE SCORER'S COMMAND LINE.
 *
 * The demo page's build calls this; the vitest specs import `scoreSevenLines` directly. Both run
 * the SAME function (`sevenLines.ts`); this file is only I/O and argument parsing, so the page and
 * the specs cannot print different rules.
 *
 * Usage (from `casemaker-app/`):
 *
 *   npx tsx --tsconfig tsconfig.scripts.json tests/tools/seven-lines.ts score \
 *       --input <card-measurement.json> [--out <scored.json>]
 *
 *   npx tsx --tsconfig tsconfig.scripts.json tests/tools/seven-lines.ts measure \
 *       --run <card-run-dir> --name <card> --holding <text> --pitch <mm> [--owned true|false] \
 *       [--out <score.json>]
 *
 *   npx tsx --tsconfig tsconfig.scripts.json tests/tools/seven-lines.ts measure-vendor \
 *       --name <card> --goalcheck <goalcheck.json> --nc <file.nc> [--nc <file.nc> …] \
 *       [--holding <text>] [--pitch <mm>] [--out <score.json>]
 *
 *   npx tsx --tsconfig tsconfig.scripts.json tests/tools/seven-lines.ts card \
 *       --run <card-run-dir> --name <card> --holding <text> --pitch <mm> [--owned true|false] \
 *       [--vendor-goalcheck <goalcheck.json> --vendor-nc <file.nc> …] [--out <scored.json>]
 *
 * `card` is the one-command form the page uses: measure our side from the run directory, measure
 * the vendor side when its local files are given, and score. Without a vendor side the card comes
 * back `referenced: false` — "unreferenced", never a pass.
 *
 * Exit status is 0 for a scored card whatever the verdict (the page prints deviates); pass
 * `--fail-on-deviates` to make a failing card exit 1 (the specs do not use this — they assert
 * `scoreSevenLines` directly).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  measurePageCard,
  measureVendorCard,
} from './cardMeasurement';
import { scoreSevenLines, type SevenLineCard, type ScoreInput } from './sevenLines';

type Args = Record<string, string[]>;

function parseArgs(argv: readonly string[]): { command: string; args: Args } {
  const [command = '', ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) {
      args[key] = [...(args[key] ?? []), 'true'];
      continue;
    }
    args[key] = [...(args[key] ?? []), value];
    i++;
  }
  return { command, args };
}

const one = (args: Args, key: string): string | undefined => args[key]?.[0];
const many = (args: Args, key: string): string[] => args[key] ?? [];
const flag = (args: Args, key: string): boolean => one(args, key) === 'true' || one(args, key) === '1';

const bool = (value: string | undefined): boolean | null => {
  if (value === undefined) return null;
  return value === 'true' || value === '1' || value === 'yes';
};

function emit(card: SevenLineCard, args: Args): void {
  const text = `${JSON.stringify(card, null, 2)}\n`;
  const out = one(args, 'out');
  if (out !== undefined) writeFileSync(out, text);
  else process.stdout.write(text);
}

function scoreFromInput(path: string): SevenLineCard {
  const input = JSON.parse(readFileSync(path, 'utf8')) as ScoreInput;
  return scoreSevenLines(input);
}

function main(argv: readonly string[]): number {
  const { command, args } = parseArgs(argv);
  const failOnDeviates = flag(args, 'fail-on-deviates');

  if (command === 'score') {
    const inputPath = one(args, 'input');
    if (inputPath === undefined) throw new Error('score needs --input <card-measurement.json>');
    const card = scoreFromInput(resolve(inputPath));
    emit(card, args);
    return failOnDeviates && !card.pass ? 1 : 0;
  }

  if (command === 'measure') {
    const run = one(args, 'run');
    const name = one(args, 'name');
    if (run === undefined || name === undefined) throw new Error('measure needs --run <dir> and --name <card>');
    const score = measurePageCard(resolve(run), {
      card: name,
      holding: one(args, 'holding') ?? 'not stated',
      pitchMm: Number(one(args, 'pitch') ?? '0'),
      cuttersOwned: bool(one(args, 'owned')),
    });
    const text = `${JSON.stringify(score, null, 2)}\n`;
    const out = one(args, 'out');
    if (out !== undefined) writeFileSync(out, text);
    else process.stdout.write(text);
    return 0;
  }

  if (command === 'measure-vendor') {
    const name = one(args, 'name');
    const goalcheck = one(args, 'goalcheck');
    const ncFiles = many(args, 'nc');
    if (name === undefined || goalcheck === undefined || ncFiles.length === 0) {
      throw new Error('measure-vendor needs --name <card> --goalcheck <file> and at least one --nc <file>');
    }
    const score = measureVendorCard({
      card: name,
      goalcheckPath: resolve(goalcheck),
      ncFiles: ncFiles.map((p) => resolve(p)),
      holding: one(args, 'holding'),
      pitchMm: one(args, 'pitch') === undefined ? undefined : Number(one(args, 'pitch')),
    });
    const text = `${JSON.stringify(score, null, 2)}\n`;
    const out = one(args, 'out');
    if (out !== undefined) writeFileSync(out, text);
    else process.stdout.write(text);
    return 0;
  }

  if (command === 'card') {
    const run = one(args, 'run');
    const name = one(args, 'name');
    if (run === undefined || name === undefined) throw new Error('card needs --run <dir> and --name <card>');
    const ours = measurePageCard(resolve(run), {
      card: name,
      holding: one(args, 'holding') ?? 'not stated',
      pitchMm: Number(one(args, 'pitch') ?? '0'),
      cuttersOwned: bool(one(args, 'owned')),
    });
    const vendorGoalcheck = one(args, 'vendor-goalcheck');
    const vendorNc = many(args, 'vendor-nc');
    const vendor =
      vendorGoalcheck === undefined || vendorNc.length === 0
        ? null
        : measureVendorCard({
            card: name,
            goalcheckPath: resolve(vendorGoalcheck),
            ncFiles: vendorNc.map((p) => resolve(p)),
            holding: one(args, 'holding'),
            pitchMm: one(args, 'pitch') === undefined ? undefined : Number(one(args, 'pitch')),
          });
    const card = scoreSevenLines({ card: name, ours, vendor });
    emit(card, args);
    return failOnDeviates && !card.pass ? 1 : 0;
  }

  process.stderr.write(
    'usage: seven-lines.ts score --input <json> | measure --run <dir> --name <card> | measure-vendor --name <card> --goalcheck <json> --nc <file> | card --run <dir> --name <card>\n',
  );
  return 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
