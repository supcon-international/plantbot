"""Adapter vision process: latest-frame sampling, shared inference, durable bounded outbox."""
from __future__ import annotations
import base64
import json
import logging
import os
from pathlib import Path
import signal
import sqlite3
import threading
import time
import uuid
os.environ.setdefault('OPENCV_LOG_LEVEL', 'OFF')
import cv2
import requests
from inference import Models, Tracking, ViewGuard, DETECTOR_VERSION, OCR_VERSION
from rules import Rule, PRESETS

log = logging.getLogger('vision')


class Source:
    def __init__(self, config, stop):
        self.config, self.stop = config, stop
        self.latest = None
        self.epoch = uuid.uuid4().hex
        self.status, self.note = 'unavailable', 'Connecting to source'
        self.lock = threading.Lock()
        threading.Thread(target=self.capture, daemon=True).start()

    def capture(self):
        url = self.config['url']
        remote = url.startswith(('rtsp://', 'rtsps://', 'http://', 'https://'))
        while not self.stop.is_set():
            cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG, [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000])
            fps = min(60, max(1, cap.get(cv2.CAP_PROP_FPS) or 25))
            with self.lock:
                self.epoch = uuid.uuid4().hex
            while not self.stop.is_set():
                ok, frame = cap.read()
                if not ok:
                    break
                # Limit memory; evidence remains the actual source frame at up to 1280px.
                h, w = frame.shape[:2]
                if max(h, w) > 1280:
                    frame = cv2.resize(frame, (round(w*1280/max(h,w)), round(h*1280/max(h,w))))
                with self.lock:
                    self.latest = (time.time(), frame, self.epoch)
                if not remote and self.stop.wait(1/fps):
                    break
            cap.release()
            with self.lock:
                self.latest = None
                self.status, self.note = 'unavailable', 'No fresh frames; reconnecting'
            if not remote and not self.config.get('loop', False):
                return
            self.stop.wait(1)

    def get(self):
        with self.lock:
            item = self.latest
        if not item or time.time()-item[0] > 3:
            return None
        return item

    def stationary(self):
        if self.config['view'] == 'fixed':
            return True
        try:
            state = json.loads(Path(self.config['stationaryFile']).read_text())
            age = time.time()-state['observedAt']/1000
            return state['stationary'] is True and 0 <= age <= 2
        except (KeyError, ValueError, OSError, TypeError):
            return False

    def public(self):
        return {k:self.config.get(k, '') for k in ('id', 'label', 'channelId', 'view')} | dict(status=self.status, note=self.note)


class Outbox:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, data TEXT NOT NULL)')

    def add(self, result):
        body = json.dumps(result, separators=(',', ':'))
        # 128 records / 64MB hard queue bound; expiry and overflow are visible in logs.
        while True:
            count, size = self.db.execute('SELECT count(*),coalesce(sum(length(data)),0) FROM outbox').fetchone()
            if count < 128 and size+len(body) <= 64*1024*1024:
                break
            self.db.execute('DELETE FROM outbox WHERE rowid=(SELECT rowid FROM outbox ORDER BY rowid LIMIT 1)')
            log.warning('Outbox full; oldest unsent observation discarded')
        self.db.execute('INSERT OR IGNORE INTO outbox VALUES(?,?)', (result['id'], body))
        self.db.commit()

    def flush(self, url, headers):
        for rid, data in self.db.execute('SELECT id,data FROM outbox ORDER BY rowid LIMIT 1').fetchall():
            try:
                response = requests.post(url+'/results', data=data, headers=headers, timeout=1)
            except requests.RequestException:
                return
            if response.status_code == 409 and 'lease expired' in response.text:
                return
            if response.status_code in (401, 403, 429) or response.status_code >= 500:
                return
            if response.ok or response.status_code in (400, 404, 409, 410, 413):
                self.db.execute('DELETE FROM outbox WHERE id=?', (rid,))
                self.db.commit()
                if not response.ok:
                    log.warning('Observation rejected: HTTP %s', response.status_code)
            else:
                return


