# Makera Studio — capability parity review

Status as of 2026-10-03; §13 added 2026-10-04; §14 added 2026-10-05. Nothing here is
implemented; this document is the inventory and the gap list that `/Fabrication.md` plans
against.

**Why this document exists.** The brief changed: Case Maker's CNC side is no longer "get
one badge cut on one Z1", it is software other people will rely on. That makes Makera
Studio the benchmark — not as a model to copy, but as the capability surface a user
coming from it will expect, and as a worked example of what to do differently.

**Provenance rule, inherited from `/Fabrication.md` §1.** Studio and its data files are
shared across the Carvera, Carvera Air and Z1. Anything below that is Carvera-specific,
or that comes from Studio's shared UI, is marked as such. Z1 behaviour is only asserted
where a Z1 database row, the `MakeraInc/MakeraZ1Firmware` source or a `Z1/*` wiki page
confirms it.

**Data stays where it is.** Makera's feeds, tool catalogue and material list are their
data. This document records the *shape* of it and a few load-bearing facts about its
coverage. It does not copy the tables into this repo, and neither should the app —
§3 of `/Fabrication.md` says read at runtime.

---

## 1. Evidence base

Sections 2–10 were read from the local Studio 0.1.2.0 install; paths are written relative
to `%APPDATA%/MakeraStudio` and `%LOCALAPPDATA%/Programs/Makera Studio`. **§11 covers the
published documentation** — Makera's wiki and GitHub — including how to reach the Z1 wiki
pages at all, and the licence constraint that applies to their repos.

| Source | What it proves |
|---|---|
| `configure/*.json` (14 files, both the install copy and the user copy) | The full parameter shape of every strategy that ships with a default config |
| `makera_library.db` (SQLite, 21 tables) | Machines, the tool catalogue, the material list, and the feeds/speeds matrix |
| `GCodes/TopClamp.nc` (9 668 lines) | What Studio actually emits: header, motion vocabulary, program framing |
| `MakeraStudio.exe` string table | Class names for strategies and paths, including three with no config file |
| `data/lang/lang_us_EN.json` (239 strings) | The machine-control surface, not the CAM surface |
| Shipped DLLs | `dexeltool.dll`, `freetype.dll`, `assimp-vc143-mt.dll`, `libGLESV2.dll` |
| `logs/` (32 files) and `dmp/` (25 minidumps) | Observed failure modes, recorded as counts and verbatim messages |
| `docs/makera/CARVERA_EXAMPLES_2026.02.pdf` | 20 pages, **no text layer** — an image-only Carvera project gallery. No software-capability content, and Carvera-branded, so it informs nothing here |

**What this evidence cannot prove.** Config defaults are not a feature list: a parameter
that exists in JSON may be unreachable in the UI, and a class in the binary may be
unreleased. Where a capability rests only on a class name, it is marked **(binary only)**.

---

## 2. Strategies

Studio's operation type is an integer in each config's `type` field. The 14 shipped
configs cover every value from 0 to 14 **except 5**.

