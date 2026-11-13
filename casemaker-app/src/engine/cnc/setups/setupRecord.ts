/**
 * #1246 stage 2, slice 1 — THE SETUP RECORD.
 *
 * The design (`docs/design/planner-v3.md` §4A.8) asks for every pose to be described ONCE, and
 * for the planner, the verifier, the simulation, the goal check and the run sheet to read that
 * one description. Stage 1 (`#1246`'s inventory) showed each consumer deriving its own; this is
 * the first slice: the record's shape, one builder, and the verifier's context built through it.
 *
 * WHAT A FIELD MEANS. One field per fact of the inventory's Table 1. A fact this slice does not
 * yet move is `null`, and its comment names the slice that fills it — so the next slice has to
 * change this file on purpose rather than wander in. `verifierSetup` is the one consumer binding
 * this slice could not take: building the verifier's `Setup` body from {@link SetupRecord.stock}
 * was stopped (#1247) because the body's work origin and machine placement reach a verdict
 * (`verify.ts:602` → `emulator/timeline.ts:248/254`; `setup.ts:259-263, 285-291`). It is `null`
 * and `verifyContextFrom` takes today's body from its caller.
 *
 * WHAT THE BUILDER DERIVES. Fact 1 from `stockForSetup` (the setup's stated box, else the job's
 * blank) and the shape from the caller's `Setup.part`; fact 3 from that stock; fact 4 from the
 * job's sacrificial model; fact 5 from the caller's mount; fact 6 from `jobDepthLimit` when the
 * caller states no limit of its own (the through kerf widens it, #943, and the thickness is the
 * setup's own, #1082); fact 7 from `setupFootprint` unless the caller states another region;
 * fact 10 from the caller's already-built `RotaryMap`. Facts 2/8/9 (slice 2), 11 (slice 4) and
 * 12 (slice 5) are `null`.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. It does not change `toSetup`: every caller still
 * passes `undefined` for the setup stock, so the body — and with it every verdict — is exactly
 * what it was (#1247 owns the change). It states no fact the inventory did not name; the one
 * field beyond them, `verifierSetup`, is the deferred consumer binding #1247 fills.
 */

import { aabbOfProfile } from '@/engine/compiler/profile';
import { jobDepthLimit } from '@/engine/cnc/engrave/partPlan';
import { buildThroughMask } from '@/engine/cnc/engrave/throughMask';
import { setupFootprint, type FootprintShape } from '@/engine/cnc/footprint';
import { sacrificialBoxes } from '@/engine/cnc/sacrificial';
import { stockForSetup } from '@/engine/cnc/setups/perSetupStock';
import type { OpOutcome } from '@/engine/cnc/cam/model/plan';
import type { Mill } from '@/engine/cnc/machine';
import type { MountObstacles } from '@/engine/cnc/mounts/bracket';
import type { RotaryMap } from '@/engine/cnc/rotary/wrap';
import type { Setup } from '@/engine/cnc/setup';
import type { Tool } from '@/engine/cnc/tool';
import type { DepthLimit, VerifyContext } from '@/engine/cnc/verify';
import type { EngraveJob } from '@/types/engraveJob';
import type { SetupFrame } from '@/engine/cnc/cam/model/features';

/** The twelve facts of a setup, as the verifier's side can state them today. */
export interface SetupRecord {
  /** The 0-based setup index, the same index `job.setups` and `stockForSetup` use. */
  index: number;
  /**
   * Fact 1 — THIS setup's stock. The box is `stockForSetup`'s (the setup's stated box, else the
   * job's blank); the shape is the caller's `Setup.part`, which is a cylinder exactly when the
   * job is rotary. The numbers state the fact even where a consumer has not caught up — the
   * verifier's `Setup` body is still the job blank until #1247.
   */
  stock: { kind: 'box'; length: number; width: number; thickness: number } | { kind: 'rod'; diameter: number; length: number };
  /**
   * Fact 2 — the planner's own `SetupFrame` for this setup, stated as itself (no second shape).
   * Slice 2 fills it from the frame the plan input builds; null when the caller has none (a
   * restored run has no plan to state one).
   */
  frame: SetupFrame | null;
  /**
   * Fact 3 — the stock's top and bottom in the setup frame. A flat job's Z0 is the stock top, so
   * the top is 0 and the bottom is minus the stock's thickness; a rod's Z0 is the axis, so its
   * surface is the radius above it and the bottom the radius below.
   */
  heights: { stockTop: number; stockBottom: number };
  /**
   * Fact 4 — the sacrificial pieces as extents, not only as a depth function. The job's
   * sacrificial material belongs to the job's blank, so a setup that states its own box states no
   * job sacrificial material (the same rule `setupFootprint` applies).
   */
  sacrificial: { underThicknessMm: number | null; sides: readonly FootprintShape[] };
  /** Fact 5 — the mount's obstacles as the verifier takes them, or absent when none is modelled. */
  holds: VerifyContext['mountObstacles'];
  /** Fact 6 — the deepest cut permitted at (x, y), positive. */
  depthLimit: DepthLimit;
  /** Fact 7 (#1235) — the region a cut may travel over, or absent when the caller states none. */
  footprint: readonly FootprintShape[] | undefined;
  /** Fact 8 (#1234) — slice 2; null until then. */
  openEdges: null;
  /** Fact 9 — the outline-is-stock decision and the freeing contour; slice 2; null until then. */
  outline: null;
  /** Fact 10 — the rotary frame when this setup is a rod, exactly as the caller states it today. */
  rotary: VerifyContext['rotary'];
  /** Fact 11 — slice 4 fills it from the registration/probing session; null until then. */
  datum: null;
  /** Fact 12 — slice 5 fills it from the stock as it now stands (#1221's `Stock`); null until then. */
  priorCuts: null;
  /**
   * The verifier's `Setup` body built from {@link stock}. NULL IN THIS SLICE: #1247 owns the
   * change — the body's work origin and machine placement feed the runner's `outside-envelope`
   * verdict, so building it from the setup's own stock is a verdict change, not a fact move.
   * Until it lands, `verifyContextFrom` takes today's caller-built body (`perProgram.setup`).
   */
  verifierSetup: null;
}