class Worker:
    def __init__(self, config, models=None):
        self.config = config
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.runtime = uuid.uuid4().hex
        self.token, self.configs, self.jobs = '', [], []
        self.completed_jobs = set()
        self.sources = {s['id']: Source(s, self.stop) for s in config.get('sources', [])}
        self.url = config['serverUrl'].rstrip('/')+'/api/integration/v1/vision'
        self.headers = {'Authorization': 'Bearer '+os.environ.get('PB_SITE_KEY', config.get('siteKey', '')), 'Content-Type':'application/json'}
        self.models = models or Models(threads=int(os.environ.get('PB_VISION_THREADS', '2')))
        self.data = Path(os.environ.get('PB_VISION_DATA', str(Path(__file__).parent/'data')))
        self.data.mkdir(parents=True, exist_ok=True)
        self.outbox = Outbox(self.data/'outbox.db')
        self.states = {}
        self.views = {}
        self.progress = time.time()
        self.last_emit = {}

    def heartbeat(self):
        while not self.stop.is_set():
            try:
                if time.time()-self.progress > 60:
                    log.error('Inference watchdog expired; restarting the vision process')
                    os._exit(1)
                body = dict(adapterId=self.config['id'], runtimeId=self.runtime, name=self.config.get('name', self.config['id']), sources=[s.public() for s in self.sources.values()], models=dict(detector=DETECTOR_VERSION, ocr=OCR_VERSION))
                r = requests.post(self.url+'/heartbeat', json=body, headers=self.headers, timeout=5)
                r.raise_for_status()
                value = r.json()
                with self.lock:
                    self.token, self.configs, self.jobs = value['token'], value['configs'], value['jobs']
            except (requests.RequestException, ValueError, KeyError):
                log.warning('Server heartbeat unavailable; results remain in the local outbox')
                with self.lock:
                    self.token = ''
            self.stop.wait(3)

    def emit(self, config, result, timestamp, epoch, frame=None, annotations=(), job=None):
        key = job['id'] if job else config['id']
        previous = self.last_emit.get(key)
        if not job and previous and previous[1] == result['status'] and timestamp-previous[0] < config['intervalS']:
            return
        self.last_emit[key] = (timestamp, result['status'])
        image = ''
        if frame is not None:
            ok, jpg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ok:
                image = base64.b64encode(jpg).decode()
        body = dict(id=uuid.uuid4().hex, adapterId=self.config['id'], configId=config['id'], revision=config['revision'], capturedAt=round(timestamp*1000), observationId=epoch, model=OCR_VERSION if config['preset']=='ocr' else DETECTOR_VERSION, image=image, annotations=list(annotations)[:200], **result)
        if job:
            body['jobId'] = job['id']
            self.completed_jobs.add(job['id'])
        self.outbox.add(body)

    def run(self):
        threading.Thread(target=self.heartbeat, daemon=True).start()
        while not self.stop.is_set():
            now = time.time()
            self.progress = now
            with self.lock:
                configs, jobs, token = list(self.configs), list(self.jobs), self.token
            jobs = [j for j in jobs if j['id'] not in self.completed_jobs and j['expiresAt']/1000 > now]
            self.completed_jobs.intersection_update(j['id'] for j in self.jobs)
            work = [(c, None) for c in configs] + [(j['config'], j) for j in jobs]
            active_ids = {j['id'] if j else c['id'] for c, j in work}
            self.states = {k:v for k,v in self.states.items() if k in active_ids}
            self.last_emit = {k:v for k,v in self.last_emit.items() if k in active_ids}
            for source_id in {c['sourceId'] for c, _ in work}:
                group = [(c,j) for c,j in work if c['sourceId']==source_id]
                source = self.sources.get(source_id)
                item = source.get() if source else None
                if not item:
                    for c,j in group:
                        self.states.pop(j['id'] if j else c['id'], None)
                        self.emit(c, dict(status='failed',value=None,text='',note='Source has no fresh frames'), now, self.runtime, job=j)
                    continue
                captured, frame, epoch = item
                view = self.views.get(source_id)
                if not view or view['epoch'] != epoch or captured-view['last'] > 3:
                    view = self.views[source_id] = dict(epoch=epoch, last=0, guard=ViewGuard(), tracker=Tracking())
                    for c,j in group:
                        self.states.pop(j['id'] if j else c['id'], None)
                if captured <= view['last']:
                    continue
                view['last'] = captured
                valid = view['guard'].check(frame, captured) and source.stationary()
                source.status, source.note = ('ready','Receiving stable frames') if valid else ('paused','Waiting for a stable, usable view')
                if not valid:
                    view['tracker'] = Tracking()
                try:
                    tracks = view['tracker'].update(self.models.detect(frame), frame, captured) if valid and any(c['preset'] != 'ocr' for c,j in group) else []
                    for c,j in group:
                        key = j['id'] if j else c['id']
                        state = self.states.get(key)
                        if not state or state['revision'] != c['revision']:
                            state = self.states[key] = dict(revision=c['revision'], rule=Rule(c), started=captured)
                        texts = self.models.read(frame, c['region']) if valid and c['preset']=='ocr' else []
                        result = state['rule'].evaluate(captured, tracks, texts, valid=valid)
                        if j and captured-state['started'] < min(40, max(3,c['durationS']+2)):
                            continue
                        if j and c['durationS'] > 38 and result['status'] != 'alert':
                            result.update(status='unknown',note='Preview is limited to 40 seconds; enable the rule to observe the full duration')
                        annotations = [dict(label=t['text'],box=t['box'],score=t['score']) for t in texts] if c['preset']=='ocr' else [dict(label=t['label'],box=t['box'],score=t['score']) for t in tracks if t['score']>=c['confidence']]
                        self.emit(c,result,captured,epoch,frame,annotations,j)
                except Exception as exc:
                    # Do not include device URLs, credentials or arbitrary exception messages.
                    log.error('Inference failed (%s)', type(exc).__name__)
                    for c,j in group:
                        self.states.pop(j['id'] if j else c['id'], None)
                        self.emit(c,dict(status='failed',value=None,text='',note='Inference failed; check adapter health'),captured,epoch,job=j)
            if token:
                self.outbox.flush(self.url, self.headers | {'X-Vision-Token':token})
            (self.data/'health').write_text(str(time.time()))
            self.stop.wait(.2)
        self.outbox.db.close()


