/**
 * #970/#966 — THE STANDING REGRESSION GUARD, on the real elephant mesh, env-gated in the #965/#959
 * pattern (`CM_ELEPHANT_STL`, matching `figureAcceptance965.spec.ts` exactly — not a new env var).
 *
 * `figureAcceptance965.spec.ts` already asserts whole-surface coverage and the adjudicated
 * cut-into fraction (the goal-heightfield-based check). This spec is a DIFFERENT, more direct
 * question, stated by #970's own issue: does any posted TOP-SETUP feed point actually lie BELOW
 * the real design mesh's own highest surface at its own (x, y) — a straight collision check
 * against the mesh itself, not a heightfield comparison — and does it do so treating the tool's
 * SHANK as solid, not only the cutting tip (a real body collision check, the #966 finding's own
 * exact failure mode: the elephant's belly closing over the leg gap above the pocket's own floor).
 *
 * THE CHECK, precisely: for every `feed` move `(x, y, z)` of every program in a TOP setup
 * (`frame.up = [0, 0, 1]`), each collision-relevant part of the tool's body (`bodyParts` below:
 * a flat's one tip-height cylinder; a ball's own round tip PLUS its shank, whose bottom plane is
 * the ball's CENTRE, one radius above the tip — #1092) must sit at or above the design mesh's own
 * highest point within that part's radius. A part is a finding when its low point is more than
 * `MAX_PENETRATION_MM` below the mesh there; that threshold is measured and stated in its own
 * note, not guessed. This is the SAME `dropCutterHeight` (#957) ground truth
 * `rough()`/`oppositeSurfaceSafeDepthMm`/this branch's own pocket-shadow fix already read off this
 * mesh — not a second, divergent source.
 *
 * `planModelCam`'s own toolpath IR is checked directly (not the posted G-code text): the IR's
 * moves ARE exactly what `postZ1` turns into feed lines, one to one, so this is the same check as
 * reading the posted file, without a G-code round trip. A TOP setup only (#970's own stated scope)
 * — a flip setup's own "world" position needs `mapIRToDocument`'s inverse to re-express a move's Z
 * against the ORIGINAL mesh frame, which this spec does not attempt; every setup this engine plans
 * for the figures today is a single top setup, so the scope is not a real limitation yet, only
 * stated rather than silently assumed.
 *
 * SCOPE (#1092). This PER-BRANCH guard plans with the card's picked ten cutters (`CARD_CUTTERS`)
 * and covers the FLAT-ROUGHING class only, threshold 0.7 mm — just above the measured 0.603 mm
 * ceiling at 7a7bac78c. It does NOT see the rest-pass class (the card's 24.747 mm over-cut): the
 * rest is cut by the app's multi-stage route (engrave/restPass.ts's `restJobFor` over the first
 * program's own remainder), which a single `planModelCam` call never reaches — not with the picked
 * cutters and not with the job's full 134-cutter inventory (both measured, both pass). That class
 * is guarded by ~/casemaker-manager/nightly-j29.sh, which runs the j29 CARD and asserts its goal
 * check. Do not read a pass here as covering it.
 *
 * WITHOUT `CM_ELEPHANT_STL` this SKIPS CLEANLY (one `it` stating why), the same pattern every other
 * figure-gated spec in this suite uses — this repo holds no figure meshes. Session E or F runs it
 * for real once this branch is merged.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseStl, type ParsedMesh } from '@/engine/import/stlParser';
import { placeTarget } from '@/engine/cnc/engrave/targetPlace';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { jobVise, viseEnvelope } from '@/engine/cnc/fixture';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { dropCutterHeight, profileOf, type CutterProfile, type DropCutterMesh } from '@/engine/cnc/cam/model/dropcutter';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const REPO = join(APP, '..');
const JOBS = join(REPO, 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');
const JOB_FILE = 'j29-elephant-stick.json';
const ENV = 'CM_ELEPHANT_STL';

/**
 * #1092 — THE PER-BRANCH INVENTORY: the ten cutters the j29 card's programs name (their
 * `;@MKR|TOOL` headers at 5d41e1c8a). It is a DETERMINISTIC, fast set that covers the
 * flat-roughing class; it does NOT reproduce the card's chain — the chain's picks are its OUTPUT,
 * and re-feeding them re-plans the sequence (the rest is no longer the ⌀3.175 flat's), which is
 * why the rest-pass class is the nightly j29 card's job (`nightly-j29.sh`), not this check's.
 * Geometry is the record's own: tip, shank, shoulder (the shank-collision limit) and, for the
 * chamfer, its included angle.
 */
