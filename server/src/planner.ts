// Grid A* planner over a yard occupancy layout — stands in for each
// robot's onboard nav stack (Nav2 global planner). Operators never edit
// paths; they only pick waypoints. This produces the "computed route"
// that the UI displays.
//
// Parameterized per site: each World builds its own planner from the
// site's bounds and obstacle set (multi-site support).

export interface PlannerDef {
  bounds: { x: [number, number]; z: [number, number] }
  /** axis-aligned obstacles [x0, z0, x1, z1] (margins included) */
  rects: [number, number, number, number][]
  /** round obstacles [cx, cz, r] */
  circles?: [number, number, number][]
  /** rectangles carved back out of the blocked set (dock approaches) */
  carve?: [number, number, number, number][]
}

export interface Planner {
  planPath(x0: number, z0: number, x1: number, z1: number): { x: number; z: number }[]
  pathLength(path: { x: number; z: number }[]): number
}

const RES = 0.5

export function createPlanner(def: PlannerDef): Planner {
  const X0 = def.bounds.x[0]
  const Z0 = def.bounds.z[0]
  const W = Math.round((def.bounds.x[1] - X0) / RES)
  const H = Math.round((def.bounds.z[1] - Z0) / RES)

  const blocked = new Uint8Array(W * H)
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = X0 + (i + 0.5) * RES
      const z = Z0 + (j + 0.5) * RES
      let b = 0
      if (x < X0 + 0.8 || x > def.bounds.x[1] - 0.8 || z < Z0 + 0.8 || z > def.bounds.z[1] - 0.8) b = 1
      for (const [a, c, d, e] of def.rects) if (x > a && x < d && z > c && z < e) b = 1
      for (const [cx, cz, r] of def.circles ?? []) if ((x - cx) ** 2 + (z - cz) ** 2 < r * r) b = 1
      blocked[j * W + i] = b
    }
  }
  for (const [a, c, d, e] of def.carve ?? [])
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const x = X0 + (i + 0.5) * RES
        const z = Z0 + (j + 0.5) * RES
        if (x > a && x < d && z > c && z < e) blocked[j * W + i] = 0
      }

  function cell(x: number, z: number): [number, number] {
    return [
      Math.max(0, Math.min(W - 1, Math.floor((x - X0) / RES))),
      Math.max(0, Math.min(H - 1, Math.floor((z - Z0) / RES))),
    ]
  }

  function nearestFree(i: number, j: number): [number, number] {
    if (!blocked[j * W + i]) return [i, j]
    for (let r = 1; r < 8; r++)
      for (let dj = -r; dj <= r; dj++)
        for (let di = -r; di <= r; di++) {
          const ni = i + di
          const nj = j + dj
          if (ni >= 0 && ni < W && nj >= 0 && nj < H && !blocked[nj * W + ni]) return [ni, nj]
        }
    return [i, j]
  }

  /** A* with diagonals; returns world-frame polyline (simplified). */
  function planPath(x0: number, z0: number, x1: number, z1: number): { x: number; z: number }[] {
    let [si, sj] = cell(x0, z0)
    let [gi, gj] = cell(x1, z1)
    ;[si, sj] = nearestFree(si, sj)
    ;[gi, gj] = nearestFree(gi, gj)

    const open = new Map<number, number>() // idx -> f
    const g = new Float32Array(W * H).fill(Infinity)
    const from = new Int32Array(W * H).fill(-1)
    const sIdx = sj * W + si
    const gIdx = gj * W + gi
    g[sIdx] = 0
    open.set(sIdx, Math.hypot(gi - si, gj - sj))

    const closed = new Uint8Array(W * H)
    while (open.size) {
      let cur = -1
      let best = Infinity
      for (const [idx, f] of open) if (f < best) ((best = f), (cur = idx))
      if (cur === gIdx) break
      open.delete(cur)
      closed[cur] = 1
      const ci = cur % W
      const cj = (cur / W) | 0
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue
          const ni = ci + di
          const nj = cj + dj
          if (ni < 0 || ni >= W || nj < 0 || nj >= H) continue
          const nIdx = nj * W + ni
          if (blocked[nIdx] || closed[nIdx]) continue
          if (di && dj && (blocked[cj * W + ni] || blocked[nj * W + ci])) continue // no corner cutting
          const cost = g[cur] + Math.hypot(di, dj)
          if (cost < g[nIdx]) {
            g[nIdx] = cost
            from[nIdx] = cur
            open.set(nIdx, cost + Math.hypot(gi - ni, gj - nj))
          }
        }
    }

    if (from[gIdx] === -1 && gIdx !== sIdx) return [{ x: x0, z: z0 }, { x: x1, z: z1 }]

    const cells: [number, number][] = []
    let cur = gIdx
    while (cur !== -1) {
      cells.push([cur % W, (cur / W) | 0])
      cur = from[cur]
    }
    cells.reverse()

    // collinear simplification, then endpoints snapped to true coords
    const pts = cells.map(([i, j]) => ({ x: X0 + (i + 0.5) * RES, z: Z0 + (j + 0.5) * RES }))
    const out: { x: number; z: number }[] = []
    for (let k = 0; k < pts.length; k++) {
      if (k === 0 || k === pts.length - 1) {
        out.push(pts[k])
        continue
      }
      const a = out[out.length - 1]
      const b = pts[k]
      const c = pts[k + 1]
      const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
      if (Math.abs(cross) > 1e-6) out.push(b)
    }
    if (out.length) {
      out[0] = { x: x0, z: z0 }
      out[out.length - 1] = { x: x1, z: z1 }
    }
    return out
  }

  return { planPath, pathLength }
}

export function pathLength(path: { x: number; z: number }[]) {
  let d = 0
  for (let i = 1; i < path.length; i++) d += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z)
  return d
}
