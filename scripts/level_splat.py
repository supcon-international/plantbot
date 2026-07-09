#!/usr/bin/env python3
"""3DGS .ply → leveled .splat for the Plantbot scene stage.

The whole point: the exported scene is ALREADY straight. We fit the ground
plane (RANSAC with a gravity prior), rotate its normal onto +Y, zero the
floor, align the dominant footprint axis to X via PCA, center the mass,
scale the long axis to the yard, and bake every bit of that — positions,
gaussian scales AND rotation quaternions — into the output. The viewer
then loads it with identity calibration, so nothing can be crooked.

usage: level_splat.py in.ply out.splat [--span 36] [--keep 2000000]
"""

import struct
import sys

import numpy as np

SH_C0 = 0.28209479177387814


def read_gs_ply(path):
    with open(path, 'rb') as f:
        header = b''
        while not header.endswith(b'end_header\n'):
            header += f.readline()
        head = header.decode('ascii', 'ignore')
        n = int(next(l for l in head.splitlines() if l.startswith('element vertex')).split()[-1])
        props = [l.split()[-1] for l in head.splitlines() if l.startswith('property float')]
        data = np.fromfile(f, dtype='<f4', count=n * len(props)).reshape(n, len(props))
    idx = {p: i for i, p in enumerate(props)}
    return data, idx


def ransac_ground(pos, iters=400, tol=None, gravity=np.array([0, -1.0, 0])):
    """Largest plane whose normal roughly matches the COLMAP gravity prior (y-down)."""
    rng = np.random.default_rng(7)
    sample = pos[rng.choice(len(pos), min(60000, len(pos)), replace=False)]
    diag = np.linalg.norm(sample.max(0) - sample.min(0))
    tol = tol or diag * 0.004
    best_n, best_d, best_count = None, 0.0, -1
    for _ in range(iters):
        p = sample[rng.choice(len(sample), 3, replace=False)]
        n = np.cross(p[1] - p[0], p[2] - p[0])
        norm = np.linalg.norm(n)
        if norm < 1e-9:
            continue
        n = n / norm
        if n @ gravity < 0:
            n = -n
        if n @ gravity < 0.7:  # within ~45° of "up" (y-down world → sky is -y)
            continue
        d = n @ p[0]
        count = int((np.abs(sample @ n - d) < tol).sum())
        if count > best_count:
            best_n, best_d, best_count = n, d, count
    # refine on inliers with least squares
    inl = sample[np.abs(sample @ best_n - best_d) < tol]
    c = inl.mean(0)
    _, _, vt = np.linalg.svd(inl - c, full_matrices=False)
    n = vt[2]
    if n @ gravity < 0:
        n = -n
    return n, c, best_count / len(sample)


def rot_between(a, b):
    """Rotation matrix taking unit vector a to unit vector b."""
    v = np.cross(a, b)
    c = float(a @ b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3) if c > 0 else -np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1 / (1 + c))


def mat_to_quat(m):
    w = np.sqrt(max(0, 1 + m[0, 0] + m[1, 1] + m[2, 2])) / 2
    x = np.sqrt(max(0, 1 + m[0, 0] - m[1, 1] - m[2, 2])) / 2
    y = np.sqrt(max(0, 1 - m[0, 0] + m[1, 1] - m[2, 2])) / 2
    z = np.sqrt(max(0, 1 - m[0, 0] - m[1, 1] + m[2, 2])) / 2
    x = np.copysign(x, m[2, 1] - m[1, 2])
    y = np.copysign(y, m[0, 2] - m[2, 0])
    z = np.copysign(z, m[1, 0] - m[0, 1])
    q = np.array([w, x, y, z])
    return q / np.linalg.norm(q)


def quat_mul(q, r):
    """Hamilton product, w-first; q is (4,), r is (N,4)."""
    w1, x1, y1, z1 = q
    w2, x2, y2, z2 = r[:, 0], r[:, 1], r[:, 2], r[:, 3]
    return np.stack(
        [
            w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
            w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
            w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
            w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
        ],
        axis=1,
    )


