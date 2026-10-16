import { unzipSync } from 'fflate';

/**
 * A PrusaSlicer project 3MF, read as a DESIGN rather than as a mesh (#410).
 *
 * `threeMfParser.ts` already reads a 3MF, but only as one anonymous triangle soup — enough to draw
 * a reference asset, and nothing more. A PrusaSlicer project carries the thing we actually want: a
 * named list of VOLUMES, each marked `ModelPart` or `NegativeVolume`, each a range of the model's
 * triangles, plus the text/SVG parameters that generated the negative ones. That split is what
 * turns "the maintainer's PrusaSlicer file" into "an engrave job".
 *
 * HOW THE FORMAT IS PUT TOGETHER, verified against PrusaSlicer's own output
 * (`samples/badge-blank/single.3mf`, 2026-10-15) rather than assumed:
 *
 *   1. `3D/3dmodel.model` holds ONE object whose single `<mesh>` concatenates every volume's
 *      triangles, in write order.
 *   2. `Metadata/Slic3r_PE_model.config` slices that mesh by `<volume firstid="0" lastid="575">` —
 *      TRIANGLE indices, inclusive, into the concatenated list — and names each volume through
 *      `<metadata type="volume" key="…" value="…">`.
 *   3. THE MESH IS ALREADY IN THE OBJECT FRAME, and the per-volume `matrix` is a PLACEMENT RECORD,
 *      not a transform left to apply. It is a 4×4 row-major, so the translation is elements 3, 7, 11
 *      and the bottom row is 0 0 0 1; on the
 *      volumes imported from another project it carries `source_file`/`source_offset_*` beside it
 *      (T2: z 1.5), and on the built-in text/shape volumes its translation is the anchor the tool
 *      placed the text/SVG origin at (the subtitle's x translation 12.203 is that volume's own raw
 *      centre x). Applying any of them double-transforms: T2 would sit at z 1.5…4.5 instead of
 *      0…3, T3 at 3.405…4.215, the text would float 2.8 mm above the blank, and the logo would be
 *      scaled to 47 % (`br`'s linear part is 0.4713, not identity). The raw vertex bounds are the
 *      ones that match the file's declared design — exactly 76.2 × 38.1 × 3.81 mm, i.e.
 *      3 × 1.5 × 0.15 in — and the magnet pocket's ceiling comes out at 2.3 mm, the depth the blank
 *      was made with. The raw coordinates are therefore the final ones.
 *   4. `slic3rpe:text` says how a text volume was generated (`text`, `font_descriptor`,
 *      `line_height`), `slic3rpe:shape` says the same for an SVG (`filepath3mf` into the zip).
 *      Neither is needed to cut the volume — its mesh is already there — but they are what lets a
 *      report name the face and the weight the design was made in.
 *   5. `<build><item transform="…">` — where the object sits on the bed — is CHECKED and not applied
 *      ({@link checkBuildTransform}): this file's is a pure translation, so the mesh is the part and
 *      everything measured here is relative to the part's own bounding box.
 *
 * Pure: bytes in, plain data out. No Manifold, no DOM, so it can be unit-tested on a fixture.
 */

/** One `<volume>` of the project's object, with the config metadata that describes it. */
export interface PrusaVolume {
  /** The volume's name — PrusaSlicer's own, kept as the item name (#410). */
  name: string;
  /** `ModelPart` for solid geometry, `NegativeVolume` for a modifier that cuts. */
  volumeType: string;
  /** The extruder the volume is assigned to, or `null` when the config names none. */
  extruder: number | null;
  /** Triangle index range into the merged mesh, INCLUSIVE at both ends. */
  firstId: number;
  lastId: number;
  /** The 16 numbers of the volume's `matrix`, row-major (translation at 3, 7, 11), or null. */
  matrix: readonly number[] | null;
  /** Where the volume sat in its source file, mm — the same fact `matrix`'s translation records. */
  sourceOffsetZ: number | null;
  /** The text parameters, when the volume came from PrusaSlicer's text tool. */
  text: PrusaTextVolume | null;
  /** The SVG parameters, when the volume came from an embedded shape. */
  shape: PrusaShapeVolume | null;
}

