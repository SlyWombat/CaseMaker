import { ASSUMED_RAPID_MM_MIN } from '@/engine/cnc/cam/ir';
import { aabbOfProfile } from '@/engine/compiler/profile';
import { jobTool, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { toPartPlan, type PartPlan } from '@/engine/cnc/engrave/partPlan';
import type { FeedsResult } from '@/engine/cnc/feeds';
import { viseEnvelope } from '@/engine/cnc/fixture';
import { Z1 } from '@/engine/cnc/machine';
import { hasSacrificial, viseJawShift } from '@/engine/cnc/sacrificial';
import type { VerifyReport } from '@/engine/cnc/verify';
// #243 — the blind-spot sentence is the Simulate panel's OWN builder, imported rather than
// re-worded, so the sheet and the panel cannot disagree about what the sweep did not see.
import { coverageDisclaimer, type SimCoverageInput, type SimRunOutcome } from '@/components/panels/simCoverage';
import type { EngraveJob, ViseParams } from '@/types/engraveJob';
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
 * assignable. `estimatedSeconds` is the CYCLE estimate — cutting PLUS rapids at
 * `ASSUMED_RAPID_MM_MIN` (#242).
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
  /** Label of a blank the operator fills in. */
  record?: string;
  /**
   * The issue that will confirm this step on the machine, e.g. `'#208'`. PRESENT means the step
   * is an assumption, not a measured fact; the view must show the tag.
   */
  unverified?: string;
  /** Render the step's text bold. The unmeasured-vise warning opens section 8 this way. */
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
}

/**
 * The note beside the header's time estimate (#242). The number is a CYCLE estimate — cutting
 * plus rapids at `ASSUMED_RAPID_MM_MIN` — so it is a planning figure, not a measured cycle time.
 * Built from the constant so the printed rate cannot drift from the one the estimate uses.
 */
export const RAPID_ASSUMPTION_NOTE =
  `cutting + rapids at an assumed ${ASSUMED_RAPID_MM_MIN} mm/min — a planning estimate, not a measured cycle time.`;

export interface RunSheetHeader {
  jobName: string;
  /** ISO date (`YYYY-MM-DD`) the sheet was generated. */
  generatedOn: string;
  /** The sanitised job name plus `.nc` — the file the operator loads. */
  fileName: string;
  /** First 8 hex of SHA-256 of the `.nc` text, so the sheet can be matched to the file. */
  fileHash: string;
  /** Formatted cycle estimate, from `generated.cam.estimatedSeconds`. */
  estimatedTime: string;
  /** Always `RAPID_ASSUMPTION_NOTE` — says the number is a planning estimate (#242). */
  estimatedTimeNote: string;
}

export interface RunSheet {
  header: RunSheetHeader;
  sections: RunSheetSection[];
  /** Placed inside section 5 in the view. */
  diagram: RunSheetDiagram;
}

// ---------------------------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------------------------

/** '2' for 2.0, '0.5' for 0.5, '12.346' for a value that needs rounding. Trailing zeros trimmed. */
function fmtNum(n: number): string {
  return String(Number(n.toFixed(3)));
}

const MATERIAL_LABEL: Record<EngraveJob['stock']['material'], string> = {
  softwood: 'softwood',
  hardwood: 'hardwood',
  mdf: 'MDF',
  pla: 'PLA',
};

/** Cutting diameter of a tool, best effort (`tipDiameter ?? diameter`, as `EngravePanel` does). */
function cuttingDiameter(tool: NonNullable<ReturnType<typeof jobTool>>): number | null {
  return tool.tipDiameter ?? tool.diameter;
}

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
 * Every item that will actually cut (#214/#215), in plan order and with its resolved stock-frame
 * profile. `toPartPlan` is the one funnel all three item lists go through, so a `border`, `frame`
 * or `cutaway` is here too, while a `construction` item, a broken reference and a
 * self-intersecting polygon — none of which produces a region — are absent. The sheet therefore
 * describes exactly the cuts the `.nc` makes, no more and no fewer.
 */
function cutItems(job: EngraveJob): PartPlan['engraves'] {
  return toPartPlan(job).engraves;
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

/** The top-view origin diagram's plain geometry, derived from the job and its cut regions. */
function buildDiagram(job: EngraveJob, cut: PartPlan['engraves']): RunSheetDiagram {
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
  for (const item of cut) {
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
  };
}

/** The unmeasured-vise warning text — the same wording `validateJob` uses (`jobSetup.ts`). */
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
 * the sheet names ARE the ones the sweep was given. `holderKnown` is the machine's own answer
 * (`Z1.holder` is null), and the tool name comes from the job's cutter.
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
    holderKnown: Z1.holder !== null,
    toolName: jobTool(job)?.name ?? null,
    codes: [...codes],
  };
}

export function buildRunSheet(
  job: EngraveJob,
  generated: RunSheetGenerated,
  sim: RunSheetSim | null,
  now: Date = new Date(),
): RunSheet {
  const { length, width, thickness, material } = job.stock;
  const vise = job.workholding.vise;
  const items = cutItems(job);
  const deepest = items.reduce((max, item) => Math.max(max, item.depth), 0);
  const stopBelow = deepest + 1; // #207 section 3: below the deepest cut + 1 mm the cutter is under the jaw tops
  const tool = jobTool(job);
  const diameter = tool ? cuttingDiameter(tool) : null;
  const params = generated.feeds && generated.feeds.ok ? generated.feeds.params : null;
  const nc = generated.nc;
  const header: RunSheetHeader = {
    jobName: job.name,
    generatedOn: now.toISOString().slice(0, 10),
    fileName: runSheetFileName(job.name),
    fileHash: nc === null ? '' : sha256Hex(nc).slice(0, 8),
    estimatedTime: generated.cam ? formatDuration(generated.cam.estimatedSeconds) : 'unknown',
    estimatedTimeNote: RAPID_ASSUMPTION_NOTE,
  };

  // ---- 1 · What you need ---------------------------------------------------------------------
  const needSteps: RunSheetStep[] = [
    {
      text:
        'The blank. Measure it. If it differs by more than 0.5 mm in any dimension, change the job ' +
        'and regenerate — do not run this file.',
      value: `${fmtNum(length)} × ${fmtNum(width)} × ${fmtNum(thickness)} mm ${MATERIAL_LABEL[material]}`,
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
        'The Z1 low-profile vise, and the Makera 3D Probe — the one rated for non-conductive ' +
        'material, NOT the 3D Probe Rod that came in the box.',
    },
  ];
  const sac = sacrificialSummary(job);
  if (sac !== null) needSteps.push({ text: 'Sacrificial material:', value: sac });

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
  const loadSteps: RunSheetStep[] = [
    {
      text: "The blank's length runs left–right between the jaws. The face to be engraved is up.",
      value: `${fmtNum(length)} mm`,
    },
    {
      text:
        `The top face must stand ${fmtNum(vise.stockProud)} mm above the jaw tops. Record the measured ` +
        `value. If it is less than ${fmtNum(stopBelow)} mm, stop: the cutter would work below the jaw tops.`,
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
  const originSteps: RunSheetStep[] = [
    { text: "X0: the blank's left face (against the fixed jaw).", unverified: UNVERIFIED },
    { text: "Y0: the blank's front edge.", unverified: UNVERIFIED },
    { text: "Z0: the blank's top face — probe it, or touch off on it.", unverified: UNVERIFIED },
    {
      text: 'X0 Y0 Z0 is the top-front-left corner of the blank. Move there and check by eye before going on.',
      unverified: UNVERIFIED,
    },
  ];

  // ---- 6 · Dry run ---------------------------------------------------------------------------
  // #244 — the frame file replaces the manual "raise Z by 20 mm" offset. Its Z is baked in, so
  // there is nothing for the operator to set (or to forget to clear), and it is a separate file,
  // so it cannot be confused with the job. The 20 mm height itself is `FRAME_Z` above, the figure
  // #207 specified.
  const dryRunSteps: RunSheetStep[] = [
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
      text: 'Spindle, feed, plunge, passes and step-down. Air on.',
      value:
        `${params.rpm} RPM · ${fmtNum(params.feed)} mm/min feed · ${fmtNum(params.plungeFeed)} mm/min ` +
        `plunge · ${generated.cam?.passes ?? 1} × ${fmtNum(params.stepDown)} mm passes · ` +
        `${fmtNum(params.stepOver)} mm step-over`,
    });
  } else {
    cutSteps.push({ text: 'Cutting parameters were not resolved for this job.' });
  }
  for (const item of items) {
    cutSteps.push({ text: item.name, value: `${fmtNum(item.depth)} mm deep` });
  }
  cutSteps.push({
    text: 'Stay at the machine. Stop it if the sound changes, the blank moves, or the cutter loads up.',
  });

  // ---- 8 · Warnings carried from the app -----------------------------------------------------
  const warnings: RunSheetStep[] = [];
  const seen = new Set<string>();
  const pushWarning = (code: string, message: string): void => {
    const key = `${code}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
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
  // "If the vise dimensions are unmeasured defaults, this section opens with that, in bold."
  const viseIndex = warnings.findIndex((s) => s.text.includes('unmeasured defaults'));
  if (isViseDefault(vise) && viseIndex >= 0) {
    const [viseWarning] = warnings.splice(viseIndex, 1);
    viseWarning!.bold = true;
    warnings.unshift(viseWarning!);
  }
  if (warnings.length === 0) warnings.push({ text: 'No warnings were raised.' });

  // ---- 9 · Record afterwards -----------------------------------------------------------------
  const recordSteps: RunSheetStep[] = items.map((item) => ({
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
    diagram: buildDiagram(job, items),
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
