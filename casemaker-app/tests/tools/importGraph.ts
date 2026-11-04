/**
 * #964 — THE STATIC IMPORT GRAPH, for the gate's independence spec (A's R1, #956).
 *
 * The gate must be able to judge the CAM without using the CAM's own geometry. A DIRECT-import
 * rule cannot see the coupling that matters: `designCheck.ts` imports helpers from `oracle.ts`,
 * and `oracle.ts` imports the CAM's cone (`vProfile.ts`) and sweep (`partPlan.ts`) — so the gate
 * grades the CAM with the CAM's math while every direct import looks innocent. This module
 * follows imports TRANSITIVELY and treats type-only imports as erased (they are), so the spec can
 * assert what is actually reachable at run time.
 *
 * What it does NOT model, deliberately: dynamic specifiers that are not string literals, and
 * dependency injection through parameters. Those are not what R1 is about; the review named the
 * static graph.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

export interface ImportEdge {
  /** The importing file, repo-relative with forward slashes. */
  from: string;
  /** The repository-relative target, or null for a package/builtin/asset import. */
  to: string | null;
  /** The specifier exactly as written. */
  specifier: string;
  /** TRUE when the import is erased at compile time (`import type`, all type specifiers). */
  typeOnly: boolean;
  /** Source line (1-based), for the failure message. */
  line: number;
}

const posix = (p: string): string => p.split(sep).join('/');

/** Resolve an import specifier to a source file under `srcRoot`, or null for a package/builtin. */
export function resolveSpecifier(fromFile: string, specifier: string, srcRoot: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) {
    base = resolve(srcRoot, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    return null; // a package, a node builtin, or a Vite asset URL
  }
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    // An ESM-style `.js` specifier in a TS project names the TS source.
    base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : base,
    base.endsWith('.js') ? `${base.slice(0, -3)}.tsx` : base,
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // a broken path is simply not a source file
    }
  }
  return null;
}

const hasValueBinding = (clause: ts.ImportClause | undefined): boolean => {
  if (clause === undefined) return true; // `import 'x'` — a side-effect import
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true; // default import
  const bindings = clause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings)) return true; // `import * as ns`
  return bindings.elements.some((element) => !element.isTypeOnly);
};

/**
 * Every import/export-from/dynamic-import/require in one source file, with its type-only flag.
 * The targets are resolved against `srcRoot`; package and asset specifiers carry `to: null`.
 */
export function readImports(filePath: string, srcRoot: string): ImportEdge[] {
  const text = readFileSync(filePath, 'utf8');
  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const from = posix(relative(srcRoot, filePath));
  const edges: ImportEdge[] = [];
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const add = (node: ts.Node, specifier: string, typeOnly: boolean): void => {
    const resolved = resolveSpecifier(filePath, specifier, srcRoot);
    edges.push({
      from,
      to: resolved === null ? null : posix(relative(srcRoot, resolved)),
      specifier,
      typeOnly,
      line: lineOf(node),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node, node.moduleSpecifier.text, !hasValueBinding(node.importClause));
    } else if (ts.isExportDeclaration(node)) {
      // `export type * from './x'` is erased; a plain re-export carries values.
      if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        add(node, node.moduleSpecifier.text, node.isTypeOnly);
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      add(node, (node.arguments[0] as ts.StringLiteral).text, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

export interface ClosureEntry {
  /** Repository-relative file (forward slashes). */
  file: string;
  /** A sample chain from a root to this file, e.g. ['a.ts', 'b.ts', 'c.ts']. */
  chain: string[];
  /** The import edge that reached it; null for a root. */
  via: ImportEdge | null;
}

export interface ImportClosure {
  /** Every file reachable by VALUE imports from the roots, including the roots themselves. */
  files: Map<string, ClosureEntry>;
  /** The imports read along the way (value and type-only alike), for diagnostics. */
  edges: ImportEdge[];
  /** Roots that do not exist on disk. */
  missingRoots: string[];
  /** Allowlisted modules the walk reached and deliberately did not enter. */
  stoppedAt: Set<string>;
}

/**
 * The transitive closure of VALUE imports from `roots` (repository-relative to `srcRoot`).
 * Type-only imports are recorded as edges but not followed: they are erased, so they cannot make
 * the gate run the CAM's code.
 *
 * `stopAt` is the shared-modules allowlist: a module ON the list is trusted as a definition (the
 * placement of the goal, the simulator the gate reads the NC through, the Manifold toplevel) and
 * the walk does not enter it. Without that trust the allowlist would be meaningless — the
 * placement module itself imports the job model, which knows the CAM. The list is deliberately
 * small and is asserted by the spec, so widening it is a reviewed act.
 */
export function valueImportClosure(
  roots: readonly string[],
  srcRoot: string,
  stopAt: ReadonlySet<string> = new Set(),
): ImportClosure {
  const files = new Map<string, ClosureEntry>();
  const edges: ImportEdge[] = [];
  const missingRoots: string[] = [];
  const stoppedAt = new Set<string>();
  const queue: { file: string; chain: string[]; via: ImportEdge | null }[] = [];

  for (const root of roots) {
    const absolute = join(srcRoot, root);
    if (!existsSync(absolute)) {
      missingRoots.push(root);
      continue;
    }
    files.set(root, { file: root, chain: [root], via: null });
    queue.push({ file: root, chain: [root], via: null });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const absolute = join(srcRoot, current.file);
    let imports: ImportEdge[];
    try {
      imports = readImports(absolute, srcRoot);
    } catch {
      continue;
    }
    edges.push(...imports);
    for (const edge of imports) {
      if (edge.typeOnly || edge.to === null) continue;
      if (stopAt.has(edge.to)) {
        stoppedAt.add(edge.to);
        continue;
      }
      if (files.has(edge.to)) continue;
      const entry: ClosureEntry = {
        file: edge.to,
        chain: [...current.chain, edge.to],
        via: edge,
      };
      files.set(edge.to, entry);
      queue.push({ file: edge.to, chain: entry.chain, via: edge });
    }
  }
  return { files, edges, missingRoots, stoppedAt };
}
