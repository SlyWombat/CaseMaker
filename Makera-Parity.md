# Makera Studio — capability parity review

Status as of 2026-10-03. Nothing here is implemented; this document is the inventory
and the gap list that `/Fabrication.md` plans against.

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

Everything below was read from the local Studio 0.1.2.0 install. Paths are written
relative to `%APPDATA%/MakeraStudio` and `%LOCALAPPDATA%/Programs/Makera Studio`.

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
| 11 | Rotation Relief | yes | deferred (decisions 3, 11) |
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
| **Ramping** | `useRamping`, `rampingType`, `angle`, `rampingZ`, `rampingdistance` | planned — V1 plunges |
| **Tabs / bridges** | `supportTabs`, `tabsDistance`, `tabsHeight`, `tabsLayout`, `tabsShape`, `tabsWidth` (2D/3D Contour only) | planned — needed the moment we cut parts free |
| **Stock to leave** | `radial_allowance`, `axial_allowance`, `machining_allowance`, `finshing[]` *(sic)* | planned |
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
  a cylinder stock type for rotary work. Case Maker: cuboid in V1.
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

---

## 10. What the new brief reopens

"Thousands of people" invalidates premises that were sound for one user with one machine.
These are flagged, not decided:

| Decision | Premised on | Status now |
|---|---|---|
| **Decision 4** — no laser, ever | *this* machine has no laser module | Other Z1 owners have the 5 W unit. "Never" should become "not for this machine, and not in V1". |
| **§8** — "the Z1 only. No driver plugin API until someone asks" | one machine | A second machine is now foreseeable. §5.3's `MachineProfile` is the seam; it stays deferred, but the limit-clamping in §5.1 item 3 needs *some* machine object from the start. |
| **§5.3** — one `Z1` constant until a second CNC exists | one machine | Carvera and Carvera Air are already rows in the same database. |
| **Demand-driven features** (`feedback_demand_driven_features`) | a single-user tool | Still right about *speculative infrastructure*; weaker about capabilities a Studio user already has and will immediately miss (tabs, ramping, stock-to-leave). |
| **V-carve deferred to V2** | §7.4's 60°-point arithmetic | §3.1 — the arithmetic was wrong about the available tools. Still defer, for the depth-coupling reason, but say so honestly. |

**The question this document cannot answer.** Does parity mean *Studio's full capability
set on the Z1*, as a roadmap with V1 still the first slice? Or does it also mean the
Carvera and Carvera Air, and the laser? The matrix above is written for the first reading.
The second roughly doubles it and makes `MachineProfile` (§5.3) a near-term prerequisite
rather than a deferral.

---

## 11. Open unknowns

- Is strategy `type 5` V-carve? Is `toolType 4` Bull Nose? Both are hypotheses from the
  enum gaps plus binary strings.
- Does the Z1's `FuncSetting` ATC bit actually read clear on this machine
  (`/Fabrication.md` §9.4)?
- What does the Z1 do at `T1 M6` when T1 is already loaded? Studio's file opens with it.
  Added to #165's side-quest.
- Does `ORIGIN`'s `length` map to X or Y (§6.1)?
- Which machine does the `[Video]` WebSocket in the logs belong to? The Z1 has no
  documented camera.
- Are the empty `t_Custom*` tables reachable from Studio's UI, or dormant schema?
