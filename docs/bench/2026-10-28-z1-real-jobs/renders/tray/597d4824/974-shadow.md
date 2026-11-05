# #974 — the tray's 8.11 % shadow class at 597d4824: map, section, per-class depths

- **What changed between `f5ce99cb` and `597d4824`:** the tray's shadow class goes 0.00 % → **8.11 %**
  (116,868 cells of 1,441,021 covered) and raw cut-into 3.88 % → 11.67 %. The programs are
  byte-identical with the ceiling on and off (F), so the ceiling is not the cause; the tray gained
  facing-off's skin, the 4a mask and #974's chamfer on the newly closed rims in that span.
- **Map `974-shadow-map.png`:** the shadow cells form a band ~0.9 mm wide around every slot rim
  (1,168.7 mm²), and **all 116,868 are owned by the ball-6 finish** (program 2); the green arcs on
  the inter-slot ridges are the chamfer's raw cuts (edge-break class). The deepest shadow cell is
  (19.7, 12.0), 3.43 mm below the goal.
- **Section `974-shadow-section.png`:** at x = 19.7, y 7–17. The slot's end wall crosses at
  y ≈ 12.05 (blue = mesh top; the wall runs from the land −1.2 to the floor −7.2). The land cell
  just left of the wall has the goal at −1.2 and the swept floor (red) at −4.6 — the ball-6's disc
  flank, finishing the slot floor on the right, stamped across the wall onto the land.
- **Per-class depths below the goal (the tool's class dump):**

| class | cells | median depth | max depth | cells > 0.5 mm |
|---|---:|---:|---:|---:|
| edge break | 43,082 | 0.392 mm | **1.536 mm** = the V's leg (1.5375) | 10,332 |
| wall | 8,228 | 3.440 mm | 3.492 mm | 8,228 |
| shadow | 116,868 | 2.592 mm | 3.430 mm | 116,868 |
| adjudicated | 0 | — | — | 0 |

- **Answer to the hypothesis:** the V does not cut the newly chamfered mouths deeper than its edge
  break — the edge-break class's maximum is its own leg (1.536 of 1.5375), and no shadow cell's
  deepest cutter is the V. The 8.11 % band is the **ball-6's disc stamp at the slot walls**, its
  depths the slot depth seen through the flank. The class exists for exactly this over-reach; the
  jump is the ball's finish now reaching the walls at this sha.
- **Open for the ruling:** the exclusion is radius-based, so any *real* gouge in the band would be
  invisible. The physical check that would settle it is the ball's centre distance to the wall per
  stamped position (centre ≥ R − 0 is on the floor); it needs the stamp positions, not the dense
  field — I can add that pass if wanted.