function cardTool(o: {
  number: number;
  id: string;
  name: string;
  typeText: string;
  shape: Tool['shape'];
  cuttingMm: number;
  /** `tipdiameter` when the record's tip differs from its body (the chamfer's 0.1 mm point). */
  tipMm?: number;
  handleMm: number;
  /** `shoulderlength` from the record; null where Makera leaves it empty (the chamfer). */
  shoulderMm: number | null;
  angleDeg?: number;
}): Tool {
  return {
    ...flatEndMill(o.cuttingMm, { number: o.number, id: o.id, name: o.name }),
    ...(o.tipMm === undefined ? {} : { tipDiameter: o.tipMm }),
    typeText: o.typeText,
    shape: o.shape,
    handleDiameter: o.handleMm,
    fluteLength: o.shoulderMm,
    shoulderLength: o.shoulderMm,
    ...(o.angleDeg === undefined ? {} : { angle: o.angleDeg }),
  };
}

const CARD_CUTTERS: Tool[] = [
  cardTool({ number: 1, id: 'lib-111031606032', name: '6*32mm Flat End', typeText: 'Flat End', shape: 'flat', cuttingMm: 6, handleMm: 6, shoulderMm: 32 }),
  cardTool({ number: 2, id: 'lib-112121405017', name: '4*17mm Flat End(Metal)', typeText: 'Flat End', shape: 'flat', cuttingMm: 4, handleMm: 4, shoulderMm: 17 }),
  cardTool({ number: 3, id: 'lib-111011313832', name: '3.175*32mm Flat End', typeText: 'Flat End', shape: 'flat', cuttingMm: 3.175, handleMm: 3.175, shoulderMm: 32 }),
  cardTool({ number: 4, id: 'lib-111031605022', name: '6*22mm Flat End', typeText: 'Flat End', shape: 'flat', cuttingMm: 6, handleMm: 6, shoulderMm: 22 }),
  cardTool({ number: 5, id: 'lib-161032055031', name: '6*0.5*30.5mm Ball Nose Engraving', typeText: 'Ball Nose Engraving', shape: 'ball', cuttingMm: 0.5, handleMm: 6, shoulderMm: 30.5 }),
  cardTool({ number: 6, id: 'lib-131032605022', name: '6*22mm Ball Nose', typeText: 'Ball Nose', shape: 'ball', cuttingMm: 6, handleMm: 6, shoulderMm: 22 }),
  cardTool({ number: 7, id: 'lib-112131606030', name: '6*30mm Flat End(Metal)', typeText: 'Flat End', shape: 'flat', cuttingMm: 6, handleMm: 6, shoulderMm: 30 }),
  cardTool({ number: 8, id: 'lib-111031605525', name: '6*25mm Flat End', typeText: 'Flat End', shape: 'flat', cuttingMm: 6, handleMm: 6, shoulderMm: 25 }),
  cardTool({ number: 9, id: 'kz-chamfer-90', name: 'Chamfering Bit - 1/8" Shank 90°', typeText: 'Chamfer', shape: 'chamfer', cuttingMm: 3.175, tipMm: 0.1, handleMm: 3.175, shoulderMm: null, angleDeg: 90 }),
  cardTool({ number: 10, id: 'lib-111011313832-2', name: '3.175*32mm Flat End', typeText: 'Flat End', shape: 'flat', cuttingMm: 3.175, handleMm: 3.175, shoulderMm: 32 }),
];

/** The collection floor: the job's own finish tolerance (`tolerances.finishMm` below), i.e.
 * numerical slack, not a tuned number. Everything above it is gathered, then judged. */
const CL_TOLERANCE_MM = 0.01;

