# Fabrication — driving a CNC as well as a 3D printer

Status as of 2026-10-05. The plan below is the design of record; the CNC side is now
**partly built**, and the code — not this document — is the record of what has landed. The
build-order ledger is `/Simulation.md` §10; the modules are `src/engine/cnc/` (`machine.ts`,
`tool.ts`, `toolLibrary.ts`, `feeds.ts`, `setup.ts`, `verify.ts`, `layerStack.ts`, `cam/`,
`post/z1.ts`, `gcode/`, `emulator/timeline.ts`) and `src/workers/geometry/` (`sweep.ts`,
`columnEngine.ts`). Sections below that describe something still unbuilt say so in place.

**Review scope.** Fable's adversarial review produced decisions 12–18 and covers this
document as it stood at commit `d4369d7`. The print-orientation flip (§7.2), the §7
rewrite and decisions 19–24 all postdate it and have **not** been reviewed.

**Companion documents.** `/Simulation.md` is the detailed design for toolpath simulation
(#182), including the measured performance budget. `/Makera-Parity.md` is the capability
inventory of Makera Studio and the gap list — read it before planning any CAM feature,
because it is where the evidence for Studio's actual parameter surface lives.

This is the plan for expanding Case Maker from "compile geometry, write an STL" to
"compile geometry, then make it on a chosen machine" — initially a **Makera Z1**
desktop CNC alongside the existing FDM path.

---

## 1. The machine

Figures below are from Makera's own SQLite library (`t_MachineType` in
`%APPDATA%/MakeraStudio/makera_library.db`), **not** from `ControllerConfig.txt`.
That file opens with `### Carvera settings` and much of it is Carvera template
values that do not describe the Z1 — the 6-slot tool rack is the clearest example.
`safety_limits.json` is likewise a ceiling, not a spec: its `max_spindle_rpm` of
24 000 is nearly double what the Z1 can actually turn.

**Provenance rule for this document:** anything sourced from a Carvera page, a
Carvera-era config file or Studio's shared UI is marked as such. Z1 behaviour is
only asserted where it is confirmed by `MakeraInc/MakeraZ1Firmware`, a `Z1/*` wiki
page, or the machine's own database row.

| | Makera Z1 | (Carvera, for contrast) |
|---|---|---|
| Work volume | **200 × 200 × 100 mm** | 320 × 240 × 140 |
| Automatic tool changer | **none** (`isATC=0`, `ATC_Number=0`) | 6 slots |
| Max spindle | **13 000 RPM** (150 W, closed loop, 0.01 mm runout) | 15 000 |
| Max feed rate | **1200 mm/min** | 3000 |

Firmware is a branch of **Smoothieware** (`MakeraInc/MakeraZ1Firmware`), so the
G-code semantics are LinuxCNC-flavoured and documented.

### Hardware we have
- Base machine, the **wired probe** and the **3D Probe Rod** that ship with it.
- **The Makera 3D Probe** — a separate accessory, and the one that matters. See the
  warning below: it is *not* the 3D Probe Rod.
- **4th axis rotary module.** Work envelope ⌀80 × 150 mm. Belt-driven: fine for
  hobby work, with real compromises in rigidity and precision. **Mounting and shipped
  config (`/Rotary.md` §1.2, §1.4):** mounts on the two 4 × 11 mm locating pins and three
  M5×10 screws **after removing the MDF wasteboard** — so rotary and tape-down are
  mutually exclusive setups, sharing the vise's pin datum; three-jaw chuck with **reverse
  jaws fitted by default**; tailstock with an adjustment knob. `configZ1.default` gives
  `88.889 steps/°` (32 000 steps/turn), `3600 °/min` (60 °/s, 10 rpm), `360 °/s²` and
  `home_to_min` with a real endstop — **read from the repository, not measured on the
  device** (the same `worksize_x 300` boilerplate caveat as `/Makera-Parity.md` §11.3).
- **Low-profile vise** (confirmed 2026-10-03). Listed on `Z1/Accessories`. It matters more
  than it looks — see §7.3, where it may remove a V1 deliverable.
- **An integrated camera** (confirmed 2026-10-03). Not in `Z1/QuickStart` at all, which is
  why this document previously recorded "the Z1 has no documented camera" as an open
  question against the `[Video]` WebSocket errors in Studio's logs. That was wrong. Studio
  carries `OpenCamera`, `VideoStreamManager`, `VideoOverlayWidget`, `ws_video` and a
  recording timer, the mobile Makera App shows the feed, and independent reviews confirm the
  hardware.
  **Its documented purpose is monitoring and time-lapse, not metrology** — see §7.3 for
  what that does and does not buy.

