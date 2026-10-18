// #480 — the headless MCP documents' JSON Schemas are checked in beside the generator. Three
// things are held here:
//
//   1. freshness — the checked-in JSON is exactly what the Zod documents generate today, so a
//      schema change and its JSON land in one commit;
//   2. descriptiveness — every property a tool could be handed has text, because the description
//      is the only thing an LLM sees;
//   3. the board-library trap — the board schema STRIPS unknown keys, so a field present in a
//      committed profile but missing from the Zod schema is invisible until it is compared with
//      the generated schema. This spec is that comparison.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { unknownBoardKeys } from '@/library/schema';
import { displayProfileSchema } from '@/library/displaySchema';
import { hatProfileSchema } from '@/library/hatSchema';
import { generateMcpSchemas, MCP_SCHEMA_NAMES } from '@/platform/headless/mcpSchemas';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const SCHEMA_DIR = join(APP, 'src', 'platform', 'headless', 'schemas');

/** The generated documents, parsed once — they are also what the freshness test compares. */
const generated = generateMcpSchemas();
const parsed = Object.fromEntries(
  Object.entries(generated).map(([name, json]) => [name, JSON.parse(json) as JsonObject]),
) as Record<(typeof MCP_SCHEMA_NAMES)[number], JsonObject>;

interface JsonObject {
  [key: string]: unknown;
}

/**
 * Every property node in a JSON Schema document, as `path` strings, whether or not it carries a
 * description. Walks composition branches, array items, `additionalProperties` and `$defs` — a
 * field is no less authorable for being nested in an `anyOf`.
 */
function properties(node: unknown, path: string, out: { path: string; described: boolean }[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => properties(item, `${path}[${i}]`, out));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const obj = node as JsonObject;
  const props = obj.properties;
  if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
    for (const [key, child] of Object.entries(props as JsonObject)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      const description =
        child !== null && typeof child === 'object' ? (child as JsonObject).description : undefined;
      out.push({ path: childPath, described: typeof description === 'string' && description.length > 0 });
      properties(child, childPath, out);
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf', 'items', 'additionalProperties', '$defs'] as const) {
    if (obj[key] !== undefined) properties(obj[key], path, out);
  }
}

describe('#480 the headless MCP schemas', () => {
  it('has a checked-in document for every schema, and it is current', () => {
    for (const name of MCP_SCHEMA_NAMES) {
      let onDisk: string;
      try {
        onDisk = readFileSync(join(SCHEMA_DIR, `${name}.json`), 'utf8');
      } catch {
        throw new Error(
          `${name}.json is missing — run: npx tsx --tsconfig tsconfig.scripts.json scripts/gen-mcp-schemas.ts`,
        );
      }
      expect(onDisk, `${name}.json is stale — rerun scripts/gen-mcp-schemas.ts`).toBe(generated[name]);
    }
  });

  it('describes every property in every document', () => {
    const missing: string[] = [];
    for (const name of MCP_SCHEMA_NAMES) {
      const found: { path: string; described: boolean }[] = [];
      properties(parsed[name], '', found);
      for (const p of found) if (!p.described) missing.push(`${name}: ${p.path}`);
    }
    // Every field a tool accepts or returns needs text (#480's "done when").
    expect(missing).toEqual([]);
  });

  it('declares every key the committed board profiles carry', () => {
    const dir = join(APP, 'src', 'library', 'boards');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    const undeclared: string[] = [];
    for (const file of files) {
      const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      for (const key of unknownBoardKeys(raw)) undeclared.push(`boards/${file}: ${key}`);
    }
    expect(undeclared).toEqual([]);
  });

  it('declares every key the committed HAT and display profiles carry', () => {
    // The same strip trap the board library has, on the two profile types nested in a project.
    const checks = [
      { dir: join(APP, 'src', 'library', 'hats'), shape: hatProfileSchema.shape },
      { dir: join(APP, 'src', 'library', 'displays'), shape: displayProfileSchema.shape },
    ];
    const undeclared: string[] = [];
    for (const { dir, shape } of checks) {
      const known = new Set(Object.keys(shape));
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
        for (const key of Object.keys(raw)) {
          if (!known.has(key)) undeclared.push(`${file}: ${key}`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('emits the current document, not the versioned union', () => {
    // The union branches all carry `schemaVersion` literals; a single document must require
    // exactly the current one.
    expect((parsed.project.properties as JsonObject).schemaVersion).toMatchObject({ const: 16 });
    expect((parsed['engrave-job'].properties as JsonObject).schemaVersion).toMatchObject({ const: 3 });
  });
});
