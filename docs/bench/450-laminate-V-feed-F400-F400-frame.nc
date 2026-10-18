;@MKR|BEGIN
;@MKR|SCHEMA|v=1.0.0
;@MKR|MACHINE|id=Z1|name=Makera Z1
;@MKR|MATERIAL|id=0|name=plastic
;@MKR|STOCK|id=cuboid|length=25.35|width=76|height=1.5|diameter=1
;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-12.675|y=-38|z=0.75
;@MKR|CAM|id=CaseMaker|name=Case Maker|v=1.0.0
;@MKR|UNIT|value=MM
;@MKR|TOOL|number=1|id=0|name=Single Flute Engraving Bit - 1/8" Shank 30° * 0.3mm|type=Engraving|handlediameter=3.175|sticklength=0|shoulderlength=0|flutelength=0|diameter=3.175|tipdiameter=0.3|cornerradius=0|angle=0|halfAngle=15
; type=Engraving is UNVERIFIED against Makera Studio: a non-flat cutter's own word for this field, not one read out of a Studio sample
;@CM|TOOL|key=inv:kz-engrave-30-0-3
;@MKR|TIME|seconds=3
; cycle estimate: cutting + rapids through the trapezoid, timed on Makera Z1's rapid model (1200 mm/min XY, 600 mm/min Z, 150 mm/s² accel, config read 2026-10-07 + stopwatch 2026-10-08) — a planning estimate, not a measured cycle time
;@MKR|TOOLPATH|number=1|tool_number=1|name=Frame trace
;@MKR|END

G90 G21
;@MKR|TOOLPATH_START|toolpath_number=1

; T1-Single Flute Engraving Bit - 1/8" Shank 30° * 0.3mm

T1 M6
G53 G0 Z-3
G0 X3.257 Y6.893
S12000 M3
G0 Z20
G0 X22.143
G0 Y13.107
G0 X3.257
G0 Y6.893
G0 Z15
M05
G28
M02
