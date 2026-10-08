# The Makera Studio library database — schema, join and one row from each table (2026-10-08, #307)

**What this is.** The real, verbatim schema of Makera Studio's SQLite catalogue, taken from this
PC's install. Before this, `Makera-Parity.md` §3/§5 and `/Fabrication.md` §3 carried the *fields*
in camelCase prose and the row counts, but not one real column name, not the join key, and not the
cutter's primary key. Every catalogue-shaped child of #212 was blocked on it. This is a **desk
task** — the machine at `192.168.10.43` was not involved and its plug was not switched.

**Where the result went.** `Makera-Parity.md` §3.2/§3.3 (the tool model, verbatim) and §5 (stock,
materials, feeds). This file is the dump itself and the method.

## How it was taken — read-only, on a copy

Studio's own handle must never be contended, and nothing may be written or migrated
(`/Fabrication.md` §3, #186). So the file was **copied to a scratch directory first** and the copy
opened **immutable**:

```python
import sqlite3
db = "<scratch>/makera_library.db"                     # a copy, not %APPDATA%'s file
con = sqlite3.connect(f"file:{db}?mode=ro&immutable=1", uri=True)
```

`mode=ro` opens it read-only and `immutable=1` tells SQLite the file cannot change, so it skips all
locking — the source file's own handle (Studio's) is never touched. Source:
`%APPDATA%/MakeraStudio/makera_library.db`, **14 073 856 bytes**, file dated **2026-10-06**; read
from WSL via `/mnt/c/Users/<user>/AppData/Roaming/MakeraStudio/makera_library.db`. Column names came
from `PRAGMA table_info(<table>)`; rows from `SELECT * … LIMIT 1`. The dump is **not committed** —
only schema and one row per table, per the constraint above.

## The tables (22)

`t_CalcCutterList`, `t_CustomerCutterGroup`, `t_CustomerCutterProperties`, `t_MachineResourceFiles`,
`t_MachineResourceParameters`, `t_MakeraCutterGroup`, `t_MachineType`, `t_MakeraCutterProperties`,
`t_SystemParameters`, `t_SkuMapping`, `t_CutterInventoryList`, `t_DeletionQueue`,
`t_CustomCutterList`, `t_MaterialCategory`, `t_MakeraCutterList`, `t_CutterCategory`,
`t_MaterialSpecs`, `t_CustomerMaterialList`, `t_MaterialList`, `t_CustomerMaterialSpecs`,
`t_MyDeviceList`. (Plus `t_CustomerMaterialList`.) Every table that describes a cutter or a material
keys on a **time-ordered UUID** and carries `lastUpdateDate`.

## One complete row from each, column names beside the values

**`t_MakeraCutterList`** — the 3.175 mm flat that `TopClamp.nc` names. (Already in #307's earlier
comment; repeated here so this file stands alone.)

| column | value |
|---|---|
| `cutterId` | `019c049a-8169-7633-8723-74b49e391948` |
| `groupId` | `019c04b5-2e1e-7b1e-a93a-a6b564865c50` (= "Single Flute Metal") |
| `cutterName` | `3.175*12mm Flat End(Metal)` |
| `cutterNumber` | 4 |
| `cutterCategoryId` | 1 (Flat End) |
| `cutterDiameter` | 3.175 |
| `cutterStickoutLength` | `''` — empty **string**, not NULL |
| `cutterShoulderLength` | 12.0 |
| `cutterFluteLength` | 12.0 |
| `cutterMaxDiameter` | 3.175 |
| `cutterTipDiameter` | 3.175 |
| `cutterCornerRadius` | `''` |
| `cutterAngle` | `''` |
| `cutterHalfAngle` | `''` |
| `threadSpecification` | `''` |
| `pitch` | `''` |
| `threadAngle` | `''` |
| `drillDiameter` | `''` |
| `sellProduct` | 1 |
| `g_ID` | `112111313812` |
| `metalDuty` | 1 |
| `lastUpdateDate` | `2026-…` |

**`t_MakeraCutterProperties`** — one row for that same cutter (it carries 13, one per rated
material; this is the 7075-aluminium one).

| column | value |
|---|---|
| `propertiesId` | `019c2c27-953a-73ad-b7fe-1566492c73d8` |
| `materialId` | `019bfae0-a419-7718-88a0-ca1275ef5d9b` → **7075 Aluminum** |
| `cutterID` | `019c049a-8169-7633-8723-74b49e391948` |
| `spindleSpeed` | 12000 |
| `feedRate` | 500 |
| `plungeFeedRate` | 200.0 |
| `stepDown` | 0.2 |
| `stepOver` | 2.0 |
| `stepOverPercent` | 63.0 |
| `coolant` | 1 |

**`t_MaterialList`** — the PCB row.

