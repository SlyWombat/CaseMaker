;@MKR|BEGIN
;@MKR|SCHEMA|v=1.0.0
;@MKR|MACHINE|id=Z1|name=Makera Z1
;@MKR|MATERIAL|id=0|name=Test stock
;@MKR|STOCK|id=cuboid|length=60|width=30|height=6|diameter=1
;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-30|y=-15|z=3
;@MKR|CAM|id=CaseMaker|name=Case Maker|v=0.0.0-test
;@MKR|UNIT|value=MM
;@MKR|TOOL|number=1|id=0|name=3.175 flat|type=Flat End|handlediameter=3.175|sticklength=0|shoulderlength=12|flutelength=12|diameter=3.175|tipdiameter=3.175|cornerradius=0|angle=0|halfAngle=0
;@MKR|TIME|seconds=30
;@MKR|TOOLPATH|number=1|tool_number=1|name=[T1]three strokes
;@MKR|END

G90 G21
;@MKR|TOOLPATH_START|toolpath_number=1
T1 M6
M7
S12000 M3
G0 X10 Y8 Z30
G1 Z24.5 F200
G1 X50 F500
G0 Z30
G0 X10 Y15
G1 Z24 F200
G1 X50 F500
G0 Z30
G0 X10 Y22
G1 Z23 F200
G1 X50 F500
G0 Z40
M9
M05
G28
M02
