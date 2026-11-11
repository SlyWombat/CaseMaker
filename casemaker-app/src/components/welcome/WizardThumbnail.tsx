/**
 * #1099 — THE FILE, DRAWN. One thumbnail for the question step's read state, fed by the PARSED
 * import (never by re-opening the file):
 *
 *   - a mesh: a shaded isometric at a fixed camera (az 35°, el 30°), painted from its triangles;
 *   - a drawing (SVG/DXF): its rings filled and its open paths stroked, fitted to the box;
 *   - a picture (PNG): the image itself, in the relief's greyscale reading;
 *   - a Gerber set: the board's outline (the set's own geometry lives in the job's items).
 *
 * Beside/below it, one facts line and — when the caller has one — the stock proposal's sentence,
 * which moved here from the Stock step so the operator sees the blank they will get while the file
 * is still in front of them.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { base64ToArrayBuffer } from '@/engine/import/base64';
import { parseStl, type ParsedMesh } from '@/engine/import/stlParser';
import type { OutlineImport } from '@/engine/import/outlineImport';

export type ThumbnailSource =
  | {
      kind: 'mesh';
      name: string;
      /** The stored binary STL (a STEP/3MF/OBJ is converted at the door, so all are STL here). */
      data: string;
      size: { x: number; y: number; z: number };
    }
  | { kind: 'outline'; outline: OutlineImport }
  | { kind: 'picture'; name: string; data: string; size: { x: number; y: number; z: number } }
  | {
      kind: 'board';
      board: { length: number; width: number };
      /** The Gerber files the set came in as; null/absent when the caller does not know (a Back). */
      files?: number | null;
    };

export interface WizardThumbnailProps {
  source: ThumbnailSource;
  /** The stock proposal's sentence, when the caller has proposed one. */
  sentence?: string | null;
}

const W = 160;
const H = 120;

const n = (v: number): string => String(Number(v.toFixed(2)));
/** Item 3's decided precision: millimetres to one decimal, mm/px to two, trailing zeros dropped. */
const one = (v: number): string => String(Number(v.toFixed(1)));
const two = (v: number): string => String(Number(v.toFixed(2)));

/** Azimuth and elevation of the fixed camera, degrees (the mockup's reading). */
const AZ_DEG = 35;
const EL_DEG = 30;

/**
 * Paint the mesh into the 160 × 120 box: project every triangle to the fixed camera, sort by
 * depth and fill back-to-front with one flat light. A thumbnail cannot use all of a 12 MB model's
 * triangles at this size, so a stride samples at most ~40 000 — the shape reads, the frame stays
 * inside the 300 ms budget.
 */
