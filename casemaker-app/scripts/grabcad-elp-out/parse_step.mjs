// One-shot STEP analyzer for the ELP-USBGS1200P01-H120 model.
// Extracts:
//   • overall bounding box (X/Y/Z extents → PCB outline + total module height)
//   • CIRCLE entities → cluster radii to find mounting holes vs the lens
//   • the planes at PCB top/bottom Z → confirm PCB thickness
// Spits a JSON summary to stdout.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'ELP-USBGS1200P01-H120.STEP');

const text = fs.readFileSync(FILE, 'utf8');
// Normalize CRLF + collapse multi-line entities into single logical lines.
const flat = text.replace(/\r\n/g, '\n').replace(/\n\s+/g, ' ');
// Quick sanity check on regex
const probe = (flat.match(/^#\d+\s*=\s*CIRCLE/gm) || []).length;
console.error(`flat-text CIRCLE entity prefix matches: ${probe}`);
// What does entity #189 look like in flat text?
const ent189 = flat.match(/^#189\s*=[\s\S]*?;\s*$/m);
console.error('entity 189 raw:', ent189 ? ent189[0] : '<not found>');

// Parse entities by splitting on top-level `;` (paren-balanced).
// Each statement is `#N = TYPE ( ... )` possibly with nested parens
// (NAMED_UNIT compound types or AXIS2_PLACEMENT_3D refs).
const entities = new Map();
{
  let depth = 0;
  let buf = '';
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ';' && depth === 0) {
      const stmt = buf.trim();
      buf = '';
      // Match: #N = TYPE_OR_COMPOUND ( ... )
      // Compound type starts with `(` instead of `TYPE` — skip those.
      const mh = stmt.match(/^#(\d+)\s*=\s*([A-Z_][A-Z_0-9]*)\s*\(([\s\S]*)\)\s*$/);
      if (mh) {
        // Strip outer parens already done. The captured args may still
        // contain nested parens — that's fine.
        entities.set(Number(mh[1]), { type: mh[2], args: mh[3] });
      }
      continue;
    }
    buf += ch;
  }
}
console.error(`parsed ${entities.size} entities`);
console.error('entity 189 in map:', entities.get(189));
const typeCounts = new Map();
for (const [, e] of entities) typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
console.error('CIRCLE in map:', typeCounts.get('CIRCLE'));
console.error('CARTESIAN_POINT in map:', typeCounts.get('CARTESIAN_POINT'));
console.error('AXIS2_PLACEMENT_3D in map:', typeCounts.get('AXIS2_PLACEMENT_3D'));
console.error('entity 3432:', entities.get(3432));

function getCartPoint(id) {
  const e = entities.get(id);
  if (!e || e.type !== 'CARTESIAN_POINT') return null;
  const m = e.args.match(/\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\)/);
  if (!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
}

// Bounding box from every CARTESIAN_POINT
let bbox = null;
for (const [, e] of entities) {
  if (e.type !== 'CARTESIAN_POINT') continue;
  const pm = e.args.match(/\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\)/);
  if (!pm) continue;
  const x = parseFloat(pm[1]), y = parseFloat(pm[2]), z = parseFloat(pm[3]);
  if (!bbox) bbox = { min: [x, y, z], max: [x, y, z] };
  else {
    if (x < bbox.min[0]) bbox.min[0] = x;
    if (y < bbox.min[1]) bbox.min[1] = y;
    if (z < bbox.min[2]) bbox.min[2] = z;
    if (x > bbox.max[0]) bbox.max[0] = x;
    if (y > bbox.max[1]) bbox.max[1] = y;
    if (z > bbox.max[2]) bbox.max[2] = z;
  }
}
const size = bbox && [
  +(bbox.max[0] - bbox.min[0]).toFixed(3),
  +(bbox.max[1] - bbox.min[1]).toFixed(3),
  +(bbox.max[2] - bbox.min[2]).toFixed(3),
];

// CIRCLE entities: CIRCLE(label, axis2_placement_3d, radius)
// AXIS2_PLACEMENT_3D(label, location_pt, axis_dir, ref_dir)
function parseCircle(args) {
  // args looks like: 'NONE', #123, 1.55  (commas inside parens — already flat)
  const parts = args.split(',').map((s) => s.trim());
  // last token should be radius
  const radius = parseFloat(parts[parts.length - 1]);
  const placementRef = parts.find((p) => /^#\d+$/.test(p));
  const placementId = placementRef ? Number(placementRef.slice(1)) : null;
  return { radius, placementId };
}

function locationFromPlacement(placementId) {
  const p = entities.get(placementId);
  if (!p || p.type !== 'AXIS2_PLACEMENT_3D') return null;
  // Args: 'NONE', #ptId, #axisId, #refId
  const refs = [...p.args.matchAll(/#(\d+)/g)].map((mm) => Number(mm[1]));
  if (!refs.length) return null;
  return getCartPoint(refs[0]);
}

const circles = [];
for (const [id, e] of entities) {
  if (e.type !== 'CIRCLE') continue;
  const c = parseCircle(e.args);
  if (!Number.isFinite(c.radius) || c.placementId == null) continue;
  const loc = locationFromPlacement(c.placementId);
  if (!loc) continue;
  circles.push({ id, radius: +c.radius.toFixed(3), x: +loc[0].toFixed(3), y: +loc[1].toFixed(3), z: +loc[2].toFixed(3) });
}
console.error(`extracted ${circles.length} circles with centers`);

// Bucket by radius (rounded to 0.05 mm)
const bucket = new Map();
for (const c of circles) {
  const key = Math.round(c.radius * 20) / 20;
  if (!bucket.has(key)) bucket.set(key, []);
  bucket.get(key).push(c);
}
const radiiSorted = [...bucket.keys()].sort((a, b) => a - b);

const summary = {
  bbox,
  size,
  radiiHistogram: radiiSorted.map((r) => ({ radius: r, count: bucket.get(r).length })),
};

// PCB lies in the XZ plane (Y is "up"). Find the Y-histogram of circles
// to locate the two PCB faces (top + bottom).
const yHist = new Map();
for (const c of circles) {
  const k = Math.round(c.y * 10) / 10;
  yHist.set(k, (yHist.get(k) || 0) + 1);
}
const yByCount = [...yHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.error('top Y-bands by circle count:', yByCount);
// Pick the lowest two Y-bands with non-trivial count: those should be PCB
// bottom and top.
const pcbCandidateY = [...yHist.entries()]
  .filter(([, n]) => n >= 4)
  .map(([y]) => y)
  .sort((a, b) => a - b);
const pcbBottomY = pcbCandidateY[0];
const pcbTopY = pcbCandidateY.find((y) => y > pcbBottomY + 0.5);
console.error('inferred PCB bottomY:', pcbBottomY, 'topY:', pcbTopY);
const pcbPlaneTolerance = 0.3;
const pcbY = pcbBottomY ?? bbox.min[1];
function clusterUnique(arr) {
  const seen = new Map();
  for (const c of arr) {
    const k = `${Math.round(c.x * 10) / 10}|${Math.round(c.z * 10) / 10}`;
    if (!seen.has(k)) seen.set(k, c);
  }
  return [...seen.values()];
}
const candidates = [];
for (const r of radiiSorted) {
  if (r < 0.5 || r > 2.5) continue;
  // Filter to PCB-plane circles only (y near bbox.min)
  const pcbCircles = bucket.get(r).filter((c) => Math.abs(c.y - pcbY) < pcbPlaneTolerance);
  const distinct = clusterUnique(pcbCircles);
  if (distinct.length >= 4) candidates.push({ radius: r, holes: distinct });
}
summary.mountingHoleCandidates = candidates;
// Dump every distinct circle on EITHER PCB face (top or bottom).
const allPcbCircles = circles
  .filter((c) => Math.abs(c.y - pcbBottomY) < pcbPlaneTolerance ||
                 (pcbTopY != null && Math.abs(c.y - pcbTopY) < pcbPlaneTolerance))
  .map((c) => ({ r: c.radius, x: c.x, z: c.z, y: c.y }));
const seenXZ = new Map();
for (const c of allPcbCircles) {
  const k = `${Math.round(c.x * 10) / 10}|${Math.round(c.z * 10) / 10}|${c.r}`;
  if (!seenXZ.has(k)) seenXZ.set(k, c);
}
summary.pcbBottomY = pcbBottomY;
summary.pcbTopY = pcbTopY;
summary.pcbThickness = (pcbTopY != null && pcbBottomY != null) ? +(pcbTopY - pcbBottomY).toFixed(3) : null;
summary.pcbPlaneCircles = [...seenXZ.values()].sort((a, b) => a.r - b.r);

// Find header-pin-like cluster: small radius (≤0.5 mm), 4 cylinders in a
// row (2 mm pitch). Check CYLINDRICAL_SURFACE entries for axis location.
const cylAxes = [];
for (const [, e] of entities) {
  if (e.type !== 'CYLINDRICAL_SURFACE') continue;
  const refs = [...e.args.matchAll(/#(\d+)/g)].map((mm) => Number(mm[1]));
  if (!refs.length) continue;
  const placement = entities.get(refs[0]);
  if (!placement || placement.type !== 'AXIS2_PLACEMENT_3D') continue;
  const placeRefs = [...placement.args.matchAll(/#(\d+)/g)].map((mm) => Number(mm[1]));
  const loc = getCartPoint(placeRefs[0]);
  const axis = placeRefs[1] != null ? entities.get(placeRefs[1]) : null;
  // axis is DIRECTION ( 'NONE', ( a, b, c ) )
  let axisVec = null;
  if (axis && axis.type === 'DIRECTION') {
    const am = axis.args.match(/\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\)/);
    if (am) axisVec = [parseFloat(am[1]), parseFloat(am[2]), parseFloat(am[3])];
  }
  // Radius is last numeric token in args
  const rmatch = e.args.match(/,\s*([-+0-9.eE]+)\s*$/);
  const r = rmatch ? parseFloat(rmatch[1]) : null;
  if (loc && r != null) {
    cylAxes.push({ x: +loc[0].toFixed(3), y: +loc[1].toFixed(3), z: +loc[2].toFixed(3), r: +r.toFixed(3), axis: axisVec });
  }
}
// Header pins go vertically (axis along Y). Find clusters of small-radius
// vertical cylinders.
const verticalSmallCyls = cylAxes
  .filter((c) => c.r > 0.15 && c.r < 0.6)
  .filter((c) => c.axis && Math.abs(c.axis[1]) > 0.9);
const seenPin = new Map();
for (const c of verticalSmallCyls) {
  const k = `${Math.round(c.x * 10) / 10}|${Math.round(c.z * 10) / 10}|${c.r}`;
  if (!seenPin.has(k)) seenPin.set(k, c);
}
summary.smallVerticalCylinders = [...seenPin.values()].sort((a, b) => a.x - b.x || a.z - b.z);

// Header pins are typically modeled as short cylinders (any radius < 0.6 mm)
// rooted at PCB top (y ≈ pcbTopY) and extending up. Look for 4-cluster of
// small cylinders rooted near PCB top, axis along Y. 2.0 mm pitch.
const pcbTop = pcbTopY != null ? pcbTopY : -0.7;
const headerCands = cylAxes
  .filter((c) => c.r > 0.15 && c.r < 0.6)
  .filter((c) => c.axis && Math.abs(c.axis[1]) > 0.9)
  .filter((c) => Math.abs(c.y - pcbTop) < 0.5)
  .map((c) => ({ x: c.x, z: c.z, r: c.r }));
const dedup = new Map();
for (const c of headerCands) {
  const k = `${Math.round(c.x * 10) / 10}|${Math.round(c.z * 10) / 10}`;
  if (!dedup.has(k)) dedup.set(k, c);
}
summary.headerPinAtPcbTop = [...dedup.values()].sort((a, b) => a.x - b.x || a.z - b.z);

// Also: dump every CARTESIAN_POINT at y ≈ PCB top with x > 5 (right side of
// board where pins should be). These trace the pads / pin tops.
const rightSidePoints = [];
for (const [, e] of entities) {
  if (e.type !== 'CARTESIAN_POINT') continue;
  const pm = e.args.match(/\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\)/);
  if (!pm) continue;
  const x = parseFloat(pm[1]), y = parseFloat(pm[2]), z = parseFloat(pm[3]);
  if (Math.abs(y - pcbTop) > 0.6) continue;
  if (x < 5) continue;
  rightSidePoints.push([+x.toFixed(2), +z.toFixed(2)]);
}
const seenRsp = new Set();
const rsp = [];
for (const p of rightSidePoints) {
  const k = `${p[0]}|${p[1]}`;
  if (seenRsp.has(k)) continue;
  seenRsp.add(k);
  rsp.push(p);
}
rsp.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
summary.rightSideTopFacePoints = rsp;

// Largest-radius cluster: lens barrel
const big = radiiSorted.filter((r) => r > 5);
summary.lensCandidates = big.map((r) => ({
  radius: r,
  count: bucket.get(r).length,
  sampleCenter: bucket.get(r)[0],
}));

console.log(JSON.stringify(summary, null, 2));
