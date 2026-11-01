import type { CaseFace, Project, Vec2, Vec3 } from '@/types';
import { faceFrame } from '@/engine/coords';
import { translate, type BuildOp } from './buildPlan';
import {
  clashesWith,
  describeOverlap,
  feature,
  footprintShape,
  rectFootprint,
  shapeOfOp,
  type ClashFeature,
  type ClashHit,
  type ClashKind,
  type ClashMethod,
} from './interiorClash';
import { FACE_NAME, pocketBossOp, pocketCutter, type MagnetFacts, type ResolvedPocket } from './magnets';
import { caseDividerFacts, type DividerBand, type DividerRect } from './caseDividers';

/**
 * The compiler's shared clash pass for the three features that sit among the
 * case's others: magnet pockets (and the bosses behind them), the floor grid's
 * dividers, and — through `stackConnector.ts`, which takes the same features
 * as keep-outs — the stacking connector's sockets.
 *
 * Every check goes through `interiorClash.ts`, on the real solids. Every clash
 * is a statement with an offer to move (or, for a divider no line clears, to
 * shorten); nothing here changes what is built or stops an export.
 */

export type ClashOffer =
  /** Move a magnet row (its `MagnetPocket.id`) or the nameplate (`nameplate`) to (u, v), mm. */
  | { kind: 'move-magnet'; source: string; u: number; v: number }
  /** Move a divider to another grid line (0-based). */
  | { kind: 'move-divider'; id: string; line: number }
  /** Shorten a divider to this span of sockets (0-based start). */
  | { kind: 'shorten-divider'; id: string; start: number; holes: number };

export interface ClashStatement {
  subject: 'magnet' | 'divider';
  /** The `MagnetPocket.id` (or `nameplate`), or the divider's id. */
  subjectId: string;
  against: ClashKind;
  message: string;
  method: ClashMethod;
  overlap: { size: Vec3; centre: Vec3 };
  offer?: ClashOffer;
}

export interface ClashReport {
  statements: ClashStatement[];
}

const r1 = (v: number): string => `${Math.round(v * 10) / 10 || 0}`;

function overlapOf(h: ClashHit): ClashStatement['overlap'] {
  return {
    size: h.size.map((v) => Math.round(v * 100) / 100) as Vec3,
    centre: h.centre.map((v) => Math.round(v * 100) / 100) as Vec3,
  };
}

/**
 * A lazily built set of the case's features, by kind. A kind is only turned
 * into clash shapes the first time a check asks for it, so a case with magnets
 * but no dividers never pays for its vents.
 */
export class ClashEnv {
  private readonly defs: { kind: ClashKind; make: () => ClashFeature[] }[] = [];
  private readonly built = new Map<ClashKind, ClashFeature[]>();

  /** One feature per op list; skipped when the list is empty. */
  add(kind: ClashKind, id: string, label: string, ops: () => BuildOp[]): this {
    this.defs.push({
      kind,
      make: () => {
        const list = ops();
        return list.length > 0 ? [feature(id, kind, label, list.map((op) => shapeOfOp(op)))] : [];
      },
    });
    return this;
  }

  /** Any number of ready-made features of one kind. */
  addFeatures(kind: ClashKind, make: () => ClashFeature[]): this {
    this.defs.push({ kind, make });
    return this;
  }

