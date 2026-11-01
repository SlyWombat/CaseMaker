/**
 * The welcome page's four capability illustrations: isometric line art drawn in the app's own
 * palette, as inline SVG. Every shape is projected through the one `iso()` helper below, so the
 * four pictures share an eye point and a scale: a box in the Cases picture is a box in the
 * Toolboxes picture. Colours come from CSS (`.wb-art .a-*` in index.css) so the art follows the
 * theme; nothing here is a raster and nothing is fetched.
 *
 * Each picture says what the feature does at a glance:
 *   Cases — an open enclosure with a board inside and the port cut-outs in its wall.
 *   Racks — a frame with U-rails, a shelf, and a device sitting on it.
 *   Toolboxes — a stacked bin with a divided tray, its lid lifted.
 *   CNC — a spindle down in a pocket, the toolpath on the stock.
 */

import type { ReactNode } from 'react';

type P3 = readonly [number, number, number];

const SX = 0.866;
const SY = 0.5;

/** The 30° isometric projection, with the picture's origin at (cx, cy). */
function projector(cx: number, cy: number) {
  const pt = ([x, y, z]: P3): [number, number] => [cx + (x - y) * SX, cy + (x + y) * SY - z];
  const pts = (list: readonly P3[]): string =>
    list.map((p) => pt(p).map((v) => v.toFixed(1)).join(',')).join(' ');
  return { pt, pts };
}

type Iso = ReturnType<typeof projector>;

/** A cuboid's three visible faces: top (z+h), left (y+d, toward the viewer) and right (x+w). */
function boxFaces(at: P3, size: P3): { top: P3[]; left: P3[]; right: P3[] } {
  const [x, y, z] = at;
  const [w, d, h] = size;
  return {
    top: [
      [x, y, z + h],
      [x + w, y, z + h],
      [x + w, y + d, z + h],
      [x, y + d, z + h],
    ],
    left: [
      [x, y + d, z],
      [x + w, y + d, z],
      [x + w, y + d, z + h],
      [x, y + d, z + h],
    ],
    right: [
      [x + w, y, z],
      [x + w, y + d, z],
      [x + w, y + d, z + h],
      [x + w, y, z + h],
    ],
  };
}

function Box({
  iso,
  at,
  size,
  cls = '',
  faces = 'tlr',
}: {
  iso: Iso;
  at: P3;
  size: P3;
  /** Extra class for all three faces (a material: `a-green`, `a-dark`, `a-metal`…). */
  cls?: string;
  /** Which faces to draw: t(op), l(eft), r(ight). */
  faces?: string;
}) {
  const f = boxFaces(at, size);
  return (
    <g className={cls}>
      {faces.includes('l') && <polygon className="a-left" points={iso.pts(f.left)} />}
      {faces.includes('r') && <polygon className="a-right" points={iso.pts(f.right)} />}
      {faces.includes('t') && <polygon className="a-top" points={iso.pts(f.top)} />}
    </g>
  );
}

/** A quad lying on the x = X plane (the right-hand, viewer-facing wall). */
function onRight(x: number, y0: number, y1: number, z0: number, z1: number): P3[] {
  return [
    [x, y0, z0],
    [x, y1, z0],
    [x, y1, z1],
    [x, y0, z1],
  ];
}

/** A quad lying on the y = Y plane (the left-hand, viewer-facing wall). */
function onLeft(y: number, x0: number, x1: number, z0: number, z1: number): P3[] {
  return [
    [x0, y, z0],
    [x1, y, z0],
    [x1, y, z1],
    [x0, y, z1],
  ];
}

/** A quad lying flat at height z. */
function flat(z: number, x0: number, x1: number, y0: number, y1: number): P3[] {
  return [
    [x0, y0, z],
    [x1, y0, z],
    [x1, y1, z],
    [x0, y1, z],
  ];
}