/** `slic3rpe:text` — how the text tool generated the volume. */
export interface PrusaTextVolume {
  text: string;
  /** The font family as the config names it, e.g. `Segoe UI Black`. */
  font: string;
  /** The font's weight from `font_descriptor` (700 for a Black face), or null when unreadable. */
  weight: number | null;
  /** The line height the tool laid the text out with, mm. */
  lineHeight: number;
}

/** `slic3rpe:shape` — how an SVG volume was placed. */
export interface PrusaShapeVolume {
  /** The path to the original on the author's machine (unusable here, kept for the report). */
  filepath: string | null;
  /** The path of the embedded copy inside this zip, e.g. `3D/br.svg`. */
  filepath3mf: string | null;
  /** The SVG units → mm scale factor. */
  scale: number | null;
  /** The extrusion depth in the shape's own units. */
  depth: number | null;
}

/** Everything the design reader needs out of one project file. */
export interface PrusaThreeMf {
  /** The object's name from the config, e.g. `badge-blank-3x1.5x0.15in`. */
  objectName: string;
  /** The model's unit as the 3MF declares it. Only `millimeter` is accepted. */
  unit: string;
  volumes: PrusaVolume[];
  /** The merged mesh: interleaved xyz and triangle vertex indices, in config facet order. */
  mesh: { vertProperties: Float32Array; triVerts: Uint32Array };
  /**
   * The project's PRINT SETTINGS (`Metadata/Slic3r_PE.config`), as plain `key → value`, or `{}` when
   * the project carries none. This is the saved profile — `layer_height`, `first_layer_height`,
   * `printer_model` — and it is what lets the job state how the blank was printed rather than assume
   * it (#285). Values are left exactly as the file wrote them: they carry units, `%` and quotes.
   */
  settings: Record<string, string>;
  /** The zip's entries, so an embedded `3D/br.svg` can be read without a second unzip. */
  entries: Record<string, Uint8Array>;
}

/** A malformed or unsupported project file. The message is shown to the user as written. */
export class PrusaThreeMfError extends Error {}

/** `key="value"` pairs of one XML tag's attribute text. */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  for (let m; (m = re.exec(tag)); ) out[m[1]!] = m[2]!;
  return out;
}

/** A finite number from an attribute, or null when it is absent or unparseable. */
function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** How far a build transform's linear part may differ from the identity and still be a translation.
 *  Dimensionless: 1e-4 is 0.01 % of the part, a tenth of the finest thing any job here cuts. */
const BUILD_LINEAR_TOLERANCE = 1e-4;

/**
 * The build's own placement of the object — checked, and deliberately NOT applied.
 *
 * `<build><item objectid="1" transform="…">` is the 3MF's real placement: a 4×3 matrix written
 * row-major, so its last three numbers are the translation. This file's is
 * `1 0 0 0 1 0 0 0 1 182.927 174.197 0` — a pure translation, where the blank sits on the bed — and
 * a translation moves the part without changing it, while every fact the design reader measures is
 * taken relative to the part's OWN bounding box (`design3mf.ts` anchors the job to that box, never
 * to the bed origin). Applying it would change no measured number and would put the geometry in a
 * frame nothing else here uses, so it is left where it is and the file's own frame is reported.
 *
 * A transform that is NOT a pure translation is another matter: a rotation or a scale means the
 * mesh in the file is not the part as it would be printed, and nothing here can undo it — the
 * volumes' ranges still address that mesh, and the SVG/text parameters were written for the
 * untransformed one. Refused, with the linear part quoted, rather than measured wrong.
 *
 * Several build items are refused for the same reason a second object is: the same geometry placed
 * more than once is not one part in one place, and there is no blank to measure.
 */
