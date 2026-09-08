import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from worker import Outbox, Source


class WorkerReliability(unittest.TestCase):
    def test_outbox_retry_restart_and_expired_lease(self):
        seen=[];state={'status':500,'text':'unavailable'}
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                seen.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(state['status']);self.end_headers();self.wfile.write(state['text'].encode())
            def log_message(self,*_):pass
        server=HTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path=Path(tmp)/'outbox.db';box=Outbox(path);box.add({'id':'immutable','status':'alert'})
                box.flush(f'http://127.0.0.1:{server.server_port}',{'Content-Type':'application/json'})
                self.assertEqual(box.db.execute('SELECT count(*) FROM outbox').fetchone()[0],1)
                box.db.close();box=Outbox(path)
                state.update(status=409,text='adapter lease expired')
                box.flush(f'http://127.0.0.1:{server.server_port}',{'Content-Type':'application/json'})
                self.assertEqual(box.db.execute('SELECT count(*) FROM outbox').fetchone()[0],1)
                state.update(status=200,text='{}')
                box.flush(f'http://127.0.0.1:{server.server_port}',{'Content-Type':'application/json'})
                self.assertEqual(box.db.execute('SELECT count(*) FROM outbox').fetchone()[0],0)
                self.assertEqual([v['id'] for v in seen],['immutable']*3)
                box.db.close()
        finally:server.shutdown();server.server_close();thread.join()
    def test_queue_has_a_hard_record_bound(self):
        with tempfile.TemporaryDirectory() as tmp:
            box=Outbox(Path(tmp)/'outbox.db')
            for i in range(130):box.add(dict(id=str(i)))
            self.assertEqual(box.db.execute('SELECT count(*) FROM outbox').fetchone()[0],128)
            self.assertIsNone(box.db.execute("SELECT id FROM outbox WHERE id='0'").fetchone());box.db.close()
    def test_mobile_source_never_assumes_stationary(self):
        source=Source.__new__(Source)
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'stationary.json';source.config=dict(view='mobile',stationaryFile=str(path))
            self.assertFalse(source.stationary())
            path.write_text(json.dumps(dict(stationary=True,observedAt=time.time()*1000-5000)))
            self.assertFalse(source.stationary())
            path.write_text(json.dumps(dict(stationary=True,observedAt=time.time()*1000)))
            self.assertTrue(source.stationary())
            path.write_text(json.dumps(dict(stationary=False,observedAt=time.time()*1000)))
            self.assertFalse(source.stationary())

if __name__=='__main__':unittest.main()