def main():
    src, dst = sys.argv[1], sys.argv[2]
    span_target = float(next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == '--span'), 36))
    keep_target = int(next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == '--keep'), 2_000_000))
    # indoor scenes: slice the ceiling off for the dollhouse view
    y_max = float(next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == '--ymax'), 15))

    data, idx = read_gs_ply(src)
    data = data[np.isfinite(data).all(1)]  # reconstructions ship stray NaN/Inf rows
    pos = data[:, [idx['x'], idx['y'], idx['z']]].astype(np.float64)
    print(f'loaded {len(pos):,} splats')

    # 1. level: ground normal → +Y (this also flips the COLMAP y-down world upright)
    n, c, frac = ransac_ground(pos)
    up = -n  # n points along gravity (y-down "sky"), the world up is the opposite
    R1 = rot_between(up, np.array([0, 1.0, 0]))
    p1 = pos @ R1.T
    ground_y = np.median((c @ R1.T)[1])

    # 2. yaw: dominant footprint axis → X (use the mid slab to skip floor noise / sky)
    slab = p1[(p1[:, 1] > ground_y + 0.2 * (p1[:, 1].std())) & (p1[:, 1] < ground_y + 4 * p1[:, 1].std())]
    xz = slab[:, [0, 2]] - slab[:, [0, 2]].mean(0)
    cov = np.cov(xz.T)
    evals, evecs = np.linalg.eigh(cov)
    major = evecs[:, np.argmax(evals)]
    yaw = -np.arctan2(major[1], major[0])
    Ry = np.array([[np.cos(yaw), 0, np.sin(yaw)], [0, 1, 0], [-np.sin(yaw), 0, np.cos(yaw)]])
    R = Ry @ R1
    p2 = pos @ R.T

    # 3. center on the dense core, floor at y=0
    gy = np.percentile(p2[:, 1], 8)  # floor sits near the low percentile after leveling
    cx, cz = np.median(p2[:, 0]), np.median(p2[:, 2])
    p2[:, 0] -= cx
    p2[:, 1] -= gy
    p2[:, 2] -= cz

    # 4. uniform scale: long footprint axis → span_target
    sx = np.percentile(p2[:, 0], 98) - np.percentile(p2[:, 0], 2)
    sz = np.percentile(p2[:, 2], 98) - np.percentile(p2[:, 2], 2)
    s = span_target / max(sx, sz)
    p2 *= s
    print(f'ground fit {frac:.0%} inliers · yaw {np.degrees(yaw):.1f}° · span {sx:.1f}×{sz:.1f} → ×{s:.2f}')

    # 5. crop to the yard shell + drop only the extreme floaters.
    # Scene reconstructions lean on big gaussians for surfaces — cull by
    # quantile, not absolute size, or buildings dissolve into mist.
    scales = np.exp(data[:, [idx['scale_0'], idx['scale_1'], idx['scale_2']]]) * s
    smax = scales.max(1)
    box = (np.abs(p2[:, 0]) < 19) & (np.abs(p2[:, 2]) < 12.5) & (p2[:, 1] > -0.7) & (p2[:, 1] < y_max)
    lim = np.percentile(smax[box], 99.6)
    keep = box & (smax < lim)
    near = (np.abs(p2[:, 0]) < 12) & (np.abs(p2[:, 2]) < 9)
    print(f'crop keeps {keep.sum():,} (floater cutoff {lim:.2f})')

    # 6. thin to target: keep the core denser than the shell
    ki = np.flatnonzero(keep)
    if len(ki) > keep_target:
        rng = np.random.default_rng(11)
        core = near[ki]
        pk = np.where(core, 1.0, 0.45)
        pk = pk * (keep_target / pk.sum())
        ki = ki[rng.random(len(ki)) < pk]
        print(f'thinned to {len(ki):,}')

    # 7. bake into .splat (pos f32×3, scale f32×3, rgba u8×4, quat u8×4)
    P = p2[ki].astype('<f4')
    S = scales[ki].astype('<f4')
    dc = data[ki][:, [idx['f_dc_0'], idx['f_dc_1'], idx['f_dc_2']]]
    rgb = np.clip((0.5 + SH_C0 * dc) * 255, 0, 255).astype(np.uint8)
    a = np.clip(1 / (1 + np.exp(-data[ki][:, idx['opacity']])) * 255, 0, 255).astype(np.uint8)
    q = data[ki][:, [idx['rot_0'], idx['rot_1'], idx['rot_2'], idx['rot_3']]]
    q = q / np.linalg.norm(q, axis=1, keepdims=True)
    qr = quat_mul(mat_to_quat(R), q)
    qr = qr / np.linalg.norm(qr, axis=1, keepdims=True)
    Q = np.clip(qr * 128 + 128, 0, 255).astype(np.uint8)

    # importance sort like antimatter15 — big/opaque first renders better
    order = np.argsort(-(S.prod(1) * (a / 255.0)))
    P, S, rgb, a, Q = P[order], S[order], rgb[order], a[order], Q[order]

    out = np.zeros(len(P), dtype=[('p', '<f4', 3), ('s', '<f4', 3), ('c', 'u1', 4), ('q', 'u1', 4)])
    out['p'] = P
    out['s'] = S
    out['c'][:, :3] = rgb
    out['c'][:, 3] = a
    out['q'] = Q
    out.tofile(dst)
    print(f'wrote {dst}: {len(P):,} splats, {out.nbytes / 1e6:.1f} MB')

    # sanity: residual roll/pitch of the floor after bake
    floor = P[(P[:, 1] > -0.4) & (P[:, 1] < 0.6)]
    if len(floor) > 5000:
        cf = floor.mean(0)
        _, _, vt = np.linalg.svd(floor - cf, full_matrices=False)
        nf = vt[2] if vt[2][1] > 0 else -vt[2]
        tilt = np.degrees(np.arccos(min(1, abs(nf[1]))))
        print(f'floor tilt after bake: {tilt:.2f}°')


if __name__ == '__main__':
    main()
