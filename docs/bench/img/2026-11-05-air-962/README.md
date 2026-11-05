# Tray — air seconds by program and by class (961x960-rt @ 8a44b336)

Tool: `casemaker-app/tests/tools/airByClass.ts` (pairs with E's `airByProgram.ts`). Ours from the
posted programs of `/tmp/959-combo2/tray-plan.json` (the region-tour combine, catalogue, vise);
Makera's from `Tool_Tray_70mm_Top-msfi5w1b.nc`. Both through the same G-code parser and the app's
own timing model (`Z1.rapidEstimate`, `rapidRate`, `moveSeconds`).

## By program (airByProgram)

| program | cycle s | rapid s | feed s | air % |
|---|---|---|---|---|
| p0 flat-6 (111031606032) | 2027.1 | 371.8 | 1643.3 | 18.34 |
| p1 flat-3.175 (111011313825) | 408.7 | 227.6 | 169.1 | **55.69** |
| p2 ball-6 (131032606032) | 467.8 | 159.5 | 296.3 | 34.10 |
| p3 chamfer (122111013890) | 50.6 | 8.7 | 29.9 | 17.19 |
| p4 contour (111031606032) | 992.8 | 57.9 | 922.9 | 5.83 |
| **whole plan** | **3946.9** | **825.5** | **3061.5** | **20.91** |

## By class (airByClass; excludes the ~19 s inter-operation entry rapids)

| class | ours s / count | Makera s / count |
|---|---|---|
| tool change | 2.3 / 5 | 1.3 / 1 |
| retract/plunge leg | **487.0 / 568** | 244.0 / 248 |
| row hop | 11.5 / 84 | 8.1 / 34 |
| region move | **305.6 / 198** | 181.1 / 93 |

Ours 806.3 s vs Makera 434.5 s (1.86x). The class mix is Makera's (legs ~60 %, region ~40 %);
the excess is volume: 2.0x the leg seconds, 1.7x the region seconds.

## The line and the lever

The line is 16.7 % (Makera 6.7 + 10). With feed held at 3061.5 s the rapid budget is
**<= 613.8 s**, i.e. **>= 211.7 s must go** — 44 % of the leg time alone would do it.
**Top lever: the row-end retract/plunge legs** (568 legs, 487 s, 2.0x Makera's) in the flat
rough/skin (227 legs), the ball finish (183) and the 3.175 channels (118) — each row still lifts
instead of joining the next row at the CL. Second: the 305.6 s of region crossings (already cut
36 % by the region tour).

Picture: `tray-rapid-air.png` — every rapid at one scale, ours beside Makera's; green tool-change,
grey dot retract/plunge, blue row hop, red region move.
