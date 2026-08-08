# AI Prompt & Design Specification: UniFi U7 Pro Outdoor Bench Stand

## Context & Objective
The user needs a stable, 3D-printable desktop testing stand for the Ubiquiti UniFi U7 Pro Outdoor Access Point. The stand must feature a male slider bracket that matches the exact physical channel dimensions on the back of the AP, transitioning into a wide, heavily stabilized base plate to safely support the unit's front-heavy center of gravity on a flat desk.

---

## 1. Exact Physical Dimensions of the U7 Pro Outdoor Mounting Channel

The local LLM must construct geometry matching these strict hardware tolerances:

*   **Total Slider Track Width (Outer Channel Clearance):** 42.0 mm (Target bracket width: 41.6 mm for clearance).
*   **Inner Spine Plate Width:** 38.0 mm (Target bracket spine: 37.6 mm).
*   **Retention Tab Lip Thickness:** 3.0 mm.
*   **Channel Depth (Total Insertion Space):** 6.5 mm.
*   **Minimum Engagement Length:** 65.0 mm to 75.0 mm of vertical slider contact to prevent leverage wobbling.

---

## 2. High-Stability Desk Footprint Requirements

Because the U7 Pro Outdoor is front-heavy (especially with attached omni antennas), the stand footprint must be structurally engineered against tipping:

*   **Footprint Dimensions:** Minimum 120 mm wide × 150 mm deep.
*   **Base Thickness:** Minimum 12.0 mm solid base height.
*   **Center of Gravity Compensation:** The slider column must be offset toward the back 1/3 of the base plate, pushing the base plate forward beneath the face of the AP to counter-balance the front-hanging weight.
*   **Tilt Angle:** A backward tilt of 10 to 15 degrees must be applied to the vertical column to let gravity naturally stabilize the AP over the center of the base.
*   **Structural Gussets:** Triangulated support ribs (gussets) must connect the vertical slider spine to the base plate to prevent snapping at the joint.

---

## 3. Reference OpenSCAD Implementation Code

```openscad
// =========================================================================
// STABLE BENCH-TEST DESK STAND FOR UNIFI U7 PRO OUTDOOR
// =========================================================================

\$fn = 80; // Smooth circles

// --- Core Configuration Variables ---
tilt_angle   = 12;     // 12-degree lean back for front weight compensation
base_w       = 130;    // Wide anti-tip footprint
base_l       = 160;    // Deep anti-tip footprint
base_h       = 12;     // Heavy solid plate
slider_h     = 75;     // Tall engagement channel

module stable_base() {
    // Solid anti-topple base plate with rounded front corners
    difference() {
        minkowski() {
            cube([base_w - 10, base_l - 10, base_h - 2], center = true);
            cylinder(r = 5, h = 2, center = true);
        }
        // Bevel rear edge to reduce back footprint and save material
        translate([0, (base_l/2), base_h/2])
            rotate([30, 0, 0])
            cube([base_w + 20, 20, 30], center = true);
    }
}

module slider_profile() {
    // Accurate male slider that locks inside the AP's rear channel
    // Cleared by 0.4mm for physical 3D print tolerances
    union() {
        // Main structural spine neck
        cube([34.0, 10.0, slider_h], center = true);
        
        // Inner slider flange channel
        translate([0, 5.0, 0])
            cube([37.6, 4.0, slider_h], center = true);
            
        // Outer locking tabs (lips that catch inside the AP grooves)
        translate([0, 7.0, 0])
            cube([41.6, 2.6, slider_h - 10], center = true);
    }
}

module structural_gusset() {
    // Prevents shearing stress between the base and column
    translate([0, -8, 0])
    rotate([0, 90, 0])
    linear_extrude(height = 16, center = true)
    polygon(points = [[0,0], [slider_h - 10, 0], [0, 45]]);
}

// --- Final Boolean Assembly ---
union() {
    // Base anchored on the print bed
    translate([0, 0, base_h/2]) 
        stable_base();
    
    // Offset Column shifted backward to align with center of mass
    translate([0, -35, base_h]) {
        rotate([tilt_angle, 0, 0]) {
            translate([0, 0, slider_h/2]) {
                slider_profile();
                structural_gusset();
            }
        }
    }
}
```

