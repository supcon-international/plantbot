"""Run the real locked models against packaged input phases; no network/services."""
import hashlib
import json
from pathlib import Path
import sys
import cv2
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent/'vision'))
from inference import Models, Tracking, ViewGuard
from rules import Rule

pack = json.loads((ROOT/'pack.json').read_text())
manifest = json.loads((ROOT/'media/manifest.json').read_text())
for name, digest in manifest['files'].items():
    assert hashlib.sha256((ROOT/'media'/name).read_bytes()).hexdigest() == digest, name
models = Models(Path(sys.argv[1]) if len(sys.argv)>1 else ROOT.parent/'vision/models')
definitions = {r['preset']: dict(confidence=.5, durationS=3, **r) if 'durationS' not in r else dict(confidence=.5, **r) for r in pack['rules']}
proof = []
cap = cv2.VideoCapture(str(ROOT/'media/instrument.mp4'))
for second, expected, status in [(5,70,'normal'),(35,85.2,'alert'),(65,72,'normal')]:
    cap.set(cv2.CAP_PROP_POS_MSEC,second*1000)
    ok, frame = cap.read(); assert ok
    texts = models.read(frame, definitions['ocr']['region'])
    result = Rule(definitions['ocr']).evaluate(second, texts=texts)
    assert (result['value'],result['status']) == (expected,status), (second,texts,result)
    proof.append(dict(second=second, preset='ocr', **result))
cap.release()
cap = cv2.VideoCapture(str(ROOT/'media/restricted-area.mp4'))
guard, tracker = ViewGuard(), Tracking()
rules = {p:Rule(definitions[p]) for p in ['people_count','intrusion']}
for second in range(90):
    cap.set(cv2.CAP_PROP_POS_MSEC,second*1000)
    ok, frame = cap.read(); assert ok
    valid = guard.check(frame,second)
    tracks = tracker.update(models.detect(frame),frame,second) if valid else []
    results = {p:r.evaluate(second,tracks=tracks,valid=valid) for p,r in rules.items()}
    if second in [8,38,68]:
        assert valid, ('ViewGuard never stabilised',second)
        expected = 1 if second==38 else 0
        assert results['people_count']['value']==expected, (second,results,tracks)
        assert results['intrusion']['status']==('alert' if expected else 'normal'), (second,results)
        proof.append(dict(second=second, **results))
cap.release()
print(json.dumps({'passed': True, 'checks': ['packaged media checksums','real OCR normal-alert-recovery','real detector/tracker count and intrusion','unchanged ViewGuard recovers after scene transitions'], 'proof':proof},indent=2))
