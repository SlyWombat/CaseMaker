# Sources — desktop CNC software market research

**Every capture in this directory was taken on 2026-10-04** unless the row says otherwise
(a few pages were only reachable through the Wayback Machine, which is marked).

This is the master index for the study: one table per vendor, each row giving the source
URL, **what that page proves**, and the **local file** it was saved as. The rows are
generated from the per-vendor tables in `notes/*.md`, so the note is the editable copy and
this file is the consolidated view.

> **Tracking issue: [#228](https://github.com/SlyWombat/CaseMaker/issues/228).**
> Synthesis: `FEATURE-MATRIX.md` (capabilities) and `UI-PATTERNS.md` (ten UI gaps).

## What this file is, and is not

- **It is an evidence index.** Every factual claim in `FEATURE-MATRIX.md` and
  `UI-PATTERNS.md` should be traceable to a row here.
- **It is not a copy of the vendors' documentation.** Files under `raw/` are third-party
  material kept locally for reference only. They are **not redistributed, committed, or
  copied into the app** — see *Licensing* below.
- **A row is a claim about a page, not about a product.** "The page says the software has
  a simulator" and "the software has a working simulator" are different statements. Where
  the distinction matters it is called out in the note.

## Provenance rules

Inherited from `/Makera-Parity.md` and `/Fabrication.md`, applied without exception here:

1. **Every fact carries a source URL and an access date.** No URL, no claim.
2. **Unverifiable is recorded as `NOT FOUND`, never guessed.** The per-vendor notes each
   end with a *Gaps / NOT FOUND* section listing exactly what could not be established.
3. **Marketing claim vs. manual evidence are distinguished.** A product page and a user
   guide are different grades of evidence and are cited as such.
4. **Screenshots are the sample, and where a claim is visual the screenshot is read** —
   not inferred from surrounding text. Where a quoted sentence is the evidence, the page
   capture is the sample instead.
5. **Wayback captures are labelled**, because a page fetched from the archive is evidence
   about a point in time, not about today.

## Licensing

Vendor documentation, marketing pages and images under `raw/` are **third-party
copyrighted material**. They are kept locally as research reference only and:

- are **never redistributed**, published, committed to the repo, or copied into
  `casemaker-app/`;
- must not be used as assets in the product;
- may be **studied and reimplemented from** — facts, feature descriptions and UI patterns
  are not copyrightable, the files and screenshots are.

`docs/market-research/` is therefore **gitignored** (`.gitignore`, entry dated 2026-10-04).
To publish any of it deliberately, remove that ignore rule first — but do not publish the
`raw/` material itself.

## How to read the tables

- **Software codes** (`AD`, `BT`, `C3`, …) are the same short codes used as column headings
  in `FEATURE-MATRIX.md`, where §0 maps each one to a vendor.
- **Local file** is relative to `raw/<vendor>/`; where a cell shows a bare filename it lives
  in that vendor's directory. Some cells read `(text empty; html kept)` — those pages render
  entirely client-side, so the HTML is a shell and the evidence is in the screenshot.
- **`…/`** at the start of a URL continues the host of the row above it.

## Capture obstacles encountered

Recorded because they bound what this study can claim. Each was worked around; none of
these is silently absent from the matrix.

| Site | Problem | Workaround |
|---|---|---|
| `stepcraft-systems.com` | HTTP 403 (Cloudflare) to `curl` **and** to headless Playwright | Wayback used; the D3 and M-Series manuals truncated at 1 MiB with no `%%EOF`, so those two PDFs are partial |
| `openbuilds.com` + subdomains | **Do not resolve at all** (verified via DoH) | GitHub org + repo pages used instead; the storefront is gone |
| `carveco.com` | Needs a browser user-agent | Playwright; but `docs.carveco.com` does not resolve, so Carveco has no manual in this corpus |
| Autodesk live site | Akamai 403 | Wayback captures used and labelled |
| `hub.tormach.com`, `pathpilot.tormach.com` | Do not resolve | Live HUB is `hub.pathpilot.com` |
| `shop.carbide3d.com` | Blocks plain `curl` (18-byte stubs) | Playwright captures |
| `sainsmart.com` | HTTP 429 | Retried; partial |
| `support.bantamtools.com` | Cloudflare JS challenge → 403 to `curl` | Playwright renders it fine |
| `bantamtools.com` legacy routes | 301 → 404 after a Shopify replatform | Current pages found via the product sitemap |
| Dead Bantam URLs on Wayback | No snapshots exist | Historic specs taken from the live support knowledge base instead |

## Tooling notes

- **Fetcher:** `tools/fetch.mjs` — a Playwright helper. Usage:
  `node tools/fetch.mjs <url> <outBaseWithoutExt> [both|shot|html|text]`, resolving
  `playwright` from the `casemaker-app` install. Known limitation: it **screenshots before
  writing html/text**, so a screenshot timeout on a long page loses the text too — re-run in
  `text` mode to recover it.
- **Playwright is pinned at 1.61.0** (exact, no caret). 1.62.x breaks headless WebGL via
  swiftshader.
- **Not available on this machine:** `wget`, `file`, `pdftotext`, `xxd`, `tidy`.
- **PDF text is extracted with `megapdf-cli` 2.2.1** (MegaPDF's own extractor; tool of
  record since 2026-10-04 — see `README.md` §"Method & provenance" for the install). Every
  PDF in `raw/` is mirrored to `extracted/<vendor>/<name>.md` (markup) **and** `.txt`
  (page-anchored plain text) by:
  `megapdf-cli extract <file> --format md|txt --page-marker --out <out>`. The first pass
  used Python/zlib FlateDecode, then a `pypdf` venv; both are superseded.
  **Re-extracted 2026-10-05 on 2.2.1** (`linux-v2.2.1`, installed from the release tarball
  into `~/.local`): the whole corpus was regenerated, and **10 of 50 output files changed**
  — all four documents that carried the `l ` / `•` bullet defect (Tormach UM10751, Roland
  MDX-50 ×3, Carbide 3D Shapeoko 4 XL). Page markers and page counts are unchanged, so
  every page citation in these notes still resolves.
- **PDFs with no text layer** are reported by the extractor per page. In this corpus that
  is exactly **three pages** of Tormach's UM10751 (137, 187, 257), each marked inline as
  `*[Page N has no text layer]*`. **There are no image-only PDFs in the corpus** — an
  earlier claim that Pocket NC's `spec-V2-50.pdf` and `capability-statement.pdf` were
  image-only was wrong and is corrected in the tables below.
- **Two PDFs are truncated** — Stepcraft's D3 and M-Series manuals, each **exactly 1,048,576
  bytes (2²⁰ — a byte-count cap, not a document boundary)**. Both carry an intact `%PDF-1.7`
  header and the **linearization** `%%EOF` near byte 700, but **no trailing `%%EOF`**; the
  `/Linearized` `/L` values say 2,424,405 and 6,957,423 bytes, i.e. both files are ~2.3× and
  ~6.6× larger than what was saved. `megapdf-cli` **2.2.1** refuses them with **exit 10** and
  a message that names the cause — *"the file looks incomplete: 1.0 MB present, the PDF's own
  index says 2.4 MB"* — the fix shipped for MegaPDF #665 (on 2.2.0 the same files failed more
  vaguely, exit 2 / "not a valid PDF").
  **Corrected 2026-10-05:** the first pass called this "a download that stopped early" and the
  vendor notes then called it "Wayback caps the response at 1 MiB" — *neither is verified*.
  What is verified: Wayback serves the **full** file today (2,748,929 and 3,081,038 bytes,
  both with a proper trailing `%%EOF`), but those are **different editions** — their largest
  archived snapshots (2.55 MB / 2.52 MB) match neither the local files nor their `/L` values,
  and the first megabyte of the local files does **not** hash-match any snapshot's. So these
  two are **not reproducible by re-download** and must be transferred byte-exact (see
  `transfer/`, and MegaPDF issue #665).
- **A negated claim needs a search pattern that would have matched the positive case.**
  Three Tormach cells had to be re-scored on the second pass because a grep decided them:
  `3D prob|digitiz|auto-level` never matches the word **probe** (so a `Y` feature — the Probe
  tab, pp. 205–256 — was recorded `N`), a file-list page was read as a job queue, and `API`
  matches inside *r**api**d* (re-run as `\bapi\b`: **zero** hits across all five Tormach
  files). Before recording an `N`, run the pattern against a page you already know says `Y`.

---

## Consolidated source tables

### Makera (the incumbent)  `MKS` `MKC`

*Notes:* there is no `notes/makera.md` — Makera's evidence lives in the repo-root
documents, which this directory supports rather than duplicates:

- `/Makera-Parity.md` — capability inventory of **Makera Studio**, including §8 "Where
  Studio is weak" (the 25 recorded crashes, the non-machine-aware feed table, the
  unwired dexel simulator).