/** An open-topped tray: outer walls, the cavity floor and far inner walls, and the wall-top ring. */
function Tray({
  iso,
  at,
  size,
  t,
  floor,
  children,
}: {
  iso: Iso;
  at: P3;
  size: P3;
  /** Wall thickness. */
  t: number;
  /** Floor thickness. */
  floor: number;
  /** What sits inside the cavity (drawn after the far walls, before the near walls). */
  children?: ReactNode;
}) {
  const [x, y, z] = at;
  const [w, d, h] = size;
  const f = boxFaces(at, size);
  const ix0 = x + t;
  const ix1 = x + w - t;
  const iy0 = y + t;
  const iy1 = y + d - t;
  const fz = z + floor;
  const topZ = z + h;
  const outerTop = iso.pts(f.top);
  const innerTop = iso.pts(flat(topZ, ix0, ix1, iy0, iy1));
  return (
    <g>
      {/* The cavity: floor, then the two far walls that face the viewer. */}
      <polygon className="a-floor" points={iso.pts(flat(fz, ix0, ix1, iy0, iy1))} />
      <polygon className="a-inner-r" points={iso.pts(onRight(ix0, iy0, iy1, fz, topZ))} />
      <polygon className="a-inner-l" points={iso.pts(onLeft(iy0, ix0, ix1, fz, topZ))} />
      {children}
      {/* The near walls and the rim, in front of everything inside. */}
      <polygon className="a-left" points={iso.pts(f.left)} />
      <polygon className="a-right" points={iso.pts(f.right)} />
      <path className="a-top" fillRule="evenodd" d={`M${outerTop.replace(/ /g, 'L')}Z M${innerTop.replace(/ /g, 'L')}Z`} />
    </g>
  );
}

/** An upright cylinder (a spindle, a bit, a socket) between two heights. */
function Cylinder({
  iso,
  x,
  y,
  z0,
  z1,
  r,
  cls = '',
}: {
  iso: Iso;
  x: number;
  y: number;
  z0: number;
  z1: number;
  r: number;
  cls?: string;
}) {
  const rx = r * 1.2247;
  const ry = r * 0.7071;
  const [cx, top] = iso.pt([x, y, z1]);
  const [, bot] = iso.pt([x, y, z0]);
  return (
    <g className={cls}>
      <path
        className="a-side"
        d={`M${(cx - rx).toFixed(1)},${top.toFixed(1)} L${(cx - rx).toFixed(1)},${bot.toFixed(1)} A${rx.toFixed(2)},${ry.toFixed(2)} 0 0 0 ${(cx + rx).toFixed(1)},${bot.toFixed(1)} L${(cx + rx).toFixed(1)},${top.toFixed(1)} Z`}
      />
      <ellipse className="a-top" cx={cx.toFixed(1)} cy={top.toFixed(1)} rx={rx.toFixed(2)} ry={ry.toFixed(2)} />
    </g>
  );
}

/** A rounded rectangle lying flat at height z, as a closed polyline (for toolpaths). */
function roundedLoop(z: number, x0: number, x1: number, y0: number, y1: number, r: number): P3[] {
  const out: P3[] = [];
  const corners: Array<[number, number, number]> = [
    [x1 - r, y0 + r, -Math.PI / 2],
    [x1 - r, y1 - r, 0],
    [x0 + r, y1 - r, Math.PI / 2],
    [x0 + r, y0 + r, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + (i / 6) * (Math.PI / 2);
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]);
    }
  }
  return out;
}

const VIEW = '0 0 260 190';

function Glow({ cx, cy }: { cx: number; cy: number }) {
  return <ellipse className="a-glow" cx={cx} cy={cy} rx={118} ry={64} />;
}

/* ------------------------------------------------------------------------------------------- */

