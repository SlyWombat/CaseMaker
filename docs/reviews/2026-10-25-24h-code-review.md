# Code review — the 24 hours to 2026-10-25 00:30 (main 0df9b329 → a628fa8e)

Requested by the maintainer ("Do a code review of all the work done in the past 24 hours"). Scope: the 46
commits that landed on `main` between 2026-10-24 00:00 and 2026-10-25 00:30 — 80 source files, +4925/−576
lines under `casemaker-app/src` and `src-tauri`, plus docs and bench records. Every commit had passed the
clone gate (typecheck + full vitest, 0 failed) and a manager read of its diff before landing; this review
is the second, adversarial read, done by four independent reviewers by area (registration engine;
simulation/oracle/post/package; UI/stores/location; Rust/build/infra + cross-cutting rules), each reading
the code at `origin/main` with no edits and no full-suite runs. The manager verified the blocker and the
UI findings' premises against the code before filing. Every finding is a GitHub issue; this file is the
map.

## Verdict

The day's work is sound in its mechanics — the probe command stream, the plane fit, the un-lift inverse,
the fingerprint strips, the Rust stamp and the schema compatibility all hold up under a hostile read — and
it moved the bench from "no origin can be written" to "every known blocker between registration and Upload
is on k3". The review found **one machine-safety blocker**, **seven majors** and a tail of minors, most of
them in the seams the day's speed left open: results of house writes not read, state not cleared between
runs, a second frame (lifted vs un-lifted) that the viewport does not name, and claims in commit messages
that no spec pins. None of the majors is in the G-code the machine has already run; the blocker is a
latent path (a blank much prouder than the record expects) that tonight's runs did not exercise.

## Blocker

| # | finding | where |
|---|---|---|
| #632 | The five extent touches rapid to `band.max + park` from the **plan**, while #619 lets the centre reading be accepted up to `jawTop + thickness + tol` — a blank ≥ 3 mm prouder than the band expects puts `G0` into the stock with the probe. Tonight's margin was 2.6 mm only because the badge stands 1.8 mm proud. Fix is one line (`max(band.max, slow.z) + park`) plus a fake-Z1 spec. | `execute.ts` ~696 |

## Major

| # | finding | where |
|---|---|---|
| #633 | `seekSurface`'s #619 ceiling widens the post-**facing** re-touch band too, so an unfaced top passes and the origin is written. | `execute.ts` ~445, ~776 |
| #634 | The surface un-lift (#625/#628) rebuilds checkpoints but leaves `airMoves` lifted: where the fitted plane dips below the lowest touch, every retract reads as a rapid through stock; and un-lifting the 3-dp `.nc` text (not the IR) leaves ±0.0005 mm per move that defeats the bucket/density logic for off-grid depths. | `sweep.ts` ~115 |
| #635 | `surfaceRepostBlocker` is one-directional: a package re-posted against tilt A stays uploadable after a later registration records no fit (dome/flat) — the lifted file goes up under "uploads FLAT". | `engraveRunGate.ts` ~296 |
| #636 | Every registration write-back ignores `saveMachine`'s `'stale' | 'failed'`; a 412 drops the datum/frame while the operator is told "recorded"; a throw in the chain hides a successful probe result; `createFirstBed` can run twice per run. | `EngraveRegistrationStep.tsx`, `useMountTap.ts` |
| #637 | `useMountTap` has no busy state and no unmount cleanup — a second press leaks a live console attachment to the machine; the two tap prompts have no testids. | `useMountTap.ts` |
| #638 | The vise frame and `surfaceTopZ` are written from a measurement the operator is then told is out of margin (run 1 did this with X off 0.83); later taps aim where that run moved the jaw. `writeOrigin` records the render-time plan. | `EngraveRegistrationStep.tsx` ~341 |
| #639 | Records and the #631 G32 tick are not cleared on start / Run it again: a failed re-run leaves the previous clamping's registration gating Upload open. | `EngraveRegistrationStep.tsx` ~241 |

## Minor / nits (one sweep each)

- #640 — operator text and docs: the Bed card promises a bracket tap button that cannot appear and prints
  "(#545)"; raw accessory ids (`fx-probe-1`) in sentences; the extent-stop sentence names the vise on a
  bracket; the plan narration omits the bracket tap; `blank-bowed` still in the guide and the code union
  after #631 removed its producer; stale "seating" doctrine after #628; `maxSurfaceLift` dead.
- #641 — `build.rs` watches `.git/HEAD` and the index only: a dirty tree and some commits do not restamp
  (dev-only; the rig stamps via `CASEMAKER_BUILD`); `.gitattributes` does not renormalise an existing CRLF
  checkout; no TS spec ties measured-only keys to the fixture.
