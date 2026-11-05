# Tool tray — the standard render set at `5b73a6bb` (the #974 rim fix re-taken on v5)

- **Run:** `/tmp/e966-tip.sh 5b73a6bb` — `opsAcceptance959.spec.ts`, real STEP, Makera catalogue,
  #943 vise; **18 passed / 2 skipped, 664.18 s** for the pair.
- **Scored lines:** coverage **99.3442 %**; cut-into **0.00 % adjudicated** — raw **4.0204 %**:
  edge break **3.9603 %**, wall 0.0602 %, **shadow 0**; raw max 6.000 mm at (21.3, 25.0). Cycle
  5,547.3 s; air 28.2 %; rapids 2,258 / 87.27 per 1,000.
- **Leftover:** 9,451 cells > 0.1 mm; none > 10 mm; max 5.800 at (20.2, 12.4) — wall sample.
- **The tip's story:** this is the #974 mouth-rim fix (`ac1814ec`) merged under SIMULATOR_VERSION 5.
  The fix closes the pocket rims, so the chamfer now lays its 0.5 mm edge-break leg on every rim:
  **edge break 1.6376 → 3.9603 %** and raw 1.6977 → 4.0204 % against `91e2618f`, cycle
  4,959.7 → 5,547.3 s (+588 s, the newly travelled rims). Adjudicated stays **0.00 %** and the
  **shadow class is 0 under v5** — the question this set answers.
- **Physical check:** `01` shows the blue edge-break band now running around every rim, including
  the slot ends and the numerals' rims; no red adjudicated cell, no purple shadow band; `04` the
  raw worst is still a freed wall cell at full depth; `05` every floor at −7.2; `06`/`07` match
  the tree.

**Verdict: physically clean; the rim fix adds correct edge break, not a gouge.**