| column | value |
|---|---|
| `materialID` | `019bfae0-a419-71af-8eaa-b742dfe827dd` |
| `materialCategoryID` | `019bfadc-e599-776d-b16b-b8b7e5a7b4ad` → **PCB** |
| `materialSubcategoryName` | `PCB` |
| `lastUpdateDate` | NULL |

**`t_MaterialSpecs`** — the first purchasable PCB blank.

| column | value |
|---|---|
| `materialSpecsID` | `019bfaeb-939b-73b1-bd90-5cfb9c8cd049` |
| `materialID` | `019bfae0-a419-71af-8eaa-b742dfe827dd` → PCB |
| `materialName` | `1.5mm Blank PCB Boards - Single Sided / 100mm * 150mm` |
| `materialShape` | `R` |
| `length` | 150.0 |
| `width` | 100.0 |
| `height` | 1.5 |
| `diameter` | `''` |
| `g_ID` | `1511001150100002` |

## The join and the identity (answering #307's items 3, 4, 5)

- **Join key: `t_MakeraCutterProperties.cutterID` = `t_MakeraCutterList.cutterId`.** A `LEFT JOIN`
  from properties finds **0** orphan rows. Materials join the same way:
  `t_MakeraCutterProperties.materialId` = `t_MaterialList.materialID`, also **0** orphans.
- **Primary key is `cutterId`**, a v7-shaped UUID (`019c049a-…`), on every cutter table — 129 rows,
  129 distinct `cutterId`. Not an auto-increment integer.
- **The 12-digit header id is `g_ID`.** All 129 rows have a 12-character `g_ID`; all 129 are
  distinct; all carry `sellProduct = 1`. It is a second natural key, not the primary one.
- **The QR slug `C1-BIT-BALL-NOSE-1-4` appears nowhere in the file** (every text column of every
  table searched for `C1-BIT` and `BALL-NOSE`). The only bridge-shaped table is **`t_SkuMapping`**
  (`skuMappingID, mappingDuty, g_ID, shopifyRegion, sku, url, removeFlag, lastUpdateDate`) — a
  `g_ID ↔ Shopify sku` map — and it is **empty in this install**, so Studio resolves the slug
  online.
- **Stability:** natural UUID keys and a `lastUpdateDate` on every table; `t_DeletionQueue`
  (`deletionQueueID, tableName, pkColumn, pkValue, deletionDate`) holds tombstones, so the catalogue
  is designed to sync with stable keys and explicit deletions. Nothing says what happens to a
  re-catalogued cutter's `g_ID` — untested.
- **The custom tables:** `t_CustomCutterList` is a full copy of the catalogue's columns **minus
  `g_ID`** (0 rows) — a *materialised* user tool with no base pointer. `t_CustomerCutterProperties`
  mirrors the feeds columns plus `lastUpdateDate` (0 rows). `t_CutterInventoryList`
  (`inventoryID, cutterID, qty, lastUpdateDate`, 0 rows) is Studio's own inventory concept. These
  are the schema's own model of "clone to change speeds" — `/Fabrication.md` decision 30.

## Materials, verbatim (a check on §5.1's claims)

`t_MaterialList` names, against their `t_MaterialCategory`: **PCB** (PCB); **6061 Aluminum**,
**7075 Aluminum** (Aluminum Alloys); **Brass**, **Copper** (Copper Alloys); **Bakelite**,
**Carbon Fiber**, **Epoxy Tooling**, **Synthetic Stone** (Composites); **Delrin**, **Acrylic**,
**Polycarbonate**, **ABS** (Plastic); **Hardwood**, **Softwood** (Wood).

**No PLA, no PETG, no PET, no nylon** — the plastics are ABS, Acrylic, Delrin, Polycarbonate,
Bakelite and Epoxy Tooling only. §5.1's fact 1 stands literally: the badge job's material has no row.
`t_MaterialSpecs` is 189 blanks, `materialShape` `'R'` (137) or `'C'` (52), each `g_ID` 16 digits
(all 189 distinct) — a stock-size code, not the cutter's 12.

## Still open on #307

- ~~**Photograph a Z1-badged cutter's label (A7).**~~ **Moot, 2026-10-08.** The maintainer's photo of
  every cutter that came with the machine (`docs/bench/img/a1-all-cutters-boxed.jpg`, runbook A1)
  shows every label branded **MAKERA CARVERA** — there is no Z1-badged cutter in the set, so the
  `C1-` scheme is the only one this machine's cutters carry, and the "does it generalise" question
  has no counterpart to test. What stays open is the **vocabulary**, not the scheme: one close-up per
  box group decodes the rest (`docs/bench/2026-10-bench-day-1.md` A1/A7).
- The catalogue has no 1/4-inch ball nose by name (its ball noses are 3.175, 4 and 6 mm), so the
  decoded slug matches nothing sold in this install — a further sign the slug is resolved online.
