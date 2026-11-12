/**
 * #1244 — NOTHING UNDER `src/engine/**` READS THE AMBIENT SHOP-SETTINGS SOURCE.
 *
 * After #1241 the four readers take the map as an argument, but engine modules still call
 * `liveShopDefaults()` themselves in place of a parameter. Engine code runs on the main thread, in
 * the app's worker and in the CLI's pools; an ambient read inside it is correct only where that
 * realm happened to install the source — the exact failure #1237 found in the planner and #1241 in
 * the rotary limits and the probe residuals.
 *
 * The rule (#1244): settings enter at a realm's EDGE — a worker's entry file, the CLI's bootstrap,
 * a store, a component — and travel inward as data. An engine function takes the map, or the
 * already-read values in a small record named for what they are. So this gate forbids, in every
 * file under `src/engine/**`, an import of any of these from `platform/defaultsClient`:
 *
 *   - `liveShopDefaults` (the ambient read);
 *   - `installShopDefaults` / `setLiveDefaultsSource` / `resetLiveShopDefaults` (installing or
 *     clearing the source is an edge's job, never engine code's);
 *   - a namespace or default import of the module (the same reach under another name).
 *
 * `readDefault`, `KNOWN_DEFAULTS`, the types and every other constant stay allowed: they read a
 * map the caller already holds.
 *
 * WRITTEN RED (#1244's step 1): it listed fifteen offenders on day one. Fourteen are converted;
 * the fifteenth (`src/engine/jobs/simClient.ts`) is a NAMED, REPORTED survivor — the main-thread
 * IPC client is an edge by nature (see REPORTED_SURVIVOR below) — so the gate is green with that
 * one pin and fails loudly on any other file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const ENGINE = join(APP, 'src', 'engine');
const DEFAULTS_MODULE = '@/platform/defaultsClient';

/** The names only an edge may touch. */
const FORBIDDEN = new Set([
  'liveShopDefaults',
  'installShopDefaults',
  'setLiveDefaultsSource',
  'resetLiveShopDefaults',
]);

/** Every `.ts`/`.tsx` under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** One line per forbidden import in `file`: `path:line imports <names>`. */
function offenders(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== DEFAULTS_MODULE
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause === undefined) continue; // a bare side-effect import carries no name
    const names: string[] = [];
    if (clause.name !== undefined) names.push(`(default ${clause.name.text})`);
    const bindings = clause.namedBindings;
    if (bindings !== undefined) {
      if (ts.isNamespaceImport(bindings)) names.push(`* as ${bindings.name.text}`);
      else {
        for (const element of bindings.elements) {
          // `import { type X }` is a type-only name and carries no value.
          if (element.isTypeOnly) continue;
          if (FORBIDDEN.has(element.name.text)) names.push(element.name.text);
        }
      }
    }
    if (names.length === 0) continue;
    const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
    found.push(`${relative(APP, file).split('\\').join('/')}:${line} imports ${names.join(', ')}`);
  }
  return found;
}

/**
 * #1244 hand-in — THE ONE NAMED SURVIVOR, REPORTED TO THE ANALYST.
 *
 * `simClient.ts` is the main-thread IPC client that hands data ACROSS to the sim worker: it is an
 * edge by nature (it reads the two `sim.*` timing keys to build the call), not engine logic that
 * should take a parameter. It is listed here by name — a single edge, never a subtree (#964's rule)
 * — and the moment it is converted or exempted by the ruling, this list changes and the gate must
 * be updated with it. Every other engine file must be empty of the ambient source.
 *
 * THE EXEMPTION ENDS IF simClient EVER MOVES TO A WORKER (the analyst's ruling, 2026-11-12): its
 * ambient read would then sit in a realm where a missing install silently falls back — the very
 * failure #1237 and #1241 found — so it must be converted before such a move.
 */
const REPORTED_SURVIVOR = 'src/engine/jobs/simClient.ts';

describe('#1244 the ambient shop-settings source is not read inside the engine', () => {
  it('no file under src/engine imports liveShopDefaults or the installer', () => {
    const list = sourceFiles(ENGINE).flatMap(offenders).sort();
    const files = [...new Set(list.map((line) => line.split(':')[0]!))];
    expect(files, `only the reported survivor may remain (see REPORTED_SURVIVOR):\n${list.join('\n')}`).toEqual([
      REPORTED_SURVIVOR,
    ]);
  });
});
