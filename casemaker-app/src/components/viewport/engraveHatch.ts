/**
 * §5.7 — the lost layer's hatch, as plain XY geometry.
 *
 * The design asks for a region "hatched amber", and the lost layer's contours can be many thin
 * slivers (a rounded corner, a closed counter, a dropped stroke). Drawing the fill alone would make
 * it read as one more floor; drawing the contour alone would lose the slivers at canvas scale. A
 * hatch is what says "this area is not cut" without competing with the depth ramp, so the spans are
 * computed here — pure, no three, no canvas — and the viewport only lifts them to the face's Z.
 *
 * The fill rule is EVEN-ODD over every ring, matching `executeProfile`'s default for the polygons
 * the preview receives: a letter's counter is its own ring and must stay unhatched. Each scan line
 * is `n·p = c` for the normal `n`; crossings are collected per ring, sorted along the line and
 * paired, which is the standard scan-line fill. The half-open test (`da < 0 ≤ db` or `db < 0 ≤ da`)
 * counts a vertex exactly once, so a line through a corner does not produce a zero-length span.
 */

/** One hatch span, in work-frame XY: `[from, to]`. */
export type HatchSegment = [[number, number], [number, number]];

/**
 * Spans of a hatch at `pitch` mm between the lines, `angleDeg` from the X axis.
 *
 * The phase is anchored at the coordinate origin rather than at the region's own bbox, so two
 * neighbouring lost regions hatch as one pattern instead of each starting a fresh line — the eye
 * reads them as regions of one face, not as separate objects. `pitch` must be positive; a
 * non-positive or non-finite pitch answers no spans rather than looping forever.
 */
export function hatchSegments(
  polygons: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  pitch: number,
  angleDeg = 45,
): HatchSegment[] {
  if (!(pitch > 0) || !Number.isFinite(pitch) || !Number.isFinite(angleDeg)) return [];

  const angle = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  // The line normal: `n·p` is constant along one hatch line.
  const nx = -dy;
  const ny = dx;

  let cMin = Infinity;
  let cMax = -Infinity;
  for (const ring of polygons) {
    for (const [x, y] of ring) {
      const c = x * nx + y * ny;
      if (c < cMin) cMin = c;
      if (c > cMax) cMax = c;
    }
  }
  if (!Number.isFinite(cMin) || !Number.isFinite(cMax)) return [];

  const out: HatchSegment[] = [];
  // `ceil` keeps the first line inside the bbox; the epsilon keeps a line that lands exactly on
  // cMax from being lost to floating-point drift in the loop's bound.
  const first = Math.ceil(cMin / pitch) * pitch;
  for (let c = first; c <= cMax + 1e-9; c += pitch) {
    const ts: number[] = [];
    for (const ring of polygons) {
      if (ring.length < 2) continue;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        const da = a[0] * nx + a[1] * ny - c;
        const db = b[0] * nx + b[1] * ny - c;
        // Half-open: an edge starting on the line counts when it heads negative, and one ending on
        // the line counts when it came from negative. A vertex is therefore crossed once.
        if (!((da < 0 && db >= 0) || (db < 0 && da >= 0))) continue;
        const s = da / (da - db);
        const x = a[0] + (b[0] - a[0]) * s;
        const y = a[1] + (b[1] - a[1]) * s;
        ts.push(x * dx + y * dy);
      }
    }
    // Even-odd: spans alternate outside → inside → outside.
    ts.sort((p, q) => p - q);
    for (let i = 0; i + 1 < ts.length; i += 2) {
      const t0 = ts[i]!;
      const t1 = ts[i + 1]!;
      if (t1 - t0 <= 1e-9) continue;
      out.push([
        [dx * t0 + nx * c, dy * t0 + ny * c],
        [dx * t1 + nx * c, dy * t1 + ny * c],
      ]);
    }
  }
  return out;
}
