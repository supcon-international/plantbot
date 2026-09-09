"""Run locked models against licensed camera recordings; no injected observations."""
import hashlib
import json
from pathlib import Path
import sys
import cv2
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent/'vision'))
from inference import Models, Tracking, ViewGuard, DETECTOR_VERSION, OCR_VERSION
from rules import Rule

pack = json.loads((ROOT/'pack.json').read_text())
manifest = json.loads((ROOT/'media/manifest.json').read_text())
assert pack['mediaRevision'] == manifest['mediaRevision'] == 'recorded-2026-09-v1'
for name, digest in manifest['files'].items():
    assert hashlib.sha256((ROOT/'media'/name).read_bytes()).hexdigest() == digest, name
models = Models(Path(sys.argv[1]) if len(sys.argv)>1 else ROOT.parent/'vision/models')
definitions = {r['preset']: dict(confidence=.5, durationS=3, **r) if 'durationS' not in r else dict(confidence=.5, **r) for r in pack['rules']}
proof = []
expected_ir = {2:33.2,3:33.2,4:31.1,5:31.1,6:32.3,7:32.3,8:32.6,9:32.6,10:33.1,11:33.1,12:34.3,13:34.3}
# The actual Source reopens this finite recording and resets its view/rule state.
# Repeat two file epochs, retaining the real 2 s warm-up as unknown each time.
for epoch in range(2):
    cap = cv2.VideoCapture(str(ROOT/'media/instrument.mp4'))
    assert (int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))) == (1280,1024)
    duration = cap.get(cv2.CAP_PROP_FRAME_COUNT)/cap.get(cv2.CAP_PROP_FPS)
    assert abs(duration-13.28)<.01, duration
    guard, rule = ViewGuard(), Rule(definitions['ocr'])
    for second in range(14):
        cap.set(cv2.CAP_PROP_POS_MSEC,second*1000)
        ok, frame = cap.read(); assert ok, second
        now = epoch*(duration+1)+second
        valid = guard.check(frame,now)
        texts = models.read(frame, definitions['ocr']['region']) if valid else []
        result = rule.evaluate(now, texts=texts, valid=valid)
        if second<2:
            assert not valid and result['status']=='unknown' and result['value'] is None, (epoch,second,result)
        else:
            expected = expected_ir[second]
            assert valid and (result['value'],result['status']) == (expected,'alert' if expected>33 else 'normal'), (epoch,second,texts,result)
        proof.append(dict(epoch=epoch,second=second,preset='ocr',valid=valid,texts=texts,**result))
    cap.release()
cap = cv2.VideoCapture(str(ROOT/'media/restricted-area.mp4'))
guard, tracker = ViewGuard(), Tracking()
rules = {p:Rule(definitions[p]) for p in ['people_count','intrusion']}
fps = cap.get(cv2.CAP_PROP_FPS)
assert fps>0
stride = max(1,round(fps/5))
index, people = 0, []
while True:
    ok, frame = cap.read()
    if not ok: break
    frame_index = index; index += 1
    if frame_index%stride: continue
    second = round(frame_index/fps,2)
    valid = guard.check(frame,second)
    if not valid: tracker = Tracking()
    tracks = tracker.update(models.detect(frame),frame,second) if valid else []
    results = {p:r.evaluate(second,tracks=tracks,valid=valid) for p,r in rules.items()}
    if not valid:
        assert all(r['status']=='unknown' and r['value'] is None for r in results.values()), (second,results)
    people.append(dict(second=second,valid=valid,**results))
cap.release()
assert 29<index/fps<=30, index/fps
for second, expected in [(3,0),(8.4,1),(12,0),(18.4,1),(22,0)]:
    row = next(r for r in people if r['second']==second)
    assert row['valid'] and row['people_count']['value']==expected, row
    assert row['intrusion']['status']==('alert' if expected else 'normal'), row
    proof.append(row)
print(json.dumps({'passed': True, 'models':{'ocr':OCR_VERSION,'detector':DETECTOR_VERSION},'checks': ['packaged recorded-media checksums and revision','original IR readings cross 33℃ and recover across two natural file loops','unchanged ViewGuard keeps both loop warm-ups unknown','real detector/tracker count 0→1→0→1→0 and two intrusion alerts with observed clearing'], 'proof':proof,'peopleObservations':people},indent=2))
