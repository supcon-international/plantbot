"""Deterministic rules over tracked observations; no model or network dependencies."""
from __future__ import annotations
import datetime as dt
import json
import math
import re
from pathlib import Path

PRESETS = {p['id']: p for p in json.loads((Path(__file__).resolve().parents[2] / 'shared/vision-presets.json').read_text())}


def inside(point, polygon):
    x, y = point
    odd = False
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        cross = (x-a[0])*(b[1]-a[1])-(y-a[1])*(b[0]-a[0])
        if abs(cross) < 1e-9 and min(a[0], b[0]) <= x <= max(a[0], b[0]) and min(a[1], b[1]) <= y <= max(a[1], b[1]):
            return True
        if (a[1] > y) != (b[1] > y) and x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:
            odd = not odd
    return odd


def active(schedule, timestamp):
    if not schedule:
        return True
    t = dt.datetime.fromtimestamp(timestamp, dt.timezone.utc)
    day = (t.weekday()+1) % 7  # Same Sunday=0 contract as platform schedules.
    minute = t.strftime('%H:%M')
    start, end = schedule['start'], schedule['end']
    if start == end:
        return day in schedule['days']
    if start < end:
        return day in schedule['days'] and start <= minute < end
    return (day in schedule['days'] and minute >= start) or ((day-1) % 7 in schedule['days'] and minute < end)


def side(point, line):
    a, b = line
    return ((b[0]-a[0])*(point[1]-a[1])-(b[1]-a[1])*(point[0]-a[0])) / math.dist(a, b)


def crosses_segment(a, b, line):
    # Reject passing around a line's endpoint, even if the infinite line was crossed.
    return side(line[0], [a, b]) * side(line[1], [a, b]) <= 0 if a != b else False


class Rule:
    def __init__(self, config):
        self.c = config
        self.preset = PRESETS[config['preset']]
        self.reset()

    def reset(self):
        self.last = None
        self.started = None
        self.condition_since = None
        self.tracks = {}
        self.total = 0

    def result(self, status, value=None, text='', note=''):
        return dict(status=status, value=value, text=text, note=note)

    def evaluate(self, now, tracks=(), texts=(), valid=True, max_gap=3):
        c, rule = self.c, self.preset['rule']
        if not valid or not active(c.get('schedule'), now):
            self.reset()
            return self.result('unknown', note='Observation unavailable or outside the configured UTC schedule')
        if self.last is not None and (now <= self.last or now-self.last > max_gap):
            self.reset()
        self.last = now
        if self.started is None:
            self.started = now
        if rule == 'ocr':
            selected = [t for t in texts if t['score'] >= c['confidence']]
            if not selected:
                return self.result('unknown', note='No text met the confidence threshold')
            text = ' '.join(t['text'] for t in selected)
            value = None
            if c.get('numeric'):
                # A configured display ROI must contain one unambiguous numeric value.
                clean = text.strip()
                if c.get('unit') and clean.endswith(c['unit']):
                    clean = clean[:-len(c['unit'])].strip()
                if not re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)', clean):
                    return self.result('unknown', text=text, note='The ROI does not contain one unambiguous numeric reading')
                value = float(clean)
                if not math.isfinite(value) or abs(value) > 1e12:
                    return self.result('unknown', text=text, note='Numeric reading is outside supported bounds')
            alert = value is not None and ((c.get('min') is not None and value < c['min']) or (c.get('max') is not None and value > c['max']))
            return self.result('alert' if alert else 'normal', value, text, 'Reading outside configured range' if alert else 'Display read')
        target = self.preset['target']
        observed = []
        for t in tracks:
            box = t['box']
            anchor = ((box[0]+box[2])/2, box[3])  # Ground-contact point, normalized.
            if t['target'] == target and t['score'] >= c['confidence'] and inside(anchor, c['region']):
                observed.append((t, anchor))
        ids = set()
        crossed = 0
        matured = 0
        for t, anchor in observed:
            tid = t.get('id', -1)
            if tid < 0:
                continue
            ids.add(tid)
            state = self.tracks.setdefault(tid, {'since': now, 'anchor': anchor, 'side': 0, 'point': anchor})
            if rule == 'cross':
                signed = side(anchor, c['line'])
                s = 1 if signed > .008 else -1 if signed < -.008 else 0
                previous = state['side']
                if s and previous and s != previous and crosses_segment(state['point'], anchor, c['line']):
                    direction = 'forward' if previous < s else 'reverse'
                    if c['direction'] in ('both', direction):
                        crossed += 1
                if s:
                    state['side'], state['point'] = s, anchor
            elif rule in ('dwell', 'stationary'):
                if rule == 'stationary' and math.dist(anchor, state['anchor']) > .025:
                    state['since'], state['anchor'] = now, anchor
                if now-state['since'] >= c['durationS']:
                    matured += 1
        # Missing identities never accrue unobserved dwell time.
        self.tracks = {k: v for k, v in self.tracks.items() if k in ids}
        count = len(observed)
        if rule == 'count':
            return self.result('normal', count, note='Current occupancy')
        if rule == 'cross':
            self.total += crossed
            return self.result('alert' if crossed and target == 'person' else 'normal', self.total, note=f'{crossed} crossing(s); cumulative count since observation started')
        if rule in ('dwell', 'stationary'):
            return self.result('alert' if matured else 'normal', matured, note=f'{matured} tracked object(s) exceeded {c["durationS"]:g}s')
        condition = count < c['threshold'] if rule == 'below' else count > c['threshold']
        if not condition:
            self.condition_since = None
        elif self.condition_since is None:
            self.condition_since = now
        alert = self.condition_since is not None and now-self.condition_since >= c['durationS']
        # Do not claim a healthy empty post during initial observation warm-up.
        status = 'alert' if alert else 'unknown' if condition else 'normal'
        return self.result(status, count, note='Threshold sustained' if alert else 'Observing threshold duration' if condition else 'Within configured threshold')