/**
 * #1092 — THE STATED PENETRATION THRESHOLD: the measured worst of the class this PER-BRANCH guard
 * covers, plus a margin. Measured at 7a7bac78c with the corrected body: 0.603 mm, the ⌀6 rough at
 * z −26.104 over a mesh at −25.501 (97 findings above the 0.01 mm floor, 3 above 0.5 mm). The
 * threshold is 0.7 mm — just above that measured ceiling, and far below any real body cut.
 *
 * WHAT THIS GUARD DOES NOT SEE: the rest-pass class (the 24.747 mm over-cut of the j29 card).
 * Re-feeding the card's picked cutters re-plans its chain, so the rest is no longer the ⌀3.175
 * flat's; that class is the NIGHTLY run's (CM_ELEPHANT_LOCATION, the job's own 134-cutter
 * inventory), which asserts it separately. Do not read a pass here as covering it.
 */
const MAX_PENETRATION_MM = 0.7;

function placedMesh(job: EngraveJob, bytes: Buffer): { mesh: ParsedMesh; source: { triangles: ParsedMesh } } {
  const local = parseStl(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const place = placeTarget(job.targetObject!, local).place;
  const positions = new Float32Array(local.positions.length);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < local.positions.length; i += 3) {
    const [x, y, z] = place(local.positions[i]!, local.positions[i + 1]!, local.positions[i + 2]!);
    positions[i] = x;
    positions[i + 1] = y;
    positions[i + 2] = z;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const mesh: ParsedMesh = {
    positions,
    indices: local.indices,
    triangleCount: local.triangleCount,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
  return { mesh, source: { triangles: mesh } };
}

function planInputFor(job: EngraveJob, source: { triangles: ParsedMesh }): ModelPlanInput {
  return {
    geometry: source,
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -job.stock.thickness }, underside: 'flatOnStockBottom' }],
    stock: {
      length: job.stock.length,
      width: job.stock.width,
      thickness: job.stock.thickness,
      material: job.stock.material,
    },
    fixture: { mount: job.workholding.kind === 'vise' ? 'vise' : 'tape', envelope: job.workholding.kind === 'vise' ? viseEnvelope(job.stock, jobVise(job), job.sacrificial) : null },
    cutters: { house: CARD_CUTTERS, catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
  };
}

/**
 * #1092 — ONE COLLISION-RELEVANT PART OF THE BODY: a drop-cutter profile whose own LOWEST point
 * sits `zOffsetMm` above the program's posted tip z (0 for a part whose tip IS the tool's tip).
 */
interface BodyPart {
  profile: CutterProfile;
  zOffsetMm: number;
  label: string;
}

/**
 * THE BODY, AS THE PARTS THAT CAN COLLIDE — each a drop-cutter profile standing at its own height
 * above the posted tip (#1092), in the tool's own order:
 *  - THE CUTTING SHAPE: `profileOf`'s own profile at the tip — a flat's cylinder, a ball's sphere,
 *    a V's cone. This is exact for all three; the old single-cylinder stand-in instead stood the
 *    handle's radius in AT THE TIP, which over-cut by the shank radius on every sloped move
 *    (110,486 findings over 1 mm on the elephant at 7a7bac78c, burying the real gouge), and it
 *    reported a 90° chamfer's own cone height (1.537 mm) as a collision.
 *  - A BALL'S NECK: the cutting radius from the ball's centre (`z + R`) up to the stated shoulder
 *    — what a ball nose is above its equator, wider than the sphere there.
 *  - THE SHANK: the handle's radius, its lowest point at the stated SHOULDER LENGTH, never lower
 *    (a ball with none stated falls back to its centre). A ball nose's shank starts at its
 *    shoulder — the job's own is "6*2*30.5": ⌀2 to 30.5 mm, only then ⌀6 — and standing it lower
 *    put that ⌀6 body on every steep wall.
 * `null` only when the cutter has no drop-cutter profile at all (`profileOf`'s own stated scope).
 */