- #642 — test gaps: run-store staleness watches 2 of the 8 stamped inputs; #624 lacks an "above the lift"
  case; no negative-lift / non-zero-offset fixture; #607's bracket executor path and #619's write-back are
  unpinned; two commits (65034e22 #607 hook, ac56a21d #601) shipped without a test change.
- #643 — 3D-probe sideways scan starts with a `G0` to top − R at the outward limit with no descent guard
  (dormant: the 3D probe has no tip recorded).
- Design questions recorded on their issues: #631 (G32 follows the top — right if the vise bowed the whole
  blank, wrong by the dome if the film is flat; tomorrow's calipers decide), #618 (a `suspend` that times
  out is treated as paused), #629 (column engine sweeps ramped feeds at their deep end — parked).

## Rules checked across all 46 commits

- New diagnostic codes → guide chapter 8 row: none added; one REMOVED producer (`blank-bowed`, #631) left
  its rows and union behind → #640.
- Vendor catalogue numbers committed: none (the Q8B board JSON has no feed/SKU fields; the one Makera id in
  a new spec is a pre-existing synthetic row).
- New shop-default key: `bracket.armTopMm` (#607) is measured-only — Rust bound 0.5–60, `MEASURED_ONLY` in
  TS, absent from the seed fixture: correct for its class.
- `src/docs` ↔ `docs/` mirror: byte-identical for every mirrored file touched.
- Commits touching `src` with no test change: two (above).

## Solid — do not re-litigate

- The probe command stream: one line per Idle, no G38.3 queued behind a rapid, `M119` before and after the
  tap, `inBand` floors that always stop, State-word-gated `$X` at both stop sites (#588), `$H` before the
  cutter change and last.
- `applySurfaceLift` and the #624 air check call the same `surfaceLift` at the same (x, y): the check is the
  exact inverse; frame, facing and goal posts stay unlifted.
- #584's floor identity holds for every region kind — ring 0 is `design ⊖ planeRadius`, the pitch is capped
  at the tip radius, so the union of the rings swept by the tip is `R₀ ⊕ tip`, built with the same offset
  the prediction uses.
- #621/#627 strips are complete for what the step writes; `canonicalJson` sorts keys, `cuttersKey` sorts the
  Map, `machineKey` excludes `measuredAt`/`source`; the #581 pair pins both the stamps and the fingerprint
  compare.
- `build_stamp.rs`: one function, five tests, the build script and the lib test the same code; `Health.build`
  is serde-defaulted and Zod-defaulted, so old and new clients and servers parse each other.
- wasm ownership on the new sim paths: every created handle is deleted on the success path; the column
  branch deletes each `boxSolid`; `unliftTimeline` holds no handle.
- `createFirstBed` retries once on `stale` and is idempotent on `accessories[].id`; #611's offered tap uses
  the probe now checked out and writes `by` from it; #617's location subscription is a plain selector.

## Second pass — the nine commits landed after this review (e26ad9ae → b73692c7), 2026-10-25 ~06:45

The maintainer: *"make sure you review any work that the peer does."* The follow-up slices (#647 DRO, #646 text
sweep, #635, #648 indicators, #634, #636, #639, #637, #638) had been gated green and spot-read; an independent
reviewer then read every source hunk and spec. Result: **no blocker; nothing changes what the machine is sent**
(the only new command surface is the guarded `M331.4/M332.4`). Filed:

| # | finding | severity |
|---|---|---|
| #650 | `saveMachineWithRetry` re-PUTs the SAME record after a 412 — the If-Match guard is defeated and another writer's change is overwritten; #636 spread it to every registration write. Retry must re-apply a reducer to the refreshed record. | major |
| #651 | `toolDisplayName`: chamfer / tapered-ball / unknown shapes read "N mm flat end"; kinds without a tip diameter are named by the shank; the picker's option text repeats the diameter and merges rows. | major |
| #652 | Strip: the tool comes from the live job, not the frozen package; a long alarm reason clips Stop; Offline keeps the last coordinates; a manual accessory press wins over a running release's record forever. | minor |
| #653 | Un-lift grouping against a running minimum; rapid-into-fixture judged in the lifted frame; unmount mid-motion closes the console before `$H`; an empty out-of-margin save; two sentences the text sweep distorted; two stale comments. | minor |

Solid in the second pass: `guardedMode` is one implementation with the right order (`?`, alarm across the
carried frame, explicit Idle, `P: < 100` refuses); #637's token gate cannot stick; #636 shows the probe result
before any house write; #634 applies the same quantisation to both ends of feeds and rapids; #635 refuses in
every new direction. Each commit's unpinned claims are recorded on its issue thread.

Process change from this pass: the manager reads every source hunk of a peer commit before its gate, not the
hunks named in the report.

## Method notes

The four reviewers read `git show`/`git diff` at the commit shas and the files at `origin/main`; one ran
a 10-line arithmetic check outside the repo (the 3-dp un-lift residue), one verified the `build.rs`
rerun rule in a scratch git repo. Nothing was executed against the machine. Findings were ranked by the
reviewers, then the manager read the cited code for the blocker (#632) and the UI premises (#636, #638,
#639) before filing. Reviewer confidence is recorded on each issue as CONFIRMED (code path read end to
end) or PLAUSIBLE (arithmetic or scenario, not reproduced).
