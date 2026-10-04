# Bench day 1 — the Z1 settle-in runbook (#208)

**What this is.** Every number and behaviour the CNC plan currently *assumes* about the
physical machine, collected into one ordered checklist for the first visit to the hardware.
Sections A–C move nothing (A–C run with the spindle off and **nothing in the collet**); D is
air-only; the real cut is E and belongs to #209. Nothing here cuts material except the last,
optional step.

**Status: runbook, not yet run.** Every **Expected** value below is a *reading* of the code or
a document — never a measurement of this machine. Every **Recorded** form is **blank** until the
session fills it in at the machine. When the machine disagrees with a document, the machine is
right and the document changes.

**Photographs** go under `docs/bench/img/`, named per item (`A3-vise-top.jpg`, …).

**Where the results go when this is over:** each item's **Goes to**; then the closing sections
*After the session* and *PROVISIONAL (#208) inventory*. This file stays the record — write the
reading into each blank form and keep it; do not delete the forms.

## Safety — `/Fabrication.md` §8, unchanged

- Nothing is sent to the machine without the operator's explicit go-ahead — not even a status
  query.
- Motion and spindle commands only with a person physically at the machine.
- **Sections A–C involve no spindle.** Remove the cutter, or leave the spindle empty, until D.

## How to use this

For each item: do the step, write the result in that item's **Recorded** form, then land it where
**Goes to** says in the same sitting (or file a follow-up issue and link it here). Every blank cell
below is filled at the machine — no value is pre-entered. Read every console command *aloud* to the
person at the machine before sending it. The **Expected** line is what the plan currently believes
(a code/document reading, not a measurement); the **machine wins** where they disagree.

---

## A · Look and measure — no motion

### A1 — Inventory every cutter owned

**Do.** For each cutter: type (flat / ball / V / drill), cutting diameter, flute length, shank
diameter, overall length, flute count. Photograph them together with a ruler.

**Expected (what the plan currently assumes).** Two library rows, neither a full inventory:
- `flat-3.175x12-metal` — 3.175 mm flat end, flute/shoulder 12 mm, stick-out 0, id
  `112111313812`. Source: the `;@MKR|TOOL` line of Makera's **sample** `Z1/TopClamp.nc` — the
  vendor's demo tool, not necessarily owned (`toolLibrary.ts:56-77`).
- `flat-1.0` — 1.0 mm flat end, **diameter only**; lengths unknown (`toolLibrary.ts:78-84`,
  `/Simulation.md` §4). This is the current default cutter (`engrave/defaults.ts:104`).

**Recorded:** _not yet run — table (type, cutting ⌀, flute length, shank ⌀, overall length, flutes)._

| # | Type (flat/ball/V/drill) | Cutting ⌀ (mm) | Flute length (mm) | Shank ⌀ (mm) | Overall length (mm) | Flutes | Notes |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |
| 4 | | | | | | | |
| 5 | | | | | | | |
| 6 | | | | | | | |

Photo of all cutters with a ruler: `docs/bench/img/` _______________

**Goes to:** `src/engine/cnc/toolLibrary.ts` — one entry per **flat end mill**,
`provenance: 'measured, bench day 1'`; other shapes listed in this file only. This also decides
#200's default cutter.

### A2 — Collet nut and stick-out

**Do.** Caliper the collet nut: outside diameter and height. With a cutter fitted using its
collar, measure stick-out from the nut face to the tool tip.

**Expected.** `Z1.holder` is `null` — "PROVISIONAL (#208): the collet nut has never been
measured" (`machine.ts:168-170`), so the fixture gate reports "cannot be proven". Tool
`stickout`: `0` for the TopClamp sample, `null` for `flat-1.0` (`toolLibrary.ts`). Bit collars
set ~12 mm shank protrusion by default (`/Fabrication.md` §1).

**Recorded:** _not yet run — nut ⌀, nut height, stick-out (3 numbers)._

| Field | Value |
|---|---|
| Collet nut outside ⌀ (mm) | |
| Collet nut height (mm) | |
| Stick-out, nut face → tool tip (mm) | |

Stick-out per cutter, if it differs from the collar default (cutter # from A1):

| Cutter # | Stick-out (mm) |
|---|---|
| | |
| | |

**Goes to:** `Z1.holder` in `src/engine/cnc/machine.ts` (#204) and each tool's `stickout`.

### A3 — Caliper the vise

**Do.** Jaw opening range (min, max), jaw length (Y), each jaw's thickness (X), jaw height above
the vise bed, the soft-jaw slot (width, depth) and any lip over the part's top edge. Photograph
from above and from the front with a ruler in frame.

**Expected (every value is a placeholder).** `DEFAULT_VISE` — `stockProud 4`,
`fixedJawThickness 15`, `movingJawThickness 15`, `jawLength 80`, `jawStartY −10`
(`fixture.ts:70-78`); `VISE_BODY_DEPTH 20` (`fixture.ts:36`); `GRIP_MIN 3` (`fixture.ts:43`);
uncertainty bands 2 mm (default) / 0.5 mm (saved) (`fixture.ts:56-58`). Known from the vise's
quick-start page: the **fixed jaw is the LEFT jaw**; it mounts on **two 4 × 11 mm locating pins
and six M5×20 screws, MDF wasteboard removed**; soft jaws are slotted ("suitable for thin
workpieces"); the slot is a **lip over the top-face edge**; the fixed jaw's offset from the
anchor pins is unpublished (`/Fabrication.md` §7.3).

**Recorded:** _not yet run — ~8 numbers + 2 photos._

| Field | Value |
|---|---|
| Jaw opening, min (mm) | |
| Jaw opening, max (mm) | |
| Jaw length, Y (mm) | |
| Fixed jaw (LEFT) thickness, X (mm) | |
| Moving jaw thickness, X (mm) | |
| Jaw height above the vise bed (mm) | |
| Soft-jaw slot width (mm) | |
| Soft-jaw slot depth (mm) | |
| Lip over part's top edge? (yes/no, and mm if yes) | |
| Fixed jaw offset from the anchor pins (mm) | |
| Notes | |

Photos (with a ruler in frame):
- From above: `docs/bench/img/A3-vise-top.jpg`
- From the front: `docs/bench/img/A3-vise-front.jpg`

**Goes to:** `ViseParams` defaults in `src/engine/cnc/fixture.ts` (#200, #203) — replace every
`PROVISIONAL`; `/Fabrication.md` §7.3 (the "needs a caliper and one photograph" note, #191).

### A4 — Mount the vise

**Do.** MDF wasteboard off, two locating pins, six M5×20. Note anything the quick-start page did
not say.

**Expected.** As documented: pins 4 × 11 mm, six M5×20, wasteboard removed
(`/Fabrication.md` §7.3).

**Recorded:** _not yet run — notes + photo._

| Field | Value |
|---|---|
| Pins fit as documented? (yes/no) | |
| Six M5×20 as documented? (yes/no) | |
| Anything the quick-start did not say | |

Photo: `docs/bench/img/A4-vise-mounted.jpg`

**Goes to:** #207, section 2.

### A5 — Clamp a blank

**Do.** Measure how far the blank's top stands above the jaw tops, and whether it sits flat
(press each corner — any rock?).

**Expected.** `stockProud` assumed **4 mm** (`fixture.ts:71`). Gates: `vise-stock-not-proud` if
`stockProud ≤ 0`; `vise-stock-proud-exceeds-thickness` if `≥ thickness`; `vise-grip-shallow`
warns when grip (`thickness − stockProud`) < `GRIP_MIN` 3 mm (`fixture.ts:184-213`).

**Recorded:** _not yet run — 1 number, flat yes/no._

| Field | Value |
|---|---|
| Blank top above jaw tops, stockProud (mm) | |
| Sits flat? (press each corner — any rock? yes/no) | |
| Which corner(s) rock, if any | |

**Goes to:** #207 section 3; the `vise-grip-shallow` threshold in #203.

### A6 — Where is the camera mounted?

**Do.** On the moving head, or on the frame? One word, plus a photo.

**Expected.** The Z1 has an integrated camera, documented for **monitoring and time-lapse only**,
with no origin-setting overlay (`/Fabrication.md` §1, §7.3). Head- vs frame-mounted is unknown
and it decides the whole calibration model (#189; `/Fabrication.md` §7.3 / #191 item 5).

**Recorded:** _not yet run — one word + photo._

| Field | Value |
|---|---|
| Mounted on (head / frame) | |

Photo: `docs/bench/img/A6-camera.jpg`

**Goes to:** #189.

### A7 — Barcodes on the cutters

**Do.** Photograph the label on every cutter's packaging (and the shank, if anything is marked
there). Decode each with a phone.

**Expected.** Unknown. The only id we hold is `TopClamp.nc`'s `;@MKR|TOOL|…|id=112111313812`
(12 digits, **not** a valid UPC-A — its check digit would be 5, not 2; #212). Our post emits
`id=<tool.id ?? 0>` (`post/z1.ts:150`); the `three-strokes.nc` fixture uses `id=0`.

**Recorded:** _not yet run — per cutter: the symbology (QR / Code 128 / EAN / UPC…) and the exact
decoded text, beside that cutter's A1 row. Flag any value equal to `112111313812`._

| Cutter # (from A1) | Symbology (QR/Code 128/EAN/UPC…) | Exact decoded text | Equals `112111313812`? |
|---|---|---|---|
| | | | |
| | | | |
| | | | |
| | | | |
| | | | |

**Goes to:** #212 — the tool inventory cannot be designed until it is known what the code encodes.

---

## B · Ask the controller — no motion

Connect with Makera Studio and use its console/terminal. **Read each command aloud** to the person
at the machine before sending it.

### B1 — Studio's work-origin dialog

**Do.** Open the work-origin dialog. Screenshot every mode and option it offers.

**Expected.** The dialog exists (`OperationDetailsCfgWorkOriginDlg`) but throws `invalid null
parameter` on this install (`/Makera-Parity.md` §8). Whether a two-point edge find exists is
unknown.

**Recorded:** _not yet run — screenshots._

| Mode / option shown | Screenshot file (`docs/bench/img/…`) |
|---|---|
| | |
| | |
| | |
| | |
| | |

**Goes to:** closes #187 item 1 ("one screenshot"); decides #207 section 5's wording.

### B2 — Soft endstop config

**Do.** `config-get sd soft_endstop.enable`, then `soft_endstop.x_min`, `.y_min`, `.z_min`.

**Expected (shipped default).** `false`, `-206.0`, `-206.0`, `-102.0` —
`src/configZ1.default:429-432`, quoted in `/Simulation.md` §9 item 7. The endstops are
**disabled**, and the controller's limit sits 6 mm (2 mm in Z) past the vendor's 200 mm figure.

**Recorded:** _not yet run — 4 values._

| Query | Value |
|---|---|
| `soft_endstop.enable` | |
| `soft_endstop.x_min` | |
| `soft_endstop.y_min` | |
| `soft_endstop.z_min` | |

**Goes to:** `/Simulation.md` §9 item 7; a `softEndstop` record on `Z1` (#192 q5).

### B3 — Active tool / ATC state (`M499`)

**Do.** `M499` — or whatever Studio shows as the active tool and whether an ATC is present.

**Expected.** `isATC=0`, the `FuncSetting` ATC bit clear (`machine.ts:68-70`;
`/Fabrication.md` §1, §9.4).

**Recorded:** _not yet run — output._

| Field | Value / output |
|---|---|
| `M499` output (paste verbatim) | |
| Active tool shown | |
| ATC present? (yes/no) | |

**Goes to:** `/Fabrication.md` §9.4 — is the `FuncSetting` ATC bit really clear?

### B4 — Homing position

**Do.** After homing, read the machine position Studio reports.

**Expected.** Machine coordinates run −200…0 (X), −200…0 (Y), −100…0 (Z); the machine homes to
MAX on every axis and loads 0 there (`machine.ts:53-59, 148`).

**Recorded:** _not yet run — X, Y, Z._

| Axis | Machine position after homing |
|---|---|
| X | |
| Y | |
| Z | |

**Goes to:** confirms the envelope's sign convention (`Z1.envelope`).

### B5 — Firmware identity

**Do.** Firmware version, and whether the machine identifies as Z1 or Z1 Pro.

**Expected.** Unknown. `t_MachineType` has one `Makera Z1` row; `/Fabrication.md` §1 notes
"there is a Z1 Pro" and that `Z1/QuickStart` is written for "Makera Z1（Z1&Z1Pro）".

**Recorded:** _not yet run — 2 strings._

| Field | Value |
|---|---|
| Firmware version | |
| Identifies as (Z1 / Z1 Pro) | |

**Goes to:** `/Fabrication.md` §1 and #184.

---

## C · Move, spindle off, nothing in the collet

### C1 — `G28`

**Do.** Send `G28`. Read the machine position it stops at.

**Expected.** The clearance position: `clearanceZ` −1.0, `clearanceXY` (−11.6, −14.6)
(`machine.ts:157-159`; the change position computes to (−11.62, −14.56)). `G28` is "goto
clearance position", **not** home (`/Z1-Firmware-Dialect.md` §2).

**Recorded:** _not yet run — X, Y, Z._

| Axis | Machine position after `G28` |
|---|---|
| X | |
| Y | |
| Z | |

**Goes to:** `Z1.toolChange.clearanceXY` / `clearanceZ`.

### C2 — The real travel limits (−200 or −206?)

**Do.** `G53 G0 X-200 Y-200` then `G53 G0 Z-100`, slowly, hand on the stop. Did it get there?
Then jog each axis 0.5 mm at a time past it, toward −206 / −206 / −102, and note where it stalls
or stops.

**Expected.** The profile's envelope stops at −200 / −200 / −100 (`machine.ts:148`); the firmware
config's soft limits are −206 / −206 / −102 and **disabled**, so the band (−206, −200] is
unverified without the machine (`/Simulation.md` §9 item 7).

**Recorded:** _not yet run — the real limits._

| Field | X | Y | Z |
|---|---|---|---|
| Reached −200 / −200 / −100? (yes/no) | | | |
| Hard stop / stall position (machine coords) | | | |

Notes:

**Goes to:** `/Simulation.md` §9 item 7 — closes the −200 vs −206 question.

### C3 — Does the camera image follow the move?

**Do.** With the camera feed open, command `G91 G0 X10`, then `G90`. Did the **image of the bed**
shift, or only the spindle within a still image?

**Expected.** Unknown. Head-mounted moves the whole image; frame-mounted leaves the bed still
(this is the A6 answer confirmed by behaviour).

**Recorded:** _not yet run — one sentence._

| Field | Value (one sentence) |
|---|---|
| What moved in the image | |

**Goes to:** #189 (`/Fabrication.md` §7.3 / #191 item 5: "run it first and record the answer").

### C4 — Probe repeatability on wood (Z)

**Do.** Fit the **Makera 3D Probe**. Probe the top of a **wood** blank in Z. Repeat five times
without moving XY.

**Expected.** The 3D Probe is rated for non-conductive material, so it should trigger on wood;
its repeatability has never been measured (`/Fabrication.md` §1, §7.6).

**Recorded:** _not yet run — 5 Z values; spread = probe repeatability._

| Run | Z reading (machine coords, mm) |
|---|---|
| 1 | |
| 2 | |
| 3 | |
| 4 | |
| 5 | |
| Spread (max − min) | |
| Triggered on wood? (yes/no) | |

**Goes to:** `/Fabrication.md` §7.6.

### C5 — Edge-find X and Y

**Do.** Probe the blank's left face (X) and front edge (Y) with whatever Studio's dialog from B1
offers.

**Expected.** Decision 26 wants edge-find on two *straight* edges; whether Studio can do a
two-point edge find at all is unknown (see B1).

**Recorded:** _not yet run — what worked, what did not._

| Field | Value |
|---|---|
| X edge find — worked? (yes/no) | |
| Y edge find — worked? (yes/no) | |
| What worked / what did not | |

**Goes to:** #207 section 5; #188.

### C6 — `M491` repeatability

**Do.** Fit a cutter. Run tool-length calibration (`M491`) five times in a row.

**Expected.** `M491` resets TLO for the current tool and is **not** ATC-gated (`/Fabrication.md`
§2); the `M491` term of the Z chain has never been quantified (§7.6).

**Recorded:** _not yet run — 5 TLO values._

| Run | TLO value (mm) |
|---|---|
| 1 | |
| 2 | |
| 3 | |
| 4 | |
| 5 | |
| Spread (max − min) | |

**Goes to:** the `M491` term of the Z chain (`/Fabrication.md` §7.6).

### C7 — `T1 M6` on an already-active tool

**Do.** With tool 1 already active and calibrated, send `T1 M6`. Does anything move?

**Expected.** The firmware does **nothing** — no change, no calibration
(`/Z1-Firmware-Dialect.md` §2). This is the no-op rule #207 section 4 warns about.

**Recorded:** _not yet run — yes/no._

| Field | Value |
|---|---|
| Did anything move? (yes/no) | |
| If yes, what | |

**Goes to:** #207 section 4.

---

## D · Run files — in the air first

### D1 — Air program: does the machine take it, and does it read our header?

**Do.** Upload a tiny **air** program written by us: `casemaker-app/tests/e2e/fixtures/three-strokes.nc`
(#199), with every Z raised by 25 mm (the deepest stroke, Z −2.0 → +23.0, then clears the blank's
top face by 23 mm). Does Studio accept and preview it? Does the machine's screen show our
`CAM|id=CaseMaker` header's stock, tool and time?

**Expected.** The fixture is stock 60 × 30 × 6, a 3.175 mm flat, `T1 M6`, `S12000 M3`, three
strokes at Z −0.5 / −1 / −2, header `TIME seconds=30` and
`CAM|id=CaseMaker|name=Case Maker|v=0.0.0-test`. Our post's `CAM_ID = 'CaseMaker'`
(`post/z1.ts:58`) — whether the machine accepts a non-Studio id is the open question (#173; also
asked by #165 and #176).

**Recorded:** _not yet run — Yes/no ×3 + screenshot of the machine screen._

| Question | Answer |
|---|---|
| Studio accepted the file? (yes/no) | |
| Studio previewed it? (yes/no) | |
| Machine screen showed our `CAM` header's stock, tool and time? (yes/no) | |
| Screenshot (`docs/bench/img/…`) | |
| Notes (anything on the screen that differed) | |

**Goes to:** #173's open header question.

### D1b — The `N` word: does the firmware execute a numbered line? (low priority)

**Do.** In the air, spindle off, nothing in the collet. Send each line on its own — through
Studio's console if it has one, otherwise as a short air file — and watch the head:

| line | our parser predicts |
|---|---|
| `N10 G0 X5` | **ignored** — the number is stripped but the firmware keeps testing `N`, which matches none of its G/M/T/S branches |
| `N10 X5` | **executes** — the remainder starts with `X` and survives via the bare-axis path |

Does X move 5 mm in either case? Start from X0 so the move is visible.

**Expected.** `interpreter.ts:146–165` reads `GcodeDispatch.cpp` as ignoring an `N`-numbered line
and raises `n-line-ignored` — but that reading has never been checked on hardware, while the
vendor's FreeCAD machine definition ships a `line_numbers` option that implies the opposite. Both
cannot be true, and no file we hold settles it: `reference-gcode/` (26 files) has no `N` word.

**Recorded:** _not yet run — did the head move? yes/no ×2._

| Question | Answer |
|---|---|
| `N10 G0 X5` — did X move 5 mm? (yes/no) | |
| `N10 X5` — did X move 5 mm? (yes/no) | |
| Notes (anything shown on the screen) | |

**Goes to:** #174's `n-line-ignored` reading. Low priority — whichever way it lands, the user-facing
fix is the export wiring (#206: the verifier run on export, refusing to write), not the parser, so
nothing waits on this.

### D2 — Preview origin and axes

**Do.** In Studio's preview of D1: which corner is the origin, and which way do X and Y run
relative to the stock? Sketch it.

**Expected (hypothesis).** Origin at the stock's **top-front-left**; X and Y positive into the
stock; `ORIGIN x/y/z` states the origin relative to the stock's **centre** (front = −Y). That
`length` maps to X is unproven — one square sample (`/Makera-Parity.md` §6.1; `post/z1.ts:141-144`).

**Recorded:** _not yet run — a sketch._

| Field | Value |
|---|---|
| Origin corner (sketch or name) | |
| X direction relative to stock | |
| Y direction relative to stock | |
| `length` maps to X? (yes/no/unknown) | |

Sketch: `docs/bench/img/D2-origin-axes.jpg` (or paste an ASCII sketch here)

**Goes to:** `/Makera-Parity.md` §6.1 — the `topFrontLeft` / "front = −Y" hypothesis, and whether
`length` is X.

### D3 — Time the air run

**Do.** Run D1 in the air. Time it with a stopwatch.

**Expected.** Compare with the simulation's "simulated time" — this calibrates
`DISPLAY_RAPID_MM_MIN` (3000 mm/min, `src/workers/sim/session.ts:127`; #197).

**Recorded:** _not yet run — wall-clock seconds._

| Field | Value |
|---|---|
| Wall-clock run time (s) | |
| Simulation's "simulated time" (s) | |
| Ratio / difference | |

**Goes to:** #197.

### D4 — Air-run the default engrave job

**Do.** If #206 is done: generate the default engrave job, raise work Z by 20 mm, and air-run it
over a clamped blank. Watch the clearance to the jaws at the lowest point.

**Expected.** The default job is 100 × 60 × 12 softwood, three labels — CASE 14 mm / 2.0 deep,
MAKER 12 / 1.0, "first chips" 8 / 0.5 — with tool `flat-1.0` (1 mm flat) **unless A1 changes it**
(`engrave/defaults.ts:55-115`). The vise dimensions are still §A3 defaults (`source: 'default'`,
uncertainty 2 mm), so the app's collision check will warn.

**Recorded:** _not yet run — notes; video if possible._

| Field | Value |
|---|---|
| Lowest-point clearance to the jaws (mm, observed) | |
| Did the app's collision check warn? (yes/no) | |
| Notes | |
| Video (`docs/bench/img/…`) | |

**Goes to:** go / no-go for #209.

---

## E · Optional, same session

- **#209** — the first real cut — if D4 was clean. Its own record: `docs/bench/2026-10-first-chips.md`.

  | Field | Value |
  |---|---|
  | D4 clean? (yes/no) | |
  | Went on to #209? (yes/no) | |

- **#165's depth ladder** on the printed blank already waiting (CNC-3). Its procedure is in that
  issue; it shares this setup time but **not this fixture** (`/Fabrication.md` §7.3 / #191 item 6).

  | Field | Value |
  |---|---|
  | #165 ladder run this session? (yes/no) | |
  | Notes | |

---

## After the session — where the results land

- **#187 item 1** closed with the B1 screenshot.
- **`/Simulation.md` §9 item 7** closed or restated with C2's measured limit and B2's values.
- **#174's `n-line-ignored` reading** confirmed or corrected by D1b.
- Every `PROVISIONAL (#208)` marker in code replaced by a measured value with its date, or left
  PROVISIONAL with the reason it could not be measured — see the inventory below.

## PROVISIONAL (#208) inventory — what this session is meant to replace

| Marker (value) | File:line | Resolved by |
|---|---|---|
| `holder: null` | `machine.ts:168-170` | A2 |
| `VISE_BODY_DEPTH = 20` | `fixture.ts:36` | A3 |
| `GRIP_MIN = 3` | `fixture.ts:43` | A3 / A5 |
| `DEFAULT_UNCERTAINTY = 2`, `SAVED_UNCERTAINTY = 0.5` | `fixture.ts:55-58` | A3 |
| `DEFAULT_VISE` five numbers | `fixture.ts:70-78` | A3 |
| `vise-grip-shallow` message | `fixture.ts:211` | A5 |
| "vise dimensions … awaiting #208" | `engrave/defaults.ts:46` | A3 |

Other `PROVISIONAL` markers in the tree are **not** #208's: `#205` (EngravePreview.tsx:28),
`#197` (SimMeshes.tsx:21), `#213` / `#218` (`sacrificial.ts:22,66`; `engraveJob.ts:190`).
