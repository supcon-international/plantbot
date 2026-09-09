import sys
import unittest
from pathlib import Path
import cv2
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from inference import Models, Tracking, ViewGuard
from rules import Rule
from test_rules import config


MEDIA = Path(__file__).resolve().parents[2] / 'demo' / 'media'
PERSON_REGION = [[.38, .43], [.65, .43], [.65, 1], [.38, 1]]
INSTRUMENT_REGION = [[.7, .12], [1, .12], [1, .5], [.7, .5]]


def frame_at(name, seconds):
    capture = cv2.VideoCapture(str(MEDIA / name))
    try:
        capture.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000)
        ok, frame = capture.read()
        if not ok:
            raise AssertionError(f'Cannot decode bundled real recording {name} at {seconds}s')
        return frame
    finally:
        capture.release()


class Inference(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.models = Models()
        cls.person = frame_at('restricted-area.mp4', 7)

    def test_real_pretrained_person_and_tracker(self):
        detections = self.models.detect(self.person)
        self.assertTrue(any((detections.class_id == 0) & (detections.confidence > .8)))
        tracker = Tracking()
        tracker.update(detections, self.person, 7)
        following = frame_at('restricted-area.mp4', 7.2)
        observed = tracker.update(self.models.detect(following), following, 7.2)
        self.assertTrue(any(t['id'] >= 0 and t['score'] > .8 for t in observed))
        c = config('people_count'); c['region'] = PERSON_REGION
        self.assertEqual(Rule(c).evaluate(7.2, observed)['value'], 1)
        # The same unmodified camera recording is empty before and after passage.
        for second in (0, 22):
            with self.subTest(second=second):
                frame = frame_at('restricted-area.mp4', second)
                d = self.models.detect(frame)
                self.assertFalse(any((d.class_id == 0) & (d.confidence >= .5)))

    def test_real_pretrained_display_ocr(self):
        c = config('ocr')
        c.update(region=INSTRUMENT_REGION, numeric=True, unit='℃', max=33)
        rule = Rule(c)
        # Native IR camera overlay; no generated digits or composited display.
        for second, expected, status in ((0, 34.3, 'alert'), (4, 31.1, 'normal'), (10, 33.1, 'alert')):
            with self.subTest(second=second):
                frame = frame_at('instrument.mp4', second)
                self.assertEqual(frame.shape[:2], (1024, 1280))
                texts = self.models.read(frame, INSTRUMENT_REGION)
                self.assertEqual([t['text'] for t in texts if t['score'] >= .5], [f'{expected}℃'])
                result = rule.evaluate(second, texts=texts)
                self.assertEqual((result['status'], result['value']), (status, expected))

    def test_dark_camera_motion_and_stable_recovery(self):
        guard = ViewGuard()
        # Negative guard stimuli only; these frames are never test video sources.
        self.assertFalse(guard.check(np.zeros_like(self.person), 0))
        guard.check(self.person, 1)
        self.assertTrue(guard.check(self.person, 3))
        h, w = self.person.shape[:2]
        shifted = cv2.warpAffine(self.person, np.float32([[1, 0, 30], [0, 1, 0]]), (w, h))
        self.assertFalse(guard.check(shifted, 4))
        self.assertFalse(guard.check(shifted, 5))
        self.assertTrue(guard.check(shifted, 7))


if __name__ == '__main__':
    unittest.main()
