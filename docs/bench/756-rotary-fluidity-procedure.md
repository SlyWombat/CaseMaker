# #756 — 4-axis fluidity & starvation: the bench half

The software half is `casemaker-app/tests/unit/rotaryFluidity.acceptance.spec.ts`. It measures what
the program asks of the controller. This page is what only the machine can answer. It needs the
4th-axis module fitted and characterised (#238) and the Makera plug switched on with
`tools/z1/power.sh on`. Nothing here is run by the overnight sessions.

## What the software already says (on a ⌀30 wave, a 0.05 mm step-over, 1° chords)

| Quantity | Value | Source |
|---|---|---|
| Feed asked by the test | 2000 mm/min, **refused**: the Z1 cuts at 1200 at most | the post (`maxCutFeed`) |
| Feed run | 1200 mm/min | the machine's maximum |
| A speed the firmware will turn | 58 °/s (cap 60 °/s) | perimeter model, `/Rotary.md` §1.2 |
| Surface speed the wave sees | ≈ 820 mm/min at the mean radius | the same model |
| Z speed the wave demands | ≈ 547 mm/min of Z's 600 (91 %) | the wave's slope × ω |
| Program | ≈ 290 000 lines; 800 turns | the post |
| Block rate needed | ≈ 58 blocks/s | A speed ÷ chord |
| Run time | ≈ 83 min for 40 mm of wave | 800 turns × 6.2 s |

So on a Z1 the **A axis paces this program and Z is the next limit**. The data rate is not, unless
the controller's sustained block rate is below roughly 60 blocks/s.

## 1. Measure the controller's sustained block rate

This replaces `BLOCK_RATE_PLACEHOLDER` in the spec.

1. Air run, no tool, Z well clear. Upload a file of 10 000 straight X moves of length L at F1200 for
   L = 1.0, 0.5, 0.2, 0.1 and 0.05 mm. Each is its own file, and each starts with `G4 P1` so the
   timing starts clean.
2. Time each file from the first move to the end: use the status line's state change, or a
   stopwatch on the DRO.
3. The expected time is 10 000·L / (1200/60) s. While the measured time stays at the expected time,
   the planner keeps up. The L at which it starts growing gives the sustained rate:
   10 000 ÷ the measured seconds.
4. Record the curve in `docs/bench/` and set the spec's constant from it, labelled `measured`.

## 2. The cut itself

1. ⌀30 hardwood (maple) in the chuck, tailstock in. Use the spec's spiral at F1200 with a ⌀3 flat
   as the proxy. A ⌀3 ball is refused by the rotary simulation today (R-UI-12), so a ball run
   would not have been simulated first.
2. **Listen.** A steady hum is the pass. Chatter, a morse-code rhythm or gravel is starvation or
   desync. Note the X position when it starts.
3. **Fingernail and light.** With a 0.05 mm step-over, any washboard ridge you can feel is not
   step-over. Measure the ridge pitch with a ruler or a photo scale:
   - a pitch equal to the chord's arc (about 0.24 mm at R 13.5) means micro-stops at block
     boundaries;
   - a pitch matching a whole number of lobes points at Z, which runs at 91 % of its cap.
4. Record both against the table above.
