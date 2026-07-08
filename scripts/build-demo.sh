#!/usr/bin/env bash
# Post-process demo segments: trim stream-switch waits out of 02,
# transcode everything uniformly, and merge into aegis-demo-full.mp4
set -euo pipefail
cd "$(dirname "$0")/../demos"

echo "[1/3] transcode segments"
for f in 0*.webm; do
  name="${f%.webm}"
  ffmpeg -y -loglevel error -i "$f" -c:v libx264 -r 25 -crf 20 -preset medium \
    -pix_fmt yuv420p -vf "scale=1600:900" -movflags +faststart "$name.mp4"
  rm "$f"
done

echo "[2/3] trim black waits in 02-live-video"
python3 - <<'EOF'
import subprocess, json

SRC = '02-live-video.mp4'
dur = float(subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',SRC],capture_output=True,text=True).stdout)

def lum(t):
    out = subprocess.run(['ffmpeg','-loglevel','error','-ss',str(t),'-i',SRC,'-frames:v','1',
                          '-vf','crop=1200:500:200:180,scale=48:20','-f','rawvideo','-pix_fmt','gray','-'],capture_output=True)
    d = out.stdout
    return sum(d)/len(d) if d else 0

TITLE_S = 2.1  # keep the title card unconditionally
step = 1.0
t, keep, cur = TITLE_S, [], None
while t < dur - 0.5:
    bright = lum(t) > 18
    if bright and cur is None:
        cur = t
    elif not bright and cur is not None:
        if t - cur >= 3.5: keep.append((max(TITLE_S, cur - 0.4), t + 0.2))
        cur = None
    t += step
if cur is not None and dur - cur >= 3.5:
    keep.append((max(TITLE_S, cur - 0.4), dur))

# merge adjacent segments (< 1.5 s gap)
merged = []
for s, e in keep:
    if merged and s - merged[-1][1] < 1.5:
        merged[-1] = (merged[-1][0], e)
    else:
        merged.append((s, e))

segs = [(0.0, TITLE_S)] + merged
print('segments:', [(round(a,1), round(b,1)) for a, b in segs])

parts, labels = [], []
for i, (s, e) in enumerate(segs):
    parts.append(f"[0:v]trim={s}:{e},setpts=PTS-STARTPTS[v{i}]")
    labels.append(f"[v{i}]")
fc = ';'.join(parts) + f";{''.join(labels)}concat=n={len(segs)}:v=1:a=0[out]"
subprocess.run(['ffmpeg','-y','-loglevel','error','-i',SRC,'-filter_complex',fc,'-map','[out]',
                '-c:v','libx264','-r','25','-crf','20','-preset','medium','-pix_fmt','yuv420p',
                '-movflags','+faststart','02-live-video-cut.mp4'],check=True)
EOF
mv 02-live-video-cut.mp4 02-live-video.mp4

echo "[3/3] merge"
: > concat.txt
for f in 01-ops-dashboard 02-live-video 03-missions 04-fleet 05-map-2d 06-map-3d 07-events; do
  echo "file '$f.mp4'" >> concat.txt
done
ffmpeg -y -loglevel error -f concat -safe 0 -i concat.txt -c copy aegis-demo-full.mp4
rm concat.txt

echo "done:"
for f in *.mp4; do
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" | cut -d. -f1)
  printf "  %-26s %ss\n" "$f" "$d"
done