def load_config(path):
    c = json.loads(Path(path).read_text())
    import re
    from urllib.parse import urlparse
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', c.get('id','')):
        raise ValueError('adapter id must be a short identifier')
    if urlparse(c.get('serverUrl','')).scheme not in ('https','http'):
        raise ValueError('serverUrl must be an HTTP(S) Plantbot URL')
    if not os.environ.get('PB_SITE_KEY',c.get('siteKey','')):
        raise ValueError('PB_SITE_KEY is required')
    sources = c.get('sources',[])
    if len(sources)>8 or len({s['id'] for s in sources})!=len(sources):
        raise ValueError('at most eight unique sources are supported')
    for s in sources:
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',s.get('id','')) or not s.get('label') or s.get('view') not in ('fixed','mobile'):
            raise ValueError('source requires id, label and fixed/mobile view')
        if not isinstance(s.get('url'),str) or not s['url'] or len(s['url'])>4096:
            raise ValueError('source URL is required')
        if s['view']=='mobile' and not s.get('stationaryFile'):
            raise ValueError('mobile OCR requires a fresh stationaryFile from the device adapter')
    return c


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    worker = Worker(load_config(os.environ.get('PB_ADAPTER_CONFIG','adapter.json')))
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: worker.stop.set())
    worker.run()
