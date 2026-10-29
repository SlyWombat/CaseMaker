# Make the part, or a mold of it (#721)

A goal mesh ("Surface a mesh") makes the ITEM: material is removed down to the mesh's top surface.
A goal can now make the MOLD instead: the part's shape cut as a cavity to cast it in.

## The transform (one, shared)

- The item heightfield is sampled as before (#534, the top surface, scaled per #722).
- **Mold:** each covered cell's height above the part's base (`z − base`, where base = the placed
  top less the placed height) becomes the cavity's depth below the stock top. The rows are
  mirrored about the footprint's centre line in Y. The part is **turned over about X**, as if
  pressed face-down, not reflected, so a casting reads the right way round; a reflection would
  cast its mirror image. Uncovered cells stay at the top: that is the rim.
- The CAM (roughing and finishing), the post and the material sweep run on that field unchanged.
  The viewport draws the mesh with the same turn (scale y and z negated about its top anchor),
  dropped so its base is at the stock top.

## Checks

| Code | Severity | Rule |
|---|---|---|
| `goal-mold-rim` | error | the turned footprint plus the edge margin on every side must fit the blank |
| `goal-mold-floor` | error | the cavity depth must leave the job's minimum floor |
| `goal-mold-one-sided` | info | always: cut from the top only, so the casting's underside is the flat pour face, and undercuts or a two-sided part need two setups (#723) |
| `goal-mold-no-draft` | warning | the steepest cavity wall, cell to cell including the rim, is past 85° (a labelled default) |

## UI

- The goal row: **make: Make the part / Make a mold of it**. The row's sentence says the cavity's
  depth in mm.
- Wizard step 4, Surface a mesh: the same two choices under the file, plus one sentence on the
  one-sided limit.
- `goalMode` is optional on the document. Absent means the part, so older jobs round-trip
  unchanged. A PNG relief and a reference mesh have no choice.

## Not in this slice

Two-part molds (#723 manual rotation), sprues and vents, and a draft *fix* (tapering walls).