function paintMesh(canvas: HTMLCanvasElement, mesh: ParsedMesh): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const az = (AZ_DEG * Math.PI) / 180;
  const el = (EL_DEG * Math.PI) / 180;
  const ca = Math.cos(az);
  const sa = Math.sin(az);
  const ce = Math.cos(el);
  const se = Math.sin(el);

  const p = mesh.positions;
  const idx = mesh.indices;
  const triCount = Math.floor(idx.length / 3);
  const stride = Math.max(1, Math.ceil(triCount / 40_000));

  // Project to a unit-ish frame first; fit to the box with a margin after.
  const px = new Float32Array(p.length / 3);
  const py = new Float32Array(p.length / 3);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let v = 0; v < p.length / 3; v++) {
    const x = p[3 * v]!;
    const y = p[3 * v + 1]!;
    const z = p[3 * v + 2]!;
    const u = x * ca - y * sa;
    const w = x * sa + y * ca;
    const sx = u;
    // Screen Y grows down: the tilted depth rises up the page, the height rises up too.
    const sy = -(w * se) - z * ce;
    px[v] = sx;
    py[v] = sy;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }
  const bw = Math.max(maxX - minX, 1e-6);
  const bh = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((W - 16) / bw, (H - 16) / bh);
  const ox = (W - bw * scale) / 2 - minX * scale;
  const oy = (H - bh * scale) / 2 - minY * scale;

  // One light, flat shading: lambert on the triangle's normal against a fixed direction.
  const lx = 0.4;
  const ly = -0.5;
  const lz = 0.75;
  const lLen = Math.hypot(lx, ly, lz);

  const order: number[] = [];
  const depths = new Float32Array(triCount);
  for (let t = 0; t < triCount; t += stride) {
    const a = idx[3 * t]!;
    const b = idx[3 * t + 1]!;
    const c = idx[3 * t + 2]!;
    depths[t] = (p[3 * a + 2]! + p[3 * b + 2]! + p[3 * c + 2]!) / 3;
    order.push(t);
  }
  order.sort((i, j) => depths[i]! - depths[j]!);

  ctx.clearRect(0, 0, W, H);
  for (const t of order) {
    const a = idx[3 * t]!;
    const b = idx[3 * t + 1]!;
    const c = idx[3 * t + 2]!;
    const ax = p[3 * a]!;
    const ay = p[3 * a + 1]!;
    const az2 = p[3 * a + 2]!;
    const ux = p[3 * b]! - ax;
    const uy = p[3 * b + 1]! - ay;
    const uz = p[3 * b + 2]! - az2;
    const vx = p[3 * c]! - ax;
    const vy = p[3 * c + 1]! - ay;
    const vz = p[3 * c + 2]! - az2;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const light = Math.max(0.25, Math.abs((nx * lx + ny * ly + nz * lz) / (len * lLen)));
    const shade = Math.round(120 + 110 * light);
    ctx.fillStyle = `rgb(${shade}, ${Math.round(shade * 0.86)}, ${Math.round(shade * 0.62)})`;
    ctx.beginPath();
    ctx.moveTo(ox + px[a]! * scale, oy + py[a]! * scale);
    ctx.lineTo(ox + px[b]! * scale, oy + py[b]! * scale);
    ctx.lineTo(ox + px[c]! * scale, oy + py[c]! * scale);
    ctx.closePath();
    ctx.fill();
  }
}

