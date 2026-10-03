// The chunked union is now the only bottleneck (2.3 s at 8 000 contours).
// Hypothesis: simplifying each chunk before the tree reduction keeps the
// intermediate point counts low and makes the reduction cheap.
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';
const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();
const { CrossSection } = tl;
const out = (s) => process.stdout.write(s + '\n');
const circle = (cx,cy,r,SEG) => { const p=[]; for(let i=0;i<SEG;i++){const a=2*Math.PI*i/SEG;p.push([cx+r*Math.cos(a),cy+r*Math.sin(a)]);}return p; };
function glyphPath(n,spread){const s=[];let x=10,y=19;for(let i=0;i<n;i++){const a=(i*2.39996)%(2*Math.PI);const nx=Math.min(66,Math.max(4,x+spread*Math.cos(a))),ny=Math.min(34,Math.max(4,y+spread*Math.sin(a)));s.push([x,y,nx,ny]);x=nx;y=ny;}return s;}
function contoursFor(segs,r,SEG){const polys=[];for(const [x0,y0,x1,y1] of segs){polys.push(circle(x1,y1,r,SEG));const dx=x1-x0,dy=y1-y0,len=Math.hypot(dx,dy);if(len<1e-9)continue;const nx=-dy/len*r,ny=dx/len*r;polys.push([[x0+nx,y0+ny],[x1+nx,y1+ny],[x1-nx,y1-ny],[x0-nx,y0-ny]]);}return polys;}
const T=(l,f)=>{const t=performance.now();const v=f();out(`  ${l.padEnd(42)}${(performance.now()-t).toFixed(0).padStart(7)} ms`);return v;};
const EPS = 0.002;

for (const [n, SEG] of [[4000,16],[12000,16],[12000,12]]) {
  const polys = contoursFor(glyphPath(n,1.2), 0.5, SEG);
  out(`\n### ${n} segments, SEG=${SEG} -> ${polys.length} contours, ${polys.reduce((a,p)=>a+p.length,0)} pts`);

  const plain = T('chunk64 -> union (no per-chunk simplify)', () => {
    const parts=[]; for(let i=0;i<polys.length;i+=64) parts.push(new CrossSection(polys.slice(i,i+64),'Positive'));
    return CrossSection.union(parts).simplify(EPS);
  });
  out(`    area ${plain.area().toFixed(3)}  pts ${plain.toPolygons().reduce((a,p)=>a+p.length,0)}`);

  const simp = T('chunk64 -> simplify each -> union', () => {
    const parts=[]; for(let i=0;i<polys.length;i+=64) parts.push(new CrossSection(polys.slice(i,i+64),'Positive').simplify(EPS));
    return CrossSection.union(parts).simplify(EPS);
  });
  out(`    area ${simp.area().toFixed(3)}  pts ${simp.toPolygons().reduce((a,p)=>a+p.length,0)}`);

  const pair = T('chunk64 -> simplify -> pairwise tree', () => {
    let lvl=[]; for(let i=0;i<polys.length;i+=64) lvl.push(new CrossSection(polys.slice(i,i+64),'Positive').simplify(EPS));
    while (lvl.length > 1) {
      const nx=[];
      for (let i=0;i<lvl.length;i+=8) nx.push(CrossSection.union(lvl.slice(i,i+8)).simplify(EPS));
      lvl = nx;
    }
    return lvl[0];
  });
  out(`    area ${pair.area().toFixed(3)}  pts ${pair.toPolygons().reduce((a,p)=>a+p.length,0)}`);
}
