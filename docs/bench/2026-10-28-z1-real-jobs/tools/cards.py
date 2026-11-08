"""The gate's cards. One per job, judged by a computed check against the job's own design (2.5D),
the app's goal heightfield (3D), or a reference program swept the same way (j01). No photo decides
a verdict; a maker's page is the provenance line only.

kind: 'design' (design_check.py) | 'goal' (goal-hf.mts + goal_check.py) | 'reference' (design, plus
a reference program swept on the same blank).
input: 'committed' (job file in ../jobs) | 'local' (a shop-owned mesh, embedded in the committed
job; marked as such on the page).
"""

APPENDIX = [
    ('j06 wolf relief', 'input is CC BY-NC-ND (printables.com/model/1261158), not reproducible here'),
    ('j08 rotary bust', 'cannot be described as a job yet (no 3D carving on the rotary)'),
    ('j09 PCB', 'needs a login and a board layout this shop cannot bring in'),
    ('j26 split-helix', 'a pair of posted halves with no design to check them against'),
]

# The five Milestone 1 hardwood samples (36 × 36 × 100 sticks). A sample becomes a gate card in
# CARDS when its job file is committed; until then the page lists it here with what is still missing,
# so the same page gates the bench and shows what it cannot yet judge.
SAMPLES = [
    ('S1', 936, 'Flagship text job on the stick', 'job file committed (card s1); the job the maintainer cuts first, at bench session S2'),
    ('S2', 938, 'Hardwood flat-cutter feed coupon', 'four programs on disk (card s2); the row flips to measured when the bench fills the record'),
    ('S3', 939, 'Pocket and four bores on the 36 × 100 face', 'job file committed (card s3); cut at bench session S5'),
    ('S4', 940, 'Two-cutter job: pocket, then V text on its floor', 'job file committed (card s4); cut at bench session S5/S6'),
    ('S5', 941, 'Chamfer the top edges, then a through-slot', 'job file committed (card s5); cut at bench session S6'),
]

# Per-card text the computed sentence would otherwise bury, by card id. Two kinds only: a fact
# about the input (a refusal that is correct is stated as a fact, not as an app defect), and a
# known deviation with its issue number. Cards whose sentence already says it plainly stay out.
CARD_NOTES = {
    'ref-wildspirit': 'Makera’s STL is not a closed surface (172 edges shared by more than two '
                      'triangles, even after cleanup); the app refuses it correctly.',
}

