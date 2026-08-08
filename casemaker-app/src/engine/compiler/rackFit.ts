import type { RackParams } from '@/types';
import type { PlacementIssue } from './placementValidator';
import {
  computeRackDims,
  accessorySlots,
  SLOT_PITCH,
  SIDE_T,
  LONG_SHELF,
  MID_BAR_MIN_DEPTH,
} from './rack';

/**
 * Printer build-volume fit checking for the rack archetype. The original
 * sample ("Mini Rack", Prusa XL only) simply didn't fit smaller printers;
 * our parametric version instead tells the user exactly WHICH part is the
 * blocker and what rack dimensions their printer CAN produce.
 *
 * Footprints are computed in each part's PRINT orientation (flat on the
 * bed), not its assembly orientation, and a part counts as fitting if it
 * fits straight OR rotated diagonally across the bed.
 */

export interface PrinterPreset {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
}

export const PRINTER_PRESETS: PrinterPreset[] = [
  { id: 'a1-mini', name: 'Bambu A1 mini (180³)', x: 180, y: 180, z: 180 },
  { id: 'prusa-mini', name: 'Prusa MINI+ (180³)', x: 180, y: 180, z: 180 },
  { id: 'ender-3', name: 'Ender-3 class (220×220×250)', x: 220, y: 220, z: 250 },
  { id: 'prusa-mk4', name: 'Prusa MK4/MK3 (250×210×220)', x: 250, y: 210, z: 220 },
  { id: 'bambu-256', name: 'Bambu X1/P1/A1 (256³)', x: 256, y: 256, z: 256 },
  { id: 'prusa-xl', name: 'Prusa XL (360³)', x: 360, y: 360, z: 360 },
];

/**
 * Does a p×q rectangle fit on an a×b bed, allowing 90° and diagonal
 * rotation? Straight placement first; otherwise the classic rotated-
 * rectangle bound: for p > a (long side over bed width), the rectangle
 * fits at some angle iff
 *   b ≥ (2·p·q·a + (p² − q²)·√(p² + q² − a²)) / (p² + q²).
 */
export function rectFitsBed(p0: number, q0: number, a0: number, b0: number): boolean {
  const p = Math.max(p0, q0);
  const q = Math.min(p0, q0);
  const a = Math.max(a0, b0);
  const b = Math.min(a0, b0);
  if (p <= a && q <= b) return true;
  if (q > b) return false; // even the short part side exceeds the short bed side
  // Here p > a (straight placement failed with q ≤ b), which guarantees the
  // discriminant below is positive.
  const d2 = p * p + q * q - a * a;
  const need = (2 * p * q * a + (p * p - q * q) * Math.sqrt(d2)) / (p * p + q * q);
  return need <= b + 1e-9;
}

interface PartFootprint {
  id: string;
  label: string;
  /** Bed footprint in the part's print orientation. */
  fx: number;
  fy: number;
  /** Print height. */
  fz: number;
}

/** Per-part print footprints for the current rack configuration. */
export function rackPartFootprints(rack: RackParams): PartFootprint[] {
  const dims = computeRackDims(rack);
  const wallMount = rack.wallMount ?? 'none';
  const sideH = wallMount === 'ears' ? SIDE_T + 28 : SIDE_T;
  const out: PartFootprint[] = [
    {
      id: 'rack-side-left',
      label: 'side panel',
      fx: dims.depth,
      fy: dims.totalH,
      fz: sideH,
    },
    {
      id: 'rack-top',
      label: 'top/bottom plate',
      fx: dims.plateW + 22,
      fy: dims.depth,
      fz: 5,
    },
  ];
  // Accessories span BETWEEN the sides (recessed behind the front columns).
  const accW = dims.plateW + 2;
  (rack.accessories ?? []).forEach((acc, i) => {
    const n = accessorySlots(acc);
    if (acc.type === 'shelf') {
      out.push({
        id: `rack-shelf-${i}`,
        label: `shelf (${n}-slot)`,
        fx: accW,
        fy: acc.shelfDepth ?? 123,
        fz: n * SLOT_PITCH,
      });
    } else if (acc.type === 'cable-tray') {
      out.push({ id: `rack-cable-tray-${i}`, label: 'cable tray', fx: accW, fy: 104, fz: 33 });
    } else {
      out.push({
        id: `rack-${acc.type}-${i}`,
        label: acc.type === 'keystone' ? 'keystone plate' : `blank faceplate (${n}-slot)`,
        fx: accW,
        fy: n * SLOT_PITCH,
        fz: acc.type === 'keystone' ? 10 : 16,
      });
    }
  });
  if (wallMount === 'cleat') {
    out.push({ id: 'rack-wall-cleat', label: 'wall cleat', fx: dims.width, fy: 40, fz: 15 });
  }
  return out;
}

