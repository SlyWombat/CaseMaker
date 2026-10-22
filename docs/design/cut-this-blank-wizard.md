# "Cut this blank" — one guided flow from an open job to the probe and the cut (#573)

*Design, 2026-10-22, for review. No code is written. Builds on `cnc-job-workflow.md` (the job
workflow), `cnc-panel-redesign.md` (#521, the Cut checklist), the #516 setup wizard, the
registration planner/executor (`src/engine/cnc/registration/`), #559 (seat-Z from the vise
constant), #571 (the web front end drives the machine) and #572 (the cutter override). The evidence
is the 2026-10-22 bench: `docs/bench/2026-10-22-web-registration-ux-notes.md` (F1–F8), and issues
#573, #574, #575, #576.*

## 0. Why

The maintainer, 2026-10-22: *"keep notes as this should be an intuitive process for a beginner
user."* Driving the proven badge job from "Open job" to a registration probe in the web UI showed
that **every capability works and the path is still undiscoverable**: the order that does not fail
is `connect → override the cutter → plan + approve the registration → Generate → Freeze → Register`,
and nothing tells the operator that order. The steps live in four places (the Design tab, the Cut
tab, a Setups accordion, the Manage overlay). Cut step 3 is a dead end that points back to another
tab (F1). Approving the registration after Generate silently stales the freeze (F6, #574). The
registration-plan control is per-setup, buried, and labelled so it reads as something else (F7). The
telling data point: a session with full knowledge of the code could not reliably find the "plan the
registration" control on the screen.

The fix is not more labels on the existing panels. It is **one guided flow that owns the order and
does the mechanical steps itself**, asking the operator only for the decisions that are theirs: which
cutter, approve the plan, "I'm at the machine", approve the origin, swap the bit, run. The expert
panels stay; the wizard is a layer over the same stores and engine, not a second implementation.

## 1. The flow

One button on a job that has stock: **Cut this blank**. It opens a stepper that holds a cursor and
never shows a step the operator cannot act on. Each step below states what the **app** does, what the
**operator** confirms, the **gate** to the next step, and **recovery** when the gate fails.

### Step 1 — Machine
- **App:** connect to the location's saved machine (the address in `location.json`); run identify +
  status; show *Online* with the live status line, or *Offline* with the reason.
- **Operator:** nothing when it is Online. When Offline: *Check again*, or type an address.
- **Gate:** the machine answered identify and status (what the Machines card shows as *found* +
  *Idle*). Not "a card exists" — that is the trap today (F2): a controller card with "did not answer"
  looks connected and is not.
- **Recovery:** the Z1 drops off the LAN when idle; *Check again* re-probes. (On the bench the fix
  was a plug cycle; the wizard can only say so.)

### Step 2 — Blank and cutter
- **App:** show the stock from the job (dims, material, how it sits in the vise — the `fixture.ts`
  words) and the chosen cutter; run the cutter/material check (`metalLineFindings` and the feeds
  resolution) *here*, not as a disabled Generate three steps later.
- **Operator:** confirm the cutter. If it is refused: the reason in full, and two actions in place —
  **Pick another cutter** (the recommended one first), or the #572 override: *Use this cutter
  anyway* → the plain risk sentence → *I understand the bit may break*. #575 makes the 30° engraving
  bit not need this at all; the override remains for cutters that genuinely have no row.
- **Gate:** a cutter with no blocking finding.
- **Recovery:** the finding text + the two actions above; no "Fix the errors above first" with the
  error behind a *show* toggle (F3).

### Step 3 — Registration plan
- **App:** compute the plan with `planRegistration` from the job's stock, the mount (vise), the seat-Z
  from the shipped-vise constant (#559 — no typed machine Z), and the cut-area centre. Show it in the
  planner's own words and in **work XY** (the vise plan is sent in work XY; there is no machine-XY
  anchor — #567 review): *touch the top at the cut centre (x, y); scan the left edge at Y …, the
  front edge at X …*. This is the per-setup plan the Setups accordion holds today
  (`engrave-setup-plan-reg-1` → `engrave-setup-approve-reg-1`); the wizard calls the same actions and
  stores the same approved plan on the setup.
- **Operator:** **Approve**. (Or edit: the seat if the vise is not the shipped default; the mount.)
- **Gate:** `planRegistration` returned `ok` AND the operator approved.
- **Recovery:** a refusal in the planner's sentence (stock too small for the scan inset; jaw within
  the surface band; surface point not inside the stock) with the field to change.

### Step 4 — Generate
- **App:** generate, verify, simulate — with progress and the three ticks as they land. The gate
  reads the *matches prediction* result; when it fails, say **which metric exceeded the band and by
  how much** (#576 — today the sentence shows an under-cut *inside* the band and still fails).
- **Operator:** nothing, except any clearance acknowledgement the run gate already requires.
- **Gate:** verified with 0 errors, simulated, matches prediction.
- **Recovery:** the metric + what to change (depth margin, cutter, feature), then re-run this step.

### Step 5 — Freeze
- **App:** freeze the package (the program and the setup with its approved plan).
- **Operator:** nothing.
- **Gate:** frozen and fresh. Because the wizard orders plan → generate → freeze, the F6 stale-freeze
  cannot occur inside it (§3).

### Step 6 — Register the blank (the probe)
- **App:** *Fit the wired probe. Hand near the stop.* The operator ticks *I am at the machine*; the
  wizard runs `runRegistration` with the operator callback answered by that tick (home, `M491`,
  the surface seek, the edge scans), streaming the transcript and the "waiting / touch n" state.
  Then the verdict: the offset per axis, within margin or not, and the problems if any.
- **Operator:** **Start**; then, on a usable verdict, **Write the origin** — which is its own bit
  change: *Take the probe out, fit the cutter* → `applyCorrection` (home, the cutter's `M491`,
  `G10 L2`, home). The wizard names the cutter to fit.
- **Gate:** the probe ran, the outcome is usable (every edge found, every axis measured), the
  operator confirmed, the origin was written. The at-machine tick is required before any motion.
- **Recovery:** the executor's stop sentence as today (how low the probe may be; `$X`, `G90`, lift).
  A miss at the surface seek ("found nothing down to Z …") is shown with the two usual causes: the
  blank is not where the job says, or G54 is not this job's origin (#567 review point 2) — with a
  *Check G54* pre-flight that reads the work offset back (`workOffset`, #567).

### Step 7 — Run the job
- **App:** upload and verify the md5; offer the dry run (#547); vacuum on before play (`M331`), off
  after; antistatic for plastic (#564). Show the run plan's phases.
- **Operator:** **Run** (or *Dry run first*).
- **Gate:** uploaded and verified; the machine Idle.

## 2. Automatic vs confirmed

| Step | The app does | The operator confirms |
|---|---|---|
| 1 Machine | connect, identify, status | only when Offline |
| 2 Blank + cutter | show stock, run the cutter check | the cutter, or the override (two-step) |
| 3 Registration plan | compute the plan, seat-Z from the vise | **Approve** (edit seat/mount if needed) |
| 4 Generate | generate, verify, simulate, match | clearance ack only |
| 5 Freeze | freeze | — |
| 6 Register | the probe sequence, the verdict | *at the machine* → **Start**; **Write origin**; fit the cutter |
| 7 Run | upload, verify, vacuum, play | **Run** / *Dry run* |

Nothing moves the machine without the at-machine tick (step 6) or the Run press (step 7). Every
automatic step is reversible by going back: the wizard re-runs forward from the step it returns to.

## 3. The gates and the order

The wizard **owns the order**. The dependencies the panels leave implicit become explicit:

```
machine Online
  └─ cutter without blocking finding
       └─ registration plan approved          (uses stock + vise seat-Z)
            └─ generated + verified + simulated + matches
                 └─ frozen (fresh)
                      └─ probe run → usable outcome → origin written
                           └─ uploaded + verified → run
```

- **Editing the job resets the cursor to the first affected step** and the wizard re-runs forward:
  a stock or cutter change → step 2; a label/depth change → step 4 (and re-freeze); approving a new
  plan → step 4. The stale state of #574 ("changed since generated" with a disabled Save) is replaced
  by "re-generating…" — the wizard does the re-freeze, it does not ask the operator to discover it.
- **A step never shows a control for a later step.** Step 3 does not show *Start*; step 6 does not
  show *Run*. Cut step 3's "plan it in Design → Setups" dead end (F1) cannot exist: planning is step 3
  of the same flow.

## 4. What changes in the code

This is an **orchestration layer**, not new engine. One component (working name
`EngraveCutWizard`, opened from the Engrave text panel) drives the existing stores/actions:

- step 1: the machine connect/identify/status path the Machines card uses;
- step 2: the cutter choice (`setTool`), the recommended cutter, `setMetalLineOverride` (#572),
  `metalLineFindings` for the check;
- step 3: the per-setup plan + approve that `EngraveSetupRow` calls (`planRegistration` →
  the setup's stored plan);
- step 4: the generate action and its verify/simulate/match results (`engrave-generate-slot`);
- step 5: the package freeze;
- step 6: `runRegistration` / `applyCorrection` through the registration store, with the operator
  callbacks bound to the wizard's at-machine tick and fit-cutter confirm; the G54 pre-flight via
  `workOffset`;
- step 7: upload + verify + play, the dry-run option.

The Design/Cut panels and the Setups accordion **stay** as the expert path and keep working
unchanged; the wizard reads and writes the same job document, so a job started in the wizard can be
finished in the panels and vice versa. The #516 "Set up this job" wizard (machine → stock → …) is the
natural **front** of this flow: step 1–2 here are its pages; merge rather than chain (open question
§7).

## 5. What a beginner sees

Open a job → **Cut this blank** → *Online* → *This cutter is fine* (or the override) → *Here is how
the blank will be found — Approve* → *Generated ✓ Verified ✓ Simulated ✓ Matches ✓* → *Frozen* →
*Fit the probe, hand near the stop — Start* → *Found it: offset 0.12 mm, within margin — Write the
origin* → *Fit the cutter* → *Run*. No tab is changed by hand; no body text points elsewhere.

## 6. Out of scope

- A second implementation of any engine step (the wizard calls what exists).
- Changing the default cutter/material refusal (#575 fixes the classification; #572 keeps the
  override).
- The bracket and tape mounts' extra operator steps (confirm clamps; two left-edge touches) — they
  slot into step 3/6 as the planner already describes them, but the first build is the vise.
- Rotary.

## 7. Open questions

1. **Entry point:** a button in the Engrave text panel header, or the Cut tab becoming this stepper?
   (Proposal: the button; the Cut checklist remains the expert view of the same state.)
2. **#516 overlap:** merge the setup wizard's machine/stock pages into steps 1–2, or chain it before?
   (Proposal: merge — two wizards is the problem restated.)
3. **Non-default vise:** when `vise.source` is not `default`, seat-Z is not known — step 3 asks for
   the probe reading as the Setups row does today. Is that acceptable for v1?
4. **Where the probe's live transcript lives** in the stepper (inline, or the existing Cut surface).

## 8. Acceptance

- **The bench test #567 is the acceptance:** the badge job, through the wizard, from Open job to a
  written origin, with the operator touching only the confirms in §2. The #567 recipe becomes "press
  Cut this blank and follow it".
- **The beginner test:** someone who has not read the docs, with a clamped blank and the proven job,
  reaches *Start* without being told the order or which tab anything is on.
- F1, F2, F3, F5, F6, F7, F8 of the 2026-10-22 notes are each closed by a specific step above; F4
  (the three navigation models) is reduced because the wizard never asks the operator to navigate.
