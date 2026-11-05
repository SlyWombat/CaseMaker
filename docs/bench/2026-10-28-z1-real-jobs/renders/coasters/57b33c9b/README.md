# Mandala coasters — refreshed on main `57b33c9b` (v4 gate frozen)

- **Run:** `build.py --repo ~/projects/cm-wt/coasters-v4 --sha 57b33c9b --only ref-coasters` with
  the demo location, catalogue and Makerables downloads; worktree HEAD
  `57b33c9b55321a1b41b27e4b858a93b058d1d357`. Run dir:
  `~/casemaker-manager/demo-build/runs/57b33c9b/ref-coasters/`.
- **Scope:** main now carries the frozen v4 rule (`#948`) and the SVG stroke-band import (`#968`).
  The card is unchanged by v4 — its check is the 2.5D design check, not the goal gate — and reads
  exactly what it did at `c4d93b58`: **deviates**, 50 items measured, **95.43 %** of the painted
  band area cut, worst item 60.0 % left, 19 items between 8.6 % and 11.4 % left, **outside 0.0
  mm²**, verifier **0 errors**.
- **Pictures:** `design-overlay.png` (the 50 bands at their stated widths; nothing cut outside),
  `after-top.png` (independent sweep after our program: every band engraved at 0.8 mm),
  `vendor-overlay.png` (the vendor's T2 against the same band design, 60.21 % of the bands).
- **Reading:** identical to the `c4d93b58` set — the residue is the V-tip-on-narrow-bands question
  parked by the maintainer, not a v4 effect.
