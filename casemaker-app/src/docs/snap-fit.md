# Snap-Fit Design Reference

Case Maker's snap-fit joint generates **cantilever** snap catches between the case wall and the lid lip (issue [#29](https://github.com/SlyWombat/case-maker/issues/29)). This document covers how the catches are sized, distributed, and what to tune for different filament materials.

## Cantilever snap-fit geometry

```
                 ┌─────── lid plate ───────┐
                 │                         │
                 │  ┌──── lip ring ─────┐  │
   case wall ►   │  │                   │  │
                 │  │   arm (flexes)    │  │
                 │  │     ↓             │  │
                 │  │  ┌──┐             │  │
   pocket ◄ ─────┼──┼──┤  ├─────────────┤  │
                 │  │  └──┘  ← barb     │  │
                 │  │                   │  │
                 └──┴───────────────────┴──┘
```

When the lid is pressed onto the case, each catch arm flexes inward as the barb's lead angle rides up the case-wall top, then springs back outward into the pocket below to lock.

### Default dimensions (PLA)

| Parameter | Symbol | Value |
|---|---|---|
| Arm length | `L` | 12 mm |
| Arm thickness (root) | `t` | 1.6 mm |
| Arm width | `w` | 5 mm |
| Barb protrusion | `y` | 0.8 mm |
| Barb length | `l` | 4 mm |
| Pocket depth | `p_d` | 1.0 mm |
| Pocket width | `p_w` | 6 mm |
| Pocket height | `p_h` | 5 mm |
| Lead angle | `α₁` | 30° |
| Retention angle | `α₂` | 45° |

### Strain check

Maximum bending strain during deflection of a cantilever:

`ε = 1.5 × y × t / L²`

For PLA defaults: `ε = 1.5 × 0.8 × 1.6 / 12² ≈ 1.33 %`. Just under PLA's 1.2–1.5 % strain at yield — safe but tight.

For tougher fits or longer service life, switch to:
- **PETG** (≈ 4 % strain) — same dimensions, comfortable margin.
- **ABS / ASA** (≈ 3 %) — same dimensions, comfortable margin.

If you're stuck with PLA and want more margin, increase `L` to 14 mm: `ε ≈ 0.98 %`.

## Distribution heuristic

`engine/compiler/snapCatches.ts::defaultSnapCatchesForCase` picks the catch count from the case envelope's longest outer dimension:

| Longest dim | Catches | Walls |
|---|---|---|
| < 80 mm | 2 | midpoint of each short end |
| 80–150 mm | 4 | midpoint of each of the 4 walls |
| > 150 mm | 6 | each short-end + thirds along the long walls |

Auto-population runs once the user switches `joint = 'snap-fit'` and `snapCatches` is empty. After that the user controls the list (toggle, add, remove, reposition).

## Tuning per print

Common print-time issues and adjustments:

- **Lid won't seat fully** — barb protrusion too tall or arm too stiff. Reduce `barbProtrusion` to 0.6 mm or lengthen the arm.
- **Lid pulls off too easily** — barb protrusion too short. Increase to 1.0 mm. Verify pocket depth is at least `barbProtrusion + 0.2`.
- **Arm snaps off on first close** — strain over yield. Switch material or lengthen arm.
- **Loose fit at the catch** — pocket too wide for the barb. Reduce `pocketWidth` (raise the wall around the barb).

## Barb cross-sections (issue #69)

The `barbType` field on each `SnapCatch` selects the cross-section of the barb at the cantilever tip and the matching lip on the case wall. Defaults to `hook` so legacy projects keep the original geometry.

| Type | Geometry | Insertion force | Retention force | Best for |
|---|---|---|---|---|
| `hook` (default) | Rectangular barb + sloped wedge lip | Medium (45° lip ramp) | High (flat catch face) | Permanent / semi-permanent assembly. Default for Case Maker. |
| `asymmetric-ramp` | Shorter rectangular barb (70% z) + same wedge lip | Low | Medium | Frequent open/close — battery covers, IO trays. |
| `symmetric-ramp` | Triangular prism barb + symmetric prism lip | Medium | Medium (≈ insertion) | Service-friendly enclosures the user opens by hand. |
| `half-round` | Half-cylinder barb + wedge lip | Medium-low | Medium | Smoother strain distribution; better PLA fatigue life. |
| `ball-socket` | Cylindrical detent + wedge lip | Low | Low-medium | Multi-position retention, light-duty alignment. |

**Strain budget.** All five share the same cantilever arm geometry (8 mm × 1.6 mm × 6 mm wide) and barb protrusion (0.8 mm). Per Bayer's snap-fit design guide, the strain at the arm root for 0.8 mm deflection is

ε = 1.5 · y · h / L² ≈ 1.5 · 0.8 · 1.6 / 64 ≈ 0.030 (3%)

within PLA's ~5% elastic budget. Each barb cross-section concentrates that strain differently — half-round and ball-socket distribute it across a curved face, hook concentrates it at the corner.

Advanced users can override `insertionRampDeg` and `retentionRampDeg` per-catch via the project JSON; UI v1 doesn't expose them.

## References

- Bayer Plastics, "Snap-Fit Joints for Plastics — A Design Guide"
- Bonenberger, P. R. (2000), *The First Snap-Fit Handbook*
- Protolabs design tip: "Designing snap fits for 3D-printed parts"
- Malloy, R. A. (1994), *Plastic Part Design for Injection Moulding*, §6.3 "Snap-fit cross-section catalogue"
