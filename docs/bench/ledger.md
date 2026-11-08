# Bench facts ledger — what the maintainer has already measured or tested, and where it is recorded

Rule: before anyone asks the maintainer for a measurement or a test, look here, then `docs/bench/`, then the k3 shop defaults' `source` (only a `seeded` key may be asked for). A fact measured once is cited, not re-asked.

| Fact | Value | Date / session | Record |
|---|---|---|---|
| L-bracket arms, from the inside corner | 85 / 85 mm; arm thickness 15; height 15.05 (to the M5 heads) | 2026-10-18 | `docs/bench/2026-10-18-laminate.md:152–170`; k3 `bracket.*` measured |
| L-bracket mounting holes | scale 0 = inside corner; holes centred across the 15 mm arm (7.5 from the inside face); centres at scale 15 and 70 on the scale arm, 70 on the other | 2026-10-18 | same; photo `img/2026-10-18-l-bracket-scale-holes.jpg` |
| Top clamp (Makera Top Clamp Set, 2) | 65 long × 20 wide × 5.05 thick; M5 × 14 cap screw (head 5.0 tall, 8.5 across) → stands 10.05 above its seat; stepped nose 1.05 / 3.6 / 5.05 | 2026-10-18 | same; k3 `clamps.topLength/Width/HeightMm` measured; photo `…top-clamp-stepped-nose.jpg` |
| Side Clamp Set | still bagged 2026-10-18; fitted on the BACK edge 2026-11-07, top BELOW the stock top; dimensions NOT yet calipered | 2026-11-07 | photo `img/2026-11-07-tray-holding.jpg`; #1068 |
| Vise (low-profile) | jaw bar width 10, jaw length 100, ledge step 3.1 / width 1.9 measured; floor depth 19.8; max opening 132 / 128 / ~152 (outer screws skipped); travel 8.7 | 2026-10-15/18 | laminate.md; k3 `fx-vise-1`; #508/#451 |
| Wired probe V2 | tip ⌀2.0; rim offset 0.7 ± 0.25; Z repeat 0.001; setter −75.92 (10-30) | 2026-10-15/30 | k3 `registration.*` measured; `fx-probe-1` |
| Makera 3D probe | needs `M831` (toolsensor supply) or answers `:0` silently; plugs in the probe connector (not the ionizer port); ruby ball ⌀2.1, body ⌀17.1, body-bottom→ball-end 13.3; effective sideways radius ≈ 0.15 (0.875 from an outside width, #790); `G38.5` release before any `G0`; alarms drop the supply | 2026-10-30, 31, 11-07 | `docs/bench/2026-10-30-3d-probe-survey.md`; #789 #790 #827; k3 `makera-3d-probe` |
| Accessory codes | vacuum `M331`/`M332` works (10-12); `M7`/`M9` blow nothing; antistatic `M331.4`/`M332.4` (#564); light `M821`/`M822` | 2026-10-07/12 | `2026-10-bench-plan.md:15`; #283 |
| Studio assist switches | Auto Vacuum / **Auto Blow (`M331.1`)** / Auto Bed Clean / Anti-Static / Time-Lapse, each sent once from Studio's wizard; left ON after the walk | 2026-10-07 | `2026-10-bench-day-1.md:1296,1384`; `img/D0-wizard-4-assist-toggled-mdi-log.png`; #283 |
| Machine-card output sweep | `M811/M812` spindle fan, `M801/M802` power fan, `M851/M852` external output (= the vacuum, seen twice), `M841/M842` WP charge (nothing), each `ok` | 2026-11-01 | `traces/2026-10-31-probe-bore.log:1229–1264`; #884 |
| Blower | the maintainer tested it in a prior session and it ran; the instrument was Studio's Auto Blow switch (10-07) or the card's spindle-fan row (11-01) — the maintainer's statement is the observation; `M332.1` unobserved | 2026-11-07 (statement) | #1060 |
| Home / tool-length timing | `$H` 27.5 s mean; M491 31.4 s | 2026-10-15 | k3 `plan.homeSeconds`, `plan.toolLengthSeconds` |
| Machine frame | anchor1 −190.89 / −193.83; soft limits −207 / −206 / −102; sensor = anchor1 + 181 | 2026-10-07, 11-07 | `config.txt` sweep; #238 table |
| Rotary module (R-1) | +A turns the top toward the front; 32,000 steps/turn; **A cap ≈ 30 °/s**; axis Z −37.71 / Y −125.06 (3D-probe-tip frame); jaw-face X ≈ −160; 4 jaws, OD 50.9–84; 44.5 square fits reverse/outer, ~150 between centres; tailstock body 36.1; unwind confirmed; chuck not aligned to A 0 | 2026-11-07 | #238 closing table; `img/2026-11-08-238-rotary/`; `traces/2026-11-07-console.log` |

| 3D probe incident (OUT OF SERVICE) | 2026-11-07 ~20:06Z, manager session hand-driving a datum routine (not the app): `G53 G0 X-220` hit soft_endstop.x_min −207 (alarm) → `$X` unpowered the probe (alarms drop the M831 supply) → `G91 G38.3 X25 F200` at 4 mm below the blank top ran through the left face with no trigger (`:0`) and bent the stylus; straightened by the maintainer, it now triggers but stays `Probe: 1` after release. Rules: after any alarm re-send M831 + deflection proof; no unattended command loops — routines run only as the program under test | 2026-11-07 | `traces/2026-11-07-console.log` (from 19:58Z); k3 inventory 3D probe OUT OF SERVICE; #1070 |

## Still genuinely unmeasured (the only things it is fair to ask)
k3 `seeded`: `clamps.topReachMm` (nose reach in), `bracket.originOffsetX/YMm` (needs the bracket fitted once), `bracket.fitMm`, `bracket.repeatMm`; the Side Clamp Set (footprint, height); the wasteboard's hole pitch; the Thick L Bracket; rotary TIR/backlash, tailstock reach, inner/outer grip ranges.
| M1 tray holding (bracket) | blank 126 × 160 × 25 hardwood against the L-bracket (arms FRONT + LEFT), one side clamp on the BACK edge (below the stock top); two screwed counterbored holes in the LEFT waste → place the tray 10 mm right of centred; usable length ≈ 142 from the bracket | 2026-11-07 | `img/2026-11-07-tray-holding.jpg` (photo rotated 90°); #1068 |
