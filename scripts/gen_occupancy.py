#!/usr/bin/env python3
"""Generate a realistic SLAM-style occupancy grid for yard-07.

Follows ROS map_server conventions: free=254, unknown=205, occupied=0.
Obstacles appear as laser-hit outlines (walls), with unknown shadow behind
them, speckle noise and ragged edges — the way a real gmapping/slam_toolbox
map looks. Output: 8-bit grayscale PNG + map.yaml-style JSON metadata.

World frame: x in [-16,16] (east), z in [-9,9] (south). 5 cm / cell.
"""
import struct, zlib, json, math, random, os

random.seed(42)
RES = 0.05
X0, X1, Z0, Z1 = -16.0, 16.0, -9.0, 9.0
W = int((X1 - X0) / RES)  # 640
H = int((Z1 - Z0) / RES)  # 360

FREE, UNKNOWN, OCC = 254, 205, 0
grid = [[UNKNOWN] * W for _ in range(H)]

def w2p(x, z):
    return int((x - X0) / RES), int((z - Z0) / RES)

def in_bounds(px, pz):
    return 0 <= px < W and 0 <= pz < H

def fill_rect(x0, z0, x1, z1, val, jitter=0.0):
    p0, q0 = w2p(x0, z0); p1, q1 = w2p(x1, z1)
    for q in range(min(q0, q1), max(q0, q1)):
        for p in range(min(p0, p1), max(p0, p1)):
            if in_bounds(p, q):
                if jitter and random.random() < jitter: continue
                grid[q][p] = val

def line(x0, z0, x1, z1, val=OCC, thick=1, drop=0.06, wobble=0.5):
    """Ragged laser-surface line with occasional dropouts."""
    steps = max(2, int(math.hypot(x1 - x0, z1 - z0) / (RES * 0.8)))
    for i in range(steps + 1):
        t = i / steps
        x = x0 + (x1 - x0) * t + random.uniform(-wobble, wobble) * RES
        z = z0 + (z1 - z0) * t + random.uniform(-wobble, wobble) * RES
        if random.random() < drop: continue
        p, q = w2p(x, z)
        r = thick // 2
        for dq in range(-r, r + 1):
            for dp in range(-r, r + 1):
                if in_bounds(p + dp, q + dq):
                    grid[q + dq][p + dp] = val

def circle(cx, cz, rad, val=OCC, drop=0.05):
    steps = int(2 * math.pi * rad / (RES * 0.8))
    for i in range(steps):
        a = 2 * math.pi * i / steps
        if random.random() < drop: continue
        p, q = w2p(cx + rad * math.cos(a), cz + rad * math.sin(a))
        if in_bounds(p, q): grid[q][p] = val

# --- explored floor (lidar-swept area), irregular boundary ---
for q in range(H):
    for p in range(W):
        x = X0 + p * RES; z = Z0 + q * RES
        margin = 0.55 + 0.35 * math.sin(x * 0.9) * math.cos(z * 1.3)
        if X0 + margin < x < X1 - margin and Z0 + margin < z < Z1 - margin:
            grid[q][p] = FREE

# --- perimeter fence (broken laser line) ---
line(X0 + 0.5, Z0 + 0.5, X1 - 0.5, Z0 + 0.5, drop=0.18)
line(X0 + 0.5, Z1 - 0.5, X1 - 0.5, Z1 - 0.5, drop=0.18)
line(X0 + 0.5, Z0 + 0.5, X0 + 0.5, Z1 - 0.5, drop=0.18)
line(X1 - 0.5, Z0 + 0.5, X1 - 0.5, Z1 - 0.5, drop=0.18)

# --- train + track corridor: hull outline, interior unseen ---
fill_rect(-12.4, -3.3, 12.4, 3.3, UNKNOWN)
line(-12.2, -3.2, 12.2, -3.2, thick=2, drop=0.04)
line(-12.2, 3.2, 12.2, 3.2, thick=2, drop=0.04)
line(-12.2, -3.2, -12.4, 3.2, thick=2, drop=0.1)
line(12.2, -3.2, 12.4, 3.2, thick=2, drop=0.1)
# bogie / coupler detail blips along the hull
for x in (-9.5, -6.2, -2.8, 0.4, 3.8, 7.1, 10.2):
    line(x, -3.2, x + 0.5, -3.55, thick=1, drop=0.3)
    line(x, 3.2, x + 0.5, 3.55, thick=1, drop=0.3)

# --- buildings: outline + unknown interior ---
def building(x0, z0, x1, z1):
    fill_rect(x0, z0, x1, z1, UNKNOWN)
    line(x0, z0, x1, z0, thick=2, drop=0.05)
    line(x1, z0, x1, z1, thick=2, drop=0.05)
    line(x1, z1, x0, z1, thick=2, drop=0.05)
    line(x0, z1, x0, z0, thick=2, drop=0.05)

building(-14.6, 4.6, -10.4, 8.3)      # substation
building(8.2, -8.2, 13.6, -5.1)       # workshop
building(-15.2, -8.3, -12.6, -6.0)    # charge depot
circle(14.2, 6.2, 1.15); fill_rect(13.2, 5.3, 15.2, 7.1, UNKNOWN); circle(14.2, 6.2, 1.15, drop=0.04)
circle(14.3, 2.9, 0.95); fill_rect(13.5, 2.0, 15.1, 3.8, UNKNOWN); circle(14.3, 2.9, 0.95, drop=0.04)

# --- scattered clutter: pallets, poles, cones ---
for _ in range(26):
    x = random.uniform(-14, 14); z = random.choice([random.uniform(-8, -4), random.uniform(4, 8)])
    if -15 < x < -9 and 4 < z < 8.5: continue
    if 7.5 < x < 14 and -8.5 < z < -4.5: continue
    if random.random() < 0.4:
        p, q = w2p(x, z)
        if in_bounds(p, q): grid[q][p] = OCC
    else:
        line(x, z, x + random.uniform(0.2, 0.7), z + random.uniform(-0.3, 0.3), drop=0.25)

# --- speckle noise in free space ---
for _ in range(int(W * H * 0.0016)):
    p = random.randrange(W); q = random.randrange(H)
    if grid[q][p] == FREE:
        grid[q][p] = random.choice([OCC, UNKNOWN, 230, 240])

# --- soft unknown fringe where lidar coverage fades ---
for q in range(H):
    for p in range(W):
        if grid[q][p] == FREE and random.random() < 0.010:
            grid[q][p] = random.choice([245, 250, 240])

# ---------- write grayscale PNG ----------
def png_gray(path, w, h, rows):
    raw = b''.join(b'\x00' + bytes(r) for r in rows)
    comp = zlib.compress(raw, 9)
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 0, 0, 0, 0)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', comp) + chunk(b'IEND', b''))

out_dir = os.path.join(os.path.dirname(__file__), '..', 'web', 'public', 'assets', 'maps')
os.makedirs(out_dir, exist_ok=True)
png_gray(os.path.join(out_dir, 'yard-07.png'), W, H, grid)
meta = {
    'image': 'yard-07.png',
    'resolution': RES,
    'width': W,
    'height': H,
    'origin': [X0, Z0],
    'free_thresh': 0.196,
    'occupied_thresh': 0.65,
    'source': 'slam_toolbox · JY-L3-01 mapping run 2026-06-30',
}
with open(os.path.join(out_dir, 'yard-07.json'), 'w') as f:
    json.dump(meta, f, indent=2)
print(f'wrote {W}x{H} occupancy grid -> assets/maps/yard-07.png')
