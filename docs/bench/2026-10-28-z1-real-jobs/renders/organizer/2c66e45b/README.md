# Organizer — the #960 newly-above re-run at `2c66e45b` (against 9f9011df)

- **Shas:** before `9f9011df` (the lever's baseline), after **2c66e45b** (the finish's band window =
  the cutter's reach; the delta since F's 68846cae review also includes edc4a6b6's old-grid floor
  and kink fallback, and B's f73e794b merged under).
- **Result: 0 newly-above cells.** 37,298 cells rose within the 0.1 mm band, **0 above it**; the
  worst rise is +0.500 mm at (36.1, 54.6), a cell already above the band (its leftover is 3.0 mm)
  — so no cell crosses the coverage line.
- Coverage 98.6111 → **98.6115 %**; adjudicated cut-into 0.04 → **0.00 %**; cycle 34,723 →
  **30,859 s** (D's figure); rapids/1k 20.1 → 22.0.
- Picture: `960-risen.png` — amber = risen within the band, red = risen above it (none). The
  risen cells sit on the pocket rims, where the new row phases differ from the base's.
- Tool: `tests/tools/risen-cells-960.ts` (the corrected sign), run on the two acceptance renders
  of this sha pair.
