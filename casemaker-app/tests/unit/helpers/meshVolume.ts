// The signed volume a triangle soup encloses — (1/6) Σ a·(b×c), the divergence-theorem volume.
//
// Two specs assert on winding with this arithmetic (`exportLayout.spec.ts` for the print flip,
// `snapLipWinding.spec.ts` for the snap-lip wedge) and each carried its own copy. One rule, one
// place: a mesh is outward-wound when the sum is positive, inverted when negative, and a
// partially-inverted mesh that cancels with itself lands near zero.

/** Positive for a closed, outward-wound mesh; negative for one wound inside-out. */
export function signedVolume(positions: Float32Array, indices: Uint32Array): number {
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const [ax, ay, az] = [positions[a]!, positions[a + 1]!, positions[a + 2]!];
    const [bx, by, bz] = [positions[b]!, positions[b + 1]!, positions[b + 2]!];
    const [cx, cy, cz] = [positions[c]!, positions[c + 1]!, positions[c + 2]!];
    // a · (b × c)
    sum +=
      ax * (by * cz - bz * cy) +
      ay * (bz * cx - bx * cz) +
      az * (bx * cy - by * cx);
  }
  return sum / 6;
}
