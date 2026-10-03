// Does simplify() before extrude fix the triangle blow-up? probe-sim-2d.mjs got
// 64 076 triangles out of a region whose area is 1.37 mm2, which says the union
// keeps per-capsule sliver detail. If simplify collapses it, the subtract stage
// stops being the bottleneck.
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';
const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();
const { CrossSection, Manifold } = tl;
const out = (s) => process.stdout.write(s + '\n');
const SEG = 16;
const circle = (cx, cy, r) => { const p = []; for (let i = 0; i < SEG; i++) { const a = 2*Math.PI*i/SEG; p.push([cx+r*Math.cos(a), cy+r*Math.sin(a)]); } return p; };
function glyphPath(n, spread) { const s=[]; let x=10,y=19; for (let i=0;i<n;i++){ const a=(i*2.39996)%(2*Math.PI); const nx=Math.min(66,Math.max(4,x+spread*Math.cos(a))), ny=Math.min(34,Math.max(4,y+spread*Math.sin(a))); s.push([x,y,nx,ny]); x=nx;y=ny;} return s; }
function contoursFor(segs,r){const polys=[];for(const [x0,y0,x1,y1] of segs){polys.push(circle(x1,y1,r));const dx=x1-x0,dy=y1-y0,len=Math.hypot(dx,dy);if(len<1e-9)continue;const nx=-dy/len*r,ny=dx/len*r;polys.push([[x0+nx,y0+ny],[x1+nx,y1+ny],[x1-nx,y1-ny],[x0-nx,y0-ny]]);}return polys;}
const T=(l,f)=>{const t=performance.now();const v=f();out(`  ${l.padEnd(38)}${(performance.now()-t).toFixed(0).padStart(7)} ms`);return v;};

for (const n of [1000, 4000]) {
  // spread 1.2 mm so the path actually covers area, like real glyph strokes
  const polys = contoursFor(glyphPath(n, 1.2), 0.5);
  out(`\n### ${n} segments, wider spread -> ${polys.length} contours`);
  const cs = T('chunked union', () => { const parts=[]; for(let i=0;i<polys.length;i+=64) parts.push(new CrossSection(polys.slice(i,i+64),'Positive')); return CrossSection.union(parts); });
  out(`    area ${cs.area().toFixed(2)} mm2, contour pts ${cs.toPolygons().reduce((a,p)=>a+p.length,0)}`);
  for (const eps of [0, 0.002, 0.01, 0.05]) {
    const s = eps ? T(`simplify(${eps})`, () => cs.simplify(eps)) : cs;
    const pts = s.toPolygons().reduce((a,p)=>a+p.length,0);
    const r = T(`  extrude+subtract (eps=${eps})`, () => {
      const stock = Manifold.cube([76.2,38.1,3.81]).translate([0,0,-3.81]);
      return stock.subtract(Manifold.extrude(s, 0.41).translate([0,0,-0.4]));
    });
    out(`    eps=${eps}: pts ${pts}, area ${s.area().toFixed(2)}, result ${r.numTri()} tris`);
  }
}
