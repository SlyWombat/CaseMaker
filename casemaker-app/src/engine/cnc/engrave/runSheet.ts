import type { RapidEstimate } from '@/engine/cnc/cam/ir';
import { aabbOfProfile } from '@/engine/compiler/profile';
import { jobTool, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import {
  idJawReach,
  keepOutLimit,
  keepOutLimitParts,
  keepOutMembrane,
  labelGlyphMeasure,
  labelJawReach,
  toPartPlan,
  voidLimitForItem,
  type JawReach,
  type PartPlan,
} from '@/engine/cnc/engrave/partPlan';
import {
  effectiveMargins,
  MARGIN_DEFAULTS,
  marginSourceWords,
  recommendLabelDepth,
  recommendMargins,
  splitBound,
  zBudgetInputsFor,
  type MarginSettings,
} from '@/engine/cnc/engrave/depthBounds';
import { cuttingDiameter } from '@/engine/cnc/tool';
import { axesWord, describeTouch, kindWord, readsWord, registrationFor, sideWords } from '@/engine/cnc/engrave/registration';
import {
  alongWord,
  inOutWord,
  planMaterialScan,
  surfaceWord,
  SCAN_COARSE_STEP_MM,
  SCAN_START_GAP_MM,
  type ScanTouch,
} from '@/engine/cnc/engrave/materialScan';
import type { FeedsResult } from '@/engine/cnc/feeds';
import { MATERIAL_LABELS } from '@/engine/cnc/materials';
import { VISE_BODY_DEPTH, viseEnvelope } from '@/engine/cnc/fixture';
import { hasSacrificial, stripHeight, viseJawShift } from '@/engine/cnc/sacrificial';
import { jobMachine } from '@/engine/cnc/calibration';
import type { InkMeasure } from '@/engine/cnc/engrave/inkBox';
import type { VerifyReport } from '@/engine/cnc/verify';
// #243 — the blind-spot sentence is the Simulate panel's OWN builder, imported rather than
// re-worded, so the sheet and the panel cannot disagree about what the sweep did not see.
import { coverageDisclaimer, type SimCoverageInput, type SimRunOutcome } from '@/components/panels/simCoverage';
import type { EngraveJob, EngraveMargins, ViseParams } from '@/types/engraveJob';
import type { Mm } from '@/types/units';

/**
 * The operator run sheet (#207): a printable, job-specific checklist for the person standing at
 * the machine. V1 does not talk to the machine (`/Fabrication.md` §9.1) — the file is uploaded
 * through Makera Studio and the work origin is set by hand — so everything the file ASSUMES about
 * the physical setup has to reach the operator on paper.
 *
 * This module is PURE DATA: `buildRunSheet` returns a plain `RunSheet` structure with no React,
 * no DOM and no wasm, so it is a function of the job plus what #206's `engraveGenerate` returned
 * plus the simulation's diagnostics. `RunSheetView.tsx` renders it; the SVG for the origin
 * diagram is generated here too (`runSheetDiagramSvg`) so the whole sheet is buildable and
 * testable without a browser.
 *
 * Three assumptions can ruin the part or the cutter if they are wrong, so the sheet states each
 * one plainly: where X0 Y0 Z0 is (the stock's top-front-left corner, Z0 on the top face), which
 * way round the blank goes (length in X between the jaws, fixed jaw on the left), and that the
 * machine does NOT know the cutter's length (`T1 M6` to the already-active tool does nothing —
 * `StartingTool`, `setup.ts`; the manual step is `M491`, `/Fabrication.md` §2).
 *
 * STEPS MARKED `unverified` ARE NOT CONFIRMED ON A REAL MACHINE. Three sections (mount the vise,
 * fit the cutter, set the origin) carry `unverified: '#208'`, and the view must render the tag —
 * an operator has to be able to tell a confirmed step from an assumed one (#207 "Do not hide the
 * ⚠ notes"). #208 removes the markers it confirms.
 */

// ---------------------------------------------------------------------------------------------
// The input half the sheet does not compute itself
// ---------------------------------------------------------------------------------------------

/**
 * The CAM summary #206 returns on `EngraveGenerated.cam`. Structural, so the real object is
 * assignable. `estimatedSeconds` is the CYCLE estimate — cutting PLUS rapids, a feed run timed as
 * one move and a rapid as its own, through the trapezoid on the job machine's rapid model
 * (#242, #281).
 */
export interface RunSheetCamSummary {
  operations: number;
  cuttingMoves: number;
  estimatedSeconds: number;
  passes: number;
}

/**
 * The half of #206's `EngraveGenerated` this sheet reads. It is deliberately a STRUCTURAL SUBSET:
 * the real `EngraveGenerated` also carries `ok` and `stage`, which the sheet does not need, and
 * an `EngraveGenerated` is assignable to this interface unchanged. Everything the sheet reports
 * about the cut comes from here, so the numbers on the sheet are the numbers in the file.
 */
export interface RunSheetGenerated {
  /** The app's full finding list for the job (#206 stage 1: `validateJob` + `validateVise` + the geometry findings, deduped). */
  findings: readonly JobFinding[];
  /** `feedsFor`'s result, or null when that stage was not reached. */
  feeds: FeedsResult | null;
  cam: RunSheetCamSummary | null;
  /** The exact text to be saved; the file name's hash and the file's existence come from it. */
  nc: string | null;
  verify: VerifyReport | null;
  /**
   * The frame program that will be saved BESIDE the job (#244), or null when the run never reached
   * it. §6 says which file to load for the dry run, so the sheet has to know whether that file
   * exists (#273) — the app only writes a frame it actually produced.
   */
  frameNc: string | null;
}

/**
 * The simulation diagnostic the sheet carries, structurally a `SimDiagnostic`
 * (`src/workers/sim/session.ts`). Only warnings reach the sheet.
 */
export interface RunSheetSimDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

/** What the sheet needs from a simulation run. A `SimLoadResult` (either variant) satisfies it. */
export interface RunSheetSim {
  diagnostics: readonly RunSheetSimDiagnostic[];
  /**
   * #243 — what the load reached: a full sweep, a path-only refusal, or a refusal before the
   * path. Omitted means `'swept'`, which is what the panel's generate → simulate action leaves
   * when it gets this far; a caller that saw a refusal says so and the sheet prints the
   * blind-spot sentence the same way the Simulate panel does.
   */
  outcome?: SimRunOutcome;
}

// ---------------------------------------------------------------------------------------------
// The sheet itself
// ---------------------------------------------------------------------------------------------

/** One instruction the operator follows. */
export interface RunSheetStep {
  text: string;
  /** A number with units, shown bold. */
  value?: string;
  /**
   * A line to SEND, verbatim, in the console's own language — e.g. `G38.2 Z-8 F100`. Set in a
   * monospace run rather than left inside the sentence, because it is meant to be typed and not
   * read (#391 review item 1: a step that names a travel cap but never gives a sendable line is not
   * a step an operator can follow, and the command itself must not have to be reassembled from prose).
   */
  code?: string;
  /** Label of a blank the operator fills in. */
  record?: string;
  /**
   * The issue that will confirm this step on the machine, e.g. `'#208'`. PRESENT means the step
   * is an assumption, not a measured fact; the view must show the tag.
   */
  unverified?: string;
  /** Render the step's text bold. The `vise-default` warning opens section 8 this way. */
  bold?: boolean;
}

export interface RunSheetSection {
  /** Stable id for tests and the view: 'need', 'mount', 'load', 'cutter', 'origin', 'dry-run', 'cut', 'warnings', 'record'. */
  id: string;
  title: string;
  steps: RunSheetStep[];
}

/** One item's bounding box on the origin diagram, in the STOCK frame, mm. */
export interface RunSheetDiagramItem {
  id: string;
  name: string;
  min: [Mm, Mm];
  max: [Mm, Mm];
  depth: Mm;
}

/** A jaw rectangle on the diagram, in the STOCK frame, mm (may extend past the stock). */
export interface RunSheetDiagramJaw {
  id: string;
  label: string;
  min: [Mm, Mm];
  max: [Mm, Mm];
}

/**
 * An under-surface void's footprint on the diagram, in the STOCK frame, mm (#231 item 3). Drawn
 * dashed, because it is not a cut — it is material MISSING under the top face. `solidThickness`
 * is the material left over it (`stock.thickness − zCeiling`), the number the operator must not
 * cut through.
 */
export interface RunSheetDiagramKeepOut {
  id: string;
  name: string;
  min: [Mm, Mm];
  max: [Mm, Mm];
  solidThickness: Mm;
}

/** Everything the top-view origin diagram needs — plain geometry, no markup. */
export interface RunSheetDiagram {
  /** The stock outline: X × Y, front-left at the origin. */
  stock: { length: Mm; width: Mm };
  /** The two jaws, at their faces (shifted for sacrificial material, #213). */
  jaws: RunSheetDiagramJaw[];
  /** The work origin, in the stock frame. Always `[0, 0]`. */
  origin: [Mm, Mm];
  /** Every enabled item that has a region, with its bounding box and depth. */
  items: RunSheetDiagramItem[];
  /** Enabled under-surface voids, as their footprints (#231 item 3). Empty for a solid blank. */
  keepOuts: RunSheetDiagramKeepOut[];
}

/**
 * One solid on the stack-up elevation (#213 §6), in the X–Z plane of the WORK frame. X runs left
 * to right between the jaws; Z is the job's Z, so the part's top face is Z = 0 and everything
 * below it is negative. `dimension` is the box's own size, already formatted for the operator.
 */
export interface RunSheetStackUpBox {
  id: string;
  label: string;
  minX: Mm;
  maxX: Mm;
  minZ: Mm;
  maxZ: Mm;
  /** The dimension printed on the box, e.g. `'12 mm'`; null for a jaw, whose size is not the point. */
  dimension: string | null;
  /** True for the board and the strips — drawn in the paler sacrificial tone. */
  sacrificial: boolean;
}

/**
 * The side view of the setup (#213 §6): jaws, strips, board and part, each at its own thickness,
 * so the operator can see what the jaws actually bear on and that Z0 is the PART's top face, not
 * the board's. Present only when the job has sacrificial material — a job without any is drawn by
 * the top-view origin diagram alone, and its sheet is unchanged.
 *
 * It is an X–Z ELEVATION, not a section: front and back strips lie behind the part in this view
 * and are named by `sacrificialSummary` in section 1 rather than drawn here.
 */
export interface RunSheetStackUp {
  boxes: RunSheetStackUpBox[];
  /** Z of the part's top face — the datum plane the operator probes. Always 0. */
  datumZ: Mm;
}

/**
 * The note beside the header's time estimate (#242, #281). The number is a CYCLE estimate —
 * cutting plus rapids, each timed through the trapezoid — so it is a planning figure, not a
 * measured cycle time. Built from the profile's own rapid model so the printed rates cannot drift
 * from the ones the estimate is timed with, and so a second mill prints its own. The model's
 * `source` rides along exactly as it does in the post's header line, so a sheet read on its own
 * still says where the numbers came from — a config read and a stopwatch sample, not a measurement
 * of the machine.
 */
export function rapidAssumptionNote(rapid: RapidEstimate): string {
  return (
    `cutting + rapids through the trapezoid, timed on a rapid model of ${rapid.xyMmPerMin} mm/min XY / ` +
    `${rapid.zMmPerMin} mm/min Z at ${rapid.accelMmPerS2} mm/s² (${rapid.source}) — a planning estimate, ` +
    `not a measured cycle time.`
  );
}

export interface RunSheetHeader {
  jobName: string;
  /**
   * The machine the job names (#347), by its profile name — `Makera Z1` today. On paper because it
   * is what the rest of the sheet is true ABOUT: the envelope the blank was checked against, the
   * spindle ceiling the feeds were clamped to, and the materials the job could be asked for are all
   * the machine's, and an operator holding a printout should not have to open the app to know which
   * one it was written for.
   */
  machine: string;
  /** ISO date (`YYYY-MM-DD`) the sheet was generated. */
  generatedOn: string;
  /** The sanitised job name plus `.nc` — the file the operator loads. */
  fileName: string;
  /** First 8 hex of SHA-256 of the `.nc` text, so the sheet can be matched to the file. */
  fileHash: string;
  /** Formatted cycle estimate, from `generated.cam.estimatedSeconds`. */
  estimatedTime: string;
  /** Always `rapidAssumptionNote` for the job's machine — says the number is a planning estimate (#242, #281). */
  estimatedTimeNote: string;
}

export interface RunSheet {
  header: RunSheetHeader;
  sections: RunSheetSection[];
  /** Placed inside section 5 in the view. */
  diagram: RunSheetDiagram;
  /**
   * The side view of the setup, placed inside section 3 (#213 §6). ABSENT when the job has no
   * sacrificial material, so a job that does not use it produces a byte-identical sheet.
   */
  stackUp?: RunSheetStackUp;
}

// ---------------------------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------------------------

/** '2' for 2.0, '0.5' for 0.5, '12.346' for a value that needs rounding. Trailing zeros trimmed. */
function fmtNum(n: number): string {
  return String(Number(n.toFixed(3)));
}

// #347 — the app's word for a material comes from the ONE map (`materials.ts`), so this sheet and
// the flow's `<select>` cannot spell a material two ways.

/** '2 min 35 s'. Formats the seconds it is given; `estimatedTimeNote` says what they are. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${sec} s`;
  return `${sec} s`;
}

/**
 * The height the frame file traces at, mm above the top face (#244). This is #207 §6's 20 mm air
 * clearance, now baked into the generated frame file instead of an offset the operator sets and
 * must remember to clear: the trace cannot be run at the wrong Z. Fixed, not derived from the
 * job — tall enough to clear the cutter holder over the default stock.
 */
export const FRAME_Z: Mm = 20;

/**
 * The frame file's name (#244): the job's own file name with `-frame` before the extension, so
 * it sits beside the job and cannot be confused with it. Shares `runSheetFileName`'s sanitiser,
 * so the sheet and the saved file can never disagree about what the file is called.
 */
export function runSheetFrameFileName(jobName: string): string {
  return `${runSheetFileName(jobName).slice(0, -'.nc'.length)}-frame.nc`;
}

/**
 * §9's per-item rows (#277): every cut item, in the order section 7 lists them, with the depth the
 * program was posted at. The printed sheet's "measured depth" blanks and the run record file's
 * `depths` array are both built from this one list, so a filled record can never answer a row the
 * sheet did not ask — the same single-funnel trick `toPartPlan` plays for the diagram and the
 * depth notes. It is the CALLER's plan, not a second `toPartPlan` call, so the two cannot diverge.
 */
export function recordDepths(plan: PartPlan): { id: string; name: string; depth: Mm }[] {
  return plan.engraves.map((item) => ({ id: item.id, name: item.name, depth: item.depth }));
}

/**
 * The `.nc` file name for a job: the job name with runs of anything but letters, digits, `-`, `_`
 * and `.` collapsed to `-`, trimmed, plus `.nc`. Empty after cleaning falls back to
 * `engrave-job.nc`.
 *
 * COUPLING: #206 owns the save, so this must match its sanitiser — both derive the name from
 * `job.name` and nothing else. If #206's rule differs, this is the one place to update; noted on
 * #207.
 */
export function runSheetFileName(jobName: string): string {
  const cleaned = jobName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  return `${cleaned || 'engrave-job'}.nc`;
}

// ---------------------------------------------------------------------------------------------
// SHA-256 (sync, browser and Node — no Web Crypto, whose digest is async)
// ---------------------------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

/** SHA-256 of the UTF-8 bytes of `input`, lowercase hex. Exported for its own test vectors. */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;

  const total = Math.ceil((bytes.length + 1 + 8) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(total - 4, bitLen % 0x100000000);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }

    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + (SHA256_K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  let out = '';
  for (let i = 0; i < 8; i++) out += (h[i] as number).toString(16).padStart(8, '0');
  return out;
}

// ---------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------

/**
 * #285/#345/#351 — the void numbers on this sheet are `keepOutLimit`'s, not this file's.
 *
 * They used to be worked out here, because the sheet's no-wasm, main-thread contract forbids
 * building the layer stack and the grid arithmetic was reproduced by hand. #351 is what that cost:
 * the panel and the preview each had their own copy of the same composition and one of the three
 * drifted. `keepOutLimitParts` in `partPlan.ts` is now the single owner — the ceiling plane
 * (`voidCeilingFor`, layer-aligned where the blank states a print), the margin its rule keeps
 * (`voidMargin`, #345 decision A), and the `min` against the blank's own `thickness − minFloor` —
 * and the sheet, the panel and the preview all read it. The sheet still needs the two halves APART,
 * not just the answer, so it can say WHICH number bound: see the §1 step below.
 */

/**
 * Whether ANY plane in this job carries the `boundaryMargin` rule (#345) — a void's ceiling, or the
 * colour split under an item that states an intent.
 *
 * The sheet's margins block is gated on this, the way every other absent fact is: a one-colour job
 * over solid stock has no such plane, so the margin binds nothing and a block about it would be
 * noise. The split needs the print as well as the stock's `split`, because the depth the bound sits
 * at is the layer-aligned one — a blank with no stated print has no boundary to keep clear of, which
 * is `engraveRegions`' own rule for reporting `item-depth-bound`.
 */
function usesBoundaryMargin(job: EngraveJob, plan: PartPlan): boolean {
  if (plan.stock.keepOuts.length > 0) return true;
  const split = job.stock.print?.split;
  if (split === undefined) return false;
  // Read off the LABELS, not the plan: `plan.engraves` is the four fields a cut needs and does not
  // carry `depthIntent`, and only a label can state one. The two skips mirror
  // `itemDepthBoundFindings` exactly — a disabled or construction label is not judged, so it is not
  // a bound in play here either.
  return job.labels.some(
    (l) => l.enabled && l.construction !== true && splitBound(l.depthIntent, split) !== null,
  );
}

/**
 * The margins block for §1 (#345): the number every bound in this job uses, where it came from, and
 * the arithmetic the app recommends for THIS blank.
 *
 * Both numbers, because the operator holding a printout has no panel to check them against: the
 * house default is 0.2 mm, and a blank that states a 0.33 mm dome needs more than that. Printing
 * only the one in force would hide the disagreement the panel shows.
 */
function marginsStep(
  job: EngraveJob,
  plan: PartPlan,
  margins: EngraveMargins,
  settings: MarginSettings,
): RunSheetStep {
  // The recommendation is `max(setting, zTolerance)` — the house number, never the margin the job
  // happens to be running on, and the SAME inputs the panel resolves (`zBudgetInputsFor`), so the
  // printout and the panel cannot offer two different numbers for one blank (#345 review).
  const rec = recommendMargins(job, settings, zBudgetInputsFor(job));
  // #345 decision A — a blank that states NO print and has a void runs its void's ceiling on
  // `max(boundaryMargin, minFloor)`, so the boundary margin printed on this line is NOT the number
  // that void keeps. The only place the operator can read which rule applied is here; saying it only
  // when the structural floor is the larger one keeps the line about the margin that actually binds.
  const voidKeepsFloor =
    job.stock.print === undefined &&
    plan.stock.keepOuts.length > 0 &&
    job.minFloor > margins.boundaryMargin;
  return {
    text:
      'Depth margins — how far every floor stays clear of a plane: a void’s ceiling, the colour ' +
      `split. Recommended for this blank: ${fmtNum(rec.boundaryMargin)} mm — ${rec.basis.join('; ')}.`,
    value:
      `${fmtNum(margins.boundaryMargin)} mm boundary margin · ${marginSourceWords(margins.source)}` +
      (voidKeepsFloor
        ? ` · no print stated: a void’s ceiling keeps the job’s minimum floor, ${fmtNum(job.minFloor)} mm`
        : ''),
  };
}

/**
 * Where a label's depth came from, in words, for §7 (#362 review; #345's rule that the number says
 * where it came from).
 *
 * Only the app's OWN numbers get a sentence. A depth a person typed is theirs and needs no note; a
 * depth the recommendation wrote is the one an operator may reasonably read as a mistake — 0.51 mm
 * is shallow for a label — unless the printout says which constraint left only that much. The
 * sentence is the same `basis[0]` the label's own row shows in the panel, and it is produced by the
 * same call, so the paper and the screen cannot explain one number two ways.
 *
 * The clause is printed only when the recommendation STILL reproduces the depth the job carries.
 * `setStock` can be edited after a blank was taken without re-depthing anything, and quoting a
 * reason for a number this blank's arithmetic no longer produces would be the invented provenance
 * #345 is against — so a stale `computed` depth says only that the app chose it, and what the
 * blank now allows instead.
 */
function depthSourceWords(
  job: EngraveJob,
  item: { id: string; depth: Mm },
  boundaryMargin: Mm,
  measure: InkMeasure,
): string {
  const label = job.labels.find((l) => l.id === item.id);
  if (!label) return '';
  const claim = job.sources?.labels?.[label.id];
  // Anything but `computed` is the user's or the bench's number, and neither asked to be explained.
  if (claim?.depth !== 'computed') return '';
  const rec = recommendLabelDepth(job, label, {
    // #365 — this line's own extent decides which voids bound it, exactly as the store's walk and
    // the panel's row do it. The sheet used to quote the blank's shallowest void for every line.
    voidLimit: voidLimitForItem(job, label, boundaryMargin, measure),
    // #369 — the jaw bound behind the sentence is the one THIS line is charged, on the same measured
    // box the void bound above reads (#394 measures inside `labelJawReach`, off the same
    // `job.customFonts`), or the paper would explain the depth with a limit the app no longer holds
    // the line to.
    jawReach: labelJawReach(job, label),
    boundaryMargin,
    ...(claim.depthIntent === undefined ? {} : { intent: claim.depthIntent }),
  });
  if (rec !== null && Math.abs(rec.depth - item.depth) < 1e-9) return ` — ${rec.basis[0]}`;
  return (
    ' — the app recommended this depth for the blank it was taken on' +
    (rec === null ? '' : `; this blank's arithmetic allows ${fmtNum(rec.depth)} mm`)
  );
}

/**
 * The void a cut item's extent sits over, or null. Both the item and the void are reduced to
 * their stock-frame bounding boxes (`buildDiagram` has them), because the sheet is pure — no
 * wasm, so no exact region intersection — and a box overlap is the CONSERVATIVE test: it may
 * name a void whose footprint does not quite reach the item, but it never misses one that does.
 * When several voids overlap the item, the one with the shallowest limit wins.
 */
function keepOutOver(
  job: EngraveJob,
  box: { min: [Mm, Mm]; max: [Mm, Mm] } | undefined,
  keepOuts: readonly RunSheetDiagramKeepOut[],
  margin: Mm,
): RunSheetDiagramKeepOut | null {
  if (!box) return null;
  let worst: RunSheetDiagramKeepOut | null = null;
  let worstLimit = Infinity;
  for (const ko of keepOuts) {
    if (!boxesOverlap(box, ko)) continue;
    const limit = keepOutLimit(job, ko.solidThickness, margin);
    if (limit < worstLimit) {
      worstLimit = limit;
      worst = ko;
    }
  }
  return worst;
}

/** One sentence for the sacrificial setup (#213), or null when there is none. */
function sacrificialSummary(job: EngraveJob): string | null {
  const s = job.sacrificial;
  const parts: string[] = [];
  if (s.under) {
    const ov = s.under.overhang;
    const overhang =
      ov.left === 0 && ov.right === 0 && ov.front === 0 && ov.back === 0
        ? 'flush with the part'
        : `${fmtNum(ov.left)}/${fmtNum(ov.right)}/${fmtNum(ov.front)}/${fmtNum(ov.back)} mm overhang (left/right/front/back)`;
    parts.push(`a ${fmtNum(s.under.thickness)} mm board under the part, ${overhang}, fixed with ${s.under.attach}`);
  }
  const strips = (['left', 'right', 'front', 'back'] as const)
    .filter((pos) => s.sides[pos] !== null)
    .map((pos) => {
      const side = s.sides[pos]!;
      const height = side.height === 'flush' ? 'flush with the part' : `${fmtNum(side.height)} mm tall`;
      return `${pos} strip ${fmtNum(side.thickness)} mm, ${height}`;
    });
  if (strips.length > 0) parts.push(strips.join('; '));
  return parts.length === 0 ? null : parts.join(', and ');
}

/** Bounding-box overlap, touching counted — the sheet's conservative "sits over" test (#231). */
function boxesOverlap(a: { min: [Mm, Mm]; max: [Mm, Mm] }, b: { min: [Mm, Mm]; max: [Mm, Mm] }): boolean {
  return a.min[0] <= b.max[0] && a.max[0] >= b.min[0] && a.min[1] <= b.max[1] && a.max[1] >= b.min[1];
}

/**
 * The side view of the setup (#213 §6), or null when the job has no sacrificial material. Every
 * box is placed from the same model the rest of the pipeline uses: the strips come from their own
 * `thickness`/`height` (`stripHeight`), the board from `under.thickness`/`overhang`, the jaws from
 * `viseJawShift` + `viseEnvelope`'s own body depth. Nothing here is hand-placed.
 *
 * The left/right strips are the ones BETWEEN the jaw and the part, so this elevation shows them.
 * Front and back strips sit behind the part in this view (different Y, same X span); they are named
 * by `sacrificialSummary` in section 1 instead, not drawn.
 */
function buildStackUp(job: EngraveJob): RunSheetStackUp | null {
  if (!hasSacrificial(job.sacrificial)) return null;

  const { length, thickness } = job.stock;
  const { under, sides } = job.sacrificial;
  const vise = job.workholding.vise;
  const shift = viseJawShift(job.sacrificial);
  const jawTopZ = -vise.stockProud;
  const jawBottomZ = -(thickness + VISE_BODY_DEPTH);
  const mm = (n: number): string => `${fmtNum(n)} mm`;

  const boxes: RunSheetStackUpBox[] = [];

  // The board first, so the strips and the part draw over it.
  if (under) {
    boxes.push({
      id: 'sacrificial-under',
      label: 'board',
      minX: -under.overhang.left,
      maxX: length + under.overhang.right,
      minZ: -(thickness + under.thickness),
      maxZ: -thickness,
      dimension: mm(under.thickness),
      sacrificial: true,
    });
  }

  // The jaws, at their shifted faces — the same faces `viseEnvelope` collides against.
  boxes.push(
    {
      id: 'vise-fixed-jaw',
      label: 'fixed jaw (left)',
      minX: -shift.left - vise.fixedJawThickness,
      maxX: -shift.left,
      minZ: jawBottomZ,
      maxZ: jawTopZ,
      dimension: null,
      sacrificial: false,
    },
    {
      id: 'vise-moving-jaw',
      label: 'moving jaw (right)',
      minX: length + shift.right,
      maxX: length + shift.right + vise.movingJawThickness,
      minZ: jawBottomZ,
      maxZ: jawTopZ,
      dimension: null,
      sacrificial: false,
    },
  );

  for (const pos of ['left', 'right'] as const) {
    const strip = sides[pos];
    if (!strip) continue;
    const height = stripHeight(strip, thickness);
    boxes.push({
      id: `sacrificial-${pos}`,
      label: `${pos} strip`,
      // Left strips run from the part's left edge outward; right strips outward from its right.
      minX: pos === 'left' ? -strip.thickness : length,
      maxX: pos === 'left' ? 0 : length + strip.thickness,
      minZ: -thickness,
      maxZ: -thickness + height,
      dimension: mm(strip.thickness),
      sacrificial: true,
    });
  }

  // The part last: drawn on top, and its top face is the datum line.
  boxes.push({
    id: 'part',
    label: 'part',
    minX: 0,
    maxX: length,
    minZ: -thickness,
    maxZ: 0,
    dimension: mm(thickness),
    sacrificial: false,
  });

  return { boxes, datumZ: 0 };
}

/** The top-view origin diagram's plain geometry, derived from the job and its plan. */
function buildDiagram(job: EngraveJob, plan: PartPlan): RunSheetDiagram {
  const { length, width } = job.stock;
  const vise = job.workholding.vise;
  const shift = viseJawShift(job.sacrificial);
  const jawMinY = vise.jawStartY;
  const jawMaxY = vise.jawStartY + vise.jawLength;

  // `aabbOfProfile` keeps the un-shrunk box for a NEGATIVE offset (it will not guess how far a
  // concave region pulls in), so a `border` — an inward offset of the stock — would otherwise draw
  // as the whole blank. The stock outline is a known rectangle, so a border's true outer edge is
  // `inset` in from every side (#215).
  const borderInset = new Map<string, Mm>();
  for (const c of job.combined ?? []) if (c.kind === 'border') borderInset.set(c.id, c.inset);

  const items: RunSheetDiagramItem[] = [];
  for (const item of plan.engraves) {
    const inset = borderInset.get(item.id);
    const box =
      inset !== undefined
        ? { min: [inset, inset] as [Mm, Mm], max: [length - inset, width - inset] as [Mm, Mm] }
        : aabbOfProfile(item.profile);
    if (!box) continue; // empty region (e.g. whitespace-only text): no rectangle
    items.push({
      id: item.id,
      name: item.name,
      min: [box.min[0], box.min[1]],
      max: [box.max[0], box.max[1]],
      depth: item.depth,
    });
  }

  // #231 — an under-surface void's footprint, as the stock-frame box the operator sees it in.
  const keepOuts: RunSheetDiagramKeepOut[] = [];
  for (const ko of plan.stock.keepOuts) {
    const box = aabbOfProfile(ko.footprint);
    if (!box) continue;
    keepOuts.push({
      id: ko.id,
      name: ko.name || ko.id,
      min: [box.min[0], box.min[1]],
      max: [box.max[0], box.max[1]],
      solidThickness: keepOutMembrane(job, ko.zCeiling),
    });
  }

  return {
    stock: { length, width },
    jaws: [
      {
        id: 'vise-fixed-jaw',
        // The fixed jaw is on the LEFT (/Fabrication.md §7.3); its face is x = 0, shifted out
        // for sacrificial material (#213 §2).
        label: 'Fixed jaw (left)',
        min: [-shift.left - vise.fixedJawThickness, jawMinY],
        max: [0 - shift.left, jawMaxY],
      },
      {
        id: 'vise-moving-jaw',
        label: 'Moving jaw (right)',
        min: [length + shift.right, jawMinY],
        max: [length + shift.right + vise.movingJawThickness, jawMaxY],
      },
    ],
    origin: [0, 0],
    items,
    keepOuts,
  };
}

/**
 * Whether this job's vise is the shipped default — the warning `validateVise` raises for it
 * (`vise-default`, `fixture.ts`; #353 keeps it to that one validator), which §8 must open with.
 */
function isViseDefault(vise: ViseParams): boolean {
  return vise.source === 'default';
}

/**
 * #243 — the coverage input, assembled from what THIS job and THIS run carry, never from prose.
 * The panel builds the same structure from its own state (`SimPanel.tsx`); here every field comes
 * from the job the file was generated for and the diagnostics the run produced, so a sheet that
 * was printed for a run cannot claim coverage that run did not have.
 *
 * The fixture is the vise envelope `toSetup` hands the sweep (`viseEnvelope`), so the obstacles
 * the sheet names ARE the ones the sweep was given, and the tool name comes from the job's
 * cutter. The collet nut is NOT a field here (#314): the sheet reports the nut as a blind spot
 * only when the run's own codes say the check was needed and could not be made, which on a vise
 * job — every obstacle below the stock top — is never.
 */
function coverageFor(job: EngraveJob, generated: RunSheetGenerated, sim: RunSheetSim | null): SimCoverageInput {
  const codes = new Set<string>();
  for (const f of generated.findings) codes.add(f.code);
  for (const f of generated.verify?.findings ?? []) codes.add(f.code);
  for (const d of sim?.diagnostics ?? []) codes.add(d.code);
  const envelope = viseEnvelope(job.stock, job.workholding.vise, job.sacrificial);
  return {
    outcome: sim?.outcome ?? 'swept',
    fixtureLabels: envelope.boxes.map((b) => b.label),
    fixtureSource: envelope.source,
    sacrificialModelled: hasSacrificial(job.sacrificial),
    toolName: jobTool(job)?.name ?? null,
    codes: [...codes],
  };
}

/** A leading letter, uppercased — the planner's notes are clauses, the sheet prints sentences. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * §5 — how the work origin is set, DERIVED from how the part is held (#272, decision 26).
 *
 * The sequence this replaced was decision 23's hand-written edge find, which decision 26
 * superseded: it named the left face and the front edge, said "check by eye", and could not say
 * what the jaws already reference, which axes are still open, or what is left uncertain
 * afterwards. `planProbing` answers all of it from the blank and the workholding, so the sheet
 * prints the plan rather than a rule that is correct for one fixture only.
 *
 * A REFUSAL IS A STEP. When no reachable straight edge can resolve an open axis the plan refuses
 * and names the clamp or jaw that is in the way — the one thing the old sequence could never say,
 * because it would have sent the probe to a face the fixture covers.
 *
 * #213 §6 — with sacrificial material the X and Y faces are still the PART's (the work frame does
 * not move; §"Frame — unchanged"), and Z0 is the PART's top face, never the board's. A board under
 * the part reaches a cut depth only if Z is probed on the wrong face, so the step says which face
 * it means whenever there is a board to confuse it with.
 */
function registrationSteps(job: EngraveJob, onBoard: boolean, unverified: string): RunSheetStep[] {
  const { length, width } = job.stock;
  const plan = registrationFor(job);

  if ('refuse' in plan) {
    return [
      {
        text:
          `This job cannot be registered as set up: ${plan.message}. Move the fixture or the part, ` +
          'probe by hand, or change the workholding — do not run this file until X0, Y0 and Z0 are ' +
          'known.',
        bold: true,
        unverified,
      },
    ];
  }

  const steps: RunSheetStep[] = [];
  // What the fixture supplies before any touch. Stated first, because it is what makes the rest of
  // the sequence as short as it is.
  for (const d of plan.datums) {
    steps.push({
      text: `The ${kindWord(job.workholding.kind)} already references ${axesWord(d.fixes)} to within ±${fmtNum(d.uncertainty)} mm, before any touch.`,
      unverified,
    });
  }
  // One step per touch, in the plan's own order: rotation's pair first, then whatever the pair did
  // not settle. Named physically, never by coordinate alone.
  plan.touches.forEach((t, i) => {
    const words = describeTouch(t, length, width);
    steps.push({
      text: `Touch ${i + 1} of ${plan.touches.length}: ${words.edge}, ${words.where} — this gives ${readsWord(t)}.`,
      unverified,
    });
  });
  steps.push({
    text: onBoard
      ? "Z0: the PART's top face — probe it, or touch off on it. NOT the board's top face."
      : "Z0: the blank's top face — probe it, or touch off on it.",
    unverified,
  });
  steps.push({
    text:
      `X0 Y0 Z0 is the top-front-left corner of the ${onBoard ? 'part' : 'blank'}. That leaves the ` +
      `work origin within ±${fmtNum(plan.residual)} mm in X and Y` +
      (plan.rotationResidual > 0 ? ` and ±${fmtNum(plan.rotationResidual)}° in rotation` : '') +
      '. Move there and check by eye before going on. ' +
      // #391 review item 2 — the ±residual above is what the PLAN leaves open, not how well the
      // operator then sets it. Nothing in the app carries a term for that error (or for the blank
      // sitting differently from the model): every check judges the cut against the blank and the
      // jaws AT THIS ORIGIN, so a shifted origin moves the job in the real world without moving it
      // in the model. `edgeMargin` is the X/Y slack the content keeps from a stock edge — it is not
      // a locating tolerance, but it is all there is, so the sheet says so where the origin is set
      // rather than letting it be absorbed into the vise's own uncertainty band.
      `How well YOU set it is not modelled: the file places the blank at this corner and judges the ` +
      `jaws against it, so an origin that is out by a little — or a ${onBoard ? 'part' : 'blank'} ` +
      `sitting differently from what was measured — shifts the whole job relative to both without the ` +
      `app knowing. The only X/Y slack for that is this job's edge margin, ${fmtNum(job.edgeMargin)} mm, ` +
      'which is the gap the content keeps from a stock edge rather than a locating tolerance: a cut ' +
      'standing at that margin has used all of it.',
    unverified,
  });
  // The planner's own caveats — the static-`.nc` rotation limitation, why Z is always probed, and
  // where a footprint could not be resolved. Verbatim but for the leading letter: the planner
  // writes notes as clauses, and the sheet prints sentences.
  for (const note of plan.notes) steps.push({ text: sentence(note), unverified });
  return steps;
}

/**
 * §5's second half — the material-position check (#391, decision 26).
 *
 * The steps above set the origin; these OFFER to check it against the blank that is actually in the
 * jaws, which is a different question. `registrationSteps` answers it with X, Y and rotation
 * touches that the wired probe cannot make (it is Z-only, §11.7), so the sheet says which way the
 * blank has moved with the one gesture the probe does have: a downward touch across each edge, read
 * as "the blank's own top" or "not". `materialScan.ts` owns the geometry and the physics; this
 * function is only how an operator reads them, so every number here comes from the plan.
 *
 * IT IS AN OFFER, and the sheet says so, because the check costs a tool change: the probe goes in
 * for it and the cutter comes back after. When the blank is the one the origin was just set
 * against, the check confirms what the operator has already seen with their own hands.
 *
 * HELD, not printed (#391): `buildRunSheet` calls this only when `RunSheetOptions.materialScan` is
 * set, and nothing in the app sets it. The block was written, reviewed and held (review of 36f3837,
 * 2026-10-13); the review's seven items are now IN, one step each — the sendable `G38.2` line from a
 * stated start height with its travel cap and the miss's `$X`/lift, the tip stated as the figure
 * every other one derives from (an assumption when this was written; measured 2026-10-15, A8), the
 * correction reading PAST the edge as the module always meant, the
 * dome as a shape judged edge by edge, bisection either way and a step for a pass that never
 * bracketed the edge, and per-jaw numbers inside §11.8's bounds carrying their own uncertainty —
 * but the hold is not lifted until a person has read them again. See `RunSheetOptions.materialScan`.
 */
function materialPositionSteps(job: EngraveJob, onBoard: boolean, unverified: string): RunSheetStep[] {
  const part = onBoard ? 'part' : 'blank';
  // Nothing to check the blank against when the origin itself could not be resolved: §5 is then one
  // refusal step, and a scan printed under it would be a sequence the sheet has just declined to
  // stand behind. (`registrationFor` is pure point maths on the stock rectangle, so asking it twice
  // costs nothing and keeps this function's own contract — never a scan for an unresolvable origin.)
  if ('refuse' in registrationFor(job)) return [];
  const plan = planMaterialScan(job);
  if ('refuse' in plan) {
    return [
      {
        text:
          `The ${part}’s position cannot be checked with the probe on this setup: ${plan.message}. ` +
          'Set the origin as above and check the blank against it with a rule instead.',
        unverified,
      },
    ];
  }

  // The plan's own figures, quoted rather than re-derived: the sheet prints what the module decided,
  // and every number below appears exactly once as a source.
  const gapMm = fmtNum(SCAN_START_GAP_MM);
  const capMm = fmtNum(plan.missTravelMm);
  const travelMm = fmtNum(SCAN_START_GAP_MM + plan.missTravelMm);
  const stepMm = fmtNum(SCAN_COARSE_STEP_MM);
  const biasMm = fmtNum(plan.resolutionMm);
  const belowMm = fmtNum(plan.bands.belowMm);
  /** The blank's own top band at an edge — the left/right and front/back figures differ (the dome). */
  const bandMm = (edge: 'left' | 'front'): string =>
    fmtNum(plan.edges.find((e) => e.edge === edge)!.bands.blankMm);
  const sidesMm = bandMm('left');
  const endsMm = bandMm('front');

  const steps: RunSheetStep[] = [
    {
      text:
        'OPTIONAL, BEFORE THE FIRST CUT — check where the blank really is, with the wired probe. It ' +
        'is Z-only, so it cannot touch a side: it finds an edge by touching DOWN at points across ' +
        `it and watching where the reading changes. ${plan.edges.length} edges, ${plan.edges[0]!.touches.length} touches each, a few minutes, one tool change. ` +
        'Skip this if this is the blank you have just set the origin against.',
      unverified,
    },
    {
      // #391 review item 2 — the assumptions come FIRST, before a single position is read off this
      // sheet: an operator deciding whether to trust a predicted depth is entitled to know which of
      // the figures behind it is measured and which is standing in. The plan words them, so the
      // sheet cannot soften one.
      text: 'Before you touch anything: what the numbers below assume, and what this fixture already gives you.',
      unverified,
    },
    ...plan.notes.map((text): RunSheetStep => ({ text, unverified })),
    {
      text:
        `Fit the probe and touch off ONCE on the ${part}’s top face, near the middle (M491 for the ` +
        'probe’s own length). Every reading below is a change from this one, so its Z is the zero ' +
        'depth to compare against.',
      unverified,
    },
    {
      // #391 review item 1 — a sendable line, and the height it is sent from. The cap the old step
      // named (`5 mm below the reference`) was a field the machine does not show: a `G38.2` takes a
      // TRAVEL distance, so without a stated start height there was nothing to send.
      text:
        `Every touch below is ONE line, sent with the tip held ${gapMm} mm above the top of the blank — ` +
        'lift to that height and jog X and Y THERE, never sideways at depth. The Z word is the distance ' +
        `the tip may TRAVEL, not a place to go (§11.6): from the ${gapMm} mm gap it descends onto the ` +
        `blank and stops there, or runs the ${gapMm} mm plus the ${capMm} mm cap if there is nothing ` +
        'under it — as far as it may ever go, which is what keeps a touch that finds nothing off the bed:',
      code: `G38.2 Z-${travelMm} F100`,
      unverified,
    },
    {
      text:
        'A touch that finds NOTHING is not a fault — it is one of the readings this check looks for. ' +
        'The console reports where the tip stopped with a 0 flag, then ALARM: Probe fail, and the ' +
        'machine locks: a lift is refused (error:Alarm lock) until the Alarm is cleared, which is what ' +
        'this sends:',
      code: '$X',
      unverified,
    },
    {
      text:
        'Then lift the tip clear of the clamp. Do this after EVERY touch, hit or miss, before any X or ' +
        'Y move — after a miss the tip is at the cap with a jaw beside it:',
      code: 'G53 G0 Z-3',
      unverified,
    },
  ];

  // One step per edge. The four touches of an edge differ only in how far they sit from it, so the
  // step is one sentence with the expected reading beside each position.
  for (const scan of plan.edges) {
    const aimed = scan.touches.find((t) => t.role === 'edge')!;
    const inside = scan.touches.filter((t) => t.role === 'inside');
    const outward = scan.touches[scan.touches.length - 1]!;
    // #391 review item 7 — when the fixture's own uncertainty reaches this point, the plan carries a
    // second reading: the nominal jaw stops short of it, and a jaw at the wide end of its band does
    // not. A step that printed only the first would turn a CORRECT reading into a fault the operator
    // has to explain. The second reading is always the jaw's TOP, because growing the box can only
    // add jaw — `ScanTouch.alsoMaybe` owns that direction.
    const reads = (t: ScanTouch): string =>
      t.alsoMaybe === undefined
        ? surfaceWord(t.expect)
        : `${surfaceWord(t.expect)} — or, if the jaw reaches this far after all, ${surfaceWord(t.alsoMaybe)}`;
    steps.push({
      text:
        `Check ${sideWords(scan.edge)} — at ${alongWord(scan.edge)}. Touch down at ` +
        `${inside.map((t) => fmtNum(Math.abs(t.offsetMm))).join(' and ')} mm inside (${reads(inside[0]!)}), ` +
        `at ${inOutWord(aimed.offsetMm)} (${reads(aimed)}), ` +
        `and at ${inOutWord(outward.offsetMm)} (${reads(outward)})` +
        (outward.expect === 'miss'
          ? ' — no jaw reaches under the tip past that edge, so a miss there is the expected reading, not a fault.'
          : '.'),
      record: `${scan.axis === 'x' ? 'X' : 'Y'} where the reading stops being the blank (mm)`,
      unverified,
    });
  }

  // What the readings mean. The bands are the JOB's own (its blank's dome, and the height it stands
  // proud) and they are PER EDGE, because the face is a shape: the whole point of #391's fourth
  // review item is that one figure quoted for the middle is not the top at the edges.
  steps.push({
    text:
      'Reading the depths. Each edge is judged against the blank’s own top WHERE THAT EDGE IS, not ' +
      `against one number, because the face is domed: within ${sidesMm} mm of the reference is the ` +
      `blank at the left and right edges, ${endsMm} mm at the front and back, and ${belowMm} mm or more ` +
      'below is off the blank at any of them. Between the two the tip is on the edge itself.',
    unverified,
  });
  steps.push({
    text:
      // #391 review item 3 — PAST, which is what the module has always computed and what the physics
      // says: the corner contact has to sink the reading before the dial can see it, so the change
      // appears on the far side of the edge and the edge is measured back TOWARD the blank.
      `The reading leaves the blank about ${biasMm} mm PAST the real edge — the tip’s corner contact ` +
      `has to climb ${biasMm} mm before the dial moves — so the edge is ${biasMm} mm INSIDE where the ` +
      `reading changed: measure the change, then take ${biasMm} mm back toward the blank. It is the ` +
      'same figure and the same direction at all four edges.',
    unverified,
  });
  steps.push({
    text:
      // #391 review item 5 — BOTH directions. The old step halved the gap one way only.
      `To place an edge more finely, BISECT where the reading changed, in either direction: halve the ` +
      'gap between the last reading that was the blank and the first that was not — inward or outward, ' +
      'whichever side the change fell on — touch the middle of that gap, keep the two readings that ' +
      `straddle it, and go again until they are no more than ${biasMm} mm apart, which is as fine as ` +
      'this scan can honestly place an edge. Every touch that finds nothing needs the Alarm cleared and ' +
      'the lift first (above).',
    unverified,
  });
  steps.push({
    text:
      // #391 review item 6 — the pass that never brackets the edge, which the old steps had no answer
      // for: an operator whose four readings were all "the blank" had nothing to bisect between.
      `If the readings do not bracket the change at all, the edge is not where the first pass looked. ` +
      `ALL FOUR reading the blank means every touch was still on it: step ${stepMm} mm further OUT and ` +
      `try again. An OFF reading at the innermost touch means the pass started past the edge: step ` +
      `${stepMm} mm back IN. Keep stepping until two neighbouring readings straddle the change, then ` +
      'bisect as above — and past an edge with no jaw under the tip the change arrives as a miss, ' +
      'which counts as off the blank.',
    unverified,
  });
  steps.push({
    text:
      `Compare with the file: the edges should lie where it says they do — X = 0 and X = ${fmtNum(job.stock.length)} for the ` +
      `left and right, Y = 0 and Y = ${fmtNum(job.stock.width)} for the front and back — after the ${biasMm} mm ` +
      'above is taken back toward the blank. More than the job’s own margin out, and the blank has moved: re-clamp it, or set the ' +
      'origin from the measured position. Do not cut until the two agree.',
    value: `allowed ${fmtNum(job.edgeMargin)} mm`,
    record: 'edge that is out, and by how much (mm)',
    unverified,
  });
  steps.push({
    text:
      'Put the CUTTER back and measure its length again (M491): the probe and the cutter are ' +
      'different tools, and every Z in the program is the cutter’s.',
    unverified,
  });
  return steps;
}

/**
 * What a caller may switch ON, over and above the sheet the app has always printed. Every field is
 * absent by default, so a caller that passes nothing gets exactly the shipped sheet — and adding a
 * field here cannot change one that is already on paper.
 */
export interface RunSheetOptions {
  /**
   * Print §5's material-position check (`materialScan.ts`, #391). **OFF, deliberately and for now.**
   *
   * It is the operator-facing half of a feature whose printed steps a review held (review of 36f3837
   * on 2026-10-13). That review's seven items are now all IN — see `materialPositionSteps` for the
   * list and which step carries each — and the module and the block are both tested; what remains is
   * that no person has read the rebuilt steps at a machine, so no sheet — the app's, the bench
   * generator's, or a committed `docs/bench` one — prints them yet. The probe's tip used to be the
   * loudest assumption in them; A8 calipered it on 2026-10-15 (#208), so the step now names the
   * reading — but the CONTACT MODEL around that reading is still a ball's (`materialScan.ts`'s
   * round-foot note), and A8's tip is a hollow cylinder with no ball, so the corner band and the
   * resolution are arithmetic on a shape the probe does not have. That is #391's own open item, and
   * the second reason the hold stands. Two figures are still assumptions and the steps SAY so: the
   * blank's dome, which stands in from the badge blank where the job states none (#345) — and,
   * unstated by any document, the 0.05 mm dial. Lifting the hold is the maintainer's call, not this
   * flag's.
   *
   * Nothing in the app sets it. `runSheet.spec.ts` does, so the block cannot rot while it is held.
   */
  materialScan?: boolean;
}

export function buildRunSheet(
  job: EngraveJob,
  generated: RunSheetGenerated,
  sim: RunSheetSim | null,
  now: Date = new Date(),
  settings: MarginSettings = MARGIN_DEFAULTS,
  options: RunSheetOptions = {},
): RunSheet {
  // One resolution, here: the sheet's own numbers and the panel's come off the same call with the
  // same house setting, and the BLOCK's recommendation is made from the setting rather than from
  // `margins`, which may be the job's own past recommendation (#345 review).
  const margins = effectiveMargins(job, settings);
  const { length, width, thickness, material } = job.stock;
  const vise = job.workholding.vise;
  // The one funnel all three item lists go through (#214/#215), so a `border`/`frame`/`cutaway`
  // is here too while a `construction` item, a broken reference and a self-intersecting polygon
  // are absent: the sheet describes exactly the cuts the `.nc` makes. `keepOuts` comes off the
  // same plan, so the diagram and the depth notes cannot disagree about where the voids are.
  const plan = toPartPlan(job);
  const items = plan.engraves;
  const diagram = buildDiagram(job, plan);
  const stackUp = buildStackUp(job);
  const itemBox = new Map(diagram.items.map((i) => [i.id, i] as const));
  // Only the cuts the cutter really gets OVER a jaw decide how far proud the blank must stand
  // (#369, #394). A floor works below the jaw tops only where a jaw is under it in XY, so a
  // blank-wide `deepest + clearance` told the operator to stop on a job the app itself had just
  // recommended: the badge hand-off's seeded line stands 6.9 mm clear of either jaw and cuts 1.0 mm,
  // yet the blank-wide reading demands `1.0 + 1` mm of stand — more than the vise default of the day
  // gave it (1.905) and far more than the seated default gives it now (0.71, #391). And the line this step prints is a STOP — an instruction to the
  // operator at the machine — so it takes the narrower reading the same rule answers with: the
  // cutter's own disc reaching the jaw face (`overJaw`, #394), not the wider reach the warning is
  // allowed to raise a band early on. The whole rule is `idJawReach`'s, so the paper and the panel
  // cannot disagree about whether the jaws bind at all.
  const overJaw = items
    .map((item) => ({ item, reach: idJawReach(job, item.id) }))
    .filter((r) => r.reach.overJaw);
  const deepestOver = overJaw.reduce<{ item: (typeof items)[number]; reach: JawReach } | null>(
    (deepest, r) => (deepest === null || r.item.depth > deepest.item.depth ? r : deepest),
    null,
  );
  // #362 review, #365 — the reason a recommended depth is as shallow as it is has to be the same
  // reason in all three places that state it, so the per-line void bound is worked out by the same
  // `voidLimitForItem` the store's walk and the panel's row call, on the same measurement
  // (`labelGlyphMeasure`). `depthSourceWords` asks it for the item it is wording, so a line the
  // sheet prints a reason for is judged against the voids THAT line reaches.
  const measure = labelGlyphMeasure(job.customFonts ?? []);
  // #207 section 3: below the deepest cut that sweeps OVER a jaw, by the clearance the JOB keeps,
  // the cutter is under the jaw tops. The number is the job's own `jawClearance` (#362 review) — the
  // same one `stock-proud-too-small` and `recommendLabelDepth` hold a floor to, so the printout
  // cannot tell the operator to stop somewhere the app does not. `null` when no cut comes over a jaw
  // (#369, #394): there is then no depth that would put a floor under one, and the step says so
  // instead of printing a stop the job cannot trip.
  const stopBelow = deepestOver === null ? null : deepestOver.item.depth + job.jawClearance;
  // #394 — the stop NAMES the cut that trips it and the jaw the cutter gets over. It is printed on
  // a sheet an operator did not write, and "stop" without a subject is a stop they cannot check.
  const stopWords =
    stopBelow !== null && deepestOver !== null
      ? `value. If it is less than ${fmtNum(stopBelow)} mm, stop: ${deepestOver.item.name} sweeps ` +
        `over the ${deepestOver.reach.jaw} jaw, so the cutter would work below the jaw tops.`
      : 'value. No cut on this job sweeps over a jaw, so there is no stop threshold to check.';
  const tool = jobTool(job);
  const diameter = tool ? cuttingDiameter(tool) : null;
  const params = generated.feeds && generated.feeds.ok ? generated.feeds.params : null;
  const nc = generated.nc;
  // #347 — the JOB's machine. Read once, here, rather than handed in: the name is the profile's and
  // no saved calibration touches it, so the sheet and the panel cannot disagree about which machine
  // this is even when the panel is showing a calibrated frame. Its rapid model is read from the same
  // profile (#281), so the note beside the estimate quotes the numbers the estimate was timed with.
  const machine = jobMachine(job);
  const header: RunSheetHeader = {
    jobName: job.name,
    machine: machine.name,
    generatedOn: now.toISOString().slice(0, 10),
    fileName: runSheetFileName(job.name),
    fileHash: nc === null ? '' : sha256Hex(nc).slice(0, 8),
    estimatedTime: generated.cam ? formatDuration(generated.cam.estimatedSeconds) : 'unknown',
    estimatedTimeNote: rapidAssumptionNote(machine.rapidEstimate),
  };

  // ---- 1 · What you need ---------------------------------------------------------------------
  const needSteps: RunSheetStep[] = [
    {
      text:
        'The blank. Measure it. If it differs by more than 0.5 mm in any dimension, change the job ' +
        'and regenerate — do not run this file.',
      value: `${fmtNum(length)} × ${fmtNum(width)} × ${fmtNum(thickness)} mm ${MATERIAL_LABELS[material]}`,
    },
    {
      text: tool ? `The cutter — ${tool.name}.` : 'The cutter named by the job.',
      value: diameter === null ? 'cutting diameter unknown' : `⌀ ${fmtNum(diameter)} mm cutting`,
    },
    {
      text: "Record the cutter's flute length and its stick-out from the collet.",
      record: 'flute length (mm) / stick-out (mm)',
    },
    {
      text:
        'The Z1 low-profile vise, and the wired probe that ships with the machine — a mechanical ' +
        'touch tip, so it triggers on PLA (measured 2026-10-08, 0.001 mm). The 3D Probe stays in reserve.',
    },
  ];
  const sac = sacrificialSummary(job);
  if (sac !== null) needSteps.push({ text: 'Sacrificial material:', value: sac });
  // #345 — the margin every bound in this job is drawn to, with its source and the arithmetic the
  // app recommends for this blank. Only when a bound exists: see `usesBoundaryMargin`.
  if (usesBoundaryMargin(job, plan)) needSteps.push(marginsStep(job, plan, margins, settings));
  // #231 item 3 — an under-surface void is a property of the blank the operator must know about
  // before probing Z, so each one is stated up front with the material left over it.
  for (const ko of diagram.keepOuts) {
    // #285 review — the number below is the SMALLER of the void's own ceiling and the blank's
    // `thickness − minFloor`, so naming the void as its author is wrong whenever the blank's floor
    // binds. The sheet says which of the two is doing the limiting rather than leaving the operator
    // to guess, because the two have different fixes (pour a thicker blank vs. move the pocket).
    const parts = keepOutLimitParts(job, ko.solidThickness, margins.boundaryMargin);
    const byStockFloor = parts.stockFloor < parts.overVoid;
    needSteps.push({
      text:
        `Under-surface void — ${ko.name}. The blank is only ${fmtNum(ko.solidThickness)} mm thick ` +
        'over it: do not cut through.',
      value:
        `deepest cut ${fmtNum(parts.limit)} mm` +
        (byStockFloor ? ` (the blank’s own ${fmtNum(job.minFloor)} mm floor, not the void, sets this)` : ''),
    });
  }

  // ---- 2 · Mount the vise (⚠ #208) -----------------------------------------------------------
  const UNVERIFIED = '#208';
  const mountSteps: RunSheetStep[] = [
    {
      text: 'Remove the MDF wasteboard. Seat the vise on its two locating pins; fasten with six M5×20 screws.',
      unverified: UNVERIFIED,
    },
    { text: 'The fixed jaw is on the left.', unverified: UNVERIFIED },
  ];

  // ---- 3 · Load the blank --------------------------------------------------------------------
  const frontGap = -vise.jawStartY;
  // #213 §6 — `under` drives both the assembly steps in §3 and the wording of §5's datum: with a
  // board in the stack "the blank" is ambiguous, so those steps say "the part" and NAME the board
  // as the face Z0 must not be probed on. Without one, the sheet says what it always said.
  const under = job.sacrificial.under;
  const onBoard = under !== null;
  const loadSteps: RunSheetStep[] = [
    // #213 §6 — with sacrificial material the thing loaded is an assembly, and the order matters:
    // the part is fixed to the board/strips BEFORE it goes between the jaws, and the strips sit
    // between the jaw face and the part so the jaws bear on them, not on the part.
    ...(under
      ? [
          {
            text: `Fix the part to the board before loading — the board goes in with it.`,
            value: `${fmtNum(under.thickness)} mm board, fixed with ${under.attach}`,
          } as RunSheetStep,
        ]
      : []),
    ...(['left', 'right'] as const)
      .filter((pos) => job.sacrificial.sides[pos] !== null)
      .map((pos): RunSheetStep => {
        const strip = job.sacrificial.sides[pos]!;
        return {
          text: `Put the ${pos} strip between the ${pos === 'left' ? 'fixed' : 'moving'} jaw and the part — the jaw clamps the strip, not the part.`,
          value: `${fmtNum(strip.thickness)} mm strip`,
        };
      }),
    {
      text: "The blank's length runs left–right between the jaws. The face to be engraved is up.",
      value: `${fmtNum(length)} mm`,
    },
    {
      text:
        `The ${onBoard ? "part's " : ''}top face must stand ${fmtNum(vise.stockProud)} mm above the jaw tops. Record the measured ` +
        stopWords,
      record: 'measured stock proud (mm)',
    },
    {
      text: `Push the blank's front edge to where the file expects it: the front edge is ${fmtNum(frontGap)} mm behind the front of the jaws.`,
    },
    { text: 'Tighten. Check the blank does not rock.' },
  ];

  // ---- 4 · Fit the cutter and measure its length (⚠ #208) ------------------------------------
  const cutterSteps: RunSheetStep[] = [
    {
      text: 'Fit the cutter with its collar. Run tool-length calibration from Studio (M491).',
      unverified: UNVERIFIED,
    },
    {
      text:
        'Do not skip this because the program contains T1 M6. If the machine already believes tool 1 ' +
        'is fitted, that line does nothing.',
      unverified: UNVERIFIED,
    },
  ];

  // ---- 5 · Set the work origin (⚠ #208) ------------------------------------------------------
  // #391 — where the origin IS, then how the operator checks it against the blank actually in the
  // jaws. One section, because they are one task: a corrected origin is corrected on the spot.
  //
  // The second half is HELD (`RunSheetOptions.materialScan`): it prints only when the caller asks for
  // it, and nothing in the app or the bench generator does. The plan is sound; the steps an operator
  // would follow are not yet safe, which is what #391's review of 36f3837 lists — a travel cap with
  // no field behind it, a tip diameter stated as fact, a correction direction that reads back to
  // front, and bisection that covers one direction only. Holding one array entry is the whole change:
  // `materialScan.ts` and its spec are untouched, so the block comes back the moment the fixes land.
  const originSteps: RunSheetStep[] = [
    ...registrationSteps(job, onBoard, UNVERIFIED),
    ...(options.materialScan === true ? materialPositionSteps(job, onBoard, UNVERIFIED) : []),
  ];

  // ---- 6 · Dry run ---------------------------------------------------------------------------
  // #244 — the frame file replaces the manual "raise Z by 20 mm" offset. Its Z is baked in, so
  // there is nothing for the operator to set (or to forget to clear), and it is a separate file,
  // so it cannot be confused with the job. The 20 mm height itself is `FRAME_Z` above, the figure
  // #207 specified.
  //
  // A null `frameNc` is not hypothetical (#273): a job program the verifier refuses comes back
  // with `nc` and `verify` populated but NO frame (the frame is derived after both gates), and
  // the sheet opens on exactly that — it is only blocked when the job has since changed. Telling
  // the operator here to load a file that was never produced is worse than saying nothing, so the
  // step is replaced rather than augmented.
  const dryRunSteps: RunSheetStep[] =
    generated.frameNc === null
      ? [
          {
            text:
              'There is no frame file for this job: the program above did not pass verification, so ' +
              'the trace was never produced. Do not run this file — clear the errors, regenerate, and ' +
              'the frame comes back with the program.',
            bold: true,
          },
        ]
      : [
          {
            text:
              `Load ${runSheetFrameFileName(job.name)} and run it. The cutter traces the job's outline in ` +
              `the air, ${fmtNum(FRAME_Z)} mm above the work — no Z offset to set. Watch that the trace ` +
              'stays over the blank and clear of the jaws.',
            value: `${fmtNum(FRAME_Z)} mm above the work`,
          },
          {
            text: `If the trace is not where the job should land, stop and change the job. Otherwise load ${header.fileName} and cut.`,
          },
        ];

  // ---- 7 · Cut -------------------------------------------------------------------------------
  const cutSteps: RunSheetStep[] = [];
  if (params !== null) {
    cutSteps.push({
      text: `Spindle, feed, plunge, passes and step-down. Vacuum ${params.air ? 'on' : 'off'}.`,
      value:
        `${params.rpm} RPM · ${fmtNum(params.feed)} mm/min feed · ${fmtNum(params.plungeFeed)} mm/min ` +
        `plunge · ${generated.cam?.passes ?? 1} × ${fmtNum(params.stepDown)} mm passes · ` +
        `${fmtNum(params.stepOver)} mm step-over`,
    });
  } else {
    cutSteps.push({ text: 'Cutting parameters were not resolved for this job.' });
  }
  for (const item of items) {
    // #231 item 3 — say which cut sits over a void, and the depth the material there allows,
    // so the item name no longer has to smuggle the distinction onto the sheet.
    const over = keepOutOver(job, itemBox.get(item.id), diagram.keepOuts, margins.boundaryMargin);
    const note = over
      ? ` — over "${over.name}", only ${fmtNum(over.solidThickness)} mm of material` +
        (item.depth > keepOutLimit(job, over.solidThickness, margins.boundaryMargin)
          ? ` (DEEPER than the ${fmtNum(keepOutLimit(job, over.solidThickness, margins.boundaryMargin))} mm the void allows)`
          : ` (deepest cut there ${fmtNum(keepOutLimit(job, over.solidThickness, margins.boundaryMargin))} mm)`)
      : '';
    cutSteps.push({
      text: `${item.name}${note}${depthSourceWords(job, item, margins.boundaryMargin, measure)}`,
      value: `${fmtNum(item.depth)} mm deep`,
    });
  }
  cutSteps.push({
    text: 'Stay at the machine. Stop it if the sound changes, the blank moves, or the cutter loads up.',
  });

  // ---- 8 · Warnings carried from the app -----------------------------------------------------
  const warnings: RunSheetStep[] = [];
  const seen = new Set<string>();
  /**
   * Where the `vise-default` warning landed, so §8 can open with it in bold. Recorded by CODE as
   * the warning is pushed, never by matching its words: the message is prose that changes when the
   * facts do (it stopped saying "unmeasured defaults" on 2026-10-15), and a `findIndex` over prose
   * fails SILENTLY — a wording edit would leave the section un-opened with nothing to show for it.
   */
  let viseWarningAt = -1;
  const pushWarning = (code: string, message: string): void => {
    const key = `${code}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (code === 'vise-default' && viseWarningAt < 0) viseWarningAt = warnings.length;
    warnings.push({ text: message });
  };
  for (const f of generated.findings) {
    if (f.severity === 'warning') pushWarning(f.code, f.message);
  }
  if (generated.verify) {
    for (const f of generated.verify.findings) {
      if (f.severity === 'warning') pushWarning(f.code, f.message);
    }
  }
  if (sim) {
    for (const d of sim.diagnostics) {
      if (d.severity === 'warning') pushWarning(d.code, d.message);
    }
    // #243 — the coverage sentence, from the same builder the Simulate panel prints: which
    // geometry the sweep was given and which it never saw, and whether this run swept at all.
    // It appears whenever a simulation is part of the run (a `sim` is passed), never when the
    // caller says there was none.
    for (const sentence of coverageDisclaimer(coverageFor(job, generated, sim))) pushWarning('coverage', sentence);
  }
  // "If the vise is the shipped default, this section opens with that, in bold."
  if (isViseDefault(vise) && viseWarningAt >= 0) {
    const [viseWarning] = warnings.splice(viseWarningAt, 1);
    viseWarning!.bold = true;
    warnings.unshift(viseWarning!);
  }
  if (warnings.length === 0) warnings.push({ text: 'No warnings were raised.' });

  // ---- 9 · Record afterwards -----------------------------------------------------------------
  // #277 — the same list the run record file's `depths` array is built from, so the blanks printed
  // here and the fields the readback answers are one list.
  const recordSteps: RunSheetStep[] = recordDepths(plan).map((item) => ({
    text: `Measured floor depth — ${item.name}`,
    record: 'measured depth (mm)',
  }));
  recordSteps.push(
    { text: 'Is the text legible?', record: 'yes / no' },
    { text: 'Surface finish', record: 'clean / fuzzy / burnt' },
    { text: 'Anything that went wrong', record: 'notes' },
  );

  return {
    header,
    sections: [
      { id: 'need', title: '1 · What you need', steps: needSteps },
      { id: 'mount', title: '2 · Mount the vise', steps: mountSteps },
      { id: 'load', title: '3 · Load the blank', steps: loadSteps },
      { id: 'cutter', title: '4 · Fit the cutter and measure its length', steps: cutterSteps },
      { id: 'origin', title: '5 · Set the work origin', steps: originSteps },
      { id: 'dry-run', title: '6 · Dry run', steps: dryRunSteps },
      { id: 'cut', title: '7 · Cut', steps: cutSteps },
      { id: 'warnings', title: '8 · Warnings carried from the app', steps: warnings },
      { id: 'record', title: '9 · Record afterwards', steps: recordSteps },
    ],
    diagram,
    // Absent rather than null for a job without sacrificial material, so its sheet — and the
    // snapshot of it — is byte-identical to before this field existed.
    ...(stackUp ? { stackUp } : null),
  };
}

// ---------------------------------------------------------------------------------------------
// The origin diagram, as SVG
// ---------------------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Diagram margin around the drawn geometry, mm. */
const DIAGRAM_PAD = 8;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A top view of the stock with the jaws either side, the origin at the front-left corner, X and
 * Y arrows, and every item's bounding box with its depth written on it. Pure string output, so
 * the whole sheet is testable without a DOM.
 *
 * The job frame has +Y AWAY from the operator; SVG y runs DOWN the page, so the viewBox is
 * anchored at `-ymax` and every job-frame point maps to `(x, -y)` — that is why the stock's
 * front edge (job y = 0) sits at the bottom of the drawing.
 */
export function runSheetDiagramSvg(diagram: RunSheetDiagram): string {
  const { length, width } = diagram.stock;
  const xs: number[] = [0, length];
  const ys: number[] = [0, width];
  for (const jaw of diagram.jaws) {
    xs.push(jaw.min[0], jaw.max[0]);
    ys.push(jaw.min[1], jaw.max[1]);
  }
  for (const item of diagram.items) {
    xs.push(item.min[0], item.max[0]);
    ys.push(item.min[1], item.max[1]);
  }
  for (const ko of diagram.keepOuts) {
    xs.push(ko.min[0], ko.max[0]);
    ys.push(ko.min[1], ko.max[1]);
  }
  const xmin = Math.min(...xs) - DIAGRAM_PAD;
  const xmax = Math.max(...xs) + DIAGRAM_PAD;
  const ymin = Math.min(...ys) - DIAGRAM_PAD;
  const ymax = Math.max(...ys) + DIAGRAM_PAD;

  const rect = (min: [number, number], max: [number, number], cls: string, extra: string): string => {
    const x = min[0];
    const y = -max[1]; // flip job-frame Y
    const w = max[0] - min[0];
    const h = max[1] - min[1];
    return `<rect ${extra} class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" />`;
  };

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="${SVG_NS}" viewBox="${xmin} ${-ymax} ${xmax - xmin} ${ymax - ymin}" ` +
      `class="run-sheet-svg" role="img" aria-label="Top view of the stock, the vise jaws and the work origin">`,
  );
  parts.push(
    `<defs><marker id="run-sheet-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">` +
      `<path d="M0,0 L6,3 L0,6 z" class="run-sheet-arrowhead" /></marker></defs>`,
  );

  // The stock outline.
  parts.push(rect([0, 0], [length, width], 'run-sheet-stock', 'data-stock="true"'));
  parts.push(
    `<text class="run-sheet-label" x="${length / 2}" y="${-width - 2}" text-anchor="middle">` +
      `${fmtNum(length)} × ${fmtNum(width)} mm stock</text>`,
  );

  // The jaws.
  for (const jaw of diagram.jaws) {
    parts.push(rect(jaw.min, jaw.max, 'run-sheet-jaw', `data-jaw-id="${escapeXml(jaw.id)}"`));
    parts.push(
      `<text class="run-sheet-label" x="${(jaw.min[0] + jaw.max[0]) / 2}" y="${-((jaw.min[1] + jaw.max[1]) / 2)}" ` +
        `text-anchor="middle">${escapeXml(jaw.label)}</text>`,
    );
  }

  // #231 — the under-surface voids, drawn DASHED (they are missing material, not cuts) and
  // BEFORE the items so an item's box stays legible over the void. The presentation is inline
  // because the sheet's own CSS lives in the panel (owned by another slot) and this SVG must
  // render correctly from `runSheet.ts` alone.
  for (const ko of diagram.keepOuts) {
    parts.push(
      rect(
        ko.min,
        ko.max,
        'run-sheet-keepout',
        `data-keepout-id="${escapeXml(ko.id)}" fill="none" stroke="#a00" stroke-width="0.5" stroke-dasharray="2 1.2"`,
      ),
    );
    const cx = (ko.min[0] + ko.max[0]) / 2;
    const cy = -((ko.min[1] + ko.max[1]) / 2);
    parts.push(
      `<text class="run-sheet-keepout-label" x="${cx}" y="${cy}" text-anchor="middle" font-size="3" fill="#a00">` +
        `${escapeXml(ko.name)} · ${fmtNum(ko.solidThickness)} mm over</text>`,
    );
  }

  // The origin and the X / Y arrows.
  const [ox, oy] = diagram.origin;
  parts.push(`<circle class="run-sheet-origin" cx="${ox}" cy="${-oy}" r="1.2" />`);
  parts.push(
    `<text class="run-sheet-origin-label" x="${ox + 1.6}" y="${-oy + 3.2}">X0 Y0 (front-left, top face)</text>`,
  );
  const arrowX = Math.min(14, length);
  const arrowY = Math.min(14, width);
  parts.push(
    `<line class="run-sheet-axis" x1="${ox}" y1="${-oy}" x2="${ox + arrowX}" y2="${-oy}" marker-end="url(#run-sheet-arrow)" />`,
  );
  parts.push(`<text class="run-sheet-axis-label" x="${ox + arrowX + 1}" y="${-oy + 1.2}">X</text>`);
  parts.push(
    `<line class="run-sheet-axis" x1="${ox}" y1="${-oy}" x2="${ox}" y2="${-oy - arrowY}" marker-end="url(#run-sheet-arrow)" />`,
  );
  parts.push(`<text class="run-sheet-axis-label" x="${ox - 1}" y="${-oy - arrowY - 1}">Y</text>`);

  // Every item's bounding box, with its depth written on it.
  for (const item of diagram.items) {
    const x = item.min[0];
    const y = -item.max[1];
    const w = item.max[0] - item.min[0];
    const h = item.max[1] - item.min[1];
    parts.push(
      `<rect data-item-id="${escapeXml(item.id)}" class="run-sheet-item" x="${x}" y="${y}" width="${w}" height="${h}">` +
        `<title>${escapeXml(item.name)}</title></rect>`,
    );
    const cx = (item.min[0] + item.max[0]) / 2;
    const cy = -((item.min[1] + item.max[1]) / 2);
    parts.push(
      `<text class="run-sheet-item-depth" x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central">` +
        `${fmtNum(item.depth)} mm</text>`,
    );
  }

  parts.push('</svg>');
  return parts.join('');
}