function bodyParts(tool: Tool): BodyPart[] | null {
  const base = profileOf(tool);
  if (base === null) return null;
  const R = base.radiusMm;
  const shankRadius = tool.handleDiameter !== null && tool.handleDiameter > 0 ? tool.handleDiameter / 2 : 0;
  const shoulder = tool.shoulderLength ?? tool.fluteLength;
  const shoulderMm = shoulder !== null && shoulder > 0 ? shoulder : null;
  // (1) THE CUTTING SHAPE ITSELF, exactly `profileOf`'s own — a flat's cylinder, a ball's sphere,
  // a V's cone. Standing a V in as a flat of its outer radius at the tip reported the cone's own
  // height (1.537 mm on the 90° chamfer) as a collision, a pure model artefact.
  const parts: BodyPart[] = [{ profile: base, zOffsetMm: 0, label: tool.shape === 'ball' ? 'ball' : 'cutting' }];
  // (2) A BALL'S NECK: the cutting diameter continues as a cylinder from the ball's centre up to
  // the shoulder — wider than the sphere above its equator.
  if (tool.shape === 'ball' && shoulderMm !== null && shoulderMm > R + 1e-9) {
    const neck: CutterProfile = { radiusMm: R, flatRadiusMm: R, kind: 'flat' };
    parts.push({ profile: neck, zOffsetMm: R, label: 'neck' });
  }
  // (3) THE SHANK, only when the handle is wider than the cutting shape, and never lower than the
  // stated shoulder. With no shoulder stated a ball's shank starts at its centre (the
  // conservative floor); any other shape starts at its cutting shape's own top (a V's cone
  // height), which is exact for a cone and the stated fallback for a flat.
  if (shankRadius > R + 1e-9) {
    const coneHeightMm = base.kind === 'cone' ? (R - base.flatRadiusMm) / (base.tanHalfAngle ?? 1) : 0;
    const startMm = shoulderMm ?? (tool.shape === 'ball' ? R : coneHeightMm);
    const shank: CutterProfile = { radiusMm: shankRadius, flatRadiusMm: shankRadius, kind: 'flat' };
    parts.push({ profile: shank, zOffsetMm: startMm, label: 'shank' });
  }
  return parts;
}

interface Collision {
  toolName: string;
  /** Which part of the body made the finding, and that part's own lowest point (stock-absolute). */
  part: string;
  partZ: number;
  x: number;
  y: number;
  /** The posted move's tip z, stock-absolute (what the IR says). */
  z: number;
  surfaceZ: number;
  penetrationMm: number;
}

/**
 * Every `feed` move of every posted program where one of the tool body's own parts reaches BELOW
 * the mesh's real surface at that (x, y), beyond `marginMm`. A move yields at most ONE finding —
 * its deepest part (a ball's shank and its ball cannot both be the worst at the same point, and
 * reporting the same move twice would double-count it). `stockTopZ` converts a move's own
 * stock-top-relative `z` (every `planModelCam` program's own convention, `plan.ts`'s header note)
 * to the mesh's absolute frame `dropCutterHeight` reads.
 */
function shankCollisions(
  programs: readonly { toolKey: string; ir: ToolpathIR }[],
  mesh: DropCutterMesh,
  stockTopZ: number,
  marginMm: number,
): Collision[] {
  const bad: Collision[] = [];
  const partsCache = new Map<string, BodyPart[] | null>();
  for (const program of programs) {
    const tool = program.ir.tool;
    const cacheKey = program.toolKey;
    let parts = partsCache.get(cacheKey);
    if (parts === undefined) {
      parts = bodyParts(tool);
      partsCache.set(cacheKey, parts);
    }
    if (parts === null) continue; // stated by `profileOf`'s own scope, not silently skipped: no shape this check covers
    for (const operation of program.ir.operations) {
      for (const m of operation.moves) {
        if (m.kind !== 'feed') continue;
        const absZ = m.z + stockTopZ;
        let worst: Collision | null = null;
        for (const part of parts) {
          const surfaceZ = dropCutterHeight(part.profile, mesh, m.x, m.y);
          if (surfaceZ === null) continue; // nothing of the mesh within this part's reach here — open air, not a finding
          const partZ = absZ + part.zOffsetMm;
          const penetrationMm = surfaceZ - partZ;
          if (penetrationMm > marginMm && (worst === null || penetrationMm > worst.penetrationMm)) {
            worst = { toolName: tool.name || tool.shape, part: part.label, partZ, x: m.x, y: m.y, z: absZ, surfaceZ, penetrationMm };
          }
        }
        if (worst !== null) bad.push(worst);
      }
    }
  }
  return bad;
}