  of(...kinds: ClashKind[]): ClashFeature[] {
    const out: ClashFeature[] = [];
    for (const k of kinds) {
      let list = this.built.get(k);
      if (!list) {
        list = this.defs.filter((d) => d.kind === k).flatMap((d) => d.make());
        this.built.set(k, list);
      }
      out.push(...list);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Magnets
// ---------------------------------------------------------------------------

/** How far a move offer looks along the face, mm. */
export const MAGNET_MOVE_REACH = 40;

/** The order a move offer tries offsets in: along u, then along v, then both. */
function moveCandidates(): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 1; i <= MAGNET_MOVE_REACH; i++) out.push([i, 0], [-i, 0]);
  for (let i = 1; i <= MAGNET_MOVE_REACH; i++) out.push([0, i], [0, -i]);
  const diag: Vec2[] = [];
  for (let a = -MAGNET_MOVE_REACH; a <= MAGNET_MOVE_REACH; a += 4)
    for (let b = -MAGNET_MOVE_REACH; b <= MAGNET_MOVE_REACH; b += 4) if (a !== 0 && b !== 0) diag.push([a, b]);
  diag.sort((p, q) => Math.hypot(...p) - Math.hypot(...q));
  return out.concat(diag);
}
const CANDIDATES = moveCandidates();
const offerMemo = new Map<string, { kind: 'move-magnet'; du: number; dv: number } | null>();

export interface MagnetClashInput {
  facts: MagnetFacts;
  /** Lid-local → world Z lift. */
  lidZ: number;
  /** A face's (u, v) extent, mm. */
  faceExtent: (face: CaseFace) => [number, number];
  /** The row origin each group moves from: `MagnetPocket` (u, v), or the nameplate's centre. */
  origin: (source: string) => Vec2 | null;
  /** What a side-wall or floor boss must clear. */
  shellEnv: ClashFeature[];
  /** What a lid boss must clear. */
  lidEnv: ClashFeature[];
  /** Port cutters, tested against the pocket itself (a port cut through a boss still leaves the magnet held). */
  ports: ClashFeature[];
}

function pocketOps(p: ResolvedPocket, lidZ: number, delta: Vec3): { boss: BuildOp | null; pocket: BuildOp } {
  const lift: Vec3 = p.face === '+z' ? [delta[0], delta[1], delta[2] + lidZ] : delta;
  const move = (op: BuildOp): BuildOp =>
    lift[0] === 0 && lift[1] === 0 && lift[2] === 0 ? op : translate(lift, op);
  const boss = pocketBossOp(p);
  return { boss: boss ? move(boss) : null, pocket: move(pocketCutter(p)) };
}

interface PocketHit {
  part: 'boss' | 'pocket';
  with: ClashFeature;
  hit: ClashHit;
}

function pocketHits(p: ResolvedPocket, input: MagnetClashInput, delta: Vec3): PocketHit[] {
  const { boss, pocket } = pocketOps(p, input.lidZ, delta);
  const transient = delta[0] !== 0 || delta[1] !== 0 || delta[2] !== 0;
  const env = p.face === '+z' ? input.lidEnv : input.shellEnv;
  const out: PocketHit[] = [];
  if (boss) {
    const f = feature('magnet-boss', 'magnet', 'a magnet boss', [shapeOfOp(boss, { transient })]);
    for (const c of clashesWith(f, env)) out.push({ part: 'boss', ...c });
  }
  const pf = feature('magnet-pocket', 'magnet', 'a magnet pocket', [shapeOfOp(pocket, { transient })]);
  for (const c of clashesWith(pf, [...env, ...(p.face === '+z' ? [] : input.ports)])) {
    // A boss already stated against this feature says it; the pocket inside it adds nothing.
    if (!out.some((o) => o.with.id === c.with.id)) out.push({ part: 'pocket', ...c });
  }
  return out;
}

/**
 * Each magnet row (and the nameplate's pockets) against the case's other
 * features, with an offer to move the row to the nearest clear spot.
 */
export function magnetClashStatements(input: MagnetClashInput): ClashStatement[] {
  const groups = new Map<string, ResolvedPocket[]>();
  for (const p of input.facts.pockets) {
    const g = groups.get(p.sourceId) ?? [];
    g.push(p);
    groups.set(p.sourceId, g);
  }
  const out: ClashStatement[] = [];
  for (const [source, pockets] of groups) {
    const hits = new Map<string, { p: ResolvedPocket; h: PocketHit }>();
    for (const p of pockets) for (const h of pocketHits(p, input, [0, 0, 0])) if (!hits.has(h.with.id)) hits.set(h.with.id, { p, h });
    if (hits.size === 0) continue;

    const face = pockets[0]!.face;
    const frame = faceFrame(face, 0, 0, 0);
    const [fw, fh] = input.faceExtent(face);
    const origin = input.origin(source);
    let offer: Extract<ClashOffer, { kind: 'move-magnet' }> | undefined;
    // The search is the costly part of a clash, and a slider elsewhere does
    // not change its answer: memoize it on the pockets and what they face.
    const env = pockets[0]!.face === '+z' ? input.lidEnv : [...input.shellEnv, ...input.ports];
    const memoKey =
      pockets.map((p) => `${p.u},${p.v},${p.diameter},${p.depth},${p.skin},${p.boss?.length ?? 0},${p.boss?.diameter ?? 0}`).join(';') +
      `|${fw},${fh},${input.lidZ}|` +
      env.map((f) => f.shapes.map((x) => x.key).join(',')).join('/');
    const memo = offerMemo.get(memoKey);
    if (memo !== undefined) {
      offer = memo === null || !origin ? undefined : { ...memo, source, u: origin[0] + memo.du, v: origin[1] + memo.dv };
    } else if (origin) {
      for (const [du, dv] of CANDIDATES) {
        const onFace = pockets.every((p) => {
          const r = p.diameter / 2;
          return p.u + du - r >= 0 && p.v + dv - r >= 0 && p.u + du + r <= fw && p.v + dv + r <= fh;
        });
        if (!onFace) continue;
        const delta: Vec3 = [
          frame.uAxis[0] * du + frame.vAxis[0] * dv,
          frame.uAxis[1] * du + frame.vAxis[1] * dv,
          frame.uAxis[2] * du + frame.vAxis[2] * dv,
        ];
        if (pockets.every((p) => pocketHits(p, input, delta).length === 0)) {
          offer = { kind: 'move-magnet', source, u: Math.round((origin[0] + du) * 100) / 100, v: Math.round((origin[1] + dv) * 100) / 100 };
          break;
        }
      }
      if (offerMemo.size > 64) offerMemo.clear();
      offerMemo.set(memoKey, offer ? { kind: 'move-magnet', du: offer.u - origin[0], dv: offer.v - origin[1] } : null);
    }
    const what = source === 'nameplate' ? 'nameplate' : pockets.length > 1 ? 'row' : 'pocket';
    const offerText = offer
      ? ` Moving the ${what} to u ${r1(offer.u)} mm, v ${r1(offer.v)} mm clears it.`
      : ` No spot within ${MAGNET_MOVE_REACH} mm along the face clears it; it is cut as placed.`;
    for (const { p, h } of hits.values()) {
      const where = FACE_NAME[p.face];
      const plate = source === 'nameplate';
      const who =
        h.part === 'boss'
          ? `The boss behind ${plate ? 'a nameplate magnet' : 'a magnet pocket'} on the ${where} face`
          : `${plate ? 'A nameplate pocket' : 'A magnet pocket'} on the ${where} face`;
      const through = h.with.kind === 'port' ? ', which is cut through it' : '';
      out.push({
        subject: 'magnet',
        subjectId: source,
        against: h.with.kind,
        message: `${who} runs into ${h.with.label}${through} (they overlap ${describeOverlap(h.hit)}).${offerText}`,
        method: h.hit.method,
        overlap: overlapOf(h.hit),
        ...(offer ? { offer } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dividers
// ---------------------------------------------------------------------------

function dividerFeature(rect: DividerRect, band: DividerBand): ClashFeature {
  return feature('divider', 'divider', 'a divider', [
    rectFootprint(rect.x0, rect.y0, rect.x1, rect.y1, band.floorZ - band.depth, band.floorZ + band.height),
  ]);
}

/**
 * Each divider against the lid's lip, the vents, HAT boards beyond the host's
 * outline and the split-for-print seam. The offer is the nearest grid line
 * that clears this and every other clash, or else the fewest sockets to drop.
 */
export function dividerClashStatements(project: Project, env: ClashFeature[]): ClashStatement[] {
  if (env.length === 0) return [];
  const extraClash = (rect: DividerRect, _d: unknown, band: DividerBand): string[] =>
    clashesWith(dividerFeature(rect, band), env).map((c) => `it runs into ${c.with.label}`);
  const facts = caseDividerFacts(project, { extraClash });
  if (!facts.enabled) return [];
  const band: DividerBand = { floorZ: facts.floorZ, depth: facts.depth, height: facts.dividerHeight };
  const out: ClashStatement[] = [];
  for (const f of facts.dividers) {
    if (!f.builds || f.rect.x1 <= f.rect.x0) continue;
    const found = clashesWith(dividerFeature(f.rect, band), env);
    if (found.length === 0) continue;
    const d = (project.case.dividers ?? []).find((x) => x.id === f.id);
    const lineWord = d?.axis === 'x' ? 'row' : 'column';
    let offer: ClashOffer | undefined;
    let offerText = ' No grid line or shorter span clears it; it is built as placed.';
    if (f.moveTo !== null) {
      offer = { kind: 'move-divider', id: f.id, line: f.moveTo };
      offerText = ` Moving it to ${lineWord} ${f.moveTo + 1} clears it.`;
    } else if (f.shortenTo) {
      offer = { kind: 'shorten-divider', id: f.id, ...f.shortenTo };
      offerText = ` Shortening it to ${f.shortenTo.holes} sockets, from socket ${f.shortenTo.start + 1}, clears it.`;
    }
    for (const c of found) {
      out.push({
        subject: 'divider',
        subjectId: f.id,
        against: c.with.kind,
        message: `${f.label}: it runs into ${c.with.label} (they overlap ${describeOverlap(c.hit)}).${offerText}`,
        method: c.hit.method,
        overlap: overlapOf(c.hit),
        ...(offer ? { offer } : {}),
      });
    }
  }
  return out;
}

/**
 * A HAT board's footprint beyond the host board's outline, as up to four
 * convex rectangles: the part over the host is the board's own clash.
 */
export function hatBeyondHost(
  hat: { x0: number; y0: number; x1: number; y1: number },
  host: { x0: number; y0: number; x1: number; y1: number },
  z0: number,
  z1: number,
): ClashFeature['shapes'] {
  const pieces: Vec2[][] = [];
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    if (x1 - x0 > 1e-6 && y1 - y0 > 1e-6)
      pieces.push([
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ]);
  };
  const ix0 = Math.max(hat.x0, host.x0);
  const ix1 = Math.min(hat.x1, host.x1);
  const iy0 = Math.max(hat.y0, host.y0);
  const iy1 = Math.min(hat.y1, host.y1);
  if (ix1 <= ix0 || iy1 <= iy0) rect(hat.x0, hat.y0, hat.x1, hat.y1);
  else {
    rect(hat.x0, hat.y0, ix0, hat.y1);
    rect(ix1, hat.y0, hat.x1, hat.y1);
    rect(ix0, hat.y0, ix1, iy0);
    rect(ix0, iy1, ix1, hat.y1);
  }
  return pieces.length > 0 ? [footprintShape(pieces, z0, z1)] : [];
}
