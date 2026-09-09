"""Copy one bundled, licensed real recording for an isolated test source."""
import argparse
from pathlib import Path
import shutil


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--source', choices=('person', 'instrument'), default='person')
    args = parser.parse_args()
    media = Path(__file__).resolve().parents[2] / 'demo' / 'media'
    source = media / ('restricted-area.mp4' if args.source == 'person' else 'instrument.mp4')
    if not source.is_file():
        parser.error(f'Missing bundled recording: {source}')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, args.output)


if __name__ == '__main__':
    main()