> ### ⚠ Three probes ship or are sold for this machine, and only one can touch off PLA
>
> They have nearly identical names, they all install the same way, and they all plug
> into the same connector. Picking the wrong one means **the printed-blank workflow
> does not work at all**.
>
> | | Probes | Materials |
> |---|---|---|
> | **Wired probe** (in the box) | Z only, plus surface levelling and area scanning | not stated by Makera — **measured 2026-10-08: a mechanical touch tip that triggers on PLA**, five touches on the printed blank with a 0.001 mm slow spread (`/Z1-Firmware-Dialect.md` §11.7, #293). |
> | **3D Probe Rod** (in the box) | X, Y and Z | **CONDUCTIVE ONLY.** "The workpiece must be electrically connected to the aluminum table via locating pins, screws, or other conductive methods" (`Z1/QuickStart`) |
> | **Makera 3D Probe** (separate accessory, **the user owns this one**) | X, Y and Z | "both conductive and non-conductive materials" (`Makera-Accessories/Makera-3D-Probe`) |
>
> So **decision 8 and §7.3 stand — but only because the user owns the separate 3D
> Probe.** The rod that came in the box cannot do it. #165 still verifies it on PLA
> rather than taking the page's word for it.
>
> **Revised 2026-10-08.** The bench settled it the other way: the **wired probe** touches
> PLA (it is a mechanical tip, not a conductive one) and repeats to 1 µm on the blank, so it
> is the touch-off probe in use and the 3D Probe is held in reserve. §7.3, decision 8.

### Workholding, as the machine does it natively
`Z1/QuickStart` documents an **anchor-based system** this document had not accounted
for: an L-bracket pinned to the bed with two 4 mm dowel pins and three M5×20 screws,
the workpiece registered against its inner face and clamped at the opposite corner, and
**"the system will automatically detect the lower-left corner as the machining origin"**.
The first-job walkthrough sets "Work Origin relative to Anchor 1, with X Offset = 0 and
Y Offset = 0".

That is a hardware XY datum, which is exactly what decision 23 assumed did not exist —
see §7.3 for why probing is still the plan, and what would change that.

**Bit collars** also matter more than they look: they set the shank protrusion
(~12 mm by default) so that stickout is repeatable across tool changes. That is one of
the three unquantified terms in §7.6's Z chain, and the machine ships with a jig for it.

**So `Tool.stickout` is the exposure the collar was set to, and it is an installation
property, not a catalogue one** (settled in #305, design point 1). Makera's catalogue carries
`cutterStickoutLength` and stores `''` for the 3.175 mm flat — unset, the same statement a
`.nc` header makes with `sticklength=0`, which therefore parses to `null` and never to `0`.
The consequence to keep in mind everywhere: re-collaring or re-measuring a cutter changes the
length a saved job was generated through, which is why a job snapshots the `Tool` it was
written with rather than resolving it fresh. It is **not** a sweep input, though (#314,
2026-10-08): the nut-to-tip distance depends on how deep the shank went into the collet *this*
time, which is why the machine probes the tip at every change, and the collet-nut clearance
check needs only the cutter's **shoulder length** — the nut face can be no closer to the tip
than that at any seating, so for a part proud of its jaws the nut is proven clear by the depth
gate alone. Bench task A2, which asked for calipers on the nut and stick-out, is superseded
(`docs/bench/2026-10-bench-day-1.md`).

**There is a Z1 Pro.** `Z1/QuickStart` is written throughout for "Makera Z1（Z1&Z1Pro）",
but `t_MachineType` has only one `Makera Z1` row. Whether the Pro differs in any figure
this document relies on is **unknown** — #184 should not hard-code a single Z1 identity
without noting it.

### Hardware we do NOT have
- **No laser module.** The optional unit is 5 W / 445 nm. Everything laser is out
  of scope: `M321`/`M322`/`M323`/`M324`/`M325`, and Studio's `LaserImagePath` /
  `LaserVectorPath` strategies.

### Confirmed by the docs
- The 3D Probe's page states it "enables automatic X / Y / Z probing on both
  conductive and non-conductive materials" — which is what makes the printed-blank
  workflow possible at all. Note it is filed under generic Makera accessories and is
  *not* listed on the `Z1/Accessories` page (which names only the 4th Axis module,
  Vacuum Bed, Low-Profile Vise and Ionizer); the user has confirmed owning it.
- Using it is itself a tool change: remove cutter → fit probe → unplug wired probe
  connector → plug 3D probe → probe → swap back → `M491`. §7.6 explains why that
  chain's repeatability needs measuring. **Superseded 2026-10-08:** the wired probe is the
  touch-off probe (§7.3), so nothing is unplugged or re-plugged; the chain is probe touch →
  hand swap to the cutter → `M491`, and two of its three terms are now measured (§7.6).
- The **wired** probe *is* documented after all: `Z1/QuickStart` says it "supports
  automatic Z-axis probing, surface leveling, and machining area scanning", and that with
  the anchor system "it enables easy XYZ positioning". What it does **not** state is
  whether it touches off non-conductive material — so for PLA the separate Makera 3D
  Probe remains the one to use.
- **Work volume is independently confirmed.** `CarveraProfiles`'s Z1 FreeCAD machine
  definition gives X 0–200, Y 0–200, Z 0–100, matching `t_MachineType`. It also gives the
  kinematic chain — Y is the **table**, X and Z are the **head** (Z parented to X), and
  the A axis is a table rotary parented to Y.

---

## 2. Codes that matter

The published table at <https://wiki.makera.com/en/supported-codes> is **written
for the Carvera** — it says "clearance position on the Carvera", tags some codes
Carvera- or Air-only, and describes ATC behaviour the Z1 does not have. Every row
below was therefore checked against `MakeraInc/MakeraZ1Firmware`, and where the
firmware disagrees with the wiki for a no-ATC machine, the firmware wins and the
row says so.

Retrieval note: the Z1 wiki pages are **absent from `sitemap.xml`**. Reach them via
the wiki.js GraphQL page list (`{pages{list(locale:"en"){id path title}}}`), then
fetch the rendered HTML with a browser User-Agent. `single(id:)` content requires
auth; the rendered page does not.

The ATC-dependent codes branch in firmware on
`THEKERNEL->factory_set->FuncSetting & (1<<2)`. The Z1 has that bit clear
(`isATC=0`), so it takes the `// Manual Tool Change` path — which the firmware
implements deliberately, not as a degraded fallback.

| Code | Why we care |
|---|---|
| `G10 L2 P1` / `G54` | Set and select the work origin after probing. |
| `G38.2` | Standard touch probe move. |
| `G32 R1 X Y A B I J H` | Probe a **grid** and leave compensation active (`R0` off, `R1` on). `M370` clears it, `M375.1` dumps the data. Implemented by stock Smoothieware `CartGridStrategy.cpp`, and the firmware emits this itself at `ATCHandler.cpp:1473` — so it is a real Z1 path, not Carvera-only. It uses whatever probe is wired to the zprobe input. |
| `G92` / `G92.1` / `G92.4` | Offsets; clear offsets; manually set homing. |
| `G20` / `G21`, `G90` / `G91` | Units and absolute/relative. `G21 G90` is our default. |
| `G28` | Go to clearance position. |
| `G53` | Next G0/G1 in machine coordinates. |
| `M6 T<n>` | Tool change. `T0` = the probe, `T-1` = none. The wiki calls T0 the *wireless* probe (Carvera); on the Z1 tool 0 is simply "the probe", and `M491` keys off `active_tool == 0`. |
| `M490.1` / `M490.2` | **Not** collet tighten/loosen on a Z1 — that is the ATC branch. The manual branch makes `.1` = `set_tool_waiting(true)` plus a beep, `.2` = `set_tool_waiting(false)`. An **operator handshake**: "stop and wait for the human to swap the tool" / "done, carry on". `M490` with no subcode is an ATC-motor self-check. |
| `M491` | Run calibration; **resets TLO for the current tool**. **Not ATC-gated** — works on the Z1. This is the tool length sensor, and it is what makes manual multi-tool jobs viable. |
| `M497.<n>` | Sets a UI state flag only (`set_atc_state`); no motion. Subcodes name the setup workflow: 4 = margin, 5 = Zprobe, 6 = Autolevel, 7 = Done. Useful for telling the UI where we are; it does not *do* any of it. |
| `M600` | Suspend and wait for resume (`Player.cpp`). Separate mechanism from the `M490.x` handshake. |
| `M3 S<rpm>` / `M5` | Spindle. |
| `M7` / `M9` | Airflow. `M331`/`M332` auto-vacuum mode. |
| `M811`/`M812`, `M821`/`M822`, `M851`/`M852` | Spindle fan, light, extended port PWM. |
| `M220 S<pct>` / `M223 S<pct>` | Feed and spindle overrides. |
| `M482.4` / `M482.5` | Retrieve MAC / IP. |

`M801`/`M802` (internal vacuum) are **Carvera-only** — do not emit for the Z1.
`M861`/`M862` (beep) are documented Carvera Air-only.

### The manual tool change, as the firmware implements it
No ATC means a multi-tool job is a scripted handshake rather than an impossibility:

```
M490.1          ; tool-waiting status + beep — machine stops and waits
                ; operator loosens collet by hand, swaps the cutter
M490.2          ; clear tool-waiting — operator has finished
M491            ; re-measure tool length, reset TLO for the new tool
```

This is the whole reason multi-tool jobs stay on the table. It also means a job with
*n* tools can be a single `.nc` file with *n*−1 of these breaks in it, rather than
*n* separate files the operator has to launch in the right order.

### Output file format
Studio's `.nc` carries a self-documenting header. We emit the same (see
`%APPDATA%/MakeraStudio/GCodes/TopClamp.nc` for a full example):

```
;@MKR|BEGIN
;@MKR|SCHEMA|v=1.0.0
;@MKR|MACHINE|id=Z1|name=Makera Z1
;@MKR|MATERIAL|id=...|name=...
;@MKR|STOCK|id=cuboid|length=|width=|height=|diameter=
;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=|y=|z=
;@MKR|CAM|id=CaseMaker|name=Case Maker|v=<ours>   ; Studio writes id=MakeraStudio here;
                                                 ; use our own unless the machine
                                                 ; turns out to require Studio's
;@MKR|UNIT|value=mm
;@MKR|TOOL|number=|id=|name=|type=|diameter=|...
;@CM|TOOL|key=<our registry key>   ; ours, not Studio's — see "Naming our own
                                   ; cutter" below; it follows the TOOL line it names
;@MKR|TIME|seconds=
;@MKR|TOOLPATH|number=|tool_number=|name=
;@MKR|END
G90 G21
...
G0 Z15 / M9 / M05 / G28 / M02
;(thumbnail_image_begin)  <base64 PNG>
```

Origin defaults to the stock's **top-front-left** corner: it matches Studio's
`ORIGIN type_name=topFrontLeft`, and it is a landmark you can see on the part.

**What reads that header is an open question, and earlier text here overstated it.** An
earlier revision said the "machine UI reads material, stock, time estimate and thumbnail"
from it. Bench session 2026-10-07 found **the Z1 has no panel of its own**, and nothing in
Studio was seen to display any of the three: `Processing progress` lists the filename and
progress only, and the wizard's `Run` summary (`docs/bench/2026-10-bench-day-1.md`, D0)
shows the setup state — origin, probe, assists — not stock, tool or time. It showed
`Remain 0m` for a file whose header says `TIME seconds=30`. So the header is *written* by
Studio and its fields are real, but no display surface for them has been found, and the
`CAM|id=` fallback question (#173) can only be settled by **running** a job with our id and
seeing whether anything objects — not by reading a screen.

### Naming our own cutter: the `;@CM|TOOL` line

Studio's `TOOL` record names a catalogue cutter by `id=` — the catalogue's `g_ID`
(`/Makera-Parity.md` §3.2). A **clone** (a cutter the user owns, materialised rather than
pointed at a base row, #212) must not inherit that id, so the post writes `id=` empty there.
A file posted with a clone therefore names no cutter any tier can identify, and matching falls
to shape + diameter — which **already ties for two 3.175 mm flats**.

So the post writes one extra line, immediately after the `;@MKR|TOOL` line it belongs to:

```
;@CM|TOOL|key=<toolKey>
```

- **`;@CM|` is our prefix, not Makera's.** To everything else it is a `;` comment: Studio
  ignores it, and our own lexer reads any `;`-start that is not `;@MKR|` as a comment
  (`gcode/lexer.ts:44`), so it becomes no header record and raises no diagnostic. It is
  deliberately *not* a `;@MKR|` tag: that namespace is the vendor's, a tag we invented in it
  could collide with one they add, and a vendor reading our file would be reading a record
  that is not theirs.
- **`key=` is the registry key**, namespaced as everywhere else (`flat-1.0`, `cat:…`,
  `user:…`, `inv:…`) — the same string `EngraveJob.toolKey` holds and
  `ToolLibraryEntrySchema.key` validates.
- **One key per line, `|`-terminated like the rest.** The reader takes everything after
  `key=` to the end of the line, so `=` inside a key is unambiguous and `|` is not: the
  writer **refuses a key containing `|`** rather than escaping it. Keys are ours to generate
  (`ToolLibraryEntrySchema.key` is only `min(1)`), so this is a guard, not a feature.
- **Read back in this order: this key → `id=` (`g_ID`) → shape + diameter.** `matchRegistryTool`
  gained the `id=` step in #305; the key step is #309's, and this line is why that step has to
  come FIRST — an `id=` that a clone could not carry cannot outrank a key we wrote ourselves.
- **The key only, on purpose.** The `;@MKR|TOOL` record beside it already carries the whole
  geometry, and `sticklength=` already carries the installed stick-out, so a second copy here
  would be a second thing to keep true. (The format is settled here because #309 depends on it;
  nothing writes the line yet.)

---

## 3. Data we read rather than reinvent

All of it lives in the user's Makera Studio install. **Read at runtime; do not
copy into this repo** (we ship LICENSE/NOTICE and care about provenance).

- **Feeds and speeds** — `t_MakeraCutterProperties`: 1328 rows over 129 tools in
  `t_MakeraCutterList`, keyed material × cutter, giving spindleSpeed, feedRate,
  plungeFeedRate, stepDown, stepOver, coolant.
- **Tool definitions** — `t_MakeraCutterList`: 129 cutters in 16 groups, 26 fields
  each. This is what the house tool registry imports as its **immutable catalogue
  tier** (decisions 29–30): read-only, replaced wholesale on a re-sync, and
  *cloned* to change. Never bundled, same as everything in this section.
- **Machine profiles** — `t_MachineType` (above).
- **Strategy vocabulary** — `%APPDATA%/MakeraStudio/configure/*.json` gives the
  full parameter shape of each Studio strategy: Contour2D/3D, Pocket2D/3D,
  Drill2D/3D, Chamfer2D/3D, Thread2D/3D, Relief3D, RotationRelief (and the two
  laser ones we're ignoring). Useful as a checked-against reference, not a spec
  to copy.

**Verbatim schema, 2026-10-08 (#307).** The real column names, the primary key (`cutterId`, a
v7-shaped UUID — *not* `cutterCategoryId`, which is the type), the join key
(`t_MakeraCutterProperties.cutterID → t_MakeraCutterList.cutterId`, 0 orphans), and one real row per
table are recorded in `docs/bench/2026-10-08-makera-library-schema.md`; the summary correction to
the prose above is in `/Makera-Parity.md` §3.2/§3.3 and §5. Two facts a reader of this section needs:
`cutterStickoutLength` uses `''` (empty string) for "unset", and **the scanned QR slug
(`C1-BIT-BALL-NOSE-1-4`) is not in the database** — the `g_ID ↔ sku` map (`t_SkuMapping`) is empty,
so Studio resolves it online (#212, #307).

### Known-buggy baseline
Makera Studio 0.1.2.0 ("Beta") has needed local patching to run on this machine;
`MakeraStudio.exe.orig` sits beside the patched binary in the install — **keep
both**. Relevant here only as a reason not to depend on it, and for one detail:
Studio's own stock preview is **dexel**-based, which is independent support for the
representation chosen in §5.

---

## 4. Decisions taken

Decisions 1–11 were taken in conversation with the user. Decisions 12–18 came out
of Fable's adversarial design review and are corrections to this document's
earlier assumptions, each verified against the code or the geometry before being
accepted.

| # | Decision | Notes |
|---|---|---|
| 1 | **True 3D surfacing** eventually, not 2.5D only | Not in V1 — see §10. |
| 2 | **In-house heightmap/dexel engine** when 3D arrives | §5.5 states what it cannot do. |
| 3 | **Design for the 4th axis** | We own the module (⌀80 × 150 mm). Superseded for V1 by decision 18. **Design in `/Rotary.md` (decisions R1–R12).** |
| 4 | **No laser, ever (on this machine)** | Removes `M321`–`M325` and two strategy families. |
| 5 | **Images get two user-selectable methods** | Vector trace and greyscale relief. Not in V1 — V1 is text. **Resequenced 2026-10-05:** trace first, with #217; relief with the dexel engine (#222). `/Makera-Parity.md` §14.5. |
| 6 | **Mesh import only to start (STL/3MF/OBJ)** | Behind a pluggable registry. Not needed for V1. **CNC scope added 2026-10-05:** CNC import is **profiles first** — SVG, then DXF (#217); mesh for the CNC side arrives with the dexel engine (#222). The case-side mesh importer is unchanged. `/Makera-Parity.md` §14.5. |
| 7 | **Stock setup = corner find + Z touch-off, `G32` autolevel, model cross-check** | **Superseded in all three parts** — by decision 23 (edge-find on flats, not a corner), decision 12 (`G32` out) and decision 24 (no thickness cross-check). |
| 8 | **We have both the wired probe and the Makera 3D Probe** | Non-conductive probing is available, so PLA can be probed. **Revised 2026-10-08:** the *wired* probe does it — a mechanical touch tip, measured on the blank, 0.001 mm — so it is the one in use; the 3D Probe stays in reserve (§7.3, #293). |
| 9 | **First real job is a 3D-printed blank (PLA/PETG)** | The badge. **Reworded 2026-10-05:** the first *badge* job; CNC-2's first chips are wood in the vise (#209) and the badge is CNC-3. `/Makera-Parity.md` §14.5. |
| 10 | **Transport is WiFi** | Still the chosen transport. **Not in V1** — see §10.1. |
| 11 | **4th axis: designed for, not built** | See decision 18. **Design in `/Rotary.md` (decisions R1–R12).** |
| 12 | **The depth window is bed-referenced; `G32` is not an input.** | See §7. **The clause "measured stock thickness is the required input" is superseded by decision 24** — after the flip, total thickness is not a job input at all. "Bed-referenced" survives and is strengthened: the printer's bed face *is* the engraved face. **2026-10-07 (#191 item 10):** the objection to `G32` is that a *point* Z touch already sets the depth window, and that stands for the vise. It does not cover a **taped** blank, whose residual is a *tilt* one touch cannot see (§7.3) — and a tilt is a height field, which is what `G32` samples. So `G32` stays out of the depth window and is **re-openable for taped setups only**, on the four-corner spread `docs/bench/191-tape-tilt-run-sheet.md` measures. §9.1. |
| 13 | **The blank must be printed 100 % infill, and its spec is part of the depth model** | See §7. |
| 14 | **V1 cuts with a flat end mill, not a V-bit** | A V-bit couples depth to stroke width, so per-label depth stops meaning what the UI says. V-carve is V2. |
| 15 | **Engravability is computed and rendered, not assumed** | Tool radius removes glyph detail; the viewport shows the *opened* region and the predicted colour. |
| 16 | **Glyph profiles use `NonZero` fill, as an opt-in field** | Not a change to the global `EvenOdd` default. |
| 17 | **No `Project.kind` union for V1** — `case.badge` as an optional field plus a `derivedKind()` helper | The old §5.1 premise was false. See §5.1. |
| 18 | **V1 is a vertical slice, and several agreed decisions are explicitly deferred out of it** | Deferring is sequencing, not reversal. See §10.1. |
| 19 | **V1 workholding is the low-profile vise; the printed nest is not a deliverable** | **Decided 2026-10-05**, closing the open question of 2026-10-03: the nest's claimed advantage (backing the blank flat) is false for this part — the magnet recess is an air gap against any flat surface. Every enclosed desktop mill in the sample ships a mechanical fixture with a probing routine named after it (Bantam's L-Bracket Location, Carbide's vise + BitZero Corner, Shaper's Workstation) and none documents a printed per-part nest; CNC-2 is already vise-first. #175 reopens only if #176 shows the vise cannot hold the 3.81 mm badge. §7.3, `/Makera-Parity.md` §14.5. |
| 20 | **Per-label depth is a two-state choice with a numeric override** | Two outcomes exist (top colour, bottom colour), so that is what the control should offer. Same reasoning as the X-ray toggle. **Caveat, 2026-10-06 (#187 item 4):** the two outcomes are a property of a **flat-bottomed** cutter — the floor of the cut *is* a depth, so it lands above the colour boundary (top colour) or below it (bottom colour). A V-bit couples depth to stroke width, so this reading is flat-end-only (decision 14) and does not survive V-carve (#221); when that lands, the user's expressed intent is *colour: top / bottom* and the strategy owns the depth. |
| 21 | **The app loads the object; depth limits come from the solid** | No hand-coded pocket rectangles. A void in the geometry produces a shallower limit automatically, for this part and any future one. §7.1. |
| 22 | **The app models the printer's layer grid** | Layer height **and first-layer height** are inputs. The colour boundary and the depth limits sit on real layer lines, not ideal dimensions — because 0.810 mm is layer 4.05 and the difference matters, and after the flip the first layer *is* the engraved face. §7.1. |
| 23 | **Registration: probe everything** | Edge-find X/Y on two *straight* edges (the corners are R3.175 and make poor datums), then probe Z on the engraved face. The nest holds the part but is not a position reference. §7.3. |
| 24 | **Thickness error is ignored, by design** | The blank prints engraved-face-down, so error lands on the back face. Cut depths come from the probed face plus model distances. Total thickness is **not** a job input. §7.2. |
| 25 | **Build the `MachineProfile` now, even though the Z1 is the only machine** | Maintainer's call, 2026-10-03, overriding §5.3's deferral: pay for the seam once rather than recode later. Scope stays Z1-only; the profile is where machine limits get clamped and where "no laser on this machine" becomes a flag instead of an assumption. §5.3, #184. |
| 26 | **Workholding is an explicit input, and the probe plan is derived from it** | Supersedes decision 23's fixed edge-find sequence. The part may be in a nest, under clamps, in the vise or in the rotary chuck; each answers reachable / obstructed / datum candidates / residual uncertainty, and the planner queries the compiled solid for touch points. §7.3, #188. |
| 27 | **The blank spec makes the colour boundary slicer-independent** | Slicers sample each layer at its **mid-plane**, and the rule differs per slicer. So place the split and the pocket ceiling **exactly on layer lines**, where no mid-plane sampler is ambiguous. **Revised 2026-10-03:** the margin was pointed the wrong way — under mid-plane sampling at 0.2 mm the void starts at **1.6**, not 1.4, so the printed membrane is a layer *thicker* than nominal and a 1.4 ceiling gave away 0.2 mm of a ~0.6 mm band for nothing. Also "layer multiple" means **h₁ + k·h**, so the spec must *prescribe* first-layer height as well — Cura's 0.27 default puts 0.80 inside a layer again. Same mechanism as decision 22. #166, #178, #191. |
| 28 | **Fixture geometry is measured — with defaults and saved measurements as the starting point** | Maintainer's rule, 2026-10-03: do not hard-code vise or clamp dimensions *as the truth*. What is in the tool's way is whatever the user put there — discard material between the jaws, spacers, a different clamp — so the obstacle envelope is an **input with provenance**: a shipped **default** for known hardware, a **saved** measurement from a previous probe, or a **fresh probe** (later the camera). "It may not have to be done every job, and defaults are useful": a default or saved envelope is used until the setup changes, and `source` + `uncertainty` say which it is, so the emulator never mistakes a default for a measurement. The `Workholding` variants say *how* the part is held; the obstacle envelope is a separate input. §7.3, #188, #182. |
| 29 | **The house owns tools, not the machine** | Maintainer's call, 2026-10-08: cutters outlive the machine they were bought for and are shared across machines, so an inventory scoped to a machine is scoped to the wrong thing. `t_MakeraCutterList` is one *source* of tool definitions, never the owner. This is decision 25's argument (pay for the seam once) applied to the other axis: the seam is between *house* and *machine*, and it is paid for before there is a second machine. #212, #311. |
| 30 | **Catalogue rows are immutable; divergence is a clone** | Maintainer's rule, 2026-10-08: *"the core database tools cannot be changed, you can only clone to make speed changes."* So the imported catalogue is a read-only tier replaced wholesale on a re-sync, and everything the user owns is a **clone** — a `user_tool` holding the **fully materialised `Tool`** plus `base: {cutterId, g_ID, syncedAt}` and a **display-only** `overrides` diff of the fields that differ. Materialising rather than storing only the diff is the load-bearing half (the diff is never the source of a value): the clone keeps working when Makera discontinues the cutter or a re-sync drops its base row, and the diff is still there to render *"speed 9000 → 6000 (cloned)"*. Same discipline as decision 28 and `myMachineFile.ts` — values **and** their provenance, so a round trip cannot turn a measurement into a default. Physical possession is a *third*, separate record (`quantity`, scanned codes, `addedAt`) that points at a definition; a scan of a code that already exists offers `quantity + 1` and never a second row. #212, #305, #308, #309. |
| 31 | **The house service — the bridge — is the source of truth for house state** | Maintainer's call, 2026-10-08: *"a bridge is required for any printing, so the bridge should keep the database; it should sync to any web instance."* The desktop UI and a browser on the LAN read and write the same stores over `/api/v1`, so per-browser `localStorage` owns nothing house-scoped. The hosted HTTPS app at electricrv.ca **cannot** reach a plain-HTTP service (mixed content is hard-blocked), so "sync to any web instance" means the clients the service itself serves, and the hosted app stays on the built-ins (#212). **With no bridge reachable the Tools scope is absent and the pickers fall back to `TOOL_LIBRARY`** — no offline cache and no reconcile, so the degradation is visible instead of silently divergent. Reaching a bridge is a **runtime fact, not a build target**: a browser on the LAN is the *web* build and still talks to a bridge, so `canRunLocalServer`/`canReadLocalFiles` gate *hosting and syncing*, never *reaching*; `machineProbe.ts` is the model (one configured URL, one probe, four honest answers, unreachable is a normal outcome). Tiered versioned JSON on disk, not SQLite — the schemas stay in Zod, nothing needs a query, and the API is the contract if that ever changes. §5.7, #306, #312. **Naming (#306):** in code, comments and the rest of this document this is the **house service**; "the bridge" in the quote above is the maintainer's word, and it already means the machine bridge (§5.7, #255), so `houseClient`/`house.rs`/`ToolRegistryStore` and `loadMachineBridge`/`machineProbe`/`machine.rs` never collide in a grep. |
| 32 | **Feeds from `makera_library.db` are a catalogue tier *below* measurement** | Maintainer's call, 2026-10-08, correcting §9.1's 2026-10-05 line. The three objections in `/Makera-Parity.md` §5.1 — no PLA or PETG, no machine column, 32 rows above the Z1's ceiling — are reasons the table cannot be a **source**, not reasons it is useless. Adopted as a tier under the precedence `measured → job override → user feed → catalogue → unmeasured`, clamped through `clampToMachine`, each row carrying a `FieldSource` so a vendor number never reads as a measurement (decision 28's discipline, applied to feeds). It is genuinely useful for **wood** — CNC-2's material, #209 — and **can never serve the badge job at all**, because PLA has no row. A speed change is a `user_feed` row, not a clone. §9.1, #310. |
| 33 | **The house service is not authenticated on a LAN, and that is a decision rather than an omission** | Maintainer's call, 2026-10-09 (#321): a house is served on the home LAN with **no token, no login and no account** — the app's own origin is the only address that answers (decision 31), the window it serves is the same one it was launched for, and a shared house on a home network has the LAN as its trust boundary. Saying so out loud is the point: an implicit "nobody thought about it" and a deliberate "the LAN *is* the boundary" look identical in the code and completely different when a second person or a second machine appears. What sharing therefore gates on is **not** identity but **concurrency**: one process serves the house (a directory lock), and every write that changes a document carries the version it was based on (`If-Match`), so two people or two windows cannot silently overwrite each other. Both are refusals the user can see; neither is a permission. Exposing the house beyond a trusted LAN — a port-forward, a shared office network — is out of scope and would need real authentication first. §5.7, #306, #321. |

---

## 5. Architecture

**Reuse, don't restart.** Keep the BuildOp/Profile IR, `evaluateOp` (Manifold), the
importers, the exporters, and the Tauri shell — which already carries `tokio` with
`net` and `axum`.

### 5.1 Correction: the flag model already expresses a no-PCB part

This document previously claimed that `Project` requires a board, that a part with
no PCB could not be a fourth archetype flag, and that this is why
`samples/badge-blank/make_badge.py` shipped as standalone Python. **That premise is
false**, and the code says so:

- `buildRackNodes(caseParams.rack)` never reads `board`
  (`engine/compiler/ProjectCompiler.ts:62-68`).
- `emptyBoard()` exists precisely to satisfy the required field with a placeholder
  (`library/templates/buildFromSpec.ts:13-25`).
- `protectiveCase()` already ships a no-PCB project through it
  (`library/templates/index.ts:69-80`).

So the badge went to Python for some other reason — most likely it was quicker for a
one-off — not because the model forbade it. The `kind` refactor is therefore **not on
the badge's critical path**, and putting it there would have been self-inflicted risk.

What V1 does instead, following the **v7 `hinge` precedent** (`store/projectSchema.ts:444-456`,
a purely additive `.optional()` field with a bookkeeping version bump):

- `case.badge?: BadgeParams`, optional on the type and the Zod schema. Templates get
  it free through `templateSchema.casePatch`, which is `caseParamsSchema.partial()`.
- A `derivedKind(project): 'rack' | 'stand' | 'badge' | 'shell'` helper that
  centralises the precedence **once**. The nine existing flag sites then read
  `derivedKind(p) === 'rack'` instead of `p.case.rack?.enabled`.
- Early returns in `compileProject`, `validatePlacements`, `hardwareList`, and the
  board placeholder hidden in badge mode exactly as rack mode does it.

The `kind` discriminant is still the right end state; it buys exhaustiveness
checking. It gets done when a third no-PCB part type arrives, at which point the
flags are already the derivation and the change is mechanical.

### 5.2 Correction: the seam is `PartPlan`, not a general `FeaturePlan`

The earlier proposal — every archetype's `compileProject` emits a general
"`FeaturePlan` of named regions with depth intent" alongside `BuildPlan` — is the
right instinct at the wrong altitude. It retrofits fourteen feature compilers
(`ProjectCompiler.ts:90-137`) to serve one consumer that only needs the badge, and
invents semantics nobody has asked for.

**What is true and worth keeping:** CAM must consume profiles and a target Z, never
a mesh. The compiler knows the region and the depth; a mesh discards both and forces
CAM to re-infer them.

**What V1 builds instead** — the seam sits *above* `BuildPlan`, for the part family
only:

```ts
interface PartPlan {
  stock: {
    outline: Profile;
    thickness: Mm;
    split: Mm;                                      // colour change height
    keepOuts: { footprint: Profile; zCeiling: Mm }[];  // the magnet pocket
  };
  engraves: { id: string; profile: Profile; depth: Mm }[];  // one per label
}
```

with two pure derivations: `toBuildPlan(part)` for the viewport, STL and 3MF, and
`toCamJob(part, tool)` for the `.nc`. **It takes no `measuredThickness`** — this document
said it did, and decision 24 says total thickness is not a job input. The signature was a
leftover from the superseded depth model. That is literally "a set of
2D profiles each with a target Z", which is what V1 is. Generalise when a second
consumer exists.

Two mechanics this document previously glossed over:

1. **`Profile` is a tree, evaluated only in the worker.** CAM needs flat polygons to
   offset. `CrossSection.toPolygons()` exists (`manifold-3d/manifold.d.ts:322`), so
   the CAM core runs in the geometry worker beside `executeProfile`, and the
   pocketing offsets are `CrossSection.offset` — the same Clipper2 already in use.
2. **Make the CAM core pure**: `(polygons, params) → ToolpathIR`, so it runs under
   vitest in node through the same wasm harness `scripts/export-sample.ts` already
   loads. The post (IR → `.nc` text) is then trivially snapshot-testable.

### 5.3 One machine profile — **in V1** (decision 25)

Machine knowledge is scattered across `PRINTER_PRESETS` (`engine/compiler/rackFit.ts:37-44`)
and a hardcoded `ASSUMED_NOZZLE` (`engine/compiler/fasteners.ts:303`). Unifying them behind
a `process: 'fdm' | 'mill'` discriminant is correct.

**This document previously deferred it** — "a single `Z1` constant in one file is enough
until a second CNC exists". The maintainer has overridden that: build the profile now, so
that supporting a second machine later is configuration rather than a refactor. **#184.**

Scope: **the Z1 is still the only machine we support.** The profile is the seam, not a
portability project. It carries what the rest of the plan already needs to ask:

- work volume, and whether a rotary module is fitted (⌀80 × 150 on the Z1);
- **spindle and feed ceilings** — 13 000 RPM and 1 200 mm/min. These are not optional:
  Makera's own tool table has no machine column and **32 rows exceed the Z1's spindle
  ceiling** (`/Makera-Parity.md` §5.1), so every feed and speed must be clamped against
  the profile before it reaches a toolpath;
- `hasATC` / tool-slot count — `isATC=0` on the Z1, which is what makes the
  `M490.1`/`M490.2` manual handshake the tool-change path (§2);
- **capability flags for hardware we do not have**, laser and vacuum among them, so that
  "this machine cannot do that" is a profile answer rather than an absence. Decision 4
  stays in force as a *scope* decision — no laser strategies are being written — but it
  stops being an assumption baked into the code.

Carvera and Carvera Air are already rows in Makera's own `t_MachineType` alongside the Z1,
so the profile's shape is known and does not have to be guessed.

### 5.4 Importer registry — deferred

One registry normalising to **mesh** or **profile set** is the right shape for
SVG/DXF/STEP later. V1 is text, so the existing `engine/import/assetImporter.ts` is
fine untouched.

### 5.5 How the heightmap engine reaches the 4th axis

Recorded for when 3D surfacing happens; nothing in V1 depends on it. A heightmap
generalises to rotary work by **changing coordinate system, not algorithm**: sample
**radius over an (A, X) grid** instead of Z over (X, Y). Drop-cutter becomes
drop-radius; the stock simulator becomes a cylinder. Studio's
`RotationReliefPath.json` is its 3-axis relief strategy plus a `reliefdirection` and
a `haveTailTop` flag, consistent with a reparameterisation rather than a different
engine.

What this approach cannot do in either coordinate system: undercuts, and a tool that
leaves the plane through the axis. **Correction (`/Rotary.md` §1.1, measured against
Makera's own files):** A interpolates freely with X and Z — `Rotation/Nefertiti*.nc` are
helices, A and X turning together in 3 885 of 4 547 cutting moves and A and Z in 89 198.
The constraint that makes a radius-over-(A, X) model legitimate is not "A does not
interpolate" but that **the tool axis always intersects the rotary axis** (Y ≡ 0, no
tilt). What the heightmap cannot do is a tool that leaves the plane through the axis
(Y ≠ 0, tilt) or a cut that crosses the axis (Z ≤ 0); both stay refused. The firmware
scales rotary feed from the work-frame radius — `r = √(Y_wcs² + Z_wcs²)`, the target's
distance from the work origin — so the rotary work origin must lie **on** the axis
(`/Rotary.md` §1.2, R6).

### 5.6 Simulation is the pre-hardware oracle

**Sweep the selected tool along the computed toolpath, subtract it from the stock, show
before and after.** #182. This is in V1, and it is the single highest-value thing that
can be built before the machine is touched: it needs no bridge, no probe and **no
numbers from #165** — depth is an input, not a measurement.

**Full design: `/Simulation.md`.** The summary, and two corrections to what this section
said before it was measured:

**V1's sweep is exact for a flat end mill at constant Z**, with no dexel grid and no
sampling. The general rule — for any *convex* tool, `K ⊕ [a,b] = hull(K+a, K+b)`, and every
Makera tool category except the thread mill is a convex solid of revolution
(`/Makera-Parity.md` §3) — is correct mathematics but **not an affordable algorithm**: 1 600
hull-moves take 40–119 s against Manifold. So it is recorded as the eventual shape and sits
with the dexel decision, not in V1. Non-constant-Z moves, which Studio's own 2.5D pockets
emit because they ramp in, use the conservative lowest-Z capsule and over-remove.

**Performance: see `/Simulation.md` §4, and note the retraction there.** This section
previously claimed "Clipper2 unions thousands of short glyph segments cheaply; Manifold
booleans do not", then replaced it with the opposite — that a single Clipper2 union is
quadratic. **Both statements were wrong**, the second because the probe behind it had a
clockwise capsule rectangle that cancelled its own end discs under `Positive` fill, and a
synthetic load confined to a 1.4 mm box. On a glyph-offset load the union tree is about
**4×** the single call's speed — and the "realistic raster" that produced a 1.5× figure was
itself defective, retracing 768 segments up to 15.6× (`/Simulation.md` §4.1). The settled position is that `simplify()` before
extruding pays, the tree is modestly faster, and neither library is the villain — the full
re-measurement lives in `/Simulation.md` §4.

**The rule that would have caught it:** assert a closed-form area or volume for one
primitive before measuring anything built from it. §5 of the geometry notes already said
this for two earlier Manifold traps.

**Correction, on scope.** Exact CSG is right for V1 but does not generalise to dense 3D:
Studio's own `TopClamp.nc` spreads 9 618 cutting moves over **482 distinct Z levels**, and
exact CSG needs an extrude and a boolean per level. That is the measured case for
decision 2's dexel engine, so `/Simulation.md` §5 puts both behind one `Sweeper`
interface from the start, and V1 implements only the exact one.

The reason it is an oracle and not a picture: §7.5 predicts the engravable region
*analytically*, as the morphological opening of the glyph. The simulator computes the
same region *from the toolpath*. **Disagreement means the toolpath is wrong**, and that
is a machine-free unit test — as is intersecting the simulated removal with the magnet
pocket void and asserting it empty. Volumes and bounding boxes snapshot cleanly, so none
of it needs an eye or a screenshot.

**It simulates the `.nc`, not the toolpath IR**, so a sign flip or an origin error in the
post-processor cannot pass through it, and so it can be validated against Studio's own
output before any of our CAM exists. That drops its dependency from #172 to #174's
parser. `/Simulation.md` §1.

### 5.7 Machine bridge — deferred out of V1

**Tauri-only** when it happens; the web deploy can write `.nc` but cannot open
sockets. Transport is **WiFi** (decision 10), with a transport interface behind the
protocol layer so USB can follow. `M482.5` returns the machine's IP and `M482.4` its
MAC, which is how we confirm we are talking to the right machine.

It must be developed and tested **from Windows** — WSL2's NAT will almost certainly
break UDP discovery, and the Tauri build has to run on Windows anyway (`CLAUDE.md`).

**Why it is not in V1:** Makera Studio already uploads over WiFi. Putting a
Windows-only development loop on the critical path buys nothing a working `.nc` file
does not already deliver. See §9.1 — this is the one place V1 narrows the original
brief, and it is deliberate.

**Correction: there is no protocol to reverse-engineer.** This section used to justify
the deferral partly as avoiding "a protocol reverse-engineer". Makera publish their own
controller client — **`MakeraInc/CarveraController`** — and its `src/` contains
`WIFIStream.py`, `USBStream.py`, `XMODEM.py`, `CNC.py` and `Controller.py`. The
transport, the discovery and the file-transfer mechanism are all readable. The
`Z1/QuickStart` manual also documents the connection surface: USB, the machine's own
AP-mode hotspot (SSID prefix `Makera Z1`), or a shared local network, with the WiFi
credentials pushed over **Bluetooth** from Studio or the mobile Makera App. So the
bridge is a smaller job than this document assumed — it is deferred on *sequencing*
now, not on risk.

> **⚠ Licence constraint, and it binds before anyone opens those files.**
> `CarveraController` is **GPL-3.0**. Case Maker is **Apache-2.0**. GPL-3.0 code cannot
> be copied or adapted into this repo. `CarveraProfiles` is worse: it carries **no
> licence at all**, which means all rights reserved.
>
> Protocol *facts* — port numbers, framing, command sequences — are interoperability
> information and fine to learn and reimplement. **Code, comments and files are not.**
> Write the bridge from a written-down description of the protocol, not with the Python
> open beside it.

**The platform seam it needs is #181.** The split follows what a browser physically
cannot do — raw sockets (this bridge), local filesystem reads (Makera's feeds/speeds
database, the filesystem board library in #131), and the embedded server controls.
Everything else stays on web, including geometry, CAM, the post-processor, the
verifier, `.nc` export, and fonts. Fonts were considered for removal from the web
build and **rejected**: opentype.js needs no platform capability, glyph outlines serve
case labels which are a core web feature, and the 1.1 MB payload is a loading problem
whose fix is #180. Build the seam before the bridge, so bridge work does not scatter
platform checks through the UI.

**Added 2026-10-08 (#212, decision 31): the embedded server now has a second job, and it
is not deferred with the bridge.** The server was in this document already — it is what
`SettingsMenu` drives under "embedded server controls" — and it is the natural owner of
house state, because it is the only component present for *every* client: the desktop
webview, a browser pointed at the LAN, and the hosted app. So the local filesystem read
this section names as `canReadLocalFiles`'s justification gets its first real consumer —
reading Makera Studio's SQLite to import the tool catalogue (decision 30) — and
`canReadLocalFiles` stops being declared-but-unused. Note the ordering: **the server and
its store are not the bridge.** They share a process and nothing else, so the house
service is buildable and testable long before the socket protocol is, and nothing in
decisions 29–32 waits on the deferral above. #306, #308.

**Implemented 2026-10-08 (#306).** The server now serves the house service on `/api/v1`:
`GET /health` (a document version, whether a catalogue is present, and one sentence per file it
could not read), `GET /tools` (a `ToolLibraryEntry[]` — the ONE shape the workers need), `POST` /
`PATCH` / `DELETE` on `/tools` and `/inventory`, and `GET /export` / `POST /import` for the "my
machine" file (#247). `src-tauri/src/house.rs` holds the two documents — `house.json` (the user's
own tools and inventory) and `catalogue.json` (Makera's rows, read now and written only by a sync,
#308) — under `dirs::data_dir()/casemaker/`, each written atomically (temp file, flush, rename)
under a `tokio::sync::RwLock`, each GET carrying an `ETag` derived from the bytes actually served so
a 304 cannot mean anything but "byte-identical". The client is `platform/houseClient.ts` — a
same-origin `fetch`, deliberately **not** behind `canRunLocalServer`, because a LAN browser is the
web build and still reaches the service — plus `store/toolRegistryStore.ts`, which pushes the tiers
above the built-ins into stage 0's snapshot with `setRegistry`. The client implements the **read**
path only: the write endpoints exist and are tested, but their users (scan, clone, sync) are
#309/#311's, and a write path with no UI in front of it is untestable in the way that matters.

**Three traps, kept because each one cost time.** (1) **The SPA fallback answers `200` with
`index.html`**, so an unmounted API path would look like a healthy service: `/api/v1` is merged
*before* `/*path`, anything else under it is a JSON `404`, `server.rs`'s tests pin both against the
real router, and the client only believes a JSON body that passes the same Zod schema the built-in
list is written to. (2) **A key this service stores must be namespaced** (`cat:`/`user:` — never
`flat-1.0`, which is the client's permanent built-in tier) **and must not contain `|`**, the one
character `;@CM|TOOL|key=` cannot carry (§2, #305). Both are refused at the door rather than
sanitised, so a bad key is a visible 4xx and not a silent rename. (3) **A document that does not
parse is preserved, never overwritten.** Its reason travels in `/health` and every write is refused
until it is dealt with by hand: the alternative — start empty, then save over it — destroys the
user's own tool list to recover from a truncated write, which is not a recovery.

**Verified in a browser, 2026-10-08 (#306)** — `qa-306-house.mjs`, four scenarios, all green. The
web build and the desktop build each run against their own dev server with nothing stubbed: both
ask, both are told `absent` by an origin that is not the service, and both keep the built-ins in the
registry *and* in the Simulate panel's tool picker. Against a stubbed service answering health and
one `user:` cutter, the app reports `present`, the registry becomes the built-ins plus that tier, and
the cutter is selectable in the picker (photographed, not inferred). Against a static host answering
`404 text/html`, `absent` again, with the reason naming what actually answered. **The two builds
answering identically is the evidence for decision 31's rule** — reaching is a runtime fact, not a
build target — and it is why no `canRunLocalServer` guard stands in front of the probe even though a
probe at a host with no service is a request that cannot succeed. The assertions read a new
`__caseMaker.getToolRegistry()` hook (status, the reason sentence, the validator, and both key
lists), so none of them is inferred from pixels.

**The observed cost of that rule, reported rather than papered over.** When nothing answers the
health request, the browser logs its own `404` line for it: present in the first run, absent from
later ones, so the QA script allows that one pattern by text and fails on anything else. Gating the
probe on the build target would remove the line and the wasted request — a three-line change — but it
would also break the LAN browser the rule exists for, so it stands.

**Implemented 2026-10-08 (#308): the catalogue tier, imported from Makera Studio's own database.**
`src-tauri/src/catalogue.rs` is the reader and `POST /api/v1/catalogue/sync` is the only way in — no
body, no arguments, and the vendor path is a `HouseStore` *constructor* argument
(`HouseStore::open_with(dir, studio_db)`) rather than a request parameter, so the endpoint is not an
arbitrary-file-read primitive and a test can point it at a fixture. It writes `catalogue.json` —
`{kind, schemaVersion, syncedAt, tools: CatalogueEntry[]}` — next to `house.json`, and answers with a
report: `total`, `added`/`removed`/`changed` (the `cat:` keys), `unchanged`, and a `notes` array.
`GET /api/v1/tools` then serves the catalogue tier ahead of the user's own, both in the one
`ToolLibraryEntry` shape every picker already reads, so stage 0 needed no change to hold it.

**Read only, and read from a copy.** Studio's file belongs to a running application, so the reader
takes a scratch copy in the temp directory and opens *that* `SQLITE_OPEN_READ_ONLY`, never taking a
lock on the original, never creating a `-wal` or `-journal` beside it, and removing the copy
afterwards. "We do not touch their file" is therefore structural rather than a promise — the only
syscall pointed at their path is `fs::copy`'s read — and the real-install test asserts the original's
FNV-1a digest is unchanged, because that is a claim about bytes. **This is not a `canReadLocalFiles`
path.** That flag decides whether a build may *offer* the "read Studio's install" affordance; reading
the file is a runtime fact about where the service is running, exactly as reaching the service is
(decision 31), so the desktop app and a LAN browser served by it get the same catalogue and the web
build gets none because there is no service to ask (#306's client implements the read path only;
the sync's UI is #311's).

**Four traps, each of which cost real time.** (1) **`''` is not `NULL` and not zero.** Every geometry
column is nullable in practice and Studio writes `''` into REAL columns to mean "unset"; SQLite keeps
`''` as TEXT, so a plain `get::<Option<f64>>` FAILS on exactly the rows that matter — every ball
nose, every engraver, every thread mill. Reading through `rusqlite`'s `ValueRef` and treating an
empty or unparseable string as "not stated" is what makes those rows importable at all, and it is
why the served value is `null` rather than a zero nobody stated. (2) **A ball nose states its ball in
two different places.** Category 0 puts the ball diameter in `cutterMaxDiameter` and its radius in
`cutterCornerRadius`; category 7 puts only the radius there and its `cutterMaxDiameter` is the 6 mm
SHANK — so the tip diameter is read from the column when stated and otherwise derived as 2 × the
corner radius, for **categories 0 and 7 only**. A bull nose (4) is deliberately excluded: there the
corner radius is a corner, not a ball. (3) **The category name is nowhere in the database.**
`t_CutterCategory` is EMPTY in the real install, so the id→name→shape table is `/Makera-Parity.md`
§3's — and because a `cat:` cutter's `type=` text is written into a job's `.nc` header and re-read
through the client's `shapeFromType`, a spec (`tests/unit/catalogueTypeNames.spec.ts`) pins those
eight names against the eight shapes, since the Rust table and the TS function cannot import each
other and a disagreement would import a cutter and then refuse it for a reason that has nothing to do
with the cutter. (4) **A key is `cat:<cutterId>` and never a `g_ID`.** The UUID is what a re-sync
diffs on; the `g_ID` is not inherited by a clone (#309's `Origin.id`).

**What a re-sync diffs on, and the one document that may be replaced.** `contentHash` covers every
column a served row reads — the honest definition, since a column that reaches the entry must report
its change — with `lastUpdateDate` deliberately excluded: it is a vendor workflow stamp, not
geometry, so it is kept as a hint in `CatalogueExtras` and a re-sync that sees only a newer stamp
reports the row unchanged. The extras (`drillDiameter`, `pitch`, `threadAngle`,
`threadSpecification`, `metalDuty`, `sellProduct`, the group it was filed under) ride *beside* the
tool and never on the wire, because #212 says **do not widen `Tool`** — what the CAM view cannot
carry does not belong in the shape the workers structured-clone. `catalogue.json` is also the one
deliberate exception to §5.7's preserve rule: a sync REPLACES a `catalogue.json` that cannot be read
and says so in its notes, because that file is reproducible and the sync is its only recovery, while
`house.json` — the user's own — keeps the refuse-and-preserve rule untouched. A sync that would
EMPTY a non-empty catalogue (an import that found no cutters) is refused rather than applied, and a
row that cannot be served refuses the whole sync and names it. `HOUSE_SCHEMA_VERSION` stays 1: no
released build ever wrote a `catalogue.json`, so the shape below it was still free to change.

**Verified against the real install, 2026-10-08.** `cargo test --lib -- --ignored` runs the whole
path — read, map, validate, write, serve — against this machine's own Studio library: 129 rows, all
129 added, no notes, and the category counts `0→18, 1→45, 2→3, 3→22, 5→30, 6→8, 7→3` matching §3's
table exactly. A second sync reports 129 unchanged, changes nothing, and `/api/v1/tools` is
byte-identical before and after; the vendor database's digest is byte-identical too. One cutter has
an independent source — `TOOL_LIBRARY`'s `flat-3.175x12-metal` is verbatim from the `;@MKR|TOOL` line
of Makera's own `TopClamp.nc` — and the served row agrees with it field for field, with exactly three
exceptions worth knowing: the header writes `cornerradius=0|angle=0|halfAngle=0` because it has no
way to leave a field out, while the database stores `''` for the same unstated values, so the
catalogue serves `null` where the built-in carries `0`. Neither is a wrong geometry for a flat end
mill, and only the `null` one avoids claiming the vendor said something it did not. The browser QA
(`qa-308-catalogue.mjs`) then feeds the service's own answer — the bytes the ignored test writes out,
not a hand-written stand-in — through the client: the whole catalogue passes the Zod schema (one bad
row would take the entire tier down, since the array is parsed as one document), the picker lists
`2 built-in + 129`, and the catalogue's flat end mill sweeps the fixture program, while its ball nose
is refused **by name** — `tool-refused … is type "Ball Nose" (ball)` — which is the check that the
`type=` text and the shape arrived intact rather than defaulted. `npm run check:platform-gate` still
passes: the reader is Rust in the desktop binary, so nothing vendor-derived is in the web bundle, and
no vendor row is committed to this repository — the sync writes to the user's own data directory, and
"my machine" export (`/export`) carries `house.json` only.

**Implemented 2026-10-09 (#310, decision 32): the feed matrix as a tier below measurement.** The
same reader that imports the cutters imports `t_MakeraCutterProperties` — 1 328 rows over the 129
cutters, joined on `t_MakeraCutterProperties.cutterID → t_MakeraCutterList.cutterId` and filed under
`t_MaterialList.materialSubcategoryName` — and serves it as a **second document**,
`GET /api/v1/feeds`, a plain array with its own `ETag`. Second on purpose: 1 328 rows against the
cutters' 129, so a client that wants only the cutters should not parse it, a malformed feed row costs
the feeds tier and not the whole house, and a re-sync that moves one number does not invalidate the
tool list. `Health` carries `feedRows` beside `hasCatalogue`, because a `catalogue.json` written by
#308 loads fine but holds no rows — `hasCatalogue: true, feedRows: 0` is a state a user should be
able to *see*, and a re-sync is what fixes it. On the client the tier is a module-level snapshot,
`setFeedCatalogue(rows)`, **empty by default**: the Node scripts, the coupon readback and every
existing test see exactly the table they saw before, and `toolRegistryStore` fills it only after a
usable tool list has arrived, clearing it when `/feeds` is absent or unreadable.

**Four numbers, and the step-over deliberately not among them.** Makera states
`spindleSpeed`/`feedRate`/`plungeFeedRate`/`stepDown` and also its own `stepOver`/`stepOverPercent`;
only the first four are adopted. `stepOverPercent` is a fraction of the **tip** diameter, and for
**every flat end mill in wood it is 63 %** — measured: `stepOver` 2.0 mm on the 3.175 mm
`112111313812`, 0.63 mm on the 1 mm flat, 3.78 mm on the 6 mm. #191 refuses any step-over above the
tool **radius**, because our contour-parallel sweep leaves an uncut spine down the middle of a stroke
above 50 %, so importing the vendor's number would refuse every flat-end wood row in the table — the
tier's own best material. Their percentage describes *their* pocketing strategy, not ours; step-over,
peck and air stay this app's (a conservative 45 %). This is the one place the tier is narrower than
the data, and it is a decision rather than an omission.

**Keyed on the cutter, never on the diameter.** A catalogue row is looked up by `Tool.id`, which
**is** the vendor's `g_ID` — so the built-in `flat-3.175x12-metal` (`id: '112111313812'`) inherits
Makera's wood row, while `flat-1.0` (no id) and every cutter of the user's own do not, even at a
diameter the matrix covers. The material map is **exactly two rows**, `Hardwood → hardwood` and
`Softwood → softwood`, matched with `hasOwnProperty` so `toString` is not hardwood, and **anything
else is refused rather than guessed at** — including `MDF`, a material this app *has* and the vendor
files its cutters under. PLA is not in `t_MaterialList` at all, so §9.1's badge job can never be
served by this tier: #165's measured numbers remain its only source, exactly as §5.1 of
`/Makera-Parity.md` says. Precedence is decision 32's, and "a catalogue row never overrides a measured
row" is a unit test rather than a comment — `feedsFor` takes an optional table so a spec can fold a
real coupon verdict through `applyMeasurements` and prove the catalogue is not even consulted when a
field is measured. Everything the catalogue supplies still passes through `clampToMachine`: the
vendor's 15 000 RPM rows — 32 of them — resolve to the Z1's 13 000 with an `rpm-clamped` warning
rather than being dropped or edited, a made-up 24 000 is refused, and a feed above 1 200 mm/min is
clamped like any other number.

**It does not widen coverage, and that is worth saying where the tier is.** The catalogue sits above
the starting table as a source of better *numbers*; it is not a source of *rows*. A 6 mm cutter —
every wood row of `UNMEASURED_FEEDS_TABLE` stops at 3.2 mm — is refused before the catalogue is
consulted, so a catalogue row for a 6 mm cutter changes nothing today. The reason the ranges stay the
table's is that a row supplies our step-over and peck too, and no vendor states those; widening them
is its own decision with its own evidence (a bench measurement per diameter), not a side effect of
importing a matrix. The pinned behaviour — *a cutter no row covers is refused, never extrapolated* —
is unchanged.

**Verified 2026-10-09.** `cargo test --lib`: 55 pass. The ignored real-install gate now asserts the
feed half against Studio's own library — **1 328 rows**, 15 materials including both woods and
neither PLA nor MDF, every row naming a cutter the service also serves, and the TopClamp cutter
carrying one row per material — and it writes the rows into the same fixture `qa-308` reads, so the
browser sees the real matrix rather than a stand-in. `npm run typecheck`, `npx eslint` on the changed
files, and both halves of `npm run check:platform-gate` are clean; 57 targeted vitest tests pass.
`qa-310-feeds.mjs` then drives the panel in a real browser against the real rows, four scenarios, all
green and photographed: a hardwood job on the built-in 3.175 mm flat shows **10 000 rpm / 1 000 mm/min
/ 300 mm/min plunge / 1 mm step-down** tagged `Makera` under the badge *"Makera's catalogue — not
measured"* while step-over stays this app's 1.42875 mm; the same geometry with no vendor id, and the
same cutter in a material the vendor does not file it under, both show the starting values; a matrix
patched to 15 000 rpm resolves to 13 000 in the field the operator reads; and with `/feeds` answering
404 the cutters still arrive and the panel is back to the starting table — every field `computed`,
the hardwood feed 400 mm/min, nothing claiming Makera.

**One gap, found while verifying, filed rather than quietly carried (#317).** `feedsFor` returns clamp
diagnostics and the panel renders none of them, so a catalogue row clamped from 15 000 to 13 000 is
silent in the UI — the number is right and the user is not told it moved. It is a pre-existing gap
(the panel never rendered `diagnostics`), not a regression, and #310's acceptance holds without it.

**Implemented 2026-10-09 (#324): the rows are handed across, not remembered on the far side.** #310's
tier resolved from **module state** — `let feedCatalogue` in `feeds.ts`, filled by
`toolRegistryStore` — and that is where the defect lived: **a worker is a separate module realm**, so
from the sim worker the same import read `[]`. Panel and program therefore disagreed about the same
job: the panel showed Makera's hardwood numbers, and `engraveGenerate` posted the STARTING table's
`S`/`F` into the `.nc`, which the run sheet then printed, because the sheet is built from that same
worker result. Nothing caught it because the browser check read the panel and never the file
(`qa-310-feeds.mjs`). The fix is #305's shape applied to feeds: `feedsFor` takes its rows as a
**required first argument** — `feedsFor(catalogue, material, tool, machine, override?, table?)` — so
worker code that forgot to say where its rows came from is a **compile error rather than a silent
wrong number**, for the same reason `toolForIn` takes its entries. Module state survives only as the
main thread's storage (`setFeedCatalogue` / `clearFeedCatalogue` / `feedCatalogueRows`); no resolver
falls back to it. The rows are read once on the main thread and structured-cloned through the four
layers that already carried the cutter — `EngravePanel` / `engravePreviewStore` / `engraveRunStore` →
`simClient` → `sim.worker` → `engraveGenerate(job, tool, catalogue, calibration)` and
`engravePreview(job, tools, catalogue, gen)` → `recommendTool(job, tools, catalogue, measure)`. **The
preview needed it for a behavioural reason, not symmetry**: `feedsFor` refuses a row past the
machine's ceiling, so a cutter the starting table alone would qualify is *excluded from the
recommendation* once the real rows say 24 000 rpm — the picker and the generator were choosing from
different lists. The three Node scripts (bench, job upload, upload check) pass `[]` and say why in a
comment: a headless run has no house service. The two tests that would have caught it:
`engraveGenerate.spec.ts` generates with a hardwood row loaded and asserts the `.nc` carries the
row's `S`/`F` and **not** the starting table's, plus the same numbers on the run sheet;
`engraveRunStore.spec.ts` fails if the store stops handing the rows over. Nothing vendor-derived is
in the repository — the test row is hand-built (§3, #186).

**Implemented 2026-10-09 (#319, #320): the service refuses at the door, because the far side's refusal
is silent.** Both issues are one defect seen from two sides: a document the service accepts and the
client refuses does not fail loudly, it makes the whole house read `absent` — catalogue tier and all —
while `/health` still says ok, and nothing names the import that caused it. So the refusals moved to
where the data is written.

**#319 — a key this house stores is exactly `user:<something>`.** `validate_key` (which the client
mirrors as `isToolKey`) refuses, with the reason it refuses: a key with no `user:` namespace, a
namespace with nothing after it, a key with a **control character** (CR, LF, TAB, NUL) — a stored key
is what the `.nc` header's tool field prints and, in the comment line carrying it, `user:a\nG0 Z-50`
is a stored key that injects a line into every program generated with it — a `|`, which the header's
tool line cannot carry, and whitespace at either end, **refused rather than trimmed** (`user:x` and
`user:x ` are one cutter to a human and two keys to a `Map`; a silent rename is exactly what this
contract exists to prevent). `cat:` is refused by case, since the catalogue belongs to a sync and not
to this file. The client's half is the same rule applied to the **four** namespaces the app carries
(`inv:`/`user:`/`cat:`/bare) — the client does not only write keys, it reads the catalogue's and the
built-ins' — and it lives in `ToolLibrarySchema`, which parses `GET /tools`, so a key the service
should not have stored is a refusal of the whole list rather than a row filed under the built-ins.

**#320 — one document, validated whole, on the way in and on the way out.** `import` shape-checked
and adopted; `HouseDoc::validate` now runs the full `ToolLibraryEntry` rule (provenance non-empty),
unique tool keys, unique inventory ids and a code on exactly one cutter — in **`import`** (400,
whole-or-nothing, store untouched) **and in `load`**, so a hand-edited `house.json` is a `problem` in
`/health` with nothing served and writes refused, instead of being served into a panel that cannot
read it. The rule #320 asked to be decided once: **a code value appears at most once in the whole
inventory**, because `code → the item` is the door #309 is built on and must be a function; enforced
in `create_inventory`/`update_inventory` too (change the other cutter's quantity, don't register the
code twice). Two more of the same class — served in `/inventory` where the client refuses — fell out
of the same reading: an empty `addedAt` and an empty `origin.id`.

**The pairing is the test (#319/#320).** `tests/unit/fixtures/house-doc.json` is a committed,
**synthetic** document (§3, #186) read by both sides: `house.rs::tests::the_shared_house_fixture_is_accepted_and_served_whole`
imports it, serves it and round-trips it, and `tests/unit/houseContract.spec.ts` asserts it parses
through the client's two schemas — then asserts that each mutation the service refuses is one **both**
sides refuse. One list, two implementations: if either contract loosens, a test on the other side
fails next to it. Evidence: `cargo test --lib` 60 passed (the seven break-mutations each refuse, leave
`tools()` as `[]`, `problems` empty and no file written), the full vitest suite 3312 passed, typecheck
clean. No browser QA, and none is possible — the service is the desktop shell, and the web build has
no house (the same reason #324's panel-only check missed its defect).

**Implemented 2026-10-09 (#327): a torn copy is refused, on both sides of the copy.** The sync takes a
bare `fs::copy` of a database Studio writes in place (the header's bytes 18/19 are `1` — rollback
mode), so a copy taken mid-commit can be torn. A torn copy does not have to fail to open or to query:
the outcome worth refusing is the one that **parses and answers with fewer rows**, where every missing
cutter is reported `removed` and its feed rows go with it until somebody happens to re-sync.

Two checks, one either side of the copy.

- **Before it: the source's sidecars.** A `-journal` or `-wal` with **anything** in it beside
  `makera_library.db` means the main file is behind its own writes — rollback mode keeps the original
  pages in the journal while the main file already carries the new ones, WAL keeps commits in `-wal`
  until a checkpoint — so a copy of the main file alone is missing a transaction. The sync refuses and
  names the sidecar and the consequence, with the one action that fixes it ("Open Makera Studio and
  close it again, then sync"). An **empty** sidecar is not a pending write (`journal_mode=PERSIST`
  leaves an empty journal after every commit, and a checkpointed `-wal` can be empty), so the at-rest
  states still sync. This is a third mechanism, beyond the two the issue named, and it is the only way
  the copy-first design can honour the "handles journal and WAL correctly" the backup API would have
  given — the backup API reads Studio's live file, which the module's first promise forbids.
- **After it: `PRAGMA integrity_check`** on the copy, before a row is read from it. `integrity_check`
  and not the `quick_check` the issue named: the difference between them is the index-versus-table
  cross-check and the UNIQUE checks, and an index that disagrees with its table is exactly what a main
  file written without its journal looks like — with this module's SELECTs joining through
  `t_MakeraCutterList.cutterId`'s primary-key index, a `quick_check`-clean copy can still answer the
  wrong rows. Both a pragma that fails and a pragma that reports are the same refusal.

Also: the cleanup removes the `-journal`/`-wal`/`-shm` beside the copy as well as the copy itself (a
read-only open of a WAL-mode copy creates the first two in the temp directory, and the old cleanup
left them there for good); `immutable=1` is deliberately **not** used, because a `file:` URI has to be
hand-escaped for a Windows temp path with a space in it and a mis-escaped one fails the whole sync, so
the sidecars are deleted by name instead; and a file whose pages cannot be read at all is refused as
**damage** ("the copy did not verify … `database disk image is malformed`") rather than as "not a
Makera Studio library", which sent the user looking for the wrong file — a valid database that has
never heard of Makera still gets the wrong-file answer.

**One test-infrastructure fix, because the change exposed it.** `the_read_leaves_the_vendors_database_
exactly_as_it_was` sampled the process-wide temp directory for leftover copies. That was already racy —
every test in the binary reads in parallel, and another thread's in-flight copy is not a leak — and
`integrity_check` widened a copy's live window from microseconds to milliseconds, which made it fail.
The scratch directory is now a parameter of the read (`read_all_in`, with `read_all` passing
`env::temp_dir()`), so the test makes its copy in a directory it owns and the existing "only
`makera_library.db` is in there" assertion covers the copy **and** any sidecar beside it, with no race.
The claim got stronger rather than weaker.

Evidence: `cargo test` 68 passed / 0 failed / 1 ignored, and three consecutive runs of it — the flake is
gone rather than hidden. New: a library with a non-empty `-journal` (and separately `-wal`) is refused
by name, an empty one still syncs, a halved library file is refused as a copy that did not verify, and a
sentence where a database should be is refused as damage rather than as the wrong file.

**Implemented 2026-10-09 (#326): a failed feeds query is not an empty matrix, and the problem outlives
the write.** Three defects from the same review of e77b230, all in the sync path.

1. **Every prepare error was read as "no feeds table".** `let Ok(mut stmt) = conn.prepare(SELECT_FEEDS)
   else { return Ok((vec![], None)) }` — so a Studio update that renamed one column made the next sync
   **succeed**: `feeds: []` written over 1 328 rows, `feedRows: 0`, notes empty, and the panel quietly
   back on the app's starting table with nothing telling the user why. The two cases cannot be told
   apart by code — SQLite reports "no such table" and "no such column" with the same `SQLITE_ERROR`,
   which rusqlite maps to `ErrorCode::Unknown` — so `absent_feed_table` reads the **message** and
   matches the one table whose absence is legitimate. Everything else comes back as a sentence naming
   the vendor's own error, which is what makes a renamed column refuse the sync by name. The table name
   in the match is not decoration: the join that carries the material is `t_MaterialList`, and a missing
   one would otherwise have emptied the matrix with no note at all.
2. **`inf`/`NaN` were servable.** `num()` reads text, and Rust's `f64` parse accepts `"inf"`; `> 0.0`
   passes `+inf`, serde_json writes it as `null`, and that fails the client's parse of the **whole**
   document — the exact "one bad row costs the tier" outcome the dropping exists to prevent. The line is
   now `is_finite() && > 0.0`, the same line the client's schema draws (`.finite().positive()`, #325),
   and the note says which rule did it ("not positive and finite"). NaN was already caught by `> 0.0`;
   `inf` was reachable, through a TEXT cell.
3. **The problem was cleared before the write could fail.** `catalogue_problem.take()` ran before
   `write_atomic`, so a sync whose write failed reported no problem while `catalogue.json` was still
   unreadable — and the next successful sync lost the note about the file it replaced. The read is now
   `as_deref()` and the clear happens where it already did, after the write: a store is only touched
   once the bytes have landed.

**And the empty guard, one tier down.** The tools guard refuses an all-or-nothing empty import because a
catalogue with no cutters leaves nothing to cut with. The same import with no **feed** rows costs only
the starting numbers, so it is a NOTE and the sync still lands — stopping there would block the one
operation that can heal a bad catalogue file, which is the same reasoning that lets a sync replace an
unreadable one. It fires only when rows would be lost; a first sync over a database that never held
feeds says nothing, which is the state the reader is allowed to call empty.

Evidence: `cargo test --lib` 66 passed / 0 failed / 1 ignored. New: a database without the feeds table
is an empty matrix with no note and its cutters import; a renamed column refuses the sync **naming the
column**, and a dropped `t_MaterialList` refuses too rather than passing for empty; an `inf` step-down
drops its row under the same rule as a `0`; at the store's edge a renamed column is a `Refused` that
leaves the served matrix intact; a write that cannot land leaves `catalogue_problem` set; and a sync
that empties the matrix notes it while a first sync over a feedless database is silent.

**One gap, filed rather than fixed here (#328).** These are sentences nobody reads yet: `houseStore`
keeps the report as `lastSync` and builds its notice from the counts alone, so a replaced catalogue
file, forty dropped feed rows and an emptied matrix all look like a clean sync. That is the same
silent-failure shape this issue is about, one layer up, and it is a rendering job on #311's surface.

**Implemented 2026-10-09 (#325): the catalogue yields, and the label follows the clamp.** Two defects
from the review of e77b230, one class each: the tier above the starting table was treating its
numbers as the truth about this job.

1. **A row could refuse a job the default would cut.** `catalogue.rs` dropped only empty or
   unparseable cells — `num()` reads Studio's `0` in a numeric column as a perfectly good `0.0` —
   and the client's `FeedCatalogueSchema` was `finite()`, not positive. `feedsFor` then adopted the
   row and hit its own `<= 0` and >50 % clamp refusals with no fall-through, so a vendor row with
   `feedRate = 0` for a wood cutter refused a job that generated fine before the sync, with a
   message ("cutting feed must be > 0, got 0 mm/min") naming the vendor's cell and not the vendor.
   Fixed at three points, because the failure is silent wherever it is not refused: the **reader**
   drops a row whose four numbers are not all positive and says which rule dropped them, the
   **client schema** requires positive-and-finite (a `0` reaching a client is a service this build
   does not understand — said out loud, and the tier is lost loudly rather than resolved into a
   program), and **`feedsFor` screens the row field by field before adopting it**: a number this job
   cannot use — non-positive, or past the machine's refusal band — is passed over, the starting table
   answers that field, and a `catalogue-ignored` diagnostic names the row, the number and why. A row
   that answers none of its four fields is not this job's catalogue answer at all (`catalogue: null`,
   and the panel's label with it). The refusal stays for a value someone **asserted** — an override,
   a typed feeds row — which is the whole asymmetry: a vendor table does not get to assert for the
   user. The band question is put to `clampToMachine` rather than restated, so the rule has one home.

2. **A clamped value was labelled Makera.** `sources` was stamped from the row *before* the clamp, so
   a 15 000 RPM row showed 13 000 tagged `Makera` — when Makera said 15 000 and the 13 000 is this
   machine's ceiling. `sources` is now stamped after the clamp, with the moved fields read off the
   choke point's own answer rather than a remembered copy (decision 28). The same one-line condition
   covers the measured tier, which had the same unearned tag.

**One consequence, named rather than hidden.** #324's `recommendTool` test used an absurd row
(24 000 RPM) to show the handed catalogue excluding a cutter the starting table would qualify. After
this, **no catalogue row can decide that pre-filter at all**: every number a row states is either
usable or passed over, so `feedsFor(...).ok` answers exactly as it would with no row. The test is now
the opposite assertion — the cutter stays, and the two calls agree — which is the guarantee #324
exists for. The hand-over is still observable where it matters, in the numbers
`engraveGenerate.spec.ts` reads out of the `.nc`; `recommendTool` keeps the argument and says in its
doc why. The guide gained the `catalogue-ignored` row (chapter 8 lists every code the tree can emit)
and its feeds step now says a row stating a number this job cannot use does not fail the job; the
mirror is re-synced. Evidence: `cargo test --lib` 61 passed — the new one drops a `0` feed and a
negative step-down with a note naming the rule, and **serves** a 24 000 RPM row, since absurd is not
the same as unusable; full vitest 3316 passed; typecheck and eslint clean. No browser QA, and none is
possible — the reader lives in the desktop shell, and the web build has no house.

**Implemented 2026-10-09 (#321): sharing the house safely — one process, and a version on every
change.** The service was built for one window and had no answer for a second. Two of them on one
machine is the case that matters: `server.rs` falls back to an ephemeral port when the configured one
is taken, so a second launch would have bound a different port, opened its own `HouseStore` over the
same `house.json`, served its own in-memory copy, and let the two windows overwrite each other's saves
by arrival order with nothing on screen saying so. Five changes, in the order they matter.

**One house, one process.** `HouseLock::acquire` takes an OS lock on `house.lock` in the house
directory (`File::try_lock`, which is why `rust-version` is now `1.89` — the file's own comment says
so, because a `rust-version` the code does not honour is a promise to nobody). A second launch
**refuses to start** — the issue allowed refusing or focusing the first, and refusing costs nothing: a
window is not built, a store is not opened and no second port is bound. The refusal is shown in a
message box via the already-present dialog plugin, not written to a log, because `eprintln!` and
`env_logger` go nowhere for a Windows GUI app: a lock that silently made the app not open would be
worse than the bug. `server::start` now takes the lock as a parameter, so "the process serving the
house is the process holding its lock" is compiler-checked rather than a comment.

A held lock and not a pid file or a `create_new` marker, because the OS releases a lock when its
holder dies: a pid file cannot tell a live process from a crashed one, and a marker file would leave
a stale lock that permanently blocks the app. Nothing ever DELETES `house.lock` either — unlinking it
while another process held a lock on it would let a third create a fresh file and lock *that*, and two
processes would be serving one house again. The file is empty and permanent; the lock is the truth.
`tauri-plugin-single-instance` was considered and rejected: the directory lock is the stronger
guarantee (it covers a second *process*, whoever started it) and needs no new dependency.

**A version on every write that changes something.** `PATCH` and `DELETE` on `/tools` and
`/inventory` now require `If-Match`: missing is **428**, naming a version no longer served is
**412**, and last-writer-wins becomes a refusal the client has to act on. `POST` is deliberately not
guarded — a create is judged against its key, and a second create of the same key is a 409 whatever
version it was based on, which is a stronger answer than a validator — and neither is `POST /import`,
which replaces the house wholesale and has no prior version here to be based on. The validator is the
**list's** `ETag` (`/tools` or `/inventory`), not a per-entry one: the list is the representation the
client actually read and the one whose etag `toolRegistryStore` already keeps, so the guard needed no
wire-shape widening. The over-breadth is deliberate and conservative — a catalogue re-sync invalidates
a pending tool edit, which costs a reload and can never lose a write.

The two helpers that derive a list's bytes are **free functions over `&Inner`** rather than methods
(`tools_bytes`, `inventory_bytes`), because a guarded write has to compute the validator while already
holding the write guard, and a method would have deadlocked on the same `RwLock`.

**Unique temp names, and a flushed directory.** `write_atomic` wrote `<file>.tmp`, which two writers
would both aim at: the loser's rename would publish the winner's half-written bytes — the exact torn
copy the atomic write exists to prevent. The scratch name is now `<file>.<pid>-<counter>.tmp`
(`WRITE_SEQ`, process-wide), and `sync_dir` fsyncs the directory on unix so the rename itself is on
disk before the write is called done — unix only, because on Windows a directory handle cannot be
opened for that purpose and `rename` is already the file's own barrier.

**The client sends what it read, and re-reads when it is told it is stale.** `houseClient.ts` carries
the validator as `ifMatch` on the request options — a field of its own, not the reads' `etag`, which
is an `If-None-Match` saying the opposite thing — and the four guarded helpers take it as a required
parameter whose type allows `null` (a client with no validator has none to offer, and the 428's
sentence says so rather than an invented etag). `houseStore` passes `etag` / `inventoryEtag`, read at
the moment of the write rather than captured when the edit began. And a 412 or 428 now **re-reads**:
the rule was "a refusal leaves the house exactly as it was, so re-reading is a request whose answer is
already known", and a stale guard is precisely the refusal where that is false — without it the user
retries against the same dead validator for ever. The notice is still the service's own sentence,
because a 412 is something the user can fix, not an error to report.

**LAN authentication: decided, not omitted — decision 33.** A house on a home LAN stays
unauthenticated, and what sharing gets instead is the lock and the guard: concurrency is the problem a
home network actually has.

Evidence: `cargo test --lib` 74 passed / 0 failed / 1 ignored (the ignored one reads this machine's
Studio library), typecheck, eslint and `check:platform-gate` clean both directions, and the targeted
vitest specs 54 passed. New Rust tests: no-`If-Match` and a stale one each refuse **and leave the
document byte-identical**, the current one succeeds and moves the etag, the two lists guard
separately, a scratch name is never reused and never the destination, the lock admits one holder and
frees on drop, and the atomic-write test now scans the **directory** for leftovers instead of checking
a guessed name. New client tests: the header on all four helpers and its absence on register, the 428
path, the 412 carried through with its status, and the store re-reading on 412/428 and **not** on a
409. No browser QA: the feature is a second process and a header, and the web build has no house to
run either against.

Two stale comments died with this change, both claiming the client's write path did not exist — true
until #311 landed, and a lie in `house_api.rs`'s and `houseClient.ts`'s front doors ever since.

**Implemented 2026-10-09 (#311): the Manage surface — the house, in the app.** #306/#308/#310 built
the service and the tiers; this is the screen over them, and it gives #306's write path its first
users. Manage is a **third mode beside the welcome overlay**, entered from the toolbar beside
`✨ New` and gated on `__FEATURE_SIM__` like every other CNC surface: a house-scoped surface has to be
visible with no project open, and no sidebar section can be (`activeSidebarSection` is
project-scoped, and `Sidebar.tsx` filters by archetype). Its rail holds **House → Tools** and
**Machines**, with **Materials** drawn greyed and *later* rather than absent. A row's tier is read
from its **key namespace** (`inv:`/`user:`/`cat:`/builtin) — the one thing the client can trust,
since `GET /tools` serves the catalogue tier first and `ToolLibrarySchema` does not carry `origin` —
and a clone's `provenance` sentence is what names what it was cloned from. The five decisions the
mockup took stand as drawn: grouped by tier, a clone a **separate** row that records its origin while
the owned row keeps Makera's definition read-only (decision 30), Materials reserved, the printers
card kept muted, and the Machines header keeping its own check beside the card's **Check again**.

**Three things it cost, kept because each is a trap.** (1) **Two definitions no service supplies,
and two counts that disagreed.** The built-ins are in the list with the service absent — a simulation
needs something to run with — and the first status bar summed `entries.length + 2`, which counted
neither them nor the `inv:` rows, so it read "4 definitions" beside a rail that read "5": two counts
of one thing, on screen at once. Both now read `useToolRegistry()`. (2) **The provenance line is the
widest thing in the table.** Every `td` is `nowrap`, so the Name column's minimum is the widest thing
in it; left unwrapped, *"cloned from Makera catalogue “3.175*12mm Flat End(Metal)” on 2026-10-08"* set
that column to ~390 px and pushed the From column — the tier tag, the whole point of the grouping —
past the right edge of a 1400 px window. It wraps now, under a **measured** cap: nine `nowrap`
columns come to 761 px against the 784 the list pane has at 1400, so no scrollbar appears at the
design width (it still does at 1200, where the pane is 584, and `overflow: auto` keeps every column
reachable there). (3) **Every write re-reads, and the re-read blanks the pane.**
`toolRegistryStore.refresh()` opens with `status: 'checking'`, so ToolsScope swaps to its "Asking
this origin…" pane and the list unmounts for one local round trip after each save. Left standing and
reported rather than papered over: the fix is a store change (hold the last list through
`checking`), the flash is one round trip against a local service, and the QA waits on the sentence
the write concludes in instead of a node that may be gone by then.

**Verified in a browser, 2026-10-09 (#311)** — `qa-311-manage.mjs`, four scenarios, all green and
photographed into `qa-311-out/`. The toolbar toggle opens the mode with no project open and the rail
names both scopes; the list groups owned → yours → catalogue → built-in and the counts line accounts
for every definition; a stated dimension prints as stated and an unstated one as `—`, never `0`; the
status bar and the rail agree on the count, and the list fits its pane, tag and all; search and the
tier chips each narrow the list; selecting a row shows the definition with its catalogue id; **Clone
registers a new `user:` key and not an edit of the catalogue row**, keeping the numbers it was cloned
from and stating where it came from; saving a quantity PATCHes `/api/v1/inventory/{id}` and leaves
the definition untouched; Export is a `GET` that wrote nothing and Import sends the file whole; the
three Register doors each say what they will hold, and the Type door says blank means unknown; the
Machines card concludes out loud that the web build cannot reach a machine and leaves no machine
behind, with the house undisturbed; and with the origin answering as a non-service the card carries
the probe's own reason sentence verbatim, the two built-ins are drawn beside it, and **Check again**
asks the origin again. The unit specs pin the tier rules and the store against a faked `HouseClient`;
the browser pins reachability, real rendering at real size, and the wire shape.

**Implemented 2026-10-09 (#313): the shell is revalidated, not cached for an hour.** Every asset went
out with `public, max-age=3600`, `index.html` included — which made the one file whose *name* does not
change with its content the only one pinned for an hour, so a user who updated the app kept a shell
naming the **previous** build's chunks. `serve_asset` now decides on the **served** name — the name that
answered, which is not always the name requested: an unknown path is the shell, so a deep link is
revalidated exactly as `/` is, and an `assets/` path never is. `index.html` → `no-cache` with a content
validator, `assets/…` → `public, max-age=31536000, immutable`, everything else keeps the hour (the
favicons and the social card have no hash to pin them by). `no-cache` and deliberately not `no-store`:
the entry is *kept* and one conditional request decides it, which is what also keeps the back/forward
entry — the thing `no-store` throws away — and one 304 against a local server is not a saving worth
losing it for.

**The validator is over the shell's bytes, and a 304 carries the headers that are not about bytes.** The
ETag is `"fnv1a-<16 hex>"` over the bytes served, so a rebuild changes it and the first load after an
update is a 200 with the new shell. The 304 repeats the ETag, `no-cache` **and the CSP**, because RFC
9111 says a 304 updates the stored response's headers with its own and leaves absent ones as they were —
and the CSP comes from the server rather than the file, so a build that changed only the policy would
otherwise leave the old policy governing a cached page that the validator says is unchanged.

**`fnv1a_hex` moved to `etag.rs`.** Four modules hashed bytes and `server.rs` reaching into `house.rs`
for it would have stated a false structure — the shell has nothing to do with the house — so the one
content-validator idiom lives in its own module, and the `If-None-Match` matching rule (exact, comma
list, `*`) moved with it, so the API and the shell answer "the same bytes" by one implementation of one
sentence instead of two.

**Evidence.** `cargo test` in `src-tauri`: 79 passed / 0 failed / 1 ignored, five of them new — the
shell's validator is the same across `/` and a deep link, a matching validator answers a bodyless 304
with the CSP aboard while a foreign one answers 200, `cache_policy`'s four cases, an `/api/v1` request
carrying the *shell's* validator still gets JSON rather than a 304, and the headers the real server
writes **over a real socket** — a router test and "what a browser does" are different claims, and only
the second one was the bug.

**The gate, run for real (`qa-313-rebuild.mjs`).** Two phases sharing one persistent browser profile:
load the built app (shell A), add a marker `<meta>` to `dist/index.html`, rebuild and restart, load
again. The browser sent the validator it had stored for A, the server answered 200 because the bytes
differed, and the new marker was in the DOM **on the first load** — the whole point of the issue, and
the one claim a header test cannot make. `qa-313-shell-cache.mjs` is the standing policy check beside
it.

**The trap that cost the most time, recorded because it will read as a bug again.** Two CDP readings
said "the shell is never revalidated": `Network.requestWillBeSent.request.headers` fires *before* the
cache layer adds the validator, so it reports `If-None-Match: null` on a request that carries one, and
`Network.responseReceived` reports the **merged** response, so a 304 surfaces as `200,
fromDiskCache: false`. The honest signal is `requestWillBeSentExtraInfo` — the headers that actually
went on the wire — and even that was only trusted after an in-process server that logs what it receives
was pointed at the same probe and agreed. Every one of those readings is a level removed from the
claim; the server's own log is not.

**Two defects found while verifying, filed rather than folded in.** #330 — the shell's CSP refuses the
Google Fonts stylesheet, so the desktop app renders in fallback type (`style-src 'self'
'unsafe-inline'`); #313's brief says do not change the CSP, so it is its own issue with its own
evidence. #329 — the desktop app could not start at all: `tauri.conf.json` declared window `main` while
`setup()` built a programmatic `main`, and Tauri creates config windows before the setup hook, so every
launch panicked. Fixed with `create: false` (the documented escape hatch) and verified by the app
running and answering on its port; it is its own change and its own commit. The reason it survived to
now is worth keeping: every desktop verification so far went through vite.

**Implemented 2026-10-09 (#309): registering a cutter — the scan field, and the two doors behind it.**
The Register frame was a placeholder in #311; it is now three doors, and the frame itself does
nothing but choose between them. *Scan* is the way in a scanner drives: one field, focused on mount,
Enter moves it on, and a decoded camera frame goes to the **same** handler as a typed line, so the
camera is an addition and never the way in (`'BarcodeDetector' in window` decides whether the button
exists at all, and jsdom proves the absent branch). *Catalogue* searches the synced rows. *Type* is
the honest last resort: name, shape, tip ⌀, shank ⌀, flute, shoulder, every blank left **null** —
never 0, because a blank field is "not stated" and a 0 mm shank would collide with every holder in
the planner.

**The box-code reading is provisional, and says so.** `parseBoxCode` reads
`C1-BIT-<TYPE>-<tip>-<flute>` into a shape and two lengths, but the only label anyone here has held
is the bench's 1 mm ball nose (`3.175*1*4mm Ball Nose`, g_ID `131012103804`), so #208 A7 stands: one
example is not a format. The type word is read through the **same** vocabulary Studio's `type=` field
uses (`shapeFromType`), so a label and a `.nc` header describing one cutter agree once the dashes are
spelled as spaces; a word that does not parse is `'unknown'` **and the two numbers are still read**,
because the numbers are the part a wrong guess would not corrupt. The panel draws the result as a
reading ("Read as a Makera box code: …"), and the #311 mockup's G2 already drew what happens when the
reading fits more than one row.

**The candidate rule — the "ask first" answer, taken as recommended: match on the tip, ignore the
flute.** The slug's flute is what the *box* says the bit reaches, and it is read off a provisional
format; matching on it would let one wrong guess hide the right row behind an empty list, where a
user has no way to argue with it, while matching on the tip over-suggests and G2 already draws that
outcome — two rows fit, pick the one on the label. Since the reading is provisional, the failure that
is recoverable (a longer list) beats the one that is not (no list). Shape is matched only when the
label named one.

**A code identifies a possession, not a definition** (decision 30's third record). So a scan of a
code the inventory already holds is **not** a second row: it answers "this is one of the ones you
have", names it and its count, and offers one button that PATCHes `quantity + 1`. Case-insensitive,
because a printed code retyped in lowercase names the same box, and the service would refuse the
duplicate anyway (`InventorySchema`). Registration is a POST of an `owned` row whose `Tool` is
**copied** — the user owns the cutter whether or not Makera still lists it — with Makera's `id`
**kept** (it is the definition's identity) and the catalogue row named in `origin: {id, syncedAt}`.
An **owned** row keeps Makera's `id` deliberately — it is that definition's identity, and `origin`
names the row it was registered from. A **clone** does not, and that asymmetry is the point
(`selection.ts::cloneOf`, #212's "Do not let a clone inherit the vendor id"): an owned row is the
vendor's cutter held in a hand, so the id is still true of it, while a clone is a definition the user
is about to change. `Tool.id` is what `post/z1.ts` writes into the `.nc` header and what
`simSetupStore.matchRegistryTool` matches a header back on **first**, so a clone carrying it would
write the id of the row it came from and reopen as that unedited row. `id` and `number` are the two
fields a clone does not copy; pinned in `manageMode.spec.tsx` and in `qa-311-manage.mjs`.
(#316 is the separate, still-open question of a header matched on shape + diameter alone.)

**Two defects found while verifying, both fixed and both pinned.**
*Every write unmounted the pane it was written from*: `toolRegistryStore.refresh()` set
`status: 'checking'` on every re-read, and the tools pane answers `checking` by rendering no detail
view — so a save tore down the rail and took the half-typed scan with it. `checking` now means "no
answer yet", which is what it was always about: a source we already have an answer for is not
unknown again because we asked it twice. *The candidate row's numbers were clipped at the card edge*
because a `1fr` grid column has a min-content floor; `14px minmax(0, 1fr) auto` plus an ellipsis on
the name keeps them, and the QA now **measures** the card rather than trusting the screenshot. One
thing found on the way was **filed rather than folded in**: #331 — the quantity rule is written
twice, and `ToolDetail`'s editor and the doors disagree about a blank field (`Number('')` is 0 there,
one here). Both readings are defensible in their own context, and the divergence is on #311's
surface, so it is its own issue.

**Evidence.** `registerCutter.spec.ts` — 31 tests, the parse and its three resolve outcomes, the
tip-match/flute-ignore rule, the excluded row whose tip the catalogue does not state, `itemFromEntry`'s
origin/id rules and `itemFromForm`'s nulls including the `type=` round trip; `manageMode.spec.tsx`
drives all three doors in jsdom against a faked `HouseClient`, and pins that the frame **survives its
own write**; `recommendTool.spec.ts` pins that two `inv:` rows of the same definition rank as the
cutter they are. Full suite 3364 passed / 4 skipped. `qa-311-manage.mjs` ALL PASS, photographed into
`qa-311-out/`: the focused field, the camera button exactly where the browser could drive one, the
owned code reading as PATCH-then-a-new-count, the candidates card measured, the unknown read back
rather than swallowed, the Type door refusing a nameless cutter, and the Catalogue door's way out of
a search that matches nothing.

**The Simulate form and the clamp notice — two silences (#315, #317).** Different files, one shape:
the app knew a thing and did not say it.

*#315 — a user edit the file threw away.* `simSetupStore`'s module doc had stated the rule since
#196: "A user edit always wins: `setStock`/`setTool` flip that field's `source` to `'user'`, and a
reopened header never overwrites it." `openFile` rebuilt `stock`, `stockSource` and `toolKey` from
scratch on every call, so the doc and the code said opposite things. The panel's happy path is
open-then-choose, which hides it; the other order is ordinary — pick the cutter you have in the
spindle, then open the program — and the header silently replaced the choice. It was found while
writing #308's browser gate, where select-then-open made a ball nose run as a flat end. `openFile` now
MERGES: a field whose source is `'user'` keeps its value and its source, every other field takes this
file's, and `reset()` is the only way back. The rule is per FIELD, not per file, so opening a file
after choosing a cutter keeps the cutter and still brings the stock in — and the reverse.

*Measuring that the gate discriminates, rather than asserting it.* `qa-308-catalogue.mjs` had been
reordered around the bug (the selection moved after the open, with a comment naming why). The reorder
was reverted and the gate run against **both** stores: with the pre-#315 `openFile` the picker came
back `flat-3.175x12-metal` — the header's own cutter, matched through shape + diameter to the built-in
that leads the registry — and the ball-nose run reported `status ready, diagnostics []`, a ball end
swept as a flat end. With the fix the selection survives (`cat:019c049a-…` for the flat) and the
refusal returns by name. Both `[2]` checks are regression tests for #315; neither was assumed to be.

*#317 — a number the machine moved, said nothing.* `feedsFor` has returned clamp diagnostics since
#310 and no screen rendered them, which #310's catalogue tier made reachable on the vendor's own data:
32 of Makera's 1 328 rows state 15 000 RPM against the Z1's 13 000 ceiling, and that band CLAMPS rather
than refuses. The `Cutting` heading now carries `clamped to this machine (n)` in the warning colour,
the moved values and their messages in the `title`, the codes in `data-codes`. It counts **only the
clamps**: `FeedsDiagnostic` is the union of `ClampDiagnostic` and the catalogue's `catalogue-ignored`
(#325), and that second one is a row that YIELDED a field to the tier below — already told in the
provenance sentence, with the field named. Counting the pair would make "clamped to this machine (2)" a
lie about the row that simply had nothing to say, so a test seeds exactly that pair. The maintainer's
decision, taken on the issue the day it was filed: **show only** — no `JobFinding`, no change to the
start gate, because a clamp is the machine's limit applied correctly rather than a reason to refuse.

*#328 — a sync's own notes, stored and never shown.* Both of #326's fixes and one from #308 were
sentences nobody could read: `HouseStore::sync_catalogue` returns a `SyncReport` whose `notes` carry
what a sync that SUCCEEDED still has to say — a `catalogue.json` it could not read and replaced,
cutters in a category this build does not know, feed rows dropped because Studio left their cells
empty, and a sync that emptied the feed matrix. Nothing rendered them; the store kept the report as
`lastSync` and built its sentence from the counts alone, so all four looked exactly like a clean sync.
That is #319/#320 and #325/#326's failure mode one layer up: the service says the right thing and the
user is not told it. The Tools scope now lists them under the result (`manage-sync-notes`, one
`manage-sync-note-<i>` per note), **deliberately outside the notice** — dismissing that must not take
the record of what the sync did with it, and the notes stay until the next sync replaces them. Whether
a note and a dropped-row count deserve different WEIGHT, and whether `lastSync` should outlive a
reload (it is in-memory only, so a restart forgets them) are left as the issue's open questions rather
than guessed.

*One doc correction made on the way, in the paragraph being edited:* `cnc-guide.md` §4 still said the
Simulate tool dropdown "starts empty and is required", which stopped being true when #305 gave the
header a match to suggest. It now says what the code does — a `TOOL` record pre-selects its cutter,
and a cutter you already chose is kept.

**Evidence.** `simSetup.spec.ts` 15 tests (the per-field merge, the per-field reverse, a choice kept
against a file that states no tool, and `reset()` as the only way back); `engravePanel.spec.tsx` 51,
four of them #317's — the tag present and naming `rpm-clamped`, absent inside the ceiling, absent when
the feeds are refused (the box already says it), and the clamp-vs-yield count. Full suite **3374 passed
/ 4 skipped**; `typecheck`, `check:sim-gate` and `check:platform-gate` clean; `docs:sync` re-mirrored
and both doc gates green. Browsers, all three ALL PASS: `qa-308-catalogue.mjs` with the user's own
order restored; `qa-310-feeds.mjs`, whose scenario 3 now reads
`{"text":"clamped to this machine (1)","codes":"rpm-clamped","title":"rpm 15000 RPM exceeds the Makera
Z1's 13000 RPM ceiling; clamped"}` beside the unchanged `Makera's catalogue` badge; and
`qa-311-manage.mjs`'s new §5, which clicks Sync against a service whose report carries two notes and
reads them off the screen rather than trusting the store.

**Blank means one, at both ends (#331).** Filed from that session's own verification. The count rule
was written twice and the two copies disagreed about an empty box: `ToolDetail`'s inventory editor
derived `qty = Number(quantity)` and `qtyOk = Number.isInteger(qty) && qty > 0` — and `Number('')` is
`0`, so a cleared field was refused — while `registerCutter.ts`'s `quantityOrOne` reads blank as
**one**. The refusal sentence was hard-coded a second time in the Save button's `title` too,
capitalised, against the lower-case wording `quantityProblem` returns. The maintainer's decision, taken
on the issue the day it was filed: **blank means one at both ends** — a person holding the box owns at
least one cutter, and the worse surprise is an editor refusing a blank it produced itself. The editor
now imports both functions; `dirty` is `qtyProblem === null && (qty !== item.quantity || nextNotes !==
item.notes)`, the Save `title` is `qtyProblem ?? 'Save the count and the notes'`, and the field carries
the same `placeholder="1"` the three doors do, so the rule is visible rather than silent. Nothing moved
to the service: `InventoryItemSchema.quantity` is `z.number().int().positive()`, and that stays the
floor at both ends rather than a rule the UI keeps its own copy of. One implementation, one sentence —
`grep -rn "whole number of cutters" src` is a single hit, in `registerCutter.ts`.

**The app's own type (#330).** The desktop shell rendered in the fallback stack and said nothing about
it: `index.html` linked `fonts.googleapis.com` for #84's three families, and every response the server
sends carries `default-src 'self'` with no `font-src`, so the stylesheet was refused — visible only in
the console of a browser pointed at the shell, which is nobody's normal day. Option 2 of the issue,
chosen: **self-host the three families**. `public/fonts/` now holds one **variable** woff2 per family
from each project's own repository — Space Grotesk 49 256 B (300–700), Inter 352 240 B (100–900),
JetBrains Mono 113 672 B (100–800) — each with its `OFL.txt` beside it (all three SIL OFL 1.1, the
licence #180 settled for the engraving fonts) and a `fonts.css` declaring the three `@font-face` rules.
The two `preconnect`s and the CDN `<link>` are gone from `index.html`; the CSP is **unchanged**, since
`default-src 'self'` already covers this origin — that is the whole point of the option, and the reason
`server.rs`'s `CSP_HEADER` doc now says the stack is local by design and the two copies of the policy
must stay in step.

Two deviations from the brief, both deliberate. The brief put the rules in `src/styles/fonts.css`
imported by `index.css`, addressing the files as `url('fonts/<file>.woff2')`. A stylesheet inside the
bundle cannot relatively address `public/` — Vite resolves a relative `url()` against the importing CSS
file, not the page — so the rules live in `public/fonts/fonts.css`, linked from `index.html`
root-absolute. That the href survives the build was checked rather than assumed: Vite rewrites it with
`base` (`/casemaker/fonts/fonts.css` on the cPanel deploy) and leaves the *relative* woff2 URLs inside
it alone, so one file serves `/`, `/casemaker/` and `tauri://localhost`. And no comment was added beside
`tauri.conf.json`'s `csp` key, because JSON has none: the note went into `server.rs`'s `CSP_HEADER` doc,
where the second copy of the policy lives, and into `DESIGN.md`'s typography section, beside the #84
note the stack came from.

**Evidence.** `manageMode.spec.tsx` 26 tests, two of them #331's — the field's `placeholder` is `1`,
clearing it and saving PATCHes `quantity: 1`, `0` and `1.5` disable Save with the shared sentence in
`title`, and `3` restores `'Save the count and the notes'`. `qa-311-manage.mjs` ALL PASS with a new
block that clears the box against the running service and reads back the PATCH it sent: a browser gate,
because jsdom cannot show that a save re-reads and remounts the keyed `InventoryEditor`, so a `fill`
typed into the old node is discarded — the first run of that block timed out on exactly that, and the
script now waits for the field to settle before each save. `cnc-guide.md` and its mirror say the pair of
rules in one breath: a blank length means *unknown*, a blank **quantity** means one.

`cargo test`: **80 passed / 0 failed / 1 ignored**, one of them new — the shell serves `/fonts/fonts.css`
as `text/css` and the three woff2 as `font/woff2`, each with the policy header attached, and the
stylesheet it serves declares all three families with `url()` targets that are exactly those three
filenames. That last shape is what makes it evidence rather than decoration: `serve_asset` answers a
MISSING asset with `index.html` and **status 200**, so a misnamed font still "requests fine" and only
the content type separates a font from the SPA fallback. In a browser, the new `qa-330-fonts.mjs` ALL
PASS on both origins — the dev server on 5199 and the desktop shell on 5399 — where all three families
are `loaded`, each measures unlike a serif or monospace generic, nothing is requested from either Google
host, and a DOM walk names the app's own elements as the ones that draw them (`app-header__logo` Space
Grotesk, `html` Inter, `wb-card__print` JetBrains Mono). `qa-313-shell-cache.mjs` passes with **zero**
console errors, the exception it carried for the CSP refusal deleted rather than kept. `dist/fonts/`
carries the three woff2, the stylesheet and the three licences with the href rewritten, and nothing is
inlined: the only `wOF2` bytes in `dist/assets/*.js` are three.js's font-loader magic check. Full suite
**3376 passed / 4 skipped**; `typecheck`, `check:sim-gate` and `check:platform-gate` clean.

---

## 6. The geometry, ported

`make_badge.py` gets **ported into the app**, not called from it: Python is not in
the app toolchain, the Tauri shell has no interpreter, and this project's notes
already record a `python3` shim on one dev machine that reports wrong paths.

`engine/compiler/badge.ts` on the Profile IR, which already has what this needs —
`roundedRect(w, h, r)` is built from `pOffset` (`engine/compiler/profile.ts:77-85`):

- `badge-bottom` = `difference(extrude(outline, split), pocket)`
- `badge-top` = `translate([0, 0, split], extrude(outline, T − split))`

The script's 141 lines of hand-rolled triangle fans (`make_badge.py:45-83`) become
roughly 30 lines of IR.

**`samples/badge-blank/make_badge.py` stays where it is, untouched** — it is the
user's file. Its three existing output files are the one-time regression oracle:
compare bounding box and volume of the ported nodes against them.

Two gaps on the export side that V1 has to close:

- `buildModelXml` writes one object per mesh with **no extruder metadata**
  (`workers/export/threeMf.ts:32-62`). Two-colour export needs the
  `Slic3r_PE_model.config` sidecar that `make_badge.py:120-130` already writes.
- `meshNodesForExport` special-cases a single node id, `gasket`
  (`engine/exportTrigger.ts:84-111`). An optional `material?: { extruder?: number; fillDensity?: string }`
  on `BuildNode` (`engine/compiler/buildPlan.ts:43-46`) lets the gasket, the badge
  halves and every future part go through one path instead.

---

## 7. Depth: the model is the source of truth

Earlier revisions of this section argued twice, in opposite directions, about whether
cut depth should be referenced from the top face or derived from a measured total
thickness. Both arguments were wrong-headed, because both were *inferring* something
the app already knows exactly. The resolution, decided with the user:

> **The app loads the actual object. It knows where the pocket is and where the colour
> boundary sits, because it compiled them. Nothing about depth is inferred, measured or
> re-derived.** The machine's only job is to establish where the physical part sits
> relative to that model.

Everything below follows from that.

### 7.1 The layer stack — one structure, two answers

The app slices the compiled solid on **the printer's actual layer grid** (layer height
**and first-layer height** are inputs, recorded in the blank spec). The first layer
matters disproportionately here: after the flip (§7.2) it *is* the engraved face, and
the colour split sits only four or five layers above it. That single structure answers
both questions that matter:

- **Where does the colour change?** At the layer boundary where the extruder
  assignment changes. Not at the ideal design height — at the layer line the printer
  will really produce.
- **How deep can the cutter go at any point?** Descend the stack from the engraved
  face; a point is cuttable to depth *d* only if it is solid in **every** layer from
  the face down to *d*. The running intersection of cross-sections is the depth-limit
  map.

The magnet pocket needs no special case. It is a void in the solid, so the stack
reports a shallower limit over its footprint automatically — and so would any future
pocket, slot, or boss on any other part. There are no hand-coded keep-out rectangles
anywhere.

This is cheap: the cross-sections are Clipper2 `CrossSection` objects, the running
intersection is one `intersection` call per layer, and the badge is ~19 layers.

Why the layer grid rather than ideal dimensions: the badge's nominal top-colour band is
0.810 mm, which at 0.2 mm layers is layer 4.05. A slicer puts that boundary at 0.80 or
1.00 mm, and the difference is a large fraction of the usable depth range. Modelling the
grid removes the guess instead of budgeting for it.

### 7.2 Print orientation, and why it settles the Z reference

**The blank is printed flipped relative to `make_badge.py`'s authored orientation:
engraved face on the build plate, pocket opening upward.** No support, no bridging.

`make_badge.py` authors the pocket on the z = 0 face and ships its 3MF
identity-transformed (`make_badge.py:117`), so as exported it prints the wrong way up and
the user flips it by hand. The app's export should emit it print-ready — the
`PRINT_FLIP_NODE_IDS` machinery in `engine/exportTrigger.ts` already exists for this.

Consequences, and these are the ones that stop the argument:

- The **engraved face is the build-plate face**, so the colour boundary and pocket
  ceiling are at fixed layer counts *from the face the cutter touches*.
- The part's **total-thickness error accumulates at the back face**, which nothing
  references and nothing cuts.
- Therefore **cut depths are measured down from the probed engraved face, using the
  model's layer distances, and a thickness-deviant blank needs no compensation at all.**
  Total thickness is not an input to the job. Feeding it in would import far-side error
  into the cut.

Secondary benefits: a build-plate face is flatter and more dimensionally honest than a
top surface, it gives the probe a genuinely flat reference, and on smooth PEI it is
glossy — so the engrave reads matte-on-gloss.

**Two orientations, and they are opposite ways up.** The blank is *printed*
engraved-face-down — magnet hole facing up, away from the plate. It is *machined* the
other way up: **pocket-down in the nest, engraved face up to the cutter**, contacting
the nest floor on the annulus around the pocket (§7.6). Both are fixed, and the only
thing they share is that the engraved face is the reference in each. Conflating them is
what put a bridged-roof measurement into #165 that this blank does not have — printed
this way up, **no layer in the part is bridged**, and the 1.51 mm over the magnet pocket
is solid 100 %-infill material. What that membrane *does* have is nothing underneath it
while it is being cut.

### 7.3 Registration is derived from workholding, not fixed

**Decision 26, taken 2026-10-03, and it supersedes decision 23's single sequence.** The
first question is not "which edges do we probe" — it is **how is the part held?** A badge
in a printed nest, a plate under top clamps, a block in the low-profile vise and a cylinder
in the 4th-axis chuck are four different registration problems, and a hardcoded
edge-find sequence is only correct for one of them.

So **workholding is an explicit input to the model**, and the probing plan is **derived**
from it together with the part the app already compiled. The app knows the geometry because
it built it; given how the part is held, it can plan the probe itself rather than being
told where to touch.

```ts
type Workholding =
  // --- owned, in scope (confirmed 2026-10-03) ---
  | { kind: 'anchor-bracket'; anchor: 1 | 2; offset: Vec2 }   // native L-bracket
  | { kind: 'top-clamps';     clamps: { at: Vec2; footprint: Profile }[] }
  | { kind: 'vise';           jawFaces: [Plane, Plane]; jawHeight: Mm }
  | { kind: 'rotary-chuck';   jawDiameter: Mm; stickout: Mm }
  | { kind: 'tape-down';      contact: Profile; shim?: Profile }
  // --- status open: see "the fixture question" below ---
  | { kind: 'printed-nest';   nest: string; seatClearance: Mm };
  // NOT built: vacuum bed. Not owned, nobody has asked.
```

```ts
// A datum source is anything that reduces what the probe must resolve.
// The camera is one, with a coarse uncertainty and no Z at all.
interface DatumSource { fixes: ('x' | 'y' | 'rotation' | 'z')[]; uncertainty: Mm }
```

The variants above are the owned ones. The vacuum bed is deliberately absent — building a
variant for hardware nobody has is the speculative infrastructure this project has a
standing rule against. **The single source is now the `Workholding` union in
`src/engine/cnc/setup.ts`**, with this section and `/Simulation.md` §1.1 pointing at it; the
three no longer each carry their own copy (#191).

Each variant has to answer the same four questions, and that is the whole interface:

| | What the planner needs from it |
|---|---|
| **Reachable** | Which faces and edges a probe can touch without hitting the fixture |
| **Obstructed** | Clamp, jaw and bracket footprints, as keep-out profiles in the work frame |
| **Datum candidates** | What this fixture *already* establishes, and how well — the anchor bracket fixes XY to the bed; a vise fixes one face and rotation; a chuck fixes the axis; a nest fixes nothing but holds the part still |
| **Residual uncertainty** | What is left for the probe to resolve, with a number. A nest pocket cut at `+0.15` leaves ±0.15 mm of XY slop; a vise leaves essentially none across the jaws |

#### The camera is a coarse datum, and that is worth a lot

The machine has an integrated camera (§1). It cannot do the job of a probe and it should not
try to — but it slots into the planner as **another datum source with a stated
uncertainty**, which is a shape the model already has.

What coarse vision buys, in order of value:

1. **It makes a blind probe safe.** `G38.2` has to start from an assumed position and travel
   until it touches. If the assumption is wrong the probe either misses the part entirely or
   drives into it. A coarse fix beforehand turns a long blind travel into a short confident
   one — which is exactly the "smart search" this problem wants, and it matters most for the
   tape-down case, where there is no datum at all.
2. **It answers "is the part even there, roughly where I think?"** before any motion. That
   is a safety check nothing else in the plan provides.
3. **It seeds rotation**, well enough to decide whether rotation compensation is needed at
   all — which is the question that otherwise forces a two-touch edge find.

What it cannot do: supply final precision, and **it cannot give Z at all.** The engraved
face's height is what every cut depth references (§7.2), and a camera looking down cannot
measure it. Z stays probed, always.

**Unverified, and all of it load-bearing before any of the above is designed:**

- **The camera-to-machine transform** — position relative to the spindle, field of view,
  resolution, whether it looks straight down, lens distortion. Nothing found documents any
  of it. **But it does not need to be documented: we can measure it ourselves (#189.)** The
  maintainer's procedure is a target with identifiable features plus a machine-driven grid
  of snapshots, stitched, checking the offset at each location — which solves scale,
  rotation and distortion at once, and gives machine backlash and squareness free as the
  stitch's closure residual.
  The point that makes it sound: **the machine is the length standard, not the paper.** A
  commanded 50 mm move is a far better ruler than a desktop printer, which carries
  0.2–0.5 % scale error. The printed pattern supplies detectable features; the machine
  supplies distance. Two things #189 adds: stitching alone cannot give the
  **camera-to-spindle offset** (that needs one tie-point milled with the actual cutter), and
  **mm-per-pixel is a function of Z**, so it must be calibrated at more than one height.
- ~~Whether Studio exposes camera-based origin setting for the Z1.~~ **Answered
  2026-10-03: it does not. The camera view is a monitoring feed — no crosshair, no
  origin-setting overlay.** So there is nothing to lean on and nothing to imitate: vision
  registration is entirely ours to build (#189), and it is a capability Studio has the
  hardware for and does not use.
- **Whether the stream is reachable by anything but Studio and the mobile app.** **Answered
  2026-10-08: yes.** It is a plain WebSocket on the machine's own ESP32 camera module,
  `ws://<host>:82/ws_video`, that sends 640 × 480 JPEG frames at ~10/s after a `start_stream` text
  message; `/Z1-Bridge-Protocol.md` §10 has the record and `tools/z1/z1.mjs camera` captures it.
  No raw socket is needed, so only the https web build is kept out (mixed content), not the desktop.

**So for V1 the camera contributes nothing to registration.** Studio will not position with
it, reading the stream needs raw sockets the web build does not have (§5.7, #181), and the
calibration (#189) is bridge-era too. It belongs in the planner's *interface* now — a datum
source with an uncertainty — and in its implementation after the bridge. In V1 it is a
webcam you can watch.

#### What that means for V1's fixture, and a correction

With vision deferred, **the vise is the strongest V1 option**, and this document briefly
argued otherwise on the strength of a camera capability that turns out not to be available
yet. Setting it out plainly:

| Fixture | What V1 must do to register it | Depends on |
|---|---|---|
| **Vise on the anchor pins** | Set an origin, **touch Y**, probe Z. The jaws fix X and rotation; Y slides along the jaw | Documented Studio features, plus one Y touch and the vise dimensions nobody has measured |
| **Tape** | Probe X, **Y and rotation** blind | Whether Studio's work-origin dialog can do a two-point edge find **at all** — unknown (#187 item 1) |
| **Printed nest** | Same as tape, plus a print per part | Same unknown |

So the vise needs **the least** that is unverified — not nothing, as this document claimed
one revision ago. What survives, and it is the valuable part: **rotation is fixed
mechanically by the jaws**, so V1 never needs rotation compensation and the static-`.nc`
limitation (no variables in Smoothieware, hence no computed `G10 L2 P1`) stops mattering.
That is the real de-risking of #187 item 1. The Y datum and the jaw dimensions are a caliper
away.

Tape remains the better long-term answer — camera coarse, probe fine, shim for the
membrane, no fixture per part — and it is the one to revisit once #189 lands. The membrane
shim question is independent of all of this and #165 Row A settles it.

**The plan then falls out of geometry, not out of a rule.** Query the compiled solid for
candidate surfaces, score them, and emit the touches that resolve the residual:

- Prefer **long straight edges** — the badge's corners are R3.175 (`make_badge.py:23`) and a
  radiused corner is a poor datum, but that is a *consequence* of querying the outline, not
  a special case to hand-code.
- Reject any touch point inside an obstructed footprint, or on a face the fixture covers.
- Two touches on one straight edge give position **and rotation**; one on a perpendicular
  edge closes XY. Only emit them if the residual uncertainty justifies the cycle time.
- **Z is always probed** on the engraved face (§7.2), whatever the fixture. That is the
  datum every cut depth is measured from and no fixture can supply it.
- If the residual cannot be resolved by any reachable surface, **say so and refuse** rather
  than registering against something that is not a reference.

The point of decision 26 is that the plan is now an *output* of the model, so the vise and
rotary cases do not each need a new hand-written sequence.

#### The planner, as implemented (#188)

`src/engine/cnc/probePlan.ts` holds the derivation. It is pure and kernel-free — it takes the
compiled outline and the `Workholding`, and returns either a `ProbePlan` or a refusal. Nothing
under `src/` calls it yet; it is the engine the UI will drive, and its spec
(`tests/unit/cncProbePlan.spec.ts`) is the acceptance.

**Every variant answers the same four questions and nothing branches per case in the caller.**
What each one contributes, per axis:

| Workholding | Already fixed (datum) | Residual it leaves | Obstructions it adds |
|---|---|---|---|
| `anchor-bracket` | x, y, rotation | 0.05 mm | none modelled (the bracket envelope is a decision-28 input) |
| `vise` | x, rotation — the **fixed (left) jaw** | 0.05 mm; **y open** | one keep-out per jaw face, from the inward normal |
| `rotary-chuck` | x, y — the axis | 0.05 mm; rotation *inherently* closed for an axisymmetric part | none modelled |
| `tape-down` | **nothing** | all three open | none — nothing is above the part |
| `top-clamps` | **nothing** | all three open | one keep-out per clamp footprint |
| `printed-nest` | **nothing** — it holds the part still, it does not locate it | its `seatClearance` (the ±0.15 mm) | none |

The invariants that make the derivation honest:

- **Per-axis residual versus tolerance.** An axis is probed when what the fixture leaves open
  on it exceeds the job's tolerance. A nest whose `seatClearance` is already inside tolerance
  therefore yields **Z alone** — `touches: []`, `probeZ: true` — which is the ±0.15 mm badge
  case, and this is where #175 reads that number from rather than asserting a datum corner.
- **Rotation is probed only when the fixture leaves it open** and the part is not axisymmetric;
  when a fixture does fix it (the jaws, the bracket, the chuck's axis) the plan says so, and a
  static `.nc` never needs rotation compensation (§7.3, #187 item 1).
- **Z is always probed**, on the engraved face (§7.2) — no variant supplies it.
- **Refusal names the obstruction.** When no reachable straight edge can resolve an open axis,
  the plan refuses rather than returning a touch inside the fixture — with the clamp or jaw
  that is in the way named in the message.
- **Straight edges come from querying the outline**, so a radiused corner shortens the datum
  it belongs to (the badge's R3.175 corners leave ~31.75 mm of the 38.1 mm side) instead of
  being a special case.
- **Where Clipper2 is required, the planner says so.** The outline may be handed in as
  polygons (as the worker produces) or as a profile; a profile made only of point maths —
  rect, circle, translate, rotate, mirror — is evaluated in-module, while an offset or boolean
  node (a `roundedRect` is two nested offsets) returns `null` and the plan refuses with
  `no-outline`. Offsetting is not re-implemented here.

**Obstacles are measured, not looked up (decision 28).** The four questions above include
"what is obstructed", and the first draft of this section imagined answering it from the
fixture's catalogue dimensions — jaw height, clamp footprint. The maintainer's rule is that
this is wrong: a user may have discard material between the jaws, a spacer under the part, a
clamp from another kit. What the tool must not hit is therefore an **input with
provenance**, not a lookup: a shipped **default** envelope for known hardware (the Z1
low-profile vise, the anchor bracket), a **saved** envelope from a previous probe of *this*
setup, or a **fresh probe** — touch the tops and inner faces of whatever is holding the part.
It need not be probed every job: a default or a saved measurement is used until the setup
changes, and `source` + `uncertainty` say which it is, so the emulator never mistakes a
default for a measurement and the UI can offer "re-probe" when a clamp moved. The probe plan
thus has a second job besides registering the part: **mapping the fixture's clear envelope**
when asked.

#### The fixture question — decision 19 is open, and there are three candidates

Decision 19 said "workholding is a printed nest, and it is a V1 deliverable". Two cheaper
options exist, and the comparison is not what §7.6 and #175 assumed.

| | XY datum | Hold | Cost |
|---|---|---|---|
| **Double-sided tape** to the table | **none** — probe X, Y and rotation | Continuous around the whole footprint; nothing above the part at all | A strip of tape |
| **Low-profile vise** | **X and rotation only** — see below | Grips two opposite edges | Setup, nothing printed |
| **Printed nest** | none; ±0.15 mm of seat clearance | Surrounds the part; held down by tape on the annulus | A print per part, designed and iterated |

> **Correction, from the vise's own quick-start page.** This table said the vise fixes
> "XY and rotation, essentially no residual". It does not. The page states the **fixed jaw
> is the LEFT jaw**, with a movable jaw opposite — so the part is referenced in **X** and in
> **rotation**, and is free to **slide along the jaw in Y**. Y needs a touch or a mechanical
> stop. Three more facts from the same page, all of which bear on §1.2's fixture-as-obstacle
> check and none of which were accounted for:
>
> - **Slotted soft jaws by default, "suitable for thin workpieces"** — which is a point in
>   the vise's favour for a 3.81 mm badge, but the slot is a **lip over the top-face edge**:
>   an obstruction of unknown width, and its height against 3.81 mm decides whether the part
>   is located in Z or tilt at all.
> - **Jaw capacity is published nowhere.** The badge needs ≥ 38.1 mm across, or ≥ 76.2 mm
>   the other way.
> - Mounting is **two 4 × 11 mm locating pins and six M5×20 screws, and it requires removing
>   the MDF wasteboard** — so the vise and tape-down are mutually exclusive setups, not two
>   options you switch between freely. The fixed jaw's offset from Anchor 1 is also
>   unpublished, so "anchor-relative origin" does not locate the part without a touch.
>
> **This needs a caliper and one photograph, not more argument** (#191): capacity, jaw
> length, slot width/height/lip, and the fixed-jaw face to pin centres.

**Tape's Z error is smaller than this document first claimed — and what is left of it is a
tilt, not a thickness.** Tape is 0.1–0.2 mm thick and compresses unevenly. Cut depths come
from **probing the engraved face**, not from any assumed stack-up (§7.2), so decision 24 does
absorb the *thickness*: however far the tape squashes where the probe lands, that touch
defines the face. What it does **not** absorb is the **unevenness**. One Z touch is a *point*
datum. It fixes the face where the probe landed, and if the tape is 0.05 mm thinner under one
corner than another the part sits **tilted** about that point — so the commanded depth is exact
at the touch and off by (tilt × distance) everywhere else. A 0.1 mm spread corner to corner
is up to 0.1 mm of depth error at the far end of the part — 12 % of the badge's 0.810 mm
colour boundary (§7.1); 0.5 mm is more than half of it and moves a cut clean across the
boundary. **Nothing has measured which it is**, and no single
touch can: four
touches, one per corner, produce the number, and that is its own bench row —
`docs/bench/191-tape-tilt-run-sheet.md` (§7.6). Its other cost is the opposite end and is
already budgeted: tape supplies **no XY reference at all**, so X, Y and rotation must all be
probed. That is precisely the plan decision 26's planner derives, so it is work already
budgeted rather than a special case.

Tape goes on the **aluminium table** (the `3D Probe Rod` page calls it that) or a sacrificial
sheet on it — and on the annulus around the magnet recess, never across it.

#### Correction: the membrane is unsupported in *all three*

This document claimed the nest's advantage was backing the blank flat across its whole
area. **Working it through, that is false for this part.** The magnet pocket is a recess in
the badge's *bottom* face, and the badge is machined pocket-down, so the recess is an air
gap against whatever is underneath — nest floor, vise air, or table. §7.6 already says the
contact is "on the annulus around the pocket". So **no fixture backs the 1.51 mm membrane**
unless something fills the recess:

- a loose **shim** of the pocket's size, under tape or in the vise, or
- the printed **support pad** in the nest floor (#175's open question).

That makes membrane support an **independent axis**, not a reason to choose a fixture.
Which is what collapses the nest's case: strip that advantage away and it fixes nothing
positionally, needs a print per part, and is beaten by tape on simplicity and by the vise
on datum quality.

**#165 Row A measures how badly the unsupported membrane actually cuts**, so the shim
question is decidable with evidence. Decision 19 stays open until then rather than being
settled by argument.

**What this does not settle — see #187 item 1.** Whether the probing happens in our `.nc`
or in Studio's dialogs is still open, and the in-file route is constrained: Smoothieware has
no variables, so `G10 L2 P1` cannot take a computed offset and **rotation compensation is
impossible in a static file.** A derived *plan* can be executed interactively today and
emitted later when the bridge exists; the planner does not care which.

**Probe, revised 2026-10-08 (was "confirmed 2026-10-03": the separate Makera 3D Probe).**
The one in use is the **wired probe that ships with the machine.** The 2026-10-03 reading
rested on Makera's pages, which rate only the 3D Probe for non-conductive material; the bench
showed the wired probe is a *mechanical* touch tip — it registers on contact, conductive or
not — and it touched the PLA blank five times with a 0.001 mm slow spread and mapped the
blank's dome against the vise (`/Z1-Firmware-Dialect.md` §11.7–11.8, #293). So nothing is
unplugged for a touch-off, the 3D Probe is held in reserve, and the runbook's C4/A8 rows for
it are superseded. The *wireless* probe is a Carvera part, which is why `M491` and `T0`
reference it in the shared firmware and why Studio's control panel carries wireless-probe
charging voltages; there is none on this machine — and with tool 0 active, `M491` ends in
the wireless-probe check `ERROR: Probe dead or not set` (`/Z1-Firmware-Dialect.md` §11.9),
which is why a cutter must be registered as `T1` first.

### 7.4 What a V-bit does, and why V1 uses a flat end mill

**This section's arithmetic was wrong about the tools that exist, and the correction goes
the other way.** It modelled a V-bit as an ideal 60° point, `w = 2·d·tan(θ/2)`, giving a
0.94 mm minimum stroke at the 0.810 mm reveal depth and the conclusion that small text
"cannot change colour with a V-bit at any commanded depth".

Makera's **non-metal** engraving bits are **30° included (half angle 15°) with a flat tip
of 0.1–0.5 mm** — the 60° ones in the catalogue are the metal bits
(`/Makera-Parity.md` §3.1). A truncated cone, not a point, so:

```
w(d) = tipDiameter + 2·d·tan(halfAngle)
```

A 0.1 mm tip at 15° gives **0.534 mm** at d = 0.810, not 0.94 mm. Meanwhile the smallest
catalogued non-metal **flat** end mill is **1.0 mm**, which erases every stroke thinner
than 1.0 mm outright (§7.5). **On reach, the V-bit beats the flat end for small text.**

What survives, and what decision 14 now rests on: **a V-bit couples depth to stroke
width**, so a per-label depth control stops meaning what the UI says — it becomes a clamp
at best. "Depth controls colour" holds only for a **flat end mill pocketing the glyph
region**, where depth is genuinely independent. That is the honest reason for decision 14,
and V-carve stays V2.

**Measured — the guess is retired (#185).** `/docs/bench/185-font-opening.md`, regenerated by
`casemaker-app/scripts/font-opening-report.ts`, runs §7.5's opening over all six bundled
faces at cap heights 4/6/8/10/14 mm and reports two things: how much glyph area survives
each cutter, and — bisected per cell, not scaled — **the widest cutter each text tolerates**.

The guess's magnitude holds; its universality does not. A text tolerates
**⌀(0.07–0.18) mm per mm of cap height**, proportional to within 0.2 % across the five
sizes, so at 4 mm the answer runs from **⌀0.27 mm** (IBM Plex Serif regular — hairlines and
serifs) to **⌀0.70 mm** (IBM Plex Mono bold), with the app's own default, Barlow bold, at
**⌀0.69 mm**. Six faces, six answers; the word you type does not move the crossing, the face
does. The smallest flat end mill in the catalogue is ⌀1.0 mm — **1.4× wider than even the
most forgiving face allows at 4 mm.** So a 4 mm title with the flat end is not "loses thin
strokes", it is *erased*: 3.9 % of the glyph area opens, and C, S and E are gone whole. In
IBM Plex Serif regular not even a 14 mm title reaches the app's own 90 % legibility
threshold (84.4 %) — that face needs a cutter of its own.

**The V-bit's reach, measured.** At the 0.810 mm reveal depth the 30°/0.1 mm-tip V has an
effective radius of 0.267 mm, and a 4 mm title opened at 0.264 mm keeps **98.8 %** of its
area against the flat end's 3.9 %. The V does what the flat end cannot, and the ladder says
how far it goes: a 4 mm title survives a 30° V up to r = 0.318 mm (tip 0.1, d = 1.0) — three
rungs of #165's twelve — and a 6 mm title up to r = 0.518. That is a real but shallow reach,
and it is why decision 14 still holds: the coupling of depth to stroke width is untouched by
any of this, because the opening says only whether a stroke is *reachable*, never at what
floor.

Nothing above is a cut. What stands between this and a V `.nc`: `cuttingRadiusForSweep`
refuses every non-flat tool, `toolLibrary.ts` has no V-bit row, and `feeds.ts` is keyed to
flat end mills. The free half of #185 is this table; the bench half is a V-groove row in
#165.

### 7.5 Tool radius silently deletes glyph detail

With an end mill of radius *r*, the reachable region is the morphological **opening** of
the glyph: `offset(offset(G, −r), +r)`. Anything thinner than 2*r* vanishes; inside
corners get radius *r*. A 3.175 mm cutter engraves nothing legible at badge scale. A 1 mm
cutter handles a 10 mm **bold** name — 99.4 % of the glyph area opens — but only 62.2 % of a
10 mm one in IBM Plex Serif regular, and at 4 mm it erases a bold title outright (3.9 %,
with C, S and E gone whole). **The face moves the answer further than the size does**; §7.4
has the measured cutter each face tolerates.

Two `p-offset` nodes compute it today (`engine/compiler/profile.ts:116-123`), so the
viewport renders the **opened** region and colours engraved floors by which side of the
colour boundary they land on. The user sees the true result before cutting — the honest
default rather than a warning bolted onto a lie.

### 7.6 What is still physical, and therefore still unmeasured

The model settles geometry. These need the machine:

- **The Z chain across a tool change.** Probe fitted → hand swap → `M491` → cutter.
  Probe repeatability plus `M491` repeatability plus collet seating has never been
  quantified. #176 measures it by cutting a step and calipering it. **Two of the three
  terms measured 2026-10-08:** the wired probe's touch repeats to **0.001 mm** on the blank
  (`/Z1-Firmware-Dialect.md` §11.7) and `M491` to **0.001 mm** on the sensor (#208 C6).
  Collet seating — the probe out, the cutter in — is the term that remains, and #176's step
  cut is still what closes it.
- **Chatter over the pocket.** Engraving inside the pocket footprint cuts a ~1.5 mm
  membrane spanning an unsupported void. Expect deflection and poor finish there at
  *any* depth. The layer stack correctly permits the cut; it cannot predict the finish.
  #171 warns on overlap for this reason, separately from the depth limit.
- **Workholding.** A printed nest: badge outline offset `+0.15` via `p-offset`, flat
  floor, finger relief. The blank sits **pocket-down**, contacting on the annulus around
  the pocket — so tape goes on the annulus, never spanning the void.
- **The tilt under a taped blank.** A taped blank's residual Z error is not *thickness* —
  the Z probe absorbs that (§7.3) — but *tilt*: one touch is a point datum, and uneven tape
  compression tips the part about it, so the commanded depth drifts with distance from the
  touch. Nothing has measured whether that drift is a tenth of the badge's 0.810 mm colour
  boundary or half of it (§7.1), and it is the one live reason `G32` might come back (§9.1).
  Four corner touches size it:
  `docs/bench/191-tape-tilt-run-sheet.md`. #191 item 10.
- **PLA finish at 13 000 RPM.** A parameter table, not a design risk. #165 records it.

## 8. Safety constraints

- **Nothing is sent to the machine without an explicit go-ahead** — not even a
  status query.
- **Motion or spindle commands only with the user physically at the machine.**
- WSL2's NAT will likely block UDP discovery; test the bridge from Windows before
  concluding anything about the protocol.
- Demand-driven: **the Z1 only.** No driver plugin API until someone asks.

---

---

## 9. V1 — multi-font depth engraving on the printed blank

**The goal, concretely:** the user opens the badge template, places several text
labels each with its own font and its own engrave depth, exports a `.nc`, and ends
up holding a two-colour badge where the deep labels read in the bottom colour and
the shallow ones don't.

### 9.1 What V1 deliberately does not include

These are all agreed decisions. Deferring them is **sequencing, not reversal** —
each is recorded above and keeps its decision number.

| Deferred | Why it is not in V1 |
|---|---|
| **WiFi machine bridge** (decision 10) | Studio already uploads over WiFi. A protocol reverse-engineer plus a Windows-only dev loop on the critical path buys nothing a working `.nc` doesn't. |
| **`G32` autolevel** (decision 7) | §7.1 — in the **vise** it addresses the wrong error: the probe sets the depth window from the face, and a point datum is all a flat-part-on-flat-jaw needs. **For tape it is the right *shape* of tool and is not closed** (added 2026-10-07, #191 item 10): a taped blank's residual is a *tilt* (§7.3), a tilt is a height field, and `G32` samples exactly that — so it comes back **for taped setups only**, on the four-corner spread `docs/bench/191-tape-tilt-run-sheet.md` measures, and never as an input to the bed-referenced depth window (decision 12). Also re-add if **#176** shows warp matters after clamping in the nest. |
| **Heightmap/dexel engine** (decision 2) | Nothing in V1 is 3D. **#182** does exact 2.5D stock simulation with CSG, and **#174** re-parses the output — between them that is the stock check V1 actually needs, with no sampled grid. |
| **4th-axis fields in the IR** (decisions 3, 11) | Adding an `A` to a move record later is one line. Adding it now is a field nobody tests. **Confirmed by `/Rotary.md` R5** — A stays out of `Pos`/`commanded`/`values`; the three R-0 reservations (`ToolpathIR.frame`, the second `zDatum`, the cylinder WCS on the axis) are the recorded exception. |
| **Image methods** (decision 5) | V1 is text. |
| **Mesh import registry** (decision 6) | V1 is text; `assetImporter.ts` is fine as is. |
| **Feeds/speeds from `makera_library.db`** (§3) | **Corrected 2026-10-05:** the DB is a **prefill source for the tool inventory (#212), never the feeds source** — it has no PLA or PETG, no machine column, and 32 rows above the Z1's spindle ceiling. Hardcode the measured numbers from **#165**; read the DB only to prefill tool geometry. `/Makera-Parity.md` §14.5. **Corrected again 2026-10-08 (decision 32):** *"never the feeds source"* over-reached. All three facts stand, and they are exactly why the table cannot be a **source** — but the maintainer asked for it as a **catalogue tier below measurement**, clamped to the machine, with a measured row always winning. The honest scope, said plainly so nobody expects more: it is useful for **wood** (CNC-2, #209) and **cannot serve the badge job at all**, because PLA has no row in it. The old line is left standing rather than deleted because the three objections are still the reason the tier sits where it does. `/Makera-Parity.md` §5.1, #310. |
| **Multi-tool `M490.1/.2` handshake** | V1 jobs are single-tool. The probe→cutter swap happens before the job starts. |
| **V-carve** (§7.4) | V2. It is the thing that eventually gets small text to change colour, and it needs a medial-axis engine. |
| **`Project.kind` union** (decision 17) | §5.1 — not on the critical path, and the flags are already the derivation. |

> **One flag for the user.** The original brief asked the app to "ensure the blank
> material is correctly in the machine and start the milling". V1 as scoped here
> stops at a verified `.nc` that you upload through Studio. That is the single place
> this plan narrows the brief, and it is deliberate: it removes the riskiest,
> most environment-bound work from the path to a badge in hand. The bridge is the
> immediate follow-on, not a someday. Say the word and it moves back in.

### 9.2 The riskiest assumption, and the experiment that kills it first

**The assumption:** that engrave depth is a controllable scalar inside a sub-millimetre
band on *this* blank — i.e. that two-colour reveal is a depth-controlled deliverable at
all.

Three of the four reasons this document originally gave for doubting it have been
**retired**, by the print orientation (§7.2) and the 100 % infill premise (decision 13):
thickness error lands on the uncut back face, the engraved face is the flat build-plate
face, and no layer anywhere in the part is bridged. What is left is a shorter list, and
a different one:

- **The entire usable band sits inside the first few print layers.** The colour split is
  0.810 mm above the build plate — layer 4 or 5. So first-layer height and first-layer
  squish set the boundary, and elephant's foot distorts the one face the probe touches.
  This is the measurement #165 most needs, and it replaces the bridged-roof question.
- **The probe → hand swap → `M491` → cutter Z chain is unquantified** (§7.6). The band is
  sub-millimetre; the chain's error has never been measured against it.
- **The membrane over the magnet pocket is unsupported while it is cut** — 1.51 mm of
  solid material spanning a 45 × 13 mm void, because the blank is machined pocket-down
  (§7.2). Deflection and finish there are unpredictable at *any* depth, and that is a
  separate failure from breaking through.
- **PLA finish at 13 000 RPM** — a parameter table, not a design risk.

Every other depth decision hangs on this, and the usable band may be well under the
nominal 0.810 mm.

**It gets tested before a line of code is written.** If it fails, the fix is a *blank*
change — thicker top colour, split lower, 5 mm part, magnet moved — which is the
cheapest thing in this entire plan to change, and impossible to change cheaply once its
numbers are compiled into `badge.ts`.

### 9.3 Breakdown

Filed as GitHub issues; **#177** tracks them. `[P]` = prerequisite for the first
physical engraved badge, `[F]` = follows.

**Gates — nothing with a number in it gets written before these close:**

| | Issue |
|---|---|
| [P] | **#165** Depth-ladder experiment: measure the real engraving window (`bench-test`) |
| [P] | **#166** Blank print specification: thickness, split, infill, usable band |

**App side** (parallel with the fabrication side):

| | Issue |
|---|---|
| [P] | **#167** `case.badge` part type + `badge.ts` compiler (§5.1, §6) |
| [P] | **#178** Layer-stack model: colour boundary + depth limits from the solid (§7.1) |
| [P] | **#184** `MachineProfile` for the Z1: limits, capabilities, feed/speed clamping (§5.3) |
| [P] | **#168** Per-node material tag + two-volume 3MF export (§6) |
| [P] | **#169** Real glyph outlines, multi-font (§7.4) |
| [P] | **#170** Badge-face labels: per-label font and depth, two-colour viewport (decision 20) |
| [P] | **#171** Engravability check: tool-opened glyph, pocket breach block (§7.4) |

**Fabrication side:**

| | Issue |
|---|---|
| [P] | **#172** CAM core: contour-parallel pocketing → toolpath IR (§5.2) |
| [P] | **#173** Z1 post-processor: IR → `.nc`, bed-referenced Z, MKR header (§7.1, §2) |
| [P] | **#174** G-code verifier: parse our own output, refuse unsafe files |
| [P] | **#182** Toolpath simulation: sweep the selected tool, show the object before and after (§5.6) |

**Fixture, then the run:**

| | Issue |
|---|---|
| [P] | **#175** Printed nest fixture (§7.6) — any time after #167 |
| [P] | **#176** First cut: V1 acceptance + Z-chain error measurement (§7.6) (`bench-test`) |

**[F] Deferred**, each with its reasoning in §9.1: **#181** web/desktop build split
(prerequisite for the bridge, not for V1) ·
feeds/speeds from `makera_library.db` · WiFi bridge · `G32` option if #176 or the
taped-blank tilt (#191 item 10) justifies
it · V-carve · `Project.kind` · multi-tool jobs · importer registry · image methods ·
heightmap engine · 4th axis.

**#182 needs #174's parser, not #172** — it simulates the emitted `.nc` (`/Simulation.md`
§1), so parser, frame tests and sweeper can all be built and validated against Makera's own
sample files before our CAM core exists. It cross-checks #171 and #178 once those land, and
it is what makes the `.nc` trustworthy without cutting.

#165 and #166 gate everything numeric. **#178 gates #171 and #172** — both ask it for
depth limits rather than carrying rules of their own. **#174 no longer needs it gated**:
its deepest-cut check takes an injected `DepthLimit`, so CNC-2 passes `thickness − minFloor`
(wood has no layer stack) and the badge passes #178's `maxDepthAt`, the same verifier either
way (#174, rescoped 2026-10-03). #175 needs only #167. #176 needs all of them.

### 9.4 Still unverified

- **Is the Z1's `FuncSetting` ATC bit actually clear on this machine?** Everything in
  §2 about the manual-tool-change path depends on it, and it is inferred from
  `isATC=0` in Makera's database rather than read off the machine. `M499` dumps tool
  state and would likely show it. Not V1-blocking — V1 is single-tool.
- **Does `G32` apply compensation across long straight moves?** Stock Smoothieware only
  follows the map at segment endpoints unless `mm_per_line_segment` is set. Glyph loops
  are short segments, but the stem of an `I` is one long `G1`. Only matters if `G32`
  comes back into scope — and the taped-blank tilt (#191 item 10, §7.3) is now the one
  live reason it might, so this question stops being hypothetical the moment that row is
  run on a taped blank.