export function CasesArt({ title }: { title: string }) {
  const iso = projector(122, 86);
  const w = 110;
  const d = 80;
  const h = 40;
  const t = 6;
  // The board, standing on its standoffs inside the cavity.
  const bx = t + 6;
  const by = t + 6;
  const bz = 14;
  const bw = w - 2 * t - 12;
  const bd = d - 2 * t - 12;
  return (
    <svg className="wb-art wb-art--cases" viewBox={VIEW} role="img" aria-label={title} focusable="false">
      <Glow cx={128} cy={118} />
      <Tray iso={iso} at={[0, 0, 0]} size={[w, d, h]} t={t} floor={5}>
        {/* Standoffs under the board's corners. */}
        {(
          [
            [bx + 4, by + 4],
            [bx + bw - 4, by + 4],
            [bx + 4, by + bd - 4],
            [bx + bw - 4, by + bd - 4],
          ] as const
        ).map(([sx, sy]) => (
          <Cylinder key={`${sx}-${sy}`} iso={iso} x={sx} y={sy} z0={5} z1={bz} r={2.2} cls="a-standoff" />
        ))}
        <Box iso={iso} at={[bx, by, bz]} size={[bw, bd, 2.5]} cls="a-green" />
        {/* Components: a SoC, a small chip, a header, and the two connectors at the board's edge. */}
        <Box iso={iso} at={[bx + 24, by + 18, bz + 2.5]} size={[18, 18, 3]} cls="a-dark" />
        <Box iso={iso} at={[bx + 48, by + 12, bz + 2.5]} size={[9, 7, 2]} cls="a-dark" />
        <Box iso={iso} at={[bx + 6, by + bd - 10, bz + 2.5]} size={[40, 4, 5]} cls="a-dark" />
        <Box iso={iso} at={[bx + bw - 16, by + 12, bz + 2.5]} size={[18, 16, 12]} cls="a-metal" />
        <Box iso={iso} at={[bx + bw - 7, by + 40, bz + 2.5]} size={[8, 9, 3]} cls="a-metal" />
      </Tray>
      {/* The port cut-outs in the right wall, lined up with the connectors behind them. */}
      <polygon className="a-hole" points={iso.pts(onRight(w, by + 10, by + 30, bz + 2, bz + 16))} />
      <polygon className="a-hole" points={iso.pts(onRight(w, by + 39.5, by + 50.5, bz + 3, bz + 7))} />
      {/* Lid, lifted clear of the box, with its vent slots. */}
      <g className="a-lid">
        <Box iso={iso} at={[-18, -4, 66]} size={[w, d, 4]} />
        {[0, 1, 2, 3, 4].map((i) => (
          <polygon key={i} className="a-slot" points={iso.pts(flat(70, 12 + i * 10, 15 + i * 10, 18, 54))} />
        ))}
      </g>
    </svg>
  );
}

export function RacksArt({ title }: { title: string }) {
  const iso = projector(126, 86);
  const w = 96;
  const d = 82;
  const post = 8;
  const z0 = 5;
  const z1 = 84;
  const holes = Array.from({ length: 9 }, (_, i) => z0 + 8 + i * 8);
  return (
    <svg className="wb-art wb-art--racks" viewBox={VIEW} role="img" aria-label={title} focusable="false">
      <Glow cx={130} cy={118} />
      {/* Base plate and the two rear posts. */}
      <Box iso={iso} at={[0, 0, 0]} size={[w, d, z0]} />
      <Box iso={iso} at={[0, 0, z0]} size={[post, post + 2, z1 - z0]} />
      <Box iso={iso} at={[0, d - post - 2, z0]} size={[post, post + 2, z1 - z0]} />
      {/* The lower shelf, vented, with a switch sitting on it. */}
      <Box iso={iso} at={[post, post + 2, 26]} size={[w - 2 * post, d - 2 * post - 4, 3]} />
      {[0, 1, 2, 3].map((i) => (
        <polygon key={i} className="a-slot" points={iso.pts(flat(29, 18 + i * 16, 24 + i * 16, 22, d - 22))} />
      ))}
      <Box iso={iso} at={[post + 6, post + 10, 29]} size={[w - 2 * post - 12, d - 2 * post - 20, 13]} cls="a-dark" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <polygon
          key={i}
          className={i % 2 === 0 ? 'a-led' : 'a-led a-led--amber'}
          points={iso.pts(onRight(w - post - 6, post + 14 + i * 7, post + 18 + i * 7, 35, 38))}
        />
      ))}
      {/* The upper shelf, empty: room for the next device. */}
      <Box iso={iso} at={[post, post + 2, 54]} size={[w - 2 * post, d - 2 * post - 4, 3]} />
      {[0, 1, 2, 3].map((i) => (
        <polygon key={i} className="a-slot" points={iso.pts(flat(57, 18 + i * 16, 24 + i * 16, 22, d - 22))} />
      ))}
      {/* A blank faceplate across the top slot, with a keystone jack. */}
      <Box iso={iso} at={[w - 2, post + 2, 68]} size={[2, d - 2 * post - 4, 12]} />
      <polygon className="a-hole" points={iso.pts(onRight(w, d / 2 - 6, d / 2 + 6, 70, 78))} />
      {/* The front posts with their U-pitch holes, in front of the shelves. */}
      <Box iso={iso} at={[w - post, 0, z0]} size={[post, post + 2, z1 - z0]} />
      <Box iso={iso} at={[w - post, d - post - 2, z0]} size={[post, post + 2, z1 - z0]} />
      {holes.map((z) => (
        <g key={z}>
          <polygon className="a-hole" points={iso.pts(onRight(w, 3.2, 6.8, z, z + 3.4))} />
          <polygon className="a-hole" points={iso.pts(onRight(w, d - 6.8, d - 3.2, z, z + 3.4))} />
        </g>
      ))}
      {/* Top plate. */}
      <Box iso={iso} at={[0, 0, z1]} size={[w, d, 5]} />
    </svg>
  );
}