CARDS = [
    dict(id='j01', title='Aluminium Top Clamp, the Z1’s preloaded first job', job='j01-topclamp-alu.json',
         kind='reference', input='committed', material='aluminium',
         source='Makera Z1 Quick Start — Top Clamp (wiki.makera.com)',
         reference=dict(
             name='Makera’s own TopClamp.nc',
             url='https://github.com/MakeraInc/CarveraProfiles/releases/download/v0.9.1/TopClamp.nc')),
    dict(id='j02', title='“CNX” over “Software”, raised on a plastic plate', job='j02-raised-cnx.json',
         kind='design', input='committed', material='PLA',
         source='CNX Software review of the Z1'),
    dict(id='j03', title='Small “CNX Software” text, block in the low-profile vise', job='j03-vise-text.json',
         kind='design', input='committed', material='PLA',
         source='CNX Software review of the Z1'),
    dict(id='j04', title='Aluminium coin with raised “CNX / Software”', job='j04-coin-alu.json',
         kind='design', input='committed', material='aluminium',
         source='CNX Software review of the Z1'),
    dict(id='j05', title='Red-over-white sign, “CNX Software” cut through to white', job='j05-sign-laminate.json',
         kind='design', input='committed', material='laminate',
         source='CNX Software review of the Z1'),
    dict(id='j07', title='Photo to relief, then cut out with tabs', job='j07-photo-relief.json',
         kind='goal', input='committed', material='PLA',
         source='Makera blog, photo-to-relief (portrait: Gardner 1863, public domain)'),
    dict(id='j10', title='V-carved plaque: a dandelion and “Ruth”', job='j10-plaque-90v.json',
         kind='design', input='committed', material='PLA',
         source='Carbide 3D community forum'),
    dict(id='j11', title='V-inlay star, female pocket “FF”', job='j11-inlay-female-90v.json',
         kind='design', input='committed', material='PLA',
         source='Carbide 3D community forum (VCarve inlays)'),
    dict(id='j12', title='Aluminium wrench plate', job='j12-wrench-alu.json',
         kind='design', input='committed', material='aluminium',
         source='patshead.com, first aluminium CNC attempt'),
    dict(id='j13', title='Tool tray, bit pockets and a tabbed cut-out', job='j13-tool-tray.json',
         kind='design', input='committed', material='PLA',
         source='Carbide 3D community forum (Nomad tool tray)'),
    dict(id='j14', title='Dog tag in aluminium, “REX 555-0100”', job='j14-dog-tag-alu.json',
         kind='design', input='committed', material='aluminium',
         source='Bantam Tools, engraving dog tags'),
    dict(id='j15', title='Darth Vader keychain outline in acrylic', job='j15-vader-acrylic.json',
         kind='design', input='committed', material='acrylic',
         source='Easel gallery (artwork: OpenMoji, CC BY-SA 4.0)'),
    dict(id='j16a', title='Chamfer a bevel: 1 × 45° on the plate’s edges', job='j16-chamfer-a-bevel.json',
         kind='design', input='committed', material='PLA',
         source='Makera chamfering bit (no published project)'),
    dict(id='j16b', title='Chamfer b cut-out: the plate freed on tabs', job='j16-chamfer-b-cutout.json',
         kind='design', input='committed', material='PLA',
         source='Makera chamfering bit (no published project)'),
    dict(id='j17', title='Faceplate: pot holes, DC jack and window', job='j17-faceplate-alu.json',
         kind='design', input='committed', material='aluminium',
         source='Love My Switches, 1590B CNC Pro enclosure'),
    dict(id='j18', title='M3 threaded bore in aluminium', job='j18-thread-a-bore-alu.json',
         kind='design', input='committed', material='aluminium',
         source='Makera thread-milling bit (no published job)'),
    dict(id='j19', title='CNC accuracy test sample, aluminium', job='j19-accuracy-sample.json',
         kind='design', input='committed', material='aluminium',
         source='Makerables — Molodos (CC BY-NC-ND 4.0)'),
    dict(id='j20', title='Personalised spoon rest, a hexagon with a raised letter', job='j20-spoon-rest.json',
         kind='design', input='committed', material='PLA',
         source='CutRocket — Personalize Spoon Rest'),
    dict(id='j21', title='Coaster with an epoxy inlay', job='j21-coaster-inlay.json',
         kind='design', input='committed', material='PLA',
         source='CutRocket — Coaster with epoxy inlay'),
    dict(id='j22', title='Square snack tray, three compartments', job='j22-snack-tray.json',
         kind='design', input='committed', material='PLA',
         source='Makerables — MakeHaven (CC0 1.0)'),
    dict(id='j23', title='Blue Shell warning sign, two-colour laminate', job='j23-shell-sign.json',
         kind='design', input='committed', material='laminate',
         source='Makerables (CC BY-NC-ND 4.0)'),
    dict(id='j24', title='Bicycle spoke wrench, aluminium', job='j24-spoke-wrench.json',
         kind='design', input='committed', material='aluminium',
         source='Makerables (CC0 1.0)'),
    dict(id='j25', title='Disc-brake truing wrench, aluminium', job='j25-truing-wrench.json',
         kind='design', input='committed', material='aluminium',
         source='Makerables (CC0 1.0)'),
    dict(id='j27', title='Mouse shell, side 1 (3D goal)', job='j27-mouse-shell-side1.json',
         kind='goal', input='local', material='PLA',
         source='shop sample mesh mouse-shell.stl (local input)'),
    dict(id='j28', title='Panther, laid flat on the hardwood stick (3D goal)', job='j28-panther-stick.json',
         kind='goal', input='local', material='hardwood',
         source='the maintainer’s nude_pantherv2-final.stl (local input), scaled in the app to the 36 × 36 × 100 stick'),
    dict(id='j29', title='Elephant on the hardwood stick (3D goal)', job='j29-elephant-stick.json',
         kind='goal', input='local', material='hardwood',
         source='the maintainer’s lfs_elephant.stl (local input), scaled in the app to the 36 × 36 × 100 stick'),
    # The Milestone 1 samples that have a committed job: judged on the k3 house export (owned cutters
    # only), the way the bench runs them. Sample 2's card is its row's own value (F1000) — the four
    # values F400/F700/F1000/F1200 are the coupon's programs, and the row is measured when the bench
    # fills the record.
    dict(id='s1', title='Sample 1: the flagship text job on the stick', job='../../936-flagship-text.job.json',
         kind='design', input='committed', material='hardwood', location='k3',
         source='Sample 1 (#936) — "CASE" / "MAKER" / "first chips" along the 100 mm axis, 8 / 7 / 6 mm, 2 / 1 / 0.5 mm deep'),
    dict(id='s2', title='Hardwood feed coupon: F1000, the row’s own value', job='../../938-hardwood-flat-cutter-feed-coupon-F1000.job.json',
         kind='design', input='committed', material='hardwood', location='k3',
         source='Sample 2 (#938) — four cells F400/F700/F1000/F1200 on flat-1.0, 9 mm text, 1.0 mm deep'),
    dict(id='s3', title='Sample 3: a pocket and four bores on the stick', job='../../939-pocket-bores.job.json',
         kind='design', input='committed', material='hardwood', location='k3',
         source='Sample 3 (#939) — a 20 × 10 × 3.0 pocket (r 2), a ⌀8 × 3.0 pocket and four ⌀3.2 × 6 bores'),
    dict(id='s4', title='Sample 4: a pocket, then the initials on its floor', job='../../940-two-cutter.job.json',
         kind='design', input='committed', material='hardwood', location='k3',
         source='Sample 4 (#940) — a 24 × 24 × 6 pocket (r 3), then "CM" 10 mm 0.8 into its floor; the app picks each program’s cutter'),
    dict(id='s5', title='Sample 5: the top edges chamfered, then a through-slot', job='../../941-chamfer-slot.job.json',
         kind='design', input='committed', material='hardwood', location='k3',
         source='Sample 5 (#941) — a 1 × 45° bevel on the stock’s edges, then a 6 × 10 slot across the full 36 mm width (the cutter leaves the stock)'),
    # #955 — the reference cards: a Makerables part, Makera Studio's own NC scored on the same goal
    # heightfield as our program. Vendor inputs are evaluation-only local downloads (see
    # references.py); the card says "inputs absent" when they are not on the machine.
    dict(id='ref-tray70', title='Reference: tool tray 70 mm — Makera Studio’s program beside ours',
         job='ref-tray70.json', kind='goal', input='local', material='hardwood', vendor='ref-tray70',
         source='Makerables — Modular Stackable Tool Trays, treintjes92 (CC BY-NC-SA 4.0); Makera Studio’s own NC'),
    dict(id='ref-tray70-tape', title='Reference: tool tray 70 mm, held on tape at a 0.2 mm grid (the operator’s changes, stated)',
         job='ref-tray70-tape.json', kind='goal', input='local', material='hardwood', vendor='ref-tray70',
         source='Makerables — Modular Stackable Tool Trays, treintjes92 (CC BY-NC-SA 4.0); Makera Studio’s own NC'),
    dict(id='ref-organizer', title='Reference: Makera tool organizer — Makera Studio’s program beside ours',
         job='ref-organizer.json', kind='goal', input='local', material='hardwood', vendor='ref-organizer',
         source='Makerables — Makera Tool Organizer (CC BY-NC-SA 4.0); Makera Studio’s own NC'),
    dict(id='ref-topclamp', title='Reference: Makera top clamp 3D feature — Makera Studio’s program beside ours',
         job='ref-topclamp.json', kind='goal', input='local', material='aluminium-6061', vendor='ref-topclamp',
         source='Makerables — Top Clamp 3D Feature (CC0 1.0); Makera Studio’s own NC'),
    dict(id='ref-halfclamp', title='Reference: half-length top clamp — Makera Studio’s program beside ours',
         job='ref-halfclamp.json', kind='goal', input='local', material='aluminium-6061', vendor='ref-halfclamp',
         source='Makerables — Half-Length Top Clamp (CC0 1.0); Makera Studio’s own NC'),
    # A drawn reference (#968): the job is built at build time from the maker's SVG, its stroke bands
    # as regions, and both programs are scored against that one design.
    dict(id='ref-coasters', title='Reference: mandala coasters — the painted band, V-engraved',
         job='ref-coasters.json', kind='design', input='local', material='hardwood', vendor='ref-coasters',
         source='Makerables — Traditional Mandala Wooden Coasters (CC BY 4.0); Makera Studio’s own NC'),
    dict(id='ref-badge', title='Reference: Makera badge — the drawn areas, two-colour engraving',
         job='ref-badge.json', kind='design', input='local', material='abs', vendor='ref-badge',
         source='Makerables — Makera Badge 2D Pattern (CC0 1.0); Makera Studio’s own NC'),
    dict(id='ref-ringbox', title='Reference: wooden ring box, the body — Makera Studio’s program beside ours',
         job='ref-ringbox-body.json', kind='goal', input='local', material='hardwood', vendor='ref-ringbox',
         source='Makerables — Wooden ring box, superGG (CC BY-ND 4.0); Makera Studio’s own NC'),
    dict(id='ref-toolholder', title='Reference: cutting tool holder, bottom side — Makera Studio’s program beside ours',
         job='ref-toolholder.json', kind='goal', input='local', material='softwood', vendor='ref-toolholder',
         source='Makerables — Cutting Tool Holder, Kalkalash (CC BY-NC-ND 4.0); Makera Studio’s own NC'),
    dict(id='ref-wildspirit', title='Reference: Wild Spirit 3D relief, the wolf — Makera Studio’s program beside ours',
         job='ref-wildspirit.json', kind='goal', input='local', material='abs', vendor='ref-wildspirit',
         source='Makerables — Wild Spirit 3D Relief (CC0 1.0); Makera Studio’s own NC'),
    dict(id='ref-knifebox', title='Reference: knife storage box — Makera Studio’s program beside ours',
         job='ref-knifebox.json', kind='goal', input='local', material='hardwood', vendor='ref-knifebox',
         source='Makerables — Knife Storage Box, Modulink (CC0 1.0); Makera Studio’s own NC (a Carvera C1 program)'),
    dict(id='ref-accuracy', title='Reference: CNC accuracy test sample — Makera Studio’s program beside ours',
         job='ref-accuracy.json', kind='goal', input='local', material='aluminium-6061', vendor='ref-accuracy',
         source='Makerables — CNC Accuracy Test Sample, Molodos (CC BY-NC-ND 4.0); Makera Studio’s own NC'),
]
