import datetime as dt
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from rules import Rule, PRESETS, active


def config(preset, **values):
    return dict(preset=preset, region=[[0,0],[1,0],[1,1],[0,1]],line=[[.5,0],[.5,1]],direction='both',durationS=2,threshold=1,confidence=.5,numeric=False,min=None,max=None,**values)


def person(x=.3,tid=1,target='person'):
    return dict(id=tid,box=[x-.05,.1,x+.05,.8],score=.9,target=target)


class Rules(unittest.TestCase):
    def test_exact_catalogue(self):
        self.assertEqual(len(PRESETS),11)
    def test_people_count_roi_confidence(self):
        r=Rule(config('people_count'))
        self.assertEqual(r.evaluate(0,[person(),person(tid=2)])['value'],2)
        self.assertEqual(r.evaluate(1,[person(target='vehicle')])['value'],0)
    def test_line_crossing_direction_segment_and_debounce(self):
        c=config('line_crossing');c['direction']='reverse'
        r=Rule(c)
        self.assertEqual(r.evaluate(0,[person(.4)])['value'],0)
        self.assertEqual(r.evaluate(1,[person(.6)])['status'],'alert')
        self.assertEqual(r.evaluate(2,[person(.61)])['status'],'normal')
        self.assertEqual(r.evaluate(3,[person(.4)])['value'],1)
        c['line']=[[.5,0],[.5,.3]]
        r=Rule(c);r.evaluate(0,[person(.4)])
        self.assertEqual(r.evaluate(1,[person(.6)])['value'],0)
    def test_vehicle_count_excludes_people(self):
        r=Rule(config('vehicle_count'))
        r.evaluate(0,[person(.4,target='vehicle'),person(.4,2)])
        v=r.evaluate(1,[person(.6,target='vehicle'),person(.6,2)])
        self.assertEqual((v['status'],v['value']),('normal',1))
    def test_intrusion_and_crowding_debounce(self):
        for preset,threshold,objects in [('intrusion',0,[person()]),('crowding',1,[person(),person(tid=2)])]:
            c=config(preset);c['threshold']=threshold;r=Rule(c)
            self.assertEqual(r.evaluate(0,objects)['status'],'unknown')
            self.assertEqual(r.evaluate(1,objects)['status'],'unknown')
            self.assertEqual(r.evaluate(2,objects)['status'],'alert')
            self.assertEqual(r.evaluate(3,[])['status'],'normal')
    def test_absence_post_occupancy_are_not_normal_during_warmup(self):
        for preset in ('absence','post_occupancy'):
            r=Rule(config(preset))
            self.assertEqual(r.evaluate(0,[])['status'],'unknown')
            self.assertEqual(r.evaluate(2,[])['status'],'alert')
            self.assertEqual(r.evaluate(3,[person()])['status'],'normal')
    def test_dwell_tracks_and_lost_observations(self):
        for preset in ('loitering','hazard_dwell'):
            r=Rule(config(preset));r.evaluate(0,[person()])
            self.assertEqual(r.evaluate(2,[person()])['status'],'alert')
            r.evaluate(3,[])
            self.assertEqual(r.evaluate(4,[person()])['status'],'normal')
            r.evaluate(5,[person()],valid=False)
            self.assertEqual(r.evaluate(6,[person()])['status'],'normal')
            self.assertEqual(r.evaluate(30,[person()])['status'],'normal')
    def test_parking_requires_stationary_vehicle(self):
        r=Rule(config('illegal_parking'));r.evaluate(0,[person(target='vehicle')])
        self.assertEqual(r.evaluate(1,[person(.4,target='vehicle')])['status'],'normal')
        self.assertEqual(r.evaluate(2,[person(.4,target='vehicle')])['status'],'normal')
        self.assertEqual(r.evaluate(3,[person(.4,target='vehicle')])['status'],'alert')
    def test_ocr_never_guesses_ambiguous_value(self):
        c=config('ocr');c.update(numeric=True,min=0,max=100,unit='C');r=Rule(c)
        read=lambda text:r.evaluate(1,texts=[dict(text=text,score=.9)])
        self.assertEqual(read('80 C')['value'],80)
        self.assertEqual(read('120 C')['status'],'alert')
        self.assertEqual(read('80 90')['status'],'unknown')
        self.assertEqual(read('8O')['status'],'unknown')
        self.assertEqual(r.evaluate(2,texts=[])['status'],'unknown')
    def test_utc_overnight_schedule(self):
        schedule=dict(days=[1],start='22:00',end='02:00')
        timestamp=lambda s:dt.datetime.fromisoformat(s).replace(tzinfo=dt.timezone.utc).timestamp()
        self.assertTrue(active(schedule,timestamp('2026-09-08T01:59:00')))
        self.assertFalse(active(schedule,timestamp('2026-09-08T02:00:00')))
        self.assertFalse(active(schedule,timestamp('2026-09-08T23:00:00')))
    def test_backwards_time_and_tracking_restart(self):
        r=Rule(config('hazard_dwell'));r.evaluate(10,[person()]);r.evaluate(12,[person()])
        self.assertEqual(r.evaluate(5,[person()])['status'],'normal')
        self.assertEqual(r.evaluate(6,[person(tid=-1)])['value'],0)

if __name__=='__main__':unittest.main()