function checkBuildTransform(model: string): void {
  const build = /<build\b[^>]*>[\s\S]*?<\/build>/.exec(model)?.[0];
  if (build === undefined) return; // no build block: the resources are used as authored
  const items = [...build.matchAll(/<item\b[^>]*\/?>/g)].map((m) => m[0]);
  if (items.length > 1) {
    throw new PrusaThreeMfError(
      `The 3MF's build places ${items.length} items, so the same geometry would be printed more ` +
        'than once. A design to cut is one part in one place.',
    );
  }
  for (const item of items) {
    const transform = attrs(item).transform;
    if (transform === undefined) continue; // the core spec's default is the identity
    const m = transform.trim().split(/\s+/).map(Number);
    if (m.length !== 12 || m.some((v) => !Number.isFinite(v))) {
      throw new PrusaThreeMfError(
        `The 3MF's build transform is not twelve numbers ("${transform}"), so where the object sits ` +
          'cannot be read.',
      );
    }
    // The identity in row-major: 1 at 0, 4 and 8, 0 elsewhere in the first nine.
    for (let i = 0; i < 9; i++) {
      if (Math.abs(m[i]! - (i % 4 === 0 ? 1 : 0)) > BUILD_LINEAR_TOLERANCE) {
        throw new PrusaThreeMfError(
          `The 3MF's build transform is not a pure translation — its linear part reads ` +
            `${m.slice(0, 9).join(' ')} — so the mesh in the file is not the part as it would be ` +
            'printed, and the design cannot be measured from it. Re-save the project with the part ' +
            'placed without rotation or scaling.',
        );
      }
    }
  }
}

/**
 * Read a PrusaSlicer project 3MF.
 *
 * Refuses anything that is not a project with per-volume metadata: a plain 3MF export (no
 * `Slic3r_PE_model.config`) has no volume names and no `NegativeVolume` flags, so there is nothing
 * here to turn into a job — `parse3MF` is the reader for that case, and the caller should say so.
 */
export function parsePrusaThreeMf(buf: ArrayBuffer): PrusaThreeMf {
  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(new Uint8Array(buf));
  } catch {
    throw new PrusaThreeMfError('The file is not a readable 3MF (zip) archive.');
  }

  const modelEntry = zip['3D/3dmodel.model'] ?? zip['3d/3dmodel.model'];
  const configEntry = zip['Metadata/Slic3r_PE_model.config'];
  if (!modelEntry) throw new PrusaThreeMfError('The 3MF has no 3D/3dmodel.model.');
  if (!configEntry) {
    throw new PrusaThreeMfError(
      'This 3MF has no Slic3r_PE_model.config, so its volumes have no names and no ' +
        'NegativeVolume flags. Save it from PrusaSlicer as a project (.3mf) to import a design.',
    );
  }

  const model = new TextDecoder('utf-8').decode(modelEntry);
  const config = new TextDecoder('utf-8').decode(configEntry);

  const unit = attrs(/<model\b[^>]*>/.exec(model)?.[0] ?? '').unit ?? 'millimeter';
  if (unit !== 'millimeter') {
    throw new PrusaThreeMfError(`The 3MF's unit is "${unit}"; only millimeter is supported.`);
  }

  // ONE object, checked rather than assumed. The config's `firstid`/`lastid` ranges address the
  // triangle list of the object PrusaSlicer wrote, so in a model with a second `<object>` — another
  // part, or an object a `<components>` entry points at — those ranges would silently address a
  // different mesh and every named volume would be measured out of the wrong triangles. There is no
  // way to tell here WHICH object the volumes were sliced from, so it is refused, not guessed.
  const objects = [...model.matchAll(/<object\b[^>]*>[\s\S]*?<\/object>/g)].map((om) => om[0]);
  if (objects.length > 1) {
    throw new PrusaThreeMfError(
      `The 3MF's model holds ${objects.length} objects; this reader needs exactly one. Its volume ` +
        'ranges address a single merged mesh, so with more than one the named volumes cannot be told ' +
        'from the geometry they belong to. Save the design as a project with one object.',
    );
  }
  checkBuildTransform(model);

  // The merged mesh, in facet order — one object's, so the config's triangle ranges address exactly
  // the concatenation PrusaSlicer wrote.
  const positions: number[] = [];
  const indices: number[] = [];
  for (const block of objects) {
    const base = positions.length / 3;
    const vertexRe = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"\s*\/>/g;
    for (let vm; (vm = vertexRe.exec(block)); ) {
      const x = Number(vm[1]);
      const y = Number(vm[2]);
      const z = Number(vm[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new PrusaThreeMfError('The 3MF has a vertex with a non-numeric coordinate.');
      }
      positions.push(x, y, z);
    }
    const triRe = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"\s*\/>/g;
    for (let tm; (tm = triRe.exec(block)); ) {
      indices.push(base + Number(tm[1]), base + Number(tm[2]), base + Number(tm[3]));
    }
  }
  if (indices.length === 0) throw new PrusaThreeMfError('The 3MF model has no triangles.');

  // The project's name: the model's `Title` metadata, which PrusaSlicer fills from the saved file
  // name (`<metadata name="Title">single</metadata>` — element text, not an attribute).
  const objectName =
    /<metadata\b[^>]*name="Title"[^>]*>([\s\S]*?)<\/metadata>/.exec(model)?.[1]?.trim() || 'design';

  const volumes: PrusaVolume[] = [];
  const volumeRe = /<volume\b([^>]*)>([\s\S]*?)<\/volume>/g;
  for (let v; (v = volumeRe.exec(config)); ) {
    const head = attrs(v[1]!);
    const firstId = num(head.firstid);
    const lastId = num(head.lastid);
    if (firstId === null || lastId === null) continue;
    const body = v[2]!;
    const meta: Record<string, string> = {};
    const metaRe = /<metadata\b([^>]*)\/?>/g;
    for (let m; (m = metaRe.exec(body)); ) {
      const a = attrs(m[1]!);
      if (a.key !== undefined && a.value !== undefined) meta[a.key] = a.value;
    }
    const textTag = /<slic3rpe:text\b([^>]*)\/?>/.exec(body)?.[1];
    const shapeTag = /<slic3rpe:shape\b([^>]*)\/?>/.exec(body)?.[1];
    const textAttrs = textTag ? attrs(textTag) : null;
    const shapeAttrs = shapeTag ? attrs(shapeTag) : null;
    volumes.push({
      name: meta.name ?? `volume ${volumes.length + 1}`,
      volumeType: meta.volume_type ?? 'ModelPart',
      extruder: num(meta.extruder),
      firstId,
      lastId,
      matrix: meta.matrix ? meta.matrix.trim().split(/\s+/).map(Number) : null,
      sourceOffsetZ: num(meta.source_offset_z),
      text: textAttrs
        ? {
            text: textAttrs.text ?? meta.name ?? '',
            font: fontFamilyOf(textAttrs.font_descriptor) ?? '',
            weight: fontWeightOf(textAttrs.font_descriptor),
            lineHeight: num(textAttrs.line_height) ?? 0,
          }
        : null,
      shape: shapeAttrs
        ? {
            filepath: shapeAttrs.filepath ?? null,
            filepath3mf: shapeAttrs.filepath3mf ?? null,
            scale: num(shapeAttrs.scale),
            depth: num(shapeAttrs.depth),
          }
        : null,
    });
  }
  if (volumes.length === 0) {
    throw new PrusaThreeMfError('The 3MF config lists no volumes.');
  }

  const settingsEntry = zip['Metadata/Slic3r_PE.config'];

  return {
    objectName,
    unit,
    volumes,
    mesh: {
      vertProperties: new Float32Array(positions),
      triVerts: new Uint32Array(indices),
    },
    settings: settingsEntry ? readSettings(new TextDecoder('utf-8').decode(settingsEntry)) : {},
    entries: zip,
  };
}