- `/Fabrication.md` — the CNC plan and the Z1 machine profile (#184).
- `raw/makera/` — the wiki captures below.

| Source URL | What it proves | Local file |
|---|---|---|
| https://wiki.makera.com/en/software/MakeraCAM_userguide | The full Makera CAM Beta user guide: `Retract Height` and its textual collision warning, the `[Calculate]` preview, the operation set. **"Simulat" and "jog" appear zero times.** | `software-MakeraCAM_userguide.txt` (92 KB) / `.html` |
| https://wiki.makera.com/en/software/MakeraCAM_Intro | Product intro: *"3D and Rotary path support coming soon!"*; purchase-email verification gate | `software-MakeraCAM_Intro.txt` / `.html` / `.png` |
| https://wiki.makera.com/en/software/MakeraCAM_tutorials | Feature walkthroughs (layers, Trace Image, thread milling, PCB/Gerber import) | `software-MakeraCAM_tutorials.txt` / `.html` / `.png` |
| https://wiki.makera.com/.../Speeds+and+Feeds | Studio's static material × cutter feed table (1 328 rows, 16 cutter groups, no PLA/PETG, no machine column) | `speeds-and-feeds.txt` / `.html` / `.png` |
| https://wiki.makera.com/.../Supported+Codes | The `;@MKR\|` header block and the supported G/M-code set | `supported-codes.txt` / `.html` / `.png` |
| https://wiki.makera.com/.../Z1+QuickStart | Z1 out-of-box flow and accessory setup | `Z1-QuickStart.txt` / `.html` / `.png` |
| https://wiki.makera.com/.../Z1+Accessories+Low-Profile+Vise | Z1 workholding accessory | `Z1-Accessories-Low-Profile-Vise.txt` / `.html` / `.png` |
| https://wiki.makera.com/.../Fusion360 | Makera's own third-party workflow (import `.step` → Fusion → post → import G-code) | `software-fusion360.txt` / `.html` |
| https://wiki.makera.com/.../VCarve+Desktop | Same pattern for Vectric VCarve Desktop | `software-vcarve-desktop.txt` / `.html` |
| https://wiki.makera.com/.../LightBurn | Same pattern for LightBurn (laser work on the same machine) | `software-LightBurn.txt` / `.html` |



### Autodesk Fusion 360  `AD`

*Note:* [`notes/autodesk-fusion360.md`](notes/autodesk-fusion360.md) · *raw:* `raw/autodesk/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://web.archive.org/web/2024id_/https://www.autodesk.com/products/fusion-360/overview | platform overview, machining capabilities, multi-axis, probing, extensions | `raw/autodesk/fusion-overview-archive.html`, `txt-overview-archive.txt`, `shot-fusion-archive.png` |
| https://web.archive.org/web/2023id_/https://www.autodesk.com/products/fusion-360/pricing | free personal-use quotes; product-line JSON (price not attributable) | `raw/autodesk/fp3.html` |
| https://web.archive.org/web/2024id_/https://www.autodesk.com/products/fusion-360/manufacturing-extension | toolpath strategies, toolpath modifications, 3D-print simulation, post-processor files | `raw/autodesk/manuf-ext-archive.html` |
| https://www.autodesk.com/products/fusion-360/overview (live) | blocked — 403 Akamai | `raw/autodesk/fusion-overview.html`, `.png` (403 placeholder) |
| https://help.autodesk.com/view/fusion360/ENU/?guid=CAM-SIMULATE | help shell only (6.6 KB JS), no doc text | `raw/autodesk/cam-sim.html` |


### Bantam Tools  `BT`

*Note:* [`notes/bantam.md`](notes/bantam.md) · *raw:* `raw/bantam/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://www.bantamtools.com/products/bantam-tools-desktop-cnc-milling-machine | Desktop CNC price $6,999, 28k RPM, ER-11, 7×9×3.3", sold out | product-desktop-cnc-machine.txt/.html/.png |
| https://www.bantamtools.com/products/bantam-tools-explorer-cnc-milling-machine | Explorer $3,999, 42 lb, sold out | product-explorer-cnc-machine.txt/.html/.png |
| https://www.bantamtools.com/products/bantam-tools-studio | Studio $349 art software | product-bantam-tools-studio.txt/.html/.png |
| https://core-electronics.com.au/bantam-tools-desktop-cnc-milling-machine.html | Full machine marketing specs, in-box, dry milling, 2.5D Auto-CAM | thirdparty-core-electronics-desktop-cnc.md |
| https://support.bantamtools.com/hc/en-us/articles/360043268254 | Software tabs, formats, probing, hotkeys, settings | art-software-overview.txt |
| https://support.bantamtools.com/hc/en-us/articles/360043268134 | Supported file formats base vs subscription | art-supported-file-formats.txt |
| https://support.bantamtools.com/hc/en-us/articles/360035891573 | Subscription activation (License Manager) | art-software-subscription.txt |
| https://support.bantamtools.com/hc/en-us/articles/360020547274 | Post processors; TinyG V9 controller | art-post-processor.txt |
| https://support.bantamtools.com/hc/en-us/articles/360043268274 | Custom Tool Library, json import/export | art-custom-tool-library.txt |
| https://support.bantamtools.com/hc/en-us/articles/360043268194 | Collision warnings (bed/frame) | art-collision-warnings.txt |
| https://support.bantamtools.com/hc/en-us/articles/...(Clean-Up Wizard) | Clean-Up Wizard | art-cleanup-wizard.txt |
| https://support.bantamtools.com/hc/en-us/articles/...(Conversational CAM) | Conversational CAM (subscription) | art-conversational-cam.txt |
| https://support.bantamtools.com/hc/en-us/articles/360043268314 | Speeds & Feeds Override | art-speeds-feeds-override.txt |
| https://support.bantamtools.com/hc/en-us/articles/360043267174 | Mac system requirements | art-mac-reqs.txt |
| https://support.bantamtools.com/hc/en-us/articles/360043267194 | Windows system requirements | art-win-reqs.txt |
| https://support.bantamtools.com/hc/en-us/articles/360043267374 | Desktop PCB mill full specs | art-pcb-mill-specs.txt |
| https://support.bantamtools.com/hc/en-us/articles/360043267314 | Othermill Pro specs | art-othermill-pro.txt |
| https://support.bantamtools.com/hc/en-us/articles/360043267154 | Othermill V2 specs | art-othermill-v2.txt |
| https://support.bantamtools.com/hc/en-us/articles/...(4th Axis) | 4th Axis accessory workflows | art-4th-axis.txt |
| https://toolguyd.com/bantam-tools-no-longer-sells-cnc-milling-or-pcb-machines/ | CNC exit / pivot to art machines (2025-11-11) | toolguyd-pivot.html |
| https://www.bantamtools.com/collections/cnc-store | Current store = CNC accessories + art machines | current-cnc-store.html |
| https://www.bantamtools.com/sitemap_products.xml | Current product URL set (legacy routes gone) | sitemap_products.xml |


### Carbide 3D (Create / Motion)  `C3`

*Note:* [`notes/carbide3d.md`](notes/carbide3d.md) · *raw:* `raw/carbide3d/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://carbide3d.com/ | site map, machine/software nav | home.html |
| https://carbide3d.com/carbidecreate/ | Create Core/Pro feature list, toolpaths, simulation | carbidecreate.html |
| https://carbide3d.com/carbidecreate/core-vs-pro/ | exact Core vs Pro feature matrix + pricing | carbidecreate-core-vs-pro.html |
| https://carbide3d.com/carbidecreate/pro/ | Pro $120/yr / $360 perpetual, 3D features | carbidecreate-pro.html |
| https://carbide3d.com/carbidecreate/download/ | v8 download, OS requirements | carbidecreate-download.html |
| https://carbide3d.com/carbidemotion/ | Motion features, FAQ (no tablets, works with Vectric/Fusion) | carbidemotion.html |
| https://carbide3d.com/nomad/ | Nomad 883 Pro legacy specs, bundled MeshCAM | nomad.html |
| https://carbide3d.com/shapeoko/ | product-line descriptions | shapeoko.html |
| https://guides.carbide3d.com/manuals/ | index of all product manual PDFs | guides-manuals.html |
| https://guides.carbide3d.com/start-here/download-software/ | no license codes; Create vs Motion roles | starthere-download-software.html |
| https://guides.carbide3d.com/start-here/setup-machine/ | Motion setup wizard every step | starthere-setup-machine.html |
| https://shop.carbide3d.com/collections/cnc-routers | embedded JSON: all Shapeoko/HDM prices | shop-collection-routers.html |
| https://shop.carbide3d.com/collections/nomad-desktop-cnc | embedded JSON: Nomad 3/4 prices | shop-collection-nomad.html |
| https://shop.carbide3d.com/products/shapeoko5 | 5.1 Pro price, spindle options, workholding | pw-shop-shapeoko5.html/.txt |
| https://shop.carbide3d.com/products/shapeoko4 | Shapeoko 4 sizes/specs table | pw-shop-shapeoko4.html/.txt |
| https://shop.carbide3d.com/products/shapeoko-hdm | HDM travel/table/spindle spec table | pw-shop-hdm.html/.txt |
| https://shop.carbide3d.com/products/nomad-4 | Nomad 4 cutting envelope + specs | pw-shop-nomad4.html/.txt |
| https://shop.carbide3d.com/products/nomad-3 | Nomad 3 specs | pw-shop-nomad3.html/.txt |
| https://carbide-downloads.website-us-east-1.linodeobjects.com/builds.json | current Create/Motion build numbers & dates | builds.json |
| https://guides.carbide3d.com/files/pdf/Nomad3_Getting_Started_Guide_...pdf | Nomad 3 manual | nomad3-getting-started.pdf |
| https://guides.carbide3d.com/files/pdf/shapeoko_hdm_getting_started_v1.pdf | HDM manual | shapeoko-hdm-getting-started.pdf |
| https://guides.carbide3d.com/files/pdf/shapeoko5pro_assembly_2.pdf | Shapeoko 5 Pro assembly | shapeoko5pro-assembly.pdf |
| https://guides.carbide3d.com/files/pdf/shapeoko4_xl_assembly_guide_v1-1.pdf | Shapeoko 4 XL assembly | shapeoko4-xl-assembly.pdf |
| https://guides.carbide3d.com/files/pdf/BitZero_V2_Shapeoko.pdf | BitZero V2 probing accessory | bitzero-shapeoko.pdf |
| https://carbide3d.com/assets/images/carbidecreate/*.png (etc.) | UI screenshots | cc-*.png/jpg, pro-*.png/jpg |


### Carveco  `CV`

*Note:* [`notes/carveco.md`](notes/carveco.md) · *raw:* `raw/carveco/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://carveco.com/ | homepage, ArtCAM heritage, nav | `raw/carveco/home.html` |
| https://carveco.com/carveco-software-range/ | tier overview | `raw/carveco/range.html` (text empty; html kept) |
| https://carveco.com/carveco-software-range/carveco-maker/ | Maker $17.50/mo, strategies | `raw/carveco/maker.html`, `txt-maker.txt`, `shot-maker.png` |
| https://carveco.com/carveco-software-range/carveco-maker-plus/ | 3D design tools, nesting, templates, simulation quote | `raw/carveco/maker-plus.html`, `txt-maker-plus.txt` |
| https://carveco.com/carveco-software-range/carveco/ | Pro $250/mo, $2,700/yr, $8,000 perp, AI credits | `raw/carveco/pro.html`, `txt-pro.txt` |
| https://carveco.com/carveco-software-range/product-comparison/ | full tier matrix (Maker/Plus/Pro); **values are `cc-yes`/`cc-no` spans and descriptions live in `data-tooltip`** — plain-text extraction loses both. Settles *Bridges (Breakout Tabs)*, *Ramping Moves*, *Final Pass Cut* (all tiers) and *Toolpath Templates* (Plus/Pro only) | `raw/carveco/comparison.html`, `txt-comparison.txt`, `shot-comparison.png` |
| https://carveco.com/support/frequently-asked-questions/ | Windows-only answer | `raw/carveco/faq.html` |
| https://onefinitycnc.com/shop/category/cnc-machine-software | Maker $180 / Maker+ $486 / $1,350 | `../onefinity/shot-software.txt` |
| https://carveco.com/2026/09/16/carveco-v1-68-release-notes/ | version v1.68 | feed link captured in `home.html` |


### Estlcam  `ES`

*Note:* [`notes/estlcam.md`](notes/estlcam.md) · *raw:* `raw/estlcam/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://www.estlcam.de/ (index.php) | current version 13.013, feature list, v13 license change. **Capture defect:** `raw/estlcam/handbuch.html` is byte-identical (md5 `dc71fcd2…`) to this landing page, so **no German manual is held locally** | `raw/estlcam/home.html`, `index.html`, `shot-home.png`, `shot-home.txt` |
| https://www.estlcam.de/estlcam.php | prices 49€/$59, update 19€/$23, license terms, Windows 10/11, 3 PCs | `raw/estlcam/order.html`, `txt-order.txt` |
| https://www.estlcam.de/hardware.php | open-source hardware, terminals/LPT/pendant, GRBL note | `raw/estlcam/hardware.html`, `txt-hardware.txt` |
| https://www.estlcam.de/changelog.php | version history (13.013 → 13.008), Gerber import, DXF, undo/redo | `raw/estlcam/changelog.html` |


### Genmitsu / Candle  `GM`

*Note:* [`notes/genmitsu.md`](notes/genmitsu.md) · *raw:* `raw/genmitsu/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://genmitsu.com/ | Current catalogue (3018-PROVer V2, 4040-PRO, PROVerXL …) | raw/genmitsu/genmitsu-com.html |
| https://genmitsu.com/products/3018-prover-v2 | PROVer V2 spec + $269 | raw/genmitsu/g-3018-prover-v2.html/.txt |
| https://genmitsu.com/products/4040-pro | 4040-PRO spec + $479 + GRBL/32-bit | raw/genmitsu/g-4040-pro.html/.txt |
| https://genmitsu.com/products/proverxl-4030-v2 | 4030 V2 spec, GRBL 1.1h, Candle/UGS | raw/genmitsu/g-proverxl-4030-v2.html/.txt |
| https://genmitsu.com/products/proverxl-6050-plus | 6050 Plus spec, HG-15 rails, $1,399 | raw/genmitsu/g-proverxl-6050-plus.html/.txt |
| https://www.sainsmart.com/collections/genmitsu-cnc | Store catalogue + Genmitsu App sender | raw/genmitsu/genmitsu-collection.html |
| https://www.sainsmart.com/products/genmitsu-3018-prover | Original 3018-PROVer page **404 (discontinued)** | raw/genmitsu/prover-3018.html/.txt |
| https://github.com/Denvi/Candle | Candle readme, GPLv3, features | raw/genmitsu/candle-readme.md, candle-denvi-github.html |
| https://api.github.com/repos/Denvi/Candle | stars/forks/license, v11.2 release dates | raw/genmitsu/candle-api.json, candle-releases.json |
| https://raw.githubusercontent.com/Denvi/Candle/master/help/en/… | Candle feature/UI docs + settings reference | raw/genmitsu/candle-help-*.md |
| https://github.com/Schildkroet/Candle2 | Candle 2 fork (GRBL-Advanced) | raw/genmitsu/candle2-readme.md, candle2-api.json |


### Inventables (Easel / X-Carve / Carvey)  `IV`

*Note:* [`notes/inventables.md`](notes/inventables.md) · *raw:* `raw/inventables/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://www.inventables.com/technologies/easel | "all-in-one CNC software", DESIGN/AUTOMATE/CONTROL | raw/inventables/easel-tech.html / .txt |
| https://easel.inventables.com/ (== https://easel.com/) | Browser CAD/CAM/control, 3 steps, stats (1M+/148/25/$0), gallery | raw/inventables/easel.html, easelcom-home.html |
| https://easel.com/product/easel-pro-feature-detail | Plans & pricing: Basic $0, Starter $8/$72, Pro $24/$216/$599; limits 1/20/unlimited | raw/inventables/easel-pro-detail.html |
| https://easel.inventables.com/ | Logged-out root serves the **marketing landing** (hero, gallery, 148/25 machine grid), not the editor — the logged-in design canvas remains uncaptured | raw/inventables/easel-app.png |
| https://easel.com/product/easel-pro-features | Full feature-by-plan inventory; Easel Generate pricing; 2026 changelog. Also the source for **Ramping plunges** (Starter), **Two-stage carving** (Basic) and **Toolbox** saved cut settings (Pro). *Tab*/*bridge* appear **nowhere** in `raw/inventables/` | raw/inventables/easel-pro-features.html |
| https://easel.com/partners/x-carve-pro | Carvey/X-Carve profiles; GRBL/FluidNC/grblHAL connection model | raw/inventables/easel-partner-xcarve.html |
| https://www.easel.com/sitemap.xml | 148 machine pages / 25 manufacturer partners | raw/inventables/easel-sitemap.xml, easel-urls.txt |
| https://www.inventables.com/pages/x-carve-pro-cnc-machine | X-Carve Pro positioning, $4,995 (4×2) | raw/inventables/x-carve-pro.html / .txt / .png |
| https://www.inventables.com/products/x-carve-pro-4x4-cnc-machine | 4×4 $7,495; 2hp/1.5kW 8k–24k RPM; ball screws; NEMA-23 | raw/inventables/x-carve-pro-4x4.html / .txt |
| https://www.inventables.com/products/x-carve-1 | X-Carve belt kits **sunset**; parts via CNC Maker Shop | raw/inventables/x-carve-std.html / .txt |
| http://carvey-instructions.inventables.com/ | Carvey manual (spindle replacement, parts) | raw/inventables/carvey-instructions.html, carvey-manual-spindle.html |
| https://easel.com/cms/images/features/v-carving.png | Easel editor UI: material/bit/cut-settings, V-bit picker | raw/inventables/easel-ui-vcarving.png |
| https://easel.com/cms/images/plans/design-library_*.webp | Pro Design Library UI | raw/inventables/easel-ui-designlibrary.webp |
| https://easel.com/rails/active_storage/...Screenshot... | 3D toolpath preview UI | raw/inventables/easel-ui-screenshot-oct.png |


### LightBurn / MillMage  `LB`

*Note:* [`notes/lightburn.md`](notes/lightburn.md) · *raw:* `raw/lightburn/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://lightburnsoftware.com/ | Product roles, perpetual/3-seat licensing, FAQ | raw/lightburn/home.html |
| https://lightburnsoftware.com/collections/millmage | MillMage Core $99 / Pro $199, renew $40, seats, firmware list | raw/lightburn/millmage.html |
| https://lightburnsoftware.com/products/lightburn-core | LightBurn **Core $99**; GCode controllers (GRBL, Smoothieware, Marlin, GRBL-LPC, Cohesion3D); 1 yr updates; 3 computers | raw/lightburn/lb-core.html/.txt |
| https://lightburnsoftware.com/products/lightburn-pro | LightBurn **Pro $199**; adds DSP + Galvo; upgrade = price difference | raw/lightburn/lb-pro.html/.txt |
| https://docs.lightburnsoftware.com/latest/Reference/UI/LanguageMenu/ | *"between 25 supported translations"*; RTL auto for Arabic/Hebrew | raw/lightburn/lb-languagemenu.html/.txt |
| https://docs.lightburnsoftware.com/latest/ | Docs home, version 2.1 | raw/lightburn/docs.html |
| .../latest/GetStarted/UITour/ | Main Window A–H breakdown verbatim | raw/lightburn/lb-ui-tour.html (+ shot-lb-ui-tour.png/.txt) |
| .../latest/Reference/CutsLayersWindow/ | Layer model, modes, Output/Show | raw/lightburn/lb-layers.html |
| .../latest/Reference/CutSettingsEditor/ | Line/Fill/OffsetFill/Image, sub-layers | raw/lightburn/lb-cutsettings.html |
| .../latest/Reference/Cameras/CamerasWindow/ | Overlay controls, DPM, opacity | raw/lightburn/lb-cam-window.html (+ shot) |
| .../latest/Reference/Cameras/Alignment/ | Alignment wizard, AprilTags ≥4/8, redo-on-move | raw/lightburn/lb-cam-align.html |
| .../latest/Reference/MaterialTest/ | 10×10 grid, params, config fields | raw/lightburn/lb-materialtest.html (+ shot) |
| .../latest/GetStarted/FramingBeginner/ | Bounding Box vs Rubber Band, Start From | raw/lightburn/lb-framing.html |
| .../latest/Reference/MacrosWindow/ | Macros create/manage, GCode-only | raw/lightburn/lb-macros.html |
| .../latest/Reference/ConsoleWindow/ | GRBL command reference | raw/lightburn/lb-console.html |
| .../latest/Reference/ArtLibrary/ | .lbart libs, drag-and-drop into project | raw/lightburn/lb-artlibrary.html |
| https://docs.millmagesoftware.com/latest/ | MillMage docs home, ver 0.9 | raw/lightburn/millmage-docs-latest.html |
| .../latest/Reference/UI/ | MillMage Main Window A–S element list | raw/lightburn/mm-ui.html (+ shot-mm-ui.png) |
| .../latest/Reference/Preview/ | Workpiece+toolpath preview, colour legend, time estimate | raw/lightburn/mm-preview.html (+ shot-mm-preview.png) |
| .../latest/GetStarted/ProjectSetupBeginners/ | Setup wizard steps verbatim | raw/lightburn/mm-projsetup-beginner.html |
| .../latest/GetStarted/AssigningOperations/ | Operation list, chaining, GCode export | raw/lightburn/mm-assign-ops.html |
| .../latest/GetStarted/ToolLibrary/ | Tool library, plywood presets | raw/lightburn/mm-tool-library.html (+ shot-mm-tool-library.png) |
| .../latest/Reference/OperationsLibrary/ | Save/apply preset operations | raw/lightburn/mm-ops-library.html |
| .../latest/Reference/OperationSettingsEditor/Profile/ | Profile side/cut direction/stock-to-leave | raw/lightburn/mm-profile.html |


### Onefinity (Redline / Kinetic)  `OF`

*Note:* [`notes/onefinity.md`](notes/onefinity.md) · *raw:* `raw/onefinity/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://www.onefinitycnc.com/build-your-machine | full Apprentice vs Gen 2 Elite spec table, prices | `raw/onefinity/build.html`, `txt-build.txt` |
| https://www.onefinitycnc.com/product-page/gen2eliteseries | Elite price, sizes, controller feature list, included Carveco, Filefinity | `raw/onefinity/elite.html`, `txt-elite.txt` |
| https://onefinitycnc.com/shop/category/cnc-machine-software | third-party CAM resold + USD prices | `raw/onefinity/software-cat.html`, `shot-software.txt`, `shot-software.png` |
| https://www.onefinitycnc.com/faq | FAQ topics (specs, touch screens, spindles) | `raw/onefinity/faq.html`, `txt-faq.txt` |
| https://www.onefinitycnc.com/customer-support | support landing, manuals link | `raw/onefinity/support2.html` |
| https://onefinitycnc.com/ | positioning, ecosystem | `raw/onefinity/home.html` |


### OpenBuilds CONTROL  `OB`

*Note:* [`notes/openbuilds.md`](notes/openbuilds.md) · *raw:* `raw/openbuilds/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://github.com/OpenBuilds/OpenBuilds-CONTROL | CONTROL repo, README, screenshot | raw/openbuilds/obcontrol-github.html, obcontrol-readme.md |
| https://api.github.com/repos/OpenBuilds/OpenBuilds-CONTROL | stars/forks/license/version metadata | raw/openbuilds/obcontrol-api.json |
| https://raw.githubusercontent.com/OpenBuilds/OpenBuilds-CONTROL/master/package.json | AGPL-3.0, name/description, v1.0.390 | raw/openbuilds/obcontrol-package.json |
| https://api.github.com/repos/OpenBuilds/OpenBuilds-CONTROL/releases | release artifacts/date | raw/openbuilds/obcontrol-releases.json |
| https://github.com/OpenBuilds/OpenBuilds-CONTROL/wiki | Pi4 install, GCODE API, devtools | raw/openbuilds/obcontrol-wiki.html |
| https://docs.openbuilds.com/doku.php?id=docs:software:openbuilds-control | CONTROL feature list + workflow | raw/openbuilds/doc-docs-software-openbuilds-control.html |
| https://docs.openbuilds.com/doku.php?id=docs:software:openbuilds-cam | OpenBuilds CAM web tool — **configuration only**: *"Select the relevant CNC controller, Machine and Tools from the Dropdown lists"*. This page carries **no machining-feature content**, which is why the matrix's tabs/ramping/stock-to-leave/template cells for `OB` are `?` | raw/openbuilds/doc-docs-software-openbuilds-cam.html |
| https://docs.openbuilds.com/doku.php?id=docs:software:overview | CAM vs sender split | raw/openbuilds/doc-docs-software-overview.html |
| https://docs.openbuilds.com/doku.php?id=docs:machines:comparison | Machine spec table | raw/openbuilds/doc-docs-machines-comparison.html |
| https://openbuildspartstore.com/lead-cnc-1010-40-x-40-1/ | LEAD 1010 kit description | raw/openbuilds/obstore-lead1010-archive.html |
| https://openbuildspartstore.com/openbuilds-c-beam-machine/ | C-Beam kit contents | raw/openbuilds/obstore-cbeam-archive.html |
| https://openbuilds.com/ (Wayback) | home/store navigation, machine names | raw/openbuilds/ob-home-archive.html |
| https://openbuilds.com/pages/control | **NOT captured — page deleted/not archived at this path** | raw/openbuilds/ob-control-archive.html (Wayback error stub) |


### Pocket NC / Penta (Kinetic Control)  `PN`

*Note:* [`notes/pocketnc.md`](notes/pocketnc.md) · *raw:* `raw/pocketnc/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://www.pentamachine.com/software | Kinetic Control overview, TCPC explanation, browser UI | penta-software-text.txt / software-1.html |
| https://www.pentamachine.com/post-processor | Supported CAM/post-processors, tool libraries, simulator | penta-post-processor-text.txt |
| https://www.pentamachine.com/penta-rebrand | Pocket NC → Penta rebrand, founding story | penta-rebrand-text.txt |
| https://www.pentamachine.com/store (V2-10) | V2-10 from $7,499 + accessories/prices | penta-v2-10-text.txt, all-products.html |
| https://www.pentamachine.com/store (V2-50) | V2-50CHB/CHK from $10,799, spindle $1,037 | penta-v2-50-text.txt |
| https://www.pentamachine.com/faq | FAQ topic list (specs/power/workholding) | penta-faq-text.txt |
| https://www.pentamachine.com/user-resources | Pocket NC + Solo user-resource hubs | penta-user-resources-text.txt |
| https://www.pentamachine.com/machine-support | Troubleshooting quizzes + support form | penta-machine-support-text.txt |
| https://pentamachine.atlassian.net/wiki/spaces/KCUR/pages/1727660098 | Full Kinetic Control UI walkthrough (pages, gauges, offsets, MDI, config) | kc-software-overview.txt/.png |
| …/KCUR/pages/581074945 | KC version history (latest v5.8.2, 2025-02-10) | kc-software-versions.txt |
| …/KCUR/pages/1727725635 | KC installation (microSD on Beaglebone) | kc-install-guide.txt |
| …/KCUR/pages/1774551045 | G-code = LinuxCNC interpreter + TCPC/RWO/Unwind | kc-gcode-overview.txt |
| …/KCUR/pages/580976641 and 2245591091 | Software Updates / Tutorials index | kc-software-updates.txt, wiki-kcur-tutorials.txt |
| https://pentamachine.atlassian.net/wiki/spaces/PNFUR/... | PNFUR announcements (Kinetic Control 2021-11-01; RWO 2021-04-01) | wiki-announcements.txt |
| …/PNFUR/.../Getting+Started | Start-here, manuals, tool libraries, V2-10 speeds/feeds | wiki-getting-started.txt, wiki-usermanual.txt |
| …/PNFUR/.../V2-10+Speeds+and+Feeds | Speeds/feeds method (8,500 RPM, 13.6 in/min alu example) | wiki-v2-10-speeds-feeds.txt |
| …/PNFUR/.../Keyboard+Shortcuts | V2 keyboard jog shortcuts | wiki-keyboard-shortcuts.txt |
| …/PNFUR/.../Pocket+NC+User+Resources (redirect) | Old KC overview page | pocketnc-wiki-overview.txt/.png |
| https://www.pocketnc.com (spec PDF, direct) | V2-10 full spec sheet | spec-V2-10.pdf |
| https://www.pocketnc.com (spec PDF, direct) | V2-50 spec sheet — envelope, NSK spindle, control, backlash | spec-V2-50.pdf |
| https://www.pocketnc.com (manual PDF) | V2 Series User's Manual | penta-manual-48040-46_en-2.pdf |
| https://www.pocketnc.com (PDF) | Capability statement — company profile, clients, use case | capability-statement.pdf |


### Roland DG (SRP Player / VPanel)  `RG`

*Note:* [`notes/roland.md`](notes/roland.md) · *raw:* `raw/roland/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://www.rolanddga.com/ | Brand/site map; product taxonomy (monoFab/MODELA/DGSHAPE) | rolanddga-home.html |
| https://www.rolanddga.com/products/3d/srm-20-small-milling-machine | SRM-20 price, envelope, spindle 3000–7000 rpm, cuttable materials, RML-1/NC, weight | srm20.html, srm20-page.png, og_srm20.jpg |
| https://www.rolanddga.com/products/3d/mdx-50-benchtop-cnc-mill | MDX-50 price $11,595, envelope, 4.5–15k rpm, 5-tool ATC, materials (no metal), VPanel quote | mdx50.html, mdx50-page.png, og_mdx50.jpg |
| https://www.rolanddga.com/products/engraving-machines/srm-20-compact-mill-and-engraver-solution | SRM-20 engraver variant; VPanel image | srm20-engraver.html |
| https://www.rolanddga.com/applications/rapid-prototyping/srp-workflow | SRP Player 5-step wizard; "no feeds and speeds…" quotes; wizard screenshots (1/2/3) | srp-workflow.html, srp-page.png, srpworkflow1-3.jpg |
| https://www.rolanddga.com/products/software | Software catalogue incl. SRP Player, Roland DG Connect, VCarve | software.html |
| https://www.rolanddga.com/products/software/roland-dg-connect | DG Connect features + free plan | roland-dg-connect.html |
| https://www.rolanddga.com/support/products/software/clickmill | ClickMill support page exists (title) | clickmill.html, clickmill_scrnsht.jpg |
| https://image.rolanddga.com/-/media/roland/.../vpanel_srm20_en.png | VPanel UI (control panel layout) | vpanel_srm20_en.png (also embedded in srm20.html) |
| https://public.rolanddga.com/brochures/products/3d/monoFab_Brochure.pdf | monoFab/SRM-20 brochure | monoFab_Brochure.pdf |
| https://public.rolanddga.com/brochures/products/3d/MDX-50_Brochure.pdf | MDX-50 brochure | MDX-50_Brochure.pdf |
| https://public.rolanddga.com/brochures/.../srm_datasheet.pdf | SRM-20 datasheet | srm_datasheet.pdf |
| https://image.rolanddga.com/-/media/roland/files/solution/3d-tech-brief_emailres.pdf | SRP technical brief (PDF) | 3d-tech-brief.pdf |
| https://web.archive.org/web/20160201155434/https://www.rolanddga.com/products/3d/mdx-540-benchtop-milling-machine | MDX-540 discontinued: travel, 4th axis + ATC, prices ($20,995–$36,995) | wayback-mdx540.html |
| https://web.archive.org/web/20151005010420/.../mdx-540-.../specifications | MDX-540 spindle 400–12,000 rpm, servo, feed, table | wayback-mdx540-specs.html |
| https://web.archive.org/web/20150911190824/.../mdx-40a-benchtop-cnc-mill | MDX-40A $7,995, 12×12×4.1 in volume, 4-axis SRP Player bundle, ZCL-40A $3,699 | wayback-mdx40a.html |
| https://web.archive.org/web/20151003065003/.../mdx-40a-.../specifications | MDX-40A spindle 4,500–15,000 rpm 100 W; ZSC-1 scanner; Windows Vista/XP | wayback-mdx40a-specs.html |
| https://web.archive.org/web/20190718045706/.../use-v-panel-to-control-the-data-feed-output-speed-of-the-mdx-540-series | VPanel used to control feed/output speed on MDX-540 | wayback-vpanel-blog.html |
| https://web.archive.org/web/20230205002155/https://www.rolanddga.com/en-la/support/products/software/clickmill | ClickMill support page (wayback) | wayback-clickmill.html |
| https://downloadcenter.rolanddg.com/ | Roland Download Center (manual host) | downloadcenter.html |
| https://global.rolanddg.com / https://www.rolanddg.com | Global Roland DG (manual host domain) | (search-referenced) |


### Shaper (Origin / Studio / Trace)  `SP`

*Note:* [`notes/shaper.md`](notes/shaper.md) · *raw:* `raw/shaper/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://www.shapertools.com/origin | Origin pitch, auto-correct 12 mm, specs, price, bundles | raw/shaper/origin.html, shot-origin.png |
| https://www.shapertools.com/studio | Studio licensing/pricing, sync semantics | raw/shaper/studio.html, shot-studio.png |
| https://www.shapertools.com/trace | Trace specs, one-time purchase | raw/shaper/trace.html |
| https://www.shapertools.com/plate | Plate dims, cut window, System 32 | raw/shaper/plate.html |
| https://www.shapertools.com/workstation | Workstation specs, T-track, shelf, fence | raw/shaper/workstation.html |
| https://www.shapertools.com/hub | ShaperHub project/template library | raw/shaper/hub.html |
| https://support.shapertools.com/ | Help Center tile list (BenchPilot, AutoPass, Caliper…) | raw/shaper/support-home.html |
| .../articles/115002894673-cut-types | Cut types verbatim | raw/shaper/ui-cut-types.html |
| .../articles/115002894693-cut-offset | Offset behaviour verbatim | raw/shaper/ui-cut-offset.html |
| .../articles/115002904714-cut-depth | Depth presets/Aircut/Encoded Depth verbatim | raw/shaper/ui-cut-depth.html |
| .../articles/115002904354-creating-a-grid | Grid probing workflow verbatim | raw/shaper/ui-grid.html |
| .../articles/115002904814-z-touch | Auto/manual z-touch verbatim | raw/shaper/ui-z-touch.html |
| .../articles/115002818893-add-to-scan | Add to Scan workflow | raw/shaper/ui-add-to-scan.html |
| .../articles/115002894073-using-the-pen-tool | Pen tool / trace workflow | raw/shaper/ui-pen-tool.html |
| .../articles/115002904434-returning-to-a-workspace | Workspace memory verbatim | raw/shaper/ui-workspace-return.html |
| .../articles/115003218014-tape-visibility-indicator | Tape indicator meanings | raw/shaper/ui-tape-visibility.html |
| .../articles/115002790213-using-shapertape | Tape layout rules | raw/shaper/ui-shapertape.html |
| .../articles/115002740713-what-does-auto-correct… | Auto-correct quote | raw/shaper/ui-auto-correct.html |
| .../articles/10126394917915-general-user-interface-pre-cut | AutoPass UI elements 1–11 | raw/shaper/ui-autopass-precut.html |
| https://support.shapertools.com/autopass | AutoPass feature map | raw/shaper/autopass-support.html |
| .../articles/1500001307001-product-manual-of-shaper-origin-gen-1 | Gen-1 product manual (all languages) | raw/shaper/origin-manual.html + origin-manual-gen1-en.pdf (1.19 MB) |
| .../articles/12110889294875-quick-start-guide…origin-gen-2 | Gen-2 quick/safety guides | raw/shaper/origin-gen2-quickstart.html + origin-gen2-quickguide.pdf (338 KB, ZZEOF) |


### Sienci Labs (gSender)  `SC`

*Note:* [`notes/sienci.md`](notes/sienci.md) · *raw:* `raw/sienci/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://sienci.com/ | Brand, LongMill/AltMill line, store | raw/sienci/sienci-home.html |
| https://sienci.com/product/longmill-mk3-30x30/ | MK3 specs, price, grblHAL SLB-LITE | raw/sienci/sienci-longmill-mk3-30x30.html |
| https://sienci.com/product/altmill/ | AltMill 49×49, 600 IPM, CAD price | raw/sienci/sienci-altmill.html |
| https://sienci.com/product/longmill-mk2/ | MK2 page 404 (discontinued) | raw/sienci/sienci-longmill-mk2.html |
| https://sienci.com/gsender/ | gSender marketing page | raw/sienci/sienci-gsender.html |
| https://github.com/Sienci-Labs/gsender | README feature list, GPLv3, version 1.6.4 | raw/sienci/gsender-readme.md, gsender-github.html |
| https://api.github.com/repos/Sienci-Labs/gsender | Stars/forks/language/license metadata | raw/sienci/gsender-api.json |
| https://resources.sienci.com/view/gs-using-gsender/ | Jog, zero/GoTo, probing, start-from-line, safety | raw/sienci/doc-gs-using-gsender.html (+.body.txt) |
| https://resources.sienci.com/view/gs-setup-and-layout/ | UI layout, tabs, stats, config, wizards, gamepad | raw/sienci/doc-gs-setup-and-layout.html (+.body.txt) |
| https://resources.sienci.com/view/gs-edge-features/ | Edge beta channel model | raw/sienci/doc-gs-edge-features.html |
| https://sienci.com/product-category/longmill/ | Product line, accessories, gControl | raw/sienci/longmill-plp.html |


### Snapmaker (Luban)  `SM`

*Note:* [`notes/snapmaker.md`](notes/snapmaker.md) · *raw:* `raw/snapmaker/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://snapmaker.com/en-US/snapmaker-artisan/specs | Artisan full specs (work areas, spindle, laser, materials) | raw/snapmaker/artisan-specs.html |
| https://snapmaker.com/en-US/snapmaker-2/specs-at | 2.0 specs | raw/snapmaker/sm2-specs.html |
| https://snapmaker.com/en-US/j1s-idex-3d-printer/specs | J1s specs | raw/snapmaker/j1s-specs.html |
| https://snapmaker.com/en-US/snapmaker-ray.../specs | Ray specs | raw/snapmaker/ray-specs.html |
| https://snapmaker.com/en-US/snapmaker-u1/specs | U1 specs, Klipper, Orca | raw/snapmaker/u1-specs.html |
| https://snapmaker.com/en-US/snapmaker-luban | Luban: open source, CNCjs/CuraEngine lineage, machines, 3-/4-axis | raw/snapmaker/luban-page.html / .txt |
| https://snapmaker.com/en-US/snapmaker-orca | Orca: built on Orca Slicer, U1, remote | raw/snapmaker/orca-page.html / .txt |
| https://snapmaker.com/en-US/snapmaker-app | Mobile App features | raw/snapmaker/snapmaker-app.html / .txt |
| https://github.com/Snapmaker/Luban | Repo, AGPL, README | raw/snapmaker/github-luban.html |
| https://raw.githubusercontent.com/Snapmaker/Luban/main/README.md | AGPLv3, CNCjs/LunarSlicer, 3-in-1 quote | raw/snapmaker/luban-README.md |
| https://raw.githubusercontent.com/Snapmaker/Luban/main/package.json | v4.15.2, Electron/React/Redux/three, AGPL-3.0-or-later | raw/snapmaker/luban-package.json |
| https://raw.githubusercontent.com/Snapmaker/Luban/main/LICENSE | AGPLv3 text | raw/snapmaker/LICENSE.txt |
| https://user-images.githubusercontent.com/3749551/219274513-...jpg | Luban UI screenshot | raw/snapmaker/luban-readme-screenshot.jpg |
| https://snapmaker.com/en-US-sitemap.xml | Real locale-prefixed product/spec URLs | raw/snapmaker/en-US-sitemap.xml |
| https://snapmaker.com/blog/tag/snapmaker-academy | Academy tutorial library | raw/snapmaker/academy.html |
| https://snapmaker.com/en-US/snapmaker-artisan (Playwright) | Live price $2,099 | raw/snapmaker/artisan-rendered.html/.txt |
| https://snapmaker.com/en-US/snapmaker-u1 (Playwright) | Live price From $849 | raw/snapmaker/u1-rendered.html/.txt |


### Stepcraft (UCCNC)  `ST`

*Note:* [`notes/stepcraft.md`](notes/stepcraft.md) · *raw:* `raw/stepcraft/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://stepcraft.us/ | US nav, series list, support/training structure | raw/stepcraft/us-home.html |
| https://stepcraft.us/model-comparison/ | Full 3-column spec table + prices + JPS | raw/stepcraft/us-model-comparison.html (+ shot-us-model-comparison.png) |
| https://stepcraft.us/d-series/ | D-Series features, 5-yr warranty | raw/stepcraft/us-d-series.html (+ shot-us-d-series.png) |
| https://stepcraft.us/m-series/ | M-Series features, Freestyle Milling, Semi-Closed-Loop | raw/stepcraft/us-m-series.html |
| https://stepcraft.us/q-series/ | Q.408 specs (1400 in/min, 7HP ATC, vacuum, JPS) | raw/stepcraft/us-q-series.html |
| https://stepcraft.us/milling-spindle-comparison/ | Spindle table (Dremel/HF-500/…) | raw/stepcraft/us-spindle-comparison.html |
| https://stepcraft.us/manuals/ | Manual/download link index | raw/stepcraft/us-manuals.html |
| https://stepcraft.us/uccncinstall/ | UCCNC installer steps, profiles, controllers | raw/stepcraft/us-uccncinstall.html |
| https://shop.stepcraft.us/shop/20709-uccnc-control-software-oem-package-140 | UCCNC OEM $349 contents | raw/stepcraft/us-uccnc-oem.html |
| https://web.archive.org/web/2024/https://stepcraft-systems.com/en/ | EU nav incl. Control Software, CNC Remote App | raw/stepcraft/wb-eu-home.html |
| https://web.archive.org/web/20160715234437/https://www.stepcraft-systems.com/en/accessories/software/uccnc-control-software | UCCNC "Software" page + manual tree | raw/stepcraft/wb-uccnc-control-sw.html |
| https://stepcraft-systems.com/download/20230619_UCCNCv36_QuickStartGuide_DE_EN.pdf (direct 403; via wayback 20250507054952) | UCCNC install/start, profiles, firmware update | raw/stepcraft/manual-uccnc-quickstart.pdf (8.12 MB, complete %%EOF) |


### Tormach (PathPilot)  `TM`

*Note:* [`notes/tormach.md`](notes/tormach.md) · *raw:* `raw/tormach/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://tormach.com/ | Brand/site map; machine catalogue (mills, lathes, routers, robots) | tormach-home.html |
| https://tormach.com/machines/mills.html | Mill range overview | mills.html |
| https://tormach.com/machines/mills/pcnc-440.html | PCNC 440 travels, 0.75 hp/10k rpm, feeds, weight, "Starting at $8,995", machine-only = base mill + PathPilot controller + free PathPilot updates | pcnc440.html |
| https://tormach.com/machines/mills/770m.html | 770M travels, 1.5 hp, table, "from $11,995" | 770m.html |
| https://tormach.com/machines/mills/1100m.html | 1100M travels, 2 hp/7.5k rpm, footprint/weight, "from $14,995" | 1100m.html |
| https://tormach.com/machines/lathes/8l-lathe.html | 8L travels, 1.5 hp/5,000 rpm/5C, swing 200 mm, "from $12,395" | 8l-lathe.html |
| https://tormach.com/pathpilot-cnc-controller | PathPilot feature list (macros, HSM, conversational, 90 GB, Dropbox, WiFi, USB I/O); HUB description | pathpilot-controller.html, shot-pathpilot.png/.html/.txt |
| https://hub.pathpilot.com/about | HUB = free cloud simulator; 3-hour controller; sync/download to machine | pathpilot-hub-about.html, shot-hub-about.png |
| https://hub.pathpilot.com/ | HUB login (app shell) | pathpilot-hub.html |
| https://tormach.com/support/software/pathpilot-documents | Manual catalogue (UM10751, TD10358, shortcuts, TD10345, TD10530, install guides) | pathpilot-documents.html |
| https://tormach.com/docs/download/assetlink/asset_id/637 | PathPilot User Guide for Lathes (UM10751) — **the primary source for the Tormach row**: PathPilot is a *LinuxCNC-based OS* (pp. 75, 133, 242); conversational CAM (pp. 45–72); feeds/speeds suggestions from material+sub-type+tool with green/white provenance (pp. 122–124); time-remaining clock + logged last line (PP-1500/2181/2257); toolpath preview (pp. 44–45); E-stop dashcam (p. 90); tool-table CSV (pp. 134–135); **Probe tab incl. Rect/Circ, ETS Setup, inside-corner, A-axis centre and effective tip diameter, and Fusion 360 bore/boss probe subroutines with size/position tolerance (pp. 205–256 — corrected 3D-probing cell)**. Text via `megapdf-cli` 2.2.1 (3 pages have no text layer: 137, 187, 257) | PathPilot_UserGuide_Lathes_UM10751.pdf |
| https://tormach.com/docs/download/assetlink/asset_id/122 | PathPilot Controller Quick-Start Guide | PathPilot_QuickStart_TD10358.pdf |
| https://tormach.com/docs/download/assetlink/asset_id/583 | PathPilot Shortcuts Cheat Sheet | PathPilot_Shortcuts_CheatSheet.pdf |
| https://tormach.com/docs/download/assetlink/asset_id/441 | Networking the PathPilot Controller | PathPilot_Networking_TD10345.pdf |
| https://tormach.com/docs/download/assetlink/asset_id/16 | Upgrading to PathPilot v2.0.x (version evidence) | Upgrading_to_PathPilot_v2_TD10530.pdf |
| https://tormach.com/support/software/pathpilot/pathpilot-updates-and-notes | PathPilot release downloads; robot v3.2.4/3.2.8 | pathpilot-updates.html |
| https://tormach.com/machine-upgrades/software.html | Third-party CAM prices: Aspire $1,995, VCarve Pro $699 | upgrades-software.html |
| https://tormach.com/support/software/post-processor-downloads | Post-processor downloads | post-processors.html |
| https://tormach.com/pathpilot-v20-upgrade-38249.html | PathPilot v2.0 USB upgrade SKU; v1.9.13 legacy | pathpilot-v20.html |
| https://tormach.com/pcnc-440 (footprint PDF) | PCNC 440 machine footprint | pcnc440.html (link) |
| https://tormach.com/media/asset/.../td10351_pcnc440_cert_inspect_1120a.pdf | PCNC 440 inspection cert (PDF) | (link in pcnc440.html) |


### Vectric (VCarve / Aspire)  `VC`

*Note:* [`notes/vectric.md`](notes/vectric.md) · *raw:* `raw/vectric/`

| Source URL | What it proves | Local file |
|---|---|---|
| https://www.vectric.com/products/vcarve | product, pricing from, Desktop/Pro split, full feature list | `raw/vectric/vcarve-prod.html`, `txt-vcarve.txt`, `shot-vcarve.png` |
| https://www.vectric.com/products/cut2d | Cut2D product, from-price, Desktop/Pro split | `raw/vectric/cut2d.html`, `txt-cut2d.txt` |
| https://www.vectric.com/products/aspire | Aspire 3D relief, price, tutorials | `raw/vectric/aspire-prod.html`, `txt-aspire.txt`, `shot-aspire.png` |
| https://www.vectric.com/compare | feature matrix + compare prices + upgrade prices | `raw/vectric/txt-compare.txt` |
| https://www.vectric.com/products/advanced-machining-module | AMM cabinet nest/drill bank/cutter comp | `raw/vectric/amm.html`, `txt-amm.txt` |
| https://www.vectric.com/support/system-requirements | OS/RAM/GPU requirements, Spark=mac | `raw/vectric/sysreq.html`, `txt-sysreq.txt` |
| https://www.vectric.com/support/tutorials/aspire | tutorial library | `raw/vectric/tutorials-aspire.html` |
| https://onefinitycnc.com/shop/category/cnc-machine-software | USD prices (VCarve Desktop $349/Pro $699/Aspire $1995) | `../onefinity/shot-software.txt` |
