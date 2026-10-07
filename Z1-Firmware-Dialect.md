# The Z1's G-code dialect, from the firmware

Status as of 2026-10-03, with a hardware-observation section added 2026-10-07 (**§11**). Every
claim in §1–§10 is read from `MakeraInc/MakeraZ1Firmware`
(`src/modules/communication/GcodeDispatch.cpp`, `utils/Gcode.cpp`, `robot/Robot.cpp`,
`tools/atc/ATCHandler.cpp`) or counted in Makera's own sample corpus (#186). **None of §1–§10 is
verified on hardware — the firmware has not been run.** Where the firmware and standard RS274/NGC
disagree, the firmware is what runs, so this is what the parser (#174) and the emulator (#182)
model. §11 is the exception and says so: it is what a real machine was *seen to do*, and it is the
only observed material in this document.

**Provenance.** The firmware is a Smoothieware fork and `GPL-3.0`. This document records
*behaviour* — interoperability facts — and quotes no code. Nothing here is copied from it.
The corpus is Carvera-generated: evidence about the shared dialect, not about Z1 specifics.

> **Errata, 2026-10-03 (adversarial review of the first draft, #174).** Three statements in
> the first version of this document were misreadings of the source, and are corrected below.
> Each one was caught by RUNNING the parser over the corpus or by re-reading the surrounding
> code, not by re-reading this document: **(1)** `M6` with the spindle running does *not*
> halt (§2); **(2)** after a tool change the head returns to the *saved X,Y*, not "a far
> corner" (§2); **(3)** a mismatched-radius arc is a circle then one jump, not a spiral (§8).
> Two items first filed as "not yet established" are now answered from the source (§10).

## Why this exists

Reading the sources overturned several things the plan asserted, and they would each have
produced a parser that disagrees with the machine on a real file. The standing rule from
`/Fabrication.md` §2 applies: *where the firmware disagrees with the wiki, the firmware wins.*

## 1. A line is split into commands by the dispatcher, not by whitespace

The dispatcher inspects characters, not tokens. After stripping a comment it repeatedly cuts
the line at the next `G`/`M`/`S`/`T` letter, searching from index 2:

| Line starts with | Cut at the next… | Consequence |
|---|---|---|
| `G` | `G`, `M`, `T` — or `G`,`M`,`S`,`T` if the line also holds an `S` **and** an `M` | `G1X0.1F2000S0.8` stays one command (laser power rides along); `G0 X5 S12000 M3` splits into `G0 X5`, `S12000 M3` |
| `M` | `G`, `M` | `M3 S12000` is one command; `S` and `T` are *parameters* of the `M` |
| `T` or `S` | the first `M`, then the next `G`/`M`/`S`/`T` after it | **`T1 M6` is one command** with `T` as a parameter of `M6` |

So `T1M6`, `G00G53Z-3` and `G1X0.1F2000S0.8` all work with no whitespace, which the corpus
relies on heavily (LightBurn writes laser jobs with no spaces at all).

## 2. `M6` needs its `T` in the same command, and it does a great deal

`M6` is only acted on when `T` is present **in the same command**. A bare `M6`, or `T1` on one
line and `M6` on the next, does nothing. A manual change (`isATC=0`) then runs a macro:

1. `G53 G0 Z<clearance>` — lift to the tool-change height, machine coordinates
2. `G53 G0 X.. Y..` — move to the tool-change position
3. `M490.1` — **wait for the operator**
4. mark the spindle tool empty
5. *(only if all axes are homed)* `G53 G0 Z<clearance>`, `G53 G0 X<anchor1+181> Y<anchor1+181>` —
   to the tool-length sensor in the far corner (a Z1/Z1 Pro coordinate). The manual-change
   path calls `fill_cali_scripts(.., clear_z = true)`, so this traverse is at **`clearance_z`**
   (**−3.0**, read on the machine — see the note at the end of this section), not `safe_z` (−20);
   the first version of this list said `safe`, and the emulator's macro copied it until code
   review #4 read the call site.
6. `G38.6 Z<toolrack_z> F<fast>`, `G91 G0 Z<retract>`, `G38.6 Z<−1−retract> F<slow>` — probe the
   sensor twice (the second target is relative to the retracted position)
7. `M493.1` — **save the new tool length offset**
8. `G53 G0 Z<safe>`; then the completion path rapids to `clearance_z` and back to the saved
   X,Y (next bullet), and records the new tool number

Four things follow:

- **`M6` calibrates tool length by itself.** `M491` is a second entry point, not a required
  follow-up. `TopClamp.nc` is a known-good Z1 job with **no `M491`**, so a check that "an `M6`
  not followed by `M491` is a fault" would refuse the vendor's own file. **That check is
  withdrawn** (it was recorded in #191 item 9).
- **`M6` while the spindle is running does NOT halt — it stops the spindle.** The handler
  first turns the spindle OFF, re-reads its state, and halts ("can not change tool while
  spindle is running") only if it is *still* running afterwards, which a program cannot
  cause. The first version of this document read only the second block and said the
  opposite; that produced 7 false errors on 6 vendor files, which concatenate programs with
  `M30` then `T1M6` and no `M5` between, and so *rely on* `M6` stopping the spindle.
- **`M6` to the tool that is already active does nothing — no change, and no calibration.**
  `TopClamp.nc` opens with `T1 M6`; if T1 is already loaded the machine skips both, and the
  tool length offset stays whatever it was. That answers the open question about what the Z1
  does at `T1 M6` when T1 is already loaded: nothing.
- **After `M6` the head returns to the SAVED X and Y, at the machine's clearance Z.** The
  macro visits the far-corner sensor in steps 5–6, but when the script queue empties the
  completion path rapids to `clearance_z` and then back to the X,Y that were recorded when
  the change began, and pops the saved modal state. (The first version of this document said
  the head stays "at the far corner"; that was wrong, and the parser wiped all three axes
  because of it.) So **X and Y survive a tool change and only Z is unknown** — it is a
  machine constant, `clearance_z`, a value for the machine profile (#184), not for the file.
  The next `G0 X.. Y..` then moves from a known X,Y and an unknown Z, which is what
  `TopClamp.nc` does.
- **`M491` is the calibration half alone** — steps 5–8 from wherever the head is, then the
  same return to the saved X,Y at `clearance_z`.
- **`G28` is not "home".** `ATCHandler::on_gcode_received` sets `g28_triggered`, and the main
  loop then rapids to `clearance_z` and on to `clearance_x, clearance_y` (−11.6, −14.6 on the
  shipped Z1 config) — the "clearance position", with the comment *"G28 means goto clearance
  position on CARVERA"*. With the machine profile the emulator animates both moves and the
  head's position is known afterwards; without it, unknown.

**OBSERVED 2026-10-06 — `G28` run on the machine, machine coordinates, `MPos`:**

```
[12:50:59] G28
[12:50:59] ok
[12:50:59] G28 means goto clearance position on CARVERA
```

The head stopped at machine **X −11.600, Y −14.600, Z −3.000**. All three are confirmed against the
controller's own config — `config-get sd coordinate.clearance_x` returns `-11.6` and
`coordinate.clearance_z` returns `-3.0` (bench item **B6**) — and the quoted comment is confirmed
*character for character*; the controller prints it unprompted.

**So this bullet is now hardware-confirmed throughout, and `clearance_z` is −3.0** — not the −1.0
that was read from the shipped config, and not `atc.*` but `coordinate.*`. The giveaway was that
−1.0 is also B4's post-homing rest Z, which would have left `G28` not moving Z at all, when it
moved 2 mm. #276, closed.

## 3. The work coordinate system lives in the machine, not in the file

`G10 L2 Pn` writes the offset to **EEPROM** for WCS 0 (G54). That is why Studio's `.nc`
carries no `G10`: the probing workflow already set it, and it persists across power cycles.
So the emulator's second transform (`WCS → machine`, #191 item 1) is machine state that the
file cannot supply, and `Setup.wcs` is exactly the right place for it.

Absolute work moves compute `target = param + wcs_offset − g92_offset + tool_offset`. The tool
offset is applied in X, Y **and** Z.

## 4. `G53` is not a simple modal

`G53` makes the *next* motion use machine coordinates, and must be on the same line as it:

- `G53 G0 X.. Y..` — the following `G0`/`G1` is extracted and used.
- `G53 X.. Y..` with nothing after it — reuses the last modal motion code.
- `G90 G0 G53 Z-3` — `G90` is hoisted (see below), `G0` has no axes, `G53 Z-3` uses the modal `G0`.
- A `G53` followed by anything but `G0`/`G1` is "Invalid G53" and ignored.

In machine coordinates the values are **absolute even under `G91`**.

## 5. Bare `X`/`Y`/`Z`/`A`/`F` lines inherit the last motion code

A line starting with `X`, `Y`, `Z`, `A` or `F` is given the last modal `G0`–`G3` as a prefix.
`F` alone is prefixed with **`G1`** — and because that sets the modal motion, **a lone `F500`
line after a `G0` silently turns every following bare `X…` line into a cutting move.** The
modal motion starts at **`G0`**. 268 000 lines of the corpus begin with a bare `X`.

## 6. Three firmware quirks that are hazards

1. **`G90`/`G91` are hoisted to the front of a `G` line — before the comment is stripped.**
   The search is a substring `find` over the whole line. A comment containing `G90` or `G91`
   on a `G` line therefore **changes the distance mode**. Not present in the corpus; a file
   from another post-processor could contain it.
2. **A `(` comment discards everything after it, including later words.** The comment is cut
   at the first `;` or `(` and nothing resumes after the `)`. In RS274, `G0 (hop) X5` still
   moves to X5; here the `X5` is dropped.
3. **Lowercase is a shell command.** A line whose first character is lowercase is passed to
   the console and ignored by the G-code dispatcher — which is what makes `echo …` lines
   harmless. It also means `g1 x5` silently does nothing. Letters are matched case-sensitively
   within a command, so `G1 x5` moves without X.

## 7. Number parsing is far more permissive than anyone intends

Words are located by scanning the command for the letter and calling `strtof` — which accepts
**exponents, `nan`, `inf` and hex**. The firmware would accept `X1e61` (the value Studio writes
into its own settings files, `/Makera-Parity.md` §8) and `XNAN`. It even accepts **`YY20` as
`Y20`**: the first `Y` yields no number, so the scan continues to the next.

**Our parser must be stricter than the machine, and say so.** Strict grammar
`[+-]?(\d+\.?\d*|\.\d+)`: it accepts `6.` and `.5`, and rejects an exponent with a message
saying the firmware would have taken it.

## 8. Arcs: IJK only, incremental, and the firmware does not validate them

- The centre is `start + (I, J, K)` — **always incremental**, whatever `G90`/`G91` says.
- There is **no `R` form** and no `G90.1`/`G91.1`. An arc with `R` is not an arc here. What the
  dispatcher does with the string `G91.1` is **unverified** (absent from the corpus), so the
  parser (`no-arc-centre-mode`) leaves the distance mode **unchanged** and raises an error:
  reading it as the plain `G91`, which the first version did, silently made every following
  move incremental (#191 §9).
- Angular travel is the CCW angle start→end about the centre from `atan2`. If start and end
  coincide in the plane it is a **full circle**, ±2π.
- **`G18` flips the sense** (`if the linear axis is Y, clockwise = !clockwise`) because the XZ
  plane's handedness is reversed.
- A mismatch between the start radius and the end radius is **not rejected**. The firmware
  rotates the START radius vector through the angular travel, so every intermediate point is
  on the start circle, and only the LAST segment lands on the target: **a circle followed by
  one jump**, not a spiral. (The first version of this document, and of the parser's arc
  code, said "spiral"; a review measured the port at 2.0 mm of radial error on a 10 → 12 mm
  test.) Either way a bad `I`/`J` is a quiet wrong path, not an error — a case where a
  verifier should be stricter than the controller.
- An arc with no feed rate alarms ("Undefined feed rate"); a `G1` falls back to the default.

This also corrects the plan: **arcs are not a contingency.** Studio's `TopClamp.nc` has none,
but the corpus has **20 000+ `G2`/`G3` lines in 10 of 25 files**, with `G17`, `G18` and `G19`.

## 9. What the corpus contains

Counted over the 25 reference files (12.8 MB, `reference-gcode/`):

| Observation | Count |
|---|---|
| `G1` / `G01` | 338 661 / 142 755 lines — **zero-padded codes are normal** |
| `G2` / `G02` / `G3` | 6 212 / 672 / 14 658 lines |
| Lines starting with a bare `X` | 268 382 |
| `G17` / `G18` / `G19` files | 16 / 4 / 3 |
| `G54` | 40 lines in 13 files |
| `G91` | 10 lines in 3 files (the tool-change macro itself uses it) |
| `G10 L2` | 2 lines — e.g. `G10L2P0X-300Y-210Z-50`, no spaces |
| `G92.4` | 3 lines — e.g. `G92.4A0S0` |
| `%` lines | 11 — program delimiters |
| Files containing non-ASCII bytes | 4 — in `echo` lines (Chinese text) |
| `M321` … `M322` | laser mode on / off — the laser jobs, with `S` as power |
| `M490.1` / `M490.2` | 10 each, in one file |
| No `G20`, `G43`, `R` word, canned cycles, or `G90.1` | — |

Accessory codes with no geometric effect, all Carvera-era: `M106`/`M107` (fan), `M331`/`M332`
(auto vacuum), `M801`/`M802` (vacuum), `M811`/`M812` (spindle fan), `M821`/`M822` (light),
`M831`/`M832`, `M841`/`M842`.

## 10. Settled from the source, and what is still open

**Answered (they were "not yet established" in the first version):**

- **The Z1 runs in grbl mode.** `Kernel.cpp` defaults `grbl_mode` to **true** under the `CNC`
  build flag, and `configZ1.default` does not override it. Consequences: **`M30` is
  end-of-program**, identical to `M2`; **`G4 P` is in seconds**, not milliseconds; and `M0`
  (feed hold) stays unimplemented — it is commented out in `Robot.cpp`. *Unverified on the
  machine itself: a config on the device could differ from the default shipped in the repo.*
- **`M2` / `M30` do more than end the program.** The dispatcher issues `M5` and `M9` and
  sets the modal motion to `G1`; the robot resets the work offset to **G54** and the distance
  mode to **absolute**. Makera's samples depend on it: they concatenate programs with `M30`
  then `T1M6` and no `M5` between.
- **An `N`-numbered line is dropped.** The dispatcher captures `first_char` *before* it
  strips the line number and never refreshes it, so `N10 G1 X5` matches none of its G/M/T/S
  branches and falls through to "ignore". Only a remainder starting with `X`, `Y`, `Z`, `A`
  or `F` survives, via the bare-axis path. No corpus file has an `N` word.
- **`F` on a `G0` sets the SEEK rate.** `Makera-Parity.md` §11.2 said a rapid "never carries a
  feed rate" and that the rapid ceiling is therefore never ours to state. True of the
  samples read, but a *file can* set it. The parser ignores `F` on `G0` for feed purposes,
  which is right; the profile should still not assume rapids are unset.

**Still open:**

- `ROUND_NEAR_HALF`, applied to every computed target, is defined outside the files read; the
  quantisation it applies is unknown. It does not affect the parser, which does not round.
- Everything in §1–§10 is a reading of source. The firmware has **not been run** — for what the
  machine was actually seen to do, see §11, which is a separate and much smaller body of evidence.

## 11. Observed on hardware, 2026-10-07

**The only observed section of this document.** Everything above is a reading of the firmware's
source; on 2026-10-07 a real Z1 (`Makera_Z1_010290`) was driven through Makera's own client and
its command traffic was read.

**Provenance, stated precisely, because it bounds what these facts are worth.** What follows is
what *Studio's own MDI log displayed as sent and received* during a Machining Wizard run — **not a
capture off the wire.** The commands are therefore certain to be what the client sent; the replies
(`ok`, `Done ATC`, `[PRB:…]`) are as the client renders them, which is one level removed from the
bytes. Nothing here comes from the firmware's source, and no code was read to produce it.

### 11.1 §2's `M49x` macro, seen running

§2 lists a manual tool change as a macro over `M490.1` (*wait for the operator*) and `M493.1`
(*save the new tool length offset*) — read from source and never executed. Both halves of that were
watched happening:

| What §2 predicted from source | What the log shows |
|---|---|
| `M490.1` — **wait for the operator** | **`M490.1`**, and the operator dialog appeared exactly there |
| `G53 G0 Z<clearance>`, `clearance_z` = **−3.0** | **`G53 G0 Z-3.000`**, repeatedly, across two separate operations |

`M490.1` is the strongest single confirmation here: the machine stopped, and Studio put up *"Tool
Change Required — Please change to: Tool T1(3.175 flat). Then press Confirm to continue."* A macro
that blocks on an operator was, until now, only a reading of a source file.

The same blocks also named the rest of the family — **`M492.3`, `M493.2 T0`, `M494.0`, `M494.2`,
`M497.2`, `M497.4`** — sent as a group, each answered `ok`, closed by **`Done ATC`**. §2 gives
roles to `M490.1` and `M493.1` only. The rest are **codes with no §2 role**: observed, and not
explained. They are not guessed at here.

### 11.2 Probing: `G38.2`, `[PRB:…]`, and `G10 L20`

The wizard's auto-Z-probe ran this, verbatim:

```
G38.2 Z-108.000 F500.000
[PRB:-118.400,-109.800,-65.135:1]
G91 G0 Z1.000
G38.2 Z-2.000 F100.000
[PRB:-118.400,-109.800,-65.118:1]
G10 L20 P0 Z0.000
G91 G0 Z1.000
```

Three facts, none of them in §1–§10:

- **A probe trigger is reported as `[PRB:x,y,z:n]`** — machine coordinates, and `:1`, which is
  grbl's success flag. §10 records that the Z1 runs in **grbl mode**; this is that showing up in
  traffic.
- **The pattern is a fast approach (`F500`), a 1 mm retract, then a slow re-probe (`F100`)** — and
  the two triggers landed **0.017 mm apart** (−65.135, −65.118). That is one point on an
  unidentified surface, not a repeatability measurement, but it is the first probe figure this
  machine has produced.
- **`G10 L20 P0 Z0.000` sets the work coordinate system from the trigger.** Auto-Z-probe does not
  merely measure — it **moves the machine's Z zero**. On this machine the G54 Z offset went
  58.633 → **65.118**, exactly the probed Z, and the tool length offset was zeroed (−0.073 → 0.0)
  in the same sequence.

Note the code difference from §2: the tool-length-sensor path there is **`G38.6`**, while workpiece
probing here is **`G38.2`**. Two different probes, two different codes.

### 11.3 A mode family: `M331`, and one silent code

Toggling the wizard's five "assist" switches sent these, each with Studio's own description:

| Studio's description | Code |
|---|---|
| `turning auto bed cleaning mode on` | `M331.2` |
| `turning auto blowing mode on` | `M331.1` |
| `turning static electricity removal mode on` | `M331.4` |
| `turning extend out mode on` | `M331` |
| *(no description, and no `ok`)* | `M951` |

**`M331` is a mode family with a decimal sub-index** — a shape nothing in §1–§10 has, and none of
these codes appears in the source reading. Which switch maps to bare `M331` is **inferred by
elimination, not observed**: four of the variants describe themselves, which leaves `M951` for the
camera time-lapse and bare `M331` ("extend out") for the vacuum. **Toggling one at a time settles
it**, and has not been done.

`M951` also **answered nothing**, where every other command answered `ok`, with a seven-second gap
to the next command. Unexplained.

**This matters beyond curiosity.** `machine.ts` models the Z1's only accessory as **air
(`M7`/`M9`)** and records the internal vacuum as Carvera-only. Studio's own wording says this
machine has bed cleaning, blowing, static removal and "extend out" as four separable modes. **No
`M7` or `M9` appears anywhere in the traffic read.**

### 11.4 What §11 does not settle

- **§2's `T1 M6` on an already-active tool** was not reached — the wizard's changes were to and
  from the probe, never a no-op change. The source reading stands unverified on hardware.
- **The roles of the `M49x` codes** beyond `M490.1` remain unread.
- **Whether the assist modes persist across a power cycle** is unasked. All five were off before
  the session and all five on after it.
- **Nothing was captured off the wire.** A capture would make all of the above first-hand; the
  client's own log is what made any of it visible at all.