/** A drawing's rings and paths fitted into the 160 × 120 box, in the mockup's colours. */
function OutlineThumbnail({ outline }: { outline: OutlineImport }): JSX.Element {
  const size = Math.max(outline.width, outline.height, 0.001);
  const scale = Math.min((W - 16) / size, (H - 16) / size);
  const ox = W / 2;
  const oy = H / 2;
  const pathOf = (points: readonly [number, number][], closed: boolean): string =>
    points
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${(ox + x * scale).toFixed(2)},${(oy - y * scale).toFixed(2)}`)
      .join(' ') + (closed ? ' Z' : '');
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="The drawing, fitted to the thumbnail"
      data-testid="wizard-thumbnail-outline"
    >
      {outline.contours.map((ring, i) => (
        <path key={`c${i}`} d={pathOf(ring, true)} fill="rgba(138, 180, 248, 0.35)" stroke="#8ab4f8" strokeWidth="1" />
      ))}
      {(outline.paths ?? []).map((path, i) => (
        <path
          key={`p${i}`}
          d={pathOf(path.points, path.closed)}
          fill={path.closed ? 'rgba(240, 217, 181, 0.25)' : 'none'}
          stroke="#f0d9b5"
          strokeWidth="1.2"
        />
      ))}
    </svg>
  );
}

export function WizardThumbnail({ source, sentence }: WizardThumbnailProps): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const mesh = source.kind === 'mesh' ? source : null;
  const meshKey = mesh === null ? '' : mesh.data.length.toString(36) + mesh.data.slice(0, 32);
  // The stored STL is the parsed import (a STEP/3MF/OBJ was converted at the door); parse it once
  // per file for both the drawing and its triangle count — never by re-reading the picked File.
  const parsed = useMemo<ParsedMesh | null>(() => {
    if (mesh === null) return null;
    try {
      return parseStl(base64ToArrayBuffer(mesh.data));
    } catch {
      return null;
    }
  }, [meshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (parsed === null || canvas.current === null) return;
    paintMesh(canvas.current, parsed);
  }, [parsed]);

  // Item 3 — a picture's own pixels are read off the decoded image, not the importer's guess.
  const [pixels, setPixels] = useState<{ w: number; h: number } | null>(null);
  let picture: JSX.Element;
  let facts: string;
  switch (source.kind) {
    case 'mesh':
      picture = (
        <canvas
          ref={canvas}
          width={W}
          height={H}
          data-testid="wizard-thumbnail-canvas"
          style={{ width: W, height: H, background: '#0b1017', borderRadius: 8 }}
        />
      );
      facts = `${n(source.size.x)} × ${n(source.size.y)} × ${n(source.size.z)} mm${
        parsed === null ? '' : ` · ${parsed.triangleCount.toLocaleString('en-US')} triangles`
      } · from ${source.name}`;
      break;
    case 'outline': {
      // Item 4 — a drawing's facts count its SHAPES (the filled rings) and name its open lines:
      // "2 shapes", "1 open line". A zero term is omitted rather than written as "0".
      const shapes = source.outline.contours.length;
      const open = (source.outline.paths ?? []).filter((p) => !p.closed).length;
      picture = <OutlineThumbnail outline={source.outline} />;
      facts = [
        `${n(source.outline.width)} × ${n(source.outline.height)} mm`,
        shapes === 0 ? null : `${shapes} shape${shapes === 1 ? '' : 's'}`,
        open === 0 ? null : `${open} open line${open === 1 ? '' : 's'}`,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ');
      break;
    }
    case 'picture':
      picture = (
        <img
          src={`data:image/png;base64,${source.data}`}
          alt="The picture, as the relief reads it"
          data-testid="wizard-thumbnail-picture"
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              setPixels({ w: img.naturalWidth, h: img.naturalHeight });
            }
          }}
          style={{ width: W, height: H, objectFit: 'contain', background: '#0b1017', borderRadius: 8, filter: 'grayscale(1)' }}
        />
      );
      // Item 3 — "512 × 512 px → 51.2 × 51.2 mm at 0.1 mm/px": the pixels the image really is,
      // the millimetres the relief reads it at, and the scale between them.
      facts =
        pixels === null
          ? `${one(source.size.x)} × ${one(source.size.y)} mm`
          : `${pixels.w.toLocaleString('en-US')} × ${pixels.h.toLocaleString('en-US')} px → ${one(source.size.x)} × ${one(
              source.size.y,
            )} mm at ${two(source.size.x / pixels.w)} mm/px`;
      break;
    case 'board':
      picture = (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="The board outline">
          <rect x="16" y="16" width={W - 32} height={H - 32} fill="rgba(184, 115, 51, 0.25)" stroke="#b87333" strokeWidth="1.5" />
        </svg>
      );
      // Item 2 — the set's own file count, when the caller knows it (a fresh read does; a Back
      // that only kept the board's outline says the size alone).
      facts = `${n(source.board.length)} × ${n(source.board.width)} mm${
        source.files == null || source.files <= 0
          ? ''
          : ` · ${source.files} Gerber file${source.files === 1 ? '' : 's'}`
      }`;
      break;
  }

  // Item 8 — the picture at the LEFT, its facts and the proposal sentence in the column beside it
  // (the CSS stacks the two under 480 px; `.sw-thumb` carries that one rule).
  return (
    <div data-testid="wizard-thumbnail" data-kind={source.kind} className="sw-thumb">
      <span className="sw-thumb__picture">{picture}</span>
      <span className="sw-thumb__side">
        <span data-testid="wizard-thumbnail-facts" style={{ fontSize: 11, color: '#9aa4b0' }}>
          {facts}
        </span>
        {sentence != null && sentence !== '' && (
          <span data-testid="wizard-thumbnail-sentence" style={{ fontSize: 11, color: '#c8d3de' }}>
            {sentence}
          </span>
        )}
      </span>
    </div>
  );
}
