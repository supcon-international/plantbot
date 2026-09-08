"""Fetch locked model files at build/setup time. Runtime must stay offline."""
import hashlib
import json
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parent


def verify(root=ROOT/'models'):
    for item in json.loads((ROOT/'models.lock.json').read_text()):
        p = root/item['file']
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != item['sha256']:
            raise RuntimeError(f'Missing or invalid model file: {item["file"]}; run setup_models.py')


if __name__ == '__main__':
    root = ROOT/'models'
    root.mkdir(exist_ok=True)
    for item in json.loads((ROOT/'models.lock.json').read_text()):
        p = root/item['file']
        if p.exists() and hashlib.sha256(p.read_bytes()).hexdigest() == item['sha256']:
            continue
        print('Downloading', item['file'], flush=True)
        tmp = p.with_suffix('.part')
        with requests.get(item['url'], stream=True, timeout=120) as r:
            r.raise_for_status()
            with tmp.open('wb') as f:
                for chunk in r.iter_content(1024*1024):
                    f.write(chunk)
        if hashlib.sha256(tmp.read_bytes()).hexdigest() != item['sha256']:
            tmp.unlink()
            raise RuntimeError('Model checksum mismatch: '+item['file'])
        tmp.replace(p)
    verify(root)
