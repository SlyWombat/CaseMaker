/**
 * #825 — AN OBJ MESH, read beside `stlParser.ts` for the two doors STL already has (the GOAL and
 * the STOCK). Makera Studio imports OBJ through `assimp-vc143-mt.dll` (RE 06); the scorecard's
 * row 64 found this app had no reader at all.
 *
 * What an OBJ is: text, one record per line. `v` is a vertex, `f` a face whose tokens are
 * `i`, `i/j`, `i//k` or `i/j/k` (vertex, texture, normal — the last two are ignored: a
 * `ParsedMesh` is triangles and nothing else), indices are 1-based, and a NEGATIVE index counts
 * back from the vertices defined above it (the common way to write a face right after its
 * vertices). A face may name any number of vertices, so a quad or an n-gon is triangulated by a
 * FAN from its first vertex — the same result assimp's polygon reader gives, and the only
 * triangulation a file of vertices plus one polygon can state.
 *
 * UNITS ARE STATED, NEVER ASSUMED SILENTLY. An OBJ has no unit in its format, and its numbers are
 * whatever the exporting program meant. The one place a file can say is a comment, so a comment of
 * the form `# units: mm` (or `# unit = cm`, one of mm, cm, m, in, ft, um and their spelled-out
 * names) is READ and the numbers are scaled to millimetres; every other file is read as
 * millimetres — the same reading the STL door gives — and {@link objUnitSentence} says so, so the
 * person who picked the file is told which reading they got.
 *
 * A MALFORMED FILE IS ONE SENTENCE, NOT A CRASH. Every refusal names the line, the keyword and
 * the token that could not be read; the doors wrap it as "`<name>` could not be parsed: <why>".
 * Unknown records (`vt`, `vn`, `o`, `g`, `s`, `usemtl`, `mtllib`, `l`, `p`, …) are SKIPPED rather
 * than refused: a file may carry material libraries, groups and lines this app does not need, and
 * neither Studio nor this reader refuses them.
 */

import type { ParsedMesh } from './stlParser';

/** The unit a file stated (or null), and the factor its numbers are multiplied by to give mm. */
export interface ObjUnit {
  /** The token the file's comment stated, lowercased — `mm`, `cm`, `m`, `in`, `ft`, `um` — or null. */
  stated: string | null;
  /** Millimetres per file unit. Exactly 1 when the file states none (its numbers are read as mm). */
  mmPerUnit: number;
}

export interface ObjMesh extends ParsedMesh {
  unit: ObjUnit;
}

/** The units an OBJ comment may state, as the token the file prints, and their millimetres. */
const UNIT_MM: Readonly<Record<string, number>> = {
  mm: 1,
  millimetre: 1,
  millimetres: 1,
  millimeter: 1,
  millimeters: 1,
  cm: 10,
  centimetre: 10,
  centimetres: 10,
  centimeter: 10,
  centimeters: 10,
  m: 1000,
  metre: 1000,
  metres: 1000,
  meter: 1000,
  meters: 1000,
  um: 0.001,
  'µm': 0.001,
  micrometre: 0.001,
  micrometres: 0.001,
  micrometer: 0.001,
  micrometers: 0.001,
  in: 25.4,
  inch: 25.4,
  inches: 25.4,
  ft: 304.8,
  foot: 304.8,
  feet: 304.8,
};

/** The words {@link objUnitSentence} prints for a stated token. */
const UNIT_WORD: Readonly<Record<string, string>> = {
  mm: 'millimetres',
  cm: 'centimetres',
  m: 'metres',
  um: 'micrometres',
  'µm': 'micrometres',
  in: 'inches',
  ft: 'feet',
};

/** `# units: cm`, `#unit=mm`, `# Units: inches` — the one way a comment states a unit. */
const UNIT_COMMENT = /^\s*#\s*units?\s*[:=]\s*([a-zµ"']+)\s*$/i;

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;

/** A comment's stated unit as a factor, or null when it states none this reader knows. */
function unitFromComment(line: string): { stated: string; mmPerUnit: number } | null {
  const m = UNIT_COMMENT.exec(line);
  if (m === null) return null;
  const token = m[1]!.toLowerCase();
  const mmPerUnit = UNIT_MM[token];
  if (mmPerUnit === undefined) return null;
  return { stated: token, mmPerUnit };
}

/** A token that must be a number, or the refusal that names it and its line. */
function numberAt(token: string, line: number, keyword: string): number {
  if (!NUMBER.test(token)) throw new Error(`OBJ line ${line}: "${keyword}" has "${token}", which is not a number`);
  const value = Number(token);
  if (!Number.isFinite(value)) throw new Error(`OBJ line ${line}: "${keyword}" has "${token}", which is not a number`);
  return value;
}

/**
 * Resolve one face token's VERTEX index to 0-based, against the vertices defined so far.
 * `i` and `-i` are the two OBJ forms; `i/j`, `i//k` and `i/j/k` keep only the vertex part.
 */
function vertexIndex(token: string, count: number, line: number): number {
  const parts = token.split('/');
  if (parts.length > 3) {
    throw new Error(`OBJ line ${line}: face token "${token}" is not a vertex index (i, i/j, i//k or i/j/k)`);
  }
  const head = parts[0]!;
  if (!INTEGER.test(head) || head === '+0' || head === '-0' || head === '0') {
    throw new Error(`OBJ line ${line}: face token "${token}" is not a vertex index (i, i/j, i//k or i/j/k)`);
  }
  const raw = Number(head);
  const index = raw > 0 ? raw - 1 : count + raw;
  if (index < 0 || index >= count) {
    throw new Error(`OBJ line ${line}: face index ${raw} is outside the ${count} vertices defined above it`);
  }
  return index;
}

