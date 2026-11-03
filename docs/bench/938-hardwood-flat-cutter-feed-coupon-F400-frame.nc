;@MKR|BEGIN
;@MKR|SCHEMA|v=1.0.0
;@MKR|MACHINE|id=Z1|name=Makera Z1
;@MKR|MATERIAL|id=0|name=hardwood
;@MKR|STOCK|id=cuboid|length=36|width=100|height=36|diameter=1
;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-18|y=-50|z=18
;@MKR|CAM|id=CaseMaker|name=Case Maker|v=1.0.0
;@MKR|UNIT|value=MM
;@MKR|TOOL|number=1|id=0|name=1 mm flat end|type=Flat End|handlediameter=3.175|sticklength=0|shoulderlength=0|flutelength=0|diameter=1|tipdiameter=1|cornerradius=0|angle=0|halfAngle=0
;@CM|TOOL|key=flat-1.0
;@CM|START|tool=empty
;@MKR|TIME|seconds=16
; cycle estimate: cutting + rapids through the trapezoid, timed on Makera Z1's rapid model (1200 mm/min XY, 600 mm/min Z, 150 mm/s² accel, config read 2026-10-07 + stopwatch 2026-10-08) — a planning estimate, not a measured cycle time
;@MKR|TOOLPATH|number=1|tool_number=1|name=Frame trace
;@MKR|END

G90 G21
;@MKR|TOOLPATH_START|toolpath_number=1

; T1-1 mm flat end

T1 M6
G53 G0 Z-3
G0 X3.876 Y31.381
S12000 M3
G0 Z20
G0 X32.124
G0 Y40.619
G0 X3.876
G0 Y31.381
G0 Z15
M05
G28
M02