/**
 * What the builder takes from the caller's surroundings. The exact members are the union of what
 * the consolidated call sites needed; each site passes only what it uses today.
 */
export interface SetupRecordDeps {
  /** Today's `toSetup` result. Its `part.kind` names the stock's shape; the body is NOT consumed. */
  setup: Setup;
  /** The mount the program is swept against, when one is modelled. */
  mount?: MountObstacles | null;
  /** The fixture clearance the mount's boxes are grown by (`VerifyContext.mountObstacles.clearance`). */
  clearanceMm?: number;
  /** The fitted top's lift (#727), when the site states one. */
  topLiftMm?: number;
  /** This setup's through-cut kerfs (#943), when the plan states any. */
  throughKerf?: readonly NonNullable<OpOutcome['throughKerf']>[];
  /** The boundary margin the job's depth limit is composed with (#345); absent where the site passes none. */
  boundaryMarginMm?: number;
  /** A depth limit that is not `jobDepthLimit`'s composition (a dry run, a restart, a stated limit). */
  depthLimit?: DepthLimit;
  /**
   * This program's footprint. OMITTED = `setupFootprint(job, index)`; `null` = the site states no
   * footprint (the rotary face paths); an array = exactly those shapes (a job-wide or restart
   * footprint).
   */
  footprint?: readonly FootprintShape[] | null;
  /** The rotary map the site already built, when its context states the rotary frame. */
  rotary?: RotaryMap | null;
  /** The planner's own `SetupFrame` for this setup (slice 2), stated on the record as itself. */
  frame?: SetupFrame;
  /**
   * The stock's box when the caller has NO `EngraveJob` — REQUIRED there (the builder throws
   * without it): a restart states the blank it cuts, and a dry run states the box its `Setup`
   * describes (`stockFromSetupPart`). Ignored when a job is given (there `stockForSetup` is the
   * fact).
   */
  stock?: { length: number; width: number; thickness: number };
}

/**
 * What genuinely differs per program: the fields the record does not own. `setup` is today's
 * caller-built body (see {@link SetupRecord.verifierSetup}); `dialect` is omitted where the site
 * omitted it, so the verifier's Z1 default applies.
 */
export interface VerifyPerProgram {
  setup: Setup;
  machine: Mill;
  tool: Tool;
  minRapidZ: number;
  dialect?: VerifyContext['dialect'];
  outsideAllowancesMm?: ReadonlyMap<number, number>;
  itemProgram?: boolean;
  limitReasonAt?: (x: number, y: number) => string;
}

/**
 * The box a `Setup`'s own part states, for a job-less caller that has no stock document — the
 * same derivation `stockFromSetup` makes for a restart. Exported so the caller can STATE it in
 * `deps.stock`; the builder itself requires the stated box (see `setupRecordFor`).
 */
export function stockFromSetupPart(setup: Setup): { length: number; width: number; thickness: number } | null {
  const part = setup.part;
  if (part.kind === 'cylinder') return { length: part.length, width: part.diameter, thickness: part.diameter };
  if (part.kind !== 'prism') return null;
  const box = aabbOfProfile(part.outline);
  return box === null ? null : { length: box.max[0] - box.min[0], width: box.max[1] - box.min[1], thickness: part.thickness };
}

/**
 * The one builder: a setup's twelve facts, from the job and the caller's surroundings.
 *
 * `job` is null for the two verifier paths that have no job document (the dry run and the restart).
 * A job-less call MUST state the stock AND the depth limit: the builder throws rather than derive
 * either from a document that does not exist. (`stockFromSetupPart` is the helper a caller uses to
 * state the box its own `Setup` describes.) The sacrificial model is then empty.
 */
