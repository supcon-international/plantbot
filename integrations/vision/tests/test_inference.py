import sys
import unittest
from pathlib import Path
import cv2
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from inference import Models, Tracking, ViewGuard
from rules import Rule
from test_rules import config


class Inference(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.models=Models()
        cls.person=cv2.imread(str(Path(__file__).parent/'fixtures/astronaut.png'))
    def test_real_pretrained_person_and_tracker(self):
        d=self.models.detect(self.person)
        self.assertTrue(any((d.class_id==0)&(d.confidence>.8)))
        track=Tracking()
        track.update(d,self.person,0)
        observed=track.update(d,self.person,.2)
        self.assertTrue(any(t['id']>=0 and t['score']>.8 for t in observed))
        result=Rule(config('people_count')).evaluate(.2,observed)
        self.assertEqual(result['value'],1)
    def test_real_pretrained_display_ocr(self):
        image=np.full((240,640,3),255,np.uint8)
        cv2.putText(image,'85.2 C',(70,150),cv2.FONT_HERSHEY_SIMPLEX,2.4,(0,0,0),4)
        texts=self.models.read(image,[[0,0],[1,0],[1,1],[0,1]])
        self.assertEqual(texts[0]['text'],'85.2 C')
        c=config('ocr');c.update(numeric=True,unit='C',max=80)
        result=Rule(c).evaluate(0,texts=texts)
        self.assertEqual((result['status'],result['value']),('alert',85.2))
    def test_dark_camera_motion_and_stable_recovery(self):
        guard=ViewGuard()
        self.assertFalse(guard.check(np.zeros_like(self.person),0))
        guard.check(self.person,1)
        self.assertTrue(guard.check(self.person,3))
        shifted=cv2.warpAffine(self.person,np.float32([[1,0,30],[0,1,0]]),(512,512))
        self.assertFalse(guard.check(shifted,4))
        self.assertFalse(guard.check(shifted,5))
        self.assertTrue(guard.check(shifted,7))

if __name__=='__main__':unittest.main()
