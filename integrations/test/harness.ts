// e2e 测试骨架：临时端口 + PB_DATA_DIR 起真平台，spawn 真 sim / 真 adapter 进程，
// 断言全部通过平台对外 API（operator 会话 + integration key）——三层都是真实进程，
// 没有 mock。每个厂商 suite 用独立端口段，可并行。

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TSX = join(ROOT, 'integrations', 'node_modules', '.bin', 'tsx')

export interface Stack {
  procs: ChildProcess[]
  base: string
  key: string
  cookie: string
  stop: () => void
}

export function spawnProc(entry: string, env: Record<string, string>, tag: string): ChildProcess {
  const child = spawn(TSX, [entry], {
    cwd: entry.startsWith('server') ? ROOT : join(ROOT, 'integrations'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pipe = (s: NodeJS.ReadableStream) =>
    s.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(`[${tag}] ${d}`))
  pipe(child.stdout!)
  pipe(child.stderr!)
  return child
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, label: string, intervalMs = 700): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v as T
    } catch {
      /* keep polling */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout: ${label}`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export async function bootPlatform(port: number): Promise<{ base: string; cookie: string; stop: () => void; proc: ChildProcess }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'pb-e2e-'))
  const proc = spawnProc('server/src/index.ts', { API_PORT: String(port), PB_DATA_DIR: dataDir, PB_DEV_KEYS: '1' }, `platform:${port}`)
  const base = `http://127.0.0.1:${port}`
  await waitFor(async () => (await fetch(`${base}/api/sites`)).ok, 20_000, 'platform up')
  // operator 会话（admin 全站）
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'plantbot' }),
  })
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  return { base, cookie, stop: () => proc.kill('SIGTERM'), proc }
}

export const j = (r: Response) => r.json() as Promise<any>

export async function api(stack: { base: string; cookie: string }, method: string, path: string, body?: unknown) {
  const res = await fetch(`${stack.base}${path}`, {
    method,
    headers: { cookie: stack.cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

export async function integration(base: string, key: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/integration/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** 平台侧对某外部机器人的观测快照（fleet + 遥测经 REST 不可得 → 用 state 回读技巧：
 *  遥测走 WS，这里直接读 fleet + events + missions 即可覆盖断言面） */
export async function fleetRobot(stack: { base: string; cookie: string }, siteId: string, serial: string) {
  const { body } = await api(stack, 'GET', `/api/sites/${siteId}/fleet`)
  return body?.robots?.find((r: any) => r.serial === serial)
}

/** 停掉钉死给某外部机器人的排程 —— 让测试场地不被平台自身的活水打扰。
 *  已生火的 run 也一并中止：排程在 disable 前可能已经出过一单（stagger 最短 9s），
 *  留着会在任意后续断言点残留 pending 订单。 */
export async function disablePinnedSchedules(stack: { base: string; cookie: string }, siteId: string, robotId: string) {
  const { body } = await api(stack, 'GET', `/api/sites/${siteId}/schedules`)
  for (const s of body?.schedules ?? []) {
    if (s.assign?.kind === 'robot' && s.assign.robotId === robotId)
      await api(stack, 'PATCH', `/api/sites/${siteId}/schedules/${s.id}`, { enabled: false })
  }
  const ms = await api(stack, 'GET', `/api/sites/${siteId}/missions`)
  for (const m of ms.body?.missions ?? []) {
    if (m.requestedRobot === robotId && (m.status === 'queued' || m.status === 'active'))
      await api(stack, 'POST', `/api/sites/${siteId}/missions/${m.id}/abort`, {})
  }
}

/** WS 遥测采样：取 windowMs 内某机器人的全部 tel 帧 */
export async function sampleTelemetry(base: string, siteId: string, robotId: string, windowMs: number): Promise<any[]> {
  const { default: WebSocket } = await import('ws')
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?site=${siteId}`)
    const out: any[] = []
    ws.on('message', (raw: Buffer) => {
      try {
        const f = JSON.parse(String(raw))
        if (f.t === 'tel') {
          const t = (f.data as any[]).find((x) => x.id === robotId)
          if (t) out.push(t)
        }
      } catch {}
    })
    setTimeout(() => {
      ws.close()
      resolve(out)
    }, windowMs)
    ws.on('error', () => {})
  })
}
