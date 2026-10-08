# Bench day 1 — the Z1 settle-in runbook (#208)

**What this is.** Every number and behaviour the CNC plan currently *assumes* about the
physical machine, collected into one ordered checklist for the first visit to the hardware.
Sections A–C move nothing (A–C run with the spindle off and **nothing in the collet**); D is
air-only; the real cut is E and belongs to #209. Nothing here cuts material except the last,
optional step.

**Status: partly run — 2026-10-06 and 2026-10-07.** Every **Expected** value below is a *reading*
of the code or a document — never a measurement of this machine. Every **Recorded** form is
**blank** until the session fills it in at the machine. When the machine disagrees with a
document, the machine is right and the document changes.

*What has run so far:* **B0, B2, B4 (partial), B5, B6, B7, B8, B9, C1** on 2026-10-06/07, **A7
(one cutter)** and **D1 (partial)** on 2026-10-07. Everything else is still blank. B0 was recorded
before the first session, over the network, with nothing sent but two identify queries and a status
poll. Two items have been **parked** rather than left looking merely un-run — **C2** (blocked, see
its own note) and **D1**'s header question — and both say so in place.

*Added 2026-10-07 after the fact:* **D0**, which is Studio's Machining Wizard. It was not in this
runbook when the session started, and it is the reason D1 could not run as written.

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

**Read the right number off Studio's DRO.** Several items below ask for a *machine* position, and
Studio's Control panel shows **two numbers per axis**: a large value, and a smaller grey value
underneath it. They are **not** the same coordinate:

| Position | Which value | 2026-10-06 reading, at rest |
|---|---|---|
| **WPos** — work position | the **large** number | X 147.400, Y 123.800, Z 57.633 |
| **MPos** — machine position | the **small grey** number | X −1.000, Y −1.000, Z −1.000 |

Every "machine position" blank in this file means the **small grey** number. This was established by
first contact, not by guessing: B0's own `?` status line returned
`MPos:-1.0000,-1.0000,-1.0000` and `WPos:147.4000,123.8000,57.6325` while Studio's panel showed
large 147.400 / small −1.000 on the same axis. The two agree exactly, so the mapping is certain.
The gap between them is the active work offset — **+148.400, +124.800, +58.633** on this machine.

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

**Recorded 2026-10-08 — the set, photographed boxed; nothing measured yet.** The maintainer laid out
every cutter that came with the machine: `docs/bench/img/a1-all-cutters-boxed.jpg`. **38 by my count
from the photo** (to be confirmed by hand), in five colour-coded box groups, **every one branded
MAKERA CARVERA** — there is no Z1-badged cutter in the set (A7). Readable from the photo, label by
label still to come:

| Box colour | Count (photo) | What the one legible label says |
|---|---|---|
| green | 1 | *Spiral "O" Single Flute Bit for Metal — 1/8" shank, 1 mm × 3 mm* — the closest thing to `flat-1.0`, the app's default cutter |
| blue | 5 | *Two Flute Ball Nose Bit for Metal — 1/8"…* |
| orange | 7 | *…Flute Engraving…* (V-bits, by the family) |
| yellow | 17 + 8 | not legible at this distance |

