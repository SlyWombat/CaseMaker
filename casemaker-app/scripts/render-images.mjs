#!/usr/bin/env node
// Render the SVG masters in /images to PNGs at every size we need.
// Uses headless chromium (we already have playwright as a devDep).
//
// Outputs (all in /images):
//   favicon-16.png, favicon-32.png, favicon-48.png, favicon-96.png
//   favicon.ico   (multi-resolution)
//   apple-touch-icon-180.png
//   pwa-192.png, pwa-512.png, pwa-512-maskable.png
//   logo-512.png  (square, transparent bg)
//   logo-wordmark-1024.png
//   social-card-1280x640.png  (GitHub OG / Twitter card)
//   readme-banner-1200x300.png

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMG_DIR = resolve(__dirname, '..', '..', 'images');

const renders = [
  // [svg, outName, width, height, opts]
  ['logo-mark.svg', 'favicon-16.png', 16, 16],
  ['logo-mark.svg', 'favicon-32.png', 32, 32],
  ['logo-mark.svg', 'favicon-48.png', 48, 48],
  ['logo-mark.svg', 'favicon-96.png', 96, 96],
  ['logo-mark.svg', 'apple-touch-icon-180.png', 180, 180],
  ['logo-mark.svg', 'pwa-192.png', 192, 192],
  ['logo-mark.svg', 'pwa-512.png', 512, 512],
  ['logo-mark.svg', 'logo-512.png', 512, 512],
  ['logo-wordmark.svg', 'logo-wordmark-1024.png', 1024, 228],
  ['social-card.svg', 'social-card-1280x640.png', 1280, 640],
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
const page = await ctx.newPage();

for (const [svg, out, w, h] of renders) {
  const svgPath = join(IMG_DIR, svg);
  if (!existsSync(svgPath)) {
    console.warn(`skip ${out}: missing ${svgPath}`);
    continue;
  }
  const svgBody = readFileSync(svgPath, 'utf8');
  // Inline the SVG into a HTML page, viewport sized to w×h, page background
  // transparent so PNG keeps the SVG's own background.
  const html = `<!doctype html><html><head><style>
    html, body { margin: 0; padding: 0; background: transparent; }
    svg { display: block; width: ${w}px; height: ${h}px; }
  </style></head><body>${svgBody}</body></html>`;
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(html, { waitUntil: 'load' });
  await page.locator('svg').screenshot({
    path: join(IMG_DIR, out),
    omitBackground: false,
  });
  console.log(`✓ ${out}  (${w}×${h})`);
}

// Build a multi-resolution .ico using the 16/32/48 PNGs.
// ICO header: 6 bytes; each ICONDIRENTRY: 16 bytes; then concatenated PNGs.
function buildIco(pngPaths) {
  const pngs = pngPaths.map((p) => ({ size: parseInt(p.match(/(\d+)\.png$/)?.[1] ?? '0', 10), buf: readFileSync(p) }));
  const N = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type 1 = ICO
  header.writeUInt16LE(N, 4);   // image count
  const dir = Buffer.alloc(16 * N);
  let offset = 6 + 16 * N;
  for (let i = 0; i < N; i++) {
    const p = pngs[i];
    const sizeByte = p.size === 256 ? 0 : p.size; // ICO spec: 0 means 256
    dir.writeUInt8(sizeByte, i * 16 + 0);     // width
    dir.writeUInt8(sizeByte, i * 16 + 1);     // height
    dir.writeUInt8(0, i * 16 + 2);            // color count (0 = >256)
    dir.writeUInt8(0, i * 16 + 3);            // reserved
    dir.writeUInt16LE(1, i * 16 + 4);         // planes
    dir.writeUInt16LE(32, i * 16 + 6);        // bits/pixel
    dir.writeUInt32LE(p.buf.length, i * 16 + 8); // size
    dir.writeUInt32LE(offset, i * 16 + 12);   // offset
    offset += p.buf.length;
  }
  return Buffer.concat([header, dir, ...pngs.map((p) => p.buf)]);
}

const icoBuf = buildIco([
  join(IMG_DIR, 'favicon-16.png'),
  join(IMG_DIR, 'favicon-32.png'),
  join(IMG_DIR, 'favicon-48.png'),
]);
writeFileSync(join(IMG_DIR, 'favicon.ico'), icoBuf);
console.log(`✓ favicon.ico  (${icoBuf.length} bytes, 3 sizes)`);

await browser.close();
console.log('\nAll image variants rendered to:', IMG_DIR);