export function ToolboxesArt({ title }: { title: string }) {
  const iso = projector(120, 88);
  const w = 110;
  const d = 80;
  const t = 6;
  const lowH = 22;
  const binH = 36;
  const trayZ = lowH + 18;
  return (
    <svg className="wb-art wb-art--toolboxes" viewBox={VIEW} role="img" aria-label={title} focusable="false">
      <Glow cx={128} cy={122} />
      {/* The module below: closed by the bin sitting in it, so only its walls show. */}
      <Box iso={iso} at={[0, 0, 0]} size={[w, d, lowH]} faces="lr" />
      <polygon className="a-seam" points={iso.pts(onLeft(d, 0, w, lowH - 0.5, lowH + 0.5))} />
      <polygon className="a-seam" points={iso.pts(onRight(w, 0, d, lowH - 0.5, lowH + 0.5))} />
      {/* The open bin, with its divided tray dropped in. */}
      <Tray iso={iso} at={[0, 0, lowH]} size={[w, d, binH]} t={t} floor={4}>
        <Box iso={iso} at={[t, t, trayZ]} size={[w - 2 * t, d - 2 * t, 2.5]} cls="a-tray" />
        {/* Dividers: two across, one along in the left bay. */}
        <Box iso={iso} at={[t + 32, t, trayZ + 2.5]} size={[1.8, d - 2 * t, 9]} cls="a-tray" />
        <Box iso={iso} at={[t + 66, t, trayZ + 2.5]} size={[1.8, d - 2 * t, 9]} cls="a-tray" />
        <Box iso={iso} at={[t, d / 2 - 0.9, trayZ + 2.5]} size={[32, 1.8, 9]} cls="a-tray" />
        {/* Tools in the bays: three sockets and a couple of bits. */}
        <Cylinder iso={iso} x={t + 44} y={t + 16} z0={trayZ + 2.5} z1={trayZ + 12} r={5} cls="a-metal" />
        <Cylinder iso={iso} x={t + 55} y={t + 36} z0={trayZ + 2.5} z1={trayZ + 12} r={5} cls="a-metal" />
        <Cylinder iso={iso} x={t + 44} y={t + 54} z0={trayZ + 2.5} z1={trayZ + 12} r={5} cls="a-metal" />
        <Box iso={iso} at={[t + 74, t + 10, trayZ + 2.5]} size={[6, 42, 4]} cls="a-accent" />
        <Box iso={iso} at={[t + 84, t + 18, trayZ + 2.5]} size={[6, 42, 4]} cls="a-accent" />
        <Box iso={iso} at={[t + 10, t + 12, trayZ + 2.5]} size={[8, 8, 6]} cls="a-dark" />
      </Tray>
      {/* The lid, lifted, its registration ridge on top. */}
      <g className="a-lid">
        <Box iso={iso} at={[-10, -2, lowH + binH + 18]} size={[w, d, 5]} />
        <Box iso={iso} at={[t - 8, t, lowH + binH + 23]} size={[w - 2 * t - 4, d - 2 * t - 4, 2.5]} />
      </g>
    </svg>
  );
}

/** Wood grain: a wavy streak lying flat at height z between x0 and x1, around y. */
function grain(z: number, x0: number, x1: number, y: number, amp: number, phase: number): P3[] {
  const out: P3[] = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    out.push([x, y + amp * Math.sin(phase + (i / n) * Math.PI * 2.2), z]);
  }
  return out;
}

