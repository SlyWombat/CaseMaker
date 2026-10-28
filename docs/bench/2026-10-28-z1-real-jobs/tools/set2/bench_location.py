"""Build the bench location for the 2026-10-28 second set: the house location with the operator's
confirmed Makera matches (#732) written on each owned cutter, plus the synced catalogue beside it."""
import json, glob, shutil, sys, os
out = sys.argv[1] if len(sys.argv) > 1 else 'bench'
os.makedirs(out, exist_ok=True)
SRC = glob.glob('/mnt/c/Users/*/AppData/Roaming/casemaker/location.json')[0]
CAT = glob.glob('/mnt/c/Users/*/AppData/Roaming/casemaker/catalogue.json')[0]
d = json.load(open(SRC))
M = {
 'kz-o-flute-3-175-25': '111011313825', 'kz-o-flute-m-3-175-12': '112111313812', 'kz-o-flute-3-175-42': '111011313842',
 'kz-o-flute-m-1-5-6': '112111153806', 'kz-o-flute-m-1-3': '112111103803', 'kz-corn-1-7': '111218103807',
 'kz-corn-0-6-3': '111218063803', 'kz-corn-2-0-10-5': '111218203811',
 'kz-chamfer-90': '122111013890', 'kz-engrave-m-60-0-1': '122111013860', 'kz-engrave-m-30-0-2': '122111023830',
 'kz-engrave-m-30-0-3': '122111033830', 'kz-engrave-30-0-5': '121011053830',
 'kz-drill-3-12': '142212303812', 'kz-thread-m3-9': '152111243809', 'kz-thread-m5-15': '152111403815',
 'kz-ball-nose-2-12': '131012203812', 'kz-ball-nose-1-4': '131012103804', 'kz-ball-nose-m-2-6': '132112203806',
 'kz-ball-nose-m-1-3': '132112103803', 'kz-ball-nose-m-3-175-10': '132112313810',
}
cat = json.load(open(CAT))
ct = {t['tool']['id']: t['tool'] for t in cat['tools']}
for it in d['inventory']:
    k, t = it.get('id'), it.get('tool')
    if k in M and t:
        row = ct[M[k]]
        t['id'] = M[k]
        if t.get('tipDiameter') is None and row.get('tipDiameter') is not None:
            t['tipDiameter'] = row['tipDiameter']   # the tip the box and the row state (#740)
        print(f"{k:26s} -> {M[k]}  {row['name']:38s} owned d={t.get('diameter')} tip={t.get('tipDiameter')} | row d={row.get('diameter')} tip={row.get('tipDiameter')}")
json.dump(d, open(os.path.join(out, 'location.json'), 'w'), indent=1)
shutil.copy(CAT, os.path.join(out, 'catalogue.json'))
