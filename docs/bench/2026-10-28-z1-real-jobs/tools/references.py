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
         # #968's fix reads the 49 strokes' 0.5003 mm bands from their transform. The drawing's own
         # rounded frame carries a scale-1 matrix, so its band is 1 mm: it is INCLUDED at its stated
         # width (Studio engraves it in the same T2 pass; at scale 0.90 it lands within 0.3 mm²).
         scale=0.90, depth=0.8,
         nc=('20260723180036-mrxcrnx2.nc',
             '5ea9732c7b57ca47dbedac45c428d64107d03a2d6aebd8ef4f73f618060e7d74'),
         job='ref-coasters.json',
         note='Studio’s engraver (T2) clears the strokes’ painted band at Z −0.8; its T4 contour frees '
              'the disc and its T6 chamfer breaks the rim, so the design comparison scores T2 only. '
              'The 49 strokes are 0.5003 mm bands, read from their 0.5-scale element matrix by the '
              'app’s own importer (#968). The drawing’s rounded frame carries a scale-1 matrix, so its '
              'band is 1 mm wide — twice the strokes’ — and it is INCLUDED at that stated width; its '
              'share of the design is one item of 50, and Studio engraves it in the same T2 pass.'),
    dict(id='ref-ringbox',
         title='Wooden Ring Box — the body, 3D feature',
         maker='superGG', licence='CC BY-ND 4.0',
         url='https://www.makerables.com/project/wooden-ring-box',
         slug='wooden-ring-box',
         material='hardwood', stock=(80.0, 80.0, 30.0), dz=5.0,
         nc=('RingBoxBody-mswk2mfo.nc',
             'edc2eed86304e67cc684fce1b546ed38b042963007a6ea4741c077cb6a51ab65'),
         model=('RingBoxBody-mswj6tmr.stl',
                '314ccbe6ee68fce332651cdc9bb759d99b156b102f3040ef5f56246aa99d427b'),
         job='ref-ringbox-body.json',
         note='The body of a two-part box; the lid is a separate 2D program on its own blank. The '
              'published STEP stands with its 25 mm axis on Y (bbox 50 × 25 × 50): the job turns it '
              'rotationX +90 so the 50 mm face is on the blank, which puts the box mouth up — the '
              'NC\'s own cut confirms it (the opposite turn reads 78 % cut-into). The 3D contour '
              'frees the part at Z −30, the blank\'s bottom, so the model top sits 5 mm under the '
              'stock top (dz 5.0; ±0.5 either way reads 99 % cut-into or 99.98 % leftover).'),
    dict(id='ref-toolholder',
         title='Cutting Tool Holder — the bottom side, pockets + arch',
         maker='Kalkalash', licence='CC BY-NC-ND 4.0',
         url='https://www.makerables.com/project/cutting-tool-holder',
         slug='cutting-tool-holder',
         material='softwood', stock=(120.0, 160.0, 28.0), dz=2.5,
         nc=('Bottom_makerastudio_TOP_20260717195037-mrp6ek38.nc',
             '1c448ff29d34cb2438f52e13786c69c2852736c3783c8f8a8546e5ea34cb82e0'),
         model=('bit_holder_rev2-mrp87ijk.stl',
                '4c1dff858a1b1f28ab4a8866a8d4837d9638e9f34dbd55e67d7b6235b45058c5'),
         job='ref-toolholder.json',
         note='Side 1 (bottom) of a double-sided project; the top side is cut on a 108 × 138 × 25 '
              'blank after the flip and is not scored here. The published STEP stands on its side — '
              'bbox 138 (X) × 23 (Y) × 108 (Z), thickness on Y — and Studio\'s auto-rotate '
              '(bAutoRotate is set in the .mks) lays it flat: rotationX −90 then rotationY 90 puts '
              'the 108 mm side along the blank\'s 120 mm X and the 138 mm side along its 160 mm Y '
              '(the in-plane 180 turns give the same field to 2e-6 mm). The model is centred in the '
              '28 mm blank, its top 2.5 mm under the stock top (dz 2.5; 2.0 reads −0.5 mm '
              'everywhere, 5.0 reads 2.5 mm leftover).'),
    dict(id='ref-wildspirit',
         title='Wild Spirit 3D Relief — the wolf, roughed with a flat, finished with a 30° engraver',
         maker='Makerables', licence='CC0 1.0',
         url='https://www.makerables.com/project/wild-spirit-3d-relief',
         slug='wild-spirit-3d-relief',
         material='abs', stock=(100.0, 100.0, 10.0), dz=0.5,
         nc=('Wolf-mqql2lif.nc',
             '82484c44d4af62901f12b845f6b3c15eecf34a9e5fa553f084b8e249bca8105b'),
         model=('Wolf-mqql5otd.stl',
                '51934927aadf5eb439bdd55d6e0f831660cbf06e5a3a21e4ec556dcf7cc46884'),
         job='ref-wildspirit.json',
         note='THE M3 SURFACING REFERENCE: a 3D relief roughed with a ⌀3.175 flat and finished with a '
              '⌀3.175 / 0.3 mm tip / 30° engraving bit, whose pass is a V-cone (leg 5.37 mm). The '
              '80 × 80 × 5 model is already flat in the published STL and sits with its top 0.5 mm '
              'under the stock top (dz 0.5; at 0.0 the whole surface reads −0.499 mm). The blank is '
              'epoxy tooling board; our job runs it as ABS, the nearest material the feed table '
              'carries, and the card states that substitution.'),
    dict(id='ref-knifebox',
         title='Knife Storage Box — the 3D feature and its contour',
         maker='Modulink', licence='CC0 1.0',
         url='https://www.makerables.com/project/knife-storage-box',
         slug='knife-storage-box',
         material='hardwood', stock=(300.0, 150.0, 20.0), dz=0.0,
         nc=('15-2_F3_175T1-mpweudt3.nc',
             '4b941add0eefd5bf290b2d99fd945e5b317e63931d016eafffb9dd5dc7a30663'),
         model=('15-2_-mpwewodq.stl',
                '158342e14c371093045f5a6f36e8341a2c430eb43ad2ed225e1e201ff7a46051'),
         job='ref-knifebox.json',
         note='A Carvera (C1) program — the Makerables project states that machine — so our column is '
              'the Z1 app on the same blank and may refuse. One ⌀3.175 flat, a 3D feature and a 2D '
              'contour, 52.0 min. The published STL’s 150 × 100 footprint sits at X 75–225, '
              'Y 25–125 of a 300 × 150 × 20 blank; the model top is the stock top (dz 0.0; 0.5 '
              'reads 99.77 % leftover, −0.5 reads 99.06 % cut-into).'),
    dict(id='ref-accuracy',
         title='CNC Accuracy Test Sample — pockets, holes, text and a slide test',
         maker='Molodos', licence='CC BY-NC-ND 4.0',
         url='https://www.makerables.com/project/cnc-accuracy-test-sample',
         slug='cnc-accuracy-test-sample',
         material='aluminium-6061', stock=(86.0, 56.0, 5.0), dz=1.0,
         nc=('cnc_sample_5_0mm_6061-mr16l8sz.nc',
             'dc603aeadae234c87b0516d4a71a9f225e240924b8d65f9afb64f10b412b86f1'),
         model=('cnc_sample-mr16xrph.stl',
                '3e87a660f5400fe4deaa38978b04d58e896a942abd03c34455a65d6c3716e941'),
         job='ref-accuracy.json',
         note='The Z1 accuracy plate: ten paths, four cutters (⌀2 and ⌀3.175 flats, a ⌀2 drill, an '
              'engraver), 55.9 min. Its “[T1]Remove Top” faces 1 mm off the blank first, so the '
              'model top sits 1 mm under the stock top (dz 1.0; 0.0 reads −1.0 mm everywhere, 2.0 '
              'reads 1.0 mm leftover). The published input is a STEP; the model file is that STEP '
              'converted with bin/step2stl.cjs (4,458 triangles, the published STEP’s sha256 '
              'abd81e3f…). The 70 × 40 part sits at (43, 28) on the 86 × 56 × 5 blank.'),
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
         note='The milestone’s first vendor-level reading: 100 % of the design covered by both programs, '
              '1.04× Makera’s cycle (31.1 vs 30.0 min), with one cutter to its three. Studio’s T2 2D '
              'Pocket reveals the second colour at Z −0.1; its T1 flat then pockets deeper (0.5–1.5) and '
              'frees the badge. The design comparison scores the T2 pass, which is the operation our job '
              'performs, at the same 0.1 mm depth.'),
]
# Parked with the reason, so the section says what it cannot yet put beside ours. Empty today.
PARKED = []

# The app's Z1 rapid profile (machine.ts): 5000 mm/min XY, 1000 mm/min Z. Used for the vendor
# file's air-fraction estimate until #964's scorer (which owns the shared implementation) lands.
RAPID_XY_MM_MIN = 5000.0
RAPID_Z_MM_MIN = 1000.0