/**
 * `Metadata/Slic3r_PE.config` as `key → value`.
 *
 * It is PrusaSlicer's own settings file, written as `; key = value` lines with the values escaped
 * (a gcode block's newlines are the two characters `\n`, not real ones), so a line-by-line split is
 * safe and only the FIRST `=` separates: values carry `=` inside quoted conditions. The leading `;`
 * is the file's comment marker and is part of the syntax here, not a comment.
 */
function readSettings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*;?\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/**
 * The font family out of a `font_descriptor`. PrusaSlicer writes wxWidgets' native descriptor,
 * whose fields are `;`-separated and whose LAST field is the face name
 * (`1;9;-24;0;0;0;700;0;0;0;1;0;0;2;32;Segoe UI Black`); the family is that name with the style
 * word dropped, so `Segoe UI Black` reports as `Segoe UI` and keeps its weight separately.
 */
function fontFamilyOf(descriptor: string | undefined): string | null {
  if (!descriptor) return null;
  const face = descriptor.split(';').pop()?.trim();
  if (!face) return null;
  return face.replace(/\s+(Black|Bold|Semibold|Light|Medium|Thin|ExtraBold|ExtraLight)$/i, '');
}

/** The numeric weight out of a `font_descriptor` (field 6: 400 regular, 700 bold), or null. */
function fontWeightOf(descriptor: string | undefined): number | null {
  if (!descriptor) return null;
  const w = Number(descriptor.split(';')[6]);
  return Number.isFinite(w) ? w : null;
}