| `type` | Strategy | Config ships | Case Maker |
|---|---|---|---|
| 0 | 2D Pocket | yes | **V1** (#172) — the badge engrave is this |
| 1 | 2D Contour | yes | planned |
| 2 | 2D Drilling | yes | planned |
| 3 | Laser Image | yes | **never** — no laser module (decision 4; see §7) |
| 4 | Laser Vector | yes | **never** — same |
| **5** | **V-Carve (hypothesis)** | **no** | V2 (§7.4) |
| 6 | 3D Relief | yes | deferred (decision 2) |
| 7 | 3D Pocket | yes | deferred |
| 8 | 3D Contour | yes | deferred |
| 9 | 2D Thread mill | yes | not planned |
| 10 | 3D Drilling | yes | planned |
| 11 | Rotation Relief | yes | **designed in `/Rotary.md` (#235); class R of three** — our classes are W (wrap), I (indexed) and R (axis-crossing relief). Makera ship only R; W is the gap in the incumbent's offering. Decisions 3 and 11 stand; the design is what they were waiting for |
| 12 | 3D Thread mill | yes | not planned |
| 13 | 2D Chamfer | yes | planned |
| 14 | 3D Chamfer | yes | planned |

### 2.1 Three strategies with no config file

The binary's string table names path classes that `configure/` has no JSON for:

- **`AVVCarvePath` / `AVVCarvePathWgt`** — and the binary also contains the literal
  string **`VCarvePath.json`**, a file present in neither config directory. It has a
  UI widget class, so it is a user-facing operation, and `5` is the only gap in the
  2D block of the type enum. **Hypothesis: V-carve is type 5, and its default config
  is missing from the 0.1.2.0 install.** This matters twice over: V-carve is what
  eventually gets small text to change colour (§7.4), and if Studio's own V-carve is
  unconfigured, our V2 is not catching up to anything.
- **`AVRotationVReliefPath`** (binary only, no widget) — V-carving on the 4th axis.
- **`AVKnifePath`** (binary only, no widget) — a drag-knife path. No Makera drag knife
  is listed in the tool catalogue, so this is likely unreleased.

Also present, with no shipped config: `AVCustom3DStrategy`, `AVCustom4DStrategy`,
`AVRelief4DStrategy`, `AVReliefFinishingToolStrategy`, `AVPolyPath`, `AVCutterPath`.

---

## 3. The tool model

`t_MakeraCutterList` holds 129 catalogued cutters in 16 groups. A tool's identity is
`cutterCategoryId`, which is the same integer the config files call `toolType`.

| id | Category | Catalogued | Geometry that defines it |
|---|---|---|---|
| 0 | Ball Nose | 18 | tip diameter (sphere radius = tip/2) |
| 1 | Flat End | 45 (incl. 20 "Corn Bits") | tip diameter, corner radius |
| 2 | Chamfer | 3 | 90° included, tip offset |
| 3 | Engraving (V) | 22 | **flat tip diameter + half angle** |
| **4** | **Bull Nose (hypothesis)** | **0** | corner radius — `Bull Nose` / `Bull_Nose` appear in the binary, and 4 is the only gap |
| 5 | Drill | 30 | drill diameter, point angle |
| 6 | Thread mill | 8 | pitch, thread angle, thread spec |
| 7 | Ball Nose Engraving | 3 | tip diameter + half angle |

The per-operation tool record carries 26 fields: `angle`, `coolant`, `cornerRadius`,
`diameter`, `drillDiameter`, `feedrate`, `fluteLength`, `halfAngle`, `handleDiameter`,
`matelDuty`, `materialPropertyId`, `pitch`, `plungeFeedrate`, `shoulderLength`,
`spindleSpeed`, `stepDown`, `stepOver` (%), `stepOverMM`, `stickoutLength`,
`threadAngle`, `threadSpecification`, `tipDiameter`, `toolName`, `toolNumber`,
`toolType`, plus ids. **This is the tool model to match**, because the `.nc` header
carries most of it and therefore so must any file we read back (§6).

### 3.1 A finding that corrects `/Fabrication.md` §7.4

§7.4 argues V1 cannot use a V-bit by modelling it as an ideal 60° point:
`w = 2·d·tan(θ/2)`, giving a 0.94 mm minimum stroke at the 0.810 mm reveal depth.

**Makera's non-metal engraving bits are not 60° and not pointed.** The catalogue's
non-metal V-bits are **30° included (half angle 15°) with a flat tip of 0.1–0.5 mm**;
the 60° half-angle-30° bits in the catalogue are the metal ones. The correct width is

```
w(d) = tipDiameter + 2·d·tan(halfAngle)
```

which for a 0.1 mm tip at 15° gives **0.534 mm** at d = 0.810 — not 0.94 mm.

Meanwhile the smallest catalogued non-metal **flat** end mill is **1.0 mm**, and a 1.0 mm
cutter erases every stroke thinner than 1.0 mm outright (§7.5's morphological opening).

**So on reach, the V-bit beats the flat end for small text — the opposite of what §7.4
implies.** Decision 14's *other* argument is untouched: with a V-bit, depth and stroke
width are coupled, so a per-label depth control stops meaning what the UI says. That is
still a good reason to cut V1 with a flat end mill. But the arithmetic in §7.4 is wrong
about the tools that exist, and the conclusion should rest on the honest reason.

**Not resolved here, because it needs a measurement, not an argument:** §7.4's "a 4 mm
cap-height title has a stroke around 0.5 mm" is a guess. Run §7.5's opening over the
bundled fonts at r = 0.5 (1 mm flat) and at the V-bit's effective radius and report
which strokes survive. If the user owns a 30° bit, one extra V-groove row in #165
settles it on the same afternoon.

---

## 4. Shared operation parameters

These recur across strategies and are the real parity surface — more so than the
strategy names, because they are what makes an operation usable.

| Group | Fields | Case Maker |
|---|---|---|
| **Depth** | `startDepth`, `endDepth`, `stepDown` (on tool), `finishStepDown`, `enablelastlayer` | V1 needs start/end/stepDown; finishing pass later |
| **Clearance** | `safeZ`, `startX/Y/Z`, `bEnableStartPosition` | **V1** (#173) |
| **Ramping** | `useRamping`, `rampingType`, `angle`, `rampingZ`, `rampingdistance` | **refused for now, with a reopen gate** — §14.4 R16. V1 plunges, and a plunge is what the sweep simulates exactly |
| **Tabs / bridges** | `supportTabs`, `tabsDistance`, `tabsHeight`, `tabsLayout`, `tabsShape`, `tabsWidth` (2D/3D Contour only) | **#218** (CNC-2.1) — needed the moment we cut parts free |
| **Stock to leave** | `radial_allowance`, `axial_allowance`, `machining_allowance`, `finshing[]` *(sic)* | milestone material, gated on #209's finish — §14.3 M3 |
| **Pocket shape** | `pocket_strategy`, `path_direction`, `direction`, `parallel_angle`, `position_offset`, `toolcontainment` | **V1** needs contour-parallel; the rest planned |
| **Contour side** | `contourPosition`, `offset`, `workDirection` | planned |
| **Peck drilling** | `retract_distance`, `retract_position`, `retract_z` | planned with drilling |
| **Coolant / air** | `coolant` on the tool; `M7`/`M9` in output | **V1** (#173) |
| **Operation list** | `pathName`, `pathOrder`, `groupid`, `showstate`, `selectedmeshes` | needed for multi-op jobs |
| **Thread milling** | `pitch`, `threadDiameter`, `holeScrew`, included angle, inside/outside, hand, layered passes | not planned |

Several thread-mill fields are named in pinyin (`luoJu` pitch, `jiaJiao` included angle,
`zuoXuan` left-hand, `fenCengJiaGong` layered machining, `fencengshu` layer count,
`hangJu` row spacing). Recorded so a future reader of a Studio project file is not stuck.

---

## 5. Stock, materials and feeds

- **Stock**: `STOCK|id=cuboid|length|width|height|diameter`. The `diameter` field implies
  a cylinder stock type for rotary work. Case Maker: cuboid in V1. Makera's CAM asks for the
  stock **shape — Square or Round — at project setup** (`/Rotary.md` §1.3), which is where the
  `diameter` field comes from; **we have never seen a `;@MKR|STOCK` record for round stock**,
  so the field order and whether `length/width/height` are still written beside `diameter` are
  both unverified. A rotary job's `STOCK` record is a thing to capture at the bench (#238)
  before the post writes one.
- **Materials**: `t_MaterialList` has **15** entries — PCB, 6061 and 7075 aluminium,
  Bakelite, Delrin, Brass, Carbon Fiber, Acrylic, Polycarbonate, Copper, Epoxy Tooling,
  Synthetic Stone, ABS, Hardwood, Softwood. `t_MaterialSpecs` adds 189 purchasable stock
  sizes.
- **Feeds**: `t_MakeraCutterProperties`, 1 328 rows keyed material × cutter, giving
  spindle speed, feed, plunge feed, step-down, step-over (% and mm) and coolant.
- **Customisation**: `t_Custom*` and `t_Customer*` tables exist for user tools, groups,
  properties, materials and specs. All are **empty** in this install, so the schema
  supports user-defined tooling but nothing here shows the UI for it.

### 5.1 Three facts about that data that change our plan

1. **There is no PLA and no PETG.** No row in `t_MaterialList` matches PLA, PETG, nylon
   or a generic "plastic". V1's blank is PLA. So Studio's feeds table **has no row for
   the material of our first job**, and `/Fabrication.md` §9.1's "hardcode the measured
   numbers from #165" is not a shortcut — for PLA it is the only source. Reading the DB
   can never answer it.
2. **For small non-metal flat ends, the 1 328-row matrix is barely differentiated.**
   Across the catalogued non-metal flat ends of 2 mm and under, the (speed, feed, plunge,
   step-down, step-over) tuples collapse to **two** distinct values — the second differing
   only in step-down, for softwood. A table that looks per-material is, in this corner,
   one row with exceptions. (Stated only for that corner; the whole table was not
   characterised.)
3. **The feeds are not machine-aware.** `t_MakeraCutterProperties` has no machine column,
   and **32 rows specify a spindle speed above the Z1's 13 000 RPM maximum** — correct for
   a Carvera, impossible on a Z1. Any app reading this table must clamp to the selected
   machine's limits itself. Max feed in the table is 1 200 mm/min, which happens to equal
   the Z1's ceiling exactly, so feed never exceeds it — by coincidence, not by design.

---

## 6. Output format

From `GCodes/TopClamp.nc`, which is a Z1 job (`MACHINE|id=Z1`):

- **Header**: `;@MKR|` comment block — `BEGIN`, `SCHEMA|v=1.0.0`, `MACHINE`, `MATERIAL`,
  `STOCK`, `ORIGIN`, `CAM`, `UNIT`, one `TOOL` per tool, `TIME|seconds=`, one `TOOLPATH`
  per operation, `END`. Then `G90 G21`, then `;@MKR|TOOLPATH_START|toolpath_number=` before
  each operation. A base64 PNG thumbnail is appended after `M02` inside
  `;(thumbnail_image_begin)`.
- **The `TOOL` line carries full geometry**: number, id, name, `type` as a human string
  ("Flat End"), handle diameter, stickout, shoulder, flute, diameter, tip diameter, corner
  radius, angle, half angle. **This is what makes a `.nc` self-describing enough to
  simulate** — see `/Simulation.md`.
- **Motion vocabulary is tiny.** This file is 9 607 `G1` and 25 `G0`, and **no arcs at
  all** — no `G2`/`G3`, no `G91`, no cutter compensation, no canned drill cycles. Studio
  linearises everything.
- **Program framing**: `T1 M6`, `M7`, `S<rpm> M3`, … `G0 Z15`, `M9`, `M05`, `G28`, `M02`.
- **No `G54` and no `G10`.** The file assumes the work coordinate system was already set
  by Studio's own probing workflow. Anything we emit has to either set it explicitly or
  document the same assumption — and our parser has to accept a file that doesn't.
- **But `TopClamp.nc` is not representative**, and writing a parser against it alone would
  be a mistake. §11.4 lists what the other 25 vendor sample files actually contain.

### 6.1 `ORIGIN` semantics — a hypothesis, not a fact

The sample reads `ORIGIN|id=0|type_name=topFrontLeft|x=-50|y=-50|z=2.5` on a
100 × 100 × 5 stock, and its cutting moves run X 10→70, Y ≈ 6, Z +1 → −0.2.

That is consistent with: **the work origin is the stock's top-front-left corner, X and Y
run positive into the stock, Z = 0 is the stock's top face, and `ORIGIN x/y/z` states the
origin's position in a stock-centred frame** (front = −Y). It is *not* consistent with the
origin being at the stock centre.

**One sample, and its stock is square**, so this cannot distinguish `length`→X from
`length`→Y. Studio's #165 job on the 76.2 × 38.1 badge disambiguates it in one file;
that is now part of #165's side-quest.

---

## 7. The machine-control surface

From `data/lang/lang_us_EN.json` (239 strings — Studio's shared controller UI, so
**some of this is Carvera-only**): toggles for spindle, spindle fan, vacuum, power fan,
laser, external output, light, air, tool-sensor power, probe laser, wireless-probe
charging and anti-static; probe fast/slow/return speeds, probe height and max travel;
rotary module X/Y/Z offsets, max A speed and acceleration; laser power limits and a
"Laser Clustering" workaround.

> **The "rotary module X/Y/Z offsets" strings are the module's datum**, and the wiki says that
> datum is *preset*: *"The 4th-axis zero point is preset in the software at the center of the
> right edge of the spindle"* (`/Rotary.md` §1.4). So those three strings are what a fitted
> module would write, and whether the preset is good enough to use as a `fixture` source or has
> to be probed at every mounting is **#238's measurement**, not a reading we can take from the
> string list.

Relevant only to the deferred bridge (`/Fabrication.md` §5.7). It is recorded here because
it is the surface a bridge would have to cover, and because it shows how much of Studio's
control panel is for hardware this machine does not have.

---

## 8. Where Studio is weak

Recorded as counts and verbatim strings. These are the reasons the user is building this,
and each one is a thing our own design has to not do.

**Observed failures in this install**

- **25 minidumps in `dmp/`, 32 session logs, and all 25 crashing sessions end with the
  same two lines**: `Qt has caught an exception thrown from an event handler.` followed by
  `QPaintDevice: Cannot destroy paint device that is being painted`.
- The 3D view's GL context fails on this machine: `Failed to load libEGL (The specified
  module could not be found.)`, `QWindowsEGLStaticContext::create: Failed to load and
  resolve libEGL functions`, `composeAndFlush: QOpenGLContext creation failed`,
  `composeAndFlush: makeCurrent() failed`.
- `ERROR::FREETYPE: Failed to load font` — in the subsystem that draws text, which is
  precisely V1's feature.
- `QObject::connect(OperationDetailsCfgWorkOriginDlg, Unknown): invalid null parameter`,
  and the same for `OperationDetailsCfgZProbeDlg` and `OperationDetailsCfgAutoLevelingDlg`
  — the three dialogs that establish **where the part is**.
- `QWidget::setMinimumSize`/`setMaximumSize` warnings on `ObjectDlg`.
- The install needed local binary patching to run at all; `MakeraStudio.exe.orig` sits
  beside the patched binary (`/Fabrication.md` §3).

**Data integrity in Studio's own persisted files**

- `coolant: -858993460` in both thread configs. That is `0xCCCCCCCC` read as a signed
  int — the MSVC debug fill pattern for uninitialised stack memory.
- `-9.255963134931783e+61` appears as `finishStepDown`, `stepOverMM` and `endDepth`
  across six configs; `finishStepDown: 4.272676737487e-312` (a denormal) appears in a
  seventh. These are uninitialised doubles written out as settings.
- `startDepth: 13.75` on a 3D chamfer default, and `endDepth: 23.8` on 3D drilling —
  stale values from whatever part was last open, shipped as defaults.
- A field is spelled `finshing` in `Pocket3DPath.json` and `finishing` in
  `Relief3DPath.json`; `enablestartpoition` in one file, `enablestartposition` in others.
- `VCarvePath.json` is referenced by the binary and ships in neither config directory.

**Documentation**

- The published supported-codes table is written for the Carvera and misdescribes the Z1
  (`/Fabrication.md` §2); `safety_limits.json` states a 24 000 RPM ceiling for a 13 000 RPM
  spindle; Z1 wiki pages are absent from `sitemap.xml`.

### 8.1 What that implies for our design

Not a list of grievances — a list of requirements:

1. **Never trust a persisted number.** Every value loaded from a project file, a template
   or a machine profile is validated and range-checked against the machine before it
   reaches geometry. A NaN, a denormal or an out-of-range feed is rejected loudly, not
   written into a toolpath. This is what #174 is for, and it should apply on *load* too.
2. **Clamp to the selected machine.** Feed, spindle, travel and depth limits come from the
   machine, not from the tool table (§5.1 item 3).
3. **The viewport must not be able to take the app down.** Studio's crash signature is a
   paint-time exception. Our geometry already runs in a worker; keep render failure
   non-fatal and keep the app usable with the 3D view broken.
4. **Simulate, and show it.** Studio ships a dexel simulator (`dexeltool.dll`) but the
   workflow still ends in "upload and find out". `/Simulation.md` makes before/after the
   thing you look at before you cut.
5. **One spelling, one place.** Our equivalents of `finshing`/`finishing` are a TypeScript
   union and a Zod schema, and the schema strips unknown keys — which turns this class of
   typo into a load-time failure instead of a silently ignored setting.

---

## 9. Where Case Maker is already ahead

Worth stating, because parity is not the whole goal:

- **Parametric parts, not just toolpaths.** Studio takes a model and cuts it. Case Maker
  *generates* the model from a spec, and the CAM reads the compiler's own profiles and
  depths rather than re-inferring them from a mesh (`/Fabrication.md` §5.2).
- **Exact geometry.** Profiles are Clipper2 cross-sections and solids are Manifold; the
  depth-limit map is an exact CSG result (#178), not a sampled grid.
- **Runs in a browser.** No install, no libEGL.
- **Real glyph outlines with a multi-font registry** already shipped (#169), in the
  subsystem whose Studio counterpart logs a font-loading failure.
- **Text, boards and enclosures are first-class**, which is the actual job; Studio is a
  general CAM front end with no notion of the part.
- **The camera is unused for metrology.** The Z1 has an integrated camera and Studio shows
  it as a **monitoring feed only** — no crosshair, no origin-setting overlay (confirmed by
  the maintainer, 2026-10-03). Calibrating it (#189) and using it to find the part before
  probing is a capability the hardware already supports and the vendor's own software does
  not offer. That is not parity; it is an advantage available for the taking.

---

## 10. What the new brief reopens

"Thousands of people" invalidates premises that were sound for one user with one machine.
These are flagged, not decided:

| Decision | Premised on | Status now |
|---|---|---|
| **Decision 4** — no laser, ever | *this* machine has no laser module | **Resolved 2026-10-03:** still out of scope — no laser strategies get written — but it becomes a **capability flag on the `MachineProfile`** (#184) rather than an assumption in the code. |
| **§8** — "the Z1 only. No driver plugin API until someone asks" | one machine | **Resolved 2026-10-03:** support stays Z1-only, but the `MachineProfile` seam gets built now (decision 25, #184) so a second machine is configuration rather than a refactor. No driver plugin API. |
| **§5.3** — one `Z1` constant until a second CNC exists | one machine | **Overridden 2026-10-03** — the profile is in V1 (#184). Carvera and Carvera Air are already rows in the same database, so its shape is known. |
| **Demand-driven features** (`feedback_demand_driven_features`) | a single-user tool | Still right about *speculative infrastructure*; weaker about capabilities a Studio user already has and will immediately miss (tabs, ramping, stock-to-leave). |
| **V-carve deferred to V2** | §7.4's 60°-point arithmetic | §3.1 — the arithmetic was wrong about the available tools. Still defer, for the depth-coupling reason, but say so honestly. |

**Answered, 2026-10-03.** Parity means **Studio's full capability set on the Z1** — the
first reading, which is how the matrix above is written. No Carvera, no Carvera Air, no
laser strategies. But the **`MachineProfile` gets built now** (decision 25, #184) rather
than deferred, so that adding a machine later is configuration instead of a refactor, and
so that machine limits have somewhere to be clamped from day one (§5.1 item 3).

**Refreshed 2026-10-04.** #228's multi-vendor study has landed; **§13** folds in what it
says about the machine-profile abstraction. It does **not** change this answer — the scope
stays Z1-only, and the study is evidence *for* that. What it adds: the `MachineProfile`
*type* must be shaped for a field wider than a 3-axis mill, and the gap list re-orders
toward "the machine knowing itself". Read §13 before treating §10 as settled.

**Refreshed 2026-10-05.** **§14** reads the whole study against the roadmap (#236): what to
act on, what deserves a milestone, what is refused on the record, and which numbered
decisions in `/Fabrication.md` the evidence now argues against. The scope answer is still
unchanged.

---

## 11. Documentation sources

Found 2026-10-03. The Z1 wiki pages are **absent from `sitemap.xml`** (`/Fabrication.md`
§2), so they are reachable only via the wiki.js GraphQL page list:

```
curl -X POST https://wiki.makera.com/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{pages{list(locale:\"en\"){id path title}}}"}'
```

That returns **100 pages**, of which **9 are Z1**. Fetch the rendered HTML with a browser
User-Agent; `single(id:)` content needs auth, the rendered page does not.

| Page | Worth reading for |
|---|---|
| `Z1/QuickStart` | **The actual manual.** Safety, tool change, the anchor workholding system, all three probes, bit collars, collet change, WiFi/Bluetooth setup, and the first-job walkthrough |
| `Z1/Manual` | An index of anchors into `Z1/QuickStart` — little content of its own |
| `Z1/new-page/Maintenance` | Maintenance, almost entirely as YouTube links. Note the unguessable path |
| `Z1/Accessories` + `/4Axis`, `/4Axis/HRG`, `/Ionizer`, `/Low-Profile-Vise`, `/VacuumBed` | The five accessory quick-starts |
| `Makera-Accessories/Makera-3D-Probe` | The probe that handles non-conductive material — **not** the 3D Probe Rod |
| `Makera-Accessories/Engraving-Module` | Despite the name this is the **laser** module ("connect the laser module cable", "wear laser safety goggles") |
| `speeds-and-feeds` | Big table, organised by bit rather than material. Has a "Plastic" column and a "Woods & Plastics" group, **but still no PLA or PETG row** — consistent with §5.1 |
| `software/MakeraCAM_userguide`, `_Intro`, `_tutorials` | Makera's own CAM documentation — the user-facing counterpart to §2's strategy list |
| `software/vcarve-desktop`, `fusion360`, `LightBurn`, and 7 more | Which third-party CAM is supported, and how |
| `supported-codes` | Carvera-written; see `/Fabrication.md` §2 |

### 11.1 GitHub, and a licence trap

| Repo | Licence | Contents |
|---|---|---|
| `MakeraInc/MakeraZ1Firmware` | — | Smoothieware fork; already §2's authority |
| `MakeraInc/CarveraController` | **GPL-3.0** | The official client. `src/` holds `WIFIStream.py`, `USBStream.py`, `XMODEM.py`, `CNC.py`, `Controller.py` — **the whole machine protocol, published** |
| `MakeraInc/CarveraProfiles` | **none (all rights reserved)** | Post-processors for **13** CAM packages, machine design files, sample `.nc`, a kiri:moto tool database |
| `MakeraInc/MakeraCAM` | — | README only; an issue tracker, not source |

> **Case Maker is Apache-2.0.** GPL-3.0 code cannot be copied or adapted in, and an
> unlicensed repo is all-rights-reserved. Protocol and format *facts* are
> interoperability information and fine to reimplement; **files, code and comments are
> not.** `/Fabrication.md` §5.7 states the rule for the bridge.

**Z1-specific assets in `CarveraProfiles`** (everything else there is Carvera-named, so
the provenance rule applies):

- `CAM_Post_Processors/Freecad/26PostProcesssor_Machine/Makera_Z1.fcm` — a small JSON
  machine definition, and the most useful single file found. It independently confirms
  X 0–200, Y 0–200, Z 0–100, and adds: the kinematic chain (Y is the table; X and Z are
  the head, Z parented to X; A is a table rotary parented to Y), `axis_precision: 3` and
  `feed_precision: 2` for output formatting, `split_arcs: false` (**the controller takes
  arcs**), `translate_drill_cycles: true` (**it does not take canned cycles**),
  `xy_before_z_after_tool_change: true`, and `dwo_supported: false` / `tcp_supported: false`.
- `Machine_Design_Files/Makera-Z1_MDF-v2.1.dxf` and `.STEP` — **the Z1's bed plate**. This
  is the primary source for where a fixture can actually be clamped and where the anchor
  pins sit, which #175 currently guesses at.
- `Machine_Design_Files/Makera-Z1_Simplified_4Axis.step` — machine model.
- `Sample_Files/NefertitiFinish.nc` — a **second** sample `.nc`, and a 3D finishing job, so
  a much harsher parser and simulator test case than `TopClamp.nc`.

### 11.1.1 A corpus of 25 vendor reference `.nc` files

`CarveraController/src/gcodes/Examples/` holds the machine's built-in examples — the ones
`Z1/QuickStart` means by "File Storage → Examples". They span every strategy family, which
no other source here does:

| Directory | Files | Useful as |
|---|---|---|
| `LED/` | 10 — ABS, 5× acrylic, aluminium, 3× PCB | Real 2.5D and engraving jobs across materials |
| `Laser/` | `AudreyHepburn.nc` (2.8 MB), small variant | A file our parser must **refuse**, not mis-simulate |
| `Relief/` | `PirateShip.nc` (2.8 MB) | Dense 3D relief — the dexel case (§4.5 of `/Simulation.md`) |
| `Rotation/` | `NefertitiFinish.nc` (2.6 MB), `NefertitiRough.nc` | **A-axis motion**, measured 2026-10-05 (`/Rotary.md` §1.1). Rough: 5 063 moves, a helix — X and A interpolate in 3 885 of 4 547 cuts. Finish: 100 519 moves, **Z and A interpolate in 89 198** of them. **Y is 0 throughout in both** — the tool stays over the axis, and that, not "A never interpolates", is the real constraint. **Z is referenced to the rotary axis** (radius, not depth below a face) and reaches **−5.00** in the finish file, i.e. it crosses the axis. A is unwound to **−153 720°** and reset with `G92.4A0S0`. Distinct files despite matching byte counts; `Tests/4th-test-air.nc` is byte-identical to the rough file but for `T6M6` |
| `Tests/` | 10, from **53 bytes** up | Tiny, hand-sized parser fixtures |

The `Tests/` files are the most immediately useful thing found all session: `atc-test.nc`
is 75 bytes, `goto-pack-pos.nc` is 53, `flatness-test-air.nc` is 215. Also
`Makerables`' official tutorials include **"Makera Badge — 2D Pattern"**, which is
this project's job almost exactly.

### 11.1.2 What those files prove about the dialect

Reading three of the tiny ones overturns several things inferred from `TopClamp.nc`:

- **`T1M6` with no space.** `atc-test.nc` is `T0M6` through `T6M6`. A whitespace-token
  parser breaks here; **parse G-code words, not tokens.**
- **`M06` and `M03`, not just `M6` and `M3`.** Both spellings appear.
- **`G53` machine-coordinate moves are real and used.** `goto-pack-pos.nc` is nothing but
  `G90 G0 G53 Z-3` / `G53 X-295 Y-205`. (Those coordinates are a Carvera envelope.)
- **`G54` *is* emitted by some files**, and `G17` plane selection appears, so §6's
  observation is about `TopClamp.nc` specifically and not about Makera files generally.
- **Parenthesis comments**, `(OCT- 8-2024-3:01:33PM)`, alongside Studio's `;` form. And
  `T1 M06()` — an empty comment immediately after the word.
- **Trailing-decimal numbers**, `DIA 6.`, which a naive float parser rejects.
- **Non-G-code console lines.** `atc-test.nc` opens with `echo ATC TEST Start...`. A parser
  must tolerate lines that are not G-code at all.

Every one of those is a cheap test case and an expensive surprise. #174 now carries them.

### 11.2 The 6000-vs-1200 velocity discrepancy — resolved

`Makera_Z1.fcm` gives `max_velocity: 6000` on X, Y and Z; `t_MachineType` gives
`maxFeedRate: 1200`. **They measure different things, and the question turns out not to
matter.**

**Smoothieware keeps cutting feed and rapid traverse as separate limits.** The firmware's
own config (`src/configZ1.default`) names them explicitly:

```
#default_feed_rate   1000   # Default speed (mm/minute) for G1/G2/G3 moves
#default_seek_rate   3000   # Default speed (mm/minute) for G0 moves
#x_axis_max_speed    4000   # Maximum speed in mm/min        <- the axis ceiling, caps both
```

So `maxFeedRate: 1200` is the **cutting** ceiling — the largest `F` Studio will write on a
`G1` — and FreeCAD's `max_velocity` is an **axis traverse** figure, which caps rapids.
Both can be true at once, and in stock Smoothieware the seek rate is 3× the feed rate.

> **Correction (2026-10-05, `/Rotary.md` §1.2).** The block above is the stock Smoothieware
> default. Makera's **shipped** `configZ1.default` reads `#default_seek_rate 2000`, not 3000 —
> so the 3× relationship is not what this machine ships with. **Neither number is a device
> figure**: both lines are commented out, so the firmware is using its compiled-in default
> until something sets it. Treat 2000 and 3000 alike — as readings of a file, not of hardware —
> and get the real traverse rate from #208 D3's timed air run, which is also what calibrates
> `ASSUMED_RAPID_MM_MIN` (#242).

**Neither 6000 nor those firmware numbers are Z1 figures.** Every rate line in
`configZ1.default` is commented out, so the firmware uses its compiled-in defaults, and
the commented values are **identical in `configZ1.default` and `configZ1Pro.default`** —
untouched Smoothieware boilerplate for two mechanically different machines. `Makera_Z1.fcm`
carries the same smell: its A-axis limits are **±10 000 000 degrees**, so whoever wrote it
filled in the real travel limits and left the rest at placeholders.

**Why it does not matter: a rapid never carries a feed rate.** In `TopClamp.nc`, **none of
the 25 `G0` lines has an `F` word**, and all 577 `F` words sit on `G1`. The controller uses
its own configured seek rate for rapids. So a post-processor emits `F` on cutting moves
only, clamped at **1 200 mm/min** — the one figure that comes from the machine's own
database row and that Studio's whole feeds table respects (max 1 200, zero rows above it).
The rapid ceiling is never ours to state.

**Caveat (review of #174):** a file *can* set the seek rate — `F` on a `G0` does. It is true of the samples read that none does, so emitting `F` on cutting moves only is still right, but the profile must not assume rapids are unconfigured. `/Z1-Firmware-Dialect.md` §10.

For #184 that means: a `maxCutFeed` field with a sourced value, and **no `maxRapid` field at
all** rather than a guessed one.

### 11.3 The Z1 Pro is a different machine

The firmware ships `src/configZ1.default` **and** `src/configZ1Pro.default`, and they differ
in the mechanics:

| | Z1 | Z1 Pro |
|---|---|---|
| X / Y steps per mm | 1600 | **640** |
| Z steps per mm | 3200 | **2560** |
| X / Y motor alarm pin | `nc` | **`1.27` / `1.24`** |

Fewer steps per mm means more travel per step, so at the same step frequency the Pro moves
roughly 2.5× faster in X and Y — consistent with it being the faster machine. And the Pro
wires up **servo motor alarm feedback** where the Z1 leaves those pins unconnected.

`t_MachineType` has only one `Makera Z1` row, so **Studio's database does not model the Pro
at all.** #184 should carry a machine identity rather than assume a single Z1.

**One trap in that file:** `alpha_max_travel 500` and `beta_max_travel 380` are *homing*
search distances — the comment says "Max travel in mm for … axis when homing" — **not** the
work envelope, which is 200 × 200 × 100. They are large enough to be mistaken for it.

## 12. Open unknowns

- Is strategy `type 5` V-carve? Is `toolType 4` Bull Nose? Both are hypotheses from the
  enum gaps plus binary strings.
- Does the Z1's `FuncSetting` ATC bit actually read clear on this machine
  (`/Fabrication.md` §9.4)?
- What does the Z1 do at `T1 M6` when T1 is already loaded? Studio's file opens with it.
  Added to #165's side-quest.
- Does `ORIGIN`'s `length` map to X or Y (§6.1)?
- ~~Which machine does the `[Video]` WebSocket in the logs belong to?~~ **Answered: the Z1
  has an integrated camera**, confirmed by the maintainer and by independent reviews, though
  `Z1/QuickStart` never mentions it. Studio carries `OpenCamera`, `VideoStreamManager`,
  `VideoOverlayWidget` and `ws_video`. Documented purpose is monitoring and time-lapse; the
  camera-to-machine calibration is ours to measure (#189); Studio offers **no**
  vision origin-setting — the view is a monitoring feed, confirmed 2026-10-03. **Where the
  camera is mounted** — head or frame — is still unknown and decides #189's whole model. `/Fabrication.md` §1 and §7.3.
- Are the empty `t_Custom*` tables reachable from Studio's UI, or dormant schema?

---

## 13. The wider field — what the multi-vendor study changes (#228)

`docs/market-research/` (local, gitignored — `FEATURE-MATRIX.md`, `UI-PATTERNS.md`,
`SOURCES.md`) is #228's survey of 37 machine models and 20 software products across the
desktop-CNC field. It is a **second benchmark alongside Studio**: §2–§9 above stay the
incumbent's inventory, and nothing here re-derives the study. What it changes is §10.

**It confirms Z1-only — twice over.** Makera's newer software, **CAM Beta v0.2.0**, is a
better CAM than Studio (layers, Trace Image, 2D/3D thread milling, PCB import) and serves
**Carvera / Carvera Air only**, gated behind purchase-email verification: a Z1 owner cannot
onboard it and is stranded on Studio's legacy CAM (`FEATURE-MATRIX.md` §3.2–§3.3). And the
field is **contracting**: Bantam Tools has left CNC entirely and `openbuilds.com` no longer
resolves (`FEATURE-MATRIX.md` §4 finding 1). "Parity means Studio's full capability set on
the Z1" is not weakened by looking outward; it is the only supported reading.

**It tells us how to shape the seam — which §10 asserted without evidence.** The field is
wider than "3-axis mill": 3-axis routers, a 5-axis mill with tool-centre-point control
(Penta / Pocket NC), a handheld CNC whose camera *is* the positioning system (Shaper Origin),
a lathe control (PathPilot), laser-first software (LightBurn / MillMage) and 3-in-1
module-swappers (Snapmaker). `FEATURE-MATRIX.md` §4 finding 2 states the consequence:

> A machine-profile abstraction (#184) that models only "3-axis mill with a spindle" will
> not cover it.

So the **scope** stays one machine, but the **type** must not bake a mill into its shape.
Anything a lathe, a laser or a handheld would falsify — a spindle RPM ceiling, a Z axis, a
single tool — must be a capability flag, a dialect field or optional data, never a structural
assumption. Decision 25 already points `MachineProfile` this way; §13 records *why* it must,
and gives #184 a wider field to check the shape against.

**It re-orders the gap list.** The recurring gap across the ten patterns is not strategies —
it is **the machine knowing itself**: a machine profile the user owns (wizard-created,
exported, re-imported), feeds clamped to the selected machine rather than a static table,
clearance heights that are *checked* rather than documented, time estimated from the real
toolpath, resume-from-line with accessory state replayed, and a printable run sheet
(`UI-PATTERNS.md`, esp. §1, §4, §5, §9). Four of the ten map directly onto work already in
flight (`/Simulation.md`, the below-PCB-clearance rule, `runSheet.ts` / `RunSheetView.tsx`);
the tenth is #189. The strategy gaps in §2 remain real, but they are not what a Studio user
misses *first* — §8.1 item 2 ("clamp to the selected machine") is the higher-value parity
item, and #228 supplies the evidence for that priority.

**The evidence is asymmetric, and the study says so.** Every competitor claim is
documentation-level — no competitor app was run — while the Makera claims are file-level
(`UI-PATTERNS.md`, "What this list does not say"). Treat §13 as a *scope and shape* input,
not as a capability audit of any named product.

---

## 14. The corpus read against the roadmap (#236)

Read 2026-10-05: `docs/market-research/FEATURE-MATRIX.md`, `UI-PATTERNS.md`, `SOURCES.md`
and all 18 vendor notes, against the open issues, the six CNC milestones, `/Fabrication.md`'s
28 numbered decisions, §13 above and `/Simulation.md`. §13 took one slice (the machine-profile
shape); this section takes the rest. **The corpus is gitignored**, so every conclusion that
matters is written here, with the load-bearing fact beside its citation, and the citation is
for a reader who has the corpus on disk. Every line below ends in a consequence. Rotary
findings are not here — they belong to #235.

Vendor codes are `FEATURE-MATRIX.md` §0's: C3 Carbide 3D, BT Bantam, SM Snapmaker, IV Easel,
RG Roland, TM Tormach PathPilot, SC gSender, OB OpenBuilds, GM Candle, SP Shaper, ST Stepcraft,
VC Vectric, CV Carveco, ES Estlcam, AD Fusion, LB LightBurn/MillMage, OF Onefinity, PN Kinetic
Control; MKS/MKC are Makera Studio / Makera CAM Beta.

### 14.1 What the matrix says, cell by cell, against what we have

| Capability (`FEATURE-MATRIX.md`) | The field | Us | Verdict |
|---|---|---|---|
| 2D pocket, contour, drill (§2.C) | Y almost everywhere | pocket shipped (#172); contour/cut-out #218; drill #220 | covered |
| Tabs / bridges (§2.C) | Y: C3, CV all tiers, VC, ES?, AD, LB, MKC; `?` for IV after the evidence audit | #218 | covered |
| Ramping (§2.C) | Y: C3 Pro, IV Starter, CV all tiers, VC, AD, LB, MKC | none | **absent by choice** — §14.4 R16 |
| Stock-to-leave / finish pass (§2.C) | Y: TM, VC, CV all tiers, AD, LB | none | **absent** — §14.3 M3 |
| V-carve (§2.C) | Y in 9 columns; MKS `P` (type 5 ships no config, §2.1) | #221, gated on #185 | covered, deferred |
| 3D relief (§2.C) | Y mostly in paid tiers (C3 Pro, IV Pro, LB Pro) | #222 | covered, deferred |
| Thread milling (§2.C) | MKS, MKC, VC, ES, AD | not planned (§2) | **refused** — R14 |
| Nesting (§2.C) | Pro tiers only: VC Pro, CV Plus, LB Pro | none | **refused** — R15 |
| Toolpath templates (§2.C) | VC Pro, CV Plus/Pro, LB Ops Library, IV Pro Toolbox (a cut-settings library, not an op template) | the `EngraveJob` document *is* the template (`docs/bench/*.job.json`) | **refused** — R7 |
| Custom tool library (§2.C) | Y nearly everywhere | `TOOL_LIBRARY` code-level; #212 inventory | covered |
| Feeds database (§2.C) | Y nearly everywhere; only TM computes from material + tool with provenance | `feeds.ts`, every row `unmeasured`, clamped by `clampToMachine` | covered; the readback loop is missing — §14.7 |
| Plugin / scripting (§2.C) | SC macros, OB inject API, GM JS debugger, VC gadgets — all senders | none | **refused** — R11 |
| Material-removal simulation (§2.D) | Y in 11 columns; MKS `P` (unwired), MKC `N` | exact sweep, checkpointed playback (#182, #193–#199) | **ahead** |
| Collision / gouge check (§2.D) | only C3 and BT; BT warns without blocking | fixture, holder, gouge, spindle-off-near-material, envelope — errors, not warnings | **ahead** |
| Machining-time estimate (§2.D) | IV, TM (learned), SC (on file load, no machine), VC (scale factor), LB | cutting-only, three different numbers — §14.2 A1 | **mis-scoped** |
| Setup / run sheet (§2.F) | only VC and CV | #207 shipped | covered |
| First-run wizard, jog, homing, overrides, pendant, MDI (§2.E) | Y in most senders | none — the web build cannot open a socket; the desktop build will (§5.7, #181) | **refused until the bridge, then reopened for the connect/home half** — R1, R10 |
| Job queue (§2.F) | **N or ? in every column**; TM's "job" is a conversational step | none | **refused** — R9 |
| G-code viewer (§2.F) | Y in 11 columns; TM colours the executing line | diagnostics say `line N`; nothing shows the text | **absent** — A5 |
| Job history / statistics (§2.F) | SC rich; PN, TM partial | run-sheet §9 record blanks, read by hand (#209) | **absent** — §14.7 |
| Resume / start-from-line (§2.E, UI §8) | SC with accessory state, IV Pro, OF, TM | none | **absent** — M2 |
| Camera (§2.F) | load-bearing only at SP and LB; MKS monitoring only | #189 | covered |
| Import: SVG / DXF / STL / STEP / Gerber (§2.B) | SVG Y in 13 columns incl. free tiers; STL 9, mostly paid; STEP 3; Gerber 4 | #217 (SVG, DXF); mesh for CNC with #222 | covered; **decision 6's order is inverted** — §14.5 |
| Image trace (§2.B) | Y in 8 columns; ES machines QR codes | #252 — a bitmap traced to a cut profile in the import dialog; relief still #222 | **trace covered** — decision 5's first half; the greyscale-relief half waits for #222 (M5) |
| Parametric modelling (§2.B) | AD only | the whole app | **ahead** |
| Open source / offline / no account (§2.A) | 3 open; MKC gates first run on a purchase email | Apache-2.0, browser, local-first | ahead; keep it — R19, R20 |

### 14.2 Act on now

Each is cheap, changes something already built or already scheduled, and needs no machine.

- **A1 — One time estimate, everywhere, with its assumptions named.** The field states the job
  time before the run: SC computes it on file load with no machine connected
  (`UI-PATTERNS.md` §3; `notes/sienci.md` feature inventory), VC from path length and feeds,
  TM learns it from the previous run and shows it on load (`notes/tormach.md`, "Run time is
  estimated and remembered", PP-1500/PP-2257). We have **three** numbers: `estimateSeconds`
  (`cam/ir.ts`) counts feed moves only; the post writes that cutting-only figure into
  `;@MKR|TIME|seconds=` (`post/z1.ts`), which the machine's screen shows as the job time
  (`/Fabrication.md` §2); the run sheet labels it "simulated — rapids not included"; the
  transport counts rapids at `DISPLAY_RAPID_MM_MIN = 3000` (`workers/sim/session.ts`); the
  Simulate panel shows no time at all. **So we should** compute one estimate — cutting time
  plus rapids at one named PROVISIONAL rapid rate (the display constant is already that
  number; #208 D3 times an air run and calibrates it) — show it in the Simulate panel on load,
  in the Engrave panel's Generate row and on the run sheet, and write *that* into `TIME` with
  the assumption in a header comment. This does not collide with §11.2's "no `maxRapid`
  field": §11.2 refuses to *command* a rapid rate (`F` on `G0`); an estimate's assumed rate is
  a labelled assumption, which the transport already makes. **So we should not** add VC's
  user-editable scale factor (a knob; the project rule is fix the default) — the honest
  correction is TM's: the run sheet §9 already records wall-clock time, and once #209 records
  it, "last measured" belongs beside the estimate.
- **A2 — Say what the simulation did not look at.** BT names its blind spots — *"The software
  doesn't yet have warnings for every potential type of collision… Fixturing collisions…
  Material collisions"* — and MillMage's setup wizard says workholding is not in the safe
  height (`UI-PATTERNS.md` §5). Our disclaimer is physics only ("rigid, ideal machine: no
  deflection, no runout, no Z-chain error, no chatter"). The geometry the sweep does not see:
  the spindle body, head and gantry (#204: "do not model the spindle body"); anything on the
  bed other than the declared vise and sacrificial stack — the anchor bracket, clamps, the
  probe cable; and the collet nut while `Z1.holder` is `null`. **So we should** add one
  sentence to the disclaimer in the Simulate panel, the Engrave panel's Simulated row and run
  sheet §8 listing that geometry, so a green result cannot be read as "nothing can be hit".
- **A3 — A framing file beside the job.** LB ships two framing modes (bounding box and
  rubber band), SC traces the job's extents, SP's Aircut pilots the design at negative depth,
  C3 offers rapid positioning to corners (`UI-PATTERNS.md` §6). Our run sheet §6 says "raise
  Z by 20 mm and run the whole file in the air" — a full-length air run to answer a question
  that takes seconds. The hull of every cutting move is already computed by the sweep. **So we
  should** emit `<job>-frame.nc` beside `<job>.nc`: spindle off, rapid to `hopZ`, trace the
  toolpath's hull at `hopZ`, return, `M02` — passed through the same verifier and simulator
  (no cut moves; spindle-off feeds far above material, so no `spindle-off-near-material`) —
  and make run sheet §6 "run the frame file first; the full air run only if the frame
  surprised you". The first bench trip keeps the air run (#208 D4): it is the only check of
  the lowest point against the jaws.
- **A4 — Suggested vs supplied, on the cutting fields.** TM colours a DRO green when the value
  is the controller's suggestion and white once the operator overwrites it
  (`notes/tormach.md`, feeds and speeds, p. 123; `UI-PATTERNS.md` runners-up). We already do
  this in the Simulate panel — `FieldSource: 'header' | 'user' | 'default'` (#196) — and not
  in the Engrave panel's Cutting override (#205), where a table value and a typed override
  look the same. **So we should** tag each cutting field with its source using the same
  convention, with the row's `status` (`unmeasured` / `measured`) as a third state, so that a
  row #209 makes `measured` reads differently from one the operator overrode.
- **A5 — A read-only G-code pane synced to the scrubber.** Eleven of twenty products show the
  program text; TM colours the executing line orange and the start line green
  (`FEATURE-MATRIX.md` §2.F; `notes/tormach.md`, "Job setup / restart aids", pp. 41–45). Our
  diagnostics carry `line N` and nothing shows line N. **So we should** add a read-only pane
  that follows the transport step and jumps on a diagnostic click. **So we should not** make
  it editable — R8.
- **A6 — Export and import the user's own measurements as one file.** SC exports firmware
  settings *"so you have it on hand"*; BT's tool library imports and exports `.json`; ST's
  installer treats each attachment as an installed profile (`UI-PATTERNS.md` §1;
  `notes/bantam.md` §4). Ours: `settingsStore.fixtures` holds the saved vise and sacrificial
  stack in one browser's `localStorage`; #212 plans inventory export separately; `Z1.holder`
  and the soft-endstop values will be bench-measured. The maintainer works on two machines.
  **So we should** add one "my machine" export/import — fixtures, inventory when it exists,
  measured holder and endstop overrides — as JSON with every `source` / `measuredAt` field
  intact. **So we should not** build a first-run wizard around it — R1.

### 14.3 Milestone material

- **M1 — Test coupons: parameter sweeps the app writes, sheets and reads back.** LB ships a
  *Material Test Generator* — *"a 10x10 grid of boxes with varying Power and Speed. Use the
  Param dropdown to select different parameters to test"* — as a first-class feature, reusable
  through its material library (`UI-PATTERNS.md` runners-up; `notes/lightburn.md` §3). Every
  bench issue we have is that feature done by hand: #165's depth ladder was built by a one-off
  script (`scripts/bench-files.ts`; #231 item 1, "no scriptable job → `.nc` path"), #185 is a
  V-groove ladder, #209 is three depths, #208 D1 is three air strokes. Every `feeds.ts` row is
  `unmeasured`, and run sheet §9's record blanks have nowhere to go but a bench markdown. The
  FDM side already has the same idea as #157 (fit coupons). *Entry:* #209 done, so the first
  real numbers exist and the paper record form is proven. *Exit:* a `coupon` job kind (a
  labelled grid varying one of depth / feed / step-over / rpm / step-down, labelled on the part
  and on the sheet); a committed scripted path job → `.nc` + sheet (closes #231 item 1); and a
  readback form whose entries flip a feeds row to `measured` with date and coupon id as its
  provenance. **So we should** make this a milestone — proposed **CNC-2.2 "Measured, not
  assumed"** — rather than another script.
- **M2 — Restart from a step, as a generated file.** SC's start-from-line *"look[s] through the
  whole g-code file up to where you want to resume… what accessories were turned on, the power
  of a spindle or laser"*; IV Pro has resume carve; OF has Jump to Line and power-loss
  recovery; TM has *Set a New Start Line* with four lead-in behaviours and logs the last
  executed line "in case a program must be restarted from the middle" (`UI-PATTERNS.md` §8;
  `notes/tormach.md`). The hard part SC describes is what our `Timeline` already holds at every
  step — spindle, air, tool, WCS (`/Simulation.md` §1.1). We do not drive the machine, so
  resume is a second `.nc`: a literal prefix (`G90 G21`, `T<n> M6`, `S M3`, `M7`, `G0` to
  `hopZ` then XY) and the tail from step *k*. Two Z1 facts make it safe: Smoothieware has no
  variables, so the prefix must be literal anyway, and `M6` re-measures tool length, which is
  exactly what a broken-bit restart needs (`/Z1-Firmware-Dialect.md` §2). *Entry:* #209 — the
  first real job is the first one that can stop. *Exit:* "Restart from this step" on any
  loaded program, writing `<file>-from-L<n>.nc` through the same generate → verify → simulate
  gate (#206), with a run-sheet addendum. **So we should** schedule it in CNC-2.2, not before.
- **M3 — A finish pass on floors and walls (stock-to-leave).** Y for TM, VC, CV (all tiers:
  *"Perform a finishing pass around the design to ensure clean and smooth edges after rough
  cutting"*, `notes/carveco.md` second pass), AD, LB; §4 above has had it as "planned" since
  2026-10-03 with no issue. *Entry:* #209 reports fuzzy or torn finish at the step-over used,
  or #176's two-colour reveal needs a cleaner floor. *Exit:* a `finish` option — a final
  full-depth wall pass at a named allowance and a floor pass at reduced step-over, both
  constant-Z and so exact in the sweep. **So we should** hold it for that evidence rather than
  build it on an assumption about finish.
- **M4 — A batch of parts from a list (demand-gated).** VC's *production plate engraving
  (CSV/text merge)* (`notes/vectric.md`, feature inventory) is exactly what a badge maker does
  twenty times. *Entry:* #176 (the first badge) done **and someone asks** — the project's
  demand-driven rule. *Exit:* one job plus a list → N `.nc` files and N run-sheet pages, one
  blank per job; not nesting (R15). **So we should** write it down and wait for the ask.
- **M5 — Vector trace of an image (decision 5's first half) — TRACE LANDED, #252.** Image trace
  is Y in eight columns, free-tier in most; ES machines pictures *and QR codes*
  (`FEATURE-MATRIX.md` §2.B). *Entry:* #217 landed — the traced result is just another profile
  import. *Exit:* raster → profile as an import source with the opening check (#201) applied to
  the result — **met**: the Engrave panel's "Trace image…" thresholds a bitmap to rings in mm and
  hands them to the same dialog, `partPlan` and opening check an SVG gets, with live threshold,
  despeckle and corner-smoothing controls and the assumed 96 px/inch scale on screen. What is
  left of M5 is the greyscale-**relief** half, which waits for #222. **So we should** sequence
  relief into CNC-4.

### 14.4 Refused, on the record

Each with the reason, so it does not come back in six months. Where a reopen condition
exists it is stated; where none is, the refusal is meant to hold.

- **R1 — not "no wizard". Rewritten 2026-10-05 after three maintainer corrections, because the
  original entry named a *mechanism* instead of a *reason* and over-refused.**
  (`UI-PATTERNS.md` §1: C3's *Setup New Machine*, BT's tab rail, LB/MillMage's project setup.)

  Sort a guided flow by what it asks about, and only one of the three is refused:

  1. **Job setup — not refused, wanted now, and web-capable.** What are you holding it in,
     what is the material, what size is the blank, which cutter is fitted. No machine, no
     socket, no bridge: it is panel work and it runs in the browser exactly as it runs on the
     desktop. Decision 26 already makes workholding an explicit input the probe plan derives
     from, and #231's dogfood found the first real job needing a hand override of
     `DEFAULT_VISE.stockProud` that nothing in the panel pointed at. **So we should** build
     it — **#254** (CNC-2.1).
  2. **Telling the app about your machine and your kit — not refused either, and also
     web-capable.** Which machine, the vise you measured, the cutters you own, the overrides
     from a bench session, imported from the JSON of A6 (**#247**). None of it needs a
     connection; it is typing and file import, which a browser does.
  3. **Connect, discover, home, test switches, configure a tool setter — absent, not
     refused.** These steps have nothing to drive until the bridge exists. `/Fabrication.md`
     §5.7 is explicit that the bridge is **Tauri-only**, WiFi, developed from Windows, and
     deferred on *sequencing* rather than risk — Makera publish their own controller client,
     so the protocol is readable. When #181's platform seam lands and the bridge is on the
     board (CNC-4), *connect / discover / confirm-this-is-the-right-machine* (`M482.5` → IP,
     `M482.4` → MAC) and *home* become real first-run steps a guided flow should carry, **on
     the desktop build only**. The web build keeps 1 and 2 and simply does not show 3.

  **What is actually refused, and it is the only durable part:** **no flow owns machine
  facts.** The profile stays code with provenance per field (`machine.ts`); a measured number
  stays a setting with its `source` and travels via #247; a flow *reads and writes those
  stores* rather than becoming a third home for the same fact, filled by typing and
  indistinguishable from a measurement. And no dialog can caliper a vise or probe a blank, so
  #208's rows remain bench work however many steps the flow has.

  **The lesson for the rest of this list:** a refusal phrased as a mechanism ("a wizard")
  will over-refuse. Phrase it as the reason. **R10 is the next entry to re-read on those
  grounds.**
- **R2 — VC's operator-editable time scale factor.** A knob over a model we can measure
  instead (A1). **So we should not.**
- **R3 — PN's Industry / Intuitive dialect switch, or any second vocabulary**
  (`UI-PATTERNS.md` §7). Two wordings are two things to keep true; the CNC guide already chose
  plain words with a glossary (`cnc-guide.md` §8.5). **So we should not.**
- **R4 — RG's "Better surface finish / Faster cutting time" radio, or any quality/speed
  preset over the feeds table** (`UI-PATTERNS.md` §7). Every row is `unmeasured`; a preset over
  unmeasured numbers is a promise. *Reopen:* two `measured` rows per material exist (M1).
  **So we should not** before then.
- **R5 — Community cut settings** (IV Pro, `UI-PATTERNS.md` §4). No server, local-first; and a
  shared number without the machine, cutter and measurement attached is the Makera table's
  failure in another form — 32 rows above the Z1's ceiling (§5.1). **So we should not.**
- **R6 — Bundling a vendor tool catalogue** (IV's "roughly 600 bits from five brands", C3's
  store library, `UI-PATTERNS.md` §4). Licence (`/Fabrication.md` §3: read, never copy) and
  #212's rule: the picker lists tools you own. **So we should not.**
- **R7 — A toolpath / operations template library** (VC templates, CV Plus/Pro, MillMage
  Operations Library). The `EngraveJob` file is the template, and the app's template mechanism
  is already declarative JSON. **So we should not** add a second preset system.
- **R8 — In-app G-code editing** (`FEATURE-MATRIX.md` §2.F: editors in 11 columns). The file is
  the output of generate → verify → simulate (#206); an edit after the gate voids the gate, and
  #209 already forbids fixing a depth by hand at the machine. **So we should not**; a viewer
  (A5) is a different thing.
- **R9 — A job queue.** Nobody in the sample has one — `N` or `?` in every column; TM's "job"
  is a conversational step inside one program (`FEATURE-MATRIX.md` §2.E note) — and we do not
  send. **So we should not.**
- **R10 — Jog, DRO, homing, overrides, pendant/gamepad, MDI console in the app**
  (`FEATURE-MATRIX.md` §2.E). Bridge-era by decision 10 and §9.1, bound by `/Fabrication.md`
  §8's safety rules; the bridge issue decides what the bridge exposes. **So we should not**
  carry any of it as a design now.
- **R11 — A plugin or scripting API, or macros** (GM's JS window with a debugger, SC macros,
  OB's inject API, VC gadgets). Three of twenty have one and all are senders;
  `/Fabrication.md` §8: no driver plugin API until someone asks. **So we should not.**
- **R12 — Gerber / PCB isolation routing** (MKC, BT subscription, AD, ES outlines). A different
  product; Case Maker builds *around* boards. **So we should not**, absent demand.
- **R13 — STEP / IGES import** (MKC, RG, AD). Needs a B-rep kernel; our geometry is Manifold
  meshes and Clipper2 profiles, and mesh import already serves cases. *Reopen:* a case consumer
  appears. **So we should not** otherwise.
- **R14 — Thread milling** (MKS, MKC, VC, ES, AD). No thread mill is owned, threads in printed
  parts are inserts and screws (#140), and a 150 W spindle in PLA is not where it earns its
  keep. **So we should not.**
- **R15 — True-shape nesting and tiling** (VC Pro, CV Plus, LB Pro, C3 Pro tiling). A 200 × 200
  bed and one blank in the vise; the FDM side's print-ready layout already handles multi-part;
  a batch (M4) is N jobs, not one nested job. **So we should not.**
- **R16 — Ramping and helical entry in our own CAM, for now** (CV all tiers, IV Starter, C3
  Pro, MKC, VC, AD, LB). A plunge is exact in the sweep; a ramp is swept conservatively and
  over-removes (`/Simulation.md` §3.2), which widens the oracle's over-cut tolerance for every
  job that uses it. At a 1 mm cutter and 0.3–1.0 mm step-down in wood and PLA the plunge load
  is small. *Reopen:* #209 shows plunge marks or an entry-broken cutter, or #222 makes
  non-constant-Z moves exact. **So we should not** write it before then; §4 now says so
  instead of "planned".
- **R17 — The camera as monitor, time-lapse or dashcam** (TM's E-stop loop recording, SM's AI
  monitoring, MKS's feed). Studio and the Makera App already monitor; our camera work is
  metrology only (§9, #189). **So we should not.**
- **R18 — UI localisation now** (LB's 25 translations, PN's language switch). The guide and
  the diagnostic reference are rewritten weekly. *Reopen:* `cnc-guide.md` §8.1 stable for a
  release. **So we should not** add i18n plumbing before that.
- **R19 — A cloud simulator or an account** (TM's PathPilot HUB; MKC's purchase-email gate;
  IV). Two vendors in this sample have vanished or exited (`FEATURE-MATRIX.md` §4 finding 1),
  and our simulator already runs in the browser. **So we should not.**
- **R20 — Feature tiers** (IV's one carve per week, C3 Pro, CV Plus). Apache-2.0, and #181's
  rule: honest UI, not teased UI. **So we should not.**

### 14.5 Where the field contradicts a numbered decision

Named for the owner of `/Fabrication.md`; this document does not edit that file.

- **Decision 6 — "Mesh import only to start (STL/3MF/OBJ), behind a pluggable registry."**
  For 2.5D CAM the universal import is the profile, not the mesh: SVG is `Y` in 13 of 20
  columns including every free tier, STL in 9 and mostly paid (`FEATURE-MATRIX.md` §2.B).
  Our own CNC pipeline agrees — "CAM must consume profiles and a target Z, never a mesh"
  (`/Fabrication.md` §5.2) — and the issues already invert the decision: #217 (SVG then DXF)
  is CNC-2.1, mesh for CNC is #222 in CNC-4. **It should become:** *CNC import is profiles
  first — SVG, then DXF (#217); mesh for the CNC side arrives with the dexel engine (#222).
  The case-side mesh importer is unchanged.* Decision 6 was taken in the printing frame and
  the CNC side needs its own sentence.
- **Decision 19 — "Workholding is a printed nest, and it is a V1 deliverable" (OPEN).** The
  bench settles it, not the corpus, but the corpus is one-sided: every enclosed desktop mill in
  the sample ships or sells a mechanical fixture with a probing routine named after it — BT's
  *L-Bracket Location* and *Rectangular Outer Corner* (`notes/bantam.md` §4), C3's low-profile
  vise with BitZero's *Corner* cycle (`notes/carbide3d.md`), SP's Workstation — and none
  documents a printed per-part nest. CNC-2 is already vise-first. **It should become:** *V1
  workholding is the low-profile vise; the nest is not a deliverable; #175 reopens only if
  #176 shows the vise cannot hold the 3.81 mm badge.*
- **§9.1 — "Feeds/speeds from `makera_library.db`: read the DB when there are two tools."**
  The DB has no PLA or PETG, no machine column and 32 rows above the Z1's ceiling (§5.1); the
  field's best practice is TM's — compute from material and tool in the app, mark which values
  are suggested (`notes/tormach.md`, pp. 122–124) — which `feeds.ts` with `status` already is.
  **It should become:** *the DB is a prefill source for the desktop tool inventory (#212,
  resolver case 2) and never the feeds source.*
- **Decision 9 — "First real job is a 3D-printed blank."** Housekeeping, not a corpus
  finding: CNC-2's first chips are wood in the vise (#209); the badge is CNC-3. **It should
  read** "first *badge* job".
- **Decision 5 — two image methods.** Not contradicted; mis-sequenced. Trace is free-tier and
  near-universal, relief is paid-tier and 3D (`FEATURE-MATRIX.md` §2.B). **It should say**
  trace first, with #217; relief with #222 (M5).

**Checked and standing, stronger for it:** decision 4 (the vendor itself routes Z1 laser work
to LightBurn — `SOURCES.md`, Makera table, `software/LightBurn`; a flag, not code); decision 10
(USB is the field's default but Makera publishes both streams; the transport seam stands);
decision 12 (the sample's only bed-levelling heightmap is GM's, built for PCB isolation —
`notes/genmitsu.md`; TM's probing is workpiece and tool setting, not bed levelling — decision
24's probed face makes `G32` unnecessary); decision 14 (gated on #185, honest reason intact);
decision 20 (SP's depth presets and RG's two-way radio are the same instinct); decision 26
(BT's named probing routines are the derivation, done by hand); decision 28 (LB redoes camera
alignment whenever the camera moves — provenance with an invalidation rule); decision 25 and
§13 (done); §8's "no plugin API" (R11).

### 14.6 The ten UI patterns: copy, inherit for nothing, or conflict

| `UI-PATTERNS.md` | Verdict | Where it lands |
|---|---|---|
| §1 wizard + exportable profile | **inherit for nothing** as a wizard *today*; **copy** the export/import; revisit the guided-setup half when the desktop build connects | A6, R1 |
| §2 scrubbable simulation | **done** — step-indexed transport, pauses as the only ticks (#198); CV's per-toolpath simulate is covered by per-label floors in the preview | — |
| §3 time before the run | **copy**, and it **conflicts** with §11.2 until "estimate ≠ command" is stated | A1, R2 |
| §4 feeds from machine + material | **done** (`clampToMachine`, `feeds.ts`); **copy** TM's suggested/supplied; **refuse** community settings and vendor catalogues | A4, R5, R6 |
| §5 clearance asked and checked | **done, stronger than any vendor** (verifier rule 9, fixture and holder gates, gouge solids); **copy** BT's blind-spot sentence | A2 |
| §6 confirm where it lands | **copy** as a framing file; SP's Aircut is run sheet §6's Z+20; **conflicts** with run sheet §6 as written | A3 |
| §7 plain language first | **done** by project values (two-state depth, override disclosure); **refuse** the dialect switch and the quality radio; **conflicts** with the guide's one vocabulary | R3, R4 |
| §8 resume with accessory state | **milestone**, as a generated file — **conflicts** with "we do not drive the machine" unless done that way; the render-failure half is already the worker architecture | M2 |
| §9 printable run sheet | **done** (#207); **copy** the unit — break the sheet at a tool change or a side when #218/#215 and multi-tool arrive; **refuse** VC's logo branding | later |
| §10 camera locates the part | **covered** (#189); LB's redo-on-move is decision 28 | — |

### 14.7 The one thing the corpus says we are ignoring

**The parameter-test generator (M1).** Every cutting number in the app is `unmeasured`; four
bench issues (#165, #185, #208 D1, #209) are hand-built parameter sweeps; the one real job
generated so far needed a private script; and the run sheet ends in record blanks that are
transcribed into markdown by hand. LightBurn ships that whole loop as a product feature
(`UI-PATTERNS.md` runners-up, row 1), and the project already recognised the same primitive on
the printing side as #157. It needs no machine, no bridge, no new geometry — a grid of items
the engrave pipeline already cuts, a label per cell, and a form whose answers become the
provenance of a feeds row. It is the mechanism by which "replace from #209" stops being a
comment in `feeds.ts`.

### 14.8 Proposed issues and milestones — listed, not filed

| Proposed | Milestone | From |
|---|---|---|
| sim/engrave: one time estimate (cutting + rapids at a named PROVISIONAL rate), in the panel, the sheet and `TIME` | CNC-2 | A1 |
| sim: the disclaimer names the geometry the sweep did not see | CNC-2 | A2 |
| engrave: emit `<job>-frame.nc` and make run sheet §6 use it | CNC-2 | A3 |
| engrave: `FieldSource` on the Cutting override fields, with `measured` as a third state | CNC-2.1 | A4 |
| sim: read-only G-code pane synced to the transport; diagnostics jump to their line | CNC-1 | A5 |
| settings: "my machine" export/import (fixtures, inventory, measured overrides) | CNC-2.1 | A6 |
| **CNC-2.2 "Measured, not assumed"** (new milestone) — entry: #209 done; exit: feeds rows flipped to `measured` through coupons, a restart file proven on a bench stop | — | M1, M2 |
| coupon job kind + scripted job → `.nc` + sheet (closes #231 item 1) + readback to `feeds.ts` | CNC-2.2 | M1 |
| sim: restart from a step as a generated, gated `.nc` | CNC-2.2 | M2 |
| cam: finish pass on floors and walls — entry gated on #209's finish | CNC-3 | M3 |
| engrave: batch from a list — demand-gated | after #176 | M4 |
| import: raster → profile trace, after #217 | CNC-2.1 follow-on | M5 — filed as #252 and shipped |
| docs: `/Fabrication.md` decisions 6, 9, 19 and the §9.1 DB row, as §14.5 states them | — | §14.5 |
