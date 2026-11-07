import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [svg, png] = process.argv.slice(2);
const markup = readFileSync(svg, 'utf8');
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1100, height: 450 } });
await p.setContent(`<html><body style="margin:0;background:#e8e4dc">${markup}</body></html>`, { waitUntil: 'load', timeout: 20000 });
await p.locator('svg').screenshot({ path: png, timeout: 20000 }); await b.close(); console.log('png written');
