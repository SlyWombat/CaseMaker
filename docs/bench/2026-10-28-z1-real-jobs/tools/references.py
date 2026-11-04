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
]

# Parked with the reason, so the section says what it cannot yet put beside ours.
PARKED = [
    ('ref-coasters', 'Traditional Mandala Wooden Coasters (CC BY 4.0)',
     'our SVG import reads the drawing’s stroke paths as centre lines (50 traces), while Studio’s '
     '2D区域清理 clears the strokes’ painted bands (a 0.15 mm raster at Z −0.8). Our line job posts '
     '(4 min 3 s vs Studio’s 4.1 min) and matches its own design 50/50, but scored against it '
     'Studio’s own program leaves up to 0.44 mm on every stroke and cuts 224 mm² outside the design: '
     'the comparable job needs the stroke bands as regions — an import-fidelity gap to file first'),
    ('ref-badge', 'Makera Badge 2D Pattern (CC0 1.0)',
     'the published original is a zipped 2D image: the same design-side comparison as the coasters, '
     'with the raster trace in place of the SVG stroke bands'),
]

# The app's Z1 rapid profile (machine.ts): 5000 mm/min XY, 1000 mm/min Z. Used for the vendor
# file's air-fraction estimate until #964's scorer (which owns the shared implementation) lands.
RAPID_XY_MM_MIN = 5000.0
RAPID_Z_MM_MIN = 1000.0