/** Largest rack width whose widest part still fits. The governing part is
 *  now the top/bottom plate (width − 2·SIDE_T + snap tabs ≈ width − 8).
 *  Also drives the RackPanel width slider's upper bound. */
export function maxRackWidthForBed(bedX: number, bedY: number): number {
  let lo = 120;
  let hi = 600;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (rectFitsBed(mid - 8, 60, bedX, bedY)) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo);
}

/** Largest rack depth that still fits the bed at the given width and slot
 *  count. Depth is governed by two parts: the side panel (depth × height)
 *  and the top/bottom plate (≈width × depth). Drives the RackPanel depth
 *  slider's upper bound. */
export function maxRackDepthForBed(
  width: number,
  slots: number,
  bedX: number,
  bedY: number,
): number {
  const sideH = 5 + slots * SLOT_PITCH + 11;
  const plateSpan = width - 2 * SIDE_T + 22; // plate + snap tabs
  const fits = (d: number): boolean =>
    rectFitsBed(d, sideH, bedX, bedY) && rectFitsBed(plateSpan, d, bedX, bedY);
  if (!fits(80)) return 0;
  let lo = 80;
  let hi = 600;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo);
}

/** Largest slot count whose side panel still fits the bed.
 *  Also drives the RackPanel height slider's upper bound. */
export function maxRackSlotsForBed(depth: number, bedX: number, bedY: number): number {
  for (let s = 40; s >= 2; s--) {
    const h = 5 + s * SLOT_PITCH + 11;
    if (rectFitsBed(depth, h, bedX, bedY)) return s;
  }
  return 0;
}

/**
 * Fit-check every part against the configured printer. Returns banner-ready
 * placement issues: one error per non-fitting part plus a summary suggestion,
 * and the wall-mount load guidance when relevant.
 */
export function validateRackFit(rack: RackParams): PlacementIssue[] {
  const issues: PlacementIssue[] = [];
  const dims = computeRackDims(rack);

  const totalSlots = (rack.accessories ?? []).reduce((s, a) => s + accessorySlots(a), 0);
  if (totalSlots > dims.slots) {
    issues.push({
      severity: 'warning',
      kind: 'rack-config',
      involves: ['rack'],
      message: `Accessories occupy ${totalSlots} slots but the rack has ${dims.slots} — remove accessories or increase the rack height.`,
    });
  }

  // NOTE: wall-mount usage guidance intentionally does NOT go through this
  // report — a permanent warning banner blocks viewport controls. The
  // RackPanel shows the guidance inline under the Mounting picker instead;
  // this validator only reports actionable problems.

  // Long/extra-deep shelves screw into the sides' mid bar — which only
  // exists when the rack is deep enough to have one.
  const hasLongShelf = (rack.accessories ?? []).some(
    (a) => a.type === 'shelf' && (a.shelfDepth ?? 123) >= LONG_SHELF,
  );
  if (hasLongShelf && dims.depth < MID_BAR_MIN_DEPTH) {
    issues.push({
      severity: 'warning',
      kind: 'rack-config',
      involves: ['rack'],
      message: `Long/extra-deep shelves anchor into the sides' middle bar, which needs a rack depth of at least ${MID_BAR_MIN_DEPTH} mm (currently ${Math.round(dims.depth)}) — deepen the rack or switch to short shelves.`,
    });
  }

  const printer = rack.printer;
  if (!printer) return issues;

  const blocked: string[] = [];
  for (const part of rackPartFootprints(rack)) {
    const fitsBed = rectFitsBed(part.fx, part.fy, printer.x, printer.y);
    const fitsZ = part.fz <= printer.z;
    if (fitsBed && fitsZ) continue;
    blocked.push(part.label);
    issues.push({
      severity: 'error',
      kind: 'printer-fit',
      involves: [part.id],
      message: `${part.label} needs ${Math.ceil(part.fx)}×${Math.ceil(part.fy)}×${Math.ceil(part.fz)} mm but the printer bed is ${printer.x}×${printer.y}×${printer.z} mm${
        fitsBed ? '' : ' (even placed diagonally)'
      }.`,
    });
  }
  if (blocked.length > 0) {
    const maxW = maxRackWidthForBed(printer.x, printer.y);
    const maxS = maxRackSlotsForBed(Math.min(dims.depth, maxW), printer.x, printer.y);
    issues.push({
      severity: 'error',
      kind: 'printer-fit',
      involves: ['rack'],
      message: `This printer could fit a rack up to ≈${maxW} mm wide/deep with up to ${maxS} slots — reduce width/depth/slots, or pick a larger printer preset.`,
    });
  }
  return issues;
}