/** The mesh's triangles from one face line's vertex indices — a fan from the first vertex. */
function fanInto(indices: number[], triangle: (a: number, b: number, c: number) => void, line: number): void {
  // A repeated neighbour (`f 1 2 2 3`) leaves a zero-area triangle; it is dropped rather than
  // refused — the face still states a real polygon, and a zero-area triangle is no geometry.
  const clean: number[] = [];
  for (const index of indices) {
    if (clean.length === 0 || clean[clean.length - 1] !== index) clean.push(index);
  }
  if (clean.length >= 2 && clean[0] === clean[clean.length - 1]) clean.pop();
  if (clean.length < 3) {
    throw new Error(`OBJ line ${line}: "f" needs at least three distinct vertices`);
  }
  for (let i = 1; i + 1 < clean.length; i++) triangle(clean[0]!, clean[i]!, clean[i + 1]!);
}

/**
 * Parse an OBJ file's bytes (or its text). The result is millimetres: the file's numbers times the
 * unit it stated, or times 1 when it stated none (see {@link objUnitSentence}).
 */
export function parseObj(source: ArrayBuffer | Uint8Array | string): ObjMesh {
  const text = typeof source === 'string' ? source : new TextDecoder('utf-8', { fatal: false }).decode(source);

  // A line may be continued with a trailing backslash (the OBJ grammar's own rule); joining first
  // keeps the line numbers the file's author sees.
  const rawLines = text.split('\n');
  const lines: string[] = [];
  let pending = '';
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!.replace(/\r$/, '');
    if (line.endsWith('\\')) {
      pending += line.slice(0, -1) + ' ';
      continue;
    }
    lines.push(pending + line);
    pending = '';
  }
  if (pending !== '') lines.push(pending);

  // THE UNIT FIRST: a comment may sit anywhere (usually the top), and the vertices are scaled at
  // the end, so a file that states its unit on line 1 and its vertices on line 2 is one reading.
  let unit: ObjUnit = { stated: null, mmPerUnit: 1 };
  for (const line of lines) {
    const stated = unitFromComment(line);
    if (stated !== null) {
      unit = stated;
      break;
    }
  }

  const xyz: number[] = [];
  const indices: number[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const vertexCount = (): number => xyz.length / 3;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const tokens = trimmed.split(/\s+/);
    const keyword = tokens[0]!;
    if (keyword === 'v') {
      if (tokens.length < 4) {
        throw new Error(`OBJ line ${lineNo}: "v" needs an x, a y and a z`);
      }
      // A fourth number is the optional weight `w`; this reader takes the position only.
      xyz.push(
        numberAt(tokens[1]!, lineNo, 'v'),
        numberAt(tokens[2]!, lineNo, 'v'),
        numberAt(tokens[3]!, lineNo, 'v'),
      );
      continue;
    }
    if (keyword === 'f') {
      if (tokens.length < 4) {
        throw new Error(`OBJ line ${lineNo}: "f" needs at least three vertices`);
      }
      const face = tokens.slice(1).map((token) => vertexIndex(token, vertexCount(), lineNo));
      fanInto(
        face,
        (a, b, c) => {
          indices.push(a, b, c);
          for (const index of [a, b, c]) {
            const x = xyz[index * 3]!;
            const y = xyz[index * 3 + 1]!;
            const z = xyz[index * 3 + 2]!;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
          }
        },
        lineNo,
      );
      continue;
    }
    // `vt`, `vn`, `vp`, `o`, `g`, `s`, `l`, `p`, `usemtl`, `mtllib`, `cstype`, … — records this
    // app's triangle mesh has no use for, and neither Studio nor this reader refuses a file for
    // carrying them. A malformed one is skipped on the same rule: it can change no triangle.
  }

  if (vertexCount() === 0) {
    throw new Error('OBJ: the file holds no vertices (no "v" record)');
  }

  // Scale the whole mesh ONCE, after the unit is known. A file with no triangles keeps its
  // vertices scaled so the doors can say "holds no triangles" about a mesh in mm.
  if (unit.mmPerUnit !== 1) {
    for (let i = 0; i < xyz.length; i++) xyz[i] = xyz[i]! * unit.mmPerUnit;
    if (indices.length > 0) {
      minX *= unit.mmPerUnit;
      minY *= unit.mmPerUnit;
      minZ *= unit.mmPerUnit;
      maxX *= unit.mmPerUnit;
      maxY *= unit.mmPerUnit;
      maxZ *= unit.mmPerUnit;
    }
  }

  const triangleCount = indices.length / 3;
  const bbox =
    triangleCount === 0
      ? { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] }
      : {
          min: [minX, minY, minZ] as [number, number, number],
          max: [maxX, maxY, maxZ] as [number, number, number],
        };

  return {
    positions: Float32Array.from(xyz),
    indices: Uint32Array.from(indices),
    triangleCount,
    bbox,
    unit,
  };
}

/**
 * What the file's numbers were read as, in ONE sentence for the person who picked it. Exported
 * beside the parser so the goal door and the stock door cannot word the same fact twice.
 */
export function objUnitSentence(name: string, unit: ObjUnit): string {
  if (unit.stated === null) {
    return `${name} states no unit; an OBJ has none of its own, so its numbers are read as millimetres.`;
  }
  const word = UNIT_WORD[unit.stated] ?? unit.stated;
  return `${name} states its unit as “${unit.stated}”; its numbers are read as ${word} (${unit.mmPerUnit} mm per unit).`;
}