Every label carries the same QR-plus-text layout as the one decoded on 2026-10-07, so one close-up per
group, labels square to the camera, decodes all 38 slugs and reads the human line under each. The
table below is still the measured record and is still empty: a boxed catalogue cutter's geometry
comes from its catalogue row (#307, `g_ID`), and A1's calipers become a **spot check** of that row
rather than the only source.

**Recorded:** _measurements not yet taken — table (type, cutting ⌀, flute length, shank ⌀, overall length, flutes)._

| # | Type (flat/ball/V/drill) | Cutting ⌀ (mm) | Flute length (mm) | Shank ⌀ (mm) | Overall length (mm) | Flutes | Notes |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |
| 4 | | | | | | | |
| 5 | | | | | | | |
| 6 | | | | | | | |

Photo of all cutters with a ruler: `docs/bench/img/a1-all-cutters-boxed.jpg` (boxed, no ruler — the
boxes are the catalogue's; a ruler shot waits for the unboxed spot check)

**Goes to:** `src/engine/cnc/toolLibrary.ts` — one entry per **flat end mill**,
`provenance: 'measured, bench day 1'`; other shapes listed in this file only. This also decides
#200's default cutter.

### A2 — Collet nut and stick-out

**Do.** Caliper the collet nut: outside diameter and height. Then fit a cutter with its
**collar** and caliper the collar as well — its outside diameter, its height, and how far it sits
from the nut face — because the collar is the thing that fixes the protrusion, so its geometry is
what makes a stick-out repeatable across tool changes rather than a number that happens to be
right today. Measure stick-out from the nut face to the tool tip. Photograph the collar seated on
a shank with a ruler in frame: the placement is what has to be reproduced, not just the length.

**Expected.** `Z1.holder` is `null` — "PROVISIONAL (#208): the collet nut has never been
measured" (`machine.ts:463-465`), so the fixture gate reports "cannot be proven". **Tool
`stickout`: `null` for every entry** — the header's `sticklength=0` means *unset* and parses to
`null`, deliberately not `0` (#305 design point 1; `tool.ts` `stickoutFromRecord`), and `flat-1.0`
carries no lengths at all. Bit collars set ~12 mm exposed length by default
(`/Fabrication.md` §1), and `Tool.stickout` is *that* exposure, not a catalogue figure
(`/Fabrication.md` §1). Do not transcribe the ~12 mm default as a measurement: the number that
goes into the library is the one the calipers read.

**Recorded:** _not yet run — nut ⌀, nut height, collar ⌀, collar height, collar-to-nut gap,_
_stick-out (6 numbers)._

| Field | Value |
|---|---|
| Collet nut outside ⌀ (mm) | |
| Collet nut height (mm) | |
| Collar outside ⌀ (mm) | |
| Collar height (mm) | |
| Collar face → nut face (mm) | |
| Stick-out, nut face → tool tip (mm) | |

Stick-out per cutter, if it differs from the collar default (cutter # from A1). Re-measure it
whenever a cutter is re-collared: a new length invalidates a saved job's stick-out, which is why
the job keeps the `Tool` it was generated with (#305 design point 2).

| Cutter # | Stick-out (mm) |
|---|---|
| | |
| | |

**Goes to:** `Z1.holder` in `src/engine/cnc/machine.ts` (#204) and each owned cutter's `stickout`
in `src/engine/cnc/toolLibrary.ts` — as the exposure that cutter is **collared to**, which is
per-installation and not a catalogue figure (`/Fabrication.md` §1, #305 design point 1). #212's
inventory item carries its own materialised snapshot of the same value.

### A3 — Caliper the vise

**Do.** Jaw opening range (min, max), jaw length (Y), each jaw's thickness (X), jaw height above
the vise bed, the soft-jaw slot (width, depth) and any lip over the part's top edge. Photograph
from above and from the front with a ruler in frame.

**Expected (every value is a placeholder).** `DEFAULT_VISE` — `stockProud 4`,
`fixedJawThickness 15`, `movingJawThickness 15`, `jawLength 80`, `jawStartY −10`
(`fixture.ts:101-105`); `VISE_BODY_DEPTH 20` (`fixture.ts:36`); `GRIP_MIN 3` (`fixture.ts:43`);
uncertainty bands 2 mm (default) / 0.5 mm (saved) (`fixture.ts:55-58`). Known from the vise's
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

**Recorded 2026-10-08 — the camera's own view, not yet the mount.** The stream was reached from the
bench harness (`node tools/z1/z1.mjs camera 192.168.10.43`; `/Z1-Bridge-Protocol.md` §10): 640 × 480
JPEG, ~10 frames/s, machine idle at the homed position. First frame:
`docs/bench/img/camera-2026-10-08-first-frame.jpg` — the X rail and the bed plate under the green
light. Whether that view moves with the head is exactly the open question: **take one frame before
and one after #293's first X/Y move** and compare — if the bed plate shifts in the picture, the camera
is on the head.

| Field | Value |
|---|---|
| Mounted on (head / frame) | **Frame — on the left side wall of the enclosure** (maintainer, 2026-10-08). Fixed camera; the bed and the vise move through its view in Y, the head in X. The frames could not show this because the module replays its last frame to a new client (bridge protocol §10). |

Photo: `docs/bench/img/A6-camera.jpg` (of the mount, by hand)

**Goes to:** #189, #286.

### A7 — Barcodes on the cutters

**Do.** Photograph the label on every cutter's packaging (and the shank, if anything is marked
there). Decode each with a phone.

**Expected.** Unknown. The only id we hold is `TopClamp.nc`'s `;@MKR|TOOL|…|id=112111313812`
(12 digits, **not** a valid UPC-A — its check digit would be 5, not 2; #212). Our post emits
`id=<tool.id ?? 0>` (`post/z1.ts:150`); the `three-strokes.nc` fixture uses `id=0`.

**Recorded 2026-10-07 — ONE CUTTER. A7 is not complete.**

**It is a QR code, and it says `C1-BIT-BALL-NOSE-1-4`.** That is a readable slug, not a number:
not the 12-digit catalogue id, not a retail EAN/UPC, and not a URL. Label photo:
`docs/bench/img/a7-makera-carvera-ball-nose-1-4-label.png`.

Decoded offline from the photo — 24 independent successes across crop, scale and threshold variants,
all returning the identical string, so this is not a single lucky misread. (OpenCV's
`QRCodeDetector`; nothing was sent anywhere.)

**Two caveats before this is generalised.**

1. **The label is branded MAKERA CARVERA, not Z1.** This is a Carvera-line cutter, and the `C1-`
   prefix may be that family's. Whether Z1-badged cutters use the same scheme is **untested** — a
   Z1 cutter's label is the obvious next photograph.
2. **One label proves one label.** A7 asks for every cutter; this settles the *symbology* question
   and the *shape* of the payload, not the whole vocabulary.

**What it means for #212.** The issue's three-way table ("catalogue id / retail barcode / URL") has
a fourth answer it did not list: **a human-readable product slug**. Three consequences:

- The 12-digit `id=112111313812` in `TopClamp.nc`'s header is **not** what the label carries, so the
  slug→geometry mapping is still open — either `makera_library.db` is keyed by the slug, or there is
  a mapping we have not seen. That is a desktop-build question (#181).
- **The slug is parseable**, which #212's "prefill anything parseable from the decoded text" step can
  actually use: `BALL-NOSE` is the cutter type and `1-4` reads as 1/4 in (6.35 mm). Worth confirming
  against the cutter's measured geometry in A1 rather than assuming.
- A QR of this size in a photograph is exactly what the browser's `BarcodeDetector` API is for, which
  is what #212 already proposes. This does not change that design.

**Recorded 2026-10-08 — the first of the two open questions is closed, from the DB (#307).** The
library database was dumped read-only (`docs/bench/2026-10-08-makera-library-schema.md`). The slug
`C1-BIT-BALL-NOSE-1-4` **appears nowhere in it** — every text column of every table was searched for
`C1-BIT` and `BALL-NOSE`. The one table shaped to bridge a slug to a `g_ID` is **`t_SkuMapping`**
(`g_ID ↔ Shopify sku`, with `shopifyRegion` and `url`), and it is **empty**, so Studio resolves the
slug **online**. There is also no 1/4-inch (6.35 mm) ball nose in the catalogue by name — its ball
noses are 3.175, 4 and 6 mm. So "either the DB is keyed by the slug, or there is a mapping we have
not seen" now reads: **there is a mapping, and it is a network one we do not hold.** The remaining
A7 row was the **Z1-badged** label — **and there is none to photograph (2026-10-08, A1's photo): every
cutter that came with the Z1 is branded MAKERA CARVERA.** Caveat 1 above therefore closes the other
way: the `C1-` Carvera scheme is the only scheme this machine's cutters carry. What is still open is
the vocabulary — one close-up per box group decodes the other 37 slugs.

| Cutter # (from A1) | Symbology | Exact decoded text | Equals `112111313812`? |
|---|---|---|---|
| A1 not yet run | **QR** | `C1-BIT-BALL-NOSE-1-4` | no |
| | | | |
| | | | |
| | | | |
| | | | |

**Goes to:** #212 — the symbology and payload shape are now known for one cutter; the remaining A7
rows decide whether either generalises.

### A8 — Caliper the Makera 3D Probe's tip

**Do.** Measure the diameter of the probe's touching tip (the ball or stylus end that contacts the
work) with calipers, at its widest. Photograph it against the scale. Note which probe it is — the
**Makera 3D Probe**, not the 3D Probe Rod, and not the wired Z-only probe the machine ships with;
they are three different parts (`/Fabrication.md` §1) — and if the tip is a ball on a stem, the
stem diameter too.

> **Superseded 2026-10-08.** The 3D Probe is not the touch-off probe — the wired probe is
> (`/Fabrication.md` §7.3, revised) — so the tip that `registration.ts:43`'s 3 mm assumption
> stands in for is the **wired probe's**. Caliper that one instead, same fields; the 3D Probe's
> tip only matters if it is ever fitted.

**Expected.** Unknown. Makera publishes no figure. The code assumes **3 mm** — "the common ball for a
probe of this class" (`engrave/registration.ts:43`, `PROBE_SPEC` at `:57`; `cncProbePlan.spec.ts`
used the same). The tip sets how far a touch stands off a corner and how short an edge may be, so
the plan's *edges and axes* are sound whatever it is, but the millimetre along them is nominal until
this is measured. Nothing in A1–A7 measures it: A1 is cutters, and the probe is not one.

**Recorded:** _not yet run — one number + one photo._

| Field | Value |
|---|---|
| Probe (3D Probe / 3D Probe Rod / wired Z-only) | |
| Tip diameter, mm (widest) | |
| Stem diameter, mm (if a ball on a stem) | |

Photo: `docs/bench/img/A8-probe-tip.jpg`

**Goes to:** `PROBE_SPEC.tipDiameter` in `engrave/registration.ts`, replacing 3 and its
`PROVISIONAL (#208)` note; #188 (the probe plan's stand-off). Pin it with a `cncProbePlan.spec.ts`
case so a changed tip moves the planned touch points.

---

## B · Ask the controller — no motion

Connect with Makera Studio and use its console/terminal. **Read each command aloud** to the person
at the machine before sending it.

**B0 was run before the session, from the network, with no Studio and no motion.** It is recorded
here because it answers controller questions the items below otherwise ask of a human at the
console, and because it is the first thing in this project ever verified against real hardware.

### B0 — Bridge first contact (our protocol, not Studio) — **RUN 2026-10-06**

**Do.** With the machine powered on and on the LAN, run the bench harness — a Node implementation of
the same five-call transport seam the desktop build uses, driving the real
`src/platform/desktop/protocol.ts`:

```
node tools/z1/z1.mjs discover
node tools/z1/z1.mjs identify 192.168.10.43
node tools/z1/z1.mjs status   192.168.10.43
```

Discovery only listens. The other two send one query each; neither moves an axis.

**Expected.** Name `CARVERA_AIR_01001`-shaped (`configZ1.default`); a 4-field discovery datagram;
`M482.5`/`M482.4` replies of unknown format; firmware assumed current; the UDP broadcast assumed
unreachable outside Windows (`Z1-Bridge-Protocol.md` §1, §2, §4, §9).

**Recorded 2026-10-06.** Machine found at **192.168.10.43**, MAC `e0:72:a1:cf:6f:ec`, idle.

| What | Raw, as received |
|---|---|
| Discovery datagram | `Makera_Z1_010290,192.168.10.43,2222,0,Idle` — **5 fields; field 4 (`Idle`) is undocumented** |
| Broadcast rate | ~3 per second, continuous |
| `M482.5` | `"STA param[5]:192.168.10.43\n"` |
| `M482.4` | `"STA param[4]:E0-72-A1-CF-6F-EC\n"` |
| Status (`?`) | `<Idle\|MPos:-1.0000,-1.0000,-1.0000,0.0000,0.0000\|WPos:147.4000,123.8000,57.6325,…\|F:0.0,2000.0,100.0\|S:0.0,10000.0,100.0,…\|T:6,-17.696,-1\|…>` |

Four things follow, and each is recorded where it belongs rather than here:

- The machine **is ours**: the IP and MAC it reported match the host we connected to. That is what
  §4's exchange is for. (A *different* device at `192.168.10.126` also answers on TCP 2222 —
  unknown, and not this machine. Never connect to the wrong box: run `identify` first.)
- **Current firmware, not legacy** — the framed protocol of §3/§5 was spoken and understood.
- `MPos` is negative while idle, consistent with `Z1.envelope`'s −200…0 convention. This does
  **not** close **B4**, which asks for the position *after homing*; the machine was not homed here.
- `T:6,-17.696,-1` in the status line looks like an active tool number and an offset, and is
  relevant to **B3** and **C6** — but it is a reading of a status line, not an `M499`, so B3 stands.

**Goes to:** `Z1-Bridge-Protocol.md` §1, §2, §4, §6 and the §9 table (all updated 2026-10-06); the
unknown 5th field and the `192.168.10.126` neighbour to **#275**.

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

**Recorded 2026-10-06 — RUN.** Console, verbatim:

```
[13:00:39] config-get sd soft_endstop.enable
[13:00:40] sd: soft_endstop.enable is set to true
[13:00:50] config-get sd soft_endstop.x_min
[13:00:50] sd: soft_endstop.x_min is set to -207.00
[13:01:00] config-get sd soft_endstop.y_min
[13:01:01] sd: soft_endstop.y_min is set to -206.0
[13:01:11] config-get sd soft_endstop.z_min
[13:01:11] sd: soft_endstop.z_min is set to -102.0
```

| Query | Value | Expected | |
|---|---|---|---|
| `soft_endstop.enable` | **true** | false | ❌ **ENABLED** |
| `soft_endstop.x_min` | **−207.00** | −206.0 | ❌ 1 mm off |
| `soft_endstop.y_min` | **−206.0** | −206.0 | ✅ |
| `soft_endstop.z_min` | **−102.0** | −102.0 | ✅ |

**The endstops are ON.** The shipped default is `false`, and the whole envelope argument in
`/Simulation.md` §9 item 7 rests on the controller *not* enforcing a limit — *"nothing in the
controller stops a move at either number."* On this machine something does. The config has been
changed since it was read, or has drifted from the default that was read; either way **the device
value is what counts, and it makes `envelope` a conservative choice rather than the only limit
there is.**

**X is 7 mm past the vendor's 200 mm, not 6.** Y and Z are as documented, so this is not a
systematic misreading — and the query form is proven correct by the other three answering. `x_min`
was also read back as `-207.00` (two decimals) against `-206.0` (one) for the others, which is a
difference in *formatting* and not evidence of anything.

**This also serves as the control for B6:** the `<group>.<key>` naming and the
`configZ1.default` readings do describe this machine, so B6's `clearance_x is not in config` is a
genuine absent key, not a broken query.

**Goes to:** `/Simulation.md` §9 item 7; the `softEndstop` record on `Z1` (#192 q5) — **both now
corrected, `src/engine/cnc/machine.ts` and `tests/unit/cncMachine.spec.ts`**. Why the config
differs from the shipped default is **#279**, and closes only by reading `/sd/config.txt`.

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

**Recorded 2026-10-06 (partial).** Read at rest **after the machine's own power-on homing** — the
quick-start says it homes every axis on power-on, and the all-axes-identical figure is what a
homing back-off looks like. **Not** a deliberate re-home, so treat the "after homing" premise as
assumed rather than proven until the Home button is pressed and the reading repeats.

| Axis | Machine position after homing (MPos, the small grey number) |
|---|---|
| X | **−1.000** |
| Y | **−1.000** |
| Z | **−1.000** |

**The sign convention holds; the zero point does not.** `−200…0` / `−200…0` / `−100…0` is
consistent with everything seen, but the expected `0` on every axis is wrong: the machine sits at
**−1.000**, not 0. A 1 mm back-off after the switch trips is the obvious reading, and it is
consistent with C1's Z (see below). One deliberate re-home closes this.

**Repeated 2026-10-08, 15:25 UTC.** The same power-on homing, read through our console this time:
during homing the status is `<Home|MPos:0.0000,0.0000,3.1009,…>`, and the first `Idle` after it
reads `MPos:-1.0000,-1.0000,-1.0000`. Same figure, second power cycle — still the power-on homing,
not a deliberate `$H`, so the premise above stands as stated.

**Goes to:** confirms the envelope's sign convention (`Z1.envelope`); the −1 offset goes with
`machine.ts`'s homing comment.

### B5 — Firmware identity

**Do.** Firmware version, and whether the machine identifies as Z1 or Z1 Pro.

**Expected.** Unknown. `t_MachineType` has one `Makera Z1` row; `/Fabrication.md` §1 notes
"there is a Z1 Pro" and that `Z1/QuickStart` is written for "Makera Z1（Z1&Z1Pro）".

**Recorded 2026-10-06.** Studio prints the version itself on connect, so this needed no query:

```
[12:42:55] Connected to machine!
[12:42:55] download /sd/config.txt
[12:42:57] version = 1.1.2.0.1.13
[12:42:57] ls -e -s /sd/gcodes
```

| Field | Value |
|---|---|
| Firmware version | **`1.1.2.0.1.13`** |
| Identifies as (Z1 / Z1 Pro) | **Z1** — from the discovery name `Makera_Z1_010290` (B0), not from this log; nothing on the panel says "Pro" |

Two incidental facts worth keeping: Studio pulls **`/sd/config.txt` off the SD card** on connect,
and lists **`/sd/gcodes`**. So the machine holds its own config and job directory on removable
storage, and B2's `config-get` queries are reading that file's live values.

**Goes to:** `/Fabrication.md` §1 and #184.

### B6 — The `coordinate.*` constants (clearance, anchors)

*Added 2026-10-06, from C1's result. Read-only; same command form as B2.*

**Do.** `config-get sd clearance_x`, `config-get sd clearance_y`, `config-get sd clearance_z`, and
`config-get sd safe_z` if that key exists.

**Expected.** `clearance_x` / `clearance_y` = **−11.6 / −14.6** — already confirmed on hardware by
C1. `clearance_z` = **−1.0** per `machine.ts:268`.

**Why.** C1 sent `G28` and the head stopped at machine **Z −3.000**, not −1.0. Either the profile's
`clearanceZ` is wrong or `G28` uses a different constant than `M6`. Asking the controller for its
own values separates those two **with no motion at all** — cheaper and safer than the `M6` or
`M491` endpoint observations that would otherwise be needed.

**Recorded 2026-10-06 — RUN. The group is `coordinate.*`, and Z is not what the profile had.**

```
[12:59:05] config-get sd clearance_x
[12:59:05] sd: clearance_x is not in config
[13:01:20] config-get sd clearance_z
[13:01:20] sd: clearance_z is not in config
[13:04:27] config-get sd coordinate.clearance_x
[13:04:27] sd: coordinate.clearance_x is set to -11.6
[13:04:35] config-get sd atc.clearance_x
[13:04:35] sd: atc.clearance_x is not in config
[13:04:43] config-get sd coordinate.clearance_z
[13:04:43] sd: coordinate.clearance_z is set to -3.0
[13:04:52] config-get sd atc.clearance_z
[13:04:52] sd: atc.clearance_z is not in config
```

| Query | Value | Profile had | |
|---|---|---|---|
| `coordinate.clearance_x` | **−11.6** | −11.6 | ✅ |
| `coordinate.clearance_z` | **−3.0** | **−1.0** | ❌ **fixed** |
| `atc.clearance_x` / `atc.clearance_z` | *not in config* | — | group was miscredited |

The first two replies are **not** syntax errors — the command parsed, the `sd` namespace resolved,
and the controller answered a *key* question — and B2's control proves the form. The bare names
are simply not keys. `machine.ts`'s provenance note credited **`coordinate.*`, `atc.*`** for six
values; clearance lives in `coordinate.*` alone, and `atc.*` holds neither.

**Two independent confirmations, which is why this closes #276 rather than moving it.**
`clearance_x` = −11.6 is exactly where C1 watched the head stop on `G28`, and `clearance_z` = −3.0
is exactly where it stopped in Z. A config read matching a watched machine position on two axes is
not a coincidence — and it rules out the alternative explanation from #276 (that `G28` used a
different constant than `M6`): the constant is simply −3.0.

**Then the anchors — `anchor2` was never missing, it was a different key name.**

```
[13:07:47] config-get sd coordinate.safe_z
[13:07:47] sd: coordinate.safe_z is not in config
[13:07:56] config-get sd coordinate.anchor1_x
[13:07:56] sd: coordinate.anchor1_x is set to -190.89
[13:08:05] config-get sd coordinate.anchor1_y
[13:08:05] sd: coordinate.anchor1_y is set to -193.83
```

| Key | Machine | Profile | |
|---|---|---|---|
| `coordinate.anchor1_x` | **−190.89** | −192.4 | ❌ **1.51 mm off** |
| `coordinate.anchor1_y` | **−193.83** | −194.3 | ❌ 0.47 mm off |
| `coordinate.safe_z` | *not in config* | −20.0 | not under `coordinate.*` either |

**`anchor1` is load-bearing, so this is not cosmetic drift.** Three positions derive from it:
`sensor = anchor1 + 181` on each axis, `changePosition = anchor1 + toolrack offsets + (132, 0)`,
and `anchor2 = anchor1 + (88.5, 45.0)`. With the machine's `anchor1`, the sensor would sit at
(−9.89, −12.83) rather than the profile's (−11.4, −13.3) — and the sensor is the spot an `M6`
drives Z down onto to touch off. **A wrong XY there aims a real probing move at the wrong place.**

**But the fix is not "replace the number", and this is the trap worth recording.** Correcting
`anchor1` alone would break the one derivation that currently agrees with hardware:
`anchor1 + offsets + 132` lands on X **−11.62** only with the *profile's* anchor. With the
machine's it lands on **−10.11** — 1.5 mm from the clearance position `G28` was watched arriving
at. So the **toolrack offsets must differ too**, and the two have to move together. Recorded, not
guessed at: a number invented here moves a probe.

This is the third value on this machine to disagree with the shipped config, after B2's `enable`
and `x_min`. **#279** is that issue, and now carries the anchors as well.

**Then the whole group, read with the new `config` harness command (13:25 onward, no typing).**

The bridge grew a `config` verb for this — `node tools/z1/z1.mjs config <host> <key> [<key>...]`,
which sends one `config-get` line per key. From here the keys were never typed by hand.

```
coordinate.anchor1_x = -190.89        coordinate.anchor_length = 100.0
coordinate.anchor1_y = -193.83        coordinate.anchor_width = 15.0
coordinate.anchor2_offset_x = 88.5    coordinate.rotation_offset_x = -7.5
coordinate.anchor2_offset_y = 45.0    coordinate.rotation_offset_y = 69.0
coordinate.clearance_x = -11.6        coordinate.rotation_offset_z = 17.0
coordinate.clearance_y = -14.6        coordinate.toolrack_offset_x = 48.8
coordinate.clearance_z = -3.0         coordinate.toolrack_offset_y = 181
coordinate.worksize_x = 200.0         coordinate.toolrack_z = -108
coordinate.worksize_y = 200.0
```

| Key | Machine | Shipped default | |
|---|---|---|---|
| `anchor1_x` | −190.89 | −192.4 | ❌ +1.51 |
| `anchor1_y` | −193.83 | −194.3 | ❌ +0.47 |
| `anchor2_offset_x` | **88.5** | 88.5 | ✅ |
| `anchor2_offset_y` | **45.0** | 45.0 | ✅ |
| `toolrack_offset_x` | 48.8 | 48.78 | ✅ (rounding) |
| `toolrack_offset_y` | **181** | 179.74 | ❌ +1.26 |
| `toolrack_z` | **−108** | *not in the default* | ✅ matches `sensorZ` |
| `clearance_x` / `_y` | −11.6 / −14.6 | −11.6 / −14.6 | ✅ |
| `clearance_z` | **−3.0** | −1.0 | ❌ −2.0 |
| `rotation_offset_x` | **−7.5** | 12.0 | ❌ −19.5 |
| `rotation_offset_y` | **69.0** | 85.5 | ❌ −16.5 |
| `rotation_offset_z` | **17.0** | *not in the default* | — |
| `worksize_x` / `_y` | **200.0 / 200.0** | *not in the default* | ✅ vendor's figure |

**`anchor2` was never absent — it is stored as an *offset from anchor1*, and it is exact.** The
earlier `coordinate.anchor2_x is not in config` was a wrong key name, not a missing feature. (88.5,
45.0) to the digit means **the anchor frame is intact on this machine and only its origin has moved**
— which was the open question B6 left, answered.

**`toolrack_z` = −108 is where `sensorZ` came from** — the constant the profile had credited to a key
nobody had read. And `worksize` = 200 × 200 restates the vendor's own figure from the machine itself.

**The `atc.*` group exists, and agrees with the profile exactly.** `atc.safe_z_mm` −20.0,
`atc.probe.fast_rate_mm_m` 500, `atc.probe.slow_rate_mm_m` 100, `atc.probe.retract_mm` 1 — every one
matching `machine.ts` digit for digit. This partly reverses B6's "the group was miscredited": `atc.*`
holds *no clearance keys*, but it is real and it is the source of the safe-Z and probe constants.
(`atc.action_rate_mm_s`, `atc.homing_max_travel_mm` and `zprobe.debounce_ms` are not in config.)

**The earlier reasoning that `anchor1` was confirmed by `clearance_x` was wrong, and this session's
reading is what disproves it.** `changePosition_x` = `anchor1_x + toolrack_offset_x + 132` computes to
−11.62 under the shipped defaults, and `clearance_x` is −11.6 — a 0.02 mm coincidence. But
`ATCHandler::fill_Autoclean_scripts` shows these are the **two opposite corners of the work area**
(it sweeps X between `clearance_x` and `anchor1_x`, Y between `clearance_y` and `anchor1_y`), not links
in a derived chain. Two independent config keys that happen to nearly coincide cannot confirm each
other, and a coincidence is not evidence. With the machine's own numbers the two differ by 1.5 mm and
that is simply correct behaviour.

**So `anchor1` is not disputed — it is calibrated.** The machine's `/sd/config.txt` is a calibration of
the shipped defaults, and it moved *several* keys together: both anchors, `toolrack_offset_y`,
`rotation_offset_*`, `clearance_z`. Nothing here says the profile's value is wrong; what it says is
that `machine.ts` describes a **stock Z1** and this machine is not one. **#279** is that question, now
with the full table to decide on rather than one number.

**Keys absent from `/sd/config.txt` are not unset, and cannot be read at all.** A key the file omits
falls through to the firmware's compiled-in default, and the `firm` source that would give that is
**answered with silence** on this machine (see `Z1-Bridge-Protocol.md` §5). So machine travel limits,
steps/mm and homing rates remain **unread, and cannot be read over this channel.**

> **CORRECTED 2026-10-07 (bench B9).** This paragraph read *"Every `alpha_*`/`beta_*`/`gamma_*` axis
> key answers not in config"*, and that is **false**. A full sweep of the firmware's own key list
> found three of them **do** answer: `alpha_max_rate = 1200.0`, `beta_max_rate = 1200.0`,
> `gamma_max_rate = 600.0` — the vendor put them in `/sd/config.txt`. The readable/unreadable split
> is **per key, not per group**, and the group-shaped claim was an over-generalisation from the pin
> and travel keys, which genuinely are absent. `alpha_steps_per_mm`, `alpha_min_endstop`,
> `alpha_max_travel` and the rest still answer *not in config*.

**Goes to:** `Z1.toolChange.clearanceZ` — **now −3.0** in `src/engine/cnc/machine.ts`, pinned by
`cncMachine.spec.ts`; **#276 closed**. `Z1.anchor1` is **left at the shipped default** with the
corrected reasoning and the full machine table on the constant — see **#279**.

### B7 — What the shell will and will not do (added 2026-10-06)

*Read-only, no motion. Recorded because three plausible ways to get `/sd/config.txt` whole all fail on
this machine, and each failure looks like a mistake on our side unless it is written down.*

**Do not retry these expecting a different answer.** Each was run through the bridge *and* typed by
hand into Studio's MDI:

| Attempt | Result |
|---|---|
| `cat /sd/config.txt` | `File not found: /sd/config.txt` |
| `cat /sd/config`, `cat /sd`, `cat /sd/gcodes`, `cat /local/config.txt` | same, for each |
| `ls`, `ls /sd`, `ls -e -s /sd` | **nothing at all** |
| `config-get-all`, `config-get-all -e` | **nothing at all** |

**The framing is not at fault.** The hand-typed attempt in Studio returns the identical message, so the
bridge's `0xA2` envelope carries the command correctly and reads the reply correctly. The failure is on
the machine's side of the wire.

- **`ls` is an empty function in the firmware.** `SimpleShell::ls_command` has a body that does
  nothing, which is why Studio's connect-time `ls -e -s /sd/gcodes` is silently empty. Not a fault.
- **`config-get-all` is not in the firmware's own `help` output**, and returns nothing when typed at
  it. Treat it as absent.
- **`cat` alone is broken, on a file everything else reads.** Measured, in this order:

  ```
  [13:35:19] md5sum /sd/config.txt
  [13:35:19] 00ceac76d7a4930bac754795b388f34b/sd/config.txt
  ```

  The file is there and the shell can open it — `md5sum` returned a hash for the identical path, and
  `config-get sd <key>` reads values out of it. Only `cat` reports `File not found`. In the published
  firmware `cat` and `md5sum` both reduce the argument to the same absolute string and call the same
  `fopen`, so **this build's `cat` is not the published `cat`**, and the published source cannot
  explain the failure. Recorded as unresolved rather than guessed at. Not blocking: nothing in the
  product needs file *contents* from the console, and the values this session was after came from
  `config-get`.

  `md5sum <path>` is worth remembering for another reason — it is a read-only command that asks the
  machine to hash a file **it** holds, which is an independent check on an upload the bridge has just
  verified by its own handshake.

**What works, and is now the supported path:** `config-get sd <key>`, one key per command, driven by
`node tools/z1/z1.mjs config <host> <key> [<key>...]`. See `Z1-Bridge-Protocol.md` §5 for the reply
forms and the two traps — that an unknown *source* is answered with silence rather than an error, and
that the one-argument effective-value form returns an empty cache on this build.

### B8 — How Studio actually downloads a file (added 2026-10-06)

*No machine contact. Read out of the desktop binary, because §9 had recorded the download direction as
unanswerable on the grounds that the ESP32 link module's firmware is not published — and the client was
sitting on disk the whole time.*

**Makera Studio is a native Qt/C++ application, not Electron.** `MakeraStudio.exe`, 54 MB, at
`%LOCALAPPDATA%\Programs\Makera Studio\`. Its strings and log format lines are legible, which makes the
*client* half of the transfer readable even though the machine's half is not.

What that reading settled:

- The transfer is a **stop-and-wait block protocol inside the ordinary `0x8668`/`0x55AA` envelope** —
  `CHECK_FOOTER: invalid frame end, expected 0x55AA`. Despite the class being named `XMODEM` and the
  log line `Cancelling XMODEM modem directly`, it is **not** wire-compatible XMODEM: no SOH/STX, no
  128/1024-byte block, no ACK/NAK.
- The messages are `FILE_VIEW`, `FILE_DATA`, `FILE_MD5`, `FILE_END` and `RETRY`; the receiver drives by
  sequence number; the sender sends the view; `FILE_END` is retried three times and then abandoned;
  a send that hears nothing for 9 s aborts.
- It is opened by the console line **`download <remote path>`**.
- **`The file's MD5 comparison is successful. No need to download the file.`** — Studio hashes the
  remote file first and skips the transfer when it already has it. That is the second independent use
  of `md5sum` found in one session, and it is why B7's `md5sum` row is worth more than it looked.
- QuickLZ rides the transfer path (`QuickLZCLI.exe`, `ftype == lz`, `Type_download_lz`, `the machine is
  decompress the nc file!`), so at least one direction moves `.nc` payloads compressed. Whether §5's
  raw upload is acceptable to this machine is now an **open question** — recorded in §9.

**What it does not change.** Only the client half is derived; the machine's replies are still inferred
from what the client expects, never observed, so no receive path gets written. And it is no longer
wanted: the config question this was opened for was closed by `config-get sd <key>`, and `/sd/config.txt`
is the file that is *missing* the compiled-in defaults, not the file that holds them.

The full sequence is in `Z1-Bridge-Protocol.md` §5, "The framed download, as the Studio client does it".

### B9 — The whole of `/sd/config.txt`, key by key (added 2026-10-07)

*Read-only, no motion. The file cannot be opened — `cat` refuses every path on this build (B7) and no
download path is implemented (§5) — so it was **reconstructed**: every key the firmware's shipped
`configZ1.default` names, asked for one at a time with `config-get sd <key>`.*

**`wifi.*` was skipped on purpose.** `/sd/config.txt` is exactly the kind of file that holds an SSID
and a password, and this record is committed. Two keys went unasked for that reason and are recorded
as unasked, not as absent.

**72 keys answer. 162 answer `not in config`. Zero failed any other way** — no timeouts, no unparsed
replies — so this is the complete picture rather than a partial one. Full record:
`docs/bench/2026-10-07-config-sweep.json`.

**Read it as a calibration, not a specification.** The machine is a stock Z1 whose card file has been
filled in; the ~162 keys it omits fall through to firmware defaults we cannot reach.

| Group | In the file |
|---|---|
| `coordinate.*` | 17 |
| `atc.*` | 13 |
| `laser_module_*` | 7 |
| `temperatureswitch.*` | 5 |
| `zprobe.*` | 5 |
| `soft_endstop.*` | 4 |
| `delta_*`, `epsilon_*` | 4 |
| `alpha_/beta_/gamma_max_rate` | 3 |
| `power.*`, `spindle.*`, `switch.*` | 6 |
| single keys | 8 |

#### Against the shipped default: 16 real changes, and the file is a subset

The sweep is only half the evidence. Every value was compared with the firmware's shipped
`configZ1.default` (233 keys), which turns "what does the file say" into **"what did the vendor
change."** The answer is unusually clean:

- **0 keys in the file that are not in the shipped default.** The file is a strict subset.
- **54 keys identical** to the shipped default — written in, but nothing was changed.
- **18 differ — of which 2 are cosmetic** (`default_seek_rate 2000 → 2000.0`,
  `temperature_control.spindle.max_temp 70 → 70.0`; same number, a decimal point added).

So **16 substantive calibrations**, and they are worth reading as a group:

| Key | Shipped | This machine | |
|---|---|---|---|
| `coordinate.worksize_x` | **300.0** | **200.0** | the Carvera's bed, overridden |
| `coordinate.worksize_y` | 200.0 | 200.0 | *unchanged* |
| `coordinate.anchor1_x` / `_y` | −192.4 / −194.3 | −190.89 / −193.83 | B6 |
| `coordinate.clearance_z` | −1.0 | −3.0 | B6, C1 |
| `coordinate.rotation_offset_x/y/z` | 12.0 / 85.5 / 23.0 | −7.5 / 69.0 / 17.0 | all three, the rotary |
| `coordinate.toolrack_offset_x` / `_y` | 48.78 / 179.74 | 48.8 / 181 | |
| `atc.action_mm` | 1.6 | 1.7 | |
| `soft_endstop.enable` | **false** | **true** | B2 |
| `soft_endstop.x_min` | −206.0 | −207.00 | B2 |
| `spindle.control_smoothing` | 0.1 | 2.5 | |
| `temperatureswitch.spindle.threshold_temp` | 35.0 | 60.0 | |
| `temperatureswitch.spindle.cooldown_power_step` | 10.0 | 2.0 | |
| `sd_ok` | false | true | |

**`worksize_x` is the one to look at.** The shipped default carries **300**, which is not a Z1
number — it is the family the firmware descends from, and the vendor's own comment already calls the
controller CARVERA. So the Z1's declared 200 mm is not inherited, it is **chosen**, keyed in on this
machine; `worksize_y` was already 200 and needed no change. That is a strong argument that the 200 in
`machine.ts`'s envelope is the vendor's real figure rather than a rounded profile number — and it
still says nothing about what the axis does past it, which is C2.

**Two of these were already in `machine.ts` as shipped values and are now measured**:
`clearance_z` (B6) and `anchor1` (B6, #279).

**A trap to avoid.** The file carries 7 `laser_module_*` keys — and all 7 are **identical to the
shipped default**. They are inherited stock config, not evidence that a laser is fitted.
`capabilities.laser: false` stands, and this sweep neither supports nor contradicts it.

**What it confirms.**

- `maxCutFeed: 1200` in `machine.ts` lands exactly on `alpha_max_rate` / `beta_max_rate = 1200.0`.
- `RotaryProfile`'s `maxRate: 3600` and `acceleration: 360` are the file's `delta_max_rate` and
  `delta_acceleration`, digit for digit. Two values that were "shipped default" now have a read
  behind them.
- The declared work area is the machine's own: `coordinate.worksize_x` / `_y` = 200.0 / 200.0.

**What is new.**

- `zprobe.fast_feedrate = 5`, `slow_feedrate = 1.5`, `return_feedrate = 20`, `probe_height = 2`,
  `max_z = 100`. C4 and C5 both probe; these are the rates the machine will actually use, and until
  now nothing in the repo held them.
- `coordinate.anchor_length = 100.0`, `anchor_width = 15.0` — the anchor bracket's own size, never
  read before.
- Motion timing: `acceleration = 150`, `default_feed_rate = 1000`, `default_seek_rate = 2000`,
  and the three `*_max_rate`. **D3 times an air run against the simulator's prediction, and this is
  the first evidence for that model.** `MillProfile` has no X/Y/Z rate or acceleration field to put
  them in — `maxCutFeed` is a *ceiling on what we ask for*, not the machine's own limit — so that is
  a decision, not a gap to fill quietly.
- `spindle.default_rpm = 10000` against the profile's `maxRpm: 13000`. Not a contradiction —
  a default is not a maximum — but 13000 still has **no read behind it**, and the file's
  `spindle.*` group does not carry a maximum.

**What it does not settle.** Steps/mm, homing rates, endstop pins and `alpha_max_travel` are all
absent from the file, so they stay unreachable (see the corrected note in B6). Travel limits remain
unread for the same reason — which is what C2 is for.

**Goes to:** `docs/bench/2026-10-07-config-sweep.json`; the `alpha_*`/`beta_*`/`gamma_*` correction in
B6; `Z1-Bridge-Protocol.md` §9.

---

## C · Move, spindle off, nothing in the collet

### C1 — `G28`

**Do.** Send `G28`. Read the machine position it stops at.

**Expected.** The clearance position: `clearanceZ` −1.0, `clearanceXY` (−11.6, −14.6)
(`machine.ts:157-159`; the change position computes to (−11.62, −14.56)). `G28` is "goto
clearance position", **not** home (`/Z1-Firmware-Dialect.md` §2).

**Recorded 2026-10-06 — RUN.** Entered in the MDI tab after `G90` / `G21` / `G17` (each answered
`ok`). Console, verbatim:

```
[12:50:59] G28
[12:50:59] ok
[12:50:59] G28 means goto clearance position on CARVERA
```

**The machine explained the trap in its own words.** That line is `Z1-Firmware-Dialect.md` §2's
caveat — *"`G28` is not 'home'"* — confirmed on hardware, printed by the controller unprompted. It
also names **CARVERA**, the family the firmware descends from.

| Axis | Machine position after `G28` (MPos) | Expected | |
|---|---|---|---|
| X | **−11.600** | −11.6 | ✅ exact |
| Y | **−14.600** | −14.6 | ✅ exact |
| Z | **−3.000** | −1.0 | ❌ → **profile fixed to −3.0** |

**X and Y are a bullseye** — the clearance corner computed from the vendor's config lands on the
real machine to 0.1 mm. **Z disagreed**, and **B6 settled it the same session**: the config's
`coordinate.clearance_z` is **−3.0**, and `machine.ts`'s −1.0 was a bad reading of the shipped
config. So the head went exactly where the machine was told to send it. The note that −1.0 is also
B4's homed rest Z — meaning a clearance of −1.0 would have left `G28` not moving Z at all — was the
tell. **#276 closed.**

**"It only moved a little" is correct behaviour, not a fault.** The machine was already parked at
the clearance corner: from B4's (−1.000, −1.000, −1.000) the move is 10.6 mm, 13.6 mm and 2 mm on
X, Y and Z. `G28` is a short trip to a known-safe spot, not a return to the far corner — which is
exactly why it is safe to use as a first motion test.

**Goes to:** `Z1.toolChange.clearanceXY` / `clearanceZ` — **both confirmed**, `machine.ts` now carries
−3.0 as measured. **#276 closed.** (This line read "Z open, #276" until B6 settled it the same
session.)

### C2 — The real travel limits (does the soft limit hold?)

*Rewritten 2026-10-06 after B6. The question changed: B6 read the soft endstops off the machine, so
this is no longer "what is the limit" — it is "can the limit be trusted."*

**UN-PARKED 2026-10-08.** R10 was reopened (#302): `tools/z1/z1.mjs console <host>` sends one typed
line at a time, through the bridge's guards, and records every line and reply to `docs/bench/traces/`.
The procedure is **#293 Stage 1** (it folds this item in as step 6), and it now takes a camera frame
(`tools/z1/z1.mjs camera`, #286) at the as-found position, at clearance, and after the first X/Y move
— the last pair answers A6 for free. §8 is unchanged: a person at the machine, hand near the stop.
The park note below is kept as the record of why it waited.

**Recorded 2026-10-08 (#293 Stage 1, 13:28–13:52 UTC).** Vise mounted, wired probe fitted, collet
empty, spindle 0, Z −3.0 (clearance) throughout; every line through `z1.mjs send`, trace
`docs/bench/traces/2026-10-08-console.log`. Directions are the maintainer's, standing at the front.

| Command | MPos before | MPos after | Direction moved (vs. the sign) | What the console said |
|---|---|---|---|---|
| `G28` | −1, −1, −1 (homed) | −11.6, −14.6, −3.0 | collet ends over the depth sensor, **back-right** | `ok` / `G28 means goto clearance position on CARVERA` |
| `G53 G0 X-100` | −11.6, −14.6 | −100, −14.6 | **left** (X− = head left) | `ok` |
| `G53 G0 Y-100` | −100, −14.6 | −100, −100 | **bed moved back**, away from the operator (Y− = tool toward the front of the work) | `ok` |
| `G53 G0 X-180`, `G53 G0 Y-180` | −100, −100 | −180, −180 | left; bed back | `ok` |
| `G91`; `G1 X-5 F300` × 5 | −180 | **−205** | left, 5 mm each, all Idle | `ok` each |
| `G1 X-5 F300` (6th, → −210; `x_min` −207) | −205 | **−205, no motion** | — | `ok` then `error:Soft Endstop X was exceeded - reset or $X or M999 required`; state **Alarm**; **beep + red blink on the head** |
| `$X`, `G90` | | | | `[Caution: Unlocked]` / `ok`; `G90` had been refused with `error:Alarm lock` while in Alarm |
| `G1 Y-5 F300` × 5, then a 6th (→ −210; `y_min` −206) | −180 | **−205**, 6th refused, no motion | bed back | same refusal, `… Soft Endstop Y …`, Alarm |
| `G28` | −205, −205 | −11.6, −14.6, −3.0 | | `ok`; ≤ 12.8 s for the diagonal |

**C2's two answers.** (1) The soft limit **holds**: the controller checks the destination before
moving and **refuses cleanly** — a message, an Alarm, no motion, no grind. (2) Whether the axis
*physically* reaches −207/−206 is **not tested** — the last accepted step was −205 on both axes and
the refused step would have gone to −210; a 2 mm bite from −205 would answer it. Rapid rate sampled
at ~1100–1400 mm/min on both axes (#281). Z not run (vise mounted).

**#275 (partial):** the broadcast still said `busy: false` during a `Run`. **#304:** no drop during
this 24-minute session, with a status poll every ~1.3 s throughout; the earlier two drops were with
nothing connected. **Stage 2 so far (wired probe, mechanical touch tip — photo
`docs/bench/img/293-s2-wired-probe-over-vise.jpg`):** a miss test `G38.2 Z-50 F300` from Z −3 over the
vise's back edge ran 50 mm and ended in **Alarm at Z −53** — the Z word is *travel*, a miss is an
Alarm, and the reply only comes when the move ends (`/Z1-Firmware-Dialect.md` §11.6). **Camera:** the module replays its last frame to a new client (§10 of the bridge
protocol), so every single frame taken today shows the *previous* position — A6 is not answered by
these frames; `camera.mjs` now skips the first.

**PARKED 2026-10-07 — blocked, not deferred.** The moves have to be typed into Studio's MDI *at the
machine*, and the bench harness cannot send motion. That is deliberate rather than a gap: `tools/z1/`
has no G-code passthrough, no jog and no MDI, and `Z1-Bridge-Protocol.md` §8 says the bridge "can
upload a verified `.nc` and report status; it cannot move an axis on its own." Adding a passthrough at
the bench to drive a soft-limit test is exactly what that rule is shaped to prevent.

The capability that unblocks it is **`/Makera-Parity.md` §14.4 R10** — jog / DRO / MDI in the app —
which is *refused until the bridge* and named there as gated on **#255** (`bridge: drive the Z1 from
the desktop build — discover, identify, upload a verified .nc`), in milestone **#9, "Local build:
what the browser cannot do."** Three things to know about that pointer:

- **#255 is the gate, not the delivery.** Its first pass excludes jog, DRO, MDI and the pendant by
  name — "and anything that moves the machine from the app without a file."
- **R10 needs no issue of its own — #255 already carries it.** Verified 2026-10-07 by reading #255:
  it names R10 twice, once as that scope exclusion and once under *"What this unblocks when it
  lands"* — "refused today *because* there is no bridge, with this as the named gate." An earlier
  version of this block said R10 was un-filed and therefore un-pointable; that was true but
  misleading, and it is withdrawn. Milestone **#4, "CNC-4: Bridge, camera, V-carve (deferred)"** is
  where the title suggests a bridge issue would live, and #255 calls out that it contains none — but
  R10 does not need one.
- **The demand is on the record.** [#255's comment of 2026-10-07](https://github.com/SlyWombat/CaseMaker/issues/255#issuecomment-6047006144)
  is the bench moment that parked this item written down where the refusal lives: the user at the
  machine, motion needed, the bridge refusing by design, **no scope change proposed.**

And the item is **runnable without any of it.** `/Fabrication.md` §8 requires a person at the machine
for motion in the first place, so remote motion was never C2's sanctioned path — and C2 tests the
*machine*, not our software. Studio can drive the axes by hand. Waiting on #255 is a choice, not a
constraint.

**Do — X and Y only.** With Z at the top of its travel (`G53 G0 Z-1`; nothing on the bed can be in
the way of a sideways move there), `G53 G0 X-200 Y-200`, hand near the stop. Did it get there? Then
`G91` and step toward the limit in 5 mm bites, noting the MPos after each, until the axis stops making
progress — and note what the console says when it does. Then `G90`.

**Z is NOT run, on purpose (2026-10-07).** C2 as first written said `G53 G0 Z-100`, which assumes a
bare bed. Z −100 is the **bottom of travel**, and the vise stays mounted, so the spindle nose would
reach the vise long before the axis reached anything and the reading would be about the vise.
Settling Z needs the vise off, or XY parked somewhere the vise is not — a separate trip, and no
reason to disturb the setup for it.

**Expected — measured, not read (B6, 2026-10-06).** `config-get sd` returned
`soft_endstop.enable true`, `x_min -207.00`, `y_min -206.0`, `z_min -102.0`. So the controller holds
a limit 7 mm (X), 6 mm (Y) and 2 mm (Z) past the vendor's declared work area of 200 / 200 / 100 —
**and it is ENABLED.** The earlier note here said "disabled"; that came from the *shipped*
`configZ1.default`, which reads `false` / `-206.0`, and it is withdrawn. This machine's config has
been changed or has drifted from the default it was read from.

Two questions, and the second is the one worth the trip:

1. Does the axis physically reach the soft limit, or bind short of it?
2. **Does the controller refuse cleanly at the limit** — a message and no motion — or does it
   grind, stall, or accept the move and lose steps?

**Why it matters.** `/Simulation.md` §9 item 7 refuses at −200. That refusal is the conservative side
of a real limit only if the declared 200 mm is *inside* what the machine will actually do, which B6
now says it is. But if the axis binds before −207, the usable travel is **less** than the machine
declares and the envelope should shrink rather than stay. Reading the config cannot tell the
difference; only a move can.

**Recorded 2026-10-08 — RUN, X and Y, through our own console (`tools/z1/z1.mjs send`, #293).**
The refusal half was taken in the morning (Stage 1: `G1 X-5` from −205 → `error:Soft Endstop X was
exceeded`, no motion, beep + red blink, `$X` clears it; same on Y). The reach half was taken at
15:26 UTC with the wired probe in the collet and Z at clearance (−3.0): each axis alone, `G53 G0
X-205` then `X-207`, and `G53 G0 Y-204` then `Y-206`, the other axis parked at its clearance value.

| Field | X | Y | Z |
|---|---|---|---|
| Reached −200 / −200 / −100? (yes/no) | **yes — and −207.000** | **yes — and −206.000** | **not run on purpose** |
| Where the controller actually stopped (machine coords) | **−207.000**, `ok`, `Idle` — exactly `soft_endstop.x_min`; the 2 mm step from −205 took 2.4 s send-to-Idle | **−206.000**, `ok`, `Idle` — exactly `soft_endstop.y_min`; 2.6 s | — |
| What it did at the limit — message / clean refusal / stall / nothing | **nothing** at −207 (no beep, no blink, no message); one step beyond is the **clean refusal** above | same | — |

Notes: the usable travel is therefore **not less** than the machine declares: both axes physically
reach the configured soft limit, 7 mm (X) and 6 mm (Y) past the vendor's 200, and the controller
neither binds nor loses position on the way (MPos read back exactly, and `G28` afterwards landed on
−11.6 / −14.6 / −3.0 as always). `/Simulation.md` §9 item 7's refusal at −200 is conservative by
exactly those margins. Frames `293-s3-x-207.jpg`, `293-s3-y-206.jpg`, `293-s3-back-at-clearance.jpg`
show the **bed** at each limit (the camera looks at the bed from the left wall; the head is out of
frame), so the MPos line is the evidence of position and the frames are the evidence that the bed
moved. Trace: `docs/bench/traces/2026-10-08-console.log`.

**Goes to:** `/Simulation.md` §9 item 7 — closes the −200 vs −207 question for **X and Y only**, and
answers whether the refusal at −200 is conservative or merely round there. **Z stays open**, and the
soft limit that matters for Z (−102) is the one we cannot reach with the vise on the bed.

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

> **Superseded 2026-10-08.** There is no wood job — the part is the printed PLA blank — and the
> **wired probe** is the touch-off probe in use (`/Fabrication.md` §7.3, revised): a mechanical
> tip that triggers on PLA, recorded below with a 0.001 mm slow spread. The 3D Probe run this row
> asked for is not needed; C4's figure is the wired-probe one.

**Expected.** The 3D Probe is rated for non-conductive material, so it should trigger on wood;
its repeatability has never been measured (`/Fabrication.md` §1, §7.6).

> **Partial, 2026-10-07 — two hits, 0.017 mm apart, and they count for less than they look.**
> The D1 session's auto-Z-probe triggered twice at one point, reported as
> `[PRB:-118.400,-109.800,-65.135:1]` at `F500` and `[PRB:…,-65.118:1]` at `F100`
> (`docs/bench/img/D1-probe-cycle-mdi-log.png`). That is **one point, twice, on an unidentified
> surface** — the bed or the vise, not wood, and not five repeats. It is the first probe figure this
> machine has produced and it is the right order of magnitude for C4 to be worth running properly;
> it is **not** C4's answer. The five-repeats-on-wood procedure below still stands.

**Recorded 2026-10-08 — on the printed blank, with the WIRED probe (not the 3D Probe, not wood).**
The wired probe is a mechanical touch tip (it triggers on contact, so PLA is fine). Five fast/slow
pairs at machine −168.4, −140.0, in the vise (`/Z1-Firmware-Dialect.md` §11.7):
slow (F100) triggers **−55.708, −55.707, −55.708, −55.708, −55.708** → **spread 0.001 mm**; fast
(F300) **−55.710 … −55.714**, spread 0.004 mm, reading 2–6 µm deep. The 3D Probe on wood — C4's own
question — is still open; this is the wired probe's figure on the blank we actually engrave.

**Blank flatness, same sitting (#191 item 10, the vise case).** 3 × 3 grid, an X line and a Y line
on the blank, and a Y line on the **fixed jaw's top** as the reference (`/Z1-Firmware-Dialect.md`
§11.8). The fixed jaw is straight to 2 µm with 0.068 mm of rise over 60 mm; the **moving jaw** (X −136) is 12–39 µm higher and parallel to it within 27 µm over 60 mm. The blank is **domed: ~0.33 mm
centre-to-edge across its 38 mm width, ~0.1 mm along its 76 mm length** — the printed-against-the-bed
face, now up, is convex. A single centre probe therefore over-reads the surface by up to 0.3 mm at
the width edges, which is of the order of the two-colour boundary's tolerance (#166, decision 12).
Frames: `docs/bench/img/293-s2-over-blank.jpg`, `293-s2-probe-over-fixed-jaw.jpg`.

**Recorded (3D Probe on wood):** _superseded — not needed, see above._

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

**Recorded 2026-10-08 — RUN, through our console (`tools/z1/z1.mjs send`).** Cutter: the 1 mm ×
4 mm two-flute ball nose (A1, yellow box, QR `C1-BIT-BALL-NOSE-1-4`), fitted with its collar; collet
nut and stick-out **not calipered** (A2 still open). Every `M491` echoes its macro to the console, so
the two `[PRB:…]` touches and the saved offset (`T:` field of the status line) were read directly;
`/Z1-Firmware-Dialect.md` §11.9 has the verbatim sequence.

**First, three runs with tool 0 active** (`T:0`, the state after power-up): each calibrated and saved,
then halted with `ERROR: Probe dead or not set, please charge or set first!` (`H:12`) — the firmware's
wireless-probe check, which runs because tool 0 means "the probe". Slow touches −85.781 ×3, offset
−9.757 ×3. Then `T1 M6` + `M490.2` registered the cutter as tool 1 (one more calibration: −85.775,
offset −9.752), and the five runs below are with **T1 active**, which is a real job's state. No alarm,
`Done ATC` each time, head back at clearance (−11.6, −14.6, −3.0) each time, 33.5 s per run.

| Run | Fast touch `G38.6 Z-108 F500` | Slow touch `G38.6 Z-2 F100` | TLO value (mm) |
|---|---|---|---|
| 1 | −85.793 | **−85.775** | **−9.752** |
| 2 | −85.793 | **−85.775** | **−9.751** |
| 3 | −85.788 | **−85.775** | **−9.752** |
| 4 | −85.789 | **−85.775** | **−9.751** |
| 5 | −85.794 | **−85.775** | **−9.751** |
| Spread (max − min) | 0.006 | **0.000** | **0.001** (the status line rounds to 1 µm) |

The slow touch moved from −85.781 (the three tool-0 runs, first minutes after fitting) to −85.775 (all
six runs after `T1 M6`), 6 µm, and the offset with it; observed, not explained — the cutter bedding in
the collet after its first touches is one reading, the fitted tool number is another, and nothing here
separates them. The `M491` term of the Z chain is therefore **≤ 0.001 mm run-to-run** on this sensor
with this cutter; the fast touch alone would be 20 µm worse, which is why the macro probes twice.

**Goes to:** the `M491` term of the Z chain (`/Fabrication.md` §7.6).

### C7 — `T1 M6` on an already-active tool

**Do.** With tool 1 already active and calibrated, send `T1 M6`. Does anything move?

**Expected.** The firmware does **nothing** — no change, no calibration
(`/Z1-Firmware-Dialect.md` §2). This is the no-op rule #207 section 4 warns about.

> **Informed but not answered, 2026-10-07.** The D1 session changed tools twice — cutter → Probe and
> back — and each time the machine **stopped and waited for an operator** (`M490.1`, with a dialog:
> *"Tool Change Required … Then press Confirm to continue"*), then ran an `M49x` block and reported
> `Done ATC`. That is a change to a *different* tool, which is not C7's case, so the no-op rule
> still has no hardware behind it. Worth knowing before running C7 that a real change **blocks**,
> so C7's "did anything move?" should be answered at the dialog, not after it.

**Recorded 2026-10-08 — RUN.** With T1 active and calibrated (C6), `T1 M6` from the console at
16:18:19 UTC.

| Field | Value |
|---|---|
| Did anything move? (yes/no) | **no** |
| If yes, what | — the reply was a single `ok`, no macro echoed, no `Please change the tool` line, state stayed `Idle` at clearance for the 13 s watched, and `T:1,-9.751,1` was unchanged: no change and **no recalibration**, exactly §2's no-op rule. |

For contrast, the same line with tool 0 active (minutes earlier) ran the full change: `Please change
the tool to: T1`, lift, `G53 G0 X-10.090 Y-12.830` (the change position — 0.2 mm in X from the
sensor), `M497.2`, `M490.1`, then state **`Tool`** with the status `T:0,-9.757,1` (the third field
is the tool being waited for) until `M490.2` carried it on through the sensor to `M493.2 T1`,
`M494.2`, `Done ATC`. So #207 section 4's warning stands: a job that opens with `T1 M6` does nothing
if T1 is already active, and a full, blocking change if it is not.

**Goes to:** #207 section 4.

---

## D · Run files — in the air first

### D0 — Studio's Machining Wizard (added 2026-10-07)

**Not in the runbook when the session started, and it changes D1's premise.** Studio does not run a
`.nc` when you press Start. It opens a **five-step wizard**, and nothing is machined until the last
step is confirmed.

```
Set Stock  →  Set Origin  →  Auto Probe  →  Assist Options  →  Run
```

**What each step carries** (observed 2026-10-07, screenshots below):

| Step | Controls seen |
|---|---|
| **Set Stock** | a bed map labelled `200.0 × 200.0 mm`, with the **L-bracket / anchor system drawn to scale** and ✕ clamp markers; radio `Anchor1` / `Custom`; *"Place the stock on the work bed and secure it firmly. We recommend using the anchor system and L-Bracket for quick and accurate positioning."* |
| **Set Origin** | `Relative to: Anchor1`, `X Offset` `42.490`, `Y Offset` `69.030`; buttons `Same As CAM` and `Set Origin with 3D Probe`; radio `Apply Settings`; toggle `Auto-Scan Machining Area` + `Scan Now` |
| **Auto Probe** | toggle `Auto Workpiece Leveling` (`Clearance Height: 5`, `X Points: 3`, `Y Points: 3`); toggle `Auto Z-Height Probing` (`Relative to: Path Origin`, `X Offset: 20.000`, `Y Offset: 7.000`) |
| **Assist Options** | five switches: `Auto Vacuum`, `Auto Blow`, `Auto Bed Clean`, `Anti-Static`, `Auto Time-Lapse` |
| **Run** | a summary of every setting above, then `Run` |

Evidence: `docs/bench/img/D0-wizard-1-set-stock.png`, `…-2-set-origin.png`,
`…-2-scan-now-mdi-log.png`, `…-3-auto-probe.png`, `…-4-assist-options.png`,
`…-4-assist-toggled-mdi-log.png`, `…-5-run-summary.png`.

**Four behaviours worth building on later:**

- **`Path Origin` means the toolpath's origin, not the work origin.** Verified by arithmetic rather
  than by reading it: the probe was configured `(20.000, 7.000) from Path Origin`, and the machine
  probed at **machine (−118.400, −109.800)** = **work (30.000, 15.000)** once the unchanged
  148.400 / 124.800 offsets are removed. 30 − 20 = 10 and 15 − 7 = 8, so Path Origin is work
  **(10, 8)** — the lower-left corner of the toolpath bounding box, which is exactly where this
  file's first stroke starts. It also explains the red `Z Probe` marker drawn at the centre of the
  green toolpath rectangle.
- **One setting carries three labels.** The pre-run checkbox, `Auto-Scan Machining Area` at the
  origin step, and `Scan Margin` on the summary are the same switch. Names like that are how a
  bridge gets wired to the wrong thing.
- **The wizard interposes an operator confirmation before it moves.** `Run` refuses to start until
  a person confirms, in a dialog, that the spindle holds the probe — *"Click the button below only
  after verification. If not, change to the probe first."* (`D1-tool-confirmation.png`.) The
  vendor's own client enforces *verify the physical machine before it moves*, which is
  `/Fabrication.md` §8's rule arriving as software. **The interlock held rather than silently
  probing**, which is the right design and worth copying.
- **The vendor recommends surface probing for our headline job.** `Auto Workpiece Leveling`'s own
  help text: *"Enable Auto Leveling for uneven surfaces or shallow cuts (<0.5 mm), especially for
  fine machining such as PCB and engraving bi-color sheet."* That is V1 — multi-font depth
  engraving on bi-colour sheet — named by Makera as the reason the feature exists. It makes **C4
  (probe repeatability)** the number that decides whether V1 needs levelling, not a curiosity.

**What the wizard is worth to the roadmap.** It is the closest thing to a specification of the
*setup* half of a job that we have: placement, origin, surface finding and post-job assists, as the
vendor models them. The bridge's first pass does none of it (`Z1-Bridge-Protocol.md` §8), and this
is now a written record of what "none of it" is.

**Recorded 2026-10-07.** Walked end to end with a bare bed, no blank and an empty collet. It
probed, moved and changed tools; it was stopped before the cut. See D1.

---

### D1 — Air program: does the machine take it, and does it read our header?

**Do.** Upload a tiny **air** program written by us: `casemaker-app/tests/e2e/fixtures/three-strokes.nc`
(#199), with every Z raised by 25 mm (the deepest stroke, Z −2.0 → +23.0, then clears the blank's
top face by 23 mm). It is **prepared for the trip at `docs/bench/208-D1-three-strokes-air.nc`**
(generated by `casemaker-app/scripts/bench-files.ts`; only the motion Z words are raised — the
header, including `ORIGIN z=3`, is untouched). Does Studio accept and preview it? Does the machine's
screen show our `CAM|id=CaseMaker` header's stock, tool and time?

**Expected.** The fixture is stock 60 × 30 × 6, a 3.175 mm flat, `T1 M6`, `S12000 M3`, three
strokes at Z −0.5 / −1 / −2, header `TIME seconds=30` and
`CAM|id=CaseMaker|name=Case Maker|v=0.0.0-test`. Our post's `CAM_ID = 'CaseMaker'`
(`post/z1.ts:58`) — whether the machine accepts a non-Studio id is the open question (#173; also
asked by #165 and #176).

**Recorded 2026-10-07 — PARTIAL. The premise above was wrong; the run was stopped on purpose.**

*The "Do" line says "upload it, does Studio accept and preview it". It does both — and then it opens
the wizard in **D0**, which requires a clamped stock before it will machine. This session had a bare
bed, no blank and an empty collet, so D1 got as far as a real probing cycle and no further. The run
was stopped at the tool-change prompt rather than confirmed.*

| Question | Answer |
|---|---|
| Studio accepted the file? | **yes** — listed as `208-D1-three-strokes-air.nc` in *Processing progress*, filename intact |
| Studio previewed it? | **yes** — the Monitor panel rendered the three strokes |
| Did anything show our `CAM` header's stock, tool and time? | **no, and there is no screen to show it on** — the Z1 has no panel of its own (confirmed at the bench), and Studio displays none of the three. The `Run` summary shows setup state instead, and `Processing progress` read `Remain 0m` against our header's `TIME seconds=30`. **This cell was mis-worded: it implied a display that does not exist.** |
| Screenshot | `docs/bench/img/D1-file-loaded.png`, `D1-pre-run-options.png`, `D1-tool-confirmation.png`, `D1-probe-cycle-mdi-log.png` |
| Notes | See below — the wizard, the tool changes, the probe cycle, and a **changed machine state the next session must know about**. |

**What the file did do, and it was more than a preview.** `Scan Now` sent the head around the
perimeter of the toolpath bounding box at machine Z −3.000, and the Auto-Z-Probe cycle ran a real
`G38.2` probe. The full command transcript — `M49x` tool-change codes, the probe, `[PRB:…]`, `G10
L20 P0 Z0.000` — is in `D1-probe-cycle-mdi-log.png` and written up in
**`/Z1-Firmware-Dialect.md` §11**, which is where dialect facts belong rather than here.

**⚠️ The machine's state changed, and it outlives the session.** The auto-Z-probe set the work
coordinate system from its trigger (`G10 L20`):

| | before 2026-10-07 | after |
|---|---|---|
| X / Y work offset | 148.400 / 124.800 | **unchanged** |
| Z work offset | 58.633 | **65.118** |
| Tool length offset | −17.696 | **0.0** |
| Active tool | cutter | **`Probe`** |

Z 65.118 is exactly the probed surface. **Any job set up against the old Z0 is now wrong by
6.5 mm**, and the controller believes the probe is loaded. The five `Assist Options` were also all
switched **on** (they were off before) — see `Z1-Firmware-Dialect.md` §11.3 for the codes and
§11.4 for what is not yet known about whether they persist.

**Goes to:** #173's open header question — **still open, and now differently shaped.** It cannot be
answered by reading a screen: there is no machine panel, and Studio shows stock, tool and time
nowhere — not in the preview, not in the `Run` summary, not in `Processing progress`. The remaining
question is whether a *non-Studio* `CAM|id` is **accepted**, which is behavioural: run a job with
ours and see whether Studio or the controller objects.

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

**Recorded 2026-10-07 — ANSWERED, from Studio's own rendering of this file's geometry.** The evidence
is the wizard's bed map (`docs/bench/img/D0-wizard-3-auto-probe.png`), measured against its own
`200.0 × 200.0 mm` label at ≈4.575 px/mm. This is a *screenshot* reading, so it is strong evidence
rather than a measurement — but two independent numbers agree with the hypothesis.

| Field | Value |
|---|---|
| Origin corner | **front-left** (`ORIGIN x=-30 y=-15` on a 60 × 30 stock *is* the front-left corner, centre-relative) |
| X direction relative to stock | **positive into the stock**, along the 60 mm dimension |
| Y direction relative to stock | **positive into the stock**, along the 30 mm dimension |
| `length` maps to X? | **yes** — the toolpath rectangle measured ≈41 × 14 mm against the strokes' X 10→50 (**40**) and Y 8→22 (**14**) |

- The **`Work Origin` dot** sits ≈**10 mm** to the −X of the toolpath rectangle's near corner.
  The file's first stroke starts at **X10**. That matches to within a pixel.
- The same Y figure reads 5–6 mm against an expected **8** — the one number that does not agree
  cleanly, and it is at the edge of what a screenshot can resolve. Recorded as approximate rather
  than rounded into agreement.
- **D0 corroborates it independently**: the wizard's `Path Origin` resolves to work **(10, 8)** —
  the lower-left of the toolpath bounding box, which is where stroke 1 begins, and only consistent
  with the origin being the stock's front-left corner.

Sketch: `docs/bench/img/D0-wizard-3-auto-probe.png` (the bed map; the blue dot is the origin)

**Goes to:** `/Makera-Parity.md` §6.1 — the `topFrontLeft` / "front = −Y" hypothesis **holds**, and
`length` **is** X. Still worth confirming with calipers on a real blank in A3/A5, since this reading
comes from a rendered map rather than the machine.

### D3 — Time the air run

**Do.** Run D1 in the air. Time it with a stopwatch.

**Expected.** Compare with the simulation's "simulated time" — this calibrates
`DISPLAY_RAPID_MM_MIN` (3000 mm/min, `src/workers/sim/session.ts:127`; #197).

**Run it expecting the estimate to come in LOW (#281).** B9 read the controller's own rates, and the
3000 assumption does not survive them: `default_seek_rate` is **2000**, `alpha_max_rate` and
`beta_max_rate` cap X and Y at **1200**, `gamma_max_rate` caps Z at **600**, and `acceleration = 150`
is not modelled at all. So a rapid is planned at roughly **1200 mm/min on X/Y**, not 3000, and every
move is timed as if it reached that rate instantly. Both errors point the same way. **A stopwatch
reading longer than the sheet's estimate is the expected result, not a fault** — record the ratio
either way, since the whole point is that this is the measurement and the config is only a reading.

**Recorded:** _not yet run — wall-clock seconds._

| Field | Value |
|---|---|
| Wall-clock run time (s) | |
| Simulation's "simulated time" (s) | |
| Ratio / difference | |

**Goes to:** #197; the rapid assumption itself is **#281**.

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
  Prepared for the trip: `docs/bench/165-depth-ladder.nc` with its run sheet at
  `docs/bench/165-depth-ladder-run-sheet.md` (the job document is beside them as
  `165-depth-ladder.job.json`). Two rows of six 5 × 5 mm squares, Row A over the pocket and Row B
  in the clear band; no result is recorded in any of them.

  | Field | Value |
  |---|---|
  | #165 ladder run this session? (yes/no) | |
  | Notes | |

- **The tape tilt** (#191 item 10) — four Z touches at the four corners of a taped blank, which
  sizes the one Z error a single touch cannot see (`/Fabrication.md` §7.3, §7.6). Its run sheet is
  `docs/bench/191-tape-tilt-run-sheet.md`: no `.nc`, no cutter, four touches and a subtraction.
  **It needs C4's repeatability in the same sitting** — a spread at or below the probe's own noise
  is not a tilt — and it is the one item here that **cannot share the vise's setup**: tape-down and
  the vise are mutually exclusive fixtures (§7.3).

  | Field | Value |
  |---|---|
  | Tape tilt measured? (yes/no) | |
  | Spread across the blank (max − min), mm | |
  | C4 repeatability this session, mm | |

- **The printer's first-layer Z-offset** (#187 item 6, filed as its own issue). No motion and no
  trip needed — read it out of the slicer profile that printed the blank, and record it beside the
  colour-change layer #165 step 1 measures, so the two can be checked against each other.

  Decision 24 treats the probed engraved face as Z0, and `layerStack.ts` puts the model's first
  layer on the bed; a `z_offset` (or elephant-foot compensation) in the printer profile lifts the
  real first layer off the bed and moves the colour boundary by that amount relative to the probed
  face, with no diagnostic. The question is only whether the offset is zero.

  | Field | Value |
  |---|---|
  | Printer profile's first-layer `z_offset`, mm (0 = decision 24 holds) | |
  | Slicer + version it was read from | |

---

## After the session — where the results land

- **#187 item 1** closed with the B1 screenshot.
- **`/Simulation.md` §9 item 7** closed or restated with C2's measured limit and B2's values.
- **#174's `n-line-ignored` reading** confirmed or corrected by D1b.
- Every `PROVISIONAL (#208)` marker in code replaced by a measured value with its date, or left
  PROVISIONAL with the reason it could not be measured — see the inventory below.

### What actually landed, 2026-10-07

This section is the honest ledger, because most of what tonight produced was **not** on the list
above — it was found by walking into a wizard this runbook did not know existed.

| Landed in | What |
|---|---|
| **`/Z1-Firmware-Dialect.md` §11** (new) | The dialect document's **first hardware-observed section**: §2's `M49x` macro seen running (`M490.1` confirmed as the operator wait), the probe cycle (`G38.2`, `[PRB:x,y,z:n]`, `G10 L20 P0`), and the `M331`/`M951` mode family. |
| **`Z1-Bridge-Protocol.md` §9** | Two rows: how a console command is acknowledged (observed indirectly, from the client's log), and whether the bridge must model the accessory modes (open, and deliberately outside the first pass). |
| **#283** (new) | The accessory modes are not air. `machine.ts` models only `M7`/`M9`, and no `M7`/`M9` appeared in the traffic. Includes the one-at-a-time toggle test that would turn an inferred mapping into an observed one. |
| **#255**, comment | Studio runs a file through a five-step wizard, so *uploading a `.nc` is not the same as being able to run it*. No scope change proposed; recorded so the gap is written down. |
| **#212**, comment | A7's first cutter decodes to a QR slug, not a catalogue id. |
| **D0** (new item) | The wizard itself, step by step, with screenshots. |
| **D2** | Answered — origin is the stock's front-left, `length` is X, and X/Y run positive into the stock. |
| **D1** | Partially answered, with the premise corrected and the machine-state change recorded. |
| **C4** | A partial figure (two hits 0.017 mm apart) marked explicitly as *not* C4's answer. |
| **D3** | **Not run.** The stopwatch number #281 is waiting for was not taken — the run was stopped before the cut. |

### The first upload, 2026-10-07 — a new item the runbook did not have

Not a runbook item: **#255's upload path was exercised against the machine for the first time**, and
it is the one thing tonight that *wrote* to the controller rather than reading it. A verified
28 668-byte engrave program (`165-depth-ladder`, `md5 6e9b97a9b51c3561f3c44150fb1b92ba`) went from
the app's own bridge — `asVerifiedProgram` and `uploadVerifiedProgram`, not a bench script — over
`tools/z1/transport.node.mjs`, which implements the same five-call `MachineTransport` seam the Tauri
transport does. **The Rust socket layer is not covered by this**; the protocol is what was proved.

| What | Result |
|---|---|
| Raw, uncompressed transfer of a `.nc` | **Accepted.** 4 × 8192-byte packets, `0xB4` `ok`, `Info: upload success: /sd/gcodes/165-depth-ladder.nc.` — §9's QuickLZ question closes: §5's raw upload is what this machine wants. |
| Did the card really get the bytes? | **Yes, checked three ways.** Our `md5Hex`, PowerShell `Get-FileHash`, and the machine's own `md5sum /sd/gcodes/165-depth-ladder.nc` all return `6e9b97…92ba`. The `ok` alone was not taken as evidence. |
| A bare filename as the upload target | **Resolved against the card root and refused**: `Error: failed to open file [/165-depth-ladder.nc]!` The target must be absolute; `/sd/gcodes` is the directory Studio uses. |
| Re-offering a file the card already holds, byte for byte | **Transferred again in full — the machine does not MD5-shortcut an upload.** The "MD5 match → cancel" behaviour is the client's, not this firmware's. |
| A refusal, reported | **`Error: failed to open file [/sd/does-not-exist/165-depth-ladder.nc]!` now comes back as `refused` with that sentence verbatim.** See below — it did not, before tonight. |

**The defect this trip found, and why it mattered.** On the first attempt the bridge read a
pre-data `0xB5` as "the machine already has this file" and returned
`{"ok":true,"packets":0,"alreadyPresent":true}` for a transfer the machine had **refused** — its
`0xB5` carried `Error: failed to open file`, and an operator would have been told the program was
on the machine when it was not. This is the shape of failure the repo's own rule warns about: the
reported success was one level removed from the fact. The fix is that a cancel is *checked, never
assumed* — the bridge asks the machine to hash the path it just offered and claims `alreadyPresent`
only on a matching digest. Filed as **#291**.

`/sd/gcodes/165-depth-ladder.nc` is on the card and will stay there. **It is inert**: a file on the
card does nothing until Studio's Machining Wizard is driven by hand at the machine (D0).

**Still owed from the 2026-10-07 trip, and cheap to get next time:** the five probe repeats on wood
(C4), what the `Set Stock` step does with `Custom` selected (D0), and whether the assist modes
survive a power cycle (`/Z1-Firmware-Dialect.md` §11.4).

**Struck from that list, 2026-10-07:** "the machine screen's `CAM` header readout". **The Z1 has no
panel of its own** — confirmed at the bench. The expectation came from `Fabrication.md` §2, which
said the "machine UI reads material, stock, time estimate and thumbnail" from the header; that line
has been corrected in place. Nothing in Studio displays the three either, so #173's `CAM|id=`
fallback is a *behavioural* question — run a job with our id and see whether anything objects — and
D1 as written could never have answered it by inspection.

## PROVISIONAL (#208) inventory — what this session is meant to replace

| Marker (value) | File:line | Resolved by |
|---|---|---|
| `holder: null` | `machine.ts:463-465` | A2 |
| `VISE_BODY_DEPTH = 20` | `fixture.ts:36` | A3 |
| `GRIP_MIN = 3` | `fixture.ts:43` | A3 / A5 |
| `DEFAULT_UNCERTAINTY = 2`, `SAVED_UNCERTAINTY = 0.5` | `fixture.ts:55-58` | A3 |
| `DEFAULT_VISE` five numbers | `fixture.ts:101-105` | A3 |
| `vise-grip-shallow` message | `fixture.ts:290` | A5 |
| "vise dimensions … awaiting #208" | `engrave/defaults.ts:64` | A3 |
| `PROBE_SPEC = { tipDiameter: 3 }` (the Makera 3D Probe's tip) | `engrave/registration.ts:43,57` | A8 |

Other `PROVISIONAL` markers in the tree are **not** #208's: `#205` (EngravePreview.tsx:28),
`#197` (SimMeshes.tsx:21), `#213` / `#218` (`sacrificial.ts:22,66`; `engraveJob.ts:190`).
