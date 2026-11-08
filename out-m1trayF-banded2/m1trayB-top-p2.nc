;@MKR|BEGIN
;@MKR|SCHEMA|v=1.0.0
;@MKR|MACHINE|id=Z1|name=Makera Z1
;@MKR|MATERIAL|id=0|name=hardwood
;@MKR|STOCK|id=cuboid|length=160|width=126|height=25|diameter=1
;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-80|y=-63|z=12.5
;@MKR|CAM|id=CaseMaker|name=Case Maker|v=1.0.0
;@MKR|UNIT|value=MM
;@MKR|TOOL|number=1|id=111218103807|name=TiN Coating Corn Bit - 1/8" Shank 1mm * 7mm|type=Flat End|handlediameter=3.175|sticklength=0|shoulderlength=0|flutelength=7|diameter=1|tipdiameter=1|cornerradius=0|angle=0|halfAngle=0
;@CM|TOOL|key=inv:kz-corn-1-7
;@CM|START|tool=empty
;@MKR|TIME|seconds=14
; cycle estimate: cutting + rapids through the trapezoid, timed on Makera Z1's rapid model (1200 mm/min XY, 600 mm/min Z, 150 mm/s² accel, config read 2026-10-07 + stopwatch 2026-10-08) — a planning estimate, not a measured cycle time
;@MKR|TOOLPATH|number=1|tool_number=1|name=[T1] Pocket "pocket-5"
;@MKR|END

G90 G21
;@MKR|TOOLPATH_START|toolpath_number=1

; T1-TiN Coating Corn Bit - 1/8" Shank 1mm * 7mm

T1 M6
G53 G0 Z-3
G0 X88.915 Y21.277
S12000 M3
G0 Z5
G0 Z1
G1 Z-0.3 F150
G1 X88.946 Y21.254 F400
G1 X88.976 Y21.277
G1 X88.946 Y21.301
G1 X88.915 Y21.277
G1 Z-0.577 F150
G1 X88.946 Y21.254 F400
G1 X88.976 Y21.277
G1 X88.946 Y21.301
G1 X88.915 Y21.277
G0 Z5
G0 Z15
M05
G28
M02
