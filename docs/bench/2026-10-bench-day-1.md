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

*One exception, 2026-10-06:* **B0** was recorded before the session, over the network, with the
machine idle and nothing sent but two identify queries and a status poll. It is marked **RUN** in
place; every other **Recorded** form is still blank, and A–E are as they were.

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

**Do.** `G53 G0 X-200 Y-200` then `G53 G0 Z-100`, slowly, hand on the stop. Did it get there? Then
jog each axis 0.5 mm at a time past it, toward the soft limit, and note what the controller does.

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

**Recorded:** _not yet run — the real limits._

| Field | X | Y | Z |
|---|---|---|---|
| Reached −200 / −200 / −100? (yes/no) | | | |
| Where the controller actually stopped (machine coords) | | | |
| What it did at the limit — message / clean refusal / stall / nothing | | | |

Notes:

**Goes to:** `/Simulation.md` §9 item 7 — closes the −200 vs −207 question, and answers whether the
refusal at −200 is conservative or merely round.

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
top face by 23 mm). It is **prepared for the trip at `docs/bench/208-D1-three-strokes-air.nc`**
(generated by `casemaker-app/scripts/bench-files.ts`; only the motion Z words are raised — the
header, including `ORIGIN z=3`, is untouched). Does Studio accept and preview it? Does the machine's
screen show our `CAM|id=CaseMaker` header's stock, tool and time?

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
