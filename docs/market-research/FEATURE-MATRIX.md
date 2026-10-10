# Desktop-CNC software — feature matrix

**Status: first pass complete, 2026-10-04.** Every cell is derived from
`notes/<vendor>.md`, which carries the source URL and access date for each fact.
Where the notes do not settle a cell it is `?` — deliberately, rather than guessed.

> **Tracking issue: [#228](https://github.com/SlyWombat/CaseMaker/issues/228).** This
> directory is **gitignored** (third-party material; see `README.md`). Companion documents:
> `UI-PATTERNS.md` (the ten UI gaps, with samples) and `SOURCES.md` (263 sources).

## 0. How to read this

Two matrices, because the field splits into **vendors who ship their own integrated
software** (the interesting comparison for us) and **third-party CAM/control packages**
that run across many machines.

**Legend for the capability grid** (short codes keep the rows readable):

| Code | Software | Vendor | Notes file | Grid |
|---|---|---|---|---|
| **MKS** | Makera **Studio** | Makera | `/Makera-Parity.md`, `/Fabrication.md` (local) | yes |
| **MKC** | Makera **CAM Beta v0.2.0** | Makera | `raw/makera/software-MakeraCAM_userguide.txt` (local) | yes |
| C3 | Carbide Create + Carbide Motion | Carbide 3D | `notes/carbide3d.md` | yes |
| BT | Bantam Tools Milling Machine Software | Bantam Tools | `notes/bantam.md` | yes |
| SM | Snapmaker Luban | Snapmaker | `notes/snapmaker.md` | yes |
| IV | Easel | Inventables / Easel Software Inc. | `notes/inventables.md` | yes |
| RG | SRP Player + VPanel | Roland DG / DGSHAPE | `notes/roland.md` | yes |
| TM | PathPilot (+ PathPilot HUB) | Tormach | `notes/tormach.md` | yes |
| SC | gSender | Sienci Labs | `notes/sienci.md` | yes |
| OB | OpenBuilds CONTROL (+ CAM) | OpenBuilds | `notes/openbuilds.md` | yes |
| GM | Candle / Candle 2 | Genmitsu (SainSmart) — third-party bundle | `notes/genmitsu.md` | yes |
| SP | Shaper Origin on-tool UI + Studio + Trace | Shaper Tools | `notes/shaper.md` | yes |
| ST | UCCNC / WinPC-NC (Stepcraft's control stack) | Stepcraft | `notes/stepcraft.md` | yes |
| VC | VCarve Desktop/Pro, Cut2D, Aspire | Vectric | `notes/vectric.md` | yes |
| CV | Carveco Maker / Maker Plus / Pro | Carveco | `notes/carveco.md` | yes |
| ES | Estlcam | Estlcam (C. Knüll) | `notes/estlcam.md` | yes |
| AD | Autodesk Fusion (CAM workspace) | Autodesk | `notes/autodesk-fusion360.md` | yes |
| LB | LightBurn + **MillMage** | LightBurn Software Inc. | `notes/lightburn.md` | yes |
| OF | Onefinity Redline CNC controller | Onefinity | `notes/onefinity.md` | yes |
| PN | Kinetic Control | Penta Machine Co. (Pocket NC) | `notes/pocketnc.md` | yes |

Cell values: `Y` = present · `P` = partial / limited / adjacent · `N` = absent ·
`?` = the notes do not settle it · `—` = not applicable.

Two rows need a convention up front, because several products are delivered as web
apps or machine firmware rather than installable desktop programs:

- **Windows / macOS / Linux (native app)** — `Y` only for an installable native build.
  Easel and Shaper Studio are web apps, so they are `N` here and `Y` under *Runs in a
  browser*; Kinetic Control runs **on the machine** and is reached by browser.
- **Grid columns vs. section 1** — Vectric, Carveco and Estlcam sell no machine, and
  LightBurn's MillMage, Autodesk and Easel sell no machine either; they appear in the
  grid but not in the hardware table.

---

## 1. Machine platform (hardware)

Every figure needs a vendor spec page or manual URL; those live in each `notes/*.md`.

| Machine | Vendor | Envelope X×Y×Z (mm) | Spindle | ATC | Axes | Materials | Price (USD) | Src |
|---|---|---|---|---|---|---|---|---|
| **Makera Z1** | Makera | **200 × 200 × 100** | **13 000 rpm**, 150 W | N (`isATC=0`) | 3 (+ rot. module ⌀80×150) | printed blanks / plastics | NOT FOUND | local `/Fabrication.md` §1 |
| Nomad 3 | Carbide 3D | 203 × 203 × 76 | 130 W, 9 000–24 000 rpm, ER-11 | N | 3 | wood, plastic | $2,800 | shop.carbide3d.com/products/nomad-3 |
| Nomad 4 | Carbide 3D | 254 × 203 × 89 | 1 200 W VFD, 8 000–24 000 rpm, ER-16 | N | 3 | wood, plastic, alu | $5,400 | shop.carbide3d.com/products/nomad-4 |
| Shapeoko 4 Std/XL/XXL | Carbide 3D | 445/838/838 × 445 × 102 | 65 mm trim router | N | 3 | wood, plastic, alu | $1,800–$2,400 | shop.carbide3d.com/products/shapeoko4 |
| Shapeoko 5.1 Pro 4×4 | Carbide 3D | 4 × 4 ft (**mm NOT FOUND**) | 65 mm VFD / 80 mm VFD options | N | 3 | wood, plastic, alu | $3,800 | shop.carbide3d.com/products/shapeoko5 |
| Shapeoko HDM V3 | Carbide 3D | travel 690 × 610 × 145 | 1.5 kW (110 V) / 2.2 kW (220 V), 8–24 k rpm, ER-20 | N | 3 | alu | $5,700 | shop.carbide3d.com/products/shapeoko-hdm |
| Bantam Desktop CNC | Bantam Tools | 178 × 229 × 84 | 28 000 rpm, ER-11 | N | 3 (+4th-axis accessory) | wax, PCB, PC, HDPE, Delrin, ABS, Cu, brass, Al | $6,999 (**sold out**) | bantamtools.com/products/bantam-tools-desktop-cnc-milling-machine |
| Bantam Explorer | Bantam Tools | **NOT FOUND** | **NOT FOUND** | N | 3 | — | $3,999 (**sold out**) | …/bantam-tools-explorer-cnc-milling-machine |
| Desktop PCB mill / Othermill V2 / Pro | Bantam Tools | 140 × 114 × 41 | V2: 10 500–16 400 rpm · Pro: 8 500–26 000 rpm, ER-11 | N | 3 | PCB blanks, plastics | NOT FOUND | support.bantamtools.com 360043267374 / 360043267314 / 360043267154 |
| Artisan | Snapmaker | 400 × 400 (CNC) | 200 W, ≤18 000 rpm | N | 3 | wood, MDF, jade, CF, acrylic, PCB, alu-able | $2,099 | snapmaker.com/en-US/snapmaker-artisan/specs |
| Snapmaker 2.0 (A350 class) | Snapmaker | 320 × 335 (CNC) | 50 W, 6 000–12 000 rpm | N | 3 | wood, acrylic, PCB, CF, jade | NOT FOUND | …/snapmaker-2/specs-at |
| Carvey | Inventables | 305 × 203 × 70 | 300 W, 3 000–12 000 rpm, ER-11 | N | 3 | wood, plastic, soft metal, wax | $1,999 (2016; **discontinued**) | Wayback 2016 …/technologies/carvey |
| X-Carve Pro 4×2 | Inventables | 1 219 × 610 | 1.5 kW air-cooled, 8 000–24 000 rpm, ER16-A | N | 3 | wood, plastics, non-ferrous | $4,995 | inventables.com/pages/x-carve-pro-cnc-machine |
| X-Carve Pro 4×4 | Inventables | 1 219 × 1 219 | as 4×2; 1" ball screws, NEMA-23 | N | 3 | as 4×2 | $7,495 | inventables.com/products/x-carve-pro-4x4-cnc-machine |
| monoFab SRM-20 | Roland DG | 203.2 × 152.4 × 60.5 | 3 000–7 000 rpm (power NOT FOUND) | N | 3 | wax, chemical wood, foam, acrylic, ABS, PCB | $5,195 | rolanddga.com/products/3d/srm-20-small-milling-machine |
| MODELA MDX-50 | Roland DG | 400 × 305 × 135 | brushless DC, 4 500–15 000 rpm | **Y** (5 tools + pin) | 3 | resins/wax — **no metal** | $11,595 | rolanddga.com/products/3d/mdx-50-benchtop-cnc-mill |
| MODELA MDX-540 / 540A / S / SA | Roland DG | 500 × 400 × 155 | 400 W, 400–12 000 rpm | opt / Y | 3 (+ opt. ZCL-540 rotary) | light metals, resins | $20,995–$36,995 (**discontinued**) | Wayback 2016 rolanddga.com |
| PCNC 440 | Tormach | travel 254 × 159 × 254 | 0.56 kW, ≤10 000 rpm, R8 | opt (8-pocket) | 3 | metal | from $8,995 | tormach.com/machines/mills/pcnc-440 |
| 770M | Tormach | travel 356 × 191 × 337 | 1.12 kW, ≤10 000 rpm, R8 | opt | 3 | metal | from $11,995 | tormach.com/machines/mills/770m |
| 1100M | Tormach | travel 457 × 279 × 412 | 1.5 kW, ≤7 500 rpm, R8 | opt | 3 | metal | from $14,995 | tormach.com/machines/mills/1100m |
| 8L (lathe) | Tormach | X 114 / Z 254 | 1.11 kW, 180–5 000 rpm, 5C | — | 2 (turn) | metal | from $12,395 | tormach.com/machines/lathes/8l-lathe |
| LongMill MK3 30×30 | Sienci Labs | 813 × 813 cut | 65 mm router / 80 mm spindle (user) | N | 3 | wood, plastics | $2,210–$2,750 | sienci.com/product/longmill-mk3-30x30 |
| AltMill MK2 4×4 | Sienci Labs | 1 245 × 1 245; Z 140 | 80 mm mount, 1.5/2.2 kW options | N | 3 | wood | CAD $3,620–$4,670 | sienci.com/product/altmill |
| LEAD 1010 | OpenBuilds | X 730 | user-supplied palm router | N | 3 | wood, plastics, alu | **NOT FOUND** | docs.openbuilds.com `docs:machines:comparison` (Wayback) |
| C-Beam Machine | OpenBuilds | X 350 | user-supplied (69 mm hole) | N | 3 | wood, plastics, alu | **NOT FOUND** | openbuildspartstore.com/openbuilds-c-beam-machine (Wayback) |
| 3018-PROVer V2 | Genmitsu | 290 × 180 × 40 | 775 spindle, 42 mm | N | 3 | wood, acrylic, PCB | $269 | genmitsu.com/products/3018-prover-v2 |
| 4040-PRO | Genmitsu | 400 × 400 × 76 | 75 W, 9 000 rpm | N | 3 (+4th axis) | wood, acrylic, alu | $479 | genmitsu.com/products/4040-pro |
| PROVerXL 4030 V2 | Genmitsu | 400 × 300 × 110 | ≤400 W, 10 000 rpm | N | 3 | wood, alu | $1,199 | genmitsu.com/products/proverxl-4030-v2 |
| PROVerXL 6050 Plus | Genmitsu | 600 × 500 × 115 | 300 W, 12 000 rpm | N | 3 | wood, alu | $1,399 | genmitsu.com/products/proverxl-6050-plus |
| **Origin** (Gen 2) | Shaper | handheld, tape-referenced; auto-correct ±12 mm | brushed spindle w/ Festool | N | 2D handheld | wood, plastics | CAD $3,799 | shapertools.com/origin |
| Workstation / Plate | Shaper | fixtures: 250×465×515 / 362×450, cut window 120×160 | — | — | — | — | CAD $500 / $420 | shapertools.com/workstation · /plate |
| D.420 | Stepcraft | 297 × 414; Z 132 | Dremel 4000 / HF-500 (500 W) | N | 3 | wood, plastics | $1,899 | stepcraft.us/model-comparison |
| M.500 | Stepcraft | 348 × 544; Z 205 | HF-500 / MM-1000 class | N | 3 | wood, plastics, alu | $3,399 | stepcraft.us/model-comparison |
| Q.408 | Stepcraft | 978 × 1 442; Z 205 | MM-1650 class, 7 HP, ISO30 | **Y** (10-tool rack) | 3 | wood, plastics, alu | "under $30,000" | stepcraft.us/q-series |
| Apprentice | Onefinity | 419 × 419 × 133 | user-supplied | N | 3 | wood | from $995 | onefinitycnc.com/build-your-machine |
| Gen 2 Elite (WW/JM/FM) | Onefinity | 838 / 1 245×838 / 1 245×1 249; Z 178 | user-supplied; RapidChange EASY ATC opt | opt | 3 (+rotary) | wood | from $2,195 | onefinitycnc.com/product-page/gen2eliteseries |
| **Pocket NC V2-10** | Penta (ex Pocket NC) | 115.5 × 128.3 × 90.1; A −25…135°, **B continuous** | 200 W BLDC, 2 000–10 000 rpm, ER11 | N | **5** | Ti G5, 6061, 303 SS, wax, acetal | from $7,499 | spec-V2-10.pdf |
| Pocket NC V2-50CHB/CHK | Penta | 115.5 × 128.3 × 90.1; A −25…135°, **B continuous** (same envelope as V2-10) | NSK NR-2551/NRR-2651, **1 000–50 000 rpm**, 200 W BLDC 3-phase, 0.0001 in runout; air required (1 CFM @ 25 psi) | N | 5 | Ti G5, 6061, 303 SS, wax, acetal | from $10,799 | spec-V2-50.pdf |

**Machineless software** (grid columns only): Vectric VCarve/Aspire, Carveco Maker/Maker
Plus/Pro, Estlcam, Autodesk Fusion, LightBurn/MillMage, Easel (Inventables' own machines
are separate rows).

---

## 2. Software capability matrix

### A. Platform, licensing, reach

| Capability | MKS | MKC | C3 | BT | SM | IV | RG | TM | SC | OB | GM | SP | ST | VC | CV | ES | AD | LB | OF | PN |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Windows (native app) | Y | ? | Y | Y | Y | N | Y | N | Y | Y | Y | N | Y | Y | Y | Y | Y | Y | N | N |
| macOS (native app) | ? | ? | Y | Y | Y | N | N | N | Y | Y | Y | N | N | N | N | N | Y | Y | N | N |
| Linux (native app) | N | ? | N | N | Y | N | N | **Y** | Y | Y | Y | N | N | N | N | N | N | N | N | N |
| Runs in a browser | N | N | N | N | N | **Y** | N | Y | Y | N | N | Y | N | N | N | N | N | N | N | **Y** |
| Mobile app | P | N | N | N | P | N | N | N | N | N | P | P | P | N | N | N | ? | N | N | N |
| Free tier | Y | P | Y | Y | Y | Y | N | Y | Y | Y | Y | Y | N | P | P | Y | Y | P | Y | Y |
| Paid / subscription tier | N | N | Y | Y | N | Y | N | N | N | N | N | Y | Y | Y | Y | Y | Y | Y | N | N |
| Open source | N | N | N | N | **Y** | N | N | P | Y | Y | Y | N | N | N | N | N | N | N | N | N |
| Account required | N | **Y** | N | N | N | Y | N | P | N | N | N | Y | N | P | Y | Y | Y | P | N | N |
| Fully offline | Y | ? | Y | Y | Y | N | Y | P | Y | Y | Y | P | Y | Y | P | P | P | Y | Y | Y |

Notes on the surprising cells:

- **MKC account required = Y.** Makera CAM Beta verifies your email on first use and
  enrols only Carvera / Carvera Air purchase emails; a free trial is granted by emailing
  support. It is the only product in the sample that gates first-run behind a purchase
  email.
- **TM Linux = Y (resolved 2026-10-04).** Tormach's marketing pages never say it, but
  the vendor manual does: PathPilot is called *an operating system* and defers to the
  *LinuxCNC documentation* (UM10751 pp. 75, 133, 242). PathPilot is a LinuxCNC-derived
  **controller OS**, not an app — hence no Windows/macOS build. See
  `notes/tormach.md` §"PathPilot controller UX".
- **TM / SC browser = Y** for different reasons: PathPilot **HUB** is a cloud simulator
  with the same panel layout; gSender's **Remote mode** serves the real app over a
  browser. `MKC`'s sibling *Simulator* is on-machine, not cloud.
- **Open source**: only Snapmaker Luban (AGPLv3), gSender (GPLv3) and CONTROL (AGPL-3.0)
  are verifiably open. Tormach **claims** "free and open source" for PathPilot but no
  licence text was captured. Genmitsu open-sources nothing itself — the sender it tells
  you to install (Candle) is GPLv3.
- **GM mobile = P**: the "Genmitsu App" is a Wi-Fi module + phone sender, hardware
  rather than a software platform. **MKS mobile = P** likewise: the Makera App shows the
  camera feed, nothing else.

### B. Design & modelling

| Capability | MKS | MKC | C3 | BT | SM | IV | RG | TM | SC | OB | GM | SP | ST | VC | CV | ES | AD | LB | OF | PN |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2D vector draw/edit | N | **Y** | Y | N | N | Y | N | N | N | ? | N | Y | N | Y | Y | N | Y | Y | N | N |
| 3D modelling | N | P | P | N | N | P | N | N | N | ? | N | N | N | P | Y | N | Y | N | N | N |
| Parametric / constraint-based | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | **Y** | N | N | N |
| Text tool + multi-font | N | ? | Y | N | N | Y | N | N | N | N | N | Y | N | Y | Y | Y | Y | Y | N | N |
| Import SVG | ? | Y | Y | Y | Y | Y | N | N | N | N | N | Y | N | Y | Y | Y | Y | Y | N | N |
| Import DXF | ? | Y | Y | N | ? | Y | Y (3D) | N | N | ? | N | Y | N | Y | Y | Y | Y | Y | N | N |
| Import STL / 3D mesh | Y | Y | Y (Pro) | N | Y | Y (Pro) | Y | N | N | N | N | N | N | Y | Y | Y | Y | N | N | N |
| Import STEP / CAD | N | **Y** | N | N | N | N | Y (IGES) | N | N | N | N | N | N | N | N | N | Y | N | N | N |
| Import Gerber / PCB | N | **Y** | N | Y (sub) | N | N | N | N | N | N | N | N | N | N | N | P | Y | N | N | N |
| Image trace (raster→vector) | N | **Y** | Y | N | P | Y | N | N | N | N | N | Y | N | Y | Y | Y | N | Y | N | N |
| Stock/blank definition | P | Y | Y | Y | Y | Y | Y | P | P | ? | P | Y | N | Y | Y | Y | Y | Y | N | P |

Notes:

- **MKC is the surprise column.** Makera CAM Beta v0.2.0 has a real 2D editor, layers,
  image trace (**Trace Image**), 3D-model trace, and imports **SVG, DXF, STL, STEP and
  unzipped Gerber**. On *design* and *import* it beats the Z1's own Studio hands-down —
  and it is not sold to Z1 owners (§3).
- **ES image trace = Y** in a way nothing else in the sample matches: Estlcam machines
  pictures and **QR codes** from PNG/JPG/GIF with the spindle.
- **VC / CV 3D modelling** differ in kind: VCarve imports 3D models and cuts reliefs,
  Aspire models from scratch; Carveco Maker does *relief* only and Maker Plus adds
  sculpting. Neither is parametric.
- **AD is the only parametric modeller** in the sample, by design.

### C. Toolpaths (CAM)

| Capability | MKS | MKC | C3 | BT | SM | IV | RG | TM | SC | OB | GM | SP | ST | VC | CV | ES | AD | LB | OF | PN |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2D pocket | Y | Y | Y | P | P | Y | P | Y | N | N | N | Y | N | Y | Y | Y | Y | Y | N | N |
| 2D contour / profile | Y | Y | Y | P | P | Y | P | Y | N | N | N | Y | N | Y | Y | Y | Y | Y | N | N |
| Drilling / peck | Y | Y | N | P | P | Y | P | Y | N | N | N | N | N | Y | Y | Y | Y | Y | N | N |
| V-carve / engraving | **P** | N | Y | P | P | Y (Pro) | P | N | N | N | N | P | N | Y | Y | Y | Y | Y (Pro) | N | N |
| Chamfer | Y | Y | N | N | N | N | N | N | N | N | N | N | N | P | Y | Y | Y | Y | N | N |
| 3D relief (rough+finish) | Y | Y | Y (Pro) | N | P | Y (Pro) | Y | N | N | N | N | N | N | Y | Y | Y | Y | Y (Pro) | N | N |
| 4th axis / rotary | Y | Y | N | P | Y | N | P | Y | P | N | P | N | ? | Y (Pro) | Y | ? | Y | N | P | **Y (5-axis)** |
| Laser image / vector | Y | Y | N | N | Y | N | N | N | P | N | Y | N | P | Y (module) | Y | N | P | Y | P | N |
| Thread milling | Y | Y | N | N | N | N | N | P | N | N | N | N | N | Y | N | Y | Y | N | N | N |
| Nesting (multiple parts) | N | N | N | N | N | N | N | N | N | N | N | N | N | Y (Pro) | Y (M+) | N | N | Y (Pro) | N | N |
| Tabs / bridges | ? | Y | Y | N | N | **?** | N | N | N | ? | ? | N | N | Y | Y | Y | Y | Y | N | N |
| Ramping / helical entry | ? | Y | Y (Pro) | N | N | Y (Starter) | N | ? | ? | ? | ? | N | ? | Y | Y | **?** | Y | Y | N | N |
| Stock-to-leave / finish pass | ? | ? | N | N | N | P (2-stage) | N | **Y** | ? | ? | ? | N | ? | Y | Y | **?** | Y | Y (Profile) | N | N |
| Custom tool library | Y | Y | Y | Y | Y | Y | Y | **Y** | Y | ? | ? | Y | Y | Y | Y | ? | Y | Y | ? | Y |
| Feeds & speeds database | Y | Y | Y | Y | Y | Y | Y | **Y** | Y | N | Y | ? | Y | Y | Y | ? | Y | Y | N | Y |
| Material library | Y | Y | Y | Y | Y | Y | Y | **Y** | Y | ? | ? | Y | Y | Y | Y | ? | Y | Y | ? | ? |
| Toolpath templates / presets | ? | ? | ? | ? | ? | **P** | ? | Y | ? | ? | ? | ? | ? | Y | **Y** (Plus/Pro) | ? | Y | Y (Ops Library) | N | N |
| Post-processors / machine profiles | ? | ? | P | Y | Y | Y | ? | Y | Y | Y | Y | ? | Y | Y | Y | Y | Y | Y | N | Y |
| Plugin / scripting API | N | N | N | N | N | N | N | **P** | Y | **Y** | **Y** | N | N | Y (Gadgets) | ? | ? | Y | P | N | P |

Notes:

- **MKS V-carve = P** is the recorded anomaly from `/Makera-Parity.md`: strategy type 5
  is referenced by the binary and its config ships nowhere.
- **MKC thread milling = Y** and it is a *2D + 3D* thread miller (drill first, then
  thread the resulting hole), which is a genuinely unusual capability at this price.
- **GM / OB scripting**: Candle ships a JavaScript script window **with a debugger**;
  CONTROL publishes an API to inject GCODE into the running app.
- **CV toolpath templates = Y for Plus/Pro only (confirmed 2026-10-04).** Carveco's tier
  comparison page marks *Toolpath Templates* **not included** in base Maker, **included**
  in Maker Plus and Pro (`cc-no`/`cc-yes` in `raw/carveco/comparison.html`); Maker Plus
  describes them as *"the toolpath template file saves the original toolpath-creation
  settings… applied to vector artwork of a model"*.
- **Second-pass corrections, 2026-10-04.** Four cells that the first pass had filled
  without a source in `raw/` or `notes/` were returned to `?` or re-scored: **IV (Easel)
  tabs/bridges `Y`→`?`** — the words *tab*, *tabs* and *bridge* appear nowhere in
  `raw/inventables/` after tag-stripping; **ES (Estlcam) ramping `Y`→`?`** and
  **stock-to-leave `Y`→`?`** — a German-term sweep of `raw/estlcam/`
  (`Rampe|Rampen|Helix|schräg|eintauch`) finds nothing, and the file named `handbuch.html`
  is **byte-identical to the English landing page**, not the manual; **IV toolpath
  templates `?`→`P`** — Easel Pro's *Toolbox* saves *"the cut settings that work in your
  shop"* per bit/material, which is a settings library, not a toolpath/operation template.
  Carveco's four capabilities were *added* from evidence: bridges/tabs, ramping (both all
  tiers) and profile allowances + final pass cut (all tiers).
- **TM CAM = P, not N (corrected 2026-10-04).** PathPilot ships **conversational
  programming** — "G-code generators intended to make simple G-code programs" for OD/ID
  turning, grooves, holes/tapping, threads (UM10751 pp. 45–72) — so it is a limited
  at-machine CAM, not a pure sender. It has **no CAD or general CAM** ("For complex
  parts… we recommend you use a CAD/CAM program", p. 46) and no import of SVG/DXF/STL;
  the `N`s on the *design* rows stand. External CAM is by post-processor (they resell
  VCarve Pro $699 / Aspire $1,995).

### D. Preview & simulation

| Capability | MKS | MKC | C3 | BT | SM | IV | RG | TM | SC | OB | GM | SP | ST | VC | CV | ES | AD | LB | OF | PN |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2D toolpath preview | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| 3D toolpath preview | Y | Y | Y | Y | ? | Y | Y | P | Y | Y | Y | Y | N | Y | Y | Y | Y | Y | Y | Y |
| Material-removal simulation | **P** | **N** | Y | P | ? | Y | P | P | Y | ? | Y | P | N | Y | Y | Y | Y | Y | P | Y |
| Machining-time estimate | ? | **N** | ? | ? | ? | Y | ? | **Y** | **Y** | ? | ? | N | N | Y | Y | N | ? | Y | ? | ? |
| Collision / gouge check | ? | **N** | Y | **Y** | N | N | N | N | N | N | N | N | N | ? | N | N | Y | N | N | N |
| Before/after stock compare | Y | N | Y | Y | ? | Y | P | N | Y | ? | ? | N | N | Y | Y | N | Y | Y | ? | Y |

Notes — this is the weakest group for the incumbent, and the most actionable:

- **MKS material-removal = P, not N.** Studio ships a dexel simulator (`dexeltool.dll`),
  so the *engine* exists, but `/Makera-Parity.md` §8.1 records that the workflow still
  ends in "upload and find out". A simulator that isn't wired into the flow is the
  difference between `Y` and a usable feature.
- **MKC = N across the board.** Makera CAM Beta has **no simulation, no time estimate,
  no collision check**. `[Calculate]` "generate[s] a preview of the created tool path" —
  a static path drawing, not material removal.
- **Collision check is rare**: only Carbide 3D and Bantam Tools do it (and Bantam warns
  without blocking); Fusion does it as part of multi-axis. MillMage gets a *warning* in
  its setup wizard but the notes do not show a computed check.
- **Time estimate is rarer still** — gSender (from the file: feed range, spindle range,
  tools used, estimated cut time, min/max dimensions, *before* connecting a machine),
  Easel, Vectric (with an operator-editable scale factor), MillMage.
- **TM time estimate = Y (added 2026-10-04).** PathPilot shows a **time-remaining clock
  above a time-elapsed clock** during a run, and — once it has run a file — it **saves**
  the estimate and shows the remaining time *immediately on load*, without pressing Cycle
  Start (UM10751 release notes PP-1500, PP-2257). It also logs **cycle time** and **run
  time** (cycle minus M00/M01 dwells) and the **last executed line number** after a stop,
  "in case a program must be restarted from the middle" (PP-2181). So PathPilot's estimate
  is *learned from a prior run*, which is a different (and cheaper) method than the
  geometric estimates above — worth noting because Case Maker already has a real
  toolpath and could do both.
- **TM material-removal / 3D preview = P (added 2026-10-04).** The manual describes a
  **Tool Path display** that draws the *loaded G-code* (tool path, current line, bounding
  box) with front/side views and a G20/G21-aware grid — a file preview, not stock removal.
  The only true simulator is the **cloud PathPilot HUB**.

### E. Machine setup & control

| Capability | MKS | MKC | C3 | BT | SM | IV | RG | TM | SC | OB | GM | SP | ST | VC | CV | ES | AD | LB | OF | PN |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| First-run / machine setup wizard | N | ? | **Y** | **Y** | Y | Y | Y | Y | Y | Y | N | Y | P | N | N | Y | P | **Y** | Y | Y |
| Homing / limit config | ? | N | Y | Y | Y | P | Y | Y | Y | Y | Y | N | Y | N | N | Y | N | N | Y | Y |
| On-screen jog | ? | **N** | Y | Y | Y | Y | Y | Y | Y | Y | Y | N | Y | N | N | Y | P | Y | Y | Y |
| Keyboard jog | ? | N | Y | ? | ? | Y | Y | Y | Y | Y | Y | N | Y | N | N | Y | Y | Y | Y | Y |
| Gamepad / pendant | ? | N | Y (pendant) | N | N | N | Y (VPanel) | Y (console) | **Y** | N | N | N | Y (handwheel) | N | N | Y (gamepad/handwheel) | N | Y (pendant) | N | Y (pendant) |
| Touch probe / touch plate | P | ? | Y (BitZero) | Y | ? | Y | Y | Y | Y | Y | ? | Y | Y | N | N | Y | Y | N | P | Y |
| 3D probing / auto-level | Y | N | Y | Y | ? | P | Y | **Y** | Y | N | **Y** (heightmap) | ? | N | N | N | Y | P | N | N | N |
| Work-origin setting (XY/Z) | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | N | N | Y | Y | Y | Y | Y |
| Tool-length measurement | P | N | Y (BitSetter) | Y | ? | ? | Y | Y | Y | ? | ? | Y (Z-touch) | Y | N | N | Y | P | N | ? | **Y** (probe + TLO) |
| Tool-change prompts | P | ? | Y | Y | ? | Y | Y | Y | Y | ? | ? | N | ? | N | N | ? | ? | N | Y | Y |
| Workholding / fixture library | P | ? | Y | Y | ? | P | Y | Y | ? | ? | ? | **Y** | Y | N | N | P | P | N | P | P |
| Feed / spindle override | Y | ? | Y | Y | Y | Y | Y | Y | Y | Y | Y | N | Y | N | N | ? | N | Y | ? | Y |
| Pause / resume / start-from-line | ? | ? | Y | Y | Y | Y | Y | Y | **Y** | ? | Y | N | ? | N | N | ? | ? | Y | Y | Y |
| Multiple machine profiles | N | N | Y | Y | Y | Y (Pro) | Y | Y | Y | Y | N | N | Y | Y | Y | Y | Y | Y | N | ? |

Notes:

- **TM 3D probing = Y (corrected 2026-10-04).** The first pass marked this `N` on a
  mis-shaped search (`"3D prob|digitiz|auto-level"`, which never matches the word *probe*).
  Re-read through MegaPDF, PathPilot has a full **Probe tab**: rectangular and circular boss
  centre-finding, **inside-corner** probing, `Find Z-`, an **ETS Setup** sub-tab for the
  electronic tool setter, and **effective tip diameter** calibration against a ring gauge,
  which writes the value to tool 99 (UM10751 release notes, pp. 205–256; PP-2011, PP-2792,
  PP-2991, PP-3060). It is also the only product here that runs **Fusion 360 probe
  subroutines** — partial circular bore and boss, with per-operation size/position tolerance
  checks and a `Measure tool` / `Tool break control` option (p. 212). What it does *not*
  have is a **surface height map for auto-levelling a spoilboard** — `GM` (heightmap) stays
  the sample's only entry for that narrower meaning, and Tormach's probing is workpiece- and
  tool-setting, not bed-levelling.
- **TM job queue = N (corrected 2026-10-04).** The `Y` rested on p. 19, which is the **Main
  tab** — a list of G-code files already loaded, to **open or close**, plus MDI and a code
  viewer. Nothing queues files. In PathPilot "job" means a **conversational *step* inside one
  program** (a "job assignment", with step order and a job-assignment editor, pp. 36–38) —
  not a queued unit of work. There is no documented multi-file queue anywhere in the 257
  pages.
- **TM localisation = N (2026-10-04, absence-of-evidence call).** PathPilot documents a
  **G20/G21 units** toggle throughout, but no UI-language setting and no translation list —
  unlike LightBurn's 25-language menu or Carveco's per-sheet localisation. Recorded as `N`
  with that caveat rather than `?`.
- **SC is the standout controller UI**: gamepad support, one-click wizards (surfacing,
  stock rounding, XY squaring, axis tuning, firmware flashing), start-from-line resume
  that replays accessory state, a stats tab with maintenance countdowns and a
  **downloadable diagnostic file**, and a Config tab whose firmware settings are
  searchable, diffable ("View Modified") and import/exportable.
- **SP has almost none of the classic machine-setup rows, and that is correct** — Origin
  has no homing, no jog, no DRO, no machine profiles. Its "setup" is the tape scan, the
  **Grid** probe and **Z-Touch**, all of which are on that row set conceptually but not
  literally. Marked `N` where the concept does not exist (jog, overrides) and `Y` where
  it does (origin setting, tool-length via Z-touch).
- **BT and C3 are the two wizard showcases**: Bantam's left-rail tab wizard
  (Home → Initial Setup → Material Setup → Plan Setup → Summary/Run → Settings → Jog)
  and Carbide Motion's `Setup New Machine` flow (machine type → connect → download config
  → initialise/homing, with a switch test → test motion → configure BitSetter → spindle
  type → options).
- **C3 probing/tool-length rows are now primary-sourced** (second pass, from the BitZero V2
  guide): Carbide Motion has a **Probe** button opening a *Probe Workpiece* window, where you
  pick the **probe type** (BitZero V2 / BitSetter) and then a **cycle** — Corner (X+Y+Z),
  Z-only, or X-only/Y-only — followed by **Begin Probe**, with an on-screen graphic of the
  setup the selected cycle expects. The docs are explicit that a **probing pin** beats an end
  mill for this (flute gaps don't register at full radius) and that the probe needs a
  magnetic ground clip. **BitSetter** is an automatic tool-offset probe that measures each
  tool's length on resume, which is what makes multi-tool jobs runnable without re-zeroing Z
  by hand. The wiring is versioned: Carbide Motion **v2.4d+** boards have a purpose-built
  `Reserved` port for a probe; earlier boards need the legacy adapter cable + probe adapter
  PCB (`raw/carbide3d/bitzero-shapeoko.pdf`; `nomad3-getting-started.pdf` pp. 34–50).

### F. Job & workflow

| Capability | MKS | MKC | C3 | BT | SM | IV | RG | TM | SC | OB | GM | SP | ST | VC | CV | ES | AD | LB | OF | PN |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Job queue / multiple jobs | N | ? | N | ? | ? | N | ? | **N** | ? | ? | N | N | N | N | N | N | N | ? | N | N |
| Remote / network control | N | N | Y | N | Y | N | Y | Y | Y | Y | Y | Y | ? | N | N | N | Y | N | Y | **Y** |
| Camera / vision | **P** | N | N | N | P | N | N | N | N | N | Y | **Y** | N | N | N | N | N | **Y** | N | N |
| Built-in G-code viewer/editor | ? | ? | N | Y | Y | Y | N | Y | Y | Y | Y | N | ? | N | N | Y | Y | Y | N | Y |
| Console / MDI / macros | ? | ? | Y | Y | ? | P | N | Y | Y | Y | Y | N | ? | P | P | Y | Y | Y | Y | Y |
| Job history / statistics | ? | N | N | N | N | ? | N | **P** | **Y** | N | P | N | N | N | N | N | N | N | N | Y |
| Error recovery messaging | N | N | P | P | **Y** | P | P | P | **Y** | P | P | P | ? | N | N | ? | P | P | P | P |
| Setup sheet / operator run sheet | N | N | N | N | N | N | N | N | N | N | N | N | N | **Y** | **Y** | N | ? | N | N | N |
| Undo / redo | ? | ? | Y | ? | Y | Y | N | N | ? | ? | **Y** | Y | ? | Y | Y | Y | Y | Y | ? | ? |
| Keyboard shortcuts | ? | ? | ? | Y | ? | Y | ? | Y | **Y** | ? | Y | N | ? | Y | ? | Y | Y | Y | ? | Y |
| Localisation (non-English UI) | ? | ? | ? | ? | ? | ? | Y | **N** | ? | ? | Y | ? | Y | Y | ? | Y | Y | **Y** | ? | **Y** |

Notes:

- **LB localisation = Y (added 2026-10-04).** LightBurn's docs Language Menu reference:
  *"Change the LightBurn program interface language by selecting between 25 supported
  translations"*, with RTL auto-enabled for Arabic and Hebrew. (The *docs site* is
  machine-translated into six languages — a different list; don't conflate them.)
- **PN localisation = Y** in an unusual form: Kinetic Control ships a language **dialect**
  switch between "Industry" (machine-shop vocabulary) and "Intuitive" (plain language)
  wording of the same UI. Nothing else in the sample does this — it is a direct,
  documented answer to the "jargon vs. beginner" problem.
- **Camera = Y only where vision is load-bearing**: Shaper (the tape camera *is* the
  positioning system), LightBurn (overlay + AprilTag alignment), gSender has none.
  **MKS = P**: the Z1 has an integrated camera and Studio shows it as a **monitoring
  feed only** — no crosshair, no origin overlay (confirmed by the maintainer 2026-10-03).
  Snapmaker's `P` is printer-side AI monitoring, not milling.
- **Setup sheet = Y for exactly two products**, Vectric (job set-up sheet, editable
  header/logo, printable) and Carveco (sheet reports for each sheet in a nested job).
  Case Maker has a `RunSheetView.tsx` already in progress — see `UI-PATTERNS.md` #9.
- **SC job history = Y** is the richest in the sample: file, duration, lines, start time,
  success, per-port run time, maintenance reminders with hour countdowns, alarm/error log,
  downloadable diagnostics.

---

## 3. The Makera baseline, precisely stated

The incumbent is **not one product**. Two exist, and the split matters more than any
individual cell above.

### 3.1 Makera Studio — the Z1's only option

From local evidence (`/Makera-Parity.md`, `/Fabrication.md`), not re-researched:

- Platform: Windows desktop app (Qt). No browser, no Linux; `?` on macOS. Not open source.
- **Modelling: none.** Studio takes a mesh and cuts it.
- Strategies: 14 configs covering types 0–14 *except* 5 (V-carve — referenced by the
  binary, shipped in no config directory).
- Tool model: 129 catalogued cutters in 16 groups, 26 fields per operation tool record.
- Feeds & speeds: **1 328 rows** keyed material × cutter, **no PLA/PETG**, and **not
  machine-aware** — 32 rows exceed the Z1's 13 000 rpm ceiling.
- Output: `;@MKR|` header block, self-describing `TOOL` lines, base64 PNG thumbnail;
  motion is **linear only** (no G2/G3, no canned cycles, no G54/G10).
- Control surface: spindle/vacuum/laser/probe toggles, much of it Carvera-only strings.
- Recorded failures: 25 minidumps ending in the same paint-time Qt exception, libEGL
  failures, `ERROR::FREETYPE: Failed to load font`, three malformed "where is the part"
  dialogs, and persisted settings holding `0xCCCCCCCC` and denormals.
- Ships a dexel simulator (`dexeltool.dll`) that the documented workflow never reaches.

### 3.2 Makera CAM Beta v0.2.0 — the newer product, and it is not for the Z1

Read from `raw/makera/software-MakeraCAM_userguide.txt` and
`software-MakeraCAM_Intro.txt`, captured 2026-10-04:

- **Target machine: Carvera / Carvera Air.** The intro's headline is "Unlock the full
  potential of your **Carvera**"; the 4-axis chapter says "when the Carvera and Carvera
  Air are configured with the optional 4th Axis Module". The Z1 appears once in the whole
  user guide — in the wiki navigation tree, not as a supported machine.
- **Access is gated**: "The first time you use the software, you will need to verify your
  email… If you've purchased Carvera or participated in the Carvera Air crowdfunding,
  verify and log in using your purchase email." A free trial is by email request.
- Genuinely good CAM: `Import Image` (JPG/PNG/BMP), `Import 2D Model` (SVG/DXF),
  `Import 3D Model` (STL/STEP), `Import PCB` (unzipped Gerber), **Trace Image** and 3D-model
  trace, layers, per-tool-group import/export, a material library, tabs, ramping, and
  **2D + 3D thread milling**.
- Full 3-axis operation set: 2D Pocket / Contour / Drilling / Thread Milling / Chamfer,
  3D Relief / Pocket / Contour / Drilling / Thread Milling / Chamfer, Laser Vector /
  Laser Image, 4-Axis Rotation Relief, PCB.
- **Absent**: simulation, time estimate, collision check, jog, homing, DRO, any machine
  control. `[Calculate]` yields a *preview of the created tool path* — a drawing.
- Documentation is internally inconsistent: the intro page (edited 02/04/2026) still says
  "supporting 2D/PCB and Laser paths. 3D and Rotary path support coming soon", while the
  user guide documents all of them.

### 3.3 What the split means

Makera's newer software is better than its older software and **does not serve the Z1**.
A Z1 owner has Studio's legacy CAM, its 25 recorded crashes, its non-machine-aware feed
table and its unwired simulator — and cannot buy into the newer, cleaner CAM. Meanwhile
Studio's own manual is written for the Carvera and misdescribes the Z1.

That is the gap this project is being built into, and it is the frame for all ten
patterns in `UI-PATTERNS.md`.

---

## 4. Findings to carry into Case Maker's design

The ten actionable UI gaps, each with a saved sample, a verbatim quote and a source URL,
are in **`UI-PATTERNS.md`**. The master source index is in **`SOURCES.md`**.

Two findings that are *not* UI and belong here instead:

1. **The ecosystem is consolidating, and one member is gone.** Bantam Tools has exited
   CNC entirely (pivoted to art machines after acquiring Evil Mad Scientist) — its
   software is now legacy, kept alive only by an unchanged support knowledge base.
   OpenBuilds' domain does not resolve at all. Both are reminders that a cloud- or
   domain-dependent toolchain has a lifespan; Case Maker's local-first model is a
   deliberate counter to this.
2. **The addressable machine set is far wider than "desktop mill".** The sample spans
   3-axis routers, 5-axis mills (`PN`, TCPC), handheld routers (`SP`), lathes (`TM`),
   lasers (`LB`, `SM`, `GM`) and 3-in-1 module-swappers (`SM`). A machine-profile
   abstraction (#184) that only models "3-axis mill with a spindle" will not cover it.

### Second-pass targets (where the notes are thinnest)

The `?`-dense regions above are the honest gaps. In priority order:

> **Study closed 2026-10-09 (#228).** What is still open below is *not sourced*, not scheduled:
> Easel's logged-in editor (item 3) needs an Inventables account; Makera CAM's per-dialog
> screenshots (item 5) need a Carvera, which a Z1 owner does not have; the two truncated Stepcraft
> manuals (exactly 1 048 576 bytes, no `%%EOF`) need a re-fetch. The matching cells stay `?`.

1. ~~**Tabs, ramping, stock-to-leave, toolpath templates** across Easel / OpenBuilds CAM /
   Estlcam / Carveco~~ — **DONE 2026-10-04, with two dead ends.** Read every file in the
   four `raw/` directories. **Carveco** settled in full (bridges/tabs, ramping, profile
   allowances + final pass all tiers; templates Plus/Pro only) from its `cc-yes`/`cc-no`
   comparison matrix; **Easel** settled as far as marketing allows (ramping = Starter,
   two-stage = Basic, Toolbox cut settings = Pro; no tabs/bridges anywhere). Two dead
   ends: **Estlcam** — `raw/estlcam/handbuch.html` turns out to be a byte-identical copy
   of the English landing page, so no German manual is held and a German-term sweep finds
   nothing; **OpenBuilds CAM** — the official doc page is configuration-only and carries
   no machining features at all. Re-capturing those two is a *capture* task, not a reading
   task. See each `notes/<vendor>.md` §"Second pass".
2. ~~**PathPilot's OS and CAM relationship**~~ — **DONE 2026-10-04.** UM10751 extracted
   with **`megapdf-cli` 2.2.0** (`extract --format md|txt --page-marker`; the PDF uses
   subset-font glyph indices, so a naive FlateDecode + regex yields garbage). Resolved:
   PathPilot *is* a LinuxCNC-derived OS with conversational CAM and in-controller
   feeds/speeds. See `notes/tormach.md`.
   **Knock-on:** the `TM` column was then re-scored from the manual — `Linux (native app)`,
   `Stock-to-leave / finish pass`, `Custom tool library`, `Feeds & speeds database` and
   `Material library` went `?`→**Y**; `Plugin / scripting API` and `Job history /
   statistics` →**P**; `Setup sheet / operator run sheet`, `Undo / redo` and `Before/after
   stock compare` →**N**.
   **Three of those `N`s were wrong and are corrected in the tables above** (2026-10-04,
   second pass): `3D probing / auto-level` → **Y** (the Probe tab, pp. 205–256 — see the §E
   note), `Job queue / multiple jobs` → **N** (the old `Y` read p. 19's *file-open* list as
   a queue; PathPilot's "job" is a step inside one program), and `Localisation` → **N**
   (units toggle only, no UI language).
   **Why the original `N`s were unsafe:** they rested on `grep` patterns, not on reading the
   pages — `3D prob|digitiz|auto-level` never matches the word **probe**, and `scripting|plugin`
   does match the *support scripts* Tormach ships (PP-3593, PP-3796), so `P` stands for the
   plugin row while a `\bapi\b` search returns **zero** hits. The lesson recorded in
   `SOURCES.md`: a negated claim needs a search pattern that would have matched the positive
   case. Remaining `N`s that still rest on zero-hit searches: `run sheet|setup sheet|job
   sheet` (zero), `undo` (one hit, and it is *"To undo all changes… select Close"*, i.e. no
   undo stack), `print` (two hits, both the Fusion post's *"Print Results to the status
   screen"* option).
3. **Easel's logged-in editor** — the highest-value single capture left; every other
   Easel screenshot is marketing imagery. (Reinforced 2026-10-04: with only marketing
   pages, tapping a URL like `easel.com/product/ramping-plunges` is the floor of evidence.
   Attempted 2026-10-04: the logged-out root of `easel.inventables.com` serves the marketing
   landing page (`raw/inventables/easel-app.png`), so an account is required.)
4. ~~**LightBurn Core-vs-Pro pricing** and the LightBurn localisation list.~~ — **DONE
   2026-10-04.** Core **$99** / Pro **$199** (both product pages, Playwright — the Shopify
   `/pages/…` routes 403 to curl); Core = GCode controllers only, Pro adds DSP + Galvo;
   **25** UI translations. See `notes/lightburn.md`.
5. **Makera CAM's own screenshots** — the user guide is text-complete but the raw capture
   has only two CAM images (`software-MakeraCAM_Intro.png`, `…_tutorials.png`); per-dialog
   UI evidence for the thread-milling and PCB flows is missing.
6. ~~**Read the PDF corpus properly.**~~ — **DONE 2026-10-04.** MegaPDF's `megapdf-cli 2.2.0`
   re-extracted all 25 readable PDFs to `extracted/`; this produced the three Tormach
   corrections above, the recovered Pocket NC V2-50 specs (the "image-only" claim was
   wrong), and Carbide 3D's probe flow from the BitZero guide. It also confirmed that the
   Stepcraft **D3** and **M-Series** manuals are truncated at exactly 1 MiB (a byte-count cap,
   not a parse fault — MegaPDF issue #665), and are **different editions** from what Wayback
   serves today, so `ST`'s remaining `?`s need those two files **copied from `transfer/`**, not
   re-fetched.
   **Re-run 2026-10-05 on `megapdf-cli` 2.2.1** (`linux-v2.2.1`): the corpus was regenerated and
   the symbol-font bullet defect (#664) is now largely fixed — 938 stray `l `/`•` markers corpus-wide
   drop to 61, with 987 proper list items recovered in UM10751 alone; the 33-page residue is filed
   as MegaPDF #669. Page anchors are unchanged, so every citation above still resolves.