// ---------------------------------------------------------------------------------------------
// The stack-up elevation, as SVG (#213 §6)
// ---------------------------------------------------------------------------------------------

/** Margin around the stack-up, mm. */
const STACKUP_PAD = 6;

/**
 * The side view of the setup, so the operator can see the assembly they are about to clamp: the
 * jaws at their shifted faces, the board under the part, the strips between the jaw and the part,
 * each with its own thickness, and the Z = 0 datum on the PART's top face.
 *
 * Pure string output, like the origin diagram, so the whole sheet is testable without a DOM. X is
 * the job's X (left to right); the viewBox anchors at `-zmax` because SVG y runs down and the job's
 * Z runs up, so the part's top face (Z = 0) is at the TOP of the drawing.
 *
 * A box taller than it is wide (a jaw, a narrow strip) gets its label rotated 90°, or the text
 * would be wider than the box it names.
 */
export function runSheetStackUpSvg(stackUp: RunSheetStackUp): string {
  const xs: number[] = [];
  const zs: number[] = [stackUp.datumZ];
  for (const b of stackUp.boxes) {
    xs.push(b.minX, b.maxX);
    zs.push(b.minZ, b.maxZ);
  }
  const xmin = Math.min(...xs) - STACKUP_PAD;
  const xmax = Math.max(...xs) + STACKUP_PAD;
  const zmin = Math.min(...zs) - STACKUP_PAD;
  const zmax = Math.max(...zs) + STACKUP_PAD;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="${SVG_NS}" viewBox="${xmin} ${-zmax} ${xmax - xmin} ${zmax - zmin}" ` +
      `class="run-sheet-svg run-sheet-stackup" role="img" ` +
      `aria-label="Side view of the setup: the vise jaws, the sacrificial board and strips, and the part">`,
  );

  for (const b of stackUp.boxes) {
    const w = b.maxX - b.minX;
    const h = b.maxZ - b.minZ;
    const cls = b.sacrificial
      ? 'run-sheet-stackup-sacrificial'
      : b.id.startsWith('vise-')
        ? 'run-sheet-jaw'
        : 'run-sheet-stackup-part';
    const title = b.dimension === null ? b.label : `${b.label} — ${b.dimension}`;
    parts.push(
      `<rect data-stackup-id="${escapeXml(b.id)}" class="${cls}" x="${b.minX}" y="${-b.maxZ}" ` +
        `width="${w}" height="${h}"><title>${escapeXml(title)}</title></rect>`,
    );

    const cx = (b.minX + b.maxX) / 2;
    const cy = -((b.minZ + b.maxZ) / 2);
    const text = b.dimension === null ? b.label : `${b.label} · ${b.dimension}`;
    // Rotate when the box is taller than wide, so the label fits inside what it names.
    const transform = h > w ? ` transform="rotate(-90 ${cx} ${cy})"` : '';
    parts.push(
      `<text class="run-sheet-stackup-label" x="${cx}" y="${cy}" text-anchor="middle" ` +
        `dominant-baseline="central"${transform}>${escapeXml(text)}</text>`,
    );
  }

  // The datum: Z0 on the part's top face. Drawn last so it reads over every box.
  parts.push(
    `<line class="run-sheet-stackup-datum" x1="${xmin}" y1="${-stackUp.datumZ}" ` +
      `x2="${xmax}" y2="${-stackUp.datumZ}" />`,
  );
  parts.push(
    `<text class="run-sheet-stackup-datum-label" x="${xmin + 1}" y="${-stackUp.datumZ - 1.2}">` +
      `Z0 — the part's top face</text>`,
  );

  parts.push('</svg>');
  return parts.join('');
}