describe.skipIf(process.env[ENV] === undefined)(
  `#970/#966 the elephant — no top-setup body reaches below the real mesh (per-branch: the flat-roughing class; the rest-pass class is the nightly j29 card)${process.env[ENV] === undefined ? ` (set ${ENV})` : ''}`,
  () => {
  it(
    'every posted feed point, checked with the body’s own parts, stays at or above the real design surface',
    async () => {
      const stlPath = process.env[ENV]!;
      const jobPath = join(JOBS, JOB_FILE);
      expect(fs.existsSync(stlPath), `${ENV}: missing ${stlPath}`).toBe(true);
      expect(fs.existsSync(jobPath), `missing committed job ${jobPath}`).toBe(true);

      const bytes = fs.readFileSync(stlPath);
      const sha = createHash('sha256').update(bytes).digest('hex');
      const job = JSON.parse(fs.readFileSync(jobPath, 'utf8')) as EngraveJob;
      expect(sha, `${ENV}: the file is not the job's own mesh`).toBe((job.targetObject as EngraveTargetObject).sha256);

      const { mesh, source } = placedMesh(job, bytes);
      const input = planInputFor(job, source);
      const output = await planModelCam(input);
      expect(output.perSetup.length).toBeGreaterThanOrEqual(1);

      const findings: Collision[] = [];
      for (const setup of output.perSetup) {
        const [ux, uy, uz] = setup.features.frame.up;
        if (!(ux === 0 && uy === 0 && uz === 1)) continue; // #970's own stated scope: top setups only
        const programs = setup.programs.map((ir, i) => ({ toolKey: setup.sequence[i]?.cutterKey ?? ir.tool.name, ir }));
        // #1092 — A LOOP, NOT `push(...array)`: the elephant's own body model finds six figures of
        // clearance facts, and spreading them into `push` exceed V8's argument limit (RangeError,
        // no findings printed at all — the first run of this guard on the real mesh).
        for (const f of shankCollisions(programs, mesh, setup.features.frame.stockTop, CL_TOLERANCE_MM)) findings.push(f);
      }
      const worstFirst = [...findings].sort((a, b) => b.penetrationMm - a.penetrationMm);
      const deep = worstFirst.filter((f) => f.penetrationMm > MAX_PENETRATION_MM);
      const top = worstFirst.slice(0, 20);
      // #1092 — the penetration distribution this run measured (the threshold above is chosen
      // from it, and it stays in the log either way).
      console.log(
        `GUARD_BANDS ${[20, 10, 5, 1, 0.5, 0.3, 0.1, 0.01].map((t) => `>${t}:${worstFirst.filter((f) => f.penetrationMm > t).length}`).join(' ')}`,
      );
      expect(
        deep,
        `${deep.length} of ${findings.length} body-clearance finding(s) are more than ${MAX_PENETRATION_MM} mm into the design; worst 20 (of ${findings.length} above the ${CL_TOLERANCE_MM} mm collection floor):\n` +
          top
            .map(
              (f) =>
                `${f.toolName} ${f.part} at (x ${f.x.toFixed(2)}, y ${f.y.toFixed(2)}): its low point z ${f.partZ.toFixed(3)} is ` +
                `${f.penetrationMm.toFixed(3)} mm below the mesh there (${f.surfaceZ.toFixed(3)}; posted tip z ${f.z.toFixed(3)})`,
            )
            .join('\n'),
      ).toEqual([]);
    },
    // The elephant's own plan plus the per-move body check measured ~5.5 min on an idle 16-core
    // box and crossed 600 s under two concurrent suites (the check had finished; the timer had
    // not). 20 min is this spec's stated budget, matching the figure acceptance case's wall.
    1_200_000,
  );
});

describe.skipIf(process.env[ENV] !== undefined)('#970/#966 elephant shank-collision guard — not run', () => {
  it(`states why: needs ${ENV} (the local-only elephant mesh)`, () => {
    expect(process.env[ENV]).toBeUndefined();
  });
});
