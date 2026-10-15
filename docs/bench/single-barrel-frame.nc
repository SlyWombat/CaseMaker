;@MKR|BEGIN
;@MKR|SCHEMA|v=1.0.0
;@MKR|MACHINE|id=Z1|name=Makera Z1
;@MKR|MATERIAL|id=0|name=pla
;@MKR|STOCK|id=cuboid|length=38.1|width=76.2|height=3.81|diameter=1
;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-19.05|y=-38.1|z=1.905
;@MKR|CAM|id=CaseMaker|name=Case Maker|v=1.0.0
;@MKR|UNIT|value=MM
;@MKR|TOOL|number=1|id=C1-BIT-ENGRAVE-30-0.3|name=Single Flute Engraving Bit 30 x 0.3|type=Engraving|handlediameter=3.175|sticklength=0|shoulderlength=0|flutelength=0|diameter=3.175|tipdiameter=0.3|cornerradius=0|angle=30|halfAngle=15
; type=Engraving is UNVERIFIED against Makera Studio (#268): a non-flat cutter's own word for this field, not one read out of a Studio sample
;@CM|TOOL|key=inv:kz-engrave-30-0-3
;@MKR|TIME|seconds=10
; cycle estimate: cutting + rapids through the trapezoid, timed on Makera Z1's rapid model (1200 mm/min XY, 600 mm/min Z, 150 mm/s² accel, config read 2026-10-07 + stopwatch 2026-10-08 (#281)) — a planning estimate, not a measured cycle time
;@MKR|TOOLPATH|number=1|tool_number=1|name=Frame trace
;@MKR|END

G90 G21
;@MKR|TOOLPATH_START|toolpath_number=1

; T1-Single Flute Engraving Bit 30 x 0.3

T1 M6
M331
G53 G0 Z-3
G0 X7.928 Y1.009
S12000 M3
G0 Z20
G0 X30.172
G0 Y75.191
G0 X7.928
G0 Y1.009
G0 Z15
M332
M05
G28
M02
