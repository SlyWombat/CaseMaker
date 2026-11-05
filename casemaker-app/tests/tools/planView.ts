/**
 * #959 acceptance — PLAN-VIEW PICTURE of the posted programs.
 *
 * The seven-line scorer reads numbers; the maintainer needs to SEE the plan. This draws every run
 * of a plan in plan view (XY), one colour per cutter, feed moves solid and rapids faint, over the
 * stock rectangle, as a standalone SVG. It is a test tool, not shipped: the acceptance writes the
 * file and attaches it, so no production module carries it.
 */

import type { ToolpathIR } from '@/engine/cnc/cam/ir';

export interface PlanViewRun {
  cutterKey: string;
  ir: ToolpathIR;
}

interface Box {
  /** Stock rectangle the view is fitted to, mm. */
  lengthMm: number;
  widthMm: number;
}

/** One colour per cutter key, stable across runs (the vendor's T1..T4 order first, then any). */
const PALETTE = ['#2563eb', '#d97706', '#059669', '#dc2626', '#7c3aed', '#0891b2', '#ca8a04', '#db2777'];

export function planViewSvg(runs: readonly PlanViewRun[], stock: Box, opts: { pxPerMm?: number } = {}): string {
  const pxPerMm = opts.pxPerMm ?? 3;
  const pad = 24;
  const w = stock.lengthMm * pxPerMm + pad * 2;
  const h = stock.widthMm * pxPerMm + pad * 2;
  const sx = (x: number): number => pad + x * pxPerMm;
  const sy = (y: number): number => pad + (stock.widthMm - y) * pxPerMm;
  const keys: string[] = [];
  for (const run of runs) if (!keys.includes(run.cutterKey)) keys.push(run.cutterKey);
  const colourOf = (key: string): string => PALETTE[keys.indexOf(key) % PALETTE.length]!;

  const paths: string[] = [];
  for (const run of runs) {
    const colour = colourOf(run.cutterKey);
    let prev: { x: number; y: number } | null = null;
    let feedPath = '';
    let rapidPath = '';
    for (const op of run.ir.operations) {
      for (const m of op.moves) {
        if (prev !== null) {
          const d = `M ${sx(prev.x).toFixed(2)} ${sy(prev.y).toFixed(2)} L ${sx(m.x).toFixed(2)} ${sy(m.y).toFixed(2)} `;
          if (m.kind === 'rapid') rapidPath += d;
          else feedPath += d;
        }
        prev = { x: m.x, y: m.y };
      }
    }
    if (rapidPath !== '') paths.push(`<path d="${rapidPath}" stroke="${colour}" stroke-opacity="0.18" stroke-width="0.6" fill="none"/>`);
    if (feedPath !== '') paths.push(`<path d="${feedPath}" stroke="${colour}" stroke-opacity="0.9" stroke-width="0.9" fill="none"/>`);
  }

  const legend = keys
    .map((key, i) => `<g transform="translate(${pad}, ${pad + 16 + i * 16})"><rect width="10" height="10" fill="${PALETTE[i % PALETTE.length]}"/><text x="14" y="9" font-family="monospace" font-size="11" fill="#111">${escapeXml(key)}</text></g>`)
    .join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(0)}" height="${h.toFixed(0)}" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<rect x="${pad}" y="${pad}" width="${(stock.lengthMm * pxPerMm).toFixed(2)}" height="${(stock.widthMm * pxPerMm).toFixed(2)}" fill="none" stroke="#111" stroke-width="1"/>`,
    ...paths,
    legend,
    `</svg>`,
  ].join('\n');
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}
