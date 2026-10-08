// How much of the panel is screw-column boss?
const PITCH = 16.5, HEIGHT = 275, THICK = 15, SKIN = 6;
for (const d of [13, 11, 10, 9]) {
  const colFull = 2 * d * HEIGHT * THICK / 1000;
  const unpocketable = 2 * d * HEIGHT * (THICK - SKIN) / 1000;
  console.log(`boss dia ${d}: two columns occupy ${colFull.toFixed(0)} cm3 full-thickness; ${unpocketable.toFixed(0)} cm3 of that blocks the pocket (gap between bosses at ${PITCH} pitch: ${(PITCH - d).toFixed(1)} mm)`);
}