export function setupRecordFor(job: EngraveJob | null, setupIndex: number, deps: SetupRecordDeps): SetupRecord {
  const own = job === null ? deps.stock : stockForSetup(job, setupIndex);
  if (own === undefined || own === null) {
    throw new Error('setupRecordFor needs deps.stock for a job-less call');
  }
  const part = deps.setup.part;
  const stock: SetupRecord['stock'] =
    part.kind === 'cylinder'
      ? { kind: 'rod', diameter: part.diameter, length: part.length }
      : { kind: 'box', length: own.length, width: own.width, thickness: own.thickness };
  const heights: SetupRecord['heights'] =
    stock.kind === 'rod'
      ? { stockTop: stock.diameter / 2, stockBottom: -stock.diameter / 2 }
      : { stockTop: 0, stockBottom: -stock.thickness };

  // Fact 4 — a stated setup box does not inherit the job blank's sacrificial material (the same
  // rule `setupFootprint` states). Otherwise the side strips are the job's own boxes, as extents.
  const stated = job !== null && job.setups?.[setupIndex]?.stock !== undefined;
  const sideBoxes = job === null || stated || job.sacrificial === undefined ? [] : sacrificialBoxes(job.stock, job.sacrificial).filter((b) => b.id !== 'under');
  const sacrificial: SetupRecord['sacrificial'] = {
    underThicknessMm: job === null || stated ? null : (job.sacrificial?.under?.thickness ?? null),
    sides: sideBoxes.map((b) => ({
      kind: 'rect',
      x: b.min[0],
      y: b.min[1],
      length: b.max[0] - b.min[0],
      width: b.max[1] - b.min[1],
    })),
  };

  // Fact 5 — the same shape `mountCtx` builds at the call sites.
  const holds: VerifyContext['mountObstacles'] =
    deps.mount === undefined || deps.mount === null
      ? undefined
      : {
          obstacles: deps.mount.obstacles,
          uncertainty: deps.mount.uncertainty,
          clearance: deps.clearanceMm ?? 0,
          topLift: deps.topLiftMm ?? 0,
        };

  // Fact 6 — the site's own limit when it states one; else #1082/#943's composition, with the
  // through mask built from this setup's own kerfs and thickness. A job-less caller must state it:
  // there is no job whose sacrificial model or voids could compose one.
  let depthLimit: DepthLimit;
  if (deps.depthLimit !== undefined) {
    depthLimit = deps.depthLimit;
  } else if (job === null) {
    throw new Error('setupRecordFor needs deps.depthLimit for a job-less call');
  } else {
    const cutouts = deps.throughKerf ?? [];
    const mask = cutouts.length === 0 ? null : buildThroughMask({ thickness: own.thickness, breakthrough: job.breakthrough, cutouts: [...cutouts] });
    depthLimit =
      mask === null
        ? jobDepthLimit(job, deps.boundaryMarginMm, undefined, undefined, own.thickness)
        : jobDepthLimit(job, deps.boundaryMarginMm, mask, undefined, own.thickness);
  }

  // Fact 7 — the site's stated region, or the setup's own footprint; `null` states none.
  const footprint = deps.footprint === null ? undefined : (deps.footprint ?? (job === null ? undefined : setupFootprint(job, setupIndex)));

  // Fact 10 — only what the site's context states today; a flat site passes nothing.
  const rotary: VerifyContext['rotary'] =
    deps.rotary === undefined || deps.rotary === null
      ? undefined
      : {
          radius: deps.rotary.radius,
          stickout: deps.rotary.stickout,
          tailstock: deps.rotary.tailstock,
          limits: deps.rotary.limits,
        };

  return {
    index: setupIndex,
    stock,
    frame: deps.frame ?? null,
    heights,
    sacrificial,
    holds,
    depthLimit,
    footprint,
    openEdges: null,
    outline: null,
    rotary,
    datum: null,
    priorCuts: null,
    verifierSetup: null,
  };
}

/** The one context builder: the record's facts plus the genuinely per-program fields. */
export function verifyContextFrom(record: SetupRecord, perProgram: VerifyPerProgram): VerifyContext {
  return {
    ...(perProgram.dialect === undefined ? {} : { dialect: perProgram.dialect }),
    setup: perProgram.setup,
    machine: perProgram.machine,
    tool: perProgram.tool,
    depthLimit: record.depthLimit,
    minRapidZ: perProgram.minRapidZ,
    ...(record.footprint === undefined ? {} : { footprint: record.footprint }),
    ...(perProgram.outsideAllowancesMm === undefined ? {} : { outsideAllowancesMm: perProgram.outsideAllowancesMm }),
    ...(perProgram.itemProgram === undefined ? {} : { itemProgram: perProgram.itemProgram }),
    ...(perProgram.limitReasonAt === undefined ? {} : { limitReasonAt: perProgram.limitReasonAt }),
    ...(record.holds === undefined ? {} : { mountObstacles: record.holds }),
    ...(record.rotary === undefined ? {} : { rotary: record.rotary }),
  };
}
