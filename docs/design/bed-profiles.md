# Bed profiles — what is on the bed, how the app learns it, how a job picks it (#509)

*Design, 2026-10-18, for review. No code is written. Builds on `cnc-job-workflow.md` §3 (the
location), §5.1–5.2 (start and mounting), decisions Q7 (the wasteboard as the sacrificial board),
Q10 (bracket + clamps as the plate default) and decision 28 (fixture obstacles with provenance).*

## 0. Why

The maintainer, 2026-10-18: *"When a waste board plate is installed, do we know its dimensions? This
should be part of knowing what the current bed setup is."* Today the app knows pieces of the bed and
none of the whole:

- the wasteboard has a thickness and scars but no size, position or "installed now" (#417);
- the vise is a set of product constants plus a per-job `stockProud`, and its picture is derived
  from the stock (#508);
- the bracket's seat on the bed is one measured key, `bracket.seatMachineZ`, with no bed under it
  (#427);
- the rotary module's position is a firmware calibration read with no place to live (`Rotary.md`);
- a job carries `workholding.vise` or a per-setup `MountSpec` with no reference to what the bed
  actually had on it when the job was set up.

A **bed profile** is the one description of the machine's bed as it is physically configured: the
surface, the fixtures on it and where, the datums measured on it, and the mountings the shop prefers
on it. A machine has many saved profiles and exactly one **active** profile. A job binds to a
profile, not to a copy of its numbers.

## 1. Vocabulary

| Term | Meaning | Lives |
|---|---|---|
| **Machine** | one physical unit with serial, firmware, calibration read from `config.txt` | `location.json` → `machines[]` (exists) |
| **Fixture record** | an accessory the shop owns, with the product's constants and this unit's measurements: the low-profile vise, the L-bracket (thin, thick), top clamps, side clamps, the 4th-axis module, the vacuum bed, the probes | the location's `accessories[]` (house-owned), placed per machine by a bed profile's placements; the probes are accessory records too (`kind: "probe"`) |
| **Surface** | what the stock or the fixtures stand on: the bare bed, an MDF wasteboard, an aluminium fixture plate, the vacuum bed | part of a bed profile (absorbs `wasteboard`) |
| **Placement** | a fixture put on the bed at a place: the vise on its two locating pins, the bracket at anchor 1 or 2, two top clamps, the 4th-axis module on its pins | part of a bed profile |
| **Datum** | a machine-Z (or XY) measured ON this bed: the surface top, a jaw top, the bracket seat, the rotary axis line; one probe touch each, dated, never typed | part of a bed profile |
| **Mounting** | how a job's stock is held: a placement plus the manner (vise jaws; bracket corner + clamps; tape on the surface; vacuum; rotary chuck) | chosen per job setup from the active profile |
| **Bed profile** | surface + placements + datums + preferred mountings + consumables, named and dated; one active per machine | `machines[].bedProfiles[]`, `activeBedProfileId` |

Provenance words are the location's own: `vendor` (Makera's firmware or manual), `default`
(shipped by us, chosen), `measured` (a probe touch or calipers, with the date and the instrument),
`typed` (the operator entered it, with the date). There is no fifth word: a datum read by the probe
is `measured`, and the instrument is named by the datum's `by` field (the probe accessory's id) — a
datum is never marked `probed`. A datum also carries the `M491` probe-length reading at measurement
(`probeLengthMm`); comparing datums across probe fits subtracts the two readings, so a longer or
shorter probe does not read as a changed datum.

## 2. Data model

```jsonc
// location.json → machines[i]
"fixtures": [
  { "id": "fx-vise-1", "kind": "vise", "product": "makera-z1-low-profile-vise",
    "constants": { "jawBarWidth": 10, "jawLength": 100, "ledgeStep": 3.1, "ledgeWidth": 1.9 },   // product, measured 2026-10-13/15
    "unit": { "jawBarHeight": null, "bodyHeight": null, "maxOpening": null },                   // this unit's, calipers
    "provenance": { "jawBarWidth": "measured:2026-10-13", "jawBarHeight": "unmeasured" } },
  { "id": "fx-bracket-thin", "kind": "bracket", "variant": "thin",
    "constants": { "armLength": 100, "armWidth": 15, "height": null }, "provenance": { "armLength": "vendor:config.anchor_length", "armWidth": "vendor:config.anchor_width" } },
  { "id": "fx-clamp-top-1", "kind": "top-clamp", "constants": { "length": 30, "width": 15, "noseReach": 8, "heightAbovePlate": 12 }, "provenance": { "*": "default" } },
  { "id": "fx-rotary", "kind": "rotary-module", "constants": { "chuck": "4-jaw self-centring, reverse jaws" }, "unit": {} }
],
"bedProfiles": [
  { "id": "bp-2026-10-18-a", "name": "Vise on the pins, bare bed", "createdAt": "2026-10-18T13:00Z",
    "basedOn": "default:z1-vise",                       // the shipped profile it started from, or null
    "surface": { "kind": "bare-bed" },                  // or:
    // "surface": { "kind": "wasteboard", "material": "MDF", "length": 206, "width": 206, "thickness": 6.0,   ← Makera's CAD, inferred (C17); confirm with calipers
    //              "position": { "frontLeft": [x, y], "frame": "machine" }, "provenance": { "thickness": "measured:2026-10-18" },
    //              "scars": [...], "lastResurfacedAt": null }        ← the #417 record, moved here
    "datums": {
      "surfaceTopZ": { "value": -112.345, "measuredAt": "2026-10-18T13:05Z", "by": "wired-probe", "at": [x, y] },
      "viseJawTopZ": { "value": -56.650, "measuredAt": "2026-10-17", "by": "wired-probe", "at": [x, y] },
      "bracketSeatZ": null, "rotaryAxis": null },
    "placements": [
      { "id": "pl-vise", "fixture": "fx-vise-1", "where": { "kind": "pins", "pins": "vise" },
        "frame": { "fixedJawFaceX": -0.1, "jawStartY": -10 },      // machine XY of the fixed jaw face and the bar's start, measured by the edge scans
        "provenance": { "fixedJawFaceX": "measured:2026-10-17" } }
      // { "id": "pl-bracket", "fixture": "fx-bracket-thin", "where": { "kind": "anchor", "anchor": 1 } },
      // { "id": "pl-clamps", "fixture": "fx-clamp-top-1", "count": 2, "where": { "kind": "free" } },
      // { "id": "pl-rotary", "fixture": "fx-rotary", "where": { "kind": "pins", "pins": "rotary" } }
    ],
    "preferredMounting": [
      { "stock": "sheet<=3mm", "mount": { "placement": null, "manner": "tape" } },
      { "stock": "plate|block", "mount": { "placement": "pl-bracket", "manner": "corner+clamps" } },
      { "stock": "blank<opening&taller-than-ledge", "mount": { "placement": "pl-vise", "manner": "jaws" } },
      { "stock": "rod|tube", "mount": { "placement": "pl-rotary", "manner": "chuck" } } ],
    "consumables": { "tape": { "widthMm": 20, "thicknessMm": 0.1, "provenance": "typed" }, "boards": [ { "material": "MDF", "size": [100, 100, 2], "count": 4 } ] },
    "history": [ { "at": "2026-10-18T13:00Z", "what": "created from default:z1-vise" } ] }
],
"activeBedProfileId": "bp-2026-10-18-a"
```

Rules:

- **Three-edit rule.** The schema lives in `src-tauri/src/location.rs` (the service owns the
  document), `src/platform/locationClient.ts` (Zod, strict blocks, `.optional()` so a document
  without the keys round-trips), and the fixture `tests/unit/fixtures/location-doc.json`; `cargo
  test --lib` green in the same commit. New shop defaults (clamp sizes, tape thickness) follow the
  seeds rule (`defaults.rs` + `defaultsClient.ts` + fixture).
- **Migration, in place, once:** `machine.wasteboard` → `bedProfiles[0].surface` (kind
  `wasteboard`, scars and dates kept); `settings.fixtures.vise` → `fixtures[vise].unit` with its
  `source`/`measuredAt`; `bracket.seatMachineZ` → `datums.bracketSeatZ`; the vise's measured jaw
  faces from the registration outcomes (#475/#495) → the vise placement's frame. The migrated
  profile is named "Current bed (migrated 2026-10-18)" and made active; nothing is deleted.
- **A datum is never typed.** The wizard offers to measure it now; a profile may be saved with
  `null` datums, and every gate that needs one refuses by name later (as `bracket.seatMachineZ`
  does today).
- **Fixture geometry is the fixture's.** The drawn and the checked shapes come from the fixture
  record's constants (#508); a placement adds only position and orientation.

## 3. The first-run wizard

**Trigger.** A machine record exists with no bed profile — a machine just added by discovery or
address, or the first launch after the upgrade (then the migrated profile is offered as the start:
"Use the current bed as migrated" or "Set the bed up now"). Also reachable any time from the
Machines card: "Set up the bed…".

**Rules.** One physical instruction per step. The machine is never moved without the operator's
confirm on that step, and each measurement is `home → fit the wired probe → one touch` (the bench
rule). Every step is skippable; a skipped measurement is an unmeasured datum, not a blocker. The 3D
bed picture (§4) is on the right of every step and redraws as answers are given.

```
S0  Your machine ────────────────────────────────────────────────────────────────────────┐
    Makera Z1 · Z1012601F010290 · firmware 1.1.2.0.1.13 · 192.168.10.43 · ● Idle, homed    │
    Read from the machine just now:                                                        │
      anchor 1 at (−190.89, −193.83) · anchor 2 at +88.5, +45.0 · anchors 100 × 15          │
      clearance (−11.6, −14.6, −3.0) · work area 200 × 200 × 100 · rotary offsets (…)       │
    These are the machine's own numbers; the wizard will place fixtures against them.        │
                                                                           [ Next: start ] │
S1  Start from ───────────────────────────────────────────────────────────────────────────┐
    ● Makera kit: wasteboard, L-bracket (thin) at anchor 1, two top clamps — what Makera ships │
    ○ Low-profile vise on its pins, bare bed                                                 │
    ○ Wasteboard with tape                                                                   │
    ○ 4th-axis module on its pins                                                            │
    ○ Vacuum bed                                        (not owned — ask if you have one)    │
    ○ Empty — I will describe it                                                             │
    (each shows its picture and the list of what must be measured before cuts stop refusing) │
S2  The surface ──────────────────────────────────────────────────────────────────────────┐
    ○ Bare aluminium bed      ● MDF wasteboard   ○ Fixture plate   ○ Vacuum bed              │
    Material [ MDF ▾ ]  Length [ 200 ] × Width [ 200 ] × Thickness [ 2.0 ] mm  (typed)       │
    Where: ● on the bed, front-left corner at machine ( −200.0 , −200.0 )  ○ centred  ○ on the pins │
    Top of the surface: not measured.   [ Measure now: home, fit the probe, one touch at (x,y) ] │
    ▸ Scars and the last resurfacing carry over from the wasteboard record (3 scars, 2026-10-12). │
S3  What is on the bed ───────────────────────────────────────────────────────────────────┐
    [x] Low-profile vise — on its two 4×11 pins; left jaw fixed                              │
         jaw top: measured 2026-10-17 (−56.650) · fixed jaw face X: measured 2026-10-17        │
         bar height / body / max opening: NOT MEASURED — drawn provisional, dashed            │
    [ ] L-bracket  ( thin ▾ ) at anchor ( 1 ▾ ) — arms 100 × 15 (Makera's numbers), height ?  │
    [ ] Top clamps × [ 2 ]  — 30 × 15, nose 8, 12 high (defaults until calipered)            │
    [ ] 4th-axis module on its pins — axis from the machine's rotary offsets; chuck ?         │
    [ ] Vacuum bed                                   (not owned)                             │
    ⚠ The vise and the 4th-axis module use the same pins: one at a time (open question A).   │
S4  How you prefer to hold stock on this bed ─────────────────────────────────────────────┐
    sheet ≤ 3 mm → tape on the surface · plates & blocks → bracket corner + clamps          │
    blanks narrower than the opening and taller than the ledge → vise · rods → rotary chuck │
    (these are the §5.2 defaults; each row is a pick-list over this bed's placements)       │
S5  Consumables on hand ──────────────────────────────────────────────────────────────────┐
    Double-sided tape [ 20 ] mm wide, [ 0.10 ] mm thick (typed)  ·  MDF boards 100×100×2 × [ 4 ] │
S6  Review and save ──────────────────────────────────────────────────────────────────────┐
    [ picture ]   Every number, with where it came from:                                   │
                  measured 4 · vendor 3 · default 6 · typed 5 · UNMEASURED 5 → the calipers list │
    Name [ Vise on the pins, bare bed ]            [ Save and make this the active bed ]    │
```

**What each step writes.** S0 → the machine's calibration read (exists). S1 → `basedOn`. S2 →
`surface` (+ `datums.surfaceTopZ` if measured). S3 → `placements[]` with each fixture's record
created or reused (+ `datums.viseJawTopZ` / `bracketSeatZ` / `rotaryAxis` if measured). S4 →
`preferredMounting[]`. S5 → `consumables`. S6 → the profile, active, with its first history line.

**Measuring inside the wizard** reuses the registration executor (#475/#495): the same seek band,
the same wired-probe `G38.2` discipline, the same outcome record. The wizard picks the touch point:
the surface at a clear spot away from fixtures; the jaw top at the bar's centre; the bracket seat
beside the arm. A touch that lands where no surface was expected is reported, never silently kept.

## 4. Visualization

One **bed scene**, drawn by the existing viewport (three.js, the `EngravePreview` fixture layer), in
machine coordinates:

- the bed plate 200 × 200 with the anchor holes and the two pin pairs at the machine's own
  coordinates (S0's read), the clearance position and the tool sensor as small markers;
- the surface as a slab of its stated size at its stated position, its top at `surfaceTopZ` when
  measured (solid) or at a nominal height (dashed, "top not measured");
- each placement from its fixture's constants (#508): the vise's two L-jaws and body, the bracket's
  two arms at the anchor, each clamp's footprint and height, the rotary's chuck body and axis line;
  unmeasured dimensions drawn dashed and labelled "provisional"; provenance by colour (measured /
  vendor / default / typed);
- datums as labelled points with their machine Z and date;
- in the job's mounting step the same scene gains the stock on its chosen placement, so "which way
  round" is seen on the real bed, not on an abstract jaw.

Clicking a fixture opens its record (constants, this unit's measurements, what is still to caliper).
The scene is the Machines card's picture, the wizard's right-hand pane and the mounting step's
picture — one component, three callers.

## 5. Managing profiles

On the Machines card, one **Bed** block replaces the wasteboard line:

```
 Bed · active: "Vise on the pins, bare bed" (since 2026-10-18)         [ Switch ▾ ] [ I changed the bed ] [ Measure… ▾ ]
   surface: bare bed · vise on the pins (jaw top −56.650, measured 2026-10-17) · 5 numbers unmeasured ▸ calipers list
   [ picture ]
   history: created 2026-10-18 from "Low-profile vise on its pins" · jaw top measured 2026-10-17 (migrated)
```

- **Switch** picks another saved profile and makes it active (a physical act the operator has done:
  the app asks "is the bed now …?" and shows the picture). Switching never moves the machine.
- **I changed the bed** opens the wizard at S2 on a copy; saving makes a NEW profile (versioned by
  date), the old one stays in history with its scars and datums. Datums that depend on what changed
  are cleared (a replaced wasteboard clears `surfaceTopZ` and its scars; a re-seated vise clears the
  jaw datums) and listed as "to measure".
- **Measure…** runs one touch (surface top, jaw top, bracket seat, rotary axis) through the
  registration executor and stamps the datum.
- Scars (#417) belong to the surface instance inside the profile; resurfacing is a history line on it.
- Profiles export and import with the location (§3.5); a profile that no saved job references may be
  deleted, others are kept.

## 6. Selecting for a job

- **Start (§5.1)** shows the machine and its active bed profile beside it: "Z1 · bed: Vise on the
  pins (2026-10-18)". No choice here: the bed is what it is.
- **Mounting (§5.2)** lists the mountings the ACTIVE profile makes possible — its placements plus
  tape/vacuum on its surface — preselected from `preferredMounting` for the stock's class. A fixture
  the shop owns but has not placed is shown greyed with "not on the bed — switch the bed profile or
  change the bed". A mounting whose datum is unmeasured is offered and the gate that needs the datum
  refuses by name (today's rule).
- **The job stores** `bed: { machineId, bedProfileId, profileVersion, placementId, manner }` and a
  snapshot of the datums it used. The job's `workholding` / `MountSpec` remain as the compatibility
  reading (as `setups[]` did in #419).
- **On load / before generate:** if the machine's active profile is not the job's, finding
  `bed-changed` (error before a run, warning in design) listing the differences in words ("the vise
  is no longer on the bed"; "the wasteboard was replaced on 10-20, its top is unmeasured") with two
  actions: "re-plan on the current bed" (rebinds and re-runs the mount checks) or "switch the bed
  back" (if the old profile is saved).
- **Downstream readers** take their numbers from the profile: registration's `expectedSurface`
  (surface top + stack, or jaw top − proud); the sim and verifier's obstacles (placements → boxes);
  the wasteboard findings (the surface's footprint and scars); the run sheet's stack-up ("Bed: Vise
  on the pins; jaw top −56.650 measured 2026-10-17; surface not measured"); the receipt (#478)
  carries `bedProfileId`/`profileVersion` in provenance.

## 7. Default profiles we ship

All `default` provenance except the vendor numbers; nothing measured; each with its picture and
its "to measure before the gates stop refusing" list.

| Profile | Surface | Placements | Vendor facts carried | To measure |
|---|---|---|---|---|
| **Z1 — Makera kit** | wasteboard | L-bracket thin at anchor 1, 2 top clamps | anchors 100 × 15, anchor 1/2 positions from the machine | bracket seat Z, arm height, clamp sizes |
| **Z1 — Low-profile vise** | bare bed | vise on its pins | jaw bar 10 × 100, ledge 3.1/1.9 (product, measured) | jaw top Z, fixed jaw face X, bar height, body, max opening |
| **Z1 — Wasteboard + tape** | wasteboard (size typed on first use) | none | — | surface top Z, board thickness |
| **Z1 — 4th-axis module** | bare bed | module on its pins | rotary offsets from the machine | axis line, chuck body, jaw reach (#238) |
| **Z1 — Vacuum bed** | vacuum bed | none | — | listed only; not owned |

## 8. Findings this adds

| code | severity | when |
|---|---|---|
| `bed-unmeasured` | info | the active profile has datums the job will need; names them and the calipers list |
| `bed-changed` | error (run) / warning (design) | the job's profile is not the machine's active one |
| `mount-not-on-bed` | error | the job's mounting names a placement the active profile lacks |
| `stock-off-surface` | warning | the stock's footprint leaves the surface's footprint |
| `fixture-overlap` | error | two placements occupy the same bed area or pins |
| `surface-top-unmeasured` | error | a tape/bracket registration needs the surface top and it is null (replaces the lone `bracket.seatMachineZ` refusal) |

Each gets its chapter-8 row (`cncGuide.spec` enforces).

## 9. Out of scope

The rotary module's characterisation (#238, `Rotary.md`) — this design gives it a place, not its
numbers. The vacuum bed (not owned). Multi-machine shops beyond the per-machine list. Per-profile
feeds. Any Z1 dimension not measured or published — the bed, the pins and the fixtures are measured
on this unit (see #444's note: Makera publishes none).

## 10. Open questions (defaults, then proceed)

- **A. Do the vise and the 4th-axis module share the locating pins?** Default: yes, exclusive —
  the wizard refuses both at once until the bench shows otherwise.
- **B. Profile granularity.** Default: one profile per physical change, versioned by date; not one
  per session.
- **C. Tape thickness.** Default: a consumable on the profile (typed) AND recorded on the job that
  used it, since it enters the Z stack.
- **D. Job binding.** Default: reference + version + a snapshot of the datums used, so a reloaded
  job can say exactly what it was planned against even if the profile was since edited.
- **E. The Z1's bare bed as a surface.** Default: `bare-bed` has no size (the machine's work area is
  it) and no scars; its top Z is still a measured datum.

## 11. Slices

1. **Model + migration** (`location.rs`, `locationClient.ts`, fixture; cargo): fixtures, bed
   profiles, active id; the four migrations; tests on round-trip and migration.
2. **Bed scene + Machines card block** (viewport component, `LocationCard`): draw the active
   profile from fixture constants (#508 lands first), Switch / Measure / I changed the bed.
3. **The wizard** (S0–S6) over the registration executor, resumable, skippable.
4. **Job binding + findings** (`jobSetup`, registration, sim, run sheet, receipt): `bed` on the job,
   the six codes, readers moved onto the profile.
5. **Default profiles + docs**: the five shipped profiles, cnc-guide chapter on the bed, chapter-8
   rows, the calipers list wired to #444.
