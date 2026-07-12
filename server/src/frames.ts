// Evidence frame grabs via ffmpeg. Two source kinds:
//  - file: local demo loop under server/media — seeks to a random point so
//    consecutive detections show different frames
//  - rtsp: live camera / robot stream — one frame over TCP transport
// The stream-key → source resolution lives in World.frameSource() (channels
// are the registry); this module only knows how to pull a JPEG.

import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const MEDIA = join(dirname(fileURLToPath(import.meta.url)), '..', 'media')
const FFMPEG = process.env.FFMPEG_BIN ?? 'ffmpeg'

export type FrameSource = { kind: 'file'; file: string } | { kind: 'rtsp'; url: string }

const durCache = new Map<string, number>()

function probeDuration(file: string): Promise<number> {
  if (durCache.has(file)) return Promise.resolve(durCache.get(file)!)
  return new Promise((resolve) => {
    execFile(FFMPEG, ['-hide_banner', '-i', file], (_err, _out, stderr) => {
      const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(stderr ?? '')
      const dur = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 10
      durCache.set(file, dur)
      resolve(dur)
    })
  })
}

// 640w + q6 keeps snapshots ~25-35KB — kanban/table thumbs never show larger
const SCALE = ['-frames:v', '1', '-vf', 'scale=min(640\\,iw):-2', '-q:v', '6']

export async function grabFrame(src: FrameSource, timeoutMs = 8000): Promise<Buffer | null> {
  const out = join(tmpdir(), `pb-frame-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`)
  try {
    let args: string[]
    if (src.kind === 'file') {
      const file = join(MEDIA, src.file.replace(/[^A-Za-z0-9._-]/g, ''))
      const dur = await probeDuration(file)
      const at = (Math.random() * Math.max(0.5, dur - 1)).toFixed(2)
      args = ['-y', '-loglevel', 'error', '-ss', at, '-i', file, ...SCALE, out]
    } else {
      // -timeout (µs) is the RTSP demuxer's socket I/O cap — a dead host fails
      // fast (connection refused / read timeout) instead of hanging the whole
      // process-timeout window. NB: rtsp uses -timeout, not -rw_timeout.
      const socketUs = String(Math.max(1_000_000, (timeoutMs - 1500) * 1000))
      args = [
        '-y', '-loglevel', 'error',
        '-rtsp_transport', 'tcp',
        '-timeout', socketUs,
        '-i', src.url,
        ...SCALE, out,
      ]
    }
    await new Promise<void>((resolve, reject) => {
      execFile(FFMPEG, args, { timeout: timeoutMs }, (err) => (err ? reject(err) : resolve()))
    })
    const buf = await readFile(out)
    unlink(out).catch(() => {})
    return buf.length > 1000 ? buf : null
  } catch {
    unlink(out).catch(() => {})
    return null
  }
}
