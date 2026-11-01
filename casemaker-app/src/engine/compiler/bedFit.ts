import type { PrinterVolume } from '@/types/printer';

/**
 * Does a p×q rectangle fit on an a×b bed, allowing 90° and diagonal
 * rotation? Straight placement first; otherwise the classic rotated-
 * rectangle bound: for p > a (long side over bed width), the rectangle
 * fits at some angle iff
 *   b ≥ (2·p·q·a + (p² − q²)·√(p² + q² − a²)) / (p² + q²).
 *
 * A LEAF module on purpose: the split machinery (splitPart) and the rack's
 * own fit checks both need it, and `rackFit.ts` owns the rack's imports of
 * `rack.ts` — keeping the predicate here stops that from becoming a cycle
 * (#266). `rackFit` re-exports it for its existing callers.
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

/** A part's plan against a bed, the way every archetype asks it. */
export function partFitsBed(w: number, d: number, printer: PrinterVolume): boolean {
  return rectFitsBed(w, d, printer.x, printer.y);
}
