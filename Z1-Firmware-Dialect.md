# The Z1's G-code dialect, from the firmware

Status as of 2026-10-03. Every claim below is read from `MakeraInc/MakeraZ1Firmware`
(`src/modules/communication/GcodeDispatch.cpp`, `utils/Gcode.cpp`, `robot/Robot.cpp`,
`tools/atc/ATCHandler.cpp`) or counted in Makera's own sample corpus (#186). **None of it is
verified on hardware.** Where the firmware and standard RS274/NGC disagree, the firmware is
what runs, so this is what the parser (#174) and the emulator (#182) model.

**Provenance.** The firmware is a Smoothieware fork and `GPL-3.0`. This document records
*behaviour* — interoperability facts — and quotes no code. Nothing here is copied from it.
The corpus is Carvera-generated: evidence about the shared dialect, not about Z1 specifics.

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
5. *(only if all axes are homed)* `G53 G0 Z<safe>`, `G53 G0 X<anchor1+181> Y<anchor1+181>` —
   to the tool-length sensor in the far corner (a Z1/Z1 Pro coordinate)
6. `G38.6 Z.. F<fast>`, `G91 G0 Z<retract>`, `G38.6 Z.. F<slow>` — probe the sensor twice
7. `M493.1` — **save the new tool length offset**
8. `G53 G0 Z<safe>`, then record the new tool number

Four things follow:

- **`M6` calibrates tool length by itself.** `M491` is a second entry point, not a required
  follow-up. `TopClamp.nc` is a known-good Z1 job with **no `M491`**, so a check that "an `M6`
  not followed by `M491` is a fault" would refuse the vendor's own file. **That check is
  withdrawn** (it was recorded in #191 item 9).
- **`M6` while the spindle is running halts the machine** ("can not change tool while spindle
  is running"). That *is* a checkable fault.
- **`M6` to the tool that is already active does nothing — no change, and no calibration.**
  `TopClamp.nc` opens with `T1 M6`; if T1 is already loaded the machine skips both, and the
  tool length offset stays whatever it was. That answers the open question about what the Z1
  does at `T1 M6` when T1 is already loaded: nothing.
- **After `M6` the tool is at the far corner at safe Z**, so the position is unknown to a
  parser that has not been told the machine's `safe_z` and anchor. The next `G0 X.. Y..`
  therefore moves from an unknown Z — which is exactly what `TopClamp.nc` does.

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
- There is **no `R` form** and no `G90.1`/`G91.1`. An arc with `R` is not an arc here.
- Angular travel is the CCW angle start→end about the centre from `atan2`. If start and end
  coincide in the plane it is a **full circle**, ±2π.
- **`G18` flips the sense** (`if the linear axis is Y, clockwise = !clockwise`) because the XZ
  plane's handedness is reversed.
- A mismatch between the start radius and the end radius is **not rejected**: the arc runs on
  the start radius and the last segment lands on the target. So a bad `I`/`J` gives a quietly
  wrong spiral, not an error — a case where a verifier should be stricter than the controller.
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

## 10. Not yet established

- `ROUND_NEAR_HALF`, applied to every computed target, is defined outside the files read; the
  quantisation it applies is unknown. It does not affect the parser, which does not round.
- Whether the Z1 runs in "grbl mode", which changes the unit of `G4 P` (seconds vs ms).
- How `N` line numbers interact with the dispatcher: the first-character test uses the value
  *before* stripping, which looks like it skips the `G` branch. No corpus file has one.
- The firmware has been read, not run. Everything here is a reading.
