# Sample STLs

Reference prints generated from the real Case Maker compiler pipeline. Use these to validate your printer / filament / settings before printing a "real" case.

## Files

| File | Purpose | Print time (PLA, 0.2mm, 15% infill) |
| :--- | :--- | :--- |
| [`snap-fit-calibration-30x30.stl`](snap-fit-calibration-30x30.stl) | 30 × 30 × ~10 mm hollow box + matching snap-fit lid. No PCB, no port cutouts — pure tolerance test for [issue #2](https://github.com/SlyWombat/case-maker/issues/2). | ~25 min |
| [`esp32-devkit-snap-fit.stl`](esp32-devkit-snap-fit.stl) | Full ESP32 DevKit V1 case (~57 × 33 mm) with snap-fit lid and per-port cutouts. Shippable enclosure once tolerances are dialed in. | ~2 hr |

## Snap-fit calibration procedure

The snap-fit geometry constants in `casemaker-app/src/engine/compiler/lid.ts` are:

- `SNAP_FRICTION = 0.2 mm` — clearance between lip ring and inner cavity wall, per side.
- `SNAP_LIP_DEPTH = 4 mm` — depth the lip ring extends below the lid plate.

These are first-pass values. Real-world fit depends on filament shrinkage, nozzle width, extrusion-multiplier calibration, layer height, and part orientation. The procedure:

1. **Print** [`snap-fit-calibration-30x30.stl`](snap-fit-calibration-30x30.stl). Both the body and the lid emerge in one print. Default settings on a properly calibrated printer take ~25 min.
2. **Test fit:**
   - **Lid drops in cleanly with no resistance:** friction is too loose. Reduce `SNAP_FRICTION` to `0.15` mm, regenerate the calibration STL (`npm run sample:export`), reprint.
   - **Lid will not seat at all even with hand pressure:** friction is too tight. Increase `SNAP_FRICTION` to `0.25` mm and reprint.
   - **Lid seats with a small amount of pressure and stays put under casual pull:** ✓ tight enough. Document the working value alongside your filament + nozzle + first-layer settings in your notes.
   - **Lid pops out under modest hand pressure:** the lip is too short. Increase `SNAP_LIP_DEPTH` to 5 mm and reprint.
3. **Re-export the real case** with the updated constants. The same friction value will work across all snap-fit cases on the same printer/filament setup.

## How these were generated

```bash
cd casemaker-app
npm run sample:export
```

The script at [`casemaker-app/scripts/export-sample.ts`](../casemaker-app/scripts/export-sample.ts) drives the real `compileProject` pipeline, executes the resulting `BuildPlan` ops against the Manifold WASM kernel running in Node, and writes binary STL via the same `buildBinaryStl` writer the in-app Export button uses. Output goes to `~/casemaker-build/samples/` (or wherever the working tree's parent is); the files committed here are copied from there.

To add another sample, append to the `SAMPLES` array in `export-sample.ts`.
