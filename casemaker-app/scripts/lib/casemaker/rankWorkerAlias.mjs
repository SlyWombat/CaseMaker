// #1151 Phase 2 — the rank pool's WORKER-THREAD resolver (module customization hooks). Copied from
// #1137's pick-pool resolver (that branch is not this one's base; the same three fixes are needed
// here, and the two can consolidate when both land).
//
// Three things a worker thread lacks that the CLI's tsx loader supplies in the parent:
//   1. the app's `@/…` alias (tsconfig.scripts.json's `paths`, read by tsx from its CLI flag);
//   2. extensionless RELATIVE imports (`./meshOutput`), which tsx resolves to `meshOutput.ts`;
//   3. the JSON import attribute: `engraveGenerate.ts` imports `../../../package.json` bare, which
//      tsx and the bundler accept and Node refuses without `with { type: 'json' }`.
// Node 24 compiles the TypeScript itself (native type stripping), so this hook supplies just the
// resolution steps — no compiler. `pickWorkerBoot.mjs` registers it before any TypeScript loads.
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * JSON as a MODULE with named exports, which the bundler and tsx both allow and Node does not
 * (`engraveGenerate.ts` reads `version` from package.json by name). The data is the file's own.
 */
export async function load(url, context, nextLoad) {
  if (url.endsWith('.json')) {
    const value = JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
    // `private` is a package.json KEY and a strict-mode reserved word: a name that cannot be a
    // binding is exported on the default object only.
    const names = Object.keys(value).filter(
      (key) => /^[A-Za-z_$][\w$]*$/.test(key) && !RESERVED.has(key),
    );
    const source =
      `const data = ${JSON.stringify(value)};\n` +
      'export default data;\n' +
      names.map((name) => `export const ${name} = data[${JSON.stringify(name)}];`).join('\n');
    return { format: 'module', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}

/** Names that cannot be exported as bindings in a strict-mode ES module. */
const RESERVED = new Set([
  'private', 'public', 'protected', 'interface', 'package', 'implements', 'static',
  'enum', 'await', 'yield', 'let', 'const', 'var', 'function', 'class', 'new', 'delete',
  'in', 'instanceof', 'typeof', 'void', 'this', 'super', 'null', 'true', 'false',
  'if', 'else', 'return', 'switch', 'case', 'default', 'for', 'while', 'do', 'break',
  'continue', 'throw', 'try', 'catch', 'finally', 'with', 'debugger', 'export', 'import',
  'extends', 'catch', 'arguments', 'eval',
]);

/** Where the alias points: this file is casemaker-app/scripts/lib/casemaker/. */
const SRC = new URL('../../../src/', import.meta.url);

const CANDIDATES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** A specifier whose last segment already names a file extension is left to Node. */
function hasExtension(specifier) {
  const last = specifier.split('/').pop() ?? '';
  return last.includes('.');
}

function existingFile(base) {
  for (const suffix of CANDIDATES) {
    const url = new URL(base.href + suffix);
    try {
      // A bare directory is not a module: the `/index.ts` candidates cover packages.
      if (statSync(fileURLToPath(url)).isFile()) return url.href;
    } catch {
      /* not this candidate */
    }
  }
  return null;
}

/** A resolved module; JSON carries the attribute Node (and only Node) insists on. */
function resolved(url) {
  return url.endsWith('.json')
    ? { url, shortCircuit: true, importAttributes: { type: 'json' } }
    : { url, shortCircuit: true };
}

/** Resolve `base` to a file URL, or null. A stated `.json` extension is tried as-is. */
function existing(base) {
  if (base.pathname.endsWith('.json')) {
    try {
      if (statSync(fileURLToPath(base)).isFile()) return base.href;
    } catch {
      /* fall through */
    }
  }
  return existingFile(base);
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const url = existing(new URL(specifier.slice(2), SRC));
    if (url !== null) return resolved(url);
    return nextResolve(specifier, context);
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const isJson = specifier.endsWith('.json');
    if (isJson || !hasExtension(specifier)) {
      const url = existing(new URL(specifier, context.parentURL));
      if (url !== null) return resolved(url);
    }
  }
  return nextResolve(specifier, context);
}
