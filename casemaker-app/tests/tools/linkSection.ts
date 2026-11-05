/**
 * #962 — THE HOP SECTION: one adjacent-row link drawn as a vertical profile, before and after.
 *
 * X is the distance along the link; Y is z. The travel path is drawn from the posted moves (feeds
 * solid, rapids dashed), and the material the linker read is a filled band: a retract shows its
 * up-cross-down arc above the band, a stay-down link is one flat feed riding on it. Test tool, not
 * shipped — the acceptance writes the SVG.
 */

import type { CamMove } from '@/engine/cnc/cam/ir';

export interface HopSection {
  /** The posted moves of the link, from the pass exit to the next pass's entry. */
  moves: readonly CamMove[];
  /** The material top along the link: [distance along the link, z], in order. */
  material: readonly (readonly [number, number])[];
  label: string;
}

interface Options {
  title: string;
  /** Pixels per millimetre of the horizontal axis. */
  pxPerMm?: number;
}

/** The XY distance along a move list, at each move's endpoint (vertical legs hold the distance). */
function profileOf(moves: readonly CamMove[]): { s: number; z: number; kind: 'feed' | 'rapid' }[] {
  const out: { s: number; z: number; kind: 'feed' | 'rapid' }[] = [];
  let s = 0;
  let prev: CamMove | null = null;
  for (const m of moves) {
    if (prev !== null) s += Math.hypot(m.x - prev.x, m.y - prev.y);
    out.push({ s, z: m.z, kind: m.kind });
    prev = m;
  }
  return out;
}

export function hopSectionSvg(sections: readonly HopSection[], opts: Options): string {
  const px = opts.pxPerMm ?? 90;
  const padL = 64;
  const padR = 24;
  const padT = 34;
  const panelH = 170;
  const gap = 30;
  const maxS = Math.max(0.2, ...sections.flatMap((sec) => (sec.material.length > 0 ? [sec.material[sec.material.length - 1]![0]!] : [0])));
  const plotW = Math.max(420, maxS * px);
  const titleWidth = opts.title.length * 7.4 + padL + padR;
  const width = Math.max(padL + plotW + padR, titleWidth);
  const height = padT + sections.length * panelH + (sections.length - 1) * gap + 34;
  const colours = ['#b45309', '#1d4ed8'];
  const parts: string[] = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(0)}" height="${height.toFixed(0)}" viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}" font-family="ui-sans-serif, system-ui, sans-serif">`);
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  parts.push(`<text x="${padL}" y="20" font-size="13" font-weight="600" fill="#111827">${opts.title}</text>`);

  // ONE z-window across every panel: a before/after pair must read at the same vertical scale.
  const allZ = sections.flatMap((sec) => [...sec.material.map((m) => m[1]), ...sec.moves.map((m) => m.z)]);
  const zLo = Math.min(...allZ);
  const zHi = Math.max(...allZ);
  const zSpan = Math.max(1e-6, zHi - zLo + 1);

  sections.forEach((sec, index) => {
    const top = padT + index * (panelH + gap);
    const colour = colours[index % colours.length]!;
    const zMin = zLo - 0.5;
    const sx = (s: number): number => padL + (s / Math.max(maxS, 1e-9)) * plotW;
    const sy = (z: number): number => top + panelH - ((z - zMin) / zSpan) * (panelH - 26);

    parts.push(`<rect x="${padL}" y="${top}" width="${plotW.toFixed(1)}" height="${panelH}" fill="#f9fafb" stroke="#e5e7eb"/>`);
    // The material band: the top the linker read, filled to the panel floor.
    if (sec.material.length > 1) {
      const pts = sec.material.map(([s, z]) => `${sx(s).toFixed(1)},${sy(z).toFixed(1)}`).join(' ');
      parts.push(`<polygon points="${sx(sec.material[0]![0]!).toFixed(1)},${(top + panelH).toFixed(1)} ${pts} ${sx(sec.material[sec.material.length - 1]![0]!).toFixed(1)},${(top + panelH).toFixed(1)}" fill="#d1d5db" opacity="0.75"/>`);
    }
    // The travel: rapids dashed, feeds solid.
    const trav = profileOf(sec.moves);
    for (let i = 1; i < trav.length; i++) {
      const a = trav[i - 1]!;
      const b = trav[i]!;
      if (a.s === b.s && a.z === b.z) continue;
      const dash = b.kind === 'rapid' ? ' stroke-dasharray="4 3"' : '';
      parts.push(`<line x1="${sx(a.s).toFixed(1)}" y1="${sy(a.z).toFixed(1)}" x2="${sx(b.s).toFixed(1)}" y2="${sy(b.z).toFixed(1)}" stroke="${colour}" stroke-width="1.8"${dash}/>`);
    }
    const mark = (x: number, y: number): string => `<circle cx="${sx(x).toFixed(1)}" cy="${sy(y).toFixed(1)}" r="2.6" fill="${colour}"/>`;
    parts.push(mark(trav[0]!.s, trav[0]!.z));
    parts.push(mark(trav[trav.length - 1]!.s, trav[trav.length - 1]!.z));
    // The panel's own caption, top-left inside the plot with a backing so the travel never hides it.
    parts.push(`<rect x="${padL + 4}" y="${top + 4}" width="${Math.min(plotW - 8, 210).toFixed(1)}" height="16" fill="#ffffff" opacity="0.85"/>`);
    parts.push(`<text x="${padL + 8}" y="${top + 16}" font-size="11" font-weight="600" fill="#374151">${sec.label}</text>`);
    // The z window's two ends (the same on every panel).
    parts.push(`<text x="8" y="${(sy(zLo) + 4).toFixed(1)}" font-size="10" fill="#6b7280">${zLo.toFixed(1)}</text>`);
    parts.push(`<text x="8" y="${(sy(zHi) + 4).toFixed(1)}" font-size="10" fill="#6b7280">${zHi.toFixed(1)}</text>`);
  });

  // The shared horizontal axis, mm along the link.
  const axisY = padT + sections.length * panelH + (sections.length - 1) * gap + 12;
  parts.push(`<text x="${padL}" y="${axisY + 4}" font-size="10" fill="#6b7280">0</text>`);
  parts.push(`<text x="${(padL + plotW - 40).toFixed(1)}" y="${axisY + 4}" font-size="10" fill="#6b7280">${maxS.toFixed(1)} mm</text>`);
  parts.push(`<text x="${padL + plotW / 2 - 56}" y="${axisY + 18}" font-size="10" fill="#6b7280">distance along the link</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}
