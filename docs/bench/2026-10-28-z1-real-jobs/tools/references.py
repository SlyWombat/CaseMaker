"""Makera Studio reference programs (#955, plan v2 §3).

Each entry is one part a maker published with the Studio program it was cut from. The vendor's NC
and model are EVALUATION-ONLY downloads: they are never committed. `build.py --makerables <dir>`
finds them under `dl/<slug>/` by file name and checks the sha256 before scoring, exactly as the
shop-owned meshes are injected. Absent inputs leave the card listed and unscored, never guessed.

`dz` is how far below the stock top the model's top face sits (the maker's facing allowance): the
goal heightfield is the model at that placement, read from the NC's `;@MKR|STOCK` header. `ours` is
the committed Case Maker job for the same model; its card is the `ref-*` entry in `cards.py`.
"""

REFS = [
    dict(id='ref-tray70',
         title='Modular Stackable Tool Trays — 70 mm tray, top side',
         maker='treintjes92', licence='CC BY-NC-SA 4.0',
         url='https://www.makerables.com/project/modular-stackable-tool-trays',
         slug='modular-stackable-tool-trays',
         material='hardwood', stock=(110.0, 140.0, 27.2), dz=1.2,
         nc=('Tool_Tray_70mm_Top-msfi5w1b.nc',
             '67c2d2f9f3536ecc93fdfa7e67fb94c9826ef674bf3b8a1e85ce2795aae482ab'),
         model=('70mm_Tool_Tray-msgtf7oi.stl',
                'f89683c8aaad50fb80c6553e4eed83fb7649c2d505650a5fa4e2529c969c203f'),
         job='ref-tray70.json',
         note='Side 1 (top) only. The published STEP does not carry the maker’s 10 mm underside '
              'recess (his bottom program cuts only a stacking channel), so the comparable line is '
              'top-surface coverage, not whole-surface.'),
    dict(id='ref-organizer',
         title='Makera Tool Organizer — top side',
         maker='Makera', licence='CC BY-NC-SA 4.0',
         url='https://www.makerables.com/project/makera-tool-organizer',
         slug='makera-tool-organizer',
         material='hardwood', stock=(170.0, 170.0, 26.8), dz=0.8,
         nc=('Tool_Organizer-msfgyhas.nc',
             'dc8c70aead44ff5fad5e7c01106ca45ba60b8eb71e80f1276bde912c7e928dad'),
         model=('Tool_Organizer_Z1-msfh3m77.stl',
                '50dcf301f424a5c231db27ef5bf052029ea016c7ee3167e1dbe2bc8afad6975b'),
         job='ref-organizer.json',
         note='Side 1 (top) only, five tools. The program cuts some pocket floors ~0.1 mm deeper '
              'than the published STEP; the card reports that as the vendor’s own number.'),
    dict(id='ref-topclamp',
         title='Top Clamp 3D Feature — aluminium, pocket + contour',
         maker='Makera', licence='CC0 1.0',
         url='https://www.makerables.com/project/top-clamp-3d-feature',
         slug='top-clamp-3d-feature',
         material='aluminium-6061', stock=(100.0, 100.0, 5.0), dz=0.0,
         nc=('TopClamp-mqqlocdq.nc',
             '626963dbc33831e574c7d5b692e06b5d7ab8c7987fc5640492406373a56a5112'),
         model=('TopClamp-mqqlz4pv.stl',
                '75b5f37dcceb490a83f5e7fd0868856d09d34450cf733f7ccd790b9f57fc95b5'),
         job='ref-topclamp.json',
         note='The STL is published standing on its side: the job lays it flat (rotationX −90) and '
              'places it where the NC cuts (part x 8–73, y 8–28). One cutter, ⌀3.175 flat, 29.2 min.'),
    dict(id='ref-halfclamp',
         title='Half-Length Top Clamp — aluminium, pocket + contour',
         maker='Makera', licence='CC0 1.0',
         url='https://www.makerables.com/project/half-length-top-clamp',
         slug='half-length-top-clamp',
         material='aluminium-6061', stock=(100.0, 100.0, 5.0), dz=0.0,
         nc=('HalfLengthTopClamp-mqzetlon.nc',
             '5cf844df493ddfd046a3cfb0e19810ab592c65ef1c4aafd24cdcdaee1a1ecb61'),
         model=('HalfLengthTopClamp-mqzf3671.stl',
                '4b299ef7c0c43d4e45a78d91570f349e5c272594163285c3f4574ea811376713'),
         job='ref-halfclamp.json',
         note='Same handling as the full clamp: laid flat from the published side-on STL, placed at '
              'the NC’s own footprint (part x 7.75–40.25, y 8–28), ⌀3.175 flat, 10.3 min.'),
    dict(id='ref-coasters',
         title='Traditional Mandala Wooden Coasters — the painted band, V-engraved',
         maker='Makerables maker', licence='CC BY 4.0',
         url='https://www.makerables.com/project/traditional-mandala-pattern-wooden-coasters',
         slug='traditional-mandala-pattern-wooden-coasters',
         material='hardwood', stock=(100.0, 100.0, 5.0), dz=0.0, tool=2,
         toolKey='inv:kz-engrave-30-0-3',
         # The published original is an SVG. The job is built from it at build time (#968 import):
         # stroke bands as regions, fitted to Studio's own engraving footprint.
         svg=('321-mrxcrxhw.svg', '42b7bb962f52635e5e39a03314f9ee22e199b48b336e841b6d66a45b3b211544'),
         strokeWidth=0.5, scale=0.90, depth=0.8,
         nc=('20260723180036-mrxcrnx2.nc',
             '5ea9732c7b57ca47dbedac45c428d64107d03a2d6aebd8ef4f73f618060e7d74'),
         job='ref-coasters.json',
         note='Studio’s engraver (T2) clears the strokes’ painted band at Z −0.8; its T4 contour frees '
              'the disc and its T6 chamfer breaks the rim, so the design comparison scores T2 only. '
              'The band is 0.5 mm: the drawing’s 1-unit default sits inside a 0.5-scale element '
              'matrix — the app’s importer at db907716 reads that default as 1 mm unscaled (found by '
              'this card), so the job states stroke-width 0.5 explicitly and the card says so.'),
    dict(id='ref-badge',
         title='Makera Badge 2D Pattern — the closed rings as regions, two-colour engraving',
         maker='Makera', licence='CC0 1.0',
         url='https://www.makerables.com/project/makera-badge-2d-patten',
         slug='makera-badge-2d-patten',
         material='abs', stock=(100.0, 100.0, 1.3), dz=0.0, tool=2,
         toolKey='inv:kz-engrave-30-0-3',
         # The zipped original's SVG: 173 closed rings at a hairline stroke — the outlines of the
         # areas Studio pockets for the second colour. `regions` fills each ring.
         svg=('MakeraBadge.svg', '09d5b467b89ac235987e602bd9045ab0b991b7dda500f83e45bc31ad8acd3431'),
         regions=True, depth=0.1,
         nc=('MakeraBadge-mqqoiinw.nc',
             '616fdca6b9f3a7f15ef355a8cd9e21f37d16f8632464d4fd9422599110605b93'),
         job='ref-badge.json',
         note='Studio’s T2 2D Pocket reveals the second colour at Z −0.1; its T1 flat then pockets '
              'deeper (0.5–1.5) and frees the badge. The design comparison scores the T2 pass, which '
              'is the operation our job performs, at the same 0.1 mm depth.'),
]
# Parked with the reason, so the section says what it cannot yet put beside ours. Empty today.
PARKED = []

# The app's Z1 rapid profile (machine.ts): 5000 mm/min XY, 1000 mm/min Z. Used for the vendor
# file's air-fraction estimate until #964's scorer (which owns the shared implementation) lands.
RAPID_XY_MM_MIN = 5000.0
RAPID_Z_MM_MIN = 1000.0