export function CncArt({ title }: { title: string }) {
  const iso = projector(112, 74);
  // The bed, and on it a hardwood plate: the name plate being engraved.
  const bed: P3 = [128, 96, 4];
  const sx = 18;
  const sy = 16;
  const sw = 104;
  const sd = 70;
  const sz = bed[2];
  const sh = 14;
  const top = sz + sh;
  const px0 = sx + 12;
  const px1 = sx + sw - 12;
  const py0 = sy + 11;
  const py1 = sy + sd - 11;
  const pz = top - 4;
  const pocket = iso.pts(flat(top, px0, px1, py0, py1));
  const outer = roundedLoop(pz + 0.2, px0 + 4, px1 - 4, py0 + 4, py1 - 4, 5);
  const inner = roundedLoop(pz + 0.2, px0 + 9, px1 - 9, py0 + 9, py1 - 9, 3);
  // The spindle is over the border loop's first point, the cutter down on the engraved floor.
  const tip: P3 = outer[1] ?? [px0 + 4, py0 + 4, pz];
  const [tx, ty] = iso.pt(tip);
  const [ringX, ringY] = iso.pt([tip[0], tip[1], top + 72]);
  const chips: Array<[number, number]> = [
    [8, -14],
    [16, -6],
    [-10, -12],
    [20, -18],
  ];
  // Engraved letters on the plate's floor, as short strokes: a name, not a word.
  const letters = [0, 1, 2, 3, 4].map((i) => flat(pz + 0.3, px0 + 22 + i * 11, px0 + 29 + i * 11, py0 + 21, py0 + 23.5));
  return (
    <svg className="wb-art wb-art--cnc" viewBox={VIEW} role="img" aria-label={title} focusable="false">
      <Glow cx={122} cy={120} />
      <defs>
        <clipPath id="wb-cnc-pocket">
          <polygon points={pocket} />
        </clipPath>
        <clipPath id="wb-cnc-top">
          <polygon points={iso.pts(flat(top, sx, sx + sw, sy, sy + sd))} />
        </clipPath>
      </defs>
      <Box iso={iso} at={[0, 0, 0]} size={bed} cls="a-bed" />
      {/* T-slot lines on the bed. */}
      {[0, 1, 2].map((i) => (
        <polygon key={i} className="a-slot" points={iso.pts(flat(bed[2], 2, bed[0] - 2, 6 + i * 44, 7.2 + i * 44))} />
      ))}
      <Box iso={iso} at={[sx, sy, sz]} size={[sw, sd, sh]} cls="a-wood" />
      {/* The grain: streaks along the plank's top, and their end grain on the near wall. */}
      <g clipPath="url(#wb-cnc-top)">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <polyline key={i} className="a-grain" points={iso.pts(grain(top + 0.1, sx, sx + sw, sy + 5 + i * 10, 2.2, i * 1.3))} />
        ))}
      </g>
      {[0, 1, 2].map((i) => (
        <polyline
          key={i}
          className="a-grain"
          points={iso.pts([
            [sx, sy + sd, sz + 3 + i * 4],
            [sx + sw * 0.5, sy + sd, sz + 4.2 + i * 4],
            [sx + sw, sy + sd, sz + 3 + i * 4],
          ])}
        />
      ))}
      {/* The engraved panel: its outline in the top, then the floor seen through it. */}
      <polygon className="a-hole" points={pocket} />
      <g clipPath="url(#wb-cnc-pocket)">
        <polygon className="a-floor" points={iso.pts(flat(pz, px0, px1, py0, py1))} />
        <polygon className="a-inner-r" points={iso.pts(onRight(px0, py0, py1, pz, top))} />
        <polygon className="a-inner-l" points={iso.pts(onLeft(py0, px0, px1, pz, top))} />
        <polygon className="a-path" points={iso.pts(inner)} />
        {letters.map((l, i) => (
          <polygon key={i} className="a-letter" points={iso.pts(l)} />
        ))}
        <polygon className="a-path a-path--live" points={iso.pts(outer)} />
      </g>
      {/* Chips flying off the cut. */}
      {chips.map(([dx, dy], i) => (
        <circle key={i} className="a-chip" cx={(tx + dx).toFixed(1)} cy={(ty + dy).toFixed(1)} r={1.4} />
      ))}
      {/* The spindle: the cutter reaching the floor, the collet nut, the body. */}
      <Cylinder iso={iso} x={tip[0]} y={tip[1]} z0={pz} z1={top + 22} r={1.6} cls="a-metal a-tool" />
      <Cylinder iso={iso} x={tip[0]} y={tip[1]} z0={top + 22} z1={top + 32} r={6} cls="a-dark" />
      <Cylinder iso={iso} x={tip[0]} y={tip[1]} z0={top + 32} z1={top + 86} r={11} cls="a-spindle" />
      <ellipse className="a-ring" cx={ringX.toFixed(1)} cy={ringY.toFixed(1)} rx={13.47} ry={7.78} />
      <circle className="a-spark" cx={tx.toFixed(1)} cy={ty.toFixed(1)} r={4} />
    </svg>
  );
}
