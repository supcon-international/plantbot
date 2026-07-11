// Event/mission snapshots pulled straight from the local demo footage with
// ffmpeg — no live-stream dependency. Each grab seeks to a random point so
// consecutive detections show different frames.

import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const MEDIA = join(dirname(fileURLToPath(import.meta.url)), '..', 'media')
const FFMPEG = process.env.FFMPEG_BIN ?? 'ffmpeg'

/** stream id → local footage backing that channel */
const SOURCE: Record<string, string> = {
  'lite3-front': 'switchgear.mp4',
  'lite3-thermal': 'thermal.mp4',
  'x30-optical': 'substation.mp4',
  'agx-ogi': 'ogi.mp4',
  'go2-front': 'corridor.mp4',
  'perimeter-cam': 'perimeter.mp4',
  'workshop-cam': 'staging.mp4',
  'mast-cam': 'plant_aerial.mp4',
  'tank-cam': 'tanknight.mp4',
  // external vendor units — adapter-registered streams (the only robots now)
  'spot07-front': 'switchgear.mp4', // plant-07 Spot
  'spot07-therm': 'thermal.mp4',
  'x30hb-optical': 'substation.mp4', // plant-12 X30
  'x30hb-therm': 'thermal.mp4',
  'spotce-front': 'campus_gate.mp4', // campus Spot
  'spotce-therm': 'night_walkway.mp4',
  'x30ce-optical': 'night_walkway.mp4', // campus X30
  'x30ce-therm': 'thermal.mp4',
  // Plant 12 · Harbor Terminal fixed cameras
  'berth-cam': 'perimeter.mp4',
  'tankrow-cam': 'tanknight.mp4',
  // Campus East · Gosuncn GS·F2 (GoRobot adapter) + fixed cameras
  'gs1-front': 'campus_quad.mp4',
  'gs1-rear': 'theft_cctv.mp4',
  'gs2-front': 'campus_walk.mp4',
  'gate-cam': 'campus_gate.mp4',
  'perimeter-cam-c': 'intruder.mp4',
  'stadium-cam': 'stadium_field.mp4',
  'lot-cam': 'parking_night.mp4',
}

const durCache = new Map<string, number>()

function probeDuration(file: string): Promise<number> {
  if (durCache.has(file)) return Promise.resolve(durCache.get(file)!)
  return new Promise((resolve) => {
    execFile(
      FFMPEG,
      ['-hide_banner', '-i', file],
      (err, _out, stderr) => {
        const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(stderr ?? '')
        const dur = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 10
        durCache.set(file, dur)
        resolve(dur)
      },
    )
  })
}

export async function grabFrame(stream: string, _timeoutMs = 8000): Promise<Buffer | null> {
  const name = SOURCE[stream] ?? SOURCE[stream.split(':')[0]] ?? 'plant_aerial.mp4'
  const file = join(MEDIA, name)
  try {
    const dur = await probeDuration(file)
    const at = (Math.random() * Math.max(0.5, dur - 1)).toFixed(2)
    const out = join(tmpdir(), `pb-frame-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`)
    await new Promise<void>((resolve, reject) => {
      execFile(
        FFMPEG,
        // 640w + q6 keeps snapshots ~25-35KB — kanban/table thumbs never show larger
        ['-y', '-loglevel', 'error', '-ss', at, '-i', file, '-frames:v', '1', '-vf', 'scale=min(640\\,iw):-2', '-q:v', '6', out],
        (err) => (err ? reject(err) : resolve()),
      )
    })
    const buf = await readFile(out)
    unlink(out).catch(() => {})
    return buf.length > 1000 ? buf : null
  } catch {
    return null
  }
}
