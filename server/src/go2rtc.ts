import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { streamTable } from './fleet.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const GO2RTC_API = 'http://127.0.0.1:1984'

let proc: ChildProcess | null = null

export function startGo2rtc() {
  const bin = join(ROOT, 'bin', 'go2rtc')
  const mediaDir = join(ROOT, 'media')
  const ffmpeg = process.env.FFMPEG_BIN ?? '/opt/homebrew/bin/ffmpeg'
  if (!existsSync(bin)) {
    console.error('[go2rtc] binary missing at', bin)
    return
  }
  const streams = streamTable(mediaDir, ffmpeg)
  const yaml = [
    'api:',
    '  listen: "127.0.0.1:1984"',
    '  origin: "*"',
    'rtsp:',
    '  listen: "127.0.0.1:8554"',
    'webrtc:',
    '  listen: ""',
    'ffmpeg:',
    `  bin: ${ffmpeg}`,
    'log:',
    '  level: warn',
    'streams:',
    ...Object.entries(streams).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
    '',
  ].join('\n')
  const cfg = join(ROOT, 'go2rtc.yaml')
  writeFileSync(cfg, yaml)

  proc = spawn(bin, ['-config', cfg], { stdio: ['ignore', 'inherit', 'inherit'] })
  proc.on('exit', (code) => {
    console.error(`[go2rtc] exited (${code}), restarting in 3s`)
    proc = null
    setTimeout(() => startGo2rtc(), 3000)
  })
  console.log('[go2rtc] started, api on :1984, rtsp on :8554')
}

export function stopGo2rtc() {
  if (proc) {
    proc.removeAllListeners('exit')
    proc.kill('SIGTERM')
    proc = null
  }
}

/** Grab a real JPEG frame from a stream (used for event snapshots). */
export async function grabFrame(stream: string, timeoutMs = 8000): Promise<Buffer | null> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    const res = await fetch(`${GO2RTC_API}/api/frame.jpeg?src=${encodeURIComponent(stream)}`, {
      signal: ctl.signal,
    })
    clearTimeout(t)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > 1000 ? buf : null
  } catch {
    return null
  }
}
