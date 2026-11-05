# Tool tray — the standard render set at `1fba811a` (full tour stack: region tour + skin corners)

- **Run:** `/tmp/e966-tip.sh 1fba811a` — the tip merging `cand/962-region-tour` (`cd5ec056`) and
  `cand/970-skin-corners` (`6b35d6e9`). Acceptance 18 passed / 2 skipped, **406.11 s** pair.
- **Scored lines:** coverage **99.3442 %**; cut-into **0.00 % adjudicated** (0 cells; raw 4.0204 %:
  edge break 3.9603 %, wall 0.0602 %, shadow 0); raw max 6.000 mm. Cycle **4,568.2 s**
  (4,812.0 at `a79bab6b`, −244 s); air **16.0 %** (18.9); rapids **669** (1,130).
- **Leftover:** 9,451 cells > 0.1 mm; none > 10 mm; max 5.800 at (20.2, 12.4) — wall sample.
- **The stack:** the region tour (one leftover field, one skin grid) plus the corrected 3×3
  corner read. Classification identical to `a79bab6b`; the cycle and rapid count fall further.

**Physical check:** edge break band around every rim, no adjudicated cell, no shadow band, floors
at goal. Nothing stops the merge.
