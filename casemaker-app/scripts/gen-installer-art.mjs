#!/usr/bin/env node
/**
 * Generate the two bitmaps the Windows installer wizard draws (#403 gap 5).
 *
 *     npm run installer:art            # writes src-tauri/windows/*.bmp
 *     npm run installer:art -- --preview /tmp/art   # ...and PNG copies to look at
 *
 * MUI2 wants a 150x57 header bitmap for every inner page (`MUI_HEADERIMAGE_BITMAP`, which Tauri's
 * template wires from `bundle.windows.nsis.headerImage`) and a 164x314 panel down the left of the
 * welcome and finish pages (`MUI_WELCOMEFINISHPAGE_BITMAP`, from `sidebarImage`). Both must be BMPs
 * — MUI `File`s them straight into the installer, so there is nothing to decode them at run time.
 *
 * These are *generated*, not drawn, so they follow the artwork rather than drifting away from it:
 * the mark is Tauri's own `icons/icon.png` resampled by the same box filter that builds the 20 and
 * 40 px icon entries, over `public/logo-mark.svg`'s own documented dark for the tall panel and over
 * the wizard's white for the header (the NOTE below says which is which and why). Redraw the
 * artwork, re-run this, and the wizard follows. Nothing here is hand-placed pixel by pixel, and the
 * two sizes are asserted below rather than eyeballed.
 *
 * NOTE the mark's own tile is `#11151a` — the sidebar's field exactly — so on the tall panel the
 * rounded tile edge is invisible and the case/PCB artwork appears to float. On the header, which
 * follows the wizard's own white, the tile does show: a dark rounded square, the mark as a mark. If
 * the artwork is ever re-exported on a different background, or the header is asked for on dark
 * again, this is the paragraph that has to be rewritten with it.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blit, canvas, decodePng, encodeBmp, encodePng, fillRect, hex, scaled } from './lib/raster.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARK = join(ROOT, 'src-tauri', 'icons', 'icon.png');
const OUT = join(ROOT, 'src-tauri', 'windows');

/** The web app's dark palette — the same four values `public/logo-mark.svg` documents in its own
 *  comment (case shell #88a4cc, PCB #0d6b3a, accent gold #d4af37, background #11151a). */
const DARK = '#11151a';
const GOLD = '#d4af37';
/** The wizard's OWN field colour, and so the header's: Modern UI defaults `MUI_BGCOLOR` to `FFFFFF`
 *  (`NSIS/Contrib/Modern UI/System.nsh`, `MUI_DEFAULT`) and Tauri's installer template does not
 *  override it. Anything else turns the header strip into a rectangle sitting inside the page
 *  instead of part of it — which is what the dark version was (#403). */
const WIZARD = '#ffffff';

/** MUI's fixed sizes; it does not scale what it is given. */
const HEADER = { width: 150, height: 57 };
const SIDEBAR = { width: 164, height: 314 };

/** Where the mark sits inside each panel, and the rule that ties the tall panel together. */
const SIDEBAR_MARK = 132;
const SIDEBAR_RULE = { width: 48, height: 3, gap: 18 };
/** In the header the mark is the left end of a strip whose page title follows it, so it is set in
 *  from the edge rather than centred — centred it reads as a logo that lost its label. */
const HEADER_MARK = 48;
const HEADER_MARK_X = 10;

const mark = decodePng(readFileSync(MARK));

const centre = (panel, size) => Math.round((panel - size) / 2);

/** The header strip: the mark, set in from the left edge, on the wizard's own field rather than on
 *  brand dark, so the strip reads as part of the page it is drawn on. */
function headerArt() {
  const img = canvas(HEADER.width, HEADER.height, WIZARD);
  blit(img, scaled(mark, HEADER_MARK), HEADER_MARK_X, centre(HEADER.height, HEADER_MARK));
  return img;
}

/**
 * The artwork's own vertical extent within the mark tile.
 *
 * The tile has a transparent margin and the artwork does not fill it, so a rule placed under the
 * *tile* floats in empty space below the case. Measuring where the ink actually ends keeps the gap
 * the gap it looks like, and it follows the artwork if it is ever redrawn. `field` is the colour the
 * mark was drawn on — the only thing "ink" can mean is "not this".
 */
