"""Verify bundled recorded clips, or rebuild them from explicitly supplied originals.

No source download, generated scene, overlaid reading or fabricated observation.
See media/manifest.json and THIRD_PARTY.md for source URLs, byte ranges and rights.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(directory, manifest):
    for name, expected in manifest['files'].items():
        path = directory / name
        if sha(path) != expected:
            raise ValueError(f'Recorded media checksum mismatch: {name}')
        subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(path),
                        '-map', '0:v:0', '-f', 'null', '-'], check=True)
        print(f'Verified SHA-256 and full decode: {name}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, help='Reviewed original inputs, named as clips[].inputFile; never downloaded implicitly')
    parser.add_argument('--output-dir', type=Path, help='Required separate destination when rebuilding; bundled assets stay intact')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'media/manifest.json').read_text())
    if args.source_dir:
        if not args.output_dir or args.output_dir.resolve() == (ROOT / 'media').resolve():
            parser.error('Rebuild into a separate --output-dir, then review before replacing bundled assets')
        args.output_dir.mkdir(parents=True, exist_ok=True)
        for clip in manifest['clips']:
            source = args.source_dir / clip['inputFile']
            if sha(source) != clip['inputSha256']:
                raise ValueError(f'Original input checksum mismatch: {source.name}')
            target = args.output_dir / clip['file']
            if clip['transform']['kind'] == 'copy':
                shutil.copyfile(source, target)
            else:
                subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', str(source),
                                *clip['transform']['ffmpegArgs'], str(target)], check=True)
        # Encoder versions may change bytes. A mismatch requires explicit media
        # review and inference retesting; never rewrite the trusted manifest here.
        verify(args.output_dir, manifest)
    else:
        if args.output_dir:
            parser.error('--output-dir requires --source-dir')
        verify(ROOT / 'media', manifest)


if __name__ == '__main__':
    main()
