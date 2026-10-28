import json, sys, os, re, glob
out = sys.argv[1]
try:
    r = json.load(open(os.path.join(out, 'receipt.json')))
except Exception as e:
    print('NO RECEIPT JSON:', e)
    print(open(os.path.join(out, 'stderr.txt')).read()[-3000:])
    sys.exit(0)
print('ok=', r.get('ok'), 'stage=', r.get('stage'), 'gate=', r.get('gate'))
for d in r.get('diagnostics', []):
    if d.get('severity') in ('error', 'warning'):
        print(f"  [{d['severity']}] {d['code']} ({d.get('program','')}): {d['message'][:400]}")
for f in r.get('refusals', []):
    print('  REFUSAL:', json.dumps(f)[:600])
det = r.get('details') or {}
for p in det.get('programs', []) or []:
    cam = p.get('cam') or {}
    sim = p.get('sim') or {}
    sheet = p.get('sheet') or {}
    print(f"  PROGRAM {p.get('name')} stage={p.get('stage')} ok={p.get('ok')} ops={cam.get('operations')} est={sheet.get('estimatedTime')} ({cam.get('estimatedSeconds')}) sim_ok={sim.get('ok')} engine={sim.get('engine')} removed={sim.get('removedVolumeMm3')} simErr={sim.get('errorCount')}")
    sf = sheet.get('file')
    if sf and os.path.exists(os.path.join(out, sf)):
        for line in open(os.path.join(out, sf)):
            if 'RPM' in line and 'feed' in line:
                m = re.search(r'\*\*(.*?)\*\*', line)
                print('    feeds:', m.group(1) if m else line.strip()[:200])
            if line.startswith('2. The cutter'):
                print('    cutter:', line.strip()[:200])
if r.get('ok') is False and not det.get('programs'):
    print(open(os.path.join(out, 'stderr.txt')).read()[-1500:])