function inkBottom(img, field) {
  const [r, g, b] = hex(field);
  const background = (r << 16) | (g << 8) | b;
  for (let y = img.height - 1; y >= 0; y--) {
    for (let x = 0; x < img.width; x++) {
      const at = (y * img.width + x) * 4;
      if (((img.data[at] << 16) | (img.data[at + 1] << 8) | img.data[at + 2]) !== background) return y;
    }
  }
  return img.height - 1;
}

/** The tall panel: the mark above centre, with a short gold rule under it as the accent. */
function sidebarArt() {
  const img = canvas(SIDEBAR.width, SIDEBAR.height, DARK);
  const art = scaled(mark, SIDEBAR_MARK);
  const markTop = centre(SIDEBAR.height, SIDEBAR_MARK) - 8;
  blit(img, art, centre(SIDEBAR.width, SIDEBAR_MARK), markTop);
  fillRect(
    img,
    centre(SIDEBAR.width, SIDEBAR_RULE.width),
    markTop + inkBottom(art, DARK) + SIDEBAR_RULE.gap,
    SIDEBAR_RULE.width,
    SIDEBAR_RULE.height,
    GOLD,
  );
  return img;
}

/** Nearest-neighbour blow-up, for previews only — the panels are too small to judge at 1:1. */
function upscale(img, factor) {
  const out = {
    width: img.width * factor,
    height: img.height * factor,
    data: new Uint8Array(img.width * factor * img.height * factor * 4),
  };
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const src = (Math.floor(y / factor) * img.width + Math.floor(x / factor)) * 4;
      out.data.set(img.data.subarray(src, src + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

/** Pixels that are not the panel's own field. A panel that came out flat means the mark never
 *  landed, which is precisely what the first run of this script produced when `blit` was handed a
 *  bare pixel array — two blank bitmaps that would have shipped as "proper icons and marketing look
 *  and feel". The artwork is a small part of a 164x314 panel, so the bar is low; it is only here to
 *  catch nothing — and it can only do that against the field each panel is actually drawn on, which
 *  is why the colour is a parameter and not the one constant it used to be. */
function inkPixels(img, field) {
  const [r, g, b] = hex(field);
  const background = (r << 16) | (g << 8) | b;
  let n = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    if (((img.data[i * 4] << 16) | (img.data[i * 4 + 1] << 8) | img.data[i * 4 + 2]) !== background) n++;
  }
  return n;
}

const wanted = [
  { name: 'installer-header.bmp', art: headerArt(), size: HEADER, field: WIZARD },
  { name: 'installer-sidebar.bmp', art: sidebarArt(), size: SIDEBAR, field: DARK },
];

const previewAt = (() => {
  const at = process.argv.indexOf('--preview');
  return at === -1 ? null : (process.argv[at + 1] ?? join(ROOT, '.art-preview'));
})();

mkdirSync(OUT, { recursive: true });
if (previewAt) mkdirSync(previewAt, { recursive: true });

for (const { name, art, size, field } of wanted) {
  if (art.width !== size.width || art.height !== size.height) {
    throw new Error(`${name} came out ${art.width}x${art.height}; MUI needs ${size.width}x${size.height}`);
  }
  const ink = inkPixels(art, field);
  if (ink < 100) throw new Error(`${name} is blank (${ink} non-background pixels) — did the mark land?`);
  const bmp = encodeBmp(art.width, art.height, art.data);
  writeFileSync(join(OUT, name), bmp);
  console.log(
    `${name}: ${art.width}x${art.height}, ${(bmp.length / 1024).toFixed(1)} kB, 24-bit, ` +
      `${ink} of ${art.width * art.height} px drawn`,
  );
  if (previewAt) {
    writeFileSync(join(previewAt, name.replace(/\.bmp$/, '.png')), encodePng(art.width, art.height, art.data));
    const big = upscale(art, 4);
    writeFileSync(join(previewAt, name.replace(/\.bmp$/, '@4x.png')), encodePng(big.width, big.height, big.data));
  }
}

console.log(`wrote ${wanted.length} bitmaps to ${OUT.replace(`${ROOT}/`, '')}`);
if (previewAt) console.log(`previews in ${previewAt}`);
