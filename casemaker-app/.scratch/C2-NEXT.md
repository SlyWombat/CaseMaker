# C2 next steps (slice 2, anchored bed-held footprint registration)

Branch 1070-footprint-reg @ 11e083295 (slice 1 green: footprint.ts + spec). Worktree clean.

## Step 1 (planner branch) — plan.ts
- PlanInput (src/engine/cnc/registration/plan.ts): add
  region?: { min: [number, number]; max: [number, number]; marginMm: number };
  softLimits?: { xMin: number; yMin: number; zMin: number } | null;
- In planRegistration's `mount === 'bracket'` branch, after the mountObstacles guard and BEFORE the
  obstacle-height loop: when input.region is present, call planFootprintRegistration
  (src/engine/cnc/registration/footprint.ts) with:
    stock {length: width, width: depth, thickness: input.stockThicknessMm ?? 0},
    region/marginMm from input.region,
    origin {x,y,from} from input.bracketOrigin (the ANCHOR SEED),
    softLimits: input.softLimits ?? null,
    expectedSurface: input.expectedSurface, seekFromMachineZ,
    probe {instrument:'z-only', tipRadiusMm: s.tipRadiusMm},
    settings from s (scanInside/scanReach/coarse/fine/cornerClearance/parkAboveSurface/surfaceTolerance),
    obstacles from mountObstacles (label/min/max).
  On !ok return {ok:false, reason}. On ok build a RegistrationPlan:
    scans = fp.plan.scans mapped to EdgeScan (same field names; coarse/fine from s),
    surfacePoint = region centre, bracketOrigin = input.bracketOrigin (seed, machine moves),
    corner = { id:'front-left', xEdge:'left', yEdge:'front' }  <-- uses the EXISTING #525
      corner-derived origin in outcome.ts (intersects the touched left/front lines, rotation from
      the same pair, out-of-square as information) — no new G54 derivation,
    mountObstacles, seek {fromMachineZ, travelMm, band}, mountDatum, probe, mountTap, settings,
    notes = fp.plan.notes (+ seed-vs-touch sentence left to the outcome notes).
  Keep the vise path untouched; the bracket's old datum+confirm path stays for jobs WITHOUT a region.
- Typecheck: `npx tsc -b`.

## Step 2 — seam (registrationAttempt.ts)
- Replace the mountKind !== 'vise' refusal for bracket: build input.region from the job
  (export cutExtents from src/engine/cnc/engrave/surfaceSpread.ts or compute via toPartPlan),
  marginMm = job.edgeMargin, softLimits = calibration.softEndstop (enabled ? values : null),
  pass through planRegistration. Tape: only when job.workholding.tape.where !== null; else refuse
  with the need stated ("a taped job needs where the blank sits…").

## Step 3 — Cut step (EngraveRegistrationStep)
- approvedPlan/proposal must not require job.setups for a bed-held job; on approve, materialise the
  derived first setup (jobSetups(job)[0]) with `registration` attached so the rest is unchanged.

## Step 4 — executor
- runRegistration: pass the plan's machine bounds; refuse before the first line if any planned
  G53 position is outside softEndstopOf(machine) (guard read: #1070 comment 6712837648).
- The scan loop already executes EdgeScans; the corner touches use the existing corner plan path.

## Step 5 — sheet
- runSheet §6 prints the footprint touches (probePlan.planProbing change or a plan-driven section).

## Step 6 — red-first
- tests/unit: planRegistrationAttempt on the tray (anchored bracket, region 22..158 x 10..116,
  stock 160x126x25) goes refused -> kind 'plan' with the six scans at the extents and machine
  coords inside -207/-206; one green case for the bottom job (stock 106x136).
